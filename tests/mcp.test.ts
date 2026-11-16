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
