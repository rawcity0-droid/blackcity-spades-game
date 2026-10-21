import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { testServer } from './helpers.js';

test('manifest is valid JSON with the install fields and real icon files', () => {
  const m = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(m.name, 'Blackcity Spades'); assert.equal(m.short_name, 'BC Spades');
  assert.equal(m.start_url, '/'); assert.equal(m.display, 'standalone');
  assert.ok(m.theme_color && m.background_color);
  const sizes = m.icons.map((i: any) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(m.icons.some((i: any) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(readFileSync('public' + i.src).length > 1000);
  const html = readFileSync('public/index.html', 'utf8');
  assert.match(html, /rel="manifest"/); assert.match(html, /apple-touch-icon/); assert.match(html, /apple-mobile-web-app-capable/);
});

test('PWA files are served with the right content types and the CSP allows them', async () => {
  const srv = await testServer();
  try {
    for (const [path, type] of [['/manifest.webmanifest', 'application/manifest+json'], ['/sw.js', 'text/javascript'], ['/icons/icon-192.png', 'image/png'], ['/icons/apple-touch-icon.png', 'image/png']]) {
      const r = await fetch(`http://127.0.0.1:${srv.port}${path}`);
      assert.equal(r.status, 200, path);
      assert.ok(r.headers.get('content-type')!.startsWith(type), path);
      const csp = r.headers.get('content-security-policy')!;
      assert.match(csp, /manifest-src 'self'/); assert.match(csp, /worker-src 'self'/);
    }
  } finally { await srv.close(); }
});

test('service worker never handles /ws or API calls, and caches GET static files', () => {
  const handlers: Record<string, Function> = {};
  const self: any = { addEventListener: (t: string, f: Function) => { handlers[t] = f; }, location: { origin: 'https://x.test' } };
  vm.runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, caches: { match: () => Promise.resolve(undefined), open: () => Promise.resolve({ put() {} }) }, fetch: () => Promise.resolve({ ok: false }), URL, Response });
  const responded = (path: string, method = 'GET') => {
    let hit = false;
    handlers.fetch({ request: { method, url: 'https://x.test' + path }, respondWith: () => { hit = true; } });
    return hit;
  };
  assert.equal(responded('/ws'), false);
  assert.equal(responded('/ws?x=1'), false);
  assert.equal(responded('/api/dev/subscription'), false);
  assert.equal(responded('/app.js', 'POST'), false);
  assert.equal(responded('/app.js'), true);
  assert.equal(responded('/style.css'), true);
  assert.equal(responded('/icons/icon-192.png'), true);
});
