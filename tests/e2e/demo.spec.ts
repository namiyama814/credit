import { test, expect } from '@playwright/test';

test('UIモックは3種類の問題集に入り、周回・既存回答・学校教材を変えない', async ({ page, request }) => {
  const { csrf } = await (await request.get('/api/me')).json();
  const paths = ['/api/rounds', '/api/history', '/api/questions?origin=school'];
  const before = await Promise.all(paths.map(async path => (await request.get(path)).json()));
  let ids: string[] = [];
  for (let n = 0; n < 2; n++) {
    const response = await request.post('/api/dev/demo-practice', { headers: { Origin: 'http://127.0.0.1:4322', 'X-CSRF-Token': csrf }, data: {} });
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data).toMatchObject({ sets: 3, questions: 5 });
    if (n) expect(data.setIds).toEqual(ids);
    ids = data.setIds;
  }
  const after = await Promise.all(paths.map(async path => (await request.get(path)).json()));
  expect(after).toEqual(before);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto('/practice/');
  await expect(page.getByRole('link', { name: /^UI確認：/u })).toHaveCount(3);
  await page.getByRole('link', { name: 'UI確認：選択式', exact: true }).click();
  await expect(page.locator('.choice')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeVisible();
});
