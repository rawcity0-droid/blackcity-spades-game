// Table music: persistence of on/off + volume, and the chord chart. (The audio itself is generated in the browser.)

import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain browser module, no type declarations
import { BAR, BEAT, BPM, CHORDS, COMP_PATTERNS, MAX_GAIN, MUSIC_DEFAULT, gainForVolume, midiToHz, parseMusicPrefs, serializeMusicPrefs } from '../public/music-state.js';

test('music defaults to OFF at a middling volume when nothing is saved', () => {
  assert.deepEqual(parseMusicPrefs(null), { on: false, vol: 0.5 });
  assert.deepEqual(MUSIC_DEFAULT, { on: false, vol: 0.5 });
});

test('prefs round-trip through the stored string', () => {
  const saved = serializeMusicPrefs({ on: true, vol: 0.35 });
  assert.deepEqual(parseMusicPrefs(saved), { on: true, vol: 0.35 });
  assert.deepEqual(parseMusicPrefs(serializeMusicPrefs({ on: false, vol: 0 })), { on: false, vol: 0 });
});

test('garbage in storage falls back safely: only a literal true turns music on, volume is clamped', () => {
  for (const raw of ['', 'nope', '[]', '42', 'null', '{"on":"yes"}', '{"on":1}', '{"on":"true"}']) assert.equal(parseMusicPrefs(raw).on, false, raw);
  assert.equal(parseMusicPrefs('{"on":true,"vol":9}').vol, 1);
  assert.equal(parseMusicPrefs('{"on":true,"vol":-3}').vol, 0);
  assert.equal(parseMusicPrefs('{"on":true,"vol":"loud"}').vol, 0.5);
  assert.equal(parseMusicPrefs('{"on":true}').vol, 0.5);
  assert.equal(parseMusicPrefs('{"on":true,"vol":0.3333333}').vol, 0.33);
  assert.deepEqual(JSON.parse(serializeMusicPrefs({ on: 'x', vol: 7 })), { on: false, vol: 1 });
});

test('volume maps to a soft, monotonic gain that never exceeds the cap', () => {
  let last = -1;
  for (let v = 0; v <= 1.0001; v += 0.1) { const g = gainForVolume(v); assert.ok(g >= last); assert.ok(g <= MAX_GAIN); last = g; }
  assert.equal(gainForVolume(0), 0);
  assert.equal(gainForVolume(1), MAX_GAIN);
  assert.equal(gainForVolume(5), MAX_GAIN);
  assert.ok(MAX_GAIN <= 0.35, 'background music stays quiet');
});

test('the chord chart is a slow 8-bar loop with playable, in-range voicings', () => {
  assert.equal(CHORDS.length, 8);
  assert.ok(BPM >= 60 && BPM <= 84);
  assert.ok(Math.abs(BAR - 4 * BEAT) < 1e-9);
  for (const c of CHORDS) {
    assert.ok(c.bass >= 28 && c.bass <= 45, c.name);
    for (const m of [...c.pad, ...c.keys]) assert.ok(m >= 48 && m <= 84, `${c.name} ${m}`);
  }
  for (const p of COMP_PATTERNS) for (const b of p) assert.ok(b >= 0 && b < 4);
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
});
