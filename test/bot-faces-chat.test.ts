// Bots get names and (some) photos, and they talk in the table chat. Nothing here changes the game rules.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Table, FACE_BOTS, RAW_ONE, defaultTimings } from '../src/server/table.js';
import { secureRng } from '../src/engine/cards.js';
import { sleep } from './helpers.js';

function makeTable(pace: number, rng = secureRng) {
  const sent: any[] = [];
  const t = new Table({
    id: 't1', code: 'ABCD', isPublic: false, target: 250, hostId: 'p1', quick: true,
    timings: { ...defaultTimings(), botDelayMs: 0, trickPauseMs: 0, handPauseMs: 60000, botChatPace: pace },
    hooks: { send: (_id: string, m: object) => sent.push(m), changed() {}, destroyed() {}, released() {} },
    rng,
  });
  return { t, sent };
}
const botLines = (sent: any[]) => sent.filter((m) => m.t === 'chatMsg' && !m.mine && m.role === 'player');

test('every bot photo file exists and "Raw 1" uses the owner photo', () => {
  const dir = path.resolve('public/faces');
  for (const f of [...FACE_BOTS, RAW_ONE]) assert.ok(fs.existsSync(path.join(dir, f.face + '.jpg')), `${f.face}.jpg is missing`);
  assert.equal(RAW_ONE.name, 'Raw 1');
});

test('a bot seat can get the Raw 1 persona, a photo persona, or just a name, and names never repeat at a table', () => {
  let seen = new Set<string>();
  let rawOne = 0, faces = 0, plain = 0;
  for (let n = 0; n < 200; n++) {
    const { t } = makeTable(0);
    t.seatHuman(0, 'p1', 'Raw', true);
    t.startGame();
    const bots = t.seats.filter((s) => s.kind === 'bot');
    assert.equal(bots.length, 3);
    assert.equal(new Set(t.seats.map((s) => s.name)).size, 4, 'unique names at the table');
    assert.ok(bots.filter((b) => b.name === 'Raw 1').length <= 1);
    for (const b of bots) {
      seen.add(b.name);
      if (b.name === 'Raw 1') { rawOne++; assert.equal(b.face, 'raw1'); }
      else if (b.face) { faces++; assert.ok(FACE_BOTS.some((f) => f.face === b.face && f.name === b.name)); }
      else plain++;
    }
    t.dispose();
  }
  assert.ok(rawOne > 20, `Raw 1 should show up often (got ${rawOne} of 200 tables)`);
  assert.ok(faces > 100 && plain > 100, `a mix of photo bots and plain bots (faces ${faces}, plain ${plain})`);
  assert.ok(seen.size > 30, 'a wide pool of names');
});

test('the table view only carries a photo id for bots, never for people', () => {
  const { t } = makeTable(0, () => 0);
  t.seatHuman(0, 'p1', 'Raw', true);
  t.startGame();
  const v: any = t.view('p1');
  assert.equal(v.seats[0].face, undefined);
  assert.equal(v.seats[1].face, 'raw1');
  t.dispose();
});

test('with chat pace 0 the bots stay quiet', async () => {
  const { t, sent } = makeTable(0);
  t.seatHuman(0, 'p1', 'Raw', true);
  t.startGame();
  t.postChat('p1', 'Raw', 'hey everybody');
  await sleep(300);
  assert.equal(botLines(sent).length, 0);
  t.dispose();
});

test('bots greet the table, answer a person who writes, and stop when the table closes', async () => {
  const { t, sent } = makeTable(0.01);
  t.seatHuman(0, 'p1', 'Raw', true);
  t.startGame();
  await sleep(250);
  const greeting = botLines(sent);
  assert.ok(greeting.length >= 1, 'a bot says hello');
  const botNames = t.seats.filter((s) => s.kind === 'bot').map((s) => s.name);
  for (const m of greeting) assert.ok(botNames.includes(m.from), 'lines come from a seated bot');
  assert.ok(greeting.every((m) => m.text.length > 0 && m.text.length <= 200));
  const before = botLines(sent).length;
  t.postChat('p1', 'Raw', 'hey y’all, good luck');
  await sleep(300);
  assert.ok(botLines(sent).length > before, 'a bot replies to a person');
  const reply = botLines(sent).slice(before)[0];
  assert.ok(botNames.includes(reply.from));
  t.dispose();
  const after = botLines(sent).length;
  await sleep(200);
  assert.equal(botLines(sent).length, after, 'no more bot chat after the table is gone');
});

test('asking whether they are bots gets a playful dodge, not a claim of being human', async () => {
  const { t, sent } = makeTable(0.01);
  t.seatHuman(0, 'p1', 'Raw', true);
  t.startGame();
  await sleep(150);
  const before = botLines(sent).length;
  t.postChat('p1', 'Raw', 'are you guys bots?');
  await sleep(300);
  const reply = botLines(sent).slice(before)[0];
  assert.ok(reply, 'someone answers');
  assert.doesNotMatch(reply.text.toLowerCase(), /i('m| am) (a )?(real|human|person)/);
  t.dispose();
});
