// Computer-player chat attitudes: friendly / competitive / elite, reply chains after big moments, the per-hand
// rate limit, and a clean-words check on every line (PG-13 card-table talk, never the word "bot").

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/engine/cards.js';
import { BotChat, MAX_LINES_PER_HAND, MOMENT_LINES, allChatLines } from '../src/server/botchat.js';

const BANNED = ['bot', 'kill', 'shoot', 'gun', 'die', 'dead meat', 'hurt you', 'beat you up', 'punch', 'stab', 'murder', 'blood',
  'fuck', 'shit', 'bitch', 'ass', 'damn', 'hell', 'sex', 'sexy', 'nigg', 'fag', 'retard', 'whore', 'slut', 'stupid', 'idiot', 'ugly', 'fat'];

test('every chat line is clean (no threats, slurs, sexual words or profanity; never "bot")', () => {
  const lines = allChatLines();
  assert.ok(lines.length > 200);
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const w of BANNED) assert.ok(!new RegExp(`\\b${w}`).test(lower), `"${line}" contains "${w}"`);
  }
});

function table(bots: { seat: number; name: string; attitude: 'friendly' | 'competitive' | 'elite' }[], seed = 1) {
  const said: { seat: number; name: string; text: string }[] = [];
  const chat = new BotChat({
    rng: mulberry32(seed), bots: () => bots.map((b) => ({ ...b, trash: b.attitude !== 'friendly' })), humans: () => [{ seat: 0, name: 'Raw' }],
    say: (seat, name, text) => said.push({ seat, name, text }), playing: () => true,
  }, 0.0001); // tiny pace: every delay is a fraction of a millisecond
  chat.start();
  return { chat, said };
}
const flush = () => new Promise((r) => setTimeout(r, 20));

test('a set starts a reply chain: the elite team gloats, the partner backs them up, the rival claps back', async () => {
  const { chat, said } = table([{ seat: 1, name: 'King Spade', attitude: 'elite' }, { seat: 3, name: 'Four Aces', attitude: 'elite' }, { seat: 2, name: 'Rico', attitude: 'competitive' }]);
  await flush(); said.length = 0;
  chat.onHandEnd([false, true]); // team 0 (seats 0 & 2) got set; team 1 (the elite team) made it
  await flush();
  const setLines = Object.values(MOMENT_LINES.set).flatMap((p) => Object.values(p).flat());
  said.splice(0, said.length, ...said.filter((x) => setLines.includes(x.text))); // small talk can run alongside at this test pace
  assert.equal(said.length, 3, JSON.stringify(said));
  assert.ok(MOMENT_LINES.set.lead.elite.includes(said[0].text) && said[0].seat % 2 === 1);
  assert.ok(MOMENT_LINES.set.backup.elite.includes(said[1].text) && said[1].seat % 2 === 1 && said[1].seat !== said[0].seat);
  assert.ok(MOMENT_LINES.set.reply.competitive.includes(said[2].text) && said[2].name === 'Rico');
  chat.stop();
});

test('chains also follow a Nil, a run of books, a close score and the end of the game; friendly players stay friendly', async () => {
  const { chat, said } = table([{ seat: 1, name: 'Tasha', attitude: 'friendly' }, { seat: 2, name: 'Dre', attitude: 'competitive' }, { seat: 3, name: 'Kim', attitude: 'friendly' }]);
  await flush();
  const lines = (moment: keyof typeof MOMENT_LINES) => Object.values(MOMENT_LINES[moment]).flatMap((p) => Object.values(p).flat());
  const check = async (moment: keyof typeof MOMENT_LINES, act: () => void) => {
    said.length = 0; (chat as any).lastChain = -Infinity; (chat as any).linesThisHand = 0;
    act(); await flush();
    said.splice(0, said.length, ...said.filter((x) => lines(moment).includes(x.text)));
    assert.ok(said.length >= 2 && said.every((x) => lines(moment).includes(x.text)), `${moment}: ${JSON.stringify(said)}`);
    for (const x of said) if (x.name !== 'Dre') assert.ok(!Object.values(MOMENT_LINES[moment]).some((p) => p.competitive.includes(x.text) || p.elite.includes(x.text)), `${x.name} stays friendly`);
  };
  await check('nilBroken', () => chat.onHandEnd([true, true], { nils: [{ team: 1, made: false }] }));
  await check('nilMade', () => chat.onHandEnd([true, true], { nils: [{ team: 0, made: true }] }));
  await check('close', () => chat.onHandEnd([true, true], { scores: [460, 440], target: 500 }));
  await check('run', () => { for (let i = 0; i < 4; i++) chat.onTrick(1); });
  await check('gameEnd', () => chat.onGameEnd(0));
  chat.stop();
});

test('rate limit: chains wait for the cool-down and a hand never gets more than the line cap', async () => {
  const said: string[] = [];
  const bots = [{ seat: 1, name: 'A', attitude: 'elite' as const }, { seat: 2, name: 'B', attitude: 'competitive' as const }, { seat: 3, name: 'C', attitude: 'elite' as const }];
  const chat = new BotChat({ rng: mulberry32(3), bots: () => bots, humans: () => [{ seat: 0, name: 'Raw' }], say: (_s, _n, t) => said.push(t), playing: () => true }, 0.01); // chain gap 200 ms
  chat.start();
  await new Promise((r) => setTimeout(r, 150)); said.length = 0;
  chat.onHandEnd([false, true]);
  await new Promise((r) => setTimeout(r, 120));
  const first = said.length;
  assert.ok(first >= 2);
  chat.onHandEnd([false, true]); // a second set right away: inside the chain cool-down (20 s at normal pace)
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(said.length, first, 'no second chain during the cool-down');
  // a flood of triggers inside one hand stays under the cap
  said.length = 0;
  (chat as any).linesThisHand = 0;
  for (let i = 0; i < 100; i++) { (chat as any).lastSpoke = 0; (chat as any).convoUntil = 0; (chat as any).lastChain = -Infinity; chat.onTrick(i % 4); chat.onBid(i % 4, 8); }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(said.length <= MAX_LINES_PER_HAND, `${said.length} lines in one hand`);
  chat.stop();
});
