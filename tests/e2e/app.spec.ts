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
 await page.getByRole('button',{name:'送信'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();await page.getByRole('link',{name:'次の問題へ'}).click();
 await page.setViewportSize({width:390,height:844});
 const answerField=page.getByRole('textbox',{name:'回答を入力'});
 await expect(answerField).toBeVisible();
 expect(await answerField.evaluate(input=>getComputedStyle(input).fontSize)).toBe('16px');
 await answerField.fill('用語1');await page.getByRole('button',{name:'送信'}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
 const progress=await (await request.get('/api/rounds')).json();expect(progress.current.status).toBe('cleared');
 await page.setViewportSize({width:390,height:844});await page.goto('/');await expect(page.getByRole('button')).toHaveText(['始める','問題集を見る']);await page.evaluate(()=>document.fonts.ready);
 const audit=await page.evaluate(()=>{const wrong:string[]=[];for(const n of document.querySelectorAll<HTMLElement>('body *')){const s=getComputedStyle(n);if(s.display==='none')continue;for(const p of ['color','backgroundColor','borderTopColor','outlineColor'] as const){const v=s[p];if(!['rgb(37, 37, 37)','rgb(255, 255, 255)','rgba(0, 0, 0, 0)'].includes(v)&&!(p==='backgroundColor'&&n.matches('button:hover:not(:disabled),.button:hover')&&['rgb(56, 56, 56)','rgb(242, 242, 242)'].includes(v)))wrong.push(`${n.tagName}.${p}=${v}`);}if(!s.fontFamily.includes('Noto Sans JP'))wrong.push(`font=${s.fontFamily}`);}return {wrong,overflow:document.documentElement.scrollWidth>window.innerWidth};});
 expect(audit.wrong).toEqual([]);expect(audit.overflow).toBe(false);expect(errors).toEqual([]);
});

test('指定した問題集を選ぶと問題一覧を挟まず演習し、通常周回を変更しない',async({page,request})=>{
 const csrf=(await (await request.get('/api/me')).json()).csrf;await seed(request,csrf);
 const before=await (await request.get('/api/rounds')).json();
 const created=await request.post('/api/practice',{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:{origin:'school',mode:'comprehensive',name:'指定問題の演習',questionIds:['fixture-0']}});expect(created.ok()).toBe(true);const set=await created.json();
 await page.context().addCookies((await request.storageState()).cookies);await page.goto('/');await page.getByRole('button',{name:'問題集を見る'}).click();
 await expect(page.getByRole('link',{name:'指定問題の演習',exact:true})).toBeVisible();await expect(page.locator('.question-summary')).toHaveCount(0);
 await page.getByRole('link',{name:'指定問題の演習',exact:true}).click();await expect(page.getByRole('button',{name:'ア．サンプルA'})).toBeVisible();
 const exercise=await (await request.get(`/api/exercise?type=practice&id=${set.id}`)).json();expect(exercise.question.id).toBe('fixture-0');expect(exercise.contextType).toBe('practice');
 await page.getByRole('button',{name:'ア．サンプルA'}).click();await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();await page.getByRole('link',{name:'採点結果を見る'}).click();
 await expect(page.locator('.stat-number')).toHaveText('1問中1問正解');await page.getByRole('link',{name:'問題集へ',exact:true}).click();await expect(page).toHaveURL(/\/practice\/$/u);
 const after=await (await request.get('/api/rounds')).json();expect(after).toEqual(before);
});

test('問題集も正解を外して不正解だけを周回し、一覧から戻っても全問クリアを保つ',async({page,request})=>{
 const csrf=(await (await request.get('/api/me')).json()).csrf;await seed(request,csrf);
 const before=await (await request.get('/api/rounds')).json();
 const response=await request.post('/api/practice',{headers:{Origin:'http://127.0.0.1:4322','X-CSRF-Token':csrf},data:{origin:'school',name:'不正解だけの問題集',questionIds:['fixture-0','fixture-1'],count:2}});expect(response.ok()).toBe(true);const set=await response.json();
 await page.context().addCookies((await request.storageState()).cookies);await page.goto(`/exercise/?type=practice&id=${set.id}`);
 await page.getByRole('button',{name:'ア．サンプルA'}).click();await page.getByRole('button',{name:'送信',exact:true}).click();await page.getByRole('link',{name:'次の問題へ'}).click();
 await expect(page.locator('.question')).toContainText('サンプル問題1');await page.getByRole('textbox',{name:'回答を入力'}).fill('誤答');await page.getByRole('button',{name:'送信',exact:true}).click();await page.getByRole('link',{name:'採点結果を見る'}).click();
 await expect(page.locator('.stat-number')).toHaveText('2問中1問正解');await expect(page.getByRole('list')).toHaveCount(0);await page.reload();await expect(page.locator('.stat-number')).toHaveText('2問中1問正解');await page.goto(`/exercise/?type=practice&id=${set.id}`);
 await expect(page.locator('.question')).toContainText('サンプル問題1');await page.getByRole('textbox',{name:'回答を入力'}).fill('用語1');await page.getByRole('button',{name:'送信',exact:true}).click();await page.getByRole('link',{name:'採点結果を見る'}).click();
 await expect(page.locator('.stat-number')).toHaveText('1問中1問正解');await expect(page.getByRole('button',{name:'もう一度'})).toHaveCount(0);
 await page.goto(`/exercise/?type=practice&id=${set.id}`);await expect(page.getByRole('heading',{name:'全問クリア',exact:true})).toBeVisible();
 expect((await (await request.get(`/api/practice/${set.id}`)).json()).items.map((i:{verdict:string})=>i.verdict)).toEqual(['correct','incorrect']);expect(await (await request.get('/api/rounds')).json()).toEqual(before);
});

test('結果と採点確認を画面中央に揃え、長文は先頭からスクロールできる',async({page})=>{
 let long=false;
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/me')return route.fulfill({json:{userId:'test',csrf:'test',canManage:false}});
  if(path==='/api/results/center')return route.fulfill({json:{attempt:{verdict:'correct',response:'回答',method:'rule',evaluation_data:{}},question:{choices:[]},answerKind:'正答',correctAnswer:'正答',explanation:long?'長文の解説。'.repeat(700):'解説'}});
  const progress={current:{id:'center',status:'cleared'},counts:{pending:0,needs_review:0},items:[]};
  return route.fulfill({json:path==='/api/rounds'?progress:{question:null,progress,contextId:'center'}});
 });
 for(const width of [390,1280]){
  await page.setViewportSize({width,height:900});
  for(const path of ['/result/?id=center','/exercise/']){
   await page.goto(path);const content=page.locator('.result-content,.completion-content');await expect(content).toBeVisible();await page.evaluate(()=>document.fonts.ready);
   const bounds=await content.boundingBox();expect(bounds).not.toBeNull();
   expect(Math.abs(bounds!.y+bounds!.height/2-450)).toBeLessThan(2);
   expect(Math.abs(bounds!.x+bounds!.width/2-width/2)).toBeLessThan(2);
   const heading=await page.locator('h1').boundingBox();expect(Math.abs(heading!.x+heading!.width/2-width/2)).toBeLessThan(40);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
 }
 long=true;await page.setViewportSize({width:390,height:844});await page.goto('/result/?id=center');await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
 expect((await page.locator('.result-content').boundingBox())!.y).toBeGreaterThanOrEqual(32);
 await page.getByRole('link',{name:'次の問題へ'}).scrollIntoViewIfNeeded();await expect(page.getByRole('link',{name:'次の問題へ'})).toBeInViewport();
});
