import {it,expect,vi} from 'vitest';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {harness} from './helpers';
import {mcpHandler} from '../src/server/mcp';
import {processJobs} from '../src/server/ai';
import {insertQuestion,roundProgress,startRound} from '../src/server/service';
import {fixtureQuestion} from './fixtures';

it('認証済みMCPの学習状況からAI生成・検証結果の確認・採用まで既存周回を変えず実行する',async()=>{
 const h=await harness();const prompts:string[]=[];let call=0;
 Object.defineProperty(h.env,'AI',{value:{run:vi.fn(async(_model,options)=>{
   prompts.push(options.messages[1].content);const n=Math.floor(call++/2)+1;
   return {response:call%2?{text:`2進数の${n===1?'11':'100'}を10進数に変換してください。`,type:'記述式',choices:[],answer:String(n+2),correctChoice:null,explanation:`桁の価値を足すと${n+2}です。`,concepts:['2進数・数値表現'],calculation:{type:'base_conversion',value:n===1?'11':'100',from:2,to:10}}:{valid:true,uniqueAnswer:true,factuallyCorrect:true,aligned:true,reason:'独立検証済み',independentAnswer:String(n+2),confidence:0.99}};
 })}});
 const handler=mcpHandler(h.env,h.user,['learning:read','questions:read','answers:read','practice:write']);
 const client=new Client({name:'generation-flow',version:'1.0.0'});
 try{
  await insertQuestion(h.db,fixtureQuestion(0),0);await startRound(h.db,h.user);const before=await roundProgress(h.db,h.user);
  await client.connect(new StreamableHTTPClientTransport(new URL(h.env.APP_ORIGIN+'/mcp'),{fetch:async(input,init)=>{const request=new Request(input,init);request.headers.set('Host',new URL(request.url).host);return handler(request,h.env,{} as ExecutionContext);}}));
  const invoke=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r)).not.toBe(true);return (r.structuredContent as {data:unknown}).data;};
  for(const name of ['get_learning_context','get_weak_topics','search_questions'])await invoke(name);
  await invoke('get_question_details',{questionId:'fixture-0',includeAnswer:true});
  const set=await invoke('create_practice_set',{origin:'ai',name:'2進数の基礎',count:2,tags:['2進数・数値表現'],instructions:'桁の価値、2進数から10進数、10進数から2進数。基礎から段階的に。'}) as {id:string};
  expect((await client.callTool({name:'approve_practice_set',arguments:{setId:set.id}})).isError).toBe(true);
  for(let i=0;i<2;i++)await processJobs(h.env,1);
  const results=await invoke('get_practice_set_results',{setId:set.id}) as {set:{status:string};items:{correctAnswer:string;explanation:string;verification:{valid:boolean;calculationResult:string}}[];jobs:{status:string}[]};
  expect(results.set.status).toBe('draft');expect(results.items).toHaveLength(2);expect(results.jobs[0].status).toBe('done');
  for(const item of results.items){expect(item.correctAnswer).toBeTruthy();expect(item.explanation).toBeTruthy();expect(item.verification.valid).toBe(true);expect(item.verification.calculationResult).toBeTruthy();}
  expect(prompts[0]).toContain('桁の価値');expect(prompts[0]).toContain('単元 【第2回】情報を伝える');expect(prompts[2]).toContain('全2問の2問目');
  expect(await invoke('approve_practice_set',{setId:set.id})).toEqual({adopted:true});
  expect((await invoke('get_practice_set_results',{setId:set.id}) as {set:{status:string}}).set.status).toBe('ready');
  expect(await roundProgress(h.db,h.user)).toEqual(before);
 }finally{await client.close();await h.mf.dispose();}
});
