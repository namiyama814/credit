import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { harness } from './helpers';
vi.mock('../src/server/mcp',()=>({mcpHandler:()=>()=>new Response('MCP test stub')}));
vi.mock('@cloudflare/workers-oauth-provider',()=>({
  authorizationErrorRedirect:(request:{redirectUri:string;state?:string;issuer?:string},code:string)=>{const url=new URL(request.redirectUri);url.searchParams.set('error',code);if(request.state)url.searchParams.set('state',request.state);if(request.issuer)url.searchParams.set('iss',request.issuer);return url.href;},
  AuthorizationError:class extends Error {},CimdFetchError:class extends Error {},
  OAuthProvider:class {constructor(private options:{defaultHandler:{fetch:(...args:unknown[])=>unknown}}){}fetch(...args:unknown[]){return this.options.defaultHandler.fetch(...args);}}
}));
import { Hono } from 'hono';
import { githubCallback, type Bindings, type Variables } from '../src/server/auth';
import { AppError } from '../src/server/domain';
import worker from '../src/server/index';
import { hash } from '../src/server/domain';
import { fixtureQuestion } from './fixtures';
import { practiceVisibility } from '../src/server/practice-visibility';
import { ensureUser,insertQuestion,createPracticeSet,practiceResults } from '../src/server/service';
let h:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{h=await harness();});
afterEach(async()=>{await h?.mf.dispose();});
const origin='https://study.example.com';
async function session(user:string,method:'study'|'github'){
  await ensureUser(h.db,user,'security-test');
  const token=crypto.randomUUID(),csrf=crypto.randomUUID();
  await h.db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at,auth_method) VALUES(?,?,?,?,?)').bind(await hash(token),user,csrf,new Date(Date.now()+60000).toISOString(),method).run();
  return {token,csrf};
}
async function request(path:string,method='GET',auth?:{token:string;csrf:string},body:unknown={}){
  const env={...h.env,APP_MODE:'production',APP_ORIGIN:origin,OWNER_GITHUB_ID:'123'} as unknown as Env;
  const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
  return worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,...(auth?{Cookie:`__Host-info1_session=${auth.token}`,'X-CSRF-Token':auth.csrf}:{}),...(method==='GET'?{}:{'Content-Type':'application/json'})},...(method==='GET'?{}:{body:JSON.stringify(body)})}),env,ctx);
}
it('本番でも学習は匿名で開けるが管理APIはstudyセッションを拒否する',async()=>{
  expect((await request('/api/me')).status).toBe(200);
  const auth=await session('github:123','study');
  for(const [method,path]of [['GET','/api/backup'],['POST','/api/restore'],['POST','/api/import/question'],['POST','/api/import/image'],['POST','/api/import/finish'],['POST','/api/jobs/run'],['POST','/api/results/unknown/correct'],['POST','/api/results/unknown/regrade'],['POST','/api/practice'],['POST','/api/practice/unknown/adopt'],['POST','/api/practice/unknown/retry'],['DELETE','/api/practice/unknown/items/unknown']]){
    expect((await request(path,method,auth)).status,method+' '+path).toBe(403);
  }
  expect((await request('/api/questions','GET',auth)).status).toBe(200);
  expect((await request('/api/draft','PUT',auth)).status).toBe(400);
});
it('管理APIは本人のGitHubセッションに限定しCSRFも検証する',async()=>{
  const wrong=await session('github:456','github');expect((await request('/api/import/question','POST',wrong)).status).toBe(403);
  const owner=await session('github:123','github');expect((await request('/api/import/question','POST',owner)).status).toBe(400);
  expect((await request('/api/import/question','POST',{...owner,csrf:'wrong'})).status).toBe(403);
});

it('正答権限なしでは独立検証の正答も公開API・MCP共通の表示から除く',async()=>{
  const user='github:123';await ensureUser(h.db,user,'owner');
  await insertQuestion(h.db,fixtureQuestion(0),0);
  const set=await createPracticeSet(h.db,user,{origin:'school',name:'scope-check',count:1});
  const verification={valid:true,independentAnswer:'SECRET_REFERENCE',calculationResult:'SECRET_CALCULATION',reason:'SECRET_REASON',nested:{answer:'SECRET_NESTED'}};
  await h.db.prepare("UPDATE practice_sets SET status='draft' WHERE id=?").bind(set.id).run();
  await h.db.prepare('UPDATE practice_items SET verification=? WHERE set_id=?').bind(JSON.stringify(verification),set.id).run();
  const result=await practiceResults(h.db,user,set.id);
  const hidden=practiceVisibility(result,false);expect(hidden.items[0]).not.toHaveProperty('verification');expect(hidden.items[0]).not.toHaveProperty('correctAnswer');expect(JSON.stringify(hidden)).not.toContain('SECRET_');
  expect(practiceVisibility(result,true).items[0]).toHaveProperty('verification',verification);
  const auth=await session(user,'study');const response=await request('/api/practice/'+set.id,'GET',auth);expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain('SECRET_');
});
it('GitHubコールバックはstateをブラウザに束縛し数値IDで本人だけを許可する',async()=>{
  const state=crypto.randomUUID(),stateHash=await hash(state);
  const env={...h.env,APP_MODE:'production',APP_ORIGIN:origin,OWNER_GITHUB_ID:'123'} as unknown as Env;
  const ctx={waitUntil(){},passThroughOnException(){}} as unknown as ExecutionContext;
  const issue=async(id:number,browserState:string=state)=>{
    await h.env.OAUTH_KV.put('login:'+stateHash,JSON.stringify({next:'/\t/evil.example',verifier:'test-verifier'}));
    const upstream=vi.fn(async (url:unknown)=>String(url).includes('/access_token')?Response.json({access_token:'not-a-real-token'}):Response.json({id,login:'test-user'}));
    vi.stubGlobal('fetch',upstream);
    try{return {response:await worker.fetch(new Request(origin+'/auth/github/callback?state='+state+'&code=test-code',{headers:{Cookie:'info1_oauth_state='+browserState}}),env,ctx),upstream};}
    finally{vi.unstubAllGlobals();}
  };
  const forged=await issue(123,'wrong-state');expect(forged.response.status).toBe(400);expect(forged.upstream).not.toHaveBeenCalled();
  const wrong=await issue(456);expect(wrong.response.status).toBe(403);expect((await h.db.prepare('SELECT COUNT(*) AS n FROM sessions').first<{n:number}>())!.n).toBe(0);
  const owner=await issue(123);expect(owner.response.status).toBe(302);expect(owner.response.headers.get('location')).toBe('/');expect(owner.response.headers.get('set-cookie')).toContain('__Host-info1_session=');
  expect(await h.db.prepare('SELECT user_id,auth_method FROM sessions').first()).toMatchObject({user_id:'github:123',auth_method:'github'});
});

it('GitHubで拒否した場合もstate/browser検証後に検証済みMCPクライアントへaccess_deniedを返す',async()=>{
  const app=new Hono<{Bindings:Bindings;Variables:Variables}>();app.get('/callback',githubCallback);app.onError((e,c)=>c.json({error:e.message},400));
  const finish=vi.fn(async(request:Request)=>{
    const state=new URL(request.url).searchParams.get('state');
    if(state!=='bound-state'||request.headers.get('Cookie')!=='upstream-browser=expected')throw new AppError(400,'Invalid browser-bound state');
    return {request:{redirectUri:'https://client.example/callback',state:'client-state',issuer:origin},data:{verifier:'secret'},headers:new Headers({'Set-Cookie':'upstream-browser=; Max-Age=0; Secure; HttpOnly'})};
  });
  const exchange=vi.fn();vi.stubGlobal('fetch',exchange);
  const env={...h.env,OAUTH_PROVIDER:{finishUpstream:finish}} as unknown as Bindings;
  try{
    const invalid=await app.request('/callback?state=bound-state&error=access_denied',{headers:{Cookie:'upstream-browser=wrong'}},env);expect(invalid.status).toBe(400);expect(invalid.headers.get('location')).toBeNull();
    const response=await app.request('/callback?state=bound-state&error=access_denied&redirect_uri=https://evil.example',{headers:{Cookie:'upstream-browser=expected'}},env);
    expect(response.status).toBe(302);const redirect=new URL(response.headers.get('location')!);expect(redirect.origin).toBe('https://client.example');expect(redirect.searchParams.get('error')).toBe('access_denied');expect(redirect.searchParams.get('state')).toBe('client-state');expect(redirect.searchParams.get('iss')).toBe(origin);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(exchange).not.toHaveBeenCalled();expect(finish).toHaveBeenCalledTimes(2);
  }finally{vi.unstubAllGlobals();}
});
