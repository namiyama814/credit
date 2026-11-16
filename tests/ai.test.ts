import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { harness } from './helpers';
import { fixtureQuestion } from './fixtures';
import { insertQuestion,startRound,submitAnswer,roundProgress,recordEvaluation,createPracticeSet,practiceResults } from '../src/server/service';
import { applyRubric,failedGrade,processJobs } from '../src/server/ai';
import {solveCalculation} from '../src/server/practice-content';
import { id,now } from '../src/server/domain';
let h:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{h=await harness();});afterEach(async()=>{await h?.mf.dispose();});
const grade={score:90,verdict:'correct',confidence:0.95,reason:'重要概念を説明しています。',strengths:['必要な内容がある'],missing:[],improvement:'',essentialConceptsMet:true,criticalError:false,components:{concepts:45,accuracy:27,conditions:18}};
function ai(fn:()=>Promise<unknown>){Object.defineProperty(h.env,'AI',{value:{run:vi.fn(fn)},configurable:true});}
async function pending(){const q=await insertQuestion(h.db,fixtureQuestion(0,'論述式'),0);const r=await startRound(h.db,h.user);return submitAnswer(h.db,h.user,{id:id(),contextType:'round',contextId:r.id,questionId:q.id,versionId:q.version,response:'必要な概念を説明した回答',durationMs:1000});}
it('論述は構造化した意味評価で採点し、履歴へモデルとバージョンを保存する',async()=>{
 const a=await pending();ai(async()=>({response:grade}));await processJobs(h.env,1);
 const r=await h.db.prepare('SELECT * FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string;evaluation_data:string}>();expect(r!.verdict).toBe('correct');expect(JSON.parse(r!.evaluation_data)).toMatchObject({model:'@cf/google/gemma-4-26b-a4b-it',promptVersion:'essay-v3-json-object'});expect((await roundProgress(h.db,h.user)).current!.status).toBe('cleared');
});
it('不正な構造化出力を不正解扱いせず、再試行後に要確認へ送る',async()=>{
 const a=await pending();ai(async()=>({response:'invalid JSON'}));for(let i=0;i<3;i++){await h.db.prepare("UPDATE jobs SET next_at=?").bind('2000-01-01T00:00:00.000Z').run();await processJobs(h.env,1);}
 const r=await h.db.prepare('SELECT verdict FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string}>();expect(r!.verdict).toBe('needs_review');expect((await roundProgress(h.db,h.user)).current!.status).toBe('active');
});
it('実モデルのchat completion形式を検証し、途中で切れたJSONは採用しない',async()=>{
 const a=await pending();ai(async()=>({choices:[{finish_reason:'length',message:{content:JSON.stringify(grade)}}]}));await processJobs(h.env,1);
 expect((await h.db.prepare('SELECT verdict FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string}>())!.verdict).toBe('pending');
 await h.db.prepare('UPDATE jobs SET next_at=?').bind('2000-01-01T00:00:00.000Z').run();
 ai(async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(grade)}}]}));await processJobs(h.env,1);
 expect((await h.db.prepare('SELECT verdict FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string}>())!.verdict).toBe('correct');
});
it('無料枠到達時はAIを呼ばず回答を採点待ちで保つ',async()=>{
 const a=await pending();ai(async()=>({response:grade}));const day=new Date().toISOString().slice(0,10);await h.db.prepare('INSERT INTO ai_usage VALUES(?,8000,1)').bind(day).run();await processJobs(h.env,1);
 expect(h.env.AI.run).not.toHaveBeenCalled();expect((await h.db.prepare('SELECT verdict FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string}>())!.verdict).toBe('pending');expect((await h.db.prepare('SELECT status FROM jobs').first<{status:string}>())!.status).toBe('deferred');
});
it('推論中の手動採点を遅れて返ったAI結果で上書きしない',async()=>{
 const a=await pending();ai(async()=>{await recordEvaluation(h.db,h.user,a.attempt.id,{...failedGrade('本人が確認'),verdict:'incorrect',score:0,model:'owner',gradedAt:now()},'manual');return {response:grade};});await processJobs(h.env,1);
 const r=await h.db.prepare('SELECT verdict,method FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string;method:string}>();expect(r).toMatchObject({verdict:'incorrect',method:'manual'});
});
it('重大な誤り・低信頼・点数不整合を自動正解にしない',()=>{
 expect(applyRubric({...grade,criticalError:true},'test').verdict).toBe('needs_review');expect(applyRubric({...grade,confidence:0.5},'test').verdict).toBe('needs_review');expect(applyRubric({...grade,score:20},'test').verdict).toBe('needs_review');
});
it('検算できない正答を採用しない',()=>{
 expect(solveCalculation({type:'base_conversion',value:'1101',from:2,to:10})).toBe('13');expect(solveCalculation({type:'binary_addition',left:'11',right:'1'})).toBe('100');expect(solveCalculation({type:'data_size',sampleRate:8000,bits:8,channels:1,seconds:1})).toBe('8000');expect(()=>solveCalculation({type:'base_conversion',value:'19',from:2,to:10})).toThrow();
});

it('古いleaseの推論失敗は再取得したジョブと採点待ちを変更しない',async()=>{
 const a=await pending();await h.db.prepare('UPDATE jobs SET tries=2').run();
 ai(async()=>{await h.db.prepare("UPDATE jobs SET lease_until='2099-01-01T00:00:00.000Z',status='running'").run();throw new Error('古い処理の失敗');});
 await processJobs(h.env,1);
 expect((await h.db.prepare('SELECT verdict FROM effective_attempts WHERE id=?').bind(a.attempt.id).first<{verdict:string}>())!.verdict).toBe('pending');expect((await h.db.prepare('SELECT status,lease_until FROM jobs').first())).toMatchObject({status:'running',lease_until:'2099-01-01T00:00:00.000Z'});
});
it('旧生成ジョブは停止しWorkers AIを呼ばず保存済みの問題を保持する',async()=>{
 const set=await createPracticeSet(h.db,h.user,{origin:'ai',name:'旧生成ジョブ',count:12});
 await h.db.prepare("INSERT INTO jobs(id,user_id,kind,payload,status,next_at,created_at,updated_at) VALUES(?,?,'generate',?,'pending',?,?,?)").bind(id(),h.user,JSON.stringify({setId:set.id}),now(),now(),now()).run();
 ai(async()=>{throw Error('生成では呼びません');});await processJobs(h.env,1);
 expect(h.env.AI.run).not.toHaveBeenCalled();expect((await practiceResults(h.db,h.user,set.id)).set.status).toBe('failed');expect((await practiceResults(h.db,h.user,set.id)).jobs[0].status).toBe('failed');
});
