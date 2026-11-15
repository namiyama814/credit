import { test,expect,type Page,type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { fixtureQuestion } from '../fixtures';
const origin='http://127.0.0.1:4322';
async function authorize(page:Page,request:APIRequestContext,scopes:string,github=true){
 const login=github?await request.post('/auth/test'):await request.get('/api/me');const {csrf}=await login.json();await page.context().addCookies((await request.storageState()).cookies);
 await request.post('/api/import/question?position=0',{headers:{Origin:origin,'X-CSRF-Token':csrf},data:fixtureQuestion(0)});
 const callback=`${origin}/oauth/test-callback`;
 const registration=await request.post('/oauth/register',{data:{client_name:'MCP検証クライアント',redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}});expect(registration.ok()).toBe(true);
 const {client_id:clientId}=await registration.json();const verifier='x'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');
 const query=new URLSearchParams({client_id:clientId,redirect_uri:callback,response_type:'code',scope:scopes,state:'test-state',code_challenge:challenge,code_challenge_method:'S256',resource:`${origin}/mcp`});
 await page.route('**/oauth/test-callback?**',route=>route.fulfill({status:200,contentType:'text/plain',body:'接続確認'}));
 await page.goto('/authorize?'+query);await expect(page.getByRole('heading',{name:'MCP検証クライアントとの接続'})).toBeVisible();
 for(const name of ['正答・解説の閲覧','問題集の作成']){const checkbox=page.getByRole('checkbox',{name});if(await checkbox.count())await checkbox.check();}
 if(!github){const handle=await page.locator('input[name=handle]').inputValue();const r=await page.request.post(origin+'/authorize',{headers:{Origin:origin},form:{handle,decision:'approve',scope:'learning:read'},maxRedirects:0});expect(r.status()).toBe(302);expect(new URL(r.headers().location).origin).toBe('https://github.com');return {tokens:{access_token:'',refresh_token:''},clientId};}
 await page.getByRole('button',{name:'接続を許可'}).click();
 await expect(page).toHaveURL(/\/oauth\/test-callback/u);
 const code=new URL(page.url()).searchParams.get('code');expect(code).toBeTruthy();
 const token=await request.post('/oauth/token',{form:{grant_type:'authorization_code',client_id:clientId,redirect_uri:callback,code:code!,code_verifier:verifier,resource:`${origin}/mcp`}});
 expect(token.ok()).toBe(true);const tokens=await token.json();expect(tokens.access_token).toBeTruthy();return {tokens,clientId};
}
test('OAuth認可後、実際のMCP SDKクライアントで全11ツールを呼ぶ',async({page,request})=>{
 const {tokens,clientId}=await authorize(page,request,'learning:read questions:read answers:read practice:write offline_access');
 const client=new Client({name:'info1-integration',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
 try{
  const tools=await client.listTools();expect(tools.tools).toHaveLength(11);
  const calls:[string,Record<string,unknown>][]=[['get_learning_context',{}],['get_round_progress',{}],['get_weak_topics',{}],['get_answer_history',{}],['get_question_details',{questionId:'fixture-0',includeAnswer:true}],['search_questions',{}],['recommend_questions',{}],['get_ai_grading_results',{}]];
  for(const [name,args]of calls){const result=await client.callTool({name,arguments:args});expect(result.isError,`${name}: ${JSON.stringify(result)}`).not.toBe(true);}
  const created=await client.callTool({name:'create_practice_set',arguments:{origin:'school',name:'MCPからの復習',count:1}});expect(created.isError).not.toBe(true);const setId=(created.structuredContent as {data:{id:string}}).data.id;
  expect((await client.callTool({name:'approve_practice_set',arguments:{setId}})).isError).not.toBe(true);
  expect((await client.callTool({name:'get_practice_set_results',arguments:{setId}})).isError).not.toBe(true);
 }finally{await client.close();}
 expect(tokens.refresh_token).toBeTruthy();const refreshed=await request.post('/oauth/token',{form:{grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource:`${origin}/mcp`}});expect(refreshed.ok()).toBe(true);
 const fresh=await refreshed.json();const metadata=await (await request.get('/.well-known/oauth-authorization-server')).json();expect(metadata.revocation_endpoint).toBeTruthy();
 expect((await request.post(metadata.revocation_endpoint,{form:{token:fresh.access_token,client_id:clientId,token_type_hint:'access_token'}})).ok()).toBe(true);
 expect((await request.post('/mcp',{headers:{Authorization:`Bearer ${fresh.access_token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},data:{jsonrpc:'2.0',id:1,method:'tools/list'}})).status()).toBe(401);
});
test('読み取りだけのトークンでは問題集を作れない',async({page,request})=>{
 const {tokens}=await authorize(page,request,'learning:read');const client=new Client({name:'readonly-test',version:'1.0.0'});await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${tokens.access_token}`}}}));
 try{expect((await client.callTool({name:'get_learning_context',arguments:{}})).isError).not.toBe(true);expect((await client.callTool({name:'create_practice_set',arguments:{origin:'school',name:'拒否される問題集',count:1}})).isError).toBe(true);}finally{await client.close();}
});

test('ログイン不要の学習セッションだけではMCPを認可できない',async({page,request})=>{
 await authorize(page,request,'learning:read',false);
 expect((await request.get('/mcp')).status()).toBe(401);
});
