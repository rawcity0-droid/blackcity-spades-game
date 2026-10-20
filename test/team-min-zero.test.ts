import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../src/engine/cards.js';
import { createGame, legalBids, legalPlays, nextHand, placeBid, playCard, scoreTeam } from '../src/engine/game.js';
import { chooseBid, choosePlay } from '../src/engine/bot.js';

// Team-minimum tables (teamMin > 0): no Nil. A 0 bid is a plain zero that counts in the team contract.

test('team-min game: first bidder of a pair may bid 0..13; after a partner 0 the second must bid 4+; after 4+ a 0 is fine', () => {
  const g = createGame({ teamMin: 4, rng: mulberry32(1), dealer: 3 }); // seat 0 bids first
  assert.deepEqual(legalBids(g, 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  placeBid(g, 0, 0);
  placeBid(g, 1, 5);
  assert.deepEqual(legalBids(g, 2), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.throws(() => placeBid(g, 2, 3), /at least 4 together/);
  placeBid(g, 2, 4);
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
        if (g.phase === 'playing') for (const pair of [[0, 2], [1, 3]]) assert.ok(g.bids[pair[0]]! + g.bids[pair[1]]! >= 4);
      } else if (g.phase === 'playing') {
        const c = choosePlay(g, g.turn, g.turn % 2 ? 'strong' : 'normal');
        assert.ok(legalPlays(g, g.turn).includes(c));
        playCard(g, g.turn, c);
      } else {
        for (const t of g.lastHand!.teams) { assert.equal(t.nilPoints, 0); assert.equal(t.nil.length, 0); }
        hands++; nextHand(g);
      }
    }
  }
  assert.ok(zeros / bids < 0.1, `bots bid 0 rarely (${zeros}/${bids})`);
});
