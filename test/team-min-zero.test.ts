import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/engine/cards.js';
import { createGame, legalBids, legalPlays, nextHand, placeBid, playCard, scoreTeam } from '../src/engine/game.js';
import { chooseBid, choosePlay } from '../src/engine/bot.js';

// Team-minimum tables (teamMin > 0): no Nil. A 0 bid is a plain zero that counts in the team contract.

test('team-min game: both partners may bid 0..13 with no individual limit', () => {
  const g = createGame({ teamMin: 4, rng: mulberry32(1), dealer: 3 }); // seat 0 bids first
  assert.deepEqual(legalBids(g, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  placeBid(g, 0, 0);
  placeBid(g, 1, 5);
  assert.deepEqual(legalBids(g, 2), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  placeBid(g, 2, 1);
  assert.ok(legalBids(g, 3).includes(0), 'partner bid 5, so 0 is allowed');
  placeBid(g, 3, 0);
  assert.equal(g.phase, 'playing');
});

test('team-min scoring: a 0 bid is part of the team contract, no ±100', () => {
  // seats 0 & 2: bids 0 + 4 = 4; tricks 2 + 3 = 5 -> made, 40 + 1 bag
  const made = scoreTeam([0, 2], [0, 0, 4, 0], [2, 0, 3, 0], 0, true, false).result;
  assert.equal(made.bid, 4); assert.equal(made.tricks, 5); assert.equal(made.made, true);
  assert.equal(made.nilPoints, 0); assert.equal(made.nil.length, 0); assert.equal(made.delta, 41);
  // bids 0 + 5 = 5; tricks 1 + 3 = 4 -> set, -50
  const set = scoreTeam([0, 2], [0, 0, 5, 0], [1, 0, 3, 0], 0, true, false).result;
  assert.equal(set.made, false); assert.equal(set.delta, -50);
});

test('free (regular) games still score Nil ±100', () => {
  const ok = scoreTeam([0, 2], [0, 0, 4, 0], [0, 0, 4, 0], 0).result;
  assert.equal(ok.nilPoints, 100); assert.equal(ok.delta, 140);
  const bust = scoreTeam([0, 2], [0, 0, 4, 0], [1, 0, 4, 0], 0).result;
  assert.equal(bust.nilPoints, -100);
});

test('a whole team-min game scores with no Nil points; bots (normal and strong) stay legal and rarely bid 0', () => {
  let zeros = 0, bids = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const g = createGame({ target: 250, teamMin: 4, rng: mulberry32(seed), dealer: seed % 4 });
    let hands = 0;
    while (g.phase !== 'gameOver' && hands < 60) {
      if (g.phase === 'bidding') {
        const skill = g.turn % 2 ? 'strong' : 'normal';
        const b = chooseBid(g, g.turn, skill);
        assert.ok(legalBids(g, g.turn).includes(b), `bid ${b}`);
        bids++; if (b === 0) zeros++;
        placeBid(g, g.turn, b);
      } else if (g.phase === 'playing') {
        const c = choosePlay(g, g.turn, g.turn % 2 ? 'strong' : 'normal');
        assert.ok(legalPlays(g, g.turn).includes(c));
        playCard(g, g.turn, c);
      } else {
        for (const t of g.lastHand!.teams) { assert.equal(t.nilPoints, 0); assert.equal(t.nil.length, 0); assert.equal(t.contract, Math.max(t.bid, 4)); }
        hands++; nextHand(g);
      }
    }
  }
  assert.ok(zeros / bids < 0.1, `bots bid 0 rarely (${zeros}/${bids})`);
});

test('board rule: last partner bids 0 after partner bid 1; contract is 4 and scoring uses it', () => {
  const g = createGame({ teamMin: 4, rng: mulberry32(2), dealer: 0 }); // seat 1 bids first
  placeBid(g, 1, 1); placeBid(g, 2, 3); placeBid(g, 3, 0); placeBid(g, 0, 0);
  assert.equal(g.phase, 'playing');
  // made the board: bid 1+0, contract 4, took 5 -> 40 + 1 bag
  let r = scoreTeam([1, 3], [0, 1, 0, 0], [0, 3, 0, 2], 0, true, false, 4).result;
  assert.equal(r.bid, 1); assert.equal(r.contract, 4); assert.equal(r.made, true); assert.equal(r.contractPoints, 40); assert.equal(r.bagsGained, 1); assert.equal(r.delta, 41);
  // set: took 3 of a board of 4 -> -40
  r = scoreTeam([1, 3], [0, 1, 0, 0], [0, 3, 0, 0], 0, true, false, 4).result;
  assert.equal(r.made, false); assert.equal(r.delta, -40);
  // 0 + 0 still plays for 4
  r = scoreTeam([1, 3], [0, 0, 0, 0], [0, 2, 0, 2], 0, true, false, 4).result;
  assert.equal(r.contract, 4); assert.equal(r.made, true); assert.equal(r.delta, 40);
  // above the board: the bid itself is the contract
  r = scoreTeam([1, 3], [0, 5, 0, 2], [0, 4, 0, 3], 0, true, false, 4).result;
  assert.equal(r.contract, 7); assert.equal(r.delta, 70);
  // regular tables unchanged: Nil still +/-100, no board
  r = scoreTeam([1, 3], [0, 1, 0, 0], [0, 3, 0, 0], 0).result;
  assert.equal(r.contract, undefined); assert.equal(r.nilPoints, 100); assert.equal(r.delta, 100 + 10 + 2);
});
