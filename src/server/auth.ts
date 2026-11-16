import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { OAuthHelpers, ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { authorizationErrorRedirect } from '@cloudflare/workers-oauth-provider';
import { AppError, hash, id, now } from './domain';
import { ensureUser, stmt } from './service';

export type Bindings=Env&{OAUTH_PROVIDER:OAuthHelpers};
export type Variables={userId:string;csrf:string};
export type AppContext=Context<{Bindings:Bindings;Variables:Variables}>;
// OAuth grants use colon-delimited IDs; keep the D1 identity unchanged in token props.
const oauthUserId=(internalUserId:string)=>internalUserId.replace(/^github:(\d+)$/u,'github-$1');
const cookieName=(c:AppContext)=>c.env.APP_MODE==='production'?'__Host-info1_session':'info1_session';
const secure=(c:AppContext)=>c.env.APP_MODE==='production';
export const escapeHTML=(s:string)=>s.replace(/[&<>"']/gu,c=>`&#${c.charCodeAt(0)};`);
export async function getSession(c:AppContext){
  const token=getCookie(c,cookieName(c));if(!token)return null;
  return stmt(c.env.DB,'SELECT user_id,csrf,expires_at,auth_method FROM sessions WHERE token_hash=? AND expires_at>?',await hash(token),now()).first<{user_id:string;csrf:string;expires_at:string;auth_method:string}>();
}
export function isOwnerSession(session:{user_id:string;auth_method:string}|null,env:Env){
  return session?.auth_method==='github'&&(session.user_id===`github:${env.OWNER_GITHUB_ID}`||(env.APP_MODE==='test'&&session.user_id==='test-owner'));
}
export async function createSession(c:AppContext,userId:string,login:string,authMethod:'github'|'study'='github'){
  await ensureUser(c.env.DB,userId,login);
  const token=id()+id(),csrf=id(),expires=new Date(Date.now()+7*86400000).toISOString();
  await stmt(c.env.DB,'INSERT INTO sessions(token_hash,user_id,csrf,expires_at,auth_method) VALUES(?,?,?,?,?)',await hash(token),userId,csrf,expires,authMethod).run();
  setCookie(c,cookieName(c),token,{httpOnly:true,secure:secure(c),sameSite:'Lax',path:'/',maxAge:7*86400});
  return {userId,csrf};
}
export async function logout(c:AppContext){
  const token=getCookie(c,cookieName(c));if(token)await stmt(c.env.DB,'DELETE FROM sessions WHERE token_hash=?',await hash(token)).run();
  deleteCookie(c,cookieName(c),{path:'/',secure:secure(c)});
}
function githubURL(c:AppContext,state:string,challenge:string){
  if(!c.env.GITHUB_CLIENT_ID||!c.env.GITHUB_CLIENT_SECRET)throw new AppError(503,'GitHubログインの接続設定が必要です。');
  const u=new URL('https://github.com/login/oauth/authorize');
  u.search=new URLSearchParams({client_id:c.env.GITHUB_CLIENT_ID,redirect_uri:`${c.env.APP_ORIGIN}/auth/github/callback`,state,scope:'read:user',code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return u.toString();
}
const verifier=()=>id().replaceAll('-','')+id().replaceAll('-','');
const challenge=async(s:string)=>btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
function localNext(next:string|null):string {return next?.startsWith('/')&&!next.startsWith('//')&&!/[\\\u0000-\u0020\u007f]/u.test(next)?next:'/';}
export async function githubStart(c:AppContext){
  const state=id()+id(),v=verifier();
  await c.env.OAUTH_KV.put(`login:${await hash(state)}`,JSON.stringify({next:localNext(c.req.query('next')??null),verifier:v}),{expirationTtl:600});
  setCookie(c,'info1_oauth_state',state,{httpOnly:true,secure:secure(c),sameSite:'Lax',path:'/',maxAge:600});
  return c.redirect(githubURL(c,state,await challenge(v)));
}
async function exchangeGithub(c:AppContext,code:string,v:string){
  const tokenResponse=await fetch('https://github.com/login/oauth/access_token',{
    method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},
    body:JSON.stringify({client_id:c.env.GITHUB_CLIENT_ID,client_secret:c.env.GITHUB_CLIENT_SECRET,code,code_verifier:v,redirect_uri:`${c.env.APP_ORIGIN}/auth/github/callback`}),signal:AbortSignal.timeout(15000),
  });
  const token=await tokenResponse.json<{access_token?:string;error?:string}>();
  if(!tokenResponse.ok||!token.access_token)throw new AppError(401,'GitHub認証を完了できませんでした。');
  const response=await fetch('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'info1-study'},signal:AbortSignal.timeout(15000)});
  const user=await response.json<{id:number;login:string}>();
  if(!response.ok||String(user.id)!==c.env.OWNER_GITHUB_ID)throw new AppError(403,'このアカウントは利用できません。');
  return {userId:`github:${user.id}`,login:user.login};
}
export async function githubCallback(c:AppContext){
  const state=c.req.query('state')??'',code=c.req.query('code')??'',denied=c.req.query('error');
  if(!state||(!code&&!denied))throw new AppError(400,'GitHub認証をやり直してください。');
  const h=await hash(state),login=await c.env.OAUTH_KV.get<{next:string;verifier:string}>(`login:${h}`,'json');
  if(login){
    const browser=getCookie(c,'info1_oauth_state');
    if(!browser||await hash(browser)!==h)throw new AppError(400,'認証を開始したブラウザでやり直してください。');
    await c.env.OAUTH_KV.delete(`login:${h}`);
    deleteCookie(c,'info1_oauth_state',{path:'/'});
    if(denied)throw new AppError(401,'GitHub認証がキャンセルされました。');
    const user=await exchangeGithub(c,code,login.verifier);await createSession(c,user.userId,user.login);
    return c.redirect(localNext(login.next));
  }
  const oauth=c.env.OAUTH_PROVIDER;
  const upstream=await oauth.finishUpstream<{verifier:string}>(c.req.raw);
  if(denied){
    // Only the browser-bound, server-stored authorization request determines
    // the redirect. Callback parameters never supply a client redirect URI.
    upstream.headers.set('Location',authorizationErrorRedirect(upstream.request,'access_denied'));
    return new Response(null,{status:302,headers:upstream.headers});
  }
  const user=await exchangeGithub(c,code,upstream.data.verifier);
  await createSession(c,user.userId,user.login);
  const {redirectTo}=await oauth.completeAuthorization({request:upstream.request,userId:oauthUserId(user.userId),metadata:{},scope:upstream.request.scope,props:{userId:user.userId,scopes:upstream.request.scope}});
  for(const [key,value] of upstream.headers)if(key.toLowerCase()==='set-cookie')c.header('Set-Cookie',value,{append:true});
  return c.redirect(redirectTo);
}
export const SCOPES=['learning:read','questions:read','answers:read','practice:write','grading:write','offline_access'];
const LABELS:Record<string,string>={'learning:read':'学習状況・回答履歴の閲覧','questions:read':'問題の閲覧','answers:read':'正答・解説の閲覧','practice:write':'問題集の作成','grading:write':'採点の修正・再評価','offline_access':'接続の継続'};
function consentPage(d:ConsentDescription,handle:string){
  const scopes=d.scope.length?d.scope:SCOPES.filter(s=>s!=='offline_access');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>接続を許可 | 情報Ⅰ</title><link rel="stylesheet" href="/fonts/noto.css"><link rel="stylesheet" href="/auth.css"></head><body><main><p>情報Ⅰ</p><h1>${escapeHTML(d.clientName)}との接続</h1><p>接続先 ${escapeHTML(d.redirectHost)}</p>${d.clientDomain?`<p>提供元 ${escapeHTML(d.clientDomain)}</p>`:'<p>クライアント名は接続元の申告です。</p>'}${d.redirectIsLoopback?'<p>この端末で接続を開始した場合だけ許可してください。</p>':''}<form method="post"><input type="hidden" name="handle" value="${escapeHTML(handle)}"><fieldset><legend>許可する操作</legend>${scopes.filter(s=>SCOPES.includes(s)).map(s=>`<label><input type="checkbox" name="scope" value="${s}" ${s.endsWith(':write')||s==='answers:read'?'':'checked'}>${LABELS[s]}</label>`).join('')}</fieldset><div class="actions"><button name="decision" value="approve">接続を許可</button><button class="secondary" name="decision" value="deny">拒否</button></div></form></main></body></html>`;
}
export async function authorizeGET(c:AppContext){
  const oauth=c.env.OAUTH_PROVIDER,request=await oauth.parseAuthRequest(c.req.raw);
  if(request.scope.some(s=>!SCOPES.includes(s)))throw new AppError(400,'対応していない権限です。');
  const details=await oauth.describeConsent(request),consent=await oauth.beginConsent(request);
  consent.headers.set('Content-Type','text/html; charset=utf-8');
  return new Response(consentPage(details,consent.handle),{headers:consent.headers});
}
export async function authorizePOST(c:AppContext){
  if(c.req.header('Origin')!==c.env.APP_ORIGIN)throw new AppError(403,'接続元を確認してください。');
  const oauth=c.env.OAUTH_PROVIDER,form=await c.req.formData(),handle=String(form.get('handle')??'');
  if(form.get('decision')!=='approve'){
    const denied=await oauth.denyConsent(c.req.raw,handle);return new Response(null,{status:302,headers:denied.headers});
  }
  const scope=form.getAll('scope').map(String);
  if(scope.some(s=>!SCOPES.includes(s))||!scope.includes('learning:read'))throw new AppError(400,'学習状況の閲覧権限が必要です。');
  const approved=await oauth.approveConsent(c.req.raw,handle,{scope});
  const session=await getSession(c);
  if(session&&isOwnerSession(session,c.env)){
    const {redirectTo}=await oauth.completeAuthorization({request:approved.request,userId:oauthUserId(session.user_id),metadata:{},scope:approved.request.scope,props:{userId:session.user_id,scopes:approved.request.scope}});
    approved.headers.set('Location',redirectTo);return new Response(null,{status:302,headers:approved.headers});
  }
  const v=verifier(),upstream=await oauth.beginUpstream(approved.request,{data:{verifier:v},headers:approved.headers});
  upstream.headers.set('Location',githubURL(c,upstream.state,await challenge(v)));
  return new Response(null,{status:302,headers:upstream.headers});
}
