// Player avatars: the server keeps only a known picture or a well-formed custom face; everything else falls back.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AVATAR_PARTS, PRESET_AVATARS, fallbackAvatar, validAvatar } from '../src/server/avatar.js';
import { FACE_BOTS, RAW_ONE } from '../src/server/personas.js';
import { Client, connectPremium, testServer } from './helpers.js';
// @ts-expect-error plain JS module shared with the browser
import { PARTS, isCustom, seededCode, avatarSvg, encode } from '../public/avatar.js';

const CUSTOM = 'c' + AVATAR_PARTS.map(([, n]) => (n - 1).toString(36)).join(''); // the last choice of every part

test('validAvatar keeps presets and good custom codes, and drops fake, oversized, out-of-range and non-string data', () => {
  for (const id of PRESET_AVATARS) assert.equal(validAvatar(id), id);
  assert.equal(validAvatar(CUSTOM), CUSTOM);
  for (const bad of ['marcus', 'raw1', 'tasha', '../x', 'LION', '', 'c', CUSTOM + '0', 'x' + CUSTOM.slice(1), 'c' + 'z'.repeat(AVATAR_PARTS.length),
    'x'.repeat(5000), 42, null, {}, ['lion'], true]) assert.equal(validAvatar(bad), undefined, String(bad).slice(0, 30));
});

test('presets are real files and never a named computer player\'s photo', () => {
  const people = new Set(FACE_BOTS.filter((f) => !(PRESET_AVATARS as readonly string[]).includes(f.face)).map((f) => f.face).concat(RAW_ONE.face));
  for (const id of PRESET_AVATARS) {
    assert.ok(fs.existsSync(path.resolve('public/faces', id + '.jpg')), id);
    assert.ok(!people.has(id), id);
  }
  for (const id of ['marcus', 'tasha', 'jerome', 'keisha', 'dre', 'luis', 'kim', 'mari', 'pearl', 'granny', 'cooper', 'raw1', 'bnasty', 'anime1', 'anime2']) assert.ok(!(PRESET_AVATARS as readonly string[]).includes(id));
});

test('the fallback face is fixed per seed, always valid, and matches the browser copy', () => {
  assert.equal(fallbackAvatar('p:abc'), fallbackAvatar('p:abc'));
  assert.notEqual(fallbackAvatar('p:abc'), fallbackAvatar('p:abd'));
  for (let i = 0; i < 200; i++) {
    const c = fallbackAvatar('seed' + i);
    assert.equal(validAvatar(c), c);
    assert.equal(seededCode('seed' + i), c);
    assert.ok(isCustom(c));
    assert.match(avatarSvg(c), /^<svg[\s\S]*<\/svg>$/);
  }
  assert.deepEqual(PARTS.map((p: any) => [p.key, p.n]), AVATAR_PARTS);
  assert.equal(encode({}), 'c' + '0'.repeat(AVATAR_PARTS.length));
});

async function hello(port: number, nick: string, face: unknown) {
  const c = new Client(port);
  await c.open();
  const w = c.waitFor((m) => m.t === 'welcome');
  c.send({ t: 'hello', nick, face });
  return { c, welcome: await w };
}
const seatOf = (view: any, name: string) => view.seats.find((s: any) => s.name === name);

test('a picked avatar is stored on the seat and everyone at the table sees it; a fake one falls back', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c: host } = await connectPremium(srv.port, 'Host');
    host.send({ t: 'setFace', face: 'lion' });
    host.send({ t: 'createTable', isPublic: false, target: 250 });
    const t = await host.waitFor((m) => m.t === 'table' && m.id);
    assert.equal(seatOf(t, 'Host').face, 'lion');

    const { c: guest } = await hello(srv.port, 'Guest', CUSTOM);
    guest.send({ t: 'joinCode', code: t.code });
    const seen = await host.waitFor((m) => m.t === 'table' && seatOf(m, 'Guest'));
    assert.equal(seatOf(seen, 'Guest').face, CUSTOM); // the host sees the guest's face

    const { c: faker, welcome } = await hello(srv.port, 'Faker', 'marcus'); // a named player's photo is not on the list
    faker.send({ t: 'joinCode', code: t.code });
    const v = await guest.waitFor((m) => m.t === 'table' && seatOf(m, 'Faker'));
    assert.equal(seatOf(v, 'Faker').face, fallbackAvatar('p:' + welcome.id));
    assert.equal(seatOf(v, 'Host').face, 'lion');

    faker.send({ t: 'setFace', face: '<script>' }); // junk later clears to the fallback too
    faker.send({ t: 'setFace', face: 'wolf' });
    const v2 = await host.waitFor((m) => m.t === 'table' && seatOf(m, 'Faker')?.face === 'wolf');
    assert.equal(seatOf(v2, 'Faker').face, 'wolf');
    for (const s of v2.seats) if (s.kind !== 'empty') assert.ok(validAvatar(s.face), s.name); // computer seats get a face too
    for (const c of [host, guest, faker]) c.close();
  } finally { await srv.close(); }
});
