import { AppError, id, now } from './domain';
import { stmt } from './service';
export const BACKUP_TABLES=['users','questions','question_versions','asset_blobs','assets','version_assets','rounds','round_items','attempts','evaluations','review_debts','drafts','practice_sets','practice_items','jobs','ai_usage','imports','mastery_cache'] as const;
export async function exportBackup(db:D1Database){
  const data:Record<string,Record<string,unknown>[]>={};
  // D1 batch gives a consistent database snapshot across all exported tables.
  const results=await db.batch<Record<string,unknown>>(BACKUP_TABLES.map(t=>db.prepare(`SELECT * FROM ${t}`)));
  BACKUP_TABLES.forEach((t,i)=>{data[t]=results[i].results.map(row=>{
    const r={...row};if((t==='assets'||t==='asset_blobs')&&r.bytes){const bytes=new Uint8Array(r.bytes as number[]);r.bytes={base64:btoa(String.fromCharCode(...bytes))};}return r;
  });});
  return {format:'info1-backup-v1',createdAt:now(),data};
}
export async function restoreBackup(db:D1Database,raw:unknown,userId:string){
  const b=raw as {format?:string;data?:Record<string,Record<string,unknown>[]>};
  if(b?.format!=='info1-backup-v1'||!b.data||typeof b.data!=='object')throw new AppError(400,'バックアップ形式が不正です。');
  if((await db.prepare('SELECT COUNT(*) AS n FROM attempts').first<{n:number}>())!.n)throw new AppError(409,'履歴が空のデータベースにだけ復元できます。先に現在の履歴を保存してください。');
  if(!b.data.users?.some(u=>u.id===userId)||b.data.users.some(u=>u.id!==userId))throw new AppError(403,'本人のバックアップを選択してください。');
  const commands:D1PreparedStatement[]=[];
  for(const table of BACKUP_TABLES){
    const rows=b.data[table];if(!Array.isArray(rows)||rows.length>100000)throw new AppError(400,'バックアップの内容が不正です。');
    const columns=(await db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>()).results.map(c=>c.name);
    for(const row of rows){
      if(!row||typeof row!=='object'||Object.keys(row).some(k=>!columns.includes(k)))throw new AppError(400,'バックアップの列が不正です。');
      if('user_id' in row&&row.user_id!==userId)throw new AppError(403,'別の利用者の履歴は復元できません。');
      const keys=Object.keys(row),values=keys.map(k=>{
        if((table==='assets'||table==='asset_blobs')&&k==='bytes'){
          const obj=row[k] as {base64?:string};if(typeof obj?.base64!=='string'||obj.base64.length>2000000)throw new AppError(400,'画像が不正です。');
          return Uint8Array.from(atob(obj.base64),c=>c.charCodeAt(0)).buffer;
        }
        const v=row[k];if(v!==null&&typeof v!=='string'&&typeof v!=='number')throw new AppError(400,'バックアップ値が不正です。');return v;
      });
      // Inserts only: no deletion of existing master data or sessions.
      commands.push(stmt(db,`INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,...values));
    }
  }
  if(commands.length>20000)throw new AppError(400,'バックアップが大きすぎます。管理用のD1復元手順を使用してください。');
  await db.batch(commands);
  await stmt(db,"UPDATE jobs SET status='pending',lease_until=NULL,next_at=?,updated_at=? WHERE status='running'",now(),now()).run();
  return {restored:true,recordCount:commands.length,restorationId:id()};
}
