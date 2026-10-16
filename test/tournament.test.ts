// Tournament tests: bracket logic, rules from the brief, forfeits/absence at tournament tables,
// reconnect rule, and a full tournament through the server.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIG } from '../src/config.js';
import { mulberry32 } from '../src/engine/cards.js';
import { Table, TableHooks, Timings } from '../src/server/table.js';
import { Match, Tournament, TournamentHost, roundName } from '../src/server/tournament.js';
import { autoPlay, connect, sleep, testServer } from './helpers.js';

function botHost(): TournamentHost & { tables: Match[] } {
  const tables: Match[] = [];
  return { tables, createMatchTable: (_t, m) => { tables.push(m); return { id: 'tbl' + tables.length, code: 'CODE' + tables.length }; }, changed() {} };
}

function allBots(size: number, seed: number): Tournament {
  const t = new Tournament({ id: 'a', code: 'ABCDE', size, organizerId: 'org', isPublic: true, host: botHost(), rng: mulberry32(seed) });
  assert.equal(t.start('org').ok, true);
  return t;
}

for (const size of [4, 8, 16]) {
  test(`bracket of ${size} bot teams completes automatically with a champion and runner-up`, () => {
    const t = allBots(size, size);
    assert.equal(t.state, 'finished');
    assert.equal(t.rounds.length, Math.log2(size));
    assert.deepEqual(t.rounds.map((r) => r.length), Array.from({ length: Math.log2(size) }, (_, i) => size / 2 ** (i + 1)));
    assert.ok(t.champion && t.runnerUp);
    assert.notEqual(t.champion!.id, t.runnerUp!.id);
    const wins = new Map<number, number>();
    for (const r of t.rounds) for (const m of r) {
      assert.equal(m.status, 'done');
      assert.ok(m.simulated);
      const [w, l] = [m.score![m.winner!], m.score![1 - m.winner!]];
      assert.ok(w >= m.target || l <= CONFIG.loseScore, `match ${m.id}: ${w}-${l} target ${m.target}`);
      assert.ok(w > l);
      const winner = m.teams[m.winner!]!;
      wins.set(winner.id, (wins.get(winner.id) ?? 0) + 1);
    }
    assert.equal(wins.get(t.champion!.id), Math.log2(size)); // champion won every round
    assert.equal(t.rounds.flat().length, size - 1); // single elimination: every team but one loses exactly once
    // the winner of each match is the team that appears in the next round
    for (let r = 0; r < t.rounds.length - 1; r++) for (const m of t.rounds[r]) {
      const next = t.rounds[r + 1][m.index >> 1];
      assert.equal(next.teams[m.index & 1]!.id, m.teams[m.winner!]!.id);
    }
    const v = t.view('org') as any;
    assert.equal(v.champion.id, t.champion!.id);
    assert.equal(v.runnerUp.id, t.runnerUp!.id);
  });
}

test('match targets: early rounds use the early target and the final uses the final target (config)', () => {
  const t = allBots(8, 3);
  assert.deepEqual(t.rounds.map((r) => r[0].target), [CONFIG.tournamentTargetEarly, CONFIG.tournamentTargetEarly, CONFIG.tournamentTargetFinal]);
  assert.equal(CONFIG.tournamentTargetEarly, 250);
  assert.equal(CONFIG.tournamentTargetFinal, 500);
});

test('seeding is random: different seeds give different first-round pairings', () => {
  const order = (seed: number) => {
    const t = new Tournament({ id: 'a', code: 'ABCDE', size: 8, organizerId: 'o', isPublic: true, host: botHost(), rng: mulberry32(seed) });
    t.start('o');
    return t.rounds[0].flatMap((m) => m.teams.map((x) => x!.name)).join('|');
  };
  const orders = new Set([1, 2, 3, 4, 5].map(order));
  assert.ok(orders.size > 1);
  assert.equal(order(9), order(9)); // but deterministic for one seed
});

test('only the organizer can start; registration limits and solo pairing', () => {
  const host = botHost();
  const t = new Tournament({ id: 'a', code: 'ABCDE', size: 4, organizerId: 'org', isPublic: true, host, rng: mulberry32(1) });
  for (const [id, n] of [['org', 'Org'], ['b', 'Bea'], ['c', 'Cy']]) assert.equal(t.join(id, n).ok, true);
  const bad = t.start('b');
  assert.equal(bad.ok, false);
  assert.equal((bad as any).code, 'not_allowed');
  assert.equal(t.state, 'registering');
  t.start('org');
  const names = t.rounds[0].flatMap((m) => m.teams.map((x) => x!.name));
  assert.ok(names.includes('Org & Bea'), 'first two solo joiners are paired together');
  assert.ok(names.includes('Cy & Bot'), 'leftover solo gets a bot partner');
  assert.equal(names.filter((n) => n.startsWith('Bot Team')).length, 2, 'unfilled slots become bot teams');
  assert.ok(host.tables.length >= 1); // human matches are played at real tables
  assert.equal(t.join('late', 'Late').ok, false); // registration closed

  const full = new Tournament({ id: 'b', code: 'ABCDF', size: 4, organizerId: 'o', isPublic: true, host: botHost() });
  for (let i = 0; i < 8; i++) assert.equal(full.join('p' + i, 'P' + i).ok, true);
  assert.equal((full.join('p9', 'P9') as any).code, 'full');
});

test('human matches wait for a table result, then winners advance automatically', () => {
  const host = botHost();
  const t = new Tournament({ id: 'a', code: 'ABCDE', size: 4, organizerId: 'org', isPublic: true, host, rng: mulberry32(11) });
  t.join('org', 'Org');
  t.start('org');
  assert.equal(t.state, 'running');
  assert.equal(host.tables.length, 1); // org's match is live; the other first-round match was simulated
  const live = host.tables[0];
  assert.equal(live.status, 'live');
  assert.ok(live.tableId);
  t.matchResult(live.id, 0, [260, 100]);
  // advancing may open the final at a table if team 0 holds the human; either way the bracket progressed
  assert.equal(live.status, 'done');
  const final = t.rounds[1][0];
  assert.ok(final.teams[0] && final.teams[1]);
  if (final.status === 'live') {
    t.matchResult(final.id, 1, [200, 510]);
  }
  assert.equal(t.state, 'finished');
  assert.equal(final.target, 500);
  assert.ok(t.champion && t.runnerUp);
});

test('a human who leaves a running tournament becomes a bot in unplayed matches', () => {
  const t = new Tournament({ id: 'a', code: 'ABCDE', size: 4, organizerId: 'org', isPublic: true, host: botHost(), rng: mulberry32(2) });
  t.join('org', 'Org');
  t.join('x', 'Xan');
  t.start('org');
  t.leave('x');
  const slots = t.rounds.flat().flatMap((m) => m.teams).flatMap((tm) => tm?.slots ?? []);
  const unplayed = t.rounds.flat().filter((m) => m.status === 'waiting');
  const stillX = unplayed.flatMap((m) => m.teams).flatMap((tm) => tm?.slots ?? []).filter((s) => s.playerId === 'x');
  assert.equal(stillX.length, 0);
  assert.ok(slots.length > 0);
});

test('a human who leaves during their LIVE match is not pulled into the next round when their team advances', () => {
  const host = botHost();
  const t = new Tournament({ id: 'a', code: 'ABCDE', size: 4, organizerId: 'org', isPublic: true, host, rng: mulberry32(11) });
  t.join('org', 'Org');
  t.start('org');
  const live = host.tables[0];
  assert.equal(live.status, 'live');
  t.leave('org'); // leaves while the match is live (the table keeps going with a bot)
  const orgSide = live.teams.findIndex((tm) => tm?.slots.some((s) => s.name === 'Org' || s.playerId === 'org'));
  assert.equal(orgSide, -1); // no slot of the match refers to the player any more
  t.matchResult(live.id, 0, [260, 100]);
  assert.equal(host.tables.length, 1); // the final had no humans, so it was simulated and no new table was opened
  assert.equal(t.state, 'finished');
});

test('roundName labels', () => {
  assert.equal(roundName(16, 0), 'Round of 16');
  assert.equal(roundName(8, 0), 'Quarterfinals');
  assert.equal(roundName(8, 1), 'Semifinals');
  assert.equal(roundName(8, 2), 'Final');
});

// ---------- table-level rules for tournament matches ----------

const T = (over: Partial<Timings> = {}): Timings =>
  ({ botDelayMs: 0, trickPauseMs: 0, handPauseMs: 0, emptyTableTtlMs: 60000, abandonMs: 60, matchEndPauseMs: 0, seatHoldMs: 60000, ...over });

function matchTable(timings = T()) {
  const events: any[] = [];
  const hooks: TableHooks = {
    send() {}, changed() {}, destroyed: () => events.push(['destroyed']), released() {},
    matchOver: (_t, winner, scores, forfeit) => events.push(['over', winner, scores, forfeit]),
  };
  const table = new Table({ id: 'ab12cd34', code: 'ABCDE', isPublic: false, target: 250, hostId: null, timings, hooks, rng: mulberry32(5), tournament: { id: 'x', matchId: 'r0m0', label: 'Final' } });
  return { table, events };
}

test('if a whole human team leaves, the other team advances', async () => {
  const { table, events } = matchTable(T({ botDelayMs: 50 }));
  table.seatHuman(0, 'a', 'A', true);
  table.seatHuman(2, 'b', 'B', true);
  table.seatHuman(1, 'c', 'C', true);
  table.seatBot(3);
  table.startGame();
  table.leave('a');
  assert.equal(events.length, 0); // partner still there
  table.leave('b');
  await sleep(30);
  assert.deepEqual(events.map((e) => e[0]), ['over']);
  assert.equal(events[0][1], 1); // team 1 (C & bot) advances
  assert.equal(events[0][3], true); // forfeit
  assert.equal(table.status, 'finished');
  table.dispose();
});

test('a team whose humans are all disconnected for the abandon period forfeits', async () => {
  const { table, events } = matchTable(T({ botDelayMs: 50, abandonMs: 60 }));
  table.seatHuman(0, 'a', 'A', true);
  table.seatHuman(1, 'c', 'C', true);
  table.seatBot(2);
  table.seatBot(3);
  table.startGame();
  table.setConnected('a', false);
  await sleep(30);
  assert.equal(events.length, 0); // grace period
  await sleep(120);
  assert.equal(events.length, 1);
  assert.equal(events[0][1], 1);
  assert.equal(events[0][3], true);
  table.dispose();
});

test('a quick reconnect inside the grace period cancels the forfeit', async () => {
  const { table, events } = matchTable(T({ botDelayMs: 50, abandonMs: 80 }));
  table.seatHuman(0, 'a', 'A', true);
  table.seatHuman(1, 'c', 'C', true);
  table.seatBot(2);
  table.seatBot(3);
  table.startGame();
  table.setConnected('a', false);
  await sleep(30);
  table.setConnected('a', true);
  await sleep(150);
  assert.equal(events.length, 0);
  table.dispose();
});

test('if nobody is connected the match is fast-forwarded by bots and a winner reported', async () => {
  const { table, events } = matchTable(T({ abandonMs: 30 }));
  table.seatHuman(0, 'a', 'A', true);
  table.seatHuman(1, 'c', 'C', true);
  table.seatBot(2);
  table.seatBot(3);
  table.startGame();
  table.setConnected('a', false);
  table.setConnected('c', false);
  for (let i = 0; i < 100 && events.length === 0; i++) await sleep(20);
  assert.equal(events.length, 1);
  assert.equal(events[0][3], false); // played out, not a forfeit
  const [w, l] = [events[0][2][events[0][1]], events[0][2][1 - events[0][1]]];
  assert.ok(w >= 250 || l <= -200);
  table.dispose();
});

test('a dropped seat is taken by a bot immediately and retaken at the next hand', async () => {
  const hooks: TableHooks = { send() {}, changed() {}, destroyed() {}, released() {} };
  const table = new Table({ id: 'ab12cd34', code: 'ABCDE', isPublic: true, target: 500, hostId: 'a', timings: T({ botDelayMs: 4, handPauseMs: 80 }), hooks, rng: mulberry32(8) });
  try {
    table.seatHuman(0, 'a', 'A', true);
    table.seatHuman(1, 'b', 'B', true); // a second connected human keeps the table running; keep B bot-driven for the test
    table.seats[1].botControlled = true;
    table.startGame();
    const g = table.game!;
    const hand1 = g.handNo;
    table.setConnected('a', false);
    assert.equal((table.view('a') as any).botControlled, true); // bot plays right away
    for (let i = 0; i < 400 && !table.seats[0].botActed; i++) await sleep(2);
    assert.equal(table.seats[0].botActed, true);
    table.setConnected('a', true);
    const mid = table.view('a') as any;
    assert.equal(mid.botControlled, true, 'still bot-controlled for the rest of this hand');
    assert.deepEqual(mid.legal, []);
    assert.equal(table.play('a', 'AS').ok, false);
    for (let i = 0; i < 600 && g.handNo === hand1; i++) await sleep(5);
    assert.equal(g.handNo, hand1 + 1);
    assert.equal((table.view('a') as any).botControlled, false, 'seat retaken at the start of the next hand');
  } finally { table.dispose(); }
});

test('a quick refresh before any bot acted retakes the seat immediately', async () => {
  const hooks: TableHooks = { send() {}, changed() {}, destroyed() {}, released() {} };
  const table = new Table({ id: 'ab12cd34', code: 'ABCDE', isPublic: true, target: 500, hostId: 'a', timings: T({ botDelayMs: 100 }), hooks, rng: mulberry32(4) });
  table.seatHuman(0, 'a', 'A', true);
  table.startGame();
  table.setConnected('a', false);
  table.setConnected('a', true);
  assert.equal((table.view('a') as any).botControlled, false);
  table.dispose();
});

// ---------- full tournament through the server ----------

test('server: organizer creates a 4-team tournament, only the organizer can start, it runs to a champion', async () => {
  const srv = await testServer({ devUnlock: true });
  try {
    const org = (await connect(srv.port, 'Org')).c;
    org.send({ t: 'devToggleSubscription' });
    await org.waitFor((m) => m.t === 'subscription');
    org.send({ t: 'createTournament', size: 4, isPublic: true });
    const reg = await org.waitFor((m) => m.t === 'tournament');
    assert.equal(reg.state, 'registering');

    const joiner = (await connect(srv.port, 'Joe')).c;
    joiner.send({ t: 'joinCode', code: reg.code });
    const jv = await joiner.waitFor((m) => m.t === 'tournament' && m.joined === true);
    assert.equal(jv.isOrganizer, false);
    joiner.send({ t: 'startTournament' });
    assert.equal((await joiner.waitFor((m) => m.t === 'error')).code, 'not_allowed');

    // a free user can join, but cannot host
    joiner.send({ t: 'leaveTournament' });
    await joiner.waitFor((m) => m.t === 'tournamentLeft');
    joiner.send({ t: 'createTournament', size: 4, isPublic: true });
    await joiner.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required');

    autoPlay(org);
    org.send({ t: 'startTournament' });
    const done = await org.waitFor((m) => m.t === 'tournament' && m.state === 'finished', 30000);
    assert.ok(done.champion && done.runnerUp);
    assert.equal(done.rounds.length, 2);
    assert.equal(done.rounds[1].matches[0].status, 'done');
    // organizer ends back in the lobby (no table)
    await org.waitFor((m) => m.t === 'left', 2000, true);
  } finally { await srv.close(); }
});
