const CACHE = 'info1-shell-v1';
const SHELL = ['/pwa-fonts.json', '/fonts/noto.css', '/offline.html', '/offline.js', '/auth.css', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const fonts = await fetch('/pwa-fonts.json').then(response => { if (!response.ok) throw new Error('Font manifest unavailable'); return response.json(); });
    if (!Array.isArray(fonts) || fonts.some(path => typeof path !== 'string' || !path.startsWith('/fonts/files/'))) throw new Error('Invalid font manifest');
    await cache.addAll([...SHELL, ...fonts]);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('info1-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Learning data, answer submissions, OAuth and MCP always use the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(api|auth|oauth|authorize|mcp|\.well-known)(\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(CACHE)).match('/offline.html')));
    return;
  }
  if (!SHELL.includes(url.pathname) && !['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname) && !url.pathname.startsWith('/_astro/') && !url.pathname.startsWith('/fonts/') && !url.pathname.startsWith('/icons/')) return;
  const update = fetch(request).then(async response => {
    if (response.ok && response.type === 'basic') {
      try { await (await caches.open(CACHE)).put(request, response.clone()); } catch { /* A full cache must not block online use. */ }
    }
    return response;
  });
  // Catch failed revalidation even when a cached response was already returned.
  event.waitUntil(update.then(() => undefined, () => undefined));
  // Public build assets are identical across Origin header variants (including font requests).
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(request, { ignoreVary: true })) || update));
});
