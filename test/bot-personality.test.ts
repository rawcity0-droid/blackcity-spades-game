// Bot personalities: some bots are trash talkers, some are strong players. Nothing here changes the rules.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Table, defaultTimings } from '../src/server/table.js';
import { BotChat, TRASH_LINES } from '../src/server/botchat.js';
import { mulberry32, secureRng } from '../src/engine/cards.js';
import { createGame, legalBids, legalPlays, nextHand, placeBid, playCard } from '../src/engine/game.js';
import { chooseBid, choosePlay } from '../src/engine/bot.js';
import { simulateGame } from '../src/engine/sim.js';

function makeTable() {
  return new Table({
    id: 't1', code: 'ABCD', isPublic: false, target: 250, hostId: 'p1', quick: true,
    timings: { ...defaultTimings(), botDelayMs: 0, trickPauseMs: 0, handPauseMs: 60000, botChatPace: 0 },
    hooks: { send() {}, changed() {}, destroyed() {}, released() {} },
    rng: secureRng,
  });
}

test('bots get a mix of chat styles and skills, and the table view never shows them', () => {
  const style = { chill: 0, trash: 0 }, skill = { normal: 0, strong: 0 };
  for (let n = 0; n < 200; n++) {
    const t = makeTable();
    t.seatHuman(0, 'p1', 'Raw', true);
    t.startGame();
    for (const b of t.seats.filter((s) => s.kind === 'bot')) { style[b.chatStyle!]++; skill[b.skill!]++; }
    assert.equal(new Set(t.seats.map((s) => s.name)).size, 4, 'unique names at the table');
    const v: any = t.view('p1');
    for (const s of v.seats) { assert.equal(s.skill, undefined); assert.equal(s.chatStyle, undefined); }
    t.dispose();
  }
  assert.ok(style.trash > 120 && style.chill > 300, JSON.stringify(style));
  assert.ok(skill.strong > 120 && skill.normal > 300, JSON.stringify(skill));
});

test('trash lines only ever come from trash-talking bots', () => {
  const trashSet = new Set(Object.values(TRASH_LINES).flat().map((l) => l.replace(/\{\w+\}/g, '')));
  const isTrash = (text: string) => [...trashSet].some((l) => l.length > 6 && text.includes(l.slice(0, Math.min(14, l.length)).replace(/\{.*$/, '')));
  const lines: { name: string; text: string }[] = [];
  const rng = mulberry32(7);
  const bots = [{ seat: 1, name: 'Mean', trash: true }, { seat: 2, name: 'Nice', trash: false }, { seat: 3, name: 'Calm', trash: false }];
  const chat = new BotChat({
    rng, bots: () => bots, humans: () => [{ seat: 0, name: 'Raw' }],
    say: (_seat, name, text) => lines.push({ name, text }), playing: () => true,
  }, 0.0001);
  chat.start();
  for (let i = 0; i < 400; i++) {
    chat.onBid(i % 4, i % 3 === 0 ? 0 : 8);
    chat.onTrick(i % 4, i % 5 === 0);
    chat.onHandEnd([i % 2 === 0, i % 2 === 1]);
    chat.onHumanChat('Raw', 'you are going to lose');
    (chat as any).lastSpoke = 0; (chat as any).convoUntil = 0; // skip the cool-down so every trigger can speak
  }
  chat.stop();
  const trashSaid = lines.filter((l) => isTrash(l.text));
  assert.ok(trashSaid.length > 20, `trash talk happened (${trashSaid.length})`);
  for (const l of trashSaid) assert.equal(l.name, 'Mean', `"${l.text}" came from ${l.name}`);
});

test('strong bots only make legal bids and plays across many random hands', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const g = createGame({ target: 500, rng: mulberry32(seed), dealer: seed % 4, breakRule: seed % 3 !== 0 });
    for (let hand = 0; hand < 2 && g.phase !== 'gameOver'; hand++) {
      while (g.phase === 'bidding') {
        const b = chooseBid(g, g.turn, 'strong');
        assert.ok(legalBids(g, g.turn).includes(b));
        placeBid(g, g.turn, b);
      }
      while (g.phase === 'playing') {
        const c = choosePlay(g, g.turn, seed % 2 ? 'strong' : (g.turn % 2 ? 'strong' : 'normal'));
        assert.ok(legalPlays(g, g.turn).includes(c), `illegal ${c}`);
        playCard(g, g.turn, c);
      }
      if (g.phase === 'handOver') nextHand(g);
    }
  }
});

test('a strong team beats a normal team clearly more than half the time', () => {
  let wins = 0;
  const games = 300;
  for (let i = 0; i < games; i++) {
    const strongTeam = i % 2;
    const skills = [0, 1, 2, 3].map((s) => (s % 2 === strongTeam ? 'strong' : 'normal') as 'strong' | 'normal');
    if (simulateGame({ target: 500, rng: mulberry32(5000 + i), skills }).winner === strongTeam) wins++;
  }
  assert.ok(wins / games > 0.54, `strong team won ${wins} of ${games}`);
});
