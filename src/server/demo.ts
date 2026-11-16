import fixtures from '../../samples/ui-demo/questions.json';
import { SourceQuestion, deriveRule, hash, now } from './domain';

export async function seedDemo(db:D1Database,userId:string){
  const questions = fixtures.map(q => SourceQuestion.parse(q));
  const labels: Record<string, string> = { choice: 'UI確認：選択式', text: 'UI確認：記述式', essay: 'UI確認：論述式' };
  const groups = new Map<string, { id: string; version: string }[]>();
  const batch: { sql: string; params: string[] }[] = [];
  const created = now();
  for (const [position, q] of questions.entries()) {
    if (!q.id.startsWith('ui-demo-') || q.mock !== true || typeof q.demo_group !== 'string' || !labels[q.demo_group]) throw new Error('UIモック以外の問題は追加できません。');
    const rule = deriveRule(q), tags = ['UI確認'];
    const contentHash = await hash(JSON.stringify({ q, rule, tags, images: [] }));
    const version = `${q.id}:${contentHash.slice(0, 24)}`;
    batch.push({ sql: "INSERT INTO questions(id,origin,unit,kind,current_version,position,created_at) VALUES(?,'ai',?,?,?,?,?) ON CONFLICT(id) DO NOTHING", params: [q.id, q.unit_name, q.question_type, version, String(200000 + position), created] });
    batch.push({ sql: 'INSERT OR IGNORE INTO question_versions(id,question_id,content_hash,payload,grading,tags,gradable,created_at) VALUES(?,?,?,?,?,?,1,?)', params: [version, q.id, contentHash, JSON.stringify(q), JSON.stringify(rule), JSON.stringify(tags), created] });
    const group = groups.get(q.demo_group) ?? []; group.push({ id: q.id, version }); groups.set(q.demo_group, group);
  }
  const suffix = (await hash(userId)).slice(0, 8), setIds: string[] = [];
  for (const [group, items] of groups) {
    const setId = `ui-demo-${group}-${suffix}`; setIds.push(setId);
    batch.push({ sql: "INSERT OR IGNORE INTO practice_sets(id,user_id,name,mode,origin,status,conditions,created_at) VALUES(?,?,?,'comprehensive','ai','ready',?,?)", params: [setId, userId, labels[group], JSON.stringify({ mock: true }), created] });
    for (const [position, q] of items.entries()) batch.push({ sql: 'INSERT OR IGNORE INTO practice_items(set_id,question_id,version_id,position,verification) VALUES(?,?,?,?,?)', params: [setId, q.id, q.version, String(position), JSON.stringify({ source: 'ui-mock', valid: true })] });
  }
  await db.batch(batch.map(query=>db.prepare(query.sql).bind(...query.params)));
  return {sets:setIds.length,questions:questions.length,setIds};
}
