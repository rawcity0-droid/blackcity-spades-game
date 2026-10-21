// "2 sets and out": a team set (books contract failed) for the 2nd time in a game loses at once.
// A failed Nil alone is not a set. Premium only; Play now / Play with a friend stay Regular; every game of a series starts fresh.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/engine/cards.js';
import { createGame, legalPlays, nextHand, placeBid, playCard, setsWinner, GameState } from '../src/engine/game.js';
import { parseClientMessage } from '../src/server/protocol.js';
import { connect, connectPremium, testServer } from './helpers.js';

/** Team 0 bids 7 + 7 (14 books cannot be made: always set); team 1 bids Nil + 1. */
function playHand(g: GameState): void {
  while (g.phase === 'bidding') placeBid(g, g.turn, g.turn % 2 === 0 ? 7 : g.turn === 1 ? 0 : 1);
  while (g.phase === 'playing') playCard(g, g.turn, legalPlays(g, g.turn)[0]);
}

test('engine: the 2nd set ends the game at once and the other team wins; failed Nils do not count', () => {
  const g = createGame({ target: 500, rng: mulberry32(7), setsOut: true });
  playHand(g);
  const h = g.lastHand!;
  assert.equal(h.teams[1].made, true, 'seed: team 1 makes its 1');
  assert.equal(h.teams[1].nil[0].made, false, 'seed: the Nil failed');
  assert.deepEqual(g.sets, [1, 0]); // the failed Nil was not a set
  assert.equal(g.phase, 'handOver');
  nextHand(g);
  playHand(g);
  assert.equal(g.sets[0], 2);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, 1);
  assert.equal(g.endReason, 'sets');
});

test('engine: Regular set rule keeps playing after two sets', () => {
  const g = createGame({ target: 500, rng: mulberry32(7) });
  playHand(g); nextHand(g); playHand(g);
  assert.equal(g.sets[0], 2);
  assert.notEqual(g.endReason, 'sets'); // only the score rules can end it
});

test('engine: both set twice on the same hand -> higher score wins; tie plays on', () => {
  assert.equal(setsWinner({ setsOut: true, sets: [2, 2], scores: [100, 50] }), 0);
  assert.equal(setsWinner({ setsOut: true, sets: [2, 2], scores: [50, 50] }), null);
  assert.equal(setsWinner({ setsOut: true, sets: [1, 2], scores: [0, 300] }), 0);
  assert.equal(setsWinner({ setsOut: false, sets: [0, 5], scores: [0, 0] }), null);
});

test('engine: Team min 4 and Jokers count a set when the board contract fails', () => {
  for (const opts of [{ teamMin: 4 }, { jokers: true }]) {
    const g = createGame({ target: 500, rng: mulberry32(3), setsOut: true, ...opts });
    while (g.phase === 'bidding') placeBid(g, g.turn, g.turn % 2 === 0 ? 13 : 0); // team 1: 0 + 0 -> board 4
    while (g.phase === 'playing') playCard(g, g.turn, legalPlays(g, g.turn)[0]);
    const h = g.lastHand!;
    assert.equal(g.sets[0], 1);
    assert.equal(g.sets[1], h.teams[1].made === false ? 1 : 0);
  }
});

test('protocol: setsOut must be a boolean', () => {
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'setRules', setsOut: 'yes' })));
  assert.equal((parseClientMessage(JSON.stringify({ t: 'setRules', setsOut: true })) as any).msg.setsOut, true);
  assert.equal((parseClientMessage(JSON.stringify({ t: 'createTournament', size: 4, isPublic: false, setsOut: true })) as any).msg.setsOut, true);
});

test('gating: Premium table chip works; Play with a friend refuses; free players cannot create it; bracket tables get it', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c: host } = await connectPremium(srv.port, 'Host');
    host.send({ t: 'createTable', isPublic: false, target: 500 });
    await host.waitFor((m) => m.t === 'table');
    host.send({ t: 'setRules', setsOut: true });
    const v = await host.waitFor((m) => m.t === 'table' && m.rules.setsOut === true);
    assert.deepEqual(v.sets, [0, 0]);
    host.send({ t: 'leaveTable' }); await host.waitFor((m) => m.t === 'left');

    const { c: free } = await connect(srv.port, 'Free');
    free.send({ t: 'createFriend' });
    await free.waitFor((m) => m.t === 'table' && m.friend);
    free.send({ t: 'setRules', setsOut: true });
    assert.equal((await free.waitFor((m) => m.t === 'error')).code, 'not_allowed');
    free.send({ t: 'leaveTable' }); await free.waitFor((m) => m.t === 'left');
    free.send({ t: 'createTournament', size: 4, isPublic: false, setsOut: true });
    assert.equal((await free.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required')).code, 'upgrade_required');

    host.send({ t: 'createTournament', size: 4, isPublic: false, setsOut: true });
    const tv = await host.waitFor((m) => m.t === 'tournament');
    assert.equal(tv.setsOut, true);
    host.send({ t: 'editTournament', setsOut: false });
    await host.waitFor((m) => m.t === 'tournament' && m.setsOut === false);
    host.send({ t: 'editTournament', setsOut: true });
    await host.waitFor((m) => m.t === 'tournament' && m.setsOut === true);
    host.send({ t: 'startTournament' });
    const tbl = await host.waitFor((m) => m.t === 'table' && m.tournament);
    assert.equal(tbl.rules.setsOut, true); // each game of the series is a new game: sets start at 0
    assert.deepEqual(tbl.sets, [0, 0]);
    host.close(); free.close();
  } finally { await srv.close(); }
});
