import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile,readdir } from 'node:fs/promises';
import { ensureUser } from '../src/server/service';
export async function harness(){
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-11-13',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'test'},kvNamespaces:['OAUTH_KV'],bindings:{APP_MODE:'test',APP_ORIGIN:'http://127.0.0.1:4321',OWNER_GITHUB_ID:'test',AI_MODEL:'@cf/google/gemma-4-26b-a4b-it',AI_DAILY_NEURONS:'8000',GITHUB_CLIENT_ID:'test',GITHUB_CLIENT_SECRET:'test'}}));
  const env=await mf.getBindings<Env>();
  const files=(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();
  const sql=(await Promise.all(files.map(f=>readFile(new URL('../migrations/'+f,import.meta.url),'utf8')))).join('\n');
  await env.DB.batch(sql.split(';').map(x=>x.trim()).filter(Boolean).map(x=>env.DB.prepare(x)));
  await ensureUser(env.DB,'test-owner','テスト');
  return {mf,env,db:env.DB,user:'test-owner'};
}
