import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";

const PORT=Number(process.env.PORT||10000);
const GITLAB_BASE=(process.env.GITLAB_BASE_URL||"https://gitlab.com").replace(/\/$/,"");
const CLIENT_ID=process.env.GITLAB_CLIENT_ID||"";
const CLIENT_SECRET=process.env.GITLAB_CLIENT_SECRET||"";
const GATEWAY_SECRET=process.env.GATEWAY_SECRET||"";
const PUBLIC_URL=(process.env.PUBLIC_URL||"").replace(/\/$/,"");
const AI_GATEWAY=(process.env.AI_GATEWAY_URL||"https://cloud.gitlab.com").replace(/\/$/,"");

const sessions=new Map(), directCache=new Map();
const MODELS=["claude-sonnet-4-6","claude-sonnet-4-5-20250929","claude-sonnet-4-20250514","claude-opus-4-6","claude-opus-4-5-20251101","claude-haiku-4-5-20251001"];

const b64=b=>Buffer.from(b).toString("base64").replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
const ub64=s=>Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-s.length%4)%4),"base64");
const random=(n=32)=>b64(crypto.randomBytes(n));
const hmac=s=>b64(crypto.createHmac("sha256",GATEWAY_SECRET).update(s).digest());

function encrypt(obj){
  const iv=crypto.randomBytes(12), key=crypto.createHash("sha256").update(GATEWAY_SECRET).digest();
  const c=crypto.createCipheriv("aes-256-gcm",key,iv), ct=Buffer.concat([c.update(JSON.stringify(obj),"utf8"),c.final()]);
  return b64(Buffer.concat([iv,c.getAuthTag(),ct]));
}
function decrypt(s){
  const b=ub64(s), iv=b.subarray(0,12), tag=b.subarray(12,28), ct=b.subarray(28);
  const d=crypto.createDecipheriv("aes-256-gcm",crypto.createHash("sha256").update(GATEWAY_SECRET).digest(),iv);
  d.setAuthTag(tag); return JSON.parse(Buffer.concat([d.update(ct),d.final()]).toString("utf8"));
}
function signedState(s){return s+"."+hmac(s)}
function verifyState(v){
  if(!v||!v.includes("."))return null; const i=v.lastIndexOf("."),s=v.slice(0,i),sig=v.slice(i+1);
  try{return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(hmac(s)))?s:null}catch{return null}
}
function cookie(n,v,maxAge,httpOnly=true){return n+"="+encodeURIComponent(v)+"; Path=/; Max-Age="+maxAge+"; HttpOnly; Secure; SameSite=Lax"}
function getCookie(req,n){const x=(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith(n+"="));return x?decodeURIComponent(x.slice(n.length+1)):null}
function send(res,status,body,type="application/json",extra={}){res.writeHead(status,{"content-type":type,"cache-control":"no-store",...extra});res.end(typeof body==="string"?body:JSON.stringify(body))}
async function body(req){const a=[];for await(const c of req)a.push(c);return Buffer.concat(a)}
function config(res){if(!CLIENT_ID||!CLIENT_SECRET||!GATEWAY_SECRET){send(res,500,{error:"Missing GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET or GATEWAY_SECRET"});return false}return true}
function publicUrl(req){return PUBLIC_URL||("https://"+req.headers.host)}
function redirectUri(req){return publicUrl(req)+"/oauth/callback"}

async function oauthCode(code,req){
 const f=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,code,grant_type:"authorization_code",redirect_uri:redirectUri(req)});
 const r=await fetch(GITLAB_BASE+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:f});
 const d=await r.json().catch(()=>({}));if(!r.ok)throw Error("OAuth exchange failed: "+r.status+" "+JSON.stringify(d));return d;
}
async function refresh(s){
 const f=new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:s.refresh_token,grant_type:"refresh_token",redirect_uri:s.redirect_uri});
 const r=await fetch(GITLAB_BASE+"/oauth/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:f});
 const d=await r.json().catch(()=>({}));if(!r.ok)throw Error("OAuth refresh failed: "+r.status+" "+JSON.stringify(d));
 s.access_token=d.access_token;s.refresh_token=d.refresh_token||s.refresh_token;s.expires_at=Date.now()+Number(d.expires_in||7200)*1000;return s;
}
async function direct(s){
 const cached=directCache.get(s.id);if(cached&&cached.expires_at>Date.now()+30000)return cached;
 if(s.expires_at<Date.now()+60000)await refresh(s);
 const r=await fetch(GITLAB_BASE+"/api/v4/ai/third_party_agents/direct_access",{method:"POST",headers:{authorization:"Bearer "+s.access_token,"content-type":"application/json",accept:"application/json"},body:null});
 const d=await r.json().catch(()=>({}));if(!r.ok||!d.token)throw Error("GitLab Duo direct-access failed: "+r.status+" "+JSON.stringify(d));
 const x={token:d.token,headers:d.headers||{},expires_at:Date.now()+25*60*1000};directCache.set(s.id,x);return x;
}
async function auth(req){
 const c=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!c)return null;
 try{const p=decrypt(c),s=sessions.get(p.sid);if(!s||s.revoked)return null;if(s.expires_at<Date.now()+60000)await refresh(s);return s}catch{return null}
}
async function anthropicRequest(s,payload){
 const d=await directAccess(s);
 const r=await fetch(AI_GATEWAY+"/ai/v1/proxy/anthropic/v1/messages",{method:"POST",headers:{...d.headers,"content-type":"application/json","accept":"application/json","anthropic-version":"2023-06-01","x-api-key":d.token},body:JSON.stringify(payload)});
 const text=await r.text(); let data; try{data=JSON.parse(text)}catch{data={raw:text}}; return {status:r.status,data};
}
function textFromAnthropic(data){return data&&Array.isArray(data.content)?data.content.filter(x=>x.type==="text").map(x=>x.text).join(""):"";}
async function proxy(req,res,s){
 const d=await direct(s), u=new URL(req.url,"http://local"), target=AI_GATEWAY+"/ai/v1/proxy/anthropic"+u.pathname;
 const headers={...d.headers,"content-type":req.headers["content-type"]||"application/json",accept:req.headers.accept||"application/json","anthropic-version":req.headers["anthropic-version"]||"2023-06-01","x-api-key":d.token};
 for(const k of ["anthropic-beta","anthropic-dangerous-direct-browser-access"])if(req.headers[k])headers[k]=req.headers[k];
 const r=await fetch(target,{method:req.method,headers,body:await body(req)});
 res.writeHead(r.status,{"content-type":r.headers.get("content-type")||"application/json","cache-control":"no-store"});
 if(r.body)for await(const c of r.body)res.write(c);res.end();
}
function page(req,connected){
 const base=publicUrl(req),cb=redirectUri(req);
 const models=MODELS.map(m=>'<tr><td><b>'+m+'</b></td><td><span class="pill good">Available</span></td><td><button class="mini" onclick="copyText(\\''+m+'\\')">Copy</button></td></tr>').join("");
 return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>GitLab Duo API</title><style>"+
"body{margin:0;background:#090c12;color:#f3f5f8;font:14px system-ui}*{box-sizing:border-box}.app{display:flex;min-height:100vh}.side{width:220px;background:#0d1119;border-right:1px solid #202938;padding:22px 12px}.brand{font-size:18px;font-weight:800;padding:5px 10px 25px}.brand b{color:#7c5cff}.nav button{display:block;width:100%;border:0;background:none;color:#8f9bad;text-align:left;padding:11px;border-radius:8px;margin:3px 0;cursor:pointer}.nav button:hover,.nav button.active{background:#181f2c;color:white}.main{flex:1;padding:28px;max-width:1200px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.top h1{font-size:25px;margin:0}.badge{border:1px solid #263143;border-radius:20px;padding:7px 11px;color:#a6b0bf}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#657184;margin-right:7px}.dot.good{background:#35d39a;box-shadow:0 0 8px #35d39a}.dot.bad{background:#ff6077}.card{background:#111722;border:1px solid #252f40;border-radius:13px;padding:18px;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.big{font-size:22px;font-weight:750;margin-top:6px}.muted{color:#8f9bad}.hero{background:linear-gradient(135deg,#171d2a,#101621);border:1px solid #293448;border-radius:15px;padding:22px;margin-bottom:14px}.btn,.mini{border:1px solid #293448;background:#192131;color:white;border-radius:8px;padding:10px 14px;cursor:pointer}.btn.primary{background:#7657ff;border-color:#7657ff}.btn.good{background:#12352b;border-color:#245e4c}.mini{padding:5px 8px;font-size:11px}.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.code{background:#080b11;border:1px solid #202938;border-radius:9px;padding:12px;font:12px ui-monospace;word-break:break-all;white-space:pre-wrap}.copy{float:right}.input,.select,textarea{background:#0a0e15;color:white;border:1px solid #293448;border-radius:8px;padding:11px}.input{width:100%}.tabs{display:flex;gap:5px;margin-bottom:14px}.tab{display:none}.tab.active{display:block}.check{display:flex;justify-content:space-between;border-bottom:1px solid #202938;padding:13px 0}.pill{font-size:11px;border-radius:20px;padding:5px 9px;background:#202938;color:#9ba6b6}.pill.good{background:#10352b;color:#6ee5b6}.pill.bad{background:#3b1820;color:#ff8b9b}.alert{padding:12px;border-radius:9px;background:#381a21;color:#ff9aaa;margin-top:12px}.success{padding:12px;border-radius:9px;background:#103329;color:#72e7b8;margin-top:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{text-align:left;padding:11px;border-bottom:1px solid #202938}.chat{height:440px;background:#090d14;border:1px solid #263143;border-radius:12px;display:flex;flex-direction:column}.msgs{flex:1;overflow:auto;padding:16px}.msg{max-width:82%;padding:11px 13px;border-radius:11px;margin:8px 0;white-space:pre-wrap;line-height:1.5}.user{background:#27324b;margin-left:auto}.ai{background:#151d2a}.compose{display:flex;gap:8px;border-top:1px solid #202938;padding:11px}.compose textarea{flex:1;resize:none}.small{font-size:12px}@media(max-width:800px){.side{width:65px}.brand{font-size:0}.brand b{font-size:16px}.nav button{font-size:0;text-align:center}.main{padding:18px}.grid{grid-template-columns:1fr}}"+
"</style></head><body><div class='app'><aside class='side'><div class='brand'>GitLab <b>Duo API</b></div><div class='nav'>"+
"<button class='active' onclick='show(\\'dash\\')'>▦ &nbsp; Dashboard</button><button onclick='show(\\'api\\')'>⌘ &nbsp; API Access</button><button onclick='show(\\'models\\')'>◈ &nbsp; Models</button><button onclick='show(\\'play\\')'>▷ &nbsp; Playground</button><button onclick='show(\\'settings\\')'>⚙ &nbsp; Settings</button>"+
"</div></aside><main class='main'><div class='top'><h1 id='title'>GitLab Duo API Gateway</h1><div class='badge'><span id='tdot' class='dot'></span><span id='tstatus'>Checking...</span></div></div>"+
"<section id='dash' class='tab active'><div class='hero'><h2 style='margin-top:0'>GitLab Duo → API Gateway</h2><p class='muted'>Connect your GitLab OAuth application, test Duo access, then generate one Anthropic-compatible API credential for Claude Code and other clients.</p><div class='row'><button class='btn primary' onclick='connect()'>"+(connected?"Reconnect GitLab":"Connect GitLab")+"</button><button class='btn' onclick='testAll()'>Run full health test</button></div></div>"+
"<div class='grid'><div class='card'><b>OAuth Application</b><div id='oauth' class='big'>"+(CLIENT_ID&&CLIENT_SECRET?"Ready":"Not configured")+"</div><div class='muted small'>Client ID + Client Secret</div></div><div class='card'><b>GitLab Duo</b><div id='duo' class='big'>"+(connected?"Connected":"Disconnected")+"</div><div class='muted small'>Direct-access token</div></div><div class='card'><b>Anthropic Proxy</b><div id='proxy' class='big'>Ready</div><div class='muted small'>cloud.gitlab.com AI Gateway</div></div></div>"+
"<div class='card'><b>GitLab Application Callback URL</b><div class='code' style='margin-top:9px'><button class='btn copy' onclick='copyText(\\''+cb+'\\')'>Copy</button>"+cb+"</div><p class='muted small'>Create a GitLab user application with this exact callback and the <b>ai_features</b> OAuth scope. Keep the Client Secret private; put it in Render environment variables.</p></div><div id='dashAlert'></div></section>"+
"<section id='api' class='tab'><div class='card'><h2>API Access</h2><p class='muted'>This is the gateway base URL. Claude Code appends <b>/v1/messages</b> automatically.</p><label>Base URL</label><div class='code'><button class='btn copy' onclick='copyText(\\''+base+'\\')'>Copy</button>"+base+"</div><p class='small muted'>Do not add <b>/v1</b> to the Claude Code base URL.</p><label>API Credential</label><div class='row'><input id='cred' class='input' readonly placeholder='Connect GitLab first'><button class='btn' onclick='copyCred()'>Copy</button><button class='btn primary' onclick='credential()'>Generate / refresh</button></div><div id='apiAlert'></div></div>"+
"<div class='card'><h3>Claude Code configuration</h3><div id='claude' class='code'>Connect GitLab and generate a credential.</div></div></section>"+
"<section id='models' class='tab'><div class='card'><div class='row' style='justify-content:space-between'><div><h2 style='margin:0'>Models</h2><p class='muted'>GitLab Duo managed Claude models.</p></div><button class='btn primary' onclick='importModels()'>Import / refresh models</button></div><table class='table' style='margin-top:14px'><thead><tr><th>Model</th><th>Status</th><th></th></tr></thead><tbody>"+models+"</tbody></table></div><div class='card'><h3>Auto model</h3><p class='muted'>Recommended default: Claude Sonnet 4.6. The playground can automatically use this model.</p><select id='auto' class='select'>"+MODELS.map(m=>'<option value=\"'+m+'\">'+m+'</option>').join("")+"</select> <button class='btn' onclick='saveAuto()'>Set Auto</button><span id='autos' class='pill good'>Auto: Claude Sonnet 4.6</span></div></section>"+
"<section id='play' class='tab'><div class='card'><div class='row' style='justify-content:space-between'><div><h2 style='margin:0'>Playground</h2><p class='muted'>Chat with any imported GitLab Duo Claude model.</p></div><select id='model' class='select'>"+MODELS.map(m=>'<option value=\"'+m+'\">'+m+'</option>').join("")+"</select></div><div class='chat'><div id='msgs' class='msgs'><div class='msg ai'>GitLab Duo Playground is ready. Choose a model and send a message.</div></div><div class='compose'><textarea id='prompt' rows='2' placeholder='Ask Claude...' onkeydown='if(event.key===\\'Enter\\'&&!event.shiftKey){event.preventDefault();chat()}'></textarea><button class='btn primary' onclick='chat()'>Send</button></div></div><div id='chatAlert'></div></div></section>"+
"<section id='settings' class='tab'><div class='card'><h2>Settings & checks</h2><div class='check'><div><b>GitLab base</b><div class='muted small'>"+GITLAB_BASE+"</div></div><span class='pill good'>Configured</span></div><div class='check'><div><b>OAuth scope</b><div class='muted small'>ai_features — limited Duo API permission</div></div><span class='pill good'>Recommended</span></div><div class='check'><div><b>AI Gateway</b><div class='muted small'>"+AI_GATEWAY+"/ai/v1/proxy/anthropic</div></div><span class='pill good'>Configured</span></div><div class='check'><div><b>Encryption</b><div class='muted small'>Credentials are encrypted with the Render GATEWAY_SECRET.</div></div><span class='pill good'>Enabled</span></div><div style='margin-top:14px'><button class='btn' onclick='disconnect()'>Disconnect GitLab</button></div></div></section>"+
"</main></div><script>"+
"function show(id){document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.getElementById(id).classList.add('active');document.querySelectorAll('.nav button').forEach(x=>x.classList.remove('active'));event.currentTarget.classList.add('active');document.getElementById('title').textContent={dash:'GitLab Duo API Gateway',api:'API Access',models:'Models',play:'Playground',settings:'Settings & checks'}[id]||'GitLab Duo API'}"+
"async function jf(u,o){let r=await fetch(u,o),d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||d.details||'Request failed');return d}"+
"function copyText(x){navigator.clipboard.writeText(x)} function copyCred(){let x=document.getElementById('cred').value;if(x)copyText(x)}"+
"function connect(){location.href='/oauth/start'}"+
"async function credential(){try{let d=await jf('/api/credential');document.getElementById('cred').value=d.credential;document.getElementById('claude').textContent='export ANTHROPIC_BASE_URL=\\\"'+d.base_url+'\\\"\\\\nexport ANTHROPIC_AUTH_TOKEN=\\\"'+d.credential+'\\\"\\\\n# optional model:\\\\nexport ANTHROPIC_MODEL=\\\"claude-sonnet-4-6\\\"\\\\nclaude';document.getElementById('apiAlert').innerHTML='<div class=success>API credential is ready. Keep it private.</div>'}catch(e){document.getElementById('apiAlert').innerHTML='<div class=alert>'+e.message+'</div>'}}"+
"async function testAll(){document.getElementById('dashAlert').innerHTML='<div class=card>Testing OAuth session → GitLab Duo direct access → Claude Messages API...</div>';try{let d=await jf('/api/test',{method:'POST'});document.getElementById('dashAlert').innerHTML='<div class=success><b>Everything is healthy.</b><br>'+d.message+'<br><span class=small>Model: '+d.model+' · '+d.preview+'</span></div>'}catch(e){document.getElementById('dashAlert').innerHTML='<div class=alert><b>Test failed:</b> '+e.message+'</div>'}}"+
"async function importModels(){try{let d=await jf('/v1/models');document.getElementById('dashAlert').innerHTML='<div class=success>Imported '+d.data.length+' GitLab Duo Claude models.</div>';show('models')}catch(e){alert(e.message)}}"+
"function saveAuto(){let x=document.getElementById('auto').value;localStorage.duoAuto=x;document.getElementById('autos').textContent='Auto: '+x;document.getElementById('model').value=x}"+
"async function chat(){let p=document.getElementById('prompt').value.trim();if(!p)return;let m=document.getElementById('model').value||localStorage.duoAuto||'claude-sonnet-4-6';document.getElementById('prompt').value='';let box=document.getElementById('msgs');box.insertAdjacentHTML('beforeend','<div class=\\\"msg user\\\">'+esc(p)+'</div><div id=\\\"thinking\\\" class=\\\"msg ai\\\">Thinking…</div>');box.scrollTop=box.scrollHeight;try{let d=await jf('/api/playground',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:m,prompt:p})});document.getElementById('thinking').textContent=d.text||'(empty response)'}catch(e){document.getElementById('thinking').textContent='Error: '+e.message;document.getElementById('thinking').style.color='#ff8b9b'}box.scrollTop=box.scrollHeight}"+
"function esc(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))} async function disconnect(){if(confirm('Disconnect GitLab from this browser?')){await fetch('/logout');location.reload()}}"+
"window.addEventListener('load',()=>{let x=localStorage.duoAuto||'claude-sonnet-4-6';document.getElementById('auto').value=x;document.getElementById('model').value=x;"+(connected?"credential();":"")+"});"+
"</script></body></html>";
}

const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,"http://"+(req.headers.host||"localhost"));
  if(u.pathname==="/health")return send(res,200,{ok:true,service:"gitlab-duo-gateway"});
  if(u.pathname==="/api/status"&&req.method==="GET"){const s=await sessionFromRequest(req);return send(res,200,{configured:configured(),oauthConfigured:!!(CLIENT_ID&&CLIENT_SECRET),gatewayConfigured:!!GATEWAY_SECRET,connected:!!s,base_url:publicUrl(req),callback:redirectUri(req)});}
  if(u.pathname==="/api/credential"&&req.method==="GET"){const s=await sessionFromRequest(req);if(!s)return send(res,401,{error:"GitLab Duo is not connected. Connect GitLab first."});const c=getCookie(req,"duo_session")||encrypt(s);return send(res,200,{credential:c,base_url:publicUrl(req),messages_url:publicUrl(req)+"/v1/messages",models:MODELS});}
  if(u.pathname==="/api/test"&&req.method==="POST"){const s=await sessionFromRequest(req);if(!s)return send(res,401,{error:"Connect GitLab before testing."});await directAccess(s);const d=await anthropicRequest(s,{model:"claude-sonnet-4-6",max_tokens:1,messages:[{role:"user",content:"ping"}]},false);if(d.status<200||d.status>=300)return send(res,502,{error:"GitLab Duo direct access works, but the Claude Messages test failed ("+d.status+").",details:d.data});return send(res,200,{ok:true,message:"OAuth, GitLab Duo direct access, AI Gateway and Claude Messages API are all working.",model:"claude-sonnet-4-6",preview:textFromAnthropic(d.data).slice(0,80)||"response received"});}
  if(u.pathname==="/api/playground"&&req.method==="POST"){const s=await sessionFromRequest(req);if(!s)return send(res,401,{error:"Connect GitLab first."});let p;try{p=JSON.parse((await readBody(req)).toString())}catch{return send(res,400,{error:"Invalid JSON"})}const model=MODELS.includes(p.model)?p.model:"claude-sonnet-4-6";const prompt=String(p.prompt||"").trim();if(!prompt)return send(res,400,{error:"Prompt is empty"});const d=await anthropicRequest(s,{model,max_tokens:1024,messages:[{role:"user",content:prompt}]},false);if(d.status<200||d.status>=300)return send(res,d.status,{error:"GitLab Duo request failed",details:d.data});return send(res,200,{ok:true,model,text:textFromAnthropic(d.data),raw:d.data});}
  if(u.pathname==="/oauth/start"){if(!config(res))return;const st=random(24),a=new URL(GITLAB_BASE+"/oauth/authorize");a.searchParams.set("client_id",CLIENT_ID);a.searchParams.set("redirect_uri",redirectUri(req));a.searchParams.set("response_type","code");a.searchParams.set("state",st);a.searchParams.set("scope","ai_features");res.writeHead(302,{location:a.toString(),"set-cookie":cookie("oauth_state",signedState(st),600)});return res.end()}
  if(u.pathname==="/oauth/callback"){if(!config(res))return;const expected=verifyState(getCookie(req,"oauth_state"));if(!expected||expected!==u.searchParams.get("state"))return send(res,400,{error:"Invalid OAuth state"});const code=u.searchParams.get("code");if(!code)return send(res,400,{error:"Missing OAuth code"});const t=await oauthCode(code,req),id=random(24);sessions.set(id,{id,access_token:t.access_token,refresh_token:t.refresh_token,expires_at:Date.now()+Number(t.expires_in||7200)*1000,redirect_uri:redirectUri(req),revoked:false});const cred=encrypt({sid:id,iat:Date.now()});res.writeHead(302,{location:"/", "set-cookie":cookie("duo_session",cred,2592000)});return res.end()}
  if(u.pathname==="/api/credential"){const c=getCookie(req,"duo_session");if(!c)return send(res,401,{error:"Not connected"});try{const p=decrypt(c),s=sessions.get(p.sid);if(!s||s.revoked)return send(res,401,{error:"Session expired; reconnect GitLab"});return send(res,200,{credential:c,base_url:publicUrl(req),models:MODELS,expires_at:s.expires_at})}catch{return send(res,401,{error:"Invalid session"})}}
  if(u.pathname==="/models"||u.pathname==="/v1/models")return send(res,200,{object:"list",data:MODELS.map(id=>({id,object:"model",owned_by:"gitlab-duo"}))});
  if(u.pathname==="/logout"){const c=getCookie(req,"duo_session");if(c)try{const p=decrypt(c),s=sessions.get(p.sid);if(s){s.revoked=true;directCache.delete(s.id)}}catch{}res.writeHead(302,{location:"/","set-cookie":cookie("duo_session","",0)});return res.end()}
  if(u.pathname==="/"||u.pathname==="/dashboard"){let connected=false;const c=getCookie(req,"duo_session");if(c)try{const p=decrypt(c),s=sessions.get(p.sid);connected=!!s&&!s.revoked}catch{}return send(res,200,page(req,connected),"text/html; charset=utf-8")}
  if(u.pathname.startsWith("/v1/messages")){const s=await auth(req);if(!s)return send(res,401,{error:{type:"authentication_error",message:"Invalid or expired GitLab Duo gateway credential"}});return proxy(req,res,s)}
  return send(res,404,{error:"Not found"});
 }catch(e){console.error(e);send(res,500,{error:String(e?.message||e)})}
});
server.listen(PORT,"0.0.0.0",()=>console.log("GitLab Duo Gateway listening on "+PORT));
