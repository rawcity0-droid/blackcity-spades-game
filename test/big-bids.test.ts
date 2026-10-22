// "Big bids" (Premium hosts): a team contract of exactly 10 made scores 200; a 13 (Boston) made wins the game at once.
// Missing either is a normal set. Nothing else changes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32, newDeck, suitOf } from '../src/engine/cards.js';
import { createGame, legalPlays, nextHand, placeBid, playCard, scoreTeam, GameOptions, GameState } from '../src/engine/game.js';
import { parseClientMessage } from '../src/server/protocol.js';
import { connect, connectPremium, testServer } from './helpers.js';

// Strongest trumps first (Jokers mode adds the two jokers and moves the 2 of spades up).
const TRUMP_ORDER = ['BS', 'LS', 'DS', 'AS', 'KS', 'QS', 'JS', 'TS', '9S', '8S', '7S', '6S', '5S', '4S', '3S', '2S'];

/** Give `strong` the 13 best trumps (that seat wins every trick) and deal the rest to the others. */
function rig(g: GameState, strong: number): void {
  const deck = newDeck(g.jokers);
  const top = deck.filter((c) => suitOf(c) === 'S').sort((a, b) => TRUMP_ORDER.indexOf(a) - TRUMP_ORDER.indexOf(b)).slice(0, 13);
  const rest = deck.filter((c) => !top.includes(c));
  g.hands = [0, 1, 2, 3].map((s) => (s === strong ? top : rest.splice(0, 13)));
}

/** Rig the deal, have team 0 bid `a` + `b` (team 1 bids 2 + 2), and play the hand out. */
function hand(opts: GameOptions, strong: number, a: number, b: number): GameState {
  const g = createGame({ target: 500, rng: mulberry32(3), dealer: 3, ...opts });
  rig(g, strong);
  while (g.phase === 'bidding') placeBid(g, g.turn, g.turn === 0 ? a : g.turn === 2 ? b : 2);
  while (g.phase === 'playing') playCard(g, g.turn, legalPlays(g, g.turn)[0]);
  return g;
}

test('10 made scores 200 for the contract; bags still count', () => {
  const g = hand({ bigBids: true }, 0, 6, 4);
  const t = g.lastHand!.teams[0];
  assert.equal(t.tricks, 13);
  assert.equal(t.contractPoints, 200);
  assert.equal(t.bagsGained, 3);
  assert.equal(g.scores[0], 203);
  assert.equal(g.phase, 'handOver');
  assert.equal(scoreTeam([0, 2], [6, 0, 4, 0], [7, 0, 3, 0], 0, true, true, 0, true).result.contractPoints, 200);
  assert.equal(scoreTeam([0, 2], [6, 0, 5, 0], [7, 0, 4, 0], 0, true, true, 0, true).result.contractPoints, 110); // 11 is normal
});

test('10 missed is a normal set', () => {
  const g = hand({ bigBids: true }, 1, 5, 5);
  assert.equal(g.lastHand!.teams[0].made, false);
  assert.equal(g.lastHand!.teams[0].contractPoints, -100);
  assert.equal(g.scores[0], -100);
});

test('Boston: 13 made wins the game at once, whatever the score', () => {
  const g = hand({ bigBids: true }, 0, 7, 6);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, 0);
  assert.equal(g.endReason, 'boston');
  assert.ok(g.scores[0] < 500);
});

test('Boston missed is a normal set and play goes on', () => {
  const g = hand({ bigBids: true }, 1, 7, 6);
  assert.equal(g.lastHand!.teams[0].made, false);
  assert.equal(g.scores[0], -130);
  assert.equal(g.phase, 'handOver');
  assert.equal(g.winner, null);
});

test('with the toggle off nothing changes: 10 = 100, 13 made just scores', () => {
  const g = hand({}, 0, 6, 4);
  assert.equal(g.lastHand!.teams[0].contractPoints, 100);
  const b = hand({}, 0, 7, 6);
  assert.equal(b.lastHand!.teams[0].contractPoints, 130);
  assert.equal(b.phase, 'handOver');
  assert.equal(b.endReason, null);
});

test('works with Team min 4, Jokers and 2 sets and out', () => {
  for (const o of [{ teamMin: 4 }, { jokers: true }, { setsOut: true }, { jokers: true, setsOut: true }] as GameOptions[]) {
    const ten = hand({ bigBids: true, ...o }, 0, 6, 4);
    assert.equal(ten.lastHand!.teams[0].contractPoints, 200, JSON.stringify(o));
    const boston = hand({ bigBids: true, ...o }, 0, 13, 0);
    assert.equal(boston.endReason, 'boston', JSON.stringify(o));
    assert.equal(boston.winner, 0);
  }
  // 2 sets and out: a missed Boston counts as a set; the second set still ends the game
  const g = hand({ bigBids: true, setsOut: true, teamMin: 4 }, 1, 13, 0);
  assert.deepEqual(g.sets, [1, 0]);
  nextHand(g);
  rig(g, 1);
  while (g.phase === 'bidding') placeBid(g, g.turn, g.turn === 0 ? 13 : 2);
  while (g.phase === 'playing') playCard(g, g.turn, legalPlays(g, g.turn)[0]);
  assert.equal(g.endReason, 'sets');
  assert.equal(g.winner, 1);
});

test('protocol: bigBids must be a boolean', () => {
  assert.ok('error' in parseClientMessage(JSON.stringify({ t: 'setRules', bigBids: 'yes' })));
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: 'setRules', bigBids: true })), { msg: { t: 'setRules', target: undefined, breakRule: undefined, sandbags: undefined, teamMin4: undefined, jokers: undefined, isPublic: undefined, setsOut: undefined, bigBids: true } });
});

test('gating: a Premium host can turn it on; a free player cannot, anywhere', async () => {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c: host } = await connectPremium(srv.port, 'Host');
    host.send({ t: 'createTable', isPublic: false, target: 500 });
    await host.waitFor((m) => m.t === 'table');
    host.send({ t: 'setRules', bigBids: true });
    await host.waitFor((m) => m.t === 'table' && m.rules.bigBids === true);
    host.send({ t: 'setRules', bigBids: false });
    await host.waitFor((m) => m.t === 'table' && m.rules.bigBids === false);

    const { c: free } = await connect(srv.port, 'Free');
    free.send({ t: 'createFriend' });
    await free.waitFor((m) => m.t === 'table' && m.friend);
    free.send({ t: 'setRules', bigBids: true });
    assert.equal((await free.waitFor((m) => m.t === 'error')).code, 'upgrade_required');
    free.send({ t: 'leaveTable' }); await free.waitFor((m) => m.t === 'left');
    free.send({ t: 'createTable', isPublic: true, target: 250, practice: true, bigBids: true });
    await free.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required');
    free.send({ t: 'createTournament', size: 4, isPublic: false, bigBids: true });
    await free.waitFor((m) => m.t === 'error' && m.code === 'upgrade_required');

    host.send({ t: 'leaveTable' }); await host.waitFor((m) => m.t === 'left');
    host.send({ t: 'createTournament', size: 4, isPublic: false, bigBids: true });
    assert.equal((await host.waitFor((m) => m.t === 'tournament')).bigBids, true);
    host.send({ t: 'startTournament' });
    const tbl = await host.waitFor((m) => m.t === 'table' && m.tournament);
    assert.equal(tbl.rules.bigBids, true);
    host.close(); free.close();
  } finally { await srv.close(); }
});
