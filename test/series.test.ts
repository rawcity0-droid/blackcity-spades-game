// Bracket matches are series: best of 3 in every round but the final (first to 2 wins), best of 5 in the final (first to 3).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG } from '../src/config.js';
import { mulberry32 } from '../src/engine/cards.js';
import { Table, TableHooks, Timings } from '../src/server/table.js';
import { Match, SeriesInfo, Tournament, TournamentHost } from '../src/server/tournament.js';
import { autoPlay, connect, sleep, testServer } from './helpers.js';

function host(): TournamentHost & { tables: Match[] } {
  const tables: Match[] = [];
  return { tables, createMatchTable: (_t, m) => { tables.push(m); return { id: 'tbl' + tables.length, code: 'C' + tables.length }; }, changed() {} };
}
/** A 4-team bracket with one human team (org + a bot partner): its semifinal is live at a table. */
function humanBracket(seed = 11) {
  const h = host();
  const t = new Tournament({ id: 'a', code: 'ABCDE', size: 4, organizerId: 'org', isPublic: true, host: h, rng: mulberry32(seed) });
  t.join('org', 'Org');
  t.start('org');
  return { t, h };
}
/** Play one game of a live series the way the table + hub do: record the game, advance only when decided. */
function game(t: Tournament, m: Match, winner: 0 | 1): SeriesInfo {
  const s = t.recordGame(m.id, winner, winner === 0 ? [260, 100] : [100, 260], false)!;
  if (s.decided) t.matchResult(m.id, winner, winner === 0 ? [260, 100] : [100, 260]);
  return s;
}
const humanSide = (m: Match) => (m.teams[0]!.slots.some((s) => s.playerId) ? 0 : 1) as 0 | 1;

test('config: early rounds need 2 wins (best of 3), the final needs 3 (best of 5); targets unchanged', () => {
  assert.equal(CONFIG.tournamentWinsEarly, 2);
  assert.equal(CONFIG.tournamentWinsFinal, 3);
  const h = host();
  const t = new Tournament({ id: 'b', code: 'B', size: 8, organizerId: 'org', isPublic: true, host: h, rng: mulberry32(2) });
  t.start('org');
  assert.deepEqual(t.rounds.map((r) => r[0].need), [2, 2, 3]);
  assert.deepEqual(t.rounds.map((r) => r[0].target), [CONFIG.tournamentTargetEarly, CONFIG.tournamentTargetEarly, CONFIG.tournamentTargetFinal]);
  for (const r of t.rounds) for (const m of r) { // bot-only series are simulated in full
    assert.equal(m.wins[m.winner!], m.need);
    assert.ok(m.wins[1 - m.winner!] < m.need);
  }
});

test('a non-final match needs 2 wins: one win does not advance, the second does', () => {
  const { t, h } = humanBracket();
  const m = h.tables[0];
  assert.equal(m.round, 0);
  const s1 = game(t, m, 0);
  assert.deepEqual(s1, { wins: [1, 0], need: 2, decided: false, game: 2 });
  assert.equal(m.status, 'live');
  assert.equal(t.rounds[1][0].teams[m.index & 1], null, 'nobody advanced after one win');
  assert.equal(game(t, m, 0).decided, true);
  assert.equal(m.status, 'done');
  assert.equal(t.rounds[1][0].teams[m.index & 1]!.id, m.teams[0]!.id);
});

test('a 2–1 series advances the team that won two games', () => {
  const { t, h } = humanBracket();
  const m = h.tables[0];
  game(t, m, 0);
  game(t, m, 1);
  assert.equal(m.status, 'live');
  const s = game(t, m, 1);
  assert.deepEqual(s.wins, [1, 2]);
  assert.equal(s.decided, true);
  assert.equal(m.winner, 1);
  assert.equal(t.rounds[1][0].teams[m.index & 1]!.id, m.teams[1]!.id);
});

test('the final needs 3 wins (best of 5)', () => {
  // play until the human team reaches the final
  for (let seed = 1; seed < 50; seed++) {
    const { t, h } = humanBracket(seed);
    const semi = h.tables[0];
    const side = humanSide(semi);
    game(t, semi, side); game(t, semi, side);
    const fin = t.rounds[1][0];
    assert.equal(fin.status, 'live');
    assert.equal(fin.need, 3);
    const fs = humanSide(fin);
    for (const w of [fs, 1 - fs, fs, 1 - fs] as (0 | 1)[]) { assert.equal(game(t, fin, w).decided, false); }
    assert.equal(t.state, 'running', '2–2 is not decided');
    const last = game(t, fin, fs);
    assert.deepEqual(last.wins, fs === 0 ? [3, 2] : [2, 3]);
    assert.equal(t.state, 'finished');
    assert.equal(t.champion!.id, fin.teams[fs]!.id);
    return;
  }
});

test('bracket view shows each match\'s series score and best-of', () => {
  const { t, h } = humanBracket();
  const m = h.tables[0];
  game(t, m, 1);
  const v = t.view('org') as any;
  const mv = v.rounds[0].matches.find((x: any) => x.id === m.id);
  assert.deepEqual(mv.wins, [0, 1]);
  assert.equal(mv.need, 2);
  assert.equal(mv.bestOf, 3);
  assert.equal(v.rounds[0].bestOf, 3);
  assert.equal(v.rounds[1].bestOf, 5);
  const sim = v.rounds[0].matches.find((x: any) => x.id !== m.id);
  assert.equal(Math.max(...sim.wins), 2);
});

test('a forfeit decides the whole series', () => {
  const { t, h } = humanBracket();
  const m = h.tables[0];
  game(t, m, 0);
  const s = t.recordGame(m.id, 1, [0, 0], true)!;
  assert.equal(s.decided, true);
});

// ---------- table: same table, same seats between games ----------

const T = (over: Partial<Timings> = {}): Timings =>
  ({ botDelayMs: 0, trickPauseMs: 0, handPauseMs: 0, emptyTableTtlMs: 60000, abandonMs: 60, matchEndPauseMs: 40, seatHoldMs: 60000, ...over });

test('table: after a game that does not decide the series, the next game starts at the same table with the same bots', async () => {
  const events: any[] = [];
  const shots: any[] = [];
  let wins: [number, number] = [0, 0];
  const hooks: TableHooks = {
    send() {}, changed() {}, destroyed() {}, released() {},
    gameEnded: (tb, w, _s, forfeit) => { queueMicrotask(() => shots.push({ v: tb.view('x'), names: tb.seats.map((s) => s.name) })); if (!forfeit) wins[w]++; const decided = forfeit || Math.max(...wins) >= 2; return { wins: [...wins] as [number, number], need: 2, decided, game: wins[0] + wins[1] + (decided ? 0 : 1) }; },
    matchOver: (_t, winner) => events.push(['over', winner]),
  };
  const table = new Table({ id: 'ab12cd34', code: 'ABCDE', isPublic: false, target: 50, hostId: null, timings: T(), hooks, rng: mulberry32(9), tournament: { id: 'x', matchId: 'r0m0', label: 'Semifinals' } });
  [0, 1, 2, 3].forEach((i) => table.seatBot(i));
  const names = table.seats.map((s) => s.name);
  table.fastForward = true;
  table.startGame();
  const deadline = Date.now() + 20000;
  while (!events.length && Date.now() < deadline) await sleep(5);
  const between = shots.filter((x) => x.v.phase === 'finished' && x.v.series && !x.v.series.decided);
  for (const x of between) assert.deepEqual(x.names, names);
  assert.equal(shots.length, wins[0] + wins[1]);
  assert.ok(between.length >= 1, 'a between-games game-over with the series score was shown');
  assert.equal(events.length, 1, 'matchOver once, when the series was decided');
  assert.equal(Math.max(...wins), 2);
  assert.equal(events[0][1], wins[0] === 2 ? 0 : 1);
  assert.deepEqual(table.seats.map((s) => s.name), names, 'bots kept their personas');
  table.dispose();
});

// ---------- server: a finished series bracket still closes and does not come back on reload ----------

test('server: a full series bracket finishes; the series scores are in the view; Close and reload still work', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const { c, welcome } = await connect(srv.port, 'Host');
    c.send({ t: 'devToggleSubscription' });
    await c.waitFor((m) => m.t === 'subscription');
    c.send({ t: 'createTournament', size: 4, isPublic: false });
    await c.waitFor((m) => m.t === 'tournament');
    autoPlay(c);
    c.send({ t: 'startTournament' });
    const between = await c.waitFor((m) => m.t === 'table' && m.phase === 'finished' && m.series, 60000, true);
    assert.ok(between.series.need >= 2);
    const done = await c.waitFor((m) => m.t === 'tournament' && m.state === 'finished', 90000, true);
    for (const r of done.rounds) for (const m of r.matches) assert.equal(Math.max(...m.wins), m.need);
    assert.equal(done.rounds[1].matches[0].need, 3);
    await sleep(300);
    c.send({ t: 'leaveTournament' });
    await c.waitFor((m) => m.t === 'tournamentLeft', 5000, true);
    c.close();
    const r = await connect(srv.port, 'Host', welcome.token);
    await sleep(300);
    assert.ok(!r.c.log.some((m: any) => m.t === 'tournament'), 'not restored');
    r.c.send({ t: 'createTournament', size: 4, isPublic: false });
    await r.c.waitFor((m) => m.t === 'tournament' && m.state === 'registering', 5000, true);
    r.c.close();
  } finally { await srv.close(); }
});
