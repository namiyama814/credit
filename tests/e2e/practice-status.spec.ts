import {test,expect} from '@playwright/test';
const setId='129c17d6-d33c-403d-ba7c-1c2ce1a2f051';
test('生成中・検証待ち・採用待ち・失敗を表示し実数を更新する',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({json:{userId:'status-owner',csrf:'csrf'}}));
 let state='generating';let generated=1;
 await page.route('**/api/practice',r=>r.fulfill({json:[{id:setId,name:'2進数の基礎',status:state,generated,total:12,phase:generated===2?'verifying':'generating',job_status:state==='failed'?'failed':'running'}]}));
 await page.clock.install();await page.goto('/practice/');await expect(page.getByRole('link',{name:/2進数の基礎/})).toContainText('生成中');await expect(page.getByText(/検証済み 1 \/ 12問/)).toBeVisible();
 generated=2;await page.clock.fastForward(10000);await expect(page.getByText(/検証待ち/)).toBeVisible();
 state='draft';await page.clock.fastForward(10000);await expect(page.getByText(/採用待ち/)).toBeVisible();
 state='failed';await page.reload();await expect(page.getByText(/生成失敗/)).toBeVisible();
});
test('未採用の直接リンクは演習に転送せず検証結果を表示する',async({page})=>{
 await page.route('**/api/me',r=>r.fulfill({json:{userId:'status-owner',csrf:'csrf',canManage:true}}));
 let state='draft';let adopted=false;
 const data=()=>({set:{id:setId,name:'2進数の基礎',status:state},progress:{generated:12,verified:12,total:12},jobs:[{kind:'generate',status:'done'}],items:[{question:{text:'2進数の101を10進数へ変換してください。',choices:[]},correctAnswer:'5',explanation:'4と1を足します。',verification:{valid:true}}]});
 await page.route(`**/api/practice/${setId}`,r=>r.fulfill({json:data()}));
 await page.route(`**/api/practice/${setId}/adopt`,r=>{adopted=true;state='ready';return r.fulfill({json:{adopted:true}});});
 await page.route('**/api/exercise?**',r=>r.fulfill({json:{question:null}}));
 await page.goto(`/practice/?id=${setId}`);await expect(page.getByText('採用待ち',{exact:true})).toBeVisible();await expect(page.getByText('参考解答 5')).toBeVisible();
 await page.getByRole('button',{name:'内容を確認して採用'}).click();await expect(page).toHaveURL(new RegExp(`/exercise/\\?type=practice&id=${setId}`));expect(adopted).toBe(true);
});
