import { AnswerInput, PracticeInput, SourceQuestion, AppError, type Question, type Evaluation, type GradingRule, type Answer, now, id, hash, deriveRule, deriveTags, gradeRule, safeQuestion, parseJSON } from './domain';

export interface VersionRow { id: string; question_id: string; payload: string; grading: string; tags: string; gradable: number; origin: string; }
export interface AttemptRow { id: string; user_id: string; context_type: string; context_id: string; question_id: string; version_id: string; response: string; duration_ms: number; created_at: string; verdict: string; score: number | null; evaluation_data: string; method: string; evaluation_seq: number; }
export interface RoundRow { id: string; user_id: string; cycle: number; number: number; status: string; created_at: string; completed_at: string | null; }
export const stmt = (db: D1Database, sql: string, ...args: (string | number | null | ArrayBuffer)[]) => db.prepare(sql).bind(...args);
export async function ensureUser(db: D1Database, userId: string, login: string) {
  await stmt(db, 'INSERT INTO users(id,login,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login', userId, login, now()).run();
}
export async function getVersion(db: D1Database, questionId: string, versionId?: string): Promise<VersionRow> {
  const row = await stmt(db, `SELECT v.*,q.origin FROM question_versions v JOIN questions q ON q.id=v.question_id WHERE q.id=? AND v.id=${versionId ? '?' : 'q.current_version'}`, ...[questionId, ...(versionId ? [versionId] : [])]).first<VersionRow>();
  if (!row) throw new AppError(404, '問題が見つかりません。');
  return row;
}
export async function insertQuestion(db: D1Database, raw: unknown, position: number, origin = 'school', ruleOverride?: GradingRule, tagsOverride?: string[]) {
  const q = SourceQuestion.parse(raw);
  const rule = ruleOverride ?? deriveRule(q);
  const tags = tagsOverride ?? deriveTags(q);
  const payload = JSON.stringify(q);
  const imageRows=await Promise.all(q.image_paths.map(path=>stmt(db,'SELECT path,content_hash FROM assets WHERE path=?',path).first<{path:string;content_hash:string}>()));
  const contentHash = await hash(JSON.stringify({ q, rule, tags, images:imageRows.filter(Boolean) }));
  const version = `${q.id}:${contentHash.slice(0, 24)}`;
  const created = now();
  await db.batch([
    stmt(db, 'INSERT INTO questions(id,origin,unit,kind,current_version,position,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_version=excluded.current_version,unit=excluded.unit,kind=excluded.kind,position=excluded.position WHERE questions.origin=excluded.origin',q.id,origin,q.unit_name,q.question_type,version,position,created),
    stmt(db, 'INSERT OR IGNORE INTO question_versions(id,question_id,content_hash,payload,grading,tags,gradable,created_at) VALUES(?,?,?,?,?,?,?,?)',version,q.id,contentHash,payload,JSON.stringify(rule),JSON.stringify(tags),Number(q.answer_verified && rule.type !== 'none'),created),
    ...imageRows.filter((r):r is {path:string;content_hash:string}=>!!r).map(r=>stmt(db,'INSERT OR IGNORE INTO version_assets VALUES(?,?,?)',version,r.path,r.content_hash)),
  ]);
  return { id: q.id, version, tags, rule, gradable: q.answer_verified && rule.type !== 'none' };
}
export async function listQuestions(db: D1Database, filter: { unit?: string; type?: string; tag?: string; origin?: string; state?: string; cursor?: string; limit?: number; query?: string; minAccuracy?:number; maxAccuracy?:number } = {}, userId?: string) {
  const rows = await db.prepare('SELECT v.*,q.origin FROM questions q JOIN question_versions v ON v.id=q.current_version ORDER BY q.position,q.id').all<VersionRow>();
  const stats = userId ? (await analytics(db,userId)).questions : [];
  const filtered = rows.results.map(r => {
    const q = parseJSON<Question>(r.payload);
    const tags = parseJSON<string[]>(r.tags);
    const stat = stats.find(s=>s.questionId===q.id);
    return { ...safeQuestion(q,r.id,tags,r.origin), mastery: stat ?? null };
  }).filter(q => (!filter.origin || q.origin === filter.origin) && (!filter.unit || q.unit === filter.unit) && (!filter.type || q.type === filter.type) && (!filter.tag || q.tags.includes(filter.tag)) && (!filter.state || (q.mastery?.state ?? 'unseen') === filter.state) && (!filter.query || q.text.includes(filter.query) || q.tags.some(t=>t.includes(filter.query!))) && (filter.minAccuracy===undefined || (q.mastery?.accuracy!==null && q.mastery?.accuracy!==undefined && q.mastery.accuracy>=filter.minAccuracy)) && (filter.maxAccuracy===undefined || (q.mastery?.accuracy!==null && q.mastery?.accuracy!==undefined && q.mastery.accuracy<=filter.maxAccuracy)));
  const offset = Math.max(0,Number(filter.cursor) || 0), limit = Math.min(100,Math.max(1,filter.limit ?? 30));
  return { items: filtered.slice(offset,offset+limit), total: filtered.length, nextCursor: offset+limit<filtered.length ? String(offset+limit) : null };
}
export async function startRound(db: D1Database, userId: string, restart = false) {
  const active = await stmt(db,"SELECT * FROM rounds WHERE user_id=? AND status='active'",userId).first<RoundRow>();
  if (active) return active;
  const latest = await stmt(db,'SELECT * FROM rounds WHERE user_id=? ORDER BY cycle DESC,number DESC LIMIT 1',userId).first<RoundRow>();
  if (latest && !restart) {
    await advanceRound(db,userId,latest.id);
    return (await stmt(db,'SELECT * FROM rounds WHERE user_id=? ORDER BY cycle DESC,number DESC LIMIT 1',userId).first<RoundRow>())!;
  }
  const roundId=id(),cycle=(latest?.cycle ?? 0)+1;
  const count = await db.prepare("SELECT COUNT(*) AS n FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school' AND v.gradable=1").first<{n:number}>();
  if (!count?.n) throw new AppError(409,'採点できる教材をインポートしてください。');
  try {
    await db.batch([
      stmt(db,"INSERT INTO rounds(id,user_id,cycle,number,status,created_at) VALUES(?,?,?,1,'active',?)",roundId,userId,cycle,now()),
      stmt(db,"INSERT INTO round_items(round_id,question_id,version_id,position) SELECT ?,q.id,q.current_version,ROW_NUMBER() OVER(ORDER BY q.position,q.id) FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school' AND v.gradable=1",roundId),
      stmt(db,'DELETE FROM review_debts WHERE user_id=?',userId),
    ]);
  } catch (error) {
    const existing=await stmt(db,"SELECT * FROM rounds WHERE user_id=? AND status='active'",userId).first<RoundRow>();
    if(existing)return existing;
    throw error;
  }
  return (await stmt(db,'SELECT * FROM rounds WHERE id=?',roundId).first<RoundRow>())!;
}
export async function advanceRound(db: D1Database,userId:string,roundId:string) {
  const round=await stmt(db,'SELECT * FROM rounds WHERE id=? AND user_id=?',roundId,userId).first<RoundRow>();
  if(!round)return;
  const next=id();
  // All transition predicates run inside one D1 atomic batch. Another request
  // cannot close a round that has unresolved evaluations or insert a second next round.
  const ready=`NOT EXISTS(SELECT 1 FROM round_items i LEFT JOIN effective_attempts a ON a.context_type='round' AND a.context_id=i.round_id AND a.question_id=i.question_id AND a.user_id=? WHERE i.round_id=? AND (a.id IS NULL OR a.verdict IN ('pending','needs_review')))`;
  const targets=`SELECT i.question_id,i.version_id FROM round_items i JOIN effective_attempts a ON a.context_type='round' AND a.context_id=i.round_id AND a.question_id=i.question_id AND a.user_id=? WHERE i.round_id=? AND a.verdict='incorrect' UNION SELECT question_id,version_id FROM review_debts WHERE user_id=?`;
  await db.batch([
    stmt(db,`UPDATE rounds SET status='complete',completed_at=COALESCE(completed_at,?) WHERE id=? AND user_id=? AND status='active' AND ${ready}`,now(),roundId,userId,userId,roundId),
    stmt(db,`INSERT OR IGNORE INTO rounds(id,user_id,cycle,number,status,created_at) SELECT ?,user_id,cycle,number+1,'active',? FROM rounds WHERE id=? AND user_id=? AND status IN ('complete','cleared') AND NOT EXISTS(SELECT 1 FROM rounds WHERE user_id=? AND status='active') AND EXISTS(${targets})`,next,now(),roundId,userId,userId,userId,roundId,userId),
    stmt(db,`INSERT OR IGNORE INTO round_items(round_id,question_id,version_id,position) SELECT ?,t.question_id,t.version_id,ROW_NUMBER() OVER(ORDER BY q.position,t.question_id) FROM (${targets}) t JOIN questions q ON q.id=t.question_id WHERE EXISTS(SELECT 1 FROM rounds WHERE id=?)`,next,userId,roundId,userId,next),
    stmt(db,"DELETE FROM review_debts WHERE user_id=? AND EXISTS(SELECT 1 FROM round_items WHERE round_id=? AND question_id=review_debts.question_id)",userId,next),
    stmt(db,`UPDATE rounds SET status='cleared' WHERE id=? AND user_id=? AND status='complete' AND NOT EXISTS(SELECT 1 FROM rounds WHERE user_id=? AND cycle=? AND number>?) AND NOT EXISTS(${targets}) AND NOT EXISTS(SELECT 1 FROM effective_attempts a JOIN rounds r ON r.id=a.context_id WHERE a.user_id=? AND a.context_type='round' AND r.cycle=? AND a.verdict IN ('pending','needs_review'))`,roundId,userId,userId,round.cycle,round.number,userId,roundId,userId,userId,round.cycle),
  ]);
}
export async function roundProgress(db:D1Database,userId:string,roundId?:string) {
  const rounds=(await stmt(db,'SELECT * FROM rounds WHERE user_id=? ORDER BY cycle DESC,number DESC',userId).all<RoundRow>()).results;
  const round=roundId ? rounds.find(r=>r.id===roundId) : rounds.find(r=>r.status==='active') ?? rounds[0];
  if(roundId&&!round)throw new AppError(404,'周回が見つかりません。');
  if(!round)return { current:null,rounds:[],items:[],counts:{total:0,unanswered:0,pending:0,needs_review:0,correct:0,incorrect:0},next:null };
  const items=(await stmt(db,"SELECT i.*,a.id AS attempt_id,COALESCE(a.verdict,'unanswered') AS verdict FROM round_items i LEFT JOIN effective_attempts a ON a.context_type='round' AND a.context_id=i.round_id AND a.question_id=i.question_id AND a.user_id=? WHERE i.round_id=? ORDER BY i.position",userId,round.id).all<{question_id:string;version_id:string;attempt_id:string|null;verdict:string;position:number}>()).results;
  const counts={total:items.length,unanswered:0,pending:0,needs_review:0,correct:0,incorrect:0};
  for(const i of items)counts[i.verdict as keyof Omit<typeof counts,'total'>]++;
  return { current:round,rounds,items,counts,next:items.find(i=>i.verdict==='unanswered') ?? null };
}
export async function nextExercise(db:D1Database,userId:string,contextType='round',contextId?:string) {
  let item:{question_id:string;version_id:string}|undefined,context:string;
  if(contextType==='round'){
    const progress=await roundProgress(db,userId,contextId);
    if(!progress.current)return { question:null,progress,contextType:'round',contextId:null,draft:null };
    context=progress.current.id;item=progress.next ?? undefined;
    if(!item)return { question:null,progress,contextType,contextId:context,draft:null };
  }else if(contextType==='practice'){
    const set=await stmt(db,"SELECT * FROM practice_sets WHERE id=? AND user_id=? AND status='ready'",contextId ?? '',userId).first();
    if(!set)throw new AppError(404,'問題集が見つかりません。');
    context=contextId!;
    item=await stmt(db,"SELECT i.question_id,i.version_id FROM practice_items i WHERE i.set_id=? AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.user_id=? AND a.context_type='practice' AND a.context_id=i.set_id AND a.question_id=i.question_id) ORDER BY i.position LIMIT 1",context,userId).first<{question_id:string;version_id:string}>() ?? undefined;
  }else throw new AppError(400,'演習形式が不正です。');
  if(!item)return {question:null,contextType,contextId:context,draft:null};
  const row=await getVersion(db,item.question_id,item.version_id);
  const draft=await stmt(db,'SELECT response,elapsed_ms,updated_at FROM drafts WHERE user_id=? AND context_type=? AND context_id=? AND question_id=?',userId,contextType,context,item.question_id).first<{response:string;elapsed_ms:number}>();
  return {question:safeQuestion(parseJSON<Question>(row.payload),row.id,parseJSON<string[]>(row.tags),row.origin),contextType,contextId:context,draft:draft?{response:parseJSON(draft.response),elapsedMs:draft.elapsed_ms}:null};
}
export async function validateContext(db:D1Database,userId:string,input:Pick<Answer,'contextType'|'contextId'|'questionId'|'versionId'>) {
  if(input.contextType==='round'){
    const valid=await stmt(db,"SELECT 1 FROM round_items i JOIN rounds r ON r.id=i.round_id WHERE i.round_id=? AND i.question_id=? AND i.version_id=? AND r.user_id=? AND r.status='active'",input.contextId,input.questionId,input.versionId,userId).first();
    if(!valid)throw new AppError(409,'周回の対象を再取得してください。');
  }else if(input.contextType==='practice'){
    const valid=await stmt(db,"SELECT 1 FROM practice_items i JOIN practice_sets s ON s.id=i.set_id WHERE i.set_id=? AND i.question_id=? AND i.version_id=? AND s.user_id=? AND s.status='ready'",input.contextId,input.questionId,input.versionId,userId).first();
    if(!valid)throw new AppError(409,'問題集の対象を再取得してください。');
  }else if(input.contextId!=='review')throw new AppError(400,'復習の指定が不正です。');
}
export async function submitAnswer(db:D1Database,userId:string,raw:unknown) {
  const input=AnswerInput.parse(raw);
  const existing=await stmt(db,'SELECT * FROM attempts WHERE id=? AND user_id=?',input.id,userId).first<AttemptRow>();
  if(existing){
    if(existing.context_id!==input.contextId||existing.question_id!==input.questionId||existing.response!==JSON.stringify(input.response))throw new AppError(409,'同じ送信IDに別の回答が含まれています。');
    return getResult(db,userId,existing.id);
  }
  await validateContext(db,userId,input);
  const row=await getVersion(db,input.questionId,input.versionId);
  if(!row.gradable)throw new AppError(409,'この問題は通常の採点対象外です。');
  const rule=parseJSON<GradingRule>(row.grading);
  if(rule.type==='choice'&&(!Array.isArray(input.response)||input.response.length!==rule.accepted.length||input.response.some(s=>!/^\d+$/u.test(s)||Number(s)>=parseJSON<Question>(row.payload).choices.length)))throw new AppError(400,'選択肢を確認してください。');
  if(rule.type!=='choice'&&typeof input.response!=='string')throw new AppError(400,'回答を入力してください。');
  const evaluation=gradeRule(rule,input.response),created=now();
  const statements=[
    stmt(db,'INSERT INTO attempts(id,user_id,context_type,context_id,question_id,version_id,response,duration_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)',input.id,userId,input.contextType,input.contextId,input.questionId,row.id,JSON.stringify(input.response),input.durationMs,created),
    stmt(db,'INSERT INTO evaluations(id,attempt_id,verdict,score,method,data,created_at) VALUES(?,?,?,?,?,?,?)',id(),input.id,evaluation.verdict,evaluation.score,'rule',JSON.stringify(evaluation),created),
    stmt(db,'DELETE FROM drafts WHERE user_id=? AND context_type=? AND context_id=? AND question_id=?',userId,input.contextType,input.contextId,input.questionId),
  ];
  if(evaluation.verdict==='pending')statements.push(stmt(db,"INSERT INTO jobs(id,user_id,kind,payload,status,next_at,created_at,updated_at) VALUES(?,?,'grade',?,'pending',?,?,?)",id(),userId,JSON.stringify({attemptId:input.id}),created,created,created));
  try { await db.batch(statements); }
  catch(error){
    const duplicate=await stmt(db,'SELECT id FROM attempts WHERE user_id=? AND context_type=? AND context_id=? AND question_id=?',userId,input.contextType,input.contextId,input.questionId).first<{id:string}>();
    if(duplicate)throw new AppError(409,`回答は保存済みです。履歴から確認してください。`);
    throw error;
  }
  if(input.contextType==='round')await advanceRound(db,userId,input.contextId);
  return getResult(db,userId,input.id);
}
export async function getResult(db:D1Database,userId:string,attemptId:string){
  const a=await stmt(db,'SELECT * FROM effective_attempts WHERE id=? AND user_id=?',attemptId,userId).first<AttemptRow>();
  if(!a)throw new AppError(404,'回答が見つかりません。');
  const row=await getVersion(db,a.question_id,a.version_id),q=parseJSON<Question>(row.payload);
  const evaluations=(await stmt(db,'SELECT id,verdict,score,method,data,created_at FROM evaluations WHERE attempt_id=? ORDER BY seq',a.id).all<{id:string;verdict:string;score:number|null;method:string;data:string;created_at:string}>()).results.map(e=>({...e,data:parseJSON(e.data)}));
  return {attempt:{...a,response:parseJSON(a.response),evaluation_data:parseJSON(a.evaluation_data)},question:safeQuestion(q,row.id,parseJSON<string[]>(row.tags),row.origin),correctAnswer:q.correct_answer,answerKind:q.answer_kind ?? (q.question_type==='論述式'?'解答例':'正答'),explanation:q.explanation,teacherComment:q.teacher_comment ?? '',evaluations};
}
export async function recordEvaluation(db:D1Database,userId:string,attemptId:string,evaluation:Evaluation,method:'ai'|'manual',expected?:{seq:number;jobId:string;lease:string}){
  const a=await stmt(db,'SELECT a.*,r.status AS round_status FROM effective_attempts a LEFT JOIN rounds r ON r.id=a.context_id AND a.context_type=\'round\' WHERE a.id=? AND a.user_id=?',attemptId,userId).first<AttemptRow&{round_status:string|null}>();
  if(!a)throw new AppError(404,'回答が見つかりません。');
  const evaluationId=id();
  const argumentsForEvaluation=[evaluationId,a.id,evaluation.verdict,evaluation.score,method,JSON.stringify(evaluation),now()];
  const guard=expected?' WHERE EXISTS(SELECT 1 FROM effective_attempts WHERE id=? AND evaluation_seq=?) AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status=\'running\' AND lease_until=?)':'';
  const statements=[stmt(db,'INSERT INTO evaluations(id,attempt_id,verdict,score,method,data,created_at) SELECT ?,?,?,?,?,?,?'+guard,...argumentsForEvaluation,...(expected?[a.id,expected.seq,expected.jobId,expected.lease]:[]))];
  if(method==='manual')statements.push(stmt(db,"UPDATE jobs SET status='done',lease_until=NULL,updated_at=? WHERE kind='grade' AND user_id=? AND json_extract(payload,'$.attemptId')=? AND status!='done'",now(),userId,attemptId));
  if(a.context_type==='round'&&a.round_status!=='active'&&evaluation.verdict==='incorrect')statements.push(stmt(db,'INSERT INTO review_debts(user_id,question_id,version_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM evaluations WHERE id=?) ON CONFLICT(user_id,question_id) DO UPDATE SET version_id=excluded.version_id,created_at=excluded.created_at',userId,a.question_id,a.version_id,now(),evaluationId));
  if(evaluation.verdict==='correct')statements.push(stmt(db,'DELETE FROM review_debts WHERE user_id=? AND question_id=? AND EXISTS(SELECT 1 FROM evaluations WHERE id=?)',userId,a.question_id,evaluationId));
  const recorded=await db.batch(statements);
  if(!recorded[0].meta.changes)return false;
  if(a.context_type==='round'){
    const active=await stmt(db,"SELECT id FROM rounds WHERE user_id=? AND status='active'",userId).first<{id:string}>();
    if(active)await advanceRound(db,userId,active.id);
    else {const last=await stmt(db,'SELECT id FROM rounds WHERE user_id=? ORDER BY cycle DESC,number DESC LIMIT 1',userId).first<{id:string}>();if(last)await advanceRound(db,userId,last.id);}
  }
}
export async function requestRegrade(db:D1Database,userId:string,attemptId:string){
  const a=await stmt(db,'SELECT * FROM attempts WHERE id=? AND user_id=?',attemptId,userId).first<AttemptRow>();
  if(!a)throw new AppError(404,'回答が見つかりません。');
  const row=await getVersion(db,a.question_id,a.version_id);
  if(parseJSON<GradingRule>(row.grading).type!=='essay')throw new AppError(400,'論述問題だけ再評価できます。');
  const running=await stmt(db,"SELECT id FROM jobs WHERE user_id=? AND kind='grade' AND json_extract(payload,'$.attemptId')=? AND status IN ('pending','running','deferred')",userId,attemptId).first();
  if(running)return running;
  const jobId=id(),t=now();
  await db.batch([
    stmt(db,"UPDATE rounds SET status='complete' WHERE id=? AND user_id=? AND status='cleared'",a.context_id,userId),
    stmt(db,"INSERT INTO evaluations(id,attempt_id,verdict,score,method,data,created_at) VALUES(?,?,'pending',NULL,'ai',?,?)",id(),attemptId,JSON.stringify({...gradeRule({type:'essay',accepted:[],normalizeWidth:false,caseSensitive:true,version:'v1'},''),reason:'再評価待ち'}),t),
    stmt(db,"INSERT INTO jobs(id,user_id,kind,payload,status,next_at,created_at,updated_at) VALUES(?,?,'grade',?,'pending',?,?,?)",jobId,userId,JSON.stringify({attemptId}),t,t,t),
  ]);
  return {id:jobId};
}
export async function history(db:D1Database,userId:string,filter:{questionId?:string;unit?:string;from?:string;to?:string;cursor?:string;limit?:number;verdict?:string}={}){
  const conditions=['a.user_id=?'],args:(string|number)[]=[userId];
  if(filter.questionId){conditions.push('a.question_id=?');args.push(filter.questionId);}
  if(filter.unit){conditions.push('q.unit=?');args.push(filter.unit);}
  if(filter.from){conditions.push('a.created_at>=?');args.push(filter.from);}
  if(filter.to){conditions.push('a.created_at<=?');args.push(filter.to);}
  if(filter.verdict){conditions.push('a.verdict=?');args.push(filter.verdict);}
  const limit=Math.min(100,Math.max(1,filter.limit ?? 30)),offset=Math.max(0,Number(filter.cursor)||0);
  const rows=await stmt(db,`SELECT a.*,q.unit,q.kind FROM effective_attempts a JOIN questions q ON q.id=a.question_id WHERE ${conditions.join(' AND ')} ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,...args,limit+1,offset).all<AttemptRow>();
  return {items:rows.results.slice(0,limit).map(a=>({...a,response:parseJSON(a.response),evaluation_data:parseJSON(a.evaluation_data)})),nextCursor:rows.results.length>limit?String(offset+limit):null};
}
export async function analytics(db:D1Database,userId:string){
  const rows=(await stmt(db,'SELECT a.id,a.question_id,a.context_type,a.context_id,a.created_at,a.duration_ms,a.verdict,a.score,a.method,q.unit,v.tags FROM effective_attempts a JOIN questions q ON q.id=a.question_id JOIN question_versions v ON v.id=a.version_id WHERE a.user_id=? ORDER BY a.created_at,a.id',userId).all<{id:string;question_id:string;context_type:string;context_id:string;created_at:string;duration_ms:number;verdict:string;score:number|null;method:string;unit:string;tags:string}>()).results;
  const byQuestion=new Map<string,typeof rows>(),byUnit=new Map<string,typeof rows>(),byTag=new Map<string,typeof rows>(),byDay=new Map<string,typeof rows>(),byRound=new Map<string,typeof rows>();
  const add=(m:Map<string,typeof rows>,k:string,r:typeof rows[number])=>m.set(k,[...(m.get(k)??[]),r]);
  for(const r of rows){add(byQuestion,r.question_id,r);add(byUnit,r.unit,r);for(const t of parseJSON<string[]>(r.tags))add(byTag,t,r);add(byDay,new Date(r.created_at).toLocaleDateString('sv-SE',{timeZone:'Asia/Tokyo'}),r);if(r.context_type==='round')add(byRound,r.context_id,r);}
  const summarize=(rs:typeof rows)=>{const scored=rs.filter(r=>r.verdict==='correct'||r.verdict==='incorrect'),correct=scored.filter(r=>r.verdict==='correct').length,n=scored.length;return {answered:rs.length,scored:n,correct,incorrect:n-correct,pending:rs.filter(r=>r.verdict==='pending').length,needsReview:rs.filter(r=>r.verdict==='needs_review').length,accuracy:n?correct/n:null,averageDurationMs:rs.length?Math.round(rs.reduce((a,r)=>a+r.duration_ms,0)/rs.length):0};};
  const questions=[...byQuestion].map(([questionId,rs])=>{
    const s=summarize(rs),scored=rs.filter(r=>r.verdict==='correct'||r.verdict==='incorrect');let streak=0;for(let i=scored.length-1;i>=0&&scored[i].verdict==='correct';i--)streak++;
    const state=rs.at(-1)?.verdict==='pending'||rs.at(-1)?.verdict==='needs_review'?'needs_review':s.scored<3?'insufficient':streak>=3&&s.accuracy!>=0.8?'stable':rs.at(-1)?.verdict==='incorrect'||s.accuracy!<0.6?'review':'developing';
    return {questionId,...s,firstCorrect:scored[0]?.verdict==='correct',streak,lastAnsweredAt:rs.at(-1)!.created_at,lastVerdict:rs.at(-1)!.verdict,lastScore:rs.at(-1)!.score,lastMethod:rs.at(-1)!.method,state,priority:(rs.at(-1)?.verdict==='needs_review'?100:0)+(rs.at(-1)?.verdict==='incorrect'?50:0)+s.incorrect*5+(1-(s.accuracy??0.5))*10+Math.min(s.averageDurationMs/60000,5), evidenceAttemptIds:rs.slice(-5).map(r=>r.id)};
  });
  const topics=[...byTag].map(([tag,rs])=>({tag,...summarize(rs),distinctQuestions:new Set(rs.map(r=>r.question_id)).size,confidence:rs.filter(r=>r.verdict==='correct'||r.verdict==='incorrect').length<5||new Set(rs.map(r=>r.question_id)).size<3?'insufficient':'observed',evidenceAttemptIds:rs.filter(r=>r.verdict==='incorrect').slice(-5).map(r=>r.id)})).sort((a,b)=>(b.incorrect/Math.max(b.scored,1))-(a.incorrect/Math.max(a.scored,1))||b.incorrect-a.incorrect);
  const firsts=[...byQuestion.values()].map(rs=>rs.find(r=>r.verdict==='correct'||r.verdict==='incorrect')).filter((r):r is typeof rows[number]=>!!r);
  const observed=new Map<string,typeof rows>();
  const masteryTimeline=[...byDay].map(([day,rs])=>{
    for(const r of rs)observed.set(r.question_id,[...(observed.get(r.question_id)??[]),r]);
    const distribution={insufficient:0,needs_review:0,review:0,developing:0,stable:0};
    for(const attempts of observed.values()){
      const scored=attempts.filter(r=>r.verdict==='correct'||r.verdict==='incorrect');
      let streak=0;for(let j=scored.length-1;j>=0&&scored[j].verdict==='correct';j--)streak++;
      const last=attempts.at(-1)!;const accuracy=scored.length?scored.filter(r=>r.verdict==='correct').length/scored.length:0;
      const state=last.verdict==='pending'||last.verdict==='needs_review'?'needs_review':scored.length<3?'insufficient':streak>=3&&accuracy>=0.8?'stable':last.verdict==='incorrect'||accuracy<0.6?'review':'developing';
      distribution[state]++;
    }
    return {day,...distribution};
  });
  return {masteryTimeline,summary:{...summarize(rows),firstAccuracy:firsts.length?firsts.filter(r=>r.verdict==='correct').length/firsts.length:null},questions,units:[...byUnit].map(([unit,rs])=>({unit,...summarize(rs)})),topics,days:[...byDay].map(([day,rs])=>({day,...summarize(rs)})),rounds:[...byRound].map(([roundId,rs])=>({roundId,...summarize(rs)}))};
}
export async function recommendations(db:D1Database,userId:string,limit=10){
  const a=await analytics(db,userId),list=await listQuestions(db,{origin:'school',limit:100});
  const all=list.nextCursor?[...list.items,...(await listQuestions(db,{origin:'school',limit:100,cursor:list.nextCursor})).items]:list.items;
  return a.questions.sort((x,y)=>y.priority-x.priority).slice(0,Math.min(limit,30)).map(s=>({question:all.find(q=>q.id===s.questionId),...s,reason:s.lastVerdict==='needs_review'?'採点の確認':s.lastVerdict==='incorrect'?'直近の不正解':s.incorrect>1?'繰り返しの誤答':'定着の確認'}));
}
export async function learningContext(db:D1Database,userId:string){
  const [progress,analysis,recent,recommended]=await Promise.all([roundProgress(db,userId),analytics(db,userId),history(db,userId,{limit:5}),recommendations(db,userId,5)]);
  return {examDate:'2027-01-21',timezone:'Asia/Tokyo',asOf:now(),progress:{current:progress.current,counts:progress.counts,next:progress.next,unresolved:progress.items.filter(i=>i.verdict==='pending'||i.verdict==='needs_review').slice(0,10)},analysis:{summary:analysis.summary,units:analysis.units,weakTopics:analysis.topics.slice(0,8),masteryTimeline:analysis.masteryTimeline.slice(-7)},recent:recent.items,recommended,aiIsReference:true};
}
export async function createPracticeSet(db:D1Database,userId:string,raw:unknown){
  const c=PracticeInput.parse(raw),count=c.count??(c.origin==='school'&&c.questionIds?.length?c.questionIds.length:c.mode==='mock'?20:10),setId=id(),t=now();
  if(c.origin==='school'){
    const data=await listQuestions(db,{origin:'school',limit:100});
    const more=data.nextCursor?(await listQuestions(db,{origin:'school',limit:100,cursor:data.nextCursor})).items:[];
    let qs=[...data.items,...more].filter(q=>q.gradable&&(!c.questionIds||c.questionIds.includes(q.id))&&(!c.tags.length||c.tags.some(t=>q.tags.includes(t))));
    if(!qs.length)throw new AppError(400,'条件に合う問題がありません。');
    if(c.mode==='weakness'){const a=await analytics(db,userId);qs.sort((x,y)=>(a.questions.find(s=>s.questionId===y.id)?.priority??0)-(a.questions.find(s=>s.questionId===x.id)?.priority??0));}
    qs=qs.slice(0,count);
    await db.batch([stmt(db,"INSERT INTO practice_sets VALUES(?,?,?,?,?,'ready',?,?)",setId,userId,c.name,c.mode,'school',JSON.stringify(c),t),...qs.map((q,i)=>stmt(db,"INSERT INTO practice_items VALUES(?,?,?,?,?)",setId,q.id,q.versionId,i,JSON.stringify({source:'verified_school'})))]);
  }else{
    await db.batch([stmt(db,"INSERT INTO practice_sets VALUES(?,?,?,?,?,'generating',?,?)",setId,userId,c.name,c.mode,'ai',JSON.stringify({...c,count}),t),stmt(db,"INSERT INTO jobs(id,user_id,kind,payload,status,next_at,created_at,updated_at) VALUES(?,?,'generate',?,'pending',?,?,?)",id(),userId,JSON.stringify({setId,conditions:{...c,count}}),t,t,t)]);
  }
  return {id:setId,status:c.origin==='ai'?'generating':'ready'};
}
export async function practiceResults(db:D1Database,userId:string,setId:string){
  const set=await stmt(db,'SELECT * FROM practice_sets WHERE id=? AND user_id=?',setId,userId).first<{id:string;status:string;conditions:string}>();
  if(!set)throw new AppError(404,'問題集が見つかりません。');
  const items=(await stmt(db,"SELECT i.*,COALESCE(a.verdict,'unanswered') AS verdict,a.id AS attempt_id FROM practice_items i LEFT JOIN effective_attempts a ON a.context_type='practice' AND a.context_id=i.set_id AND a.question_id=i.question_id AND a.user_id=? WHERE i.set_id=? ORDER BY i.position",userId,setId).all<{question_id:string;version_id:string;verification:string;verdict:string;attempt_id:string|null}>()).results;
  const questions=await Promise.all(items.map(async i=>{const v=await getVersion(db,i.question_id,i.version_id),q=parseJSON<Question>(v.payload);return {...i,verification:parseJSON(i.verification),question:safeQuestion(q,v.id,parseJSON<string[]>(v.tags),v.origin),...(set.status==='draft'?{correctAnswer:q.correct_answer,explanation:q.explanation}:{} )};}));
  const jobs=(await stmt(db,"SELECT id,status,kind,last_error,next_at FROM jobs WHERE user_id=? AND (json_extract(payload,'$.setId')=?) ORDER BY created_at DESC",userId,setId).all()).results;
  return {set:{...set,conditions:parseJSON(set.conditions)},items:questions,jobs};
}

export async function approvePracticeSet(db:D1Database,userId:string,setId:string){
  const p=await practiceResults(db,userId,setId);
  if(p.set.status==='ready')return {adopted:true};
  if(p.set.status!=='draft'||!p.items.length||p.items.some(i=>!(i.verification as {valid?:boolean}).valid))throw new AppError(409,'検証済みの問題集を確認してください。');
  await stmt(db,"UPDATE practice_sets SET status='ready' WHERE id=? AND user_id=? AND status='draft'",setId,userId).run();
  return {adopted:true};
}
