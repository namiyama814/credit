import {test,expect,type Page} from '@playwright/test';
const question={id:'audit-text',versionId:'audit-v1',origin:'school',sourceType:'確認テスト',unit:'架空単元',lesson:'架空授業',number:'Q1',type:'記述式',text:'監査用の架空の問題です。回答を入力してください。',choices:[],images:[],sourceUrl:'https://example.com/audit',tags:[],gradable:true,codeBlocks:[]};
const result={question,attempt:{id:'audit-result',response:'回答',verdict:'correct',method:'rule',evaluation_data:{}},correctAnswer:'回答',answerKind:'正答',explanation:'監査用の解説です。'};
async function setup(page:Page,draft:unknown=null){
 await page.route('**/api/me',route=>route.fulfill({json:{userId:'audit-owner',csrf:'audit-csrf'}}));
 await page.route('**/api/exercise?**',route=>route.fulfill({json:{question,contextType:'practice',contextId:'audit-set',draft}}));
 await page.route('**/api/draft',route=>route.fulfill({json:{saved:true}}));
 await page.route('**/api/results/audit-result',route=>route.fulfill({json:result}));
}
test('確定的な入力エラー後は編集を再開し、新しい回答を送信できる',async({page})=>{
 await setup(page);let calls=0;
 await page.route('**/api/answers',route=>{calls++;return calls===1?route.fulfill({status:400,json:{error:'入力内容を確認してください。'}}):route.fulfill({json:result});});
 await page.goto('/exercise/?type=practice&id=audit-set');const field=page.getByRole('textbox',{name:'回答を入力'});
 await expect(field).toHaveAttribute('maxlength','5000');await field.fill('最初の回答');await page.getByRole('button',{name:'送信',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(field).toBeEnabled();
 expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.endsWith(':pending')))).toEqual([]);
 await field.fill('編集した回答');await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
});
test('応答が不明な送信失敗は同じID・同じ回答で再送する',async({page})=>{
 await setup(page);const bodies:Record<string,unknown>[]=[];
 await page.route('**/api/answers',route=>{bodies.push(route.request().postDataJSON());return bodies.length===1?route.fulfill({status:503,json:{error:'一時的な障害'}}):route.fulfill({json:result});});
 await page.goto('/exercise/?type=practice&id=audit-set');const field=page.getByRole('textbox',{name:'回答を入力'});await field.fill('再送する回答');await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(field).toBeDisabled();
 await page.reload();await expect(field).toHaveValue('再送する回答');await expect(field).toBeDisabled();await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();expect(bodies[0].id).toBe(bodies[1].id);expect(bodies[0].response).toBe(bodies[1].response);
});
test('結果画面の次へリンクで外部サイト・認証URLへ移動しない',async({page})=>{
 await setup(page);
 for(const target of ['/\\evil.example/','//evil.example/','/auth/github','/oauth/token']){
  await page.goto('/result/?id=audit-result&next='+encodeURIComponent(target));await expect(page.getByRole('link',{name:'次の問題へ'})).toHaveAttribute('href','/exercise/');
 }
 await page.goto('/result/?id=audit-result&next='+encodeURIComponent('/exercise/?type=practice&id=audit-set'));await expect(page.getByRole('link',{name:'次の問題へ'})).toHaveAttribute('href','/exercise/?type=practice&id=audit-set');
});
test('古い端末下書きより新しいサーバー下書きを優先する',async({page})=>{
 await setup(page,{response:'別端末の新しい回答',elapsedMs:2000,updatedAt:'2026-11-16T01:00:00.000Z'});
 await page.addInitScript(()=>localStorage.setItem('info1:audit-owner:practice:audit-set:audit-text:draft',JSON.stringify({response:'古い回答',elapsedMs:1000,versionId:'audit-v1',editedAt:Date.parse('2026-11-15T01:00:00.000Z')})));
 await page.goto('/exercise/?type=practice&id=audit-set');await expect(page.getByRole('textbox',{name:'回答を入力'})).toHaveValue('別端末の新しい回答');
});
