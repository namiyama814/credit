import { test, expect } from '@playwright/test';

test('PWAのインストール設定・オフライン復帰・教材のキャッシュ除外', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '始める', exact: true })).toBeEnabled();
  const manifestURL = await page.locator('link[rel=manifest]').getAttribute('href');
  const response = await page.request.get(manifestURL!);
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', name: '情報Ⅰ' });
  expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(['192x192', '512x512']);
  for (const icon of manifest.icons) {
    const png = await page.request.get(icon.src);
    expect(png.ok()).toBe(true);
    expect(png.headers()['content-type']).toContain('image/png');
    const bytes = await png.body();
    const [width, height] = icon.sizes.split('x').map(Number);
    expect(bytes.readUInt32BE(16)).toBe(width);
    expect(bytes.readUInt32BE(20)).toBe(height);
  }
  const workerSource=await (await page.request.get('/sw.js')).text();
  expect(workerSource).toMatch(/const CACHE = 'info1-shell-[0-9a-f]{20}';/u);
  const cdp = await context.newCDPSession(page);
  expect((await cdp.send('Page.getAppManifest')).errors).toEqual([]);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);
  await page.evaluate(async () => { await fetch('/api/questions'); await fetch('/api/me'); });
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).filter(key => key.startsWith('info1-shell-')).map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat());
  expect(cached).toContain('/offline.html');
  expect(cached.some(path => /^\/(api|auth|oauth|authorize|mcp|exercise|result)(\/|$)/u.test(path))).toBe(false);
  await context.setOffline(true);
  await page.goto('/practice/');
  await expect(page.getByRole('heading', { name: 'オフライン', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '再読み込み', exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => document.fonts.check('24px "Noto Sans JP Variable"', 'オフライン'))).toBe(true);
  await context.setOffline(false);
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('.collection-list,.practice-empty')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'オフライン', exact: true })).toHaveCount(0);
});
