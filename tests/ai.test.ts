import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { harness } from './helpers';
import { fixtureQuestion } from './fixtures';
import { approvePracticeSet,insertQuestion,startRound,submitAnswer,roundProgress,recordEvaluation,createPracticeSet,practiceResults } from '../src/server/service';
import { applyRubric,failedGrade,processJobs,solveCalculation } from '../src/server/ai';
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
it('独自問題を生成・独立検証しても採用前は演習不可とする',async()=>{
 const set=await createPracticeSet(h.db,h.user,{origin:'ai',mode:'comprehensive',name:'架空の生成問題',count:1});let call=0;
 ai(async()=>({response:++call===1?{text:'架空のテスト問題です。正しい説明を選んでください。',type:'選択式',choices:['正しい説明','誤った説明1','誤った説明2','誤った説明3'],answer:'正しい説明',correctChoice:0,explanation:'架空の説明を検証するテストです。',concepts:['情報モラル'],calculation:null}:{valid:true,uniqueAnswer:true,factuallyCorrect:true,aligned:true,reason:'独立検証済み',independentAnswer:'正しい説明',confidence:0.95}}));
 await processJobs(h.env,1);const r=await practiceResults(h.db,h.user,set.id);expect(r.set.status).toBe('draft');expect(r.items).toHaveLength(1);expect(r.items[0].question.origin).toBe('ai');await approvePracticeSet(h.db,h.user,set.id);expect((await practiceResults(h.db,h.user,set.id)).set.status).toBe('ready');expect((await h.db.prepare('SELECT COUNT(*) AS n FROM rounds').first<{n:number}>())!.n).toBe(0);
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
it('古いleaseの生成失敗は新しい生成ジョブをfailedにしない',async()=>{
 const set=await createPracticeSet(h.db,h.user,{origin:'ai',name:'生成競合',count:1});await h.db.prepare('UPDATE jobs SET tries=2').run();
 ai(async()=>{await h.db.prepare("UPDATE jobs SET lease_until='2099-01-01T00:00:00.000Z',status='running'").run();throw new Error('古い生成の失敗');});await processJobs(h.env,1);
 expect((await practiceResults(h.db,h.user,set.id)).set.status).toBe('generating');
});

it('最終問題保存後に生成ジョブが再開しても問題を追加しない',async()=>{
 const set=await createPracticeSet(h.db,h.user,{origin:'ai',name:'再開生成',count:1});
 const q=await insertQuestion(h.db,fixtureQuestion(70),70,'ai');await h.db.prepare('INSERT INTO practice_items VALUES(?,?,?,?,?)').bind(set.id,q.id,q.version,0,JSON.stringify({valid:true})).run();
 ai(async()=>{throw new Error('呼び出してはいけません');});await processJobs(h.env,1);
 expect(h.env.AI.run).not.toHaveBeenCalled();expect((await practiceResults(h.db,h.user,set.id)).set.status).toBe('draft');expect((await practiceResults(h.db,h.user,set.id)).items).toHaveLength(1);
});
