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
 const r=await fetch(GITLAB_BASE+"/api/v4/ai/third_party_agents/direct_access",{method:"POST",headers:{authorization:"Bearer "+s.access_token,"content-type":"application/json",accept:"application/json"},body:JSON.stringify({feature_flags:{DuoAgentPlatformNext:true}})});
 const d=await r.json().catch(()=>({}));if(!r.ok||!d.token)throw Error("GitLab Duo direct-access failed: "+r.status+" "+JSON.stringify(d));
 const x={token:d.token,headers:d.headers||{},expires_at:Date.now()+25*60*1000};directCache.set(s.id,x);return x;
}
async function auth(req){
 const c=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!c)return null;
 try{const p=decrypt(c),s=sessions.get(p.sid);if(!s||s.revoked)return null;if(s.expires_at<Date.now()+60000)await refresh(s);return s}catch{return null}
}
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
 return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>GitLab Duo Gateway</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:20px;background:#0b1020;color:#eee}main{background:#151c31;padding:28px;border-radius:16px}a,button{background:#6e40c9;color:#fff;border:0;border-radius:9px;padding:12px 18px;text-decoration:none;font-weight:600}code,pre{background:#090d18;padding:12px;border-radius:8px;display:block;overflow:auto}small{color:#aab2c5}.ok{color:#6ee7b7}</style></head><body><main><h1>GitLab Duo Gateway</h1><p>OAuth bridge and Anthropic-compatible proxy for GitLab Duo.</p><small>GitLab Application Callback URL</small><code>"+cb+"</code>"+(connected?"<p class=ok>✓ GitLab connected</p><button onclick='load()'>Generate Claude Code credential</button><pre id=out>Click the button.</pre><h3>Claude Code</h3><pre>export ANTHROPIC_BASE_URL=\""+base+"\"\nexport ANTHROPIC_AUTH_TOKEN=\"PASTE_CREDENTIAL_HERE\"\nclaude</pre><p><a href=/logout>Disconnect</a></p>":"<p><a href=/oauth/start>Connect GitLab Duo</a></p>")+"<script>async function load(){const r=await fetch('/api/credential'),j=await r.json();document.querySelector('#out').textContent=j.credential||j.error||'failed'}</script></main></body></html>";
}

const server=http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,"http://"+(req.headers.host||"localhost"));
  if(u.pathname==="/health")return send(res,200,{ok:true,service:"gitlab-duo-gateway"});
  if(u.pathname==="/oauth/start"){if(!config(res))return;const st=random(24),a=new URL(GITLAB_BASE+"/oauth/authorize");a.searchParams.set("client_id",CLIENT_ID);a.searchParams.set("redirect_uri",redirectUri(req));a.searchParams.set("response_type","code");a.searchParams.set("state",st);a.searchParams.set("scope","api");res.writeHead(302,{location:a.toString(),"set-cookie":cookie("oauth_state",signedState(st),600)});return res.end()}
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
