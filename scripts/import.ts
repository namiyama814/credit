import { readFile } from 'node:fs/promises';
import { resolve,sep } from 'node:path';
import { parseArgs } from 'node:util';
import { SourceQuestion,deriveRule,deriveTags } from '../src/server/domain';
const {values}=parseArgs({options:{source:{type:'string',default:'info1-exam-preparation'},url:{type:'string',default:'http://127.0.0.1:4321'},test:{type:'boolean',default:false},'cookie-file':{type:'string'},'validate-only':{type:'boolean',default:false}}});
const base=resolve(values.source!),url=new URL(values.url!);
const raw:unknown=JSON.parse(await readFile(resolve(base,'questions.json'),'utf8'));
if(!Array.isArray(raw))throw new Error('questions.jsonは配列である必要があります。');
const questions=raw.map(q=>SourceQuestion.parse(q));
if(new Set(questions.map(q=>q.id)).size!==questions.length)throw new Error('問題IDが重複しています。');
for(const q of questions){deriveRule(q);deriveTags(q);}
const images=[...new Set(questions.flatMap(q=>q.image_paths))],imageData=[];
for(const path of images){
 const full=resolve(base,path);if(!full.startsWith(resolve(base,'assets')+sep))throw new Error('画像パスが不正です。');
 const bytes=await readFile(full);imageData.push({path,base64:bytes.toString('base64'),mime:'image/png'});
}
const counts={total:questions.length,gradable:questions.filter(q=>q.answer_verified).length,images:images.length};
if(questions.length===171&&(counts.gradable!==167||counts.images!==5))throw new Error('既存教材の件数が一致しません。');
if(values['validate-only']){console.log(JSON.stringify({...counts,uniqueIds:true,gradingRulesVerified:true,imagesVerified:true}));process.exit(0);}
let cookie='';
if(values.test){
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('--testはローカル専用です。');
 const r=await fetch(new URL('/auth/test',url),{method:'POST'});if(!r.ok)throw new Error('テストモードのサーバーを起動してください。');cookie=r.headers.get('set-cookie')?.split(';')[0]??'';
}else if(values['cookie-file'])cookie=(await readFile(values['cookie-file'],'utf8')).trim();
else throw new Error('本番は--cookie-fileに所有者のGitHub認証済みセッションのCookieヘッダーを保存した非公開ファイルを指定してください。');
const me=await fetch(new URL('/api/me',url),{headers:{Cookie:cookie}});if(!me.ok)throw new Error('ログインを確認してください。');const {csrf}=await me.json() as {csrf:string};
async function send(path:string,body:unknown){const r=await fetch(new URL('/api'+path,url),{method:'POST',headers:{Cookie:cookie,Origin:url.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok){const err=await r.json() as {error:string};throw new Error(err.error);}return r.json();}
for(const image of imageData)await send('/import/image',image);
for(const [i,q] of questions.entries())await send(`/import/question?position=${i}`,q);
console.log(JSON.stringify(await send('/import/finish',counts)));
