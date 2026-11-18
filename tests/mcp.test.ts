import {it,expect,vi} from 'vitest';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {harness} from './helpers';
import {mcpHandler} from '../src/server/mcp';
import {processJobs} from '../src/server/ai';
import {insertQuestion,roundProgress,startRound,nextExercise,submitAnswer} from '../src/server/service';
import {fixtureQuestion} from './fixtures';
import {practiceQuestion} from './practice-fixtures';
import {id} from '../src/server/domain';
it('MCPから12問を段階保存・検算・確認・採用・回答しWorkers AIと通常周回を変更しない',async()=>{
 const h=await harness();const run=vi.fn(async()=>{throw Error('問題生成では呼ばない');});Object.defineProperty(h.env,'AI',{value:{run}});
 const handler=mcpHandler(h.env,h.user,['learning:read','questions:read','answers:read','practice:write']);const client=new Client({name:'client-generation',version:'1.0.0'});
 try{
 await insertQuestion(h.db,fixtureQuestion(0),0);await startRound(h.db,h.user);const before=await roundProgress(h.db,h.user);
 await client.connect(new StreamableHTTPClientTransport(new URL(h.env.APP_ORIGIN+'/mcp'),{fetch:async(input,init)=>{const request=new Request(input,init);request.headers.set('Host',new URL(request.url).host);return handler(request,h.env,{} as ExecutionContext);}}));
 const invoke=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r)).not.toBe(true);return (r.structuredContent as {data:any}).data;};
 await invoke('get_learning_context');const setId=id();
 const input={setId,origin:'ai',name:'2進数の基礎',count:12,questions:[practiceQuestion(1)]};
 expect(await invoke('create_practice_set',input)).toMatchObject({id:setId,status:'generating',generated:1});
 expect(await invoke('create_practice_set',input)).toMatchObject({generated:1});
 expect((await client.callTool({name:'approve_practice_set',arguments:{setId}})).isError).toBe(true);
 const partial=await invoke('get_practice_set_results',{setId});expect(partial.progress).toEqual({generated:1,verified:1,total:12});expect(partial.items[0].correctAnswer).toBeTruthy();
 await invoke('create_practice_set',{...input,questions:Array.from({length:11},(_,i)=>practiceQuestion(i+2))});await processJobs(h.env,2);
 const result=await invoke('get_practice_set_results',{setId});expect(result.set.status).toBe('draft');expect(result.items).toHaveLength(12);expect(result.jobs).toHaveLength(0);
 for(const item of result.items){expect(item.correctAnswer).toBeTruthy();expect(item.verification).toMatchObject({valid:true,method:'client_review_and_calculation'});expect(item.verification.calculationResult).toBeTruthy();}
 await invoke('approve_practice_set',{setId});expect((await invoke('get_practice_set_results',{setId})).set.status).toBe('ready');
 const ex=await nextExercise(h.db,h.user,'practice',setId);expect(ex.question).toBeTruthy();
 const answer=await submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:setId,questionId:ex.question!.id,versionId:ex.question!.versionId,response:'3',durationMs:1000});expect(answer.attempt.verdict).toBe('correct');
 expect(run).not.toHaveBeenCalled();expect(await roundProgress(h.db,h.user)).toEqual(before);
 }finally{await client.close();await h.mf.dispose();}
});

it('MCPのAI採点は回答時点の資料を渡し、権限と評価版を検証して履歴に保存する',async()=>{
 const h=await harness();const clients:Client[]=[];
 const connect=async(scopes:string[])=>{
  const handler=mcpHandler(h.env,h.user,scopes),client=new Client({name:'grading-client',version:'1.0.0'});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(h.env.APP_ORIGIN+'/mcp'),{fetch:async(input,init)=>{const request=new Request(input,init);request.headers.set('Host',new URL(request.url).host);return handler(request,h.env,{} as ExecutionContext);}}));return client;
 };
 try{
  await insertQuestion(h.db,fixtureQuestion(0,'論述式'),0);const round=await startRound(h.db,h.user);const ex=await nextExercise(h.db,h.user);
  const a=await submitAnswer(h.db,h.user,{id:id(),contextType:'round',contextId:round.id,questionId:ex.question!.id,versionId:ex.question!.versionId,response:'意味を説明した回答',durationMs:100});
  const read=await connect(['learning:read']);
  expect((await read.callTool({name:'get_grading_tasks',arguments:{}})).isError).toBe(true);
  const client=await connect(['learning:read','questions:read','answers:read','grading:write']);
  const fetched=await client.callTool({name:'get_grading_tasks',arguments:{}});expect(fetched.isError).not.toBe(true);
  const {tasks}=(fetched.structuredContent as {data:{tasks:any[]}}).data;expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({attemptId:a.attempt.id,response:'意味を説明した回答',referenceAnswer:fixtureQuestion(0,'論述式').correct_answer});
  const input={attemptId:a.attempt.id,evaluationSeq:tasks[0].evaluationSeq,verdict:'correct',reason:'必須概念を説明しています。',model:'client-test-model',confirm:true};
  expect((await read.callTool({name:'submit_ai_grading',arguments:input})).isError).toBe(true);
  const other=await connect(['learning:read','questions:read','answers:read','grading:write']);
  // The same scopes cannot access a different user's answer.
  const foreignHandler=mcpHandler(h.env,'other-user',['learning:read','questions:read','answers:read','grading:write']);
  const foreign=new Client({name:'foreign',version:'1.0.0'});clients.push(foreign);
  await foreign.connect(new StreamableHTTPClientTransport(new URL(h.env.APP_ORIGIN+'/mcp'),{fetch:async(input,init)=>{const request=new Request(input,init);request.headers.set('Host',new URL(request.url).host);return foreignHandler(request,h.env,{} as ExecutionContext);}}));
  expect((await foreign.callTool({name:'submit_ai_grading',arguments:input})).isError).toBe(true);
  expect((await client.callTool({name:'submit_ai_grading',arguments:input})).isError).not.toBe(true);
  expect((await other.callTool({name:'submit_ai_grading',arguments:{...input,verdict:'incorrect'}})).isError).toBe(true);
  expect(await h.db.prepare('SELECT verdict,method,response,evaluation_data FROM effective_attempts WHERE id=?').bind(a.attempt.id).first()).toMatchObject({verdict:'correct',method:'ai',response:JSON.stringify('意味を説明した回答'),evaluation_data:expect.stringContaining('mcp-ai-v1')});
  expect(await h.db.prepare("SELECT status FROM jobs WHERE json_extract(payload,'$.attemptId')=?").bind(a.attempt.id).first()).toMatchObject({status:'done'});
  expect((await roundProgress(h.db,h.user)).current!.status).toBe('cleared');
 }finally{await Promise.all(clients.map(c=>c.close()));await h.mf.dispose();}
});
