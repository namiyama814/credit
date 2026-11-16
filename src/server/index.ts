import { practiceVisibility } from './practice-visibility';
import { seedDemo } from './demo';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { OAuthProvider, AuthorizationError, CimdFetchError, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { SourceQuestion, AppError, id, now, hash, parseJSON, safeQuestion, type Question, type Evaluation } from './domain';
import { stmt, insertQuestion, restartPracticeSet, startRound, roundProgress, nextExercise, submitAnswer, getResult, recordEvaluation, requestRegrade, history, analytics, learningContext, listQuestions, getVersion, createPracticeSet, practiceResults, validateContext } from './service';
import { getSession, isOwnerSession, createSession, logout, githubStart, githubCallback, authorizeGET, authorizePOST, SCOPES, type Bindings, type Variables } from './auth';
import { mcpHandler } from './mcp';
import { processJobs } from './ai';
import { exportBackup, restoreBackup } from './backup';

const app=new Hono<{Bindings:Bindings;Variables:Variables}>();
app.use('*',bodyLimit({maxSize:10*1024*1024,onError:c=>c.json({error:'ファイルが大きすぎます。'},413)}));
app.use('*',async(c,next)=>{
  c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');c.header('X-Frame-Options','DENY');
  c.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(!c.req.path.startsWith('/fonts/')&&!c.req.path.startsWith('/_astro/'))c.header('Cache-Control','no-store');
  await next();
});
app.onError((error,c)=>{
  if(error instanceof AppError)return c.json({error:error.message},error.status as 400);
  if(error instanceof z.ZodError)return c.json({error:'入力内容を確認してください。',fields:error.issues.map(i=>i.path.join('.'))},400);
  if(error instanceof AuthorizationError&&error.redirectTo)return c.redirect(error.redirectTo);
  if(error instanceof AuthorizationError||error instanceof CimdFetchError)return c.json({error:'接続の認証情報を確認し、もう一度接続してください。'},400);
  console.error(JSON.stringify({event:'request_failed',path:c.req.path,type:error.name}));
  return c.json({error:'処理を完了できませんでした。再試行してください。'},500);
});
app.get('/health',c=>c.json({ok:true}));
app.get('/auth/github',githubStart);
app.get('/auth/github/callback',githubCallback);
app.get('/authorize',authorizeGET);
app.post('/authorize',authorizePOST);
app.post('/auth/test',async c=>{
  const u=new URL(c.req.url);
  if(c.env.APP_MODE!=='test'||!['localhost','127.0.0.1','[::1]'].includes(u.hostname))return c.notFound();
  const session=await createSession(c,'test-owner','テスト');return c.json(session);
});
app.use('/api/*',async(c,next)=>{
  const existing=await getSession(c);
  const path=c.req.path;
  const management=path==='/api/backup'||path==='/api/restore'||path.startsWith('/api/import/')||path==='/api/jobs/run'||/^\/api\/results\/[^/]+\/(correct|regrade)$/u.test(path)||(path.startsWith('/api/practice')&&!['GET','HEAD'].includes(c.req.method)&&!/^\/api\/practice\/[^/]+\/restart$/u.test(path));
  if(c.env.APP_MODE==='production'&&management&&!isOwnerSession(existing,c.env))return c.json({error:'管理操作には本人のGitHub認証が必要です。'},403);
  const created=existing?null:await createSession(c,c.env.APP_MODE==='test'?'test-owner':`github:${c.env.OWNER_GITHUB_ID}`,'学習','study');
  c.set('userId',existing?.user_id??created!.userId);c.set('csrf',existing?.csrf??created!.csrf);
  if(!['GET','HEAD'].includes(c.req.method)){
    if(c.req.header('Origin')!==c.env.APP_ORIGIN||c.req.header('X-CSRF-Token')!==c.get('csrf'))return c.json({error:'画面を更新してやり直してください。'},403);
  }
  await next();
});
app.post('/api/dev/demo-practice',async c=>{
  if(!['test','development'].includes(c.env.APP_MODE)||!['localhost','127.0.0.1','[::1]'].includes(new URL(c.req.url).hostname))return c.notFound();
  return c.json(await seedDemo(c.env.DB,c.get('userId')));
});
app.get('/api/me',c=>c.json({userId:c.get('userId'),csrf:c.get('csrf'),mode:c.env.APP_MODE}));
app.post('/api/logout',async c=>{await logout(c);return c.json({ok:true});});
app.get('/api/dashboard',async c=>{
  const [progress,analysis,totals]=await Promise.all([roundProgress(c.env.DB,c.get('userId')),analytics(c.env.DB,c.get('userId')),c.env.DB.prepare("SELECT COUNT(*) AS total,SUM(v.gradable) AS gradable FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school'").first()]);
  return c.json({progress,analysis,totals,examDate:'2027-01-21'});
});
app.get('/api/context',async c=>c.json(await learningContext(c.env.DB,c.get('userId'))));
app.post('/api/rounds/start',async c=>{
  const input=z.object({restart:z.boolean().default(false)}).parse(await c.req.json());
  const current=await stmt(c.env.DB,"SELECT 1 FROM rounds WHERE user_id=? AND status='active'",c.get('userId')).first();
  if(!current){
    const verified=await c.env.DB.prepare('SELECT question_count AS total,gradable_count AS gradable FROM imports ORDER BY created_at DESC LIMIT 1').first<{total:number;gradable:number}>();
    const actual=await c.env.DB.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(v.gradable),0) AS gradable FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school'").first<{total:number;gradable:number}>();
    if(!verified||verified.total!==actual?.total||verified.gradable!==actual.gradable)throw new AppError(409,'教材のインポートを完了してください。');
  }
  return c.json(await startRound(c.env.DB,c.get('userId'),input.restart));
});
app.get('/api/rounds',async c=>c.json(await roundProgress(c.env.DB,c.get('userId'),c.req.query('id'))));
app.get('/api/exercise',async c=>c.json(await nextExercise(c.env.DB,c.get('userId'),c.req.query('type')??'round',c.req.query('id'))));
app.post('/api/answers',async c=>{
  const result=await submitAnswer(c.env.DB,c.get('userId'),await c.req.json());
  if(result.attempt.verdict==='pending')c.executionCtx.waitUntil(processJobs(c.env,1));
  return c.json(result);
});
app.get('/api/results/:id',async c=>c.json(await getResult(c.env.DB,c.get('userId'),c.req.param('id'))));
app.post('/api/results/:id/regrade',async c=>{const r=await requestRegrade(c.env.DB,c.get('userId'),c.req.param('id'));c.executionCtx.waitUntil(processJobs(c.env,1));return c.json(r,202);});
app.post('/api/results/:id/correct',async c=>{
  const input=z.object({verdict:z.enum(['correct','incorrect']),reason:z.string().trim().min(1).max(1000)}).parse(await c.req.json());
  const evaluation:Evaluation={verdict:input.verdict,score:input.verdict==='correct'?100:0,reason:input.reason,strengths:[],missing:[],improvement:'',model:'owner',promptVersion:'manual-v1',rubricVersion:'manual-v1',gradedAt:now()};
  await recordEvaluation(c.env.DB,c.get('userId'),c.req.param('id'),evaluation,'manual');
  return c.json(await getResult(c.env.DB,c.get('userId'),c.req.param('id')));
});
app.put('/api/draft',async c=>{
  const d=z.object({contextType:z.enum(['round','practice','review']),contextId:z.string().max(160),questionId:z.string().max(160),versionId:z.string().max(200),response:z.union([z.string().max(5000),z.array(z.string().max(160)).max(10)]),elapsedMs:z.number().int().min(0).max(86400000)}).parse(await c.req.json());
  await validateContext(c.env.DB,c.get('userId'),d);
  await stmt(c.env.DB,'INSERT INTO drafts VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,context_type,context_id,question_id) DO UPDATE SET response=excluded.response,elapsed_ms=excluded.elapsed_ms,updated_at=excluded.updated_at',c.get('userId'),d.contextType,d.contextId,d.questionId,JSON.stringify(d.response),d.elapsedMs,now()).run();
  return c.json({saved:true});
});
const queryFilters=(c:{req:{query:(key:string)=>string|undefined}})=>({unit:c.req.query('unit'),type:c.req.query('type'),tag:c.req.query('tag'),origin:c.req.query('origin'),state:c.req.query('state'),cursor:c.req.query('cursor'),limit:Math.min(100,Math.max(1,Number(c.req.query('limit'))||30)),query:c.req.query('query')});
app.get('/api/questions',async c=>c.json(await listQuestions(c.env.DB,queryFilters(c),c.get('userId'))));
app.get('/api/questions/:id',async c=>{const v=await getVersion(c.env.DB,c.req.param('id'));return c.json(safeQuestion(parseJSON<Question>(v.payload),v.id,parseJSON<string[]>(v.tags),v.origin));});
app.get('/api/images',async c=>{
  const path=c.req.query('path')??'',version=c.req.query('version');const image=await (version?stmt(c.env.DB,'SELECT b.mime,b.bytes FROM version_assets v JOIN asset_blobs b ON b.content_hash=v.content_hash WHERE v.path=? AND v.version_id=?',path,version):stmt(c.env.DB,'SELECT mime,bytes FROM assets WHERE path=?',path)).first<{mime:string;bytes:number[]|ArrayBuffer}>();
  if(!image)return c.notFound();
  return new Response(Array.isArray(image.bytes)?new Uint8Array(image.bytes):image.bytes,{headers:{'Content-Type':image.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
});
app.get('/api/history',async c=>c.json(await history(c.env.DB,c.get('userId'),{...queryFilters(c),questionId:c.req.query('questionId'),from:c.req.query('from'),to:c.req.query('to'),verdict:c.req.query('verdict')})));
app.get('/api/analytics',async c=>c.json(await analytics(c.env.DB,c.get('userId'))));
app.get('/api/practice',async c=>c.json((await stmt(c.env.DB,"SELECT * FROM practice_sets WHERE user_id=? AND json_extract(conditions,'$.repeatedFrom') IS NULL ORDER BY created_at DESC LIMIT 100",c.get('userId')).all()).results));
app.post('/api/practice',async c=>{const r=await createPracticeSet(c.env.DB,c.get('userId'),await c.req.json());if(r.status==='generating')c.executionCtx.waitUntil(processJobs(c.env,1));return c.json(r,201);});
app.post('/api/practice/:id/restart',async c=>c.json(await restartPracticeSet(c.env.DB,c.get('userId'),c.req.param('id')),201));
app.get('/api/practice/:id',async c=>{
  const data=await practiceResults(c.env.DB,c.get('userId'),c.req.param('id'));
  const owner=isOwnerSession(await getSession(c),c.env);
  return c.json(practiceVisibility(data,owner));
});
app.post('/api/practice/:id/adopt',async c=>{
  const p=await practiceResults(c.env.DB,c.get('userId'),c.req.param('id'));
  if(p.set.status!=='draft'||!p.items.length||p.items.some(i=>!(i.verification as {valid?:boolean}).valid))throw new AppError(409,'検証済みの問題集を確認してください。');
  await stmt(c.env.DB,"UPDATE practice_sets SET status='ready' WHERE id=? AND user_id=? AND status='draft'",p.set.id,c.get('userId')).run();return c.json({adopted:true});
});
app.delete('/api/practice/:id/items/:questionId',async c=>{
  const p=await practiceResults(c.env.DB,c.get('userId'),c.req.param('id'));if(p.set.status!=='draft')throw new AppError(409,'確認中の問題だけ除外できます。');
  await stmt(c.env.DB,'DELETE FROM practice_items WHERE set_id=? AND question_id=?',p.set.id,c.req.param('questionId')).run();return c.json({excluded:true});
});
app.post('/api/practice/:id/retry',async c=>{
  const p=await practiceResults(c.env.DB,c.get('userId'),c.req.param('id'));if(p.set.status!=='failed')throw new AppError(409,'再生成できる状態ではありません。');
  await c.env.DB.batch([stmt(c.env.DB,"UPDATE practice_sets SET status='generating' WHERE id=? AND user_id=?",p.set.id,c.get('userId')),stmt(c.env.DB,"UPDATE jobs SET status='pending',tries=0,next_at=?,updated_at=? WHERE user_id=? AND json_extract(payload,'$.setId')=? AND status='failed'",now(),now(),c.get('userId'),p.set.id)]);
  c.executionCtx.waitUntil(processJobs(c.env,1));return c.json({queued:true},202);
});
app.get('/api/settings',async c=>{
  const [usage,jobs,counts]=await Promise.all([stmt(c.env.DB,'SELECT * FROM ai_usage WHERE day=?',new Date().toISOString().slice(0,10)).first(),stmt(c.env.DB,"SELECT id,kind,status,last_error,next_at FROM jobs WHERE user_id=? AND status!='done' ORDER BY created_at DESC LIMIT 30",c.get('userId')).all(),c.env.DB.prepare("SELECT COUNT(*) AS total,SUM(v.gradable) AS gradable FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school'").first()]);
  return c.json({usage,jobs:jobs.results,counts,aiModel:c.env.AI_MODEL,dailyNeurons:Number(c.env.AI_DAILY_NEURONS),mcpURL:`${c.env.APP_ORIGIN}/mcp`,scopes:SCOPES});
});
app.post('/api/jobs/run',async c=>{c.executionCtx.waitUntil(processJobs(c.env,2));return c.json({queued:true},202);});
app.get('/api/backup',async c=>c.json(await exportBackup(c.env.DB),200,{'Content-Disposition':`attachment; filename="info1-backup-${new Date().toISOString().slice(0,10)}.json"`}));
app.post('/api/restore',async c=>c.json(await restoreBackup(c.env.DB,await c.req.json(),c.get('userId'))));
app.post('/api/import/question',async c=>{
  const q=SourceQuestion.parse(await c.req.json());
  const count=await stmt(c.env.DB,"SELECT COUNT(*) AS n FROM rounds WHERE user_id=? AND status='active'",c.get('userId')).first<{n:number}>();
  // Existing rounds stay pinned to their original versions; updates cannot erase history.
  const result=await insertQuestion(c.env.DB,q,Number(c.req.query('position'))||0);
  return c.json({...result,activeRoundUnchanged:!!count?.n});
});
app.post('/api/import/image',async c=>{
  const input=z.object({path:z.string().regex(/^assets\/[\w.\-]+$/u),base64:z.string().max(300000),mime:z.literal('image/png')}).parse(await c.req.json());
  const bytes=Uint8Array.from(atob(input.base64),v=>v.charCodeAt(0));
  if(bytes.length>200000||bytes[0]!==137||bytes[1]!==80||bytes[2]!==78||bytes[3]!==71)throw new AppError(400,'PNG画像を選択してください。');
  const contentHash=await hash(bytes);await c.env.DB.batch([stmt(c.env.DB,'INSERT INTO assets VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes,content_hash=excluded.content_hash',input.path,input.mime,bytes.buffer,contentHash),stmt(c.env.DB,'INSERT OR IGNORE INTO asset_blobs VALUES(?,?,?)',contentHash,input.mime,bytes.buffer)]);return c.json({saved:true});
});
app.post('/api/import/finish',async c=>{
  const expected=z.object({total:z.number().int().min(1).max(10000),gradable:z.number().int().min(0),images:z.number().int().min(0)}).parse(await c.req.json());
  const actual=(await c.env.DB.prepare("SELECT COUNT(*) AS total,SUM(v.gradable) AS gradable FROM questions q JOIN question_versions v ON v.id=q.current_version WHERE q.origin='school'").first<{total:number;gradable:number}>())!;
  const images=(await c.env.DB.prepare("SELECT COUNT(DISTINCT j.value) AS n FROM questions q JOIN question_versions v ON v.id=q.current_version,json_each(v.payload,'$.image_paths') j WHERE q.origin='school' AND EXISTS(SELECT 1 FROM assets a WHERE a.path=j.value)").first<{n:number}>())!.n;
  if(expected.total!==actual.total||expected.gradable!==actual.gradable||expected.images!==images)throw new AppError(409,`件数が一致しません。問題${actual.total}問、採点対象${actual.gradable}問、画像${images}点。`);
  const versions=(await c.env.DB.prepare("SELECT v.payload FROM question_versions v JOIN questions q ON q.current_version=v.id WHERE q.origin='school'").all<{payload:string}>()).results;
  const paths=new Set((await c.env.DB.prepare('SELECT path FROM assets').all<{path:string}>()).results.map(r=>r.path));
  const missing=versions.flatMap(v=>parseJSON<Question>(v.payload).image_paths).filter(p=>!paths.has(p));if(missing.length)throw new AppError(409,'不足画像: '+missing.join(', '));
  await stmt(c.env.DB,'INSERT INTO imports VALUES(?,?,?,?,?)',id(),actual.total,actual.gradable,images,now()).run();
  return c.json({verified:true,...actual,images});
});
// Learning screens are public. Only MCP authorization requires GitHub identity.
app.all('*',async c=>{

  if(c.req.path==='/questions/'||c.req.path==='/questions')return c.redirect('/practice/');
  if(c.req.path==='/login/'||c.req.path==='/login')return c.redirect('/');
  if(['/analytics/','/history/','/settings/'].includes(c.req.path))return c.redirect('/');
  return c.env.ASSETS.fetch(c.req.raw);
});

export function createProvider(env:Env){
  return new OAuthProvider<Bindings>({
    apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
    scopesSupported:SCOPES,requiredScopes:['learning:read'],clientIdMetadataDocumentEnabled:true,
    resourceMetadata:{resource:`${env.APP_ORIGIN}/mcp`,authorization_servers:[env.APP_ORIGIN]},
    apiHandler:{async fetch(request,bindings,ctx){
      const auth=ctx as OAuthResourceContext<{userId:string;scopes:string[]}>;
      const userId=auth.props?.userId;
      if(!userId||!auth.auth.scope.includes('learning:read'))return new Response('権限がありません。',{status:403});
      if(bindings.APP_MODE==='production'&&userId!==`github:${bindings.OWNER_GITHUB_ID}`)return new Response('権限がありません。',{status:403});
      const exists=await stmt(bindings.DB,'SELECT 1 FROM users WHERE id=?',userId).first();if(!exists)return new Response('権限がありません。',{status:403});
      return mcpHandler(bindings,userId,auth.auth.scope)(request,bindings,ctx);
    }},
    defaultHandler:{fetch:(request,bindings,ctx)=>app.fetch(request,bindings,ctx)},
  });
}
export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext){
    try{return await createProvider(env).fetch(request,env as Bindings,ctx);}
    catch(error){console.error(JSON.stringify({event:'provider_failed',type:error instanceof Error?error.name:'unknown'}));return Response.json({error:'接続処理を完了できませんでした。'},{status:500,headers:{'Cache-Control':'no-store'}});}
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){
    ctx.waitUntil(processJobs(env,2));
    ctx.waitUntil(stmt(env.DB,'DELETE FROM sessions WHERE expires_at<?',now()).run());
  },
};
