// Bots in brackets and events get real personas (name, picture, chat style, skill), unique across the whole tournament,
// and the same persona sits at the match table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Tournament } from '../src/server/tournament.js';
import { TableEvent } from '../src/server/event.js';
import { mulberry32 } from '../src/engine/cards.js';
import { autoPlay, connectPremium, testServer } from './helpers.js';

const faceOk = (f?: string) => f === undefined || fs.existsSync(`public/faces/${f}.jpg`);

test('bracket: bot slots get unique persona names (no clash with people), valid faces and named teams', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const host = { createMatchTable: () => ({ id: 'x', code: 'X' }), changed() {} };
    const t = new Tournament({ id: 'a', code: 'ABCDE', size: 16, organizerId: 'org', isPublic: false, host, rng: mulberry32(seed) });
    t.join('org', 'Raw 1'); t.join('b', 'Lowrider Lou'); t.join('c', 'Cy'); // people may share names with the bot pool
    t.start('org');
    const slots = t.rounds[0].flatMap((m) => m.teams.flatMap((x) => x!.slots));
    const names = slots.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, 'every name in the bracket is unique');
    for (const s of slots.filter((x) => x.playerId === null)) {
      assert.ok(s.persona && s.persona.name === s.name && s.name !== 'Bot');
      assert.ok(faceOk(s.persona.face));
    }
    const v: any = t.view('org');
    const players = v.rounds[0].matches.flatMap((m: any) => m.teams.flatMap((x: any) => x.players));
    assert.ok(players.some((p: any) => p.face), 'the bracket view carries bot pictures');
    assert.ok(players.filter((p: any) => !p.bot).every((p: any) => p.face === undefined));
    // A person leaving mid-tournament becomes a named bot
    t.leave('c');
    const after = t.rounds[0].flatMap((m) => m.teams.flatMap((x) => x!.slots)).find((s) => s.name !== 'Cy' && !names.includes(s.name));
    assert.ok(after && after.playerId === null && after.persona, 'leaver replaced by a persona bot');
  }
});

test('event: bot seats get unique persona names and valid faces', () => {
  const ev = new TableEvent({ id: 'e', code: 'EVENT', tables: 3, target: 250, organizerId: 'o', host: { createEventTable: () => ({ id: 'x', code: 'X' }), changed() {} } });
  for (const [id, n] of [['o', 'Org'], ['b', 'Bea'], ['c', 'Cy'], ['d', 'Dee'], ['e', 'Eve']]) ev.join(id, n);
  ev.start('o');
  const seats = ev.results.flatMap((r) => r.seats);
  assert.equal(seats.length, 8);
  const names = seats.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
  for (const s of seats.filter((x) => !x.playerId)) { assert.ok(s.persona && s.name === s.persona.name); assert.ok(faceOk(s.persona.face)); }
});

test('match and event tables seat the same bot personas that the bracket / event shows', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    for (const create of [{ t: 'createTournament', size: 4, isPublic: false }, { t: 'createEvent', tables: 1, target: 250 }]) {
      const { c } = await connectPremium(srv.port, 'Host');
      c.send(create);
      const kind = create.t === 'createEvent' ? 'event' : 'tournament';
      await c.waitFor((m) => m.t === kind);
      c.send({ t: kind === 'event' ? 'startEvent' : 'startTournament' });
      const table = await c.waitFor((m) => m.t === 'table' && m.seats, 8000, true);
      const sheet = await c.waitFor((m) => m.t === kind && m.state === 'running', 8000, true);
      const teams = kind === 'event' ? sheet.results[0].teams : sheet.rounds[0].matches.find((m: any) => m.teams.some((x: any) => x?.mine)).teams;
      const shown = teams.flatMap((x: any) => x.players).filter((p: any) => p.bot);
      const seated = table.seats.filter((s: any) => s.kind === 'bot');
      assert.deepEqual(seated.map((s: any) => s.name).sort(), shown.map((p: any) => p.name).sort(), `${kind}: same bot names`);
      for (const s of seated) assert.equal(s.face, shown.find((p: any) => p.name === s.name).face, `${kind}: same picture`);
      c.send({ t: kind === 'event' ? 'leaveEvent' : 'leaveTournament' });
      c.close();
    }
  } finally { await srv.close(); }
});

test('a finished bracket can be closed: the server answers leaveTournament with tournamentLeft and the player can host again', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c } = await connectPremium(srv.port, 'Host');
    c.send({ t: 'createTournament', size: 4, isPublic: false });
    await c.waitFor((m) => m.t === 'tournament');
    c.send({ t: 'startTournament' });
    autoPlay(c); // play our matches out (fast test timings); bot-only matches are instant
    await c.waitFor((m) => m.t === 'tournament' && m.state === 'finished', 60000, true);
    c.send({ t: 'leaveTournament' });
    await c.waitFor((m) => m.t === 'tournamentLeft', 5000, true);
    c.send({ t: 'createTournament', size: 4, isPublic: false });
    const again = await c.waitFor((m) => m.t === 'tournament' && m.state === 'registering', 5000, true);
    assert.ok(again.isOrganizer);
    c.close();
  } finally { await srv.close(); }
});
