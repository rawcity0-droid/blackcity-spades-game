import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// @ts-expect-error plain browser module without types
import { shouldShowCover } from '../public/cover-rules.js';
import { testServer } from './helpers.js';

test('the cover shows once per session, and ?cover=1 forces it', () => {
  assert.equal(shouldShowCover({}), true, 'a fresh tab');
  assert.equal(shouldShowCover({ seen: true }), false, 'a reload in the same tab');
  assert.equal(shouldShowCover({ seen: true, forced: true }), true, '?cover=1 for testing');
  assert.equal(shouldShowCover({ deepLink: true }), false, 'an invite code or a return from checkout goes straight in');
  assert.equal(shouldShowCover({ deepLink: true, forced: true }), true);
  assert.equal(shouldShowCover(), true);
});

test('the cover image is served as a JPEG under the CSP, and is small', async () => {
  const size = fs.statSync(new URL('../public/cover.jpg', import.meta.url)).size;
  assert.ok(size < 300 * 1024, `cover.jpg is ${size} bytes`);
  const srv = await testServer();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/cover.jpg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.match(res.headers.get('content-security-policy') ?? '', /img-src 'self' data:/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xff, 0xd8, 0xff]);
  } finally { await srv.close(); }
});
