// Engine tests: deck, rules, trick winner, scoring, game end/tie, bot legality, bot-vs-bot games.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseBid, choosePlay } from '../src/engine/bot.js';
import { RANKS, mulberry32, newDeck, rankOf, shuffle, suitOf, dealHands } from '../src/engine/cards.js';
import {
  EngineError, GameState, createGame, legalBids, gameWinner, legalPlays, nextHand, placeBid, playCard, scoreTeam, trickWinner,
} from '../src/engine/game.js';
import { CONFIG } from '../src/config.js';
import { botStep, simulateGame } from '../src/engine/sim.js';

/** Game in the playing phase with given hands; seat 1 leads (dealer 0). */
function playing(hands: string[][], bids = [4, 4, 4, 4], target = 500): GameState {
  const g = createGame({ target, rng: mulberry32(1), dealer: 0 });
  g.hands = hands.map((h) => h.slice());
  for (let s = 0; s < 4; s++) placeBid(g, g.turn, bids[g.turn]);
  assert.equal(g.phase, 'playing');
  return g;
}

test('deck has 52 unique cards, 13 per suit', () => {
  const d = newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  for (const s of 'SHDC') assert.equal(d.filter((c) => suitOf(c) === s).length, 13);
  assert.equal(RANKS.length, 13);
});

test('seeded shuffle is deterministic, a permutation, and differs by seed', () => {
  const a = shuffle(newDeck(), mulberry32(42));
  const b = shuffle(newDeck(), mulberry32(42));
  const c = shuffle(newDeck(), mulberry32(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(a.slice().sort(), newDeck().sort());
});

test('dealHands gives 4 hands of 13 covering the deck', () => {
  const hands = dealHands(mulberry32(7));
  assert.deepEqual(hands.map((h) => h.length), [13, 13, 13, 13]);
  assert.deepEqual(hands.flat().sort(), newDeck().sort());
});

test('regular bidding (free games): 1 to 13 plus Nil, no minimum; order is left of dealer', () => {
  const g = createGame({ rng: mulberry32(2), dealer: 0 });
  assert.equal(g.teamMin, 0);
  assert.equal(g.turn, 1);
  assert.deepEqual(legalBids(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  for (const bad of [14, -1, 2.5, NaN]) assert.throws(() => placeBid(g, 1, bad), EngineError, `bid ${bad} must be rejected`);
  assert.throws(() => placeBid(g, 1, 14), /Bid must be 1 to 13/);
  assert.throws(() => placeBid(g, 2, 4), EngineError); // not seat 2's turn
  placeBid(g, 1, 0); // Nil is allowed (CONFIG.rules.allowNil)
  placeBid(g, 2, 13);
  placeBid(g, 3, 1);
  assert.equal(g.phase, 'bidding');
  placeBid(g, 0, 1); // partners 0 and 2 bid 1 and 13; partners 1 and 3 bid Nil and 1: nothing limits a team's total
  assert.equal(g.phase, 'playing');
  assert.equal(g.turn, 1);
  assert.deepEqual(g.bids, [1, 0, 13, 1]);
});

test('Premium team rule: partners must bid at least 4 together, any split, and the second to bid cannot go below what is needed', () => {
  const g = createGame({ rng: mulberry32(2), dealer: 0, teamMin: 4 });
  assert.equal(g.turn, 1);
  // the first player of a team is free: 1, 2, 3 are fine
  assert.deepEqual(legalBids(g, 1), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  placeBid(g, 1, 1);
  placeBid(g, 2, 13); // seat 2 bids first for the other team: free
  // seat 3 is the partner of seat 1 (who bid 1): needs at least 3, and Nil is closed
  assert.deepEqual(legalBids(g, 3), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.throws(() => placeBid(g, 3, 2), /at least 4 together, so bid 3 or more/);
  assert.throws(() => placeBid(g, 3, 0), /bid 3 or more/);
  placeBid(g, 3, 3);
  // seat 0 is the partner of seat 2 (13): any bid is fine, Nil included
  assert.deepEqual(legalBids(g, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  placeBid(g, 0, 0);
  assert.equal(g.phase, 'playing');
});

test('Premium team rule: 2 and 2, 1 and 3, Nil needs a full 4 from the partner, and a partner Nil means the other bids 4+', () => {
  const pair = (first: number, second: number) => {
    const g = createGame({ rng: mulberry32(5), dealer: 0, teamMin: 4 });
    placeBid(g, 1, first); placeBid(g, 2, 4); // seat 1 first, seat 3 is its partner
    placeBid(g, 3, second);
    return g;
  };
  assert.equal(pair(2, 2).phase, 'bidding');
  assert.equal(pair(1, 3).bids[3], 3);
  assert.equal(pair(3, 1).bids[3], 1);
  assert.equal(pair(4, 0).bids[3], 0, 'after a 4 the partner may go Nil');
  assert.throws(() => pair(3, 0), EngineError, 'after a 3 Nil is closed');
  assert.throws(() => pair(0, 3), EngineError, 'after a Nil the partner must bid 4');
  assert.equal(pair(0, 4).bids[3], 4);
});

test('with allowNil off even 0 is rejected, and bots follow the team rule', () => {
  const saved = CONFIG.rules.allowNil;
  CONFIG.rules.allowNil = false;
  try {
    const h = createGame({ rng: mulberry32(3), dealer: 0 });
    assert.deepEqual(legalBids(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.throws(() => placeBid(h, 1, 0), /Bid must be 1 to 13$/);
    placeBid(h, 1, 1);
  } finally { CONFIG.rules.allowNil = saved; }
  for (let seed = 1; seed <= 300; seed++) {
    for (const teamMin of [0, 4]) {
      const x = createGame({ rng: mulberry32(seed), dealer: seed % 4, teamMin });
      while (x.phase === 'bidding') { const b = chooseBid(x, x.turn); assert.ok(legalBids(x, x.turn).includes(b), `bot bid ${b}`); placeBid(x, x.turn, b); }
      if (teamMin) for (const [a, b] of [[0, 2], [1, 3]]) assert.ok(x.bids[a]! + x.bids[b]! >= 4, `team total ${x.bids[a]! + x.bids[b]!} (seed ${seed})`);
    }
  }
});

test('must follow suit when able; any card when void', () => {
  const g = playing([
    ['2C', '3C', 'AS', 'KH', '4D'], // seat 0
    ['AH', '5C', '6D', '7D', '8D'], // seat 1 leads
    ['3H', '9C', '9D', '2S', '2D'],
    ['4H', '4C', '5D', '6S', '7S'],
  ].map((h) => h.concat(Array(8).fill('')).slice(0, 5)).map((h) => h.filter(Boolean)));
  playCard(g, 1, 'AH');
  assert.deepEqual(legalPlays(g, 2), ['3H']); // seat 2 holds one heart
  playCard(g, 2, '3H');
  assert.deepEqual(legalPlays(g, 3).sort(), ['4H']);
  playCard(g, 3, '4H');
  // seat 0 has KH so must follow hearts
  assert.deepEqual(legalPlays(g, 0), ['KH']);
  assert.throws(() => playCard(g, 0, '2C'), EngineError);
  playCard(g, 0, 'KH');
  // trick winner is seat 1 (AH) and leads again
  assert.equal(g.turn, 1);
  assert.equal(g.tricksWon[1], 1);
  // seat 1 leads clubs; seat 2 is void in clubs? seat 2 has 9C -> must follow
  playCard(g, 1, '5C');
  assert.deepEqual(legalPlays(g, 2), ['9C']);
  playCard(g, 2, '9C');
  assert.deepEqual(legalPlays(g, 3), ['4C']);
  playCard(g, 3, '4C');
  assert.deepEqual(legalPlays(g, 0).sort(), ['2C', '3C']);
});

test('void in the led suit: any card is legal and a spade breaks spades', () => {
  const g = playing([
    ['AS', '2H', '3H'],
    ['KD', '2D', '3D'],
    ['4D', '5D', '6D'],
    ['7D', '8D', '9D'],
  ]);
  assert.equal(g.spadesBroken, false);
  playCard(g, 1, 'KD');
  playCard(g, 2, '4D');
  playCard(g, 3, '7D');
  assert.deepEqual(legalPlays(g, 0).sort(), ['2H', '3H', 'AS'].sort()); // void in diamonds: anything
  playCard(g, 0, 'AS'); // trumps in
  assert.equal(g.spadesBroken, true);
  assert.equal(g.tricksWon[0], 1);
  assert.equal(g.turn, 0);
});

test('spades cannot be led until broken, unless the hand is only spades', () => {
  const g = playing([
    ['AS', 'KS', '2H'],
    ['3H', '3D', '3C'],
    ['4H', '4D', '4C'],
    ['5H', '5D', '5C'],
  ]);
  playCard(g, 1, '3H');
  playCard(g, 2, '4H');
  playCard(g, 3, '5H');
  playCard(g, 0, '2H'); // seat 0 must follow hearts; seat 1 (3H? no) -> winner is seat 3 (5H)
  assert.equal(g.turn, 3);
  assert.equal(g.spadesBroken, false);
  // seat 3 now leads a club/diamond; first test the restriction for a spade-holding leader:
  const h = playing([
    ['AS', '2H'],
    ['9S', '3D'],
    ['4D', '4C'],
    ['5D', '5C'],
  ]);
  assert.deepEqual(legalPlays(h, 1), ['3D']); // seat 1 leads; spades not allowed with a diamond in hand
  assert.throws(() => playCard(h, 1, '9S'), EngineError);
  const only = playing([['AS'], ['9S'], ['4S'], ['5S']].map((x) => x));
  assert.deepEqual(legalPlays(only, 1), ['9S']); // only spades: allowed
  playCard(only, 1, '9S');
  assert.equal(only.spadesBroken, true);
});

test('a spade discarded on a trick breaks spades, so the winner may then lead one', () => {
  const g = playing([
    ['2S', '9H', 'KH'],
    ['3C', '3D', '3H'],
    ['4C', '4D', '4H'],
    ['5C', '5D', '5H'],
  ]);
  playCard(g, 1, '3C');
  playCard(g, 2, '4C');
  playCard(g, 3, '5C');
  playCard(g, 0, '2S'); // void in clubs: discards a spade, which wins the trick
  assert.equal(g.spadesBroken, true);
  assert.equal(g.turn, 0);
  assert.deepEqual(legalPlays(g, 0), ['9H', 'KH']); // 2S is gone; hearts remain
  const h = playing([
    ['2S', '9S', 'KH'],
    ['3C', '3D', '3H'],
    ['4C', '4D', '4H'],
    ['5C', '5D', '5H'],
  ]);
  playCard(h, 1, '3C');
  playCard(h, 2, '4C');
  playCard(h, 3, '5C');
  playCard(h, 0, 'KH'); // discard a heart instead: spades stay locked
  assert.equal(h.spadesBroken, false);
  assert.equal(h.turn, 3);
});

test('trick winner: highest of lead suit, or highest spade', () => {
  assert.equal(trickWinner([{ seat: 0, card: 'KH' }, { seat: 1, card: 'AD' }, { seat: 2, card: 'QH' }, { seat: 3, card: '2H' }]), 0);
  assert.equal(trickWinner([{ seat: 0, card: 'KH' }, { seat: 1, card: '2S' }, { seat: 2, card: 'AH' }, { seat: 3, card: '3S' }]), 3);
  assert.equal(trickWinner([{ seat: 2, card: '5C' }, { seat: 3, card: 'AD' }, { seat: 0, card: '9C' }, { seat: 1, card: '3H' }]), 0);
  assert.equal(trickWinner([{ seat: 1, card: 'AS' }, { seat: 2, card: 'KS' }, { seat: 3, card: 'QS' }, { seat: 0, card: '2S' }]), 1);
});

// ---------- scoring ----------

const score = (bids: number[], tricks: number[], bags: [number, number] = [0, 0]) => ({
  t0: scoreTeam([0, 2], bids, tricks, bags[0]),
  t1: scoreTeam([1, 3], bids, tricks, bags[1]),
});

test('scoring: partners combine bids; made contract is 10 per bid trick plus 1 per bag', () => {
  const { t0, t1 } = score([3, 2, 4, 2], [4, 2, 4, 3]); // team0 bid 7 took 8; team1 bid 4 took 5
  assert.equal(t0.result.delta, 70 + 1);
  assert.equal(t0.bagsAfter, 1);
  assert.equal(t1.result.delta, 40 + 1);
  assert.equal(t0.result.made, true);
});

test('scoring: set contract loses 10 per bid trick, no bags', () => {
  const { t0 } = score([4, 3, 3, 3], [3, 3, 2, 5]); // team0 bid 7 took 5
  assert.equal(t0.result.made, false);
  assert.equal(t0.result.delta, -70);
  assert.equal(t0.bagsAfter, 0);
});

test('scoring: 10 bags costs 100 and resets bags by 10', () => {
  const { t0 } = score([3, 3, 3, 3], [5, 3, 4, 1], [8, 0]); // bid 6 took 9: +60 +3 bags, 8+3=11 -> penalty
  assert.equal(t0.result.bagPenalty, -100);
  assert.equal(t0.bagsAfter, 1);
  assert.equal(t0.result.delta, 60 + 3 - 100);
  const exact = score([3, 3, 3, 3], [4, 3, 3, 3], [9, 0]).t0; // bid 6 took 7: bags 9+1 = 10 -> penalty, 0 left
  assert.equal(exact.bagsAfter, 0);
  assert.equal(exact.result.bagPenalty, -100);
});

test('scoring: nil made is +100; nil failed is -100 and its tricks do not count toward the bid', () => {
  const made = score([0, 3, 4, 3], [0, 3, 6, 4]).t0; // nil made; partner bid 4 took 6 -> +40 +2 bags +100
  assert.equal(made.result.nilPoints, 100);
  assert.equal(made.result.bid, 4);
  assert.equal(made.result.delta, 100 + 40 + 2);
  const failed = score([0, 3, 4, 3], [2, 3, 4, 4]).t0; // nil bidder took 2: -100; partner took 4 = bid -> +40; 2 bags
  assert.equal(failed.result.nilPoints, -100);
  assert.equal(failed.result.made, true);
  assert.equal(failed.result.delta, -100 + 40 + 2);
  // partner took only 3 of bid 4 even though team total (3+2) >= bid: the nil tricks must not rescue the contract
  const notRescued = score([0, 3, 4, 3], [2, 3, 3, 5]).t0;
  assert.equal(notRescued.result.made, false);
  assert.equal(notRescued.result.contractPoints, -40);
});

test('scoring: double nil scores each bidder separately', () => {
  const r = score([0, 3, 0, 3], [0, 6, 1, 6]).t0;
  assert.equal(r.result.nil.length, 2);
  assert.equal(r.result.nilPoints, 0); // +100 and -100
  assert.equal(r.result.made, null);
});

test('full hand through the engine produces the scored result', () => {
  const g = createGame({ rng: mulberry32(9), dealer: 0 });
  while (g.phase !== 'handOver' && g.phase !== 'gameOver') botStep(g);
  const h = g.lastHand!;
  assert.equal(h.tricks.reduce((a, b) => a + b, 0), 13);
  assert.equal(h.scores[0], h.teams[0].delta);
  assert.equal(h.scores[1], h.teams[1].delta);
});

// ---------- game end ----------

test('game ends at target score; lower than target continues', () => {
  assert.equal(gameWinner([499, 100], 500), null);
  assert.equal(gameWinner([500, 100], 500), 0);
  assert.equal(gameWinner([120, 260], 250), 1);
});

test('game ends at -200 immediately, even if the other team is below target', () => {
  assert.equal(gameWinner([-200, 40], 500), 1);
  assert.equal(gameWinner([-199, 40], 500), null);
  assert.equal(gameWinner([30, -250], 500), 0);
});

test('both teams reach the target in the same hand: higher score wins', () => {
  assert.equal(gameWinner([520, 505], 500), 0);
  assert.equal(gameWinner([505, 530], 500), 1);
});

test('exactly equal scores at/above target: keep playing hands until one team is ahead', () => {
  assert.equal(gameWinner([500, 500], 500), null);
  const play = (start: [number, number]) => {
    const g = createGame({ target: 250, rng: mulberry32(3), dealer: 0 });
    g.scores = start;
    while (g.phase !== 'handOver' && g.phase !== 'gameOver') botStep(g);
    return g;
  };
  const probe = play([0, 0]);
  const [d0, d1] = [probe.lastHand!.teams[0].delta, probe.lastHand!.teams[1].delta];
  const tied = play([260 - d0, 260 - d1]); // same deal, scores finish level at 260
  assert.deepEqual(tied.scores, [260, 260]);
  assert.equal(tied.phase, 'handOver');
  assert.equal(tied.winner, null);
  nextHand(tied);
  assert.equal(tied.phase, 'bidding'); // play continues with a new hand
});

test('simulated games with equal scores never end tied', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = simulateGame({ target: 250, rng: mulberry32(seed) });
    assert.notEqual(r.scores[0], r.scores[1]);
  }
});

// ---------- bots ----------

test('bot never makes an illegal bid or play over thousands of random hands', () => {
  let hands = 0;
  for (let seed = 1; seed <= 2500; seed++) {
    const g = createGame({ rng: mulberry32(seed * 7919), dealer: seed % 4, teamMin: seed % 2 ? 4 : 0 });
    // random-ish table: mix bot choices with random legal choices so unusual states occur
    const wild = mulberry32(seed);
    while (g.phase === 'bidding') {
      const legal = legalBids(g, g.turn);
      const bid = wild() < 0.3 ? legal[Math.floor(wild() * legal.length)] : chooseBid(g, g.turn);
      assert.ok(legal.includes(bid), `bot bid ${bid}`);
      placeBid(g, g.turn, bid);
    }
    while (g.phase === 'playing') {
      const seat = g.turn;
      const legal = legalPlays(g, seat);
      const card = wild() < 0.3 ? legal[Math.floor(wild() * legal.length)] : choosePlay(g, seat);
      assert.ok(legal.includes(card), `illegal card ${card} for seat ${seat} (seed ${seed})`);
      playCard(g, seat, card);
    }
    hands += 1;
  }
  assert.equal(hands, 2500);
});

test('bot-vs-bot full games finish to the target (250 and 500) and end validly', () => {
  for (const target of [250, 500]) {
    for (let seed = 1; seed <= 12; seed++) {
      const r = simulateGame({ target, rng: mulberry32(seed * 31 + target) });
      assert.equal(r.capped, false);
      const w = r.scores[r.winner];
      const l = r.scores[1 - r.winner];
      assert.ok(w >= target || l <= -200, `winner ${w}, loser ${l}`);
      assert.ok(w > l);
    }
  }
});

test('bots bid sanely: a strong hand bids more than a weak one', () => {
  const g = createGame({ rng: mulberry32(1), dealer: 0 });
  g.hands[1] = ['AS', 'KS', 'QS', 'JS', '9S', 'AH', 'KH', 'AD', 'KD', 'AC', '2C', '3C', '4C'];
  g.hands[2] = ['2S', '3H', '4H', '5H', '6D', '7D', '8D', '9C', 'TC', '3C', '4C', '5C', '6C'];
  assert.ok(chooseBid(g, 1) >= 6);
  assert.equal(chooseBid(g, 2), 0, 'a hopeless hand still goes Nil (allowed)');
  g.hands[3] = ['2S', '3S', '4S', '5S', 'KH', 'QH', 'KD', 'QD', 'KC', 'QC', '9C', '8C', '7C'];
  const mid = chooseBid(g, 3);
  assert.ok(mid >= 1 && mid <= 13, `a middling hand bids a legal number, got ${mid}`);
});

test('rank helper orders cards', () => {
  assert.ok(rankOf('AS') > rankOf('KS'));
  assert.ok(rankOf('2S') < rankOf('3S'));
});

// ---------- table rule toggles: break rule and sandbags ----------

test('break rule ON (default): a spade cannot be led while a non-spade is held; OFF: spades may lead any time', () => {
  const hands = [['AS', '2H'], ['9S', '3D'], ['4D', '4C'], ['5D', '5C']];
  const on = playing(hands);
  assert.equal(on.breakRule, true);
  assert.deepEqual(legalPlays(on, 1), ['3D']);
  assert.throws(() => playCard(on, 1, '9S'), EngineError);

  const g = createGame({ rng: mulberry32(1), dealer: 0, breakRule: false });
  assert.equal(g.breakRule, false);
  g.hands = hands.map((h) => h.slice());
  for (let s = 0; s < 4; s++) placeBid(g, g.turn, 4);
  assert.deepEqual(legalPlays(g, 1).sort(), ['3D', '9S']);
  playCard(g, 1, '9S'); // allowed with the break rule off, and it is still tracked as broken
  assert.equal(g.spadesBroken, true);
  playCard(g, 2, '4D'); // void in spades: anything goes
  playCard(g, 3, '5D');
  assert.deepEqual(legalPlays(g, 0), ['AS']); // seat 0 holds a spade, so it must follow suit
});

test('break rule OFF: bots still play only legal cards and games finish', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = simulateGame({ target: 250, rng: mulberry32(seed), breakRule: false });
    assert.equal(r.capped, false);
  }
});

test('sandbags ON (default): overtricks are bags and 10 bags cost 100', () => {
  const on = scoreTeam([0, 2], [4, 0, 3, 0], [5, 0, 3, 0], 8); // bid 7 took 8: +70 +1 bag; 8+1 = 9 bags
  assert.equal(on.result.bagsGained, 1);
  assert.equal(on.bagsAfter, 9);
  assert.equal(on.result.delta, 71);
  const over = scoreTeam([0, 2], [4, 0, 3, 0], [6, 0, 4, 0], 8); // +3 bags: 11 -> penalty
  assert.equal(over.result.bagPenalty, -100);
  assert.equal(over.bagsAfter, 1);
});

test('sandbags OFF: no bag points, no bag counting, no penalty; contract and nil still score', () => {
  const r = scoreTeam([0, 2], [4, 0, 3, 0], [6, 0, 4, 0], 8, false); // bid 7 took 10
  assert.equal(r.result.bagsGained, 0);
  assert.equal(r.result.bagPenalty, 0);
  assert.equal(r.bagsAfter, 8); // unchanged: nothing counted
  assert.equal(r.result.delta, 70); // only the contract
  const nil = scoreTeam([0, 2], [0, 0, 4, 0], [2, 0, 6, 0], 0, false); // nil failed (-100), partner bid 4 took 6
  assert.equal(nil.result.nilPoints, -100);
  assert.equal(nil.result.bagsGained, 0);
  assert.equal(nil.result.delta, -100 + 40);
  const set = scoreTeam([0, 2], [4, 0, 3, 0], [2, 0, 2, 0], 3, false);
  assert.equal(set.result.delta, -70);
});

test('sandbags OFF through a whole game: bags stay at 0 and hand results carry no bag penalty', () => {
  const g = createGame({ target: 250, rng: mulberry32(5), dealer: 0, sandbags: false });
  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 5000) {
    botStep(g);
    assert.deepEqual(g.bags, [0, 0]);
    if (g.lastHand) for (const t of g.lastHand.teams) { assert.equal(t.bagPenalty, 0); assert.equal(t.bagsGained, 0); }
  }
  assert.equal(g.phase, 'gameOver');
});
