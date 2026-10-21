// Minimal service worker: caches static files only, so the app opens fast and can be installed.
// app.js, style.css and the page itself are network-first (a deploy shows up right away); other static
// files are cache-first. The WebSocket (/ws) and any API path are never touched.
const CACHE = 'bc-spades-v1';
const NETWORK_FIRST = ['/', '/index.html', '/app.js', '/style.css'];
const STATIC = /\.(js|css|png|jpg|svg|woff2|ttf|webmanifest|html)$/;

function skip(url) {
  return url.pathname.startsWith('/ws') || url.pathname.startsWith('/api') || url.pathname.startsWith('/dev') || url.pathname.startsWith('/billing');
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || skip(url)) return;
  if (!(NETWORK_FIRST.includes(url.pathname) || STATIC.test(url.pathname))) return;
  const put = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (NETWORK_FIRST.includes(url.pathname) || url.pathname.endsWith('.js')) {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req).then((r) => r || Response.error())));
  } else {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then(put)));
  }
});
