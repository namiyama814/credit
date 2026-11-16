import { describe,it,expect,beforeEach,afterEach } from 'vitest';
import { harness } from './helpers';
import { fixtureQuestion,fullFixture } from './fixtures';
import { restartPracticeSet,insertQuestion,startRound,roundProgress,submitAnswer,recordEvaluation,analytics,nextExercise,createPracticeSet,practiceResults,getResult,recommendations,history } from '../src/server/service';
import { deriveRule,gradeRule,id,now,type Evaluation } from '../src/server/domain';
import { exportBackup,restoreBackup } from '../src/server/backup';
let h:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{h=await harness();});afterEach(async()=>{await h?.mf.dispose();});
async function seed(n=3){for(let i=0;i<n;i++)await insertQuestion(h.db,fixtureQuestion(i),i);}
async function answer(questionId:string,response:string|string[],roundId?:string,contextType:'round'|'practice'|'review'='round'){
  const p=await roundProgress(h.db,h.user);const q=await nextExercise(h.db,h.user,contextType,roundId??p.current!.id);const item=contextType==='round'?p.items.find(i=>i.question_id===questionId)!:null;
  return submitAnswer(h.db,h.user,{id:id(),contextType,contextId:roundId??p.current!.id,questionId,versionId:item?.version_id??q.question!.versionId,response,durationMs:1200});
}
const evaluation=(verdict:'correct'|'incorrect'):Evaluation=>({verdict,score:verdict==='correct'?100:0,reason:'テストによる確認',strengths:[],missing:[],improvement:'',model:'test',promptVersion:'test',rubricVersion:'test',gradedAt:now()});
describe('教材と学習履歴',()=>{
  it('171問を保持し167問を採点対象にし、再インポートで重複しない',async()=>{
    for(const [i,q] of fullFixture().entries())await insertQuestion(h.db,q,i);
    let count=await h.db.prepare('SELECT COUNT(*) AS n,SUM(gradable) AS graded FROM question_versions').first<{n:number;graded:number}>();expect(count).toMatchObject({n:171,graded:167});
    const questionIds=fullFixture().slice(0,11).map(q=>q.id);const set=await createPracticeSet(h.db,h.user,{origin:'school',mode:'comprehensive',name:'指定した11問',questionIds});expect((await practiceResults(h.db,h.user,set.id)).items.map(q=>q.question_id)).toEqual(questionIds);
    await startRound(h.db,h.user);const a=await answer('fixture-0',['0']);
    for(const [i,q] of fullFixture().entries())await insertQuestion(h.db,q,i);
    count=await h.db.prepare('SELECT COUNT(*) AS n,SUM(gradable) AS graded FROM question_versions').first<{n:number;graded:number}>();expect(count).toMatchObject({n:171,graded:167});expect((await getResult(h.db,h.user,a.attempt.id)).attempt.verdict).toBe('correct');
  });
  it('全問回答後、不正解だけを次周回に固定し全問クリアする',async()=>{
    await seed();const r=await startRound(h.db,h.user);await answer('fixture-0',['0']);await answer('fixture-1',['1']);expect((await roundProgress(h.db,h.user)).current!.id).toBe(r.id);
    await answer('fixture-2',['0']);let p=await roundProgress(h.db,h.user);expect(p.current!.number).toBe(2);expect(p.items.map(i=>i.question_id)).toEqual(['fixture-1']);
    await answer('fixture-1',['1']);p=await roundProgress(h.db,h.user);expect(p.current!.number).toBe(3);
    await answer('fixture-1',['0']);p=await roundProgress(h.db,h.user);expect(p.current!.status).toBe('cleared');expect(p.rounds).toHaveLength(3);
  });
  it('採点待ちを完了扱いせず、手動確認後に次周回へ進む',async()=>{
    await insertQuestion(h.db,fixtureQuestion(0,'論述式'),0);await insertQuestion(h.db,fixtureQuestion(1),1);const r=await startRound(h.db,h.user);
    const a=await answer('fixture-0','説明します');await answer('fixture-1',['1']);let p=await roundProgress(h.db,h.user);expect(p.current!.id).toBe(r.id);expect(p.counts.pending).toBe(1);
    await recordEvaluation(h.db,h.user,a.attempt.id,evaluation('correct'),'manual');p=await roundProgress(h.db,h.user);expect(p.current!.number).toBe(2);expect(p.items.map(i=>i.question_id)).toEqual(['fixture-1']);
  });
  it('確定済みの周回を変更せず、採点修正は補正周回へ送る',async()=>{
    await seed(1);await startRound(h.db,h.user);const a=await answer('fixture-0',['0']);expect((await roundProgress(h.db,h.user)).current!.status).toBe('cleared');
    await recordEvaluation(h.db,h.user,a.attempt.id,evaluation('incorrect'),'manual');const p=await roundProgress(h.db,h.user);expect(p.current!.status).toBe('active');expect(p.current!.number).toBe(2);expect(p.items).toHaveLength(1);expect((await getResult(h.db,h.user,a.attempt.id)).evaluations).toHaveLength(2);
  });
  it('進行中の次周回へ修正対象を途中追加しない',async()=>{
    await seed(2);await startRound(h.db,h.user);const a=await answer('fixture-0',['0']);await answer('fixture-1',['1']);const current=(await roundProgress(h.db,h.user)).current!.id;
    await recordEvaluation(h.db,h.user,a.attempt.id,evaluation('incorrect'),'manual');let p=await roundProgress(h.db,h.user);expect(p.current!.id).toBe(current);expect(p.items.map(i=>i.question_id)).toEqual(['fixture-1']);
    await answer('fixture-1',['0']);p=await roundProgress(h.db,h.user);expect(p.items.map(i=>i.question_id)).toEqual(['fixture-0']);
  });
  it('同じ送信の再試行は履歴を増やさず、別IDの二重回答を拒否する',async()=>{
    await seed(2);const r=await startRound(h.db,h.user),item=(await roundProgress(h.db,h.user)).items[0];const input={id:id(),contextType:'round',contextId:r.id,questionId:item.question_id,versionId:item.version_id,response:['0'],durationMs:200};
    const [a,b]=await Promise.all([submitAnswer(h.db,h.user,input),submitAnswer(h.db,h.user,input).catch(()=>null)]);expect(a.attempt.verdict).toBe('correct');if(b)expect(b.attempt.id).toBe(a.attempt.id);
    await submitAnswer(h.db,h.user,input);expect((await h.db.prepare('SELECT COUNT(*) AS n FROM attempts').first<{n:number}>())!.n).toBe(1);
    expect((await submitAnswer(h.db,h.user,{...input,id:id()})).attempt.id).toBe(a.attempt.id);await expect(submitAnswer(h.db,h.user,{...input,id:id(),response:['1']})).rejects.toThrow('別の回答');
  });
  it('問題の再取込後も進行中の出題バージョンを維持する',async()=>{
    await seed(1);const r=await startRound(h.db,h.user),v=(await roundProgress(h.db,h.user)).items[0].version_id;
    await insertQuestion(h.db,{...fixtureQuestion(0),question_text:'変更後の架空問題'},0);
    expect((await nextExercise(h.db,h.user)).question!.versionId).toBe(v);await answer('fixture-0',['0'],r.id);
  });
  it('任意の問題集の回答は通常周回を変更しない',async()=>{
    await seed(2);const r=await startRound(h.db,h.user);const set=await createPracticeSet(h.db,h.user,{origin:'school',name:'復習',count:1});const p=await practiceResults(h.db,h.user,set.id);
    await submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:set.id,questionId:p.items[0].question_id,versionId:p.items[0].version_id,response:['0'],durationMs:500});
    const progress=await roundProgress(h.db,h.user);expect(progress.current!.id).toBe(r.id);expect(progress.counts.unanswered).toBe(2);
  });
  it('回答数が少ない間は正解しても安定とは判定しない',async()=>{
    await seed(1);await startRound(h.db,h.user);await answer('fixture-0',['0']);const a=await analytics(h.db,h.user);expect(a.questions[0].state).toBe('insufficient');expect(a.summary.firstAccuracy).toBe(1);
  });
  it('バックアップを空の別DBへ復元し履歴を保持する',async()=>{
    await seed(1);await startRound(h.db,h.user);await answer('fixture-0',['0']);const backup=await exportBackup(h.db);const other=await harness();
    try{await restoreBackup(other.db,backup,other.user);expect((await analytics(other.db,other.user)).summary.answered).toBe(1);await expect(restoreBackup(other.db,backup,other.user)).rejects.toThrow('履歴が空');}finally{await other.mf.dispose();}
  });
});
describe('短答の条件',()=>{
  it('大文字・明示的な半角条件を守る',()=>{
    const q={...fixtureQuestion(4,'記述式'),question_text:'英字の大文字4文字、半角で答えなさい。',correct_answer:'「TEST」。'};const rule=deriveRule(q);
    expect(gradeRule(rule,' TEST ').verdict).toBe('correct');expect(gradeRule(rule,'test').verdict).toBe('incorrect');expect(gradeRule(rule,'ＴＥＳＴ').verdict).toBe('incorrect');
  });
  it('形式指定がない場合は全角半角だけを正規化する',()=>{const rule=deriveRule({...fixtureQuestion(4,'記述式'),correct_answer:'「ABC」。'});expect(gradeRule(rule,'ＡＢＣ').verdict).toBe('correct');expect(gradeRule(rule,'A BC').verdict).toBe('incorrect');});
});

describe('画像の固定',()=>{
  it('同じファイル名の画像を更新しても過去の問題は元の画像を参照する',async()=>{
    const path='assets/fixture.png',old=new Uint8Array([137,80,78,71,1]).buffer,newBytes=new Uint8Array([137,80,78,71,2]).buffer;
    await h.db.batch([h.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').bind(path,'image/png',old,'old-hash'),h.db.prepare('INSERT INTO asset_blobs VALUES(?,?,?)').bind('old-hash','image/png',old)]);
    const q={...fixtureQuestion(0),image_paths:[path]};const first=await insertQuestion(h.db,q,0);
    await h.db.batch([h.db.prepare('UPDATE assets SET bytes=?,content_hash=? WHERE path=?').bind(newBytes,'new-hash',path),h.db.prepare('INSERT INTO asset_blobs VALUES(?,?,?)').bind('new-hash','image/png',newBytes)]);
    const second=await insertQuestion(h.db,q,0);expect(first.version).not.toBe(second.version);
    expect((await h.db.prepare('SELECT content_hash FROM version_assets WHERE version_id=?').bind(first.version).first<{content_hash:string}>())!.content_hash).toBe('old-hash');
    const backup=await exportBackup(h.db),other=await harness();
    try{await restoreBackup(other.db,backup,other.user);expect((await other.db.prepare('SELECT COUNT(*) AS n FROM asset_blobs').first<{n:number}>())!.n).toBe(2);}finally{await other.mf.dispose();}
  });
});

describe('監査回帰',()=>{
  it('大きな画像もスタック上限なしにバックアップ・復元する',async()=>{
    const bytes=new Uint8Array(200000);bytes[199999]=123;
    await h.db.prepare('INSERT INTO assets VALUES(?,?,?,?)').bind('assets/large.png','image/png',bytes.buffer,'large').run();
    const backup=await exportBackup(h.db),other=await harness();
    try{await restoreBackup(other.db,backup,other.user);const restored=await other.db.prepare('SELECT bytes FROM assets').first<{bytes:number[]}>();expect(restored!.bytes).toHaveLength(200000);expect(restored!.bytes[199999]).toBe(123);}finally{await other.mf.dispose();}
  });
  it('履歴が空でも教材登録済みのDBへ混合復元しない',async()=>{
    await seed(1);const backup=await exportBackup(h.db),other=await harness();
    try{const existing=await insertQuestion(other.db,{...fixtureQuestion(0),question_text:'別のマスタ'},0);await expect(restoreBackup(other.db,backup,other.user)).rejects.toThrow('教材・問題集も未登録');expect((await other.db.prepare('SELECT current_version FROM questions').first<{current_version:string}>())!.current_version).toBe(existing.version);}finally{await other.mf.dispose();}
  });
  it('問題集の再演習では固定バージョンを複製し元の回答を残す',async()=>{
    await seed(1);const first=await createPracticeSet(h.db,h.user,{origin:'school',name:'再演習',count:1}),item=(await practiceResults(h.db,h.user,first.id)).items[0];
    await submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:first.id,questionId:item.question_id,versionId:item.version_id,response:['0'],durationMs:10});
    await insertQuestion(h.db,{...fixtureQuestion(0),question_text:'更新された別の問題'},0);
    const second=await restartPracticeSet(h.db,h.user,first.id),exercise=await nextExercise(h.db,h.user,'practice',second.id);
    expect(exercise.question!.versionId).toBe(item.version_id);expect(exercise.question!.text).toBe(fixtureQuestion(0).question_text);expect((await practiceResults(h.db,h.user,first.id)).items[0].verdict).toBe('correct');expect((await roundProgress(h.db,h.user)).current).toBeNull();
  });
});

describe('演習入力と解析の監査',()=>{
  it('未回答の問題集再開と重複再開で新しい問題集を乱立させない',async()=>{
    await seed(1);const set=await createPracticeSet(h.db,h.user,{origin:'school',name:'再開',count:1});expect((await restartPracticeSet(h.db,h.user,set.id)).id).toBe(set.id);
    const item=(await practiceResults(h.db,h.user,set.id)).items[0];await submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:set.id,questionId:item.question_id,versionId:item.version_id,response:['0'],durationMs:10});
    const [a,b]=await Promise.all([restartPracticeSet(h.db,h.user,set.id),restartPracticeSet(h.db,h.user,set.id)]);expect(a.id).toBe(b.id);expect((await h.db.prepare('SELECT COUNT(*) AS n FROM practice_sets').first<{n:number}>())!.n).toBe(2);
  });
  it('reviewで過去の版を任意指定して採点できない',async()=>{
    await seed(1);const old=(await nextExercise(h.db,h.user,'practice', (await createPracticeSet(h.db,h.user,{origin:'school',name:'旧版',count:1})).id)).question!;
    await insertQuestion(h.db,{...fixtureQuestion(0),question_text:'新しい問題'},0);
    await expect(submitAnswer(h.db,h.user,{id:id(),contextType:'review',contextId:'review',questionId:old.id,versionId:old.versionId,response:['0'],durationMs:1})).rejects.toThrow('問題を再取得');
  });
  it('UIモックの回答を履歴に残しつつ理解度と推薦から除外する',async()=>{
    const q=await insertQuestion(h.db,{...fixtureQuestion(50),mock:true},50,'ai');
    await submitAnswer(h.db,h.user,{id:id(),contextType:'review',contextId:'review',questionId:q.id,versionId:q.version,response:['0'],durationMs:1});
    expect((await history(h.db,h.user)).items).toHaveLength(1);expect((await analytics(h.db,h.user)).summary.answered).toBe(0);expect(await recommendations(h.db,h.user)).toEqual([]);
  });
  it('異なるcontextTypeや版で同一送信IDを再利用できない',async()=>{
    await seed(1);const r=await startRound(h.db,h.user),q=(await nextExercise(h.db,h.user)).question!,input={id:id(),contextType:'round',contextId:r.id,questionId:q.id,versionId:q.versionId,response:['0'],durationMs:1};
    await submitAnswer(h.db,h.user,input);await expect(submitAnswer(h.db,h.user,{...input,contextType:'review'})).rejects.toThrow('同じ送信ID');await expect(submitAnswer(h.db,h.user,{...input,versionId:'invalid'})).rejects.toThrow('同じ送信ID');
  });
});

it('元の問題集から再開しても末端の未回答演習を開き、完了済み末端からは一度で再演習する',async()=>{
  await seed(1);const original=await createPracticeSet(h.db,h.user,{origin:'school',name:'連続再演習',count:1});
  const answerSet=async(setId:string)=>{const item=(await practiceResults(h.db,h.user,setId)).items[0];return submitAnswer(h.db,h.user,{id:id(),contextType:'practice',contextId:setId,questionId:item.question_id,versionId:item.version_id,response:['0'],durationMs:1});};
  await answerSet(original.id);const second=await restartPracticeSet(h.db,h.user,original.id);expect((await restartPracticeSet(h.db,h.user,original.id)).id).toBe(second.id);
  await answerSet(second.id);const third=await restartPracticeSet(h.db,h.user,original.id);expect(third.id).not.toBe(original.id);expect(third.id).not.toBe(second.id);expect((await nextExercise(h.db,h.user,'practice',third.id)).question).not.toBeNull();expect((await h.db.prepare('SELECT COUNT(*) AS n FROM attempts').first<{n:number}>())!.n).toBe(2);
});
it('古い生成leaseで教材マスタや問題の版を上書きしない',async()=>{
  const initial=await insertQuestion(h.db,fixtureQuestion(75),75,'ai');
  const stale=await insertQuestion(h.db,{...fixtureQuestion(75),question_text:'古いworkerが遅れて返した問題'},75,'ai',undefined,undefined,{id:'nonexistent-job',lease:'old-lease'});
  expect((await h.db.prepare('SELECT current_version FROM questions WHERE id=?').bind(initial.id).first<{current_version:string}>())!.current_version).toBe(initial.version);
  expect(await h.db.prepare('SELECT 1 FROM question_versions WHERE id=?').bind(stale.version).first()).toBeNull();
});
