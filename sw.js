// 最小限の Service Worker
// 同じサイトのファイルはネット優先・失敗したらキャッシュ。APIやCDNには関わらない
const CACHE = 'aichat-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || new Response('接続なし', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })))
  );
});
