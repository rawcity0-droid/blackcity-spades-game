import test from 'node:test';
import assert from 'node:assert/strict';
import { newDeck, mulberry32, suitOf, rankOf } from '../src/engine/cards.js';
import { createGame, legalPlays, trickWinner, scoreTeam, playCard, placeBid, legalBids } from '../src/engine/game.js';
import { chooseBid, choosePlay } from '../src/engine/bot.js';
import { connect, connectPremium, testServer } from './helpers.js';

test('jokers deck: 52 cards, no 2♦/2♥, both jokers, 15 trumps, 13 each', () => {
  const d = newDeck(true);
  assert.equal(d.length, 52); assert.equal(new Set(d).size, 52);
  for (const c of ['2D', '2H']) assert.ok(!d.includes(c));
  for (const c of ['BS', 'LS', 'DS']) assert.ok(d.includes(c));
  assert.equal(d.filter((c) => suitOf(c) === 'S').length, 15);
  const g = createGame({ jokers: true, rng: mulberry32(3) });
  assert.ok(g.hands.every((h) => h.length === 13));
  assert.deepEqual(g.hands.flat().sort(), d.slice().sort());
});

test('trump order: Big > Little > 2♠ > A♠ > K♠ … > 3♠', () => {
  const order = ['BS', 'LS', 'DS', 'AS', 'KS', 'QS', '3S'];
  for (let i = 0; i < order.length - 1; i++) assert.ok(rankOf(order[i]) > rankOf(order[i + 1]));
  assert.equal(trickWinner([{ seat: 0, card: 'AS' }, { seat: 1, card: 'LS' }, { seat: 2, card: 'BS' }, { seat: 3, card: 'DS' }]), 2);
  assert.equal(trickWinner([{ seat: 0, card: 'AH' }, { seat: 1, card: 'LS' }, { seat: 2, card: 'KH' }, { seat: 3, card: '3H' }]), 1);
});

test('a joker follows spades and counts as a spade for breaking', () => {
  const g = createGame({ jokers: true, rng: mulberry32(1) });
  g.phase = 'playing'; g.turn = 1;
  g.hands[1] = ['BS', 'KH', '4C'];
  g.trick = [{ seat: 0, card: '5S' }];
  assert.deepEqual(legalPlays(g, 1), ['BS']);
  g.trick = []; g.spadesBroken = false;
  assert.deepEqual(legalPlays(g, 1).sort(), ['4C', 'KH']);
  g.trick = [{ seat: 0, card: '5D' }];
  playCard(g, 1, 'BS');
  assert.equal(g.spadesBroken, true);
});

test('jokers scoring: no Nil, no bags, set under 4', () => {
  const g = createGame({ jokers: true, rng: mulberry32(2) });
  assert.equal(g.sandbags, false); assert.equal(g.teamMin, 4);
  assert.ok(legalBids(g, g.turn).includes(0));
  // made 5 with 9 tricks: 50, no bag points
  let r = scoreTeam([0, 2], [3, 0, 2, 0], [5, 0, 4, 0], 0, false, false, 4).result;
  assert.equal(r.delta, 50); assert.equal(r.bagsGained, 0);
  // bid 1+1, takes 3: contract 4, set -40
  r = scoreTeam([0, 2], [1, 0, 1, 0], [2, 0, 1, 0], 0, false, false, 4).result;
  assert.equal(r.delta, -40); assert.equal(r.made, false);
});

test('bots play full jokers games legally', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = createGame({ jokers: true, target: 250, rng: mulberry32(seed) });
    while (g.phase === 'bidding') placeBid(g, g.turn, chooseBid(g, g.turn, seed % 2 ? 'strong' : 'normal'));
    while (g.phase === 'playing') playCard(g, g.turn, choosePlay(g, g.turn, seed % 2 ? 'strong' : 'normal'));
    assert.equal(g.lastHand!.bags.join(), '0,0');
    assert.ok(g.lastHand!.tricks.reduce((a, b) => a + b) === 13);
  }
});

async function firstTable(premium: boolean, msgs: object[]): Promise<any> {
  const srv = await testServer({ devUnlock: true, timings: { botDelayMs: 60000 } });
  try {
    const { c } = premium ? await connectPremium(srv.port, 'Host') : await connect(srv.port, 'Bea');
    for (const m of msgs) { c.send(m); if ((m as any).t.startsWith('create') && (m as any).t !== 'createTable') await c.waitFor((x) => x.t === 'tournament' || x.t === 'event'); }
    const t = await c.waitFor((m) => m.t === 'table' && m.phase && m.phase !== 'waiting', 8000, true);
    c.close();
    return t;
  } finally { await srv.close(); }
}

test('host Jokers switch persists into tournament and event tables', async () => {
  const tour = await firstTable(true, [{ t: 'createTournament', size: 4, isPublic: false, jokers: true }, { t: 'startTournament' }]);
  assert.equal(tour.bidRules.jokers, true); assert.equal(tour.bidRules.teamMin, 4); assert.equal(tour.rules.sandbags, false);
  const ev = await firstTable(true, [{ t: 'createEvent', tables: 1, target: 250, jokers: true }, { t: 'startEvent' }]);
  assert.equal(ev.bidRules.jokers, true);
  const tab = await firstTable(true, [{ t: 'createTable', isPublic: false, target: 250 }, { t: 'setRules', jokers: true }, { t: 'startTable' }]);
  assert.equal(tab.bidRules.jokers, true);
  assert.ok(tab.hand.every((c: string) => c !== '2D' && c !== '2H'));
});

test('Free Play is unaffected even if a client sends jokers', async () => {
  const t = await firstTable(false, [{ t: 'quickPlay', jokers: true, teamMin4: true }]);
  assert.equal(t.bidRules.jokers, false); assert.equal(t.bidRules.teamMin, 0); assert.equal(t.target, 500);
});
