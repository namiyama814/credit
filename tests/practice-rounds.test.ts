import {it,expect,beforeEach,afterEach} from 'vitest';
import {harness} from './helpers';
import {fixtureQuestion} from './fixtures';
import {createPracticeSet,insertQuestion,nextExercise,practiceResults,restartPracticeSet,submitAnswer,recordEvaluation,roundProgress} from '../src/server/service';
import {id,now,type Evaluation} from '../src/server/domain';
let h:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{h=await harness();});afterEach(async()=>{await h.mf.dispose();});
async function reply(setId:string,response:string|string[]){
 const ex=await nextExercise(h.db,h.user,'practice',setId);expect(ex.question).toBeTruthy();
 return submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:ex.contextId!,questionId:ex.question!.id,versionId:ex.question!.versionId,response,durationMs:10});
}
it('正解を外し不正解だけを自動周回して全問クリアし、元の回答と通常周回を保持する',async()=>{
 for(let i=0;i<3;i++)await insertQuestion(h.db,fixtureQuestion(i),i);
 const set=await createPracticeSet(h.db,h.user,{origin:'school',count:3,name:'不正解だけの周回'});const normal=await roundProgress(h.db,h.user);
 await reply(set.id,['0']);await reply(set.id,['1']);await reply(set.id,['1']);
 const original=await practiceResults(h.db,h.user,set.id),second=await nextExercise(h.db,h.user,'practice',set.id);
 expect(second.contextId).not.toBe(set.id);expect(second.question!.id).toBe('fixture-1');
 const p=await practiceResults(h.db,h.user,second.contextId!);expect(p.items.map(i=>i.question_id)).toEqual(['fixture-1','fixture-2']);expect(p.progress.total).toBe(2);
 await reply(set.id,['0']);await reply(set.id,['1']);
 const third=await nextExercise(h.db,h.user,'practice',set.id);expect(third.question!.id).toBe('fixture-2');expect((await practiceResults(h.db,h.user,third.contextId!)).items).toHaveLength(1);
 await reply(set.id,['0']);const done=await nextExercise(h.db,h.user,'practice',set.id);expect(done.question).toBeNull();expect(done.progress!.current!.status).toBe('cleared');
 expect(await practiceResults(h.db,h.user,set.id)).toEqual(original);expect(await roundProgress(h.db,h.user)).toEqual(normal);
 const n=(await h.db.prepare('SELECT COUNT(*) AS n FROM practice_sets').first<{n:number}>())!.n;
 expect((await restartPracticeSet(h.db,h.user,set.id)).status).toBe('cleared');expect((await h.db.prepare('SELECT COUNT(*) AS n FROM practice_sets').first<{n:number}>())!.n).toBe(n);
});
it('採点待ちと要確認では進めず、採点確定後に不正解だけを残す',async()=>{
 await insertQuestion(h.db,fixtureQuestion(0,'論述式'),0);await insertQuestion(h.db,fixtureQuestion(1),1);
 const set=await createPracticeSet(h.db,h.user,{origin:'school',count:2,name:'採点を待つ'});
 const essay=await reply(set.id,'説明する回答です');await reply(set.id,['1']);
 let ex=await nextExercise(h.db,h.user,'practice',set.id);expect(ex.question).toBeNull();expect(ex.progress!.counts.pending).toBe(1);expect(ex.contextId).toBe(set.id);expect((await restartPracticeSet(h.db,h.user,set.id)).id).toBe(set.id);
 const evaluation:Evaluation={verdict:'needs_review',score:null,reason:'要確認',strengths:[],missing:[],improvement:'',model:'test',promptVersion:'test',rubricVersion:'test',gradedAt:now()};
 await recordEvaluation(h.db,h.user,essay.attempt.id,evaluation,'manual');ex=await nextExercise(h.db,h.user,'practice',set.id);expect(ex.progress!.counts.needs_review).toBe(1);expect(ex.contextId).toBe(set.id);
 await recordEvaluation(h.db,h.user,essay.attempt.id,{...evaluation,verdict:'correct',score:100},'manual');ex=await nextExercise(h.db,h.user,'practice',set.id);expect(ex.question!.id).toBe('fixture-1');expect(ex.contextId).not.toBe(set.id);
});
it('同時に次周回を開いても一つだけ作成し、問題の版を固定する',async()=>{
 const old=await insertQuestion(h.db,fixtureQuestion(0),0);const set=await createPracticeSet(h.db,h.user,{origin:'school',count:1,name:'同時周回'});await reply(set.id,['1']);
 await insertQuestion(h.db,{...fixtureQuestion(0),question_text:'更新された問題の本文です'},0);
 const [a,b]=await Promise.all([nextExercise(h.db,h.user,'practice',set.id),nextExercise(h.db,h.user,'practice',set.id)]);
 expect(a.contextId).toBe(b.contextId);expect(a.question!.versionId).toBe(old.version);expect(a.question!.text).toBe(fixtureQuestion(0).question_text);
 expect((await h.db.prepare('SELECT COUNT(*) AS n FROM practice_sets').first<{n:number}>())!.n).toBe(2);
 await expect(nextExercise(h.db,'other-user','practice',set.id)).rejects.toThrow();
});
