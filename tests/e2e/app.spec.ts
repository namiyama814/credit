import { test,expect,type APIRequestContext } from '@playwright/test';
import { fixtureQuestion } from '../fixtures';
async function login(request:APIRequestContext){const r=await request.post('/auth/test');expect(r.ok()).toBe(true);return (await r.json()).csrf as string;}
async function seed(request:APIRequestContext,csrf:string){for(let i=0;i<2;i++){const q=fixtureQuestion(i,i===1?'記述式':'選択式');expect((await request.post(`/api/import/question?position=${i}`,{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:q})).ok()).toBe(true);}await request.post('/api/import/finish',{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:{total:2,gradable:2,images:0}});}
test('学習はログイン不要、MCPは認証必須・CSRFを拒否する',async({request})=>{
 expect((await request.get('/api/questions')).status()).toBe(200);const mcp=await request.get('/mcp');expect(mcp.status()).toBe(401);expect(mcp.headers()['www-authenticate']).toContain('resource_metadata');
 await login(request);expect((await request.post('/api/rounds/start',{data:{}})).status()).toBe(403);
});
test('選択・記述・中断再開・履歴・2色のスマートフォン画面',async({page,request})=>{
 const csrf=(await (await request.get('/api/me')).json()).csrf;await seed(request,csrf);const cookies=await request.storageState();await page.context().addCookies(cookies.cookies);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');await expect(page.getByRole('button')).toHaveText(['始める','問題集を見る']);await expect(page.locator('header,nav,h1,h2')).toHaveCount(0);await expect(page.locator('main')).toHaveText('始める問題集を見る');
 const start=page.getByRole('button',{name:'始める',exact:true});await start.click();
 await expect(page.getByRole('button',{name:'ア．サンプルA'})).toBeVisible();
 // Correct answers must not be present in pre-submission network payloads.
 const exercise=await (await request.get('/api/exercise')).json();expect(exercise.question).not.toHaveProperty('correctAnswer');expect(exercise.question).not.toHaveProperty('explanation');
 await page.getByRole('button',{name:'ア．サンプルA'}).click();await expect(page.locator('header,details,.exercise-meta,.eyebrow')).toHaveCount(0);await expect(page.getByRole('button',{name:'一時中断',exact:true})).toHaveCount(0);await page.goto('/');await page.getByRole('button',{name:'始める',exact:true}).click();await expect(page.getByRole('button',{name:'ア．サンプルA'})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'回答を確定'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();await page.getByRole('link',{name:'次の問題へ'}).click();
 await page.getByRole('textbox',{name:'回答を入力'}).fill('用語1');await page.getByRole('button',{name:'回答を確定'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
 const progress=await (await request.get('/api/rounds')).json();expect(progress.current.status).toBe('cleared');
 await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByRole('button')).toHaveText(['始める','問題集を見る']);await page.evaluate(()=>document.fonts.ready);
 const audit=await page.evaluate(()=>{const wrong:string[]=[];for(const n of document.querySelectorAll<HTMLElement>('body *')){const s=getComputedStyle(n);if(s.display==='none')continue;for(const p of ['color','backgroundColor','borderTopColor','outlineColor'] as const){const v=s[p];if(!['rgb(37, 37, 37)','rgb(255, 255, 255)','rgba(0, 0, 0, 0)'].includes(v)&&!(p==='backgroundColor'&&n.matches('button:hover:not(:disabled),.button:hover')&&['rgb(56, 56, 56)','rgb(242, 242, 242)'].includes(v)))wrong.push(`${n.tagName}.${p}=${v}`);}if(!s.fontFamily.includes('Noto Sans JP'))wrong.push(`font=${s.fontFamily}`);}return {wrong,overflow:document.documentElement.scrollWidth>window.innerWidth};});
 expect(audit.wrong).toEqual([]);expect(audit.overflow).toBe(false);expect(errors).toEqual([]);
});
