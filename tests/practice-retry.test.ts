import {it,expect} from 'vitest';
import {harness} from './helpers';
import {createPracticeSet,approvePracticeSet,practiceResults,retryPracticeSet} from '../src/server/service';
import {practiceQuestion} from './practice-fixtures';
import {id,now} from '../src/server/domain';
it('再送は既存の版を保持し、上書き・重複・不正答・未検証・他人の問題集を拒否する',async()=>{
 const h=await harness();try{
 const input={origin:'ai',setId:id(),name:'再送テスト',count:2,questions:[practiceQuestion(1)]};
 const set=await createPracticeSet(h.db,h.user,input);const before=await practiceResults(h.db,h.user,set.id);
 await createPracticeSet(h.db,h.user,input);expect((await practiceResults(h.db,h.user,set.id)).items).toEqual(before.items);
 for(const questions of [[{...practiceQuestion(1),answer:'999'}],[{...practiceQuestion(2),verification:{...practiceQuestion(2).verification,valid:false}}],[{...practiceQuestion(2),text:practiceQuestion(1).text}],[{...practiceQuestion(1),explanation:'上書きしようとした別の解説です。'}]]){
 await expect(createPracticeSet(h.db,h.user,{...input,questions})).rejects.toThrow();expect((await practiceResults(h.db,h.user,set.id)).items).toEqual(before.items);
 }
 await expect(createPracticeSet(h.db,'other-user',input)).rejects.toThrow();
 await expect(approvePracticeSet(h.db,h.user,set.id)).rejects.toThrow();
 await createPracticeSet(h.db,h.user,{...input,questions:[practiceQuestion(2)]});await approvePracticeSet(h.db,h.user,set.id);
 await expect(createPracticeSet(h.db,h.user,{...input,questions:[{...practiceQuestion(2),explanation:'採用後の別の解説を保存してはいけません。'}]})).rejects.toThrow();
 expect((await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{n:number}>())!.n).toBe(0);
 }finally{await h.mf.dispose();}
});
it('旧ジョブの再開はWorkers AIを予約せずChatGPTの入力待ちにする',async()=>{
 const h=await harness();try{
 const set=await createPracticeSet(h.db,h.user,{origin:'ai',name:'旧問題集',count:2,questions:[practiceQuestion(1)]});
 await h.db.prepare("INSERT INTO jobs(id,user_id,kind,payload,status,next_at,created_at,updated_at) VALUES(?,?,'generate',?,'failed',?,?,?)").bind(id(),h.user,JSON.stringify({setId:set.id}),now(),now(),now()).run();await h.db.prepare("UPDATE practice_sets SET status='failed' WHERE id=?").bind(set.id).run();
 const before=await practiceResults(h.db,h.user,set.id);expect(await retryPracticeSet(h.db,h.user,set.id)).toMatchObject({queued:false});
 const after=await practiceResults(h.db,h.user,set.id);expect(after.items).toEqual(before.items);expect(after.jobs[0].status).toBe('done');expect(after.set.status).toBe('generating');
 }finally{await h.mf.dispose();}
});
it('別の位置への同時保存は全問保存後に採用待ちとなり、不正な一括送信は何も保存しない',async()=>{
 const h=await harness();try{
 const setId=id();await createPracticeSet(h.db,h.user,{setId,origin:'ai',name:'同時保存',count:2});
 await Promise.all([1,2].map(n=>createPracticeSet(h.db,h.user,{setId,origin:'ai',questions:[practiceQuestion(n)]})));
 const p=await practiceResults(h.db,h.user,setId);expect(p.set.status).toBe('draft');expect(p.items).toHaveLength(2);
 const qCount=await h.db.prepare('SELECT COUNT(*) AS n FROM questions').first<{n:number}>();
 await expect(createPracticeSet(h.db,h.user,{origin:'ai',name:'不正な一括送信',count:2,questions:[practiceQuestion(1),{...practiceQuestion(2),answer:'999'}]})).rejects.toThrow();
 expect(await h.db.prepare('SELECT COUNT(*) AS n FROM questions').first()).toEqual(qCount);expect((await h.db.prepare('SELECT COUNT(*) AS n FROM practice_sets').first<{n:number}>())!.n).toBe(1);
 expect(JSON.parse((await h.db.prepare('SELECT conditions FROM practice_sets WHERE id=?').bind(setId).first<{conditions:string}>())!.conditions)).not.toHaveProperty('questions');
 }finally{await h.mf.dispose();}
});
