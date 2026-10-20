// Hidden owner code (OWNER_CODE): correct unlocks Premium, wrong is refused, lockout after 5 wrong tries, off when unset.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_PREFIX } from '../src/server/activity.js';
import { Client, connect, testServer } from './helpers.js';

const CODE = '482916';
async function tryCode(c: Client, code: string): Promise<any> {
  const n = c.log.length;
  c.send({ t: 'ownerCode', code });
  return c.waitFor((m) => m.t === 'ownerCodeResult' && c.log.indexOf(m) >= n);
}
function captureLog(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  return { lines, stop: () => { console.log = orig; } };
}

test('correct code unlocks Premium on that device (like the owner email restore); log has only ok, never the code', async () => {
  const srv = await testServer({ ownerCode: CODE });
  const cap = captureLog();
  try {
    const { c, welcome } = await connect(srv.port, 'Raw');
    const r = await tryCode(c, CODE);
    assert.equal(r.ok, true);
    assert.equal(c.log.find((m) => m.t === 'subscription').subscribed, true);
    assert.equal(srv.hub.store.isSubscribed(welcome.id), true);
    assert.equal(srv.hub.store.get(welcome.id)!.source, 'owner'); // no expiry, same as OWNER_EMAILS
    assert.ok(!JSON.stringify(r).includes(CODE));
    cap.stop();
    const act = cap.lines.filter((l) => l.startsWith(ACTIVITY_PREFIX) && l.includes('owner_code_unlock'));
    assert.equal(act.length, 1);
    assert.match(act[0], /^\[activity\] \{"ev":"owner_code_unlock","ok":true,"at":"[^"]+"\}$/);
    assert.ok(cap.lines.every((l) => !l.includes(CODE)));
  } finally { cap.stop(); await srv.close(); }
});

test('wrong code is rejected and logged as ok:false; malformed codes are just wrong', async () => {
  const srv = await testServer({ ownerCode: CODE });
  const cap = captureLog();
  try {
    const { c, welcome } = await connect(srv.port, 'Nope');
    for (const bad of ['000000', '48291', 'abcdef']) {
      const r = await tryCode(c, bad);
      assert.deepEqual([r.ok, r.code], [false, 'wrong'], bad);
    }
    assert.equal(srv.hub.store.isSubscribed(welcome.id), false);
    cap.stop();
    assert.equal(cap.lines.filter((l) => l.includes('{"ev":"owner_code_unlock","ok":false')).length, 3);
    assert.ok(cap.lines.every((l) => !l.includes(CODE) && !l.includes('000000')));
  } finally { cap.stop(); await srv.close(); }
});

test('lockout after 5 wrong tries: even the right code is refused, per player and per IP', async () => {
  const srv = await testServer({ ownerCode: CODE });
  const cap = captureLog();
  try {
    const { c, welcome } = await connect(srv.port, 'Guess');
    for (let i = 1; i <= 4; i++) assert.equal((await tryCode(c, '11111' + i)).code, 'wrong');
    const fifth = await tryCode(c, '111115');
    assert.equal(fifth.code, 'locked');
    assert.match(fifth.message, /Too many wrong codes/);
    assert.equal((await tryCode(c, CODE)).code, 'locked');
    assert.equal(srv.hub.store.isSubscribed(welcome.id), false);
    // another player from the same IP is locked out too
    const other = (await connect(srv.port, 'Other')).c;
    assert.equal((await tryCode(other, CODE)).code, 'locked');
  } finally { cap.stop(); await srv.close(); }
});

test('off when OWNER_CODE is unset or not exactly 6 digits: the panel gets "not available"', async () => {
  const saved = process.env.OWNER_CODE;
  delete process.env.OWNER_CODE;
  try {
    for (const opt of [{}, { ownerCode: '12345' }, { ownerCode: '1234567' }, { ownerCode: 'abcdef' }]) {
      const srv = await testServer(opt);
      try {
        const { c } = await connect(srv.port, 'Raw');
        const r = await tryCode(c, '123456');
        assert.deepEqual([r.ok, r.code, r.message], [false, 'not_available', 'Not available.'], JSON.stringify(opt));
      } finally { await srv.close(); }
    }
  } finally { if (saved !== undefined) process.env.OWNER_CODE = saved; }
});
