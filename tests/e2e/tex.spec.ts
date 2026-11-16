import {test,expect} from '@playwright/test';
const code=String.raw`print("$2^3$")`;
const question={id:'tex-fixture',versionId:'tex-v1',origin:'ai',sourceType:'確認テスト',unit:'架空単元',lesson:'数式表示',number:'Q1',type:'選択式',text:String.raw`桁の価値は $2^3=8$ です。分数は \(\frac{1}{2}\)、平方根は \(\sqrt{4}\) です。
$$\sum_{i=0}^{3}2^i=15$$
\[\begin{pmatrix}1&0\\0&1\end{pmatrix}\]
`+code,choices:[{id:'0',text:String.raw`ア．\(2^0=1\)`},{id:'1',text:'イ．$2^0=0$'}],images:[],sourceUrl:'https://example.com',tags:[],gradable:true,codeBlocks:[code]};
test('問題・選択肢・正答・解説のTeXを描画しコードと保存する回答は変えない',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/me',r=>r.fulfill({json:{userId:'tex-test',csrf:'csrf'}}));
 await page.route('**/api/exercise?**',r=>r.fulfill({json:{question,contextType:'practice',contextId:'tex-set',draft:null}}));
 await page.route('**/api/draft',r=>r.fulfill({json:{saved:true}}));
 const result={question,attempt:{id:'tex-answer',response:['0'],verdict:'correct',method:'rule',evaluation_data:{}},correctAnswer:String.raw`\(2^0=1\)`,answerKind:'正答',explanation:String.raw`\[\frac{2^3}{2^2}=2\]`};
 await page.route('**/api/answers',async r=>{expect(r.request().postDataJSON().response).toEqual(['0']);await r.fulfill({json:result});});
 await page.route('**/api/results/tex-answer',r=>r.fulfill({json:result}));
 await page.setViewportSize({width:390,height:844});await page.goto('/exercise/?type=practice&id=tex-set');
 await expect(page.locator('.question .katex')).toHaveCount(5);await expect(page.locator('.question .katex-display')).toHaveCount(2);await expect(page.locator('.choice .katex')).toHaveCount(2);await expect(page.locator('pre code')).toHaveText(code);await expect(page.locator('pre .katex')).toHaveCount(0);
 await page.evaluate(()=>document.fonts.ready);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await page.locator('.choice').first().click();await page.getByRole('button',{name:'送信',exact:true}).click();await expect(page.getByRole('heading',{name:'正解',exact:true})).toBeVisible();
 await expect(page.locator('.result-answers .katex')).toHaveCount(2);await expect(page.locator('.result-explanation .katex-display')).toHaveCount(1);expect(errors).toEqual([]);
});
test('不正なTeX・HTML・外部リンク命令でも画面を壊さず外部へ通信しない',async({page})=>{
 const external:string[]=[];page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4322'))external.push(r.url());});
 await page.route('**/api/me',r=>r.fulfill({json:{userId:'tex-test',csrf:'csrf'}}));
 await page.route('**/api/exercise?**',r=>r.fulfill({json:{question:{...question,type:'記述式',choices:[],codeBlocks:[],text:String.raw`<img src="https://example.com/x" onerror="alert(1)"> $\frac{$ $\href{javascript:alert(1)}{リンク}$ $\includegraphics{https://example.com/math.png}$`},contextType:'practice',contextId:'tex-set',draft:null}}));
 await page.route('**/api/draft',r=>r.fulfill({json:{saved:true}}));
 await page.goto('/exercise/?type=practice&id=tex-set');await expect(page.getByRole('textbox',{name:'回答を入力'})).toBeVisible();await expect(page.locator('.question')).toContainText('<img');await expect(page.locator('.question img,.question a')).toHaveCount(0);expect(external).toEqual([]);
});
