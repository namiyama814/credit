import { test,expect,type APIRequestContext } from '@playwright/test';
import { fixtureQuestion } from '../fixtures';
async function login(request:APIRequestContext){const r=await request.post('/auth/test');expect(r.ok()).toBe(true);return (await r.json()).csrf as string;}
async function seed(request:APIRequestContext,csrf:string){for(let i=0;i<2;i++){const q=fixtureQuestion(i,i===1?'記述式':'選択式');expect((await request.post(`/api/import/question?position=${i}`,{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:q})).ok()).toBe(true);}await request.post('/api/import/finish',{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:{total:2,gradable:2,images:0}});}
test('未認証アクセス・CSRFを拒否する',async({request})=>{
 expect((await request.get('/api/questions')).status()).toBe(401);const mcp=await request.get('/mcp');expect(mcp.status()).toBe(401);expect(mcp.headers()['www-authenticate']).toContain('resource_metadata');
 await login(request);expect((await request.post('/api/rounds/start',{data:{}})).status()).toBe(403);
});
test('選択・記述・中断再開・履歴・2色のスマートフォン画面',async({page,request})=>{
 const csrf=await login(request);await seed(request,csrf);const cookies=await request.storageState();await page.context().addCookies(cookies.cookies);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('heading',{name:/1周目|学習を始める|全問クリア/})).toBeVisible();
 const start=page.getByRole('button',{name:/1周目を始める|学習を再開|もう一度全問を解く/});await start.click();
 await expect(page.getByRole('button',{name:'ア．サンプルA'})).toBeVisible();
 // Correct answers must not be present in pre-submission network payloads.
 const exercise=await (await request.get('/api/exercise')).json();expect(exercise.question).not.toHaveProperty('correctAnswer');expect(exercise.question).not.toHaveProperty('explanation');
 await page.getByRole('button',{name:'ア．サンプルA'}).click();await page.getByRole('button',{name:'一時中断',exact:true}).click();await page.getByRole('button',{name:'学習を再開'}).click();await expect(page.getByRole('button',{name:'ア．サンプルA'})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'回答を確定'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();await page.getByRole('link',{name:'次の問題へ'}).click();
 await page.getByRole('textbox',{name:'回答を入力'}).fill('用語1');await page.getByRole('button',{name:'回答を確定'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
 await page.goto('/');await expect(page.getByRole('heading',{name:'全問クリア',exact:true})).toBeVisible();await page.goto('/history/');await expect(page.getByRole('cell',{name:'正解',exact:true}).first()).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.goto('/analytics/');await expect(page.getByRole('heading',{name:'学習分析'})).toBeVisible();await page.evaluate(()=>document.fonts.ready);
 const audit=await page.evaluate(()=>{const wrong:string[]=[];for(const n of document.querySelectorAll<HTMLElement>('body *')){const s=getComputedStyle(n);if(s.display==='none')continue;for(const p of ['color','backgroundColor','borderTopColor','outlineColor'] as const){const v=s[p];if(!['rgb(37, 37, 37)','rgb(255, 255, 255)','rgba(0, 0, 0, 0)'].includes(v))wrong.push(`${n.tagName}.${p}=${v}`);}if(!s.fontFamily.includes('Noto Sans JP'))wrong.push(`font=${s.fontFamily}`);}return {wrong,overflow:document.documentElement.scrollWidth>window.innerWidth};});
 expect(audit.wrong).toEqual([]);expect(audit.overflow).toBe(false);expect(errors).toEqual([]);
});
