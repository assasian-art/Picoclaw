#!/usr/bin/env python3
"""Small OpenAI-compatible model router for PicoClaw.

MobileLLM is the visible PicoClaw model and the guaranteed local fallback.
Hosted providers are optional: a provider becomes active only when its API
key environment variable is present. Models are discovered from /models and
ranked dynamically. The local agent can manage provider/model state through
localhost-only admin endpoints when no router password is configured.
"""
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = os.getenv('ROUTER_HOST', '127.0.0.1')
PORT = int(os.getenv('ROUTER_PORT', '8100'))
LOCAL_BASE = os.getenv('LOCAL_MODEL_BASE', 'http://127.0.0.1:8000/v1').rstrip('/')
LOCAL_MODEL_ID = os.getenv('LOCAL_MODEL_ID', 'mobilellm-376m')
CONFIG_FILE = os.getenv('ROUTER_CONFIG_FILE', '/root/.picoclaw/config.json')
GATEWAY_RELOAD_URL = os.getenv('ROUTER_GATEWAY_RELOAD_URL', 'http://127.0.0.1:18790/reload')
FREE_ONLY = os.getenv('ROUTER_FREE_ONLY', 'true').lower() not in ('0','false','no')
REFRESH = max(30, int(os.getenv('ROUTER_REFRESH_SECONDS', '300')))
PROBE_EVERY = max(0, int(os.getenv('ROUTER_PROBE_SECONDS', '0')))
TIMEOUT = max(30, int(os.getenv('ROUTER_TIMEOUT_SECONDS', '180')))
QUOTA_COOLDOWN = max(60, int(os.getenv('ROUTER_QUOTA_COOLDOWN_SECONDS', '86400')))
STATE_FILE = os.getenv('ROUTER_STATE_FILE', '/root/.picoclaw/router-state.json')
ADMIN_PASSWORD = os.getenv('ROUTER_ADMIN_PASSWORD', os.getenv('PICOCLAW_WEBUI_PASSWORD', '')).strip()

# Common OpenAI-compatible hosted/proxy endpoints. Arbitrary compatible
# gateways can be added through ROUTER_EXTRA_PROVIDERS_JSON.
BUILTIN_PROVIDERS = [
    ('openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1', 120),
    ('groq', 'GROQ_API_KEY', 'https://api.groq.com/openai/v1', 118),
    ('cerebras', 'CEREBRAS_API_KEY', 'https://api.cerebras.ai/v1', 117),
    ('longcat', 'LONGCAT_API_KEY', 'https://api.longcat.chat/openai', 116),
    ('modelscope', 'MODELSCOPE_API_KEY', 'https://api-inference.modelscope.cn/v1', 115),
    ('zhipu', 'ZHIPU_API_KEY', 'https://open.bigmodel.cn/api/paas/v4', 114),
    ('gemini', 'GEMINI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/openai', 100),
    ('together', 'TOGETHER_API_KEY', 'https://api.together.xyz/v1', 99),
    ('fireworks', 'FIREWORKS_API_KEY', 'https://api.fireworks.ai/inference/v1', 98),
    ('xai', 'XAI_API_KEY', 'https://api.x.ai/v1', 97),
    ('mistral', 'MISTRAL_API_KEY', 'https://api.mistral.ai/v1', 96),
    ('deepseek', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/v1', 95),
    ('openai', 'OPENAI_API_KEY', 'https://api.openai.com/v1', 94),
    ('qwen', 'QWEN_API_KEY', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 93),
    ('moonshot', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1', 92),
    ('minimax', 'MINIMAX_API_KEY', 'https://api.minimax.io/v1', 91),
    ('nvidia', 'NVIDIA_API_KEY', 'https://integrate.api.nvidia.com/v1', 90),
    ('venice', 'VENICE_API_KEY', 'https://api.venice.ai/api/v1', 89),
    ('huggingface', 'HF_TOKEN', 'https://router.huggingface.co/v1', 88),
    ('vivgrid', 'VIVGRID_API_KEY', 'https://api.vivgrid.com/v1', 87),
    ('byteplus', 'BYTEPLUS_API_KEY', 'https://ark.ap-southeast.bytepluses.com/api/v3', 86),
    ('nearai', 'NEARAI_API_KEY', 'https://cloud-api.near.ai/v1', 85),
]
BAD_MODEL_WORDS = ('embedding', 'embed', 'moderation', 'rerank', 'tts', 'speech', 'whisper', 'audio', 'image', 'vision-encoder')
PATTERNS = [
    (160, r'gpt-oss-120b|gpt-5(?:\.|$)|gpt-4\.1'),
    (159, r'claude.*(?:sonnet|opus)'),
    (158, r'gemini-3.*flash'),
    (157, r'kimi.*k2'),
    (156, r'glm-5|glm-4\.7'),
    (155, r'qwen3.*(?:235b|110b|72b|32b|30b|27b)|qwen3\.5.*9b'),
    (154, r'deepseek-v4|deepseek-r1|deepseek-chat'),
    (153, r'gemma-4.*27b|gemma-3.*27b'),
    (152, r'llama-4|llama-3\.3-70b'),
    (145, r'llama.*8b|qwen.*14b|qwen.*7b|command-a'),
]

lock = threading.RLock()
state = {'disabled_providers': [], 'disabled_models': [], 'custom_providers': [], 'providers': {}}
last_refresh = 0.0
last_probe = 0.0


def load_state():
    global state
    try:
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            value = json.load(f)
        if isinstance(value, dict):
            state.update(value)
    except FileNotFoundError:
        pass
    except Exception as e:
        print('[Router] state load error:', e, flush=True)


def save_state():
    directory = os.path.dirname(STATE_FILE)
    if directory:
        os.makedirs(directory, exist_ok=True)
    tmp = STATE_FILE + '.tmp'
    with lock:
        value = {k: state.get(k, []) for k in ('disabled_providers', 'disabled_models', 'custom_providers')}
        value['providers'] = state.get('providers', {})
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def provider_defs():
    defs = list(BUILTIN_PROVIDERS)
    extra = os.getenv('ROUTER_EXTRA_PROVIDERS_JSON', '').strip()
    if extra:
        try:
            for p in json.loads(extra):
                if p.get('id') and p.get('api_key_env') and p.get('base_url'):
                    defs.append((p['id'], p['api_key_env'], p['base_url'].rstrip('/'), int(p.get('priority', 70))))
        except Exception as e:
            print('[Router] invalid extra providers:', e, flush=True)
    for p in state.get('custom_providers', []):
        if p.get('id') and p.get('api_key_env') and p.get('base_url'):
            defs.append((p['id'], p['api_key_env'], p['base_url'].rstrip('/'), int(p.get('priority', 70))))
    merged = {}
    for pid, env, base, pri in defs:
        merged[pid] = (pid, env, base, pri)
    disabled = set(state.get('disabled_providers', []))
    return [
        {'id': pid, 'env': env, 'base': base, 'priority': pri, 'key': os.getenv(env, '').strip()}
        for pid, env, base, pri in merged.values()
        if pid not in disabled and os.getenv(env, '').strip()
    ]


def pstate(pid):
    return state.setdefault('providers', {}).setdefault(pid, {'cooldown': 0, 'models': {}, 'ok': False, 'last_error': ''})


def score(model_id, priority):
    low = model_id.lower()
    if any(x in low for x in BAD_MODEL_WORDS):
        return -100000
    value = priority
    for points, pattern in PATTERNS:
        if re.search(pattern, low):
            value += points
            break
    if ':free' in low or low.endswith('-free'):
        value += 8
    if 'preview' in low or 'experimental' in low:
        value -= 3
    if 'instruct' in low or 'chat' in low:
        value += 3
    return value


def discover(provider):
    ps = pstate(provider['id'])
    try:
        req = Request(provider['base'] + '/models', headers={'Authorization': 'Bearer ' + provider['key'], 'Accept': 'application/json', 'User-Agent': 'PicoClaw-ModelRouter/3.0'})
        with urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode('utf-8', 'replace'))
        rows = [x for x in data.get('data', []) if isinstance(x, dict) and x.get('id')]
        if FREE_ONLY and provider['id'] == 'openrouter':
            rows = [x for x in rows if ':free' in str(x.get('id','')).lower() or (
                isinstance(x.get('pricing'), dict) and
                str(x['pricing'].get('prompt','')) in ('0','0.0','0.000000') and
                str(x['pricing'].get('completion','')) in ('0','0.0','0.000000')
            )]
        ids = [str(x['id']) for x in rows]
        old = ps.get('models', {})
        ps['models'] = {mid: old.get(mid, {'cooldown': 0, 'failures': 0, 'last_ok': 0, 'score': score(mid, provider['priority']), 'disabled': False}) for mid in ids}
        for mid in ids:
            ps['models'][mid]['score'] = score(mid, provider['priority'])
        ps['ok'] = True
        ps['last_error'] = ''
        ps['last_refresh'] = time.time()
    except HTTPError as e:
        body = e.read().decode('utf-8', 'replace')[:240]
        ps['ok'] = False
        ps['last_error'] = f'HTTP {e.code}: {body}'
        if e.code in (401, 403, 429):
            ps['cooldown'] = time.time() + QUOTA_COOLDOWN
    except Exception as e:
        ps['ok'] = False
        ps['last_error'] = str(e)[:240]


def refresh():
    global last_refresh
    providers = provider_defs()
    for provider in providers:
        discover(provider)
    last_refresh = time.time()
    sync_config()
    print('[Router] active providers: ' + (', '.join(p['id'] for p in providers) if providers else 'none'), flush=True)


def discovered_models():
    out = []
    for provider in provider_defs():
        ps = pstate(provider['id'])
        for mid, ms in ps.get('models', {}).items():
            out.append((provider, mid, ms))
    return out


def candidates():
    now = time.time()
    disabled = set(state.get('disabled_models', []))
    out = []
    for provider, mid, ms in discovered_models():
        key = f'{provider["id"]}/{mid}'
        if key in disabled or ms.get('disabled', False):
            continue
        if pstate(provider['id']).get('cooldown', 0) > now or ms.get('cooldown', 0) > now:
            continue
        value = ms.get('score', score(mid, provider['priority']))
        if value < 0:
            continue
        value -= min(ms.get('failures', 0) * 12, 60)
        out.append((value, provider, mid))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def catalog_models():
    rows = [{'id': 'auto', 'object': 'model', 'owned_by': 'picoclaw-router'},
            {'id': f'local/{LOCAL_MODEL_ID}', 'object': 'model', 'owned_by': 'local'}]
    disabled = set(state.get('disabled_models', []))
    for provider, mid, ms in discovered_models():
        name = f'{provider["id"]}/{mid}'
        rows.append({'id': name, 'object': 'model', 'owned_by': provider['id'],
                     'disabled': bool(ms.get('disabled', False) or name in disabled),
                     'cooldown_until': ms.get('cooldown', 0),
                     'failures': ms.get('failures', 0)})
    return rows


def sync_config():
    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        old = cfg.get('model_list', [])
        managed = {
            'auto': {'model_name':'auto','provider':'openai','model':'auto',
                     'api_base':f'http://{HOST}:{PORT}/v1','api_keys':['router'],
                     'request_timeout':TIMEOUT,'enabled':True},
            f'local/{LOCAL_MODEL_ID}': {'model_name':f'local/{LOCAL_MODEL_ID}','provider':'openai',
                     'model':f'local/{LOCAL_MODEL_ID}','api_base':f'http://{HOST}:{PORT}/v1',
                     'api_keys':['router'],'request_timeout':TIMEOUT,'enabled':True}
        }
        disabled=set(state.get('disabled_models', []))
        for provider, mid, ms in discovered_models():
            name=f'{provider["id"]}/{mid}'
            managed[name]={'model_name':name,'provider':'openai','model':name,
                           'api_base':f'http://{HOST}:{PORT}/v1','api_keys':['router'],
                           'request_timeout':TIMEOUT,
                           'enabled':not (ms.get('disabled',False) or name in disabled)}
        result=[]
        for x in old:
            n=str(x.get('model_name','')) if isinstance(x,dict) else ''
            if n in managed or (isinstance(x,dict) and x.get('api_base')==f'http://{HOST}:{PORT}/v1'):
                continue
            if isinstance(x,dict) and x.get('model_name'): result.append(x)
        result.extend(managed.values())
        cfg['model_list']=result
        cfg.setdefault('agents',{}).setdefault('defaults',{})['model_name']='auto'
        raw=json.dumps(cfg,ensure_ascii=False,indent=2)+'\n'
        with open(CONFIG_FILE,'r',encoding='utf-8') as f: current=f.read()
        if raw != current:
            tmp=CONFIG_FILE+'.router.tmp'
            with open(tmp,'w',encoding='utf-8') as f: f.write(raw)
            os.replace(tmp,CONFIG_FILE)
            try:
                req=Request(GATEWAY_RELOAD_URL,data=b'',method='POST')
                with urlopen(req,timeout=5) as response: response.read(256)
                print('[Router] config synced + gateway reload requested',flush=True)
            except Exception as e:
                print('[Router] config synced; reload deferred:',str(e)[:160],flush=True)
    except Exception as e:
        print('[Router] config sync error:',str(e)[:240],flush=True)


def resolve_requested_model(payload):
    requested=str(payload.get('model','')).strip()
    if not requested or requested=='auto': return None
    if requested in (LOCAL_MODEL_ID,f'local/{LOCAL_MODEL_ID}'):
        return ('local',LOCAL_MODEL_ID)
    if '/' in requested:
        return tuple(requested.split('/',1))
    for provider,mid,_ in discovered_models():
        if requested==mid: return (provider['id'],mid)
    return None


def route(payload):
    global last_refresh
    if time.time()-last_refresh > REFRESH: refresh()
    errors=[]
    requested=resolve_requested_model(payload)
    if requested:
        pid,mid=requested
        if pid=='local':
            return post_chat(LOCAL_BASE,'local',mid,payload),'local',mid
        provider=next((p for p in provider_defs() if p['id']==pid),None)
        if provider:
            ms=pstate(pid).get('models',{}).get(mid,{})
            if not ms.get('disabled',False) and ms.get('cooldown',0)<=time.time():
                try:
                    return post_chat(provider['base'],provider['key'],mid,payload),pid,mid
                except HTTPError as e:
                    fail(provider,mid,e.code,e.read().decode('utf-8','replace')[:180])
                    errors.append(f'{pid}/{mid}: HTTP {e.code}')
                except Exception as e:
                    fail(provider,mid,503,str(e)[:120]); errors.append(f'{pid}/{mid}: error')
        errors.append(f'{pid}/{mid}: unavailable')
    for _,provider,model_id in candidates():
        try:
            return post_chat(provider['base'],provider['key'],model_id,payload),provider['id'],model_id
        except HTTPError as e:
            detail=e.read().decode('utf-8','replace')[:180]
            fail(provider,model_id,e.code,detail); errors.append(f'{provider["id"]}/{model_id}: HTTP {e.code}')
        except (URLError,TimeoutError,OSError) as e:
            fail(provider,model_id,503,str(e)[:100]); errors.append(f'{provider["id"]}/{model_id}: network')
        except Exception as e:
            fail(provider,model_id,503,str(e)[:100]); errors.append(f'{provider["id"]}/{model_id}: error')
    try:
        return post_chat(LOCAL_BASE,'local',LOCAL_MODEL_ID,payload),'local',LOCAL_MODEL_ID
    except Exception as e:
        errors.append('local/'+LOCAL_MODEL_ID+': '+str(e)[:140])
    raise RuntimeError('No working model route: '+'; '.join(errors[-10:]))


def fail(provider, model_id, status, detail=''):
    now = time.time()
    if status in (401, 403, 429):
        cooldown = QUOTA_COOLDOWN
    elif status in (400, 404, 422):
        cooldown = 6 * 3600
    elif status >= 500:
        cooldown = 120
    else:
        cooldown = 300
    ps = pstate(provider['id'])
    ms = ps['models'].setdefault(model_id, {'cooldown': 0, 'failures': 0, 'last_ok': 0, 'score': score(model_id, provider['priority'])})
    ms['failures'] = ms.get('failures', 0) + 1
    ms['cooldown'] = now + cooldown
    if status in (400,404,422) and ms['failures'] >= 3:
        ms['disabled'] = True
        state.setdefault('disabled_models', [])
        key=provider['id']+'/'+model_id
        if key not in state['disabled_models']: state['disabled_models'].append(key)
    ps['last_error'] = f'HTTP {status}: {detail}'[:300]
    if status in (401, 403, 429):
        ps['cooldown'] = now + cooldown
    save_state()


def success(provider, model_id):
    ps = pstate(provider['id'])
    ms = ps['models'].setdefault(model_id, {})
    ms['last_ok'] = time.time()
    ms['failures'] = max(0, ms.get('failures', 0) - 1)
    ms['cooldown'] = 0
    ms['disabled'] = False
    state['disabled_models']=[x for x in state.get('disabled_models',[]) if x != provider['id']+'/'+model_id]
    ps['cooldown'] = 0
    ps['ok'] = True
    ps['last_error'] = ''
    save_state()


def post_chat(base, key, model, payload):
    body = dict(payload)
    body['model'] = model
    raw = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = Request(base + '/chat/completions', data=raw, method='POST', headers={
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        'User-Agent': 'PicoClaw-ModelRouter/3.0',
    })
    return urlopen(req, timeout=TIMEOUT)


def admin_ok(handler):
    if ADMIN_PASSWORD:
        return handler.headers.get('Authorization', '') == 'Bearer ' + ADMIN_PASSWORD
    return handler.client_address[0] in ('127.0.0.1', '::1')


class Handler(BaseHTTPRequestHandler):
    server_version = 'PicoClaw-ModelRouter/3.0'

    def log_message(self, fmt, *args):
        print('[Router] ' + fmt % args, flush=True)

    def send_json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        n = int(self.headers.get('Content-Length', '0'))
        return json.loads(self.rfile.read(n).decode('utf-8')) if n else {}

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok', 'local_model': LOCAL_MODEL_ID, 'hosted_candidates': len(candidates()), 'active_providers': [p['id'] for p in provider_defs()]})
            return
        if self.path.startswith('/v1/models'):
            if time.time() - last_refresh > REFRESH:
                refresh()
            self.send_json(200, {'object':'list','data':catalog_models()})
            return
        if self.path == '/admin/status':
            if not admin_ok(self):
                self.send_json(401, {'error': 'unauthorized'})
                return
            with lock:
                snapshot = json.loads(json.dumps(state))
            self.send_json(200, {'local_model': LOCAL_MODEL_ID, 'active_providers': [p['id'] for p in provider_defs()], 'candidates': [{'provider': p['id'], 'model': mid, 'score': s} for s, p, mid in candidates()[:100]], 'catalog': catalog_models(), 'state': snapshot})
            return
        self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        if self.path.startswith('/admin/'):
            if not admin_ok(self):
                self.send_json(401, {'error': 'unauthorized'})
                return
            try:
                b = self.body()
                if self.path == '/admin/refresh':
                    refresh(); self.send_json(200, {'ok': True}); return
                if self.path == '/admin/provider':
                    action, pid = b.get('action'), str(b.get('id', '')).strip()
                    if not pid: raise ValueError('provider id is required')
                    disabled = set(state.get('disabled_providers', []))
                    if action == 'disable': disabled.add(pid)
                    elif action == 'enable': disabled.discard(pid)
                    elif action == 'add':
                        env, base = str(b.get('api_key_env', '')).strip(), str(b.get('base_url', '')).strip().rstrip('/')
                        if not env or not base: raise ValueError('api_key_env and base_url are required')
                        state['custom_providers'] = [x for x in state.get('custom_providers', []) if x.get('id') != pid]
                        state['custom_providers'].append({'id': pid, 'api_key_env': env, 'base_url': base, 'priority': int(b.get('priority', 70))})
                        disabled.discard(pid)
                    elif action == 'remove':
                        state['custom_providers'] = [x for x in state.get('custom_providers', []) if x.get('id') != pid]
                        disabled.add(pid)
                    else: raise ValueError('action must be add/remove/enable/disable')
                    state['disabled_providers'] = sorted(disabled); save_state(); refresh()
                    self.send_json(200, {'ok': True, 'active_providers': [p['id'] for p in provider_defs()]}); return
                if self.path == '/admin/model':
                    action, provider, model = b.get('action'), str(b.get('provider', '')).strip(), str(b.get('model', '')).strip()
                    if not provider or not model: raise ValueError('provider and model are required')
                    key, disabled = provider + '/' + model, set(state.get('disabled_models', []))
                    if action in ('disable', 'remove'): disabled.add(key)
                    elif action in ('enable', 'add'): disabled.discard(key)
                    else: raise ValueError('action must be add/remove/enable/disable')
                    state['disabled_models'] = sorted(disabled); save_state()
                    self.send_json(200, {'ok': True, 'disabled': key in disabled}); return
                self.send_json(404, {'error': 'unknown_admin_endpoint'})
            except Exception as e:
                self.send_json(400, {'error': str(e)})
            return

        if self.path not in ('/v1/chat/completions', '/chat/completions'):
            self.send_json(404, {'error': 'not_found'}); return
        try:
            payload = self.body()
            payload.pop('router_debug', None)
            response, provider_id, model_id = route(payload)
            if provider_id != 'local':
                provider = next((x for x in provider_defs() if x['id'] == provider_id), None)
                if provider: success(provider, model_id)
            self.send_response(response.status)
            for key, value in response.headers.items():
                if key.lower() in ('content-length', 'transfer-encoding', 'connection', 'server', 'date'):
                    continue
                self.send_header(key, value)
            self.send_header('X-PicoClaw-Route', provider_id + '/' + model_id)
            self.end_headers()
            while True:
                chunk = response.read(8192)
                if not chunk: break
                try:
                    self.wfile.write(chunk); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    break
            response.close()
            print('[Router] routed -> ' + provider_id + '/' + model_id, flush=True)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:
            print('[Router] request error:', repr(e), flush=True)
            try: self.send_json(503, {'error': {'message': str(e), 'type': 'router_unavailable'}})
            except (BrokenPipeError, ConnectionResetError): pass


def probe():
    if PROBE_EVERY <= 0: return
    for provider in provider_defs():
        if pstate(provider['id']).get('cooldown', 0) > time.time(): continue
        cs = [x for x in candidates() if x[1]['id'] == provider['id']]
        if not cs: continue
        _, _, model_id = cs[0]
        try:
            response = post_chat(provider['base'], provider['key'], model_id, {'messages': [{'role': 'user', 'content': 'OK'}], 'max_tokens': 1, 'temperature': 0, 'stream': False})
            response.read(2048); response.close(); success(provider, model_id)
            print('[Router] probe OK -> ' + provider['id'] + '/' + model_id, flush=True)
        except HTTPError as e:
            fail(provider, model_id, e.code, e.read().decode('utf-8', 'replace')[:120])
        except Exception as e:
            fail(provider, model_id, 503, str(e)[:100])


def monitor():
    global last_probe
    while True:
        try:
            if time.time() - last_refresh > REFRESH: refresh()
            if PROBE_EVERY > 0 and time.time() - last_probe > PROBE_EVERY:
                probe(); last_probe = time.time()
        except Exception as e:
            print('[Router] monitor error:', e, flush=True)
        time.sleep(30)


if __name__ == '__main__':
    load_state(); refresh()
    threading.Thread(target=monitor, daemon=True).start()
    print(f'[Router] listening on {HOST}:{PORT}; local model={LOCAL_MODEL_ID}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
