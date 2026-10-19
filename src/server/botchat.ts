// Table talk for bots: friendly small talk between the bots, reactions to what happens in the game,
// and replies when a person writes in the chat. Everything is short, playful and server-side only.
// Nothing here touches the cards or the rules.

import { Rng } from '../engine/cards.js';

export interface BotChatHost {
  rng: Rng;
  /** Bots currently seated at the table. */
  bots(): { seat: number; name: string }[];
  /** First names of the people seated at the table who are connected. */
  humans(): { seat: number; name: string }[];
  say(seat: number, name: string, text: string): void;
  /** True while a game is being played (small talk stops after the final hand). */
  playing(): boolean;
}

type Bot = { seat: number; name: string };

/** Talks that run for a few lines, alternating between two (or three) bots. {H} is a player's name, {B} the other bot's name. */
const THREADS: string[][] = [
  ['Y’all hungry? I could really go for some wings right now', 'Lemon pepper or nothing', 'Lemon pepper is undefeated, no debate', 'Okay now I’m hungry and I have to play cards'],
  ['Long day at work, this game is my break', 'Same here, I needed this', 'Spades after a long day hits different'],
  ['Anybody watching the game tonight?', 'Nah, I’m locked in on these cards', 'Smart. Sports can wait'],
  ['My cousin swears he’s the best spades player in the family', 'Is he?', 'Not even close, he reneges every time 😂', 'Every family has one'],
  ['Who taught you how to play spades?', 'My grandmother. She didn’t play fair either', 'Haha, the grandmas were the real champions', 'Truth. She’d slap the table when she won'],
  ['This is my third game today and I’m not stopping', 'You’re addicted', 'Guilty. Just one more hand', 'That’s what you said two games ago'],
  ['Weather’s crazy lately, one day hot, next day cold', 'Tell me about it, I don’t know what to wear anymore', 'Perfect weather for staying in and playing cards'],
  ['What’s everybody listening to right now?', 'Some old school R&B, can’t go wrong', 'Now we’re talking, good cards music', 'Put on some Luther and watch me bid right'],
  ['I need a snack, anybody else?', 'Chips and a cold drink, that’s the move', 'Hot sauce on everything', 'Alright, the table is hungry'],
  ['Rule at my house: no talking while you’re holding the big spade', 'Haha, then nobody’s ever talked', 'Poker faces only, but I’m terrible at it'],
  ['Sunday spades hits different', 'Facts. Family over, plates full, cards out', 'That’s the whole weekend right there'],
  ['I’ve got a good feeling about this hand', 'You said that last hand 😂', 'And the one before that', 'Okay, but this time I mean it'],
  ['Be honest, who’s the most competitive at this table?', 'Me, easily', 'Nah, it’s me', 'We’re all going to find out in a minute'],
  ['I’ve been playing spades since I was a kid', 'You must have seen some things', 'The stories I could tell… the bids I’ve seen'],
  ['Anybody got plans for the weekend?', 'Cookout, some cards, maybe a nap', 'That’s a good weekend right there'],
  ['This table is lively tonight', 'I like it, good vibes at this one', 'Good company and good cards, can’t ask for more'],
];

/** Ambient one-liners when nothing else is going on. */
const QUIPS = [
  'Alright, let’s see who’s got the spades', 'Somebody’s hiding a big spade, I can feel it', 'Good game so far, keep it coming',
  'Count your books, y’all', 'This one’s getting interesting', 'I’m just here for a good time and a few books',
  'Don’t get sandbagged now', 'Careful with those bags', 'Keep your eyes on the spades', 'Cards are talking tonight',
  'Love this game', 'Nobody’s sleeping on this table',
];

const HELLO = ['Hey everybody', 'What’s up, y’all', 'Hey {H}, good luck', 'Yo, let’s play', 'Evening, table', 'Hey hey, let’s get it'];
const HELLO_BACK = ['Hey {H}!', 'What’s up {H}', 'Yo {H}, good to see you', 'Hey, welcome to the table', 'Hey hey 👋'];
const GG_BACK = ['gg {H}', 'Good game, run it back?', 'Good one, that was fun', 'gg, y’all played well'];
const THANKS_BACK = ['Anytime', 'No problem', 'You got it', 'All good'];
const LAUGH_BACK = ['😂😂', 'Haha right', 'I can’t with y’all', 'That’s funny'];
const QUESTION_BACK = ['Ha, ask me after this hand', 'Good question, I’m still thinking about it', 'Not sure, but I’m playing my cards', 'You’re asking the wrong one 😂', 'Hmm, hard to say'];
const BOTQ_BACK = ['Ha, just here to play spades', 'Does it matter? Play your hand 😄', 'I’m just focused on these cards', 'Worry about your bid, not me 😂'];
const GENERIC_BACK = ['True', 'I hear you', 'Facts', 'Say that again', 'Fair enough', 'Ha, okay then', 'That’s what I’m saying', 'Noted 😄', 'Right?'];
const TRASH_BACK = ['Oh we’ll see about that', 'Big talk, let’s see the books', 'Keep talking, I’m counting spades', 'Ooh, somebody’s confident 😏', 'Bring it'];
const BIG_BID = ['{N} books? That’s bold', 'Bidding {N}? Okay, I see you', '{N}? Somebody’s feeling confident', 'Wow, {N}. Let’s see it'];
const NIL = ['Nil?! Somebody’s feeling brave', 'Going Nil, respect', 'Nil bid, now we’re playing', 'Careful with that Nil, don’t get caught'];
const WIN_TRICK = ['That one’s mine', 'Nice trick', 'Gotcha', 'Thank you very much', 'Little spade magic'];
const HUMAN_WIN_TRICK = ['Okay {H}, I see you', 'Nice one, {H}', 'Alright, alright', 'Okay okay, don’t get comfortable'];
const SET = ['Ouch, that hurt', 'We got set, my bad', 'Dang, I thought I had that', 'Can’t win them all'];
const MADE = ['That’s how it’s done', 'Made it, nice', 'Books are in', 'Smooth hand'];
const GAME_WIN = ['gg everybody, that was fun', 'Good game, y’all', 'That’s the game, great playing', 'We got that one, good game'];
const GAME_LOSE = ['Well played, gg', 'You got us, good game', 'Okay, okay, good game, run it back', 'Nice game, y’all earned that one'];

const MIN_GAP_MS = 6000;      // between reactions from different triggers
const CONVO_LIMIT = 200;      // chat message length cap (matches CONFIG.chat.maxChars)

export class BotChat {
  private timers = new Set<NodeJS.Timeout>();
  private lastSpoke = 0;
  private convoUntil = 0;
  private ambient: NodeJS.Timeout | null = null;
  private usedThreads = new Set<number>();
  private on = false;
  private greeted = false;

  /** pace scales every delay: 1 is normal speed, a small number is for tests, 0 turns bot chat off. */
  constructor(private host: BotChatHost, private pace: number) {}

  get enabled(): boolean { return this.pace > 0; }

  // ---- lifecycle ----

  start(): void {
    if (!this.enabled) return;
    this.stop();
    this.on = true;
    this.greeted = false;
    this.usedThreads.clear();
    this.later(3000 + this.rand(4000), () => this.greet());
    this.armAmbient();
  }

  stop(): void {
    this.on = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.ambient) clearTimeout(this.ambient);
    this.ambient = null;
  }

  // ---- game events ----

  onBid(seat: number, bid: number): void {
    if (!this.ready() || this.cooling()) return;
    const bots = this.host.bots();
    if (bid === 0 && this.chance(0.7)) return this.sayOne(this.pickOther(bots, seat), NIL);
    if (bid >= 7 && this.chance(0.5)) return this.sayOne(this.pickOther(bots, seat), BIG_BID, { N: String(bid) });
  }

  onTrick(winner: number): void {
    if (!this.ready() || this.cooling()) return;
    const bot = this.host.bots().find((b) => b.seat === winner);
    if (bot && this.chance(0.1)) return this.sayAs(bot, WIN_TRICK);
    const human = this.host.humans().find((h) => h.seat === winner);
    if (human && this.chance(0.15)) return this.sayOne(this.pickOther(this.host.bots(), winner), HUMAN_WIN_TRICK, { H: human.name });
  }

  /** teamsMade: for each team, whether it made its bid (null if it had no bid). */
  onHandEnd(teamsMade: [boolean | null, boolean | null]): void {
    if (!this.ready() || this.cooling() || !this.chance(0.6)) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    const bot = bots[Math.floor(this.host.rng() * bots.length)];
    const team = bot.seat % 2;
    const mine = teamsMade[team];
    if (mine === false) return this.sayAs(bot, SET);
    if (mine === true) return this.sayAs(bot, MADE);
  }

  onGameEnd(winnerTeam: number): void {
    if (!this.ready()) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    const bot = bots[Math.floor(this.host.rng() * bots.length)];
    this.later(1500 + this.rand(2500), () => this.sayAs(bot, bot.seat % 2 === winnerTeam ? GAME_WIN : GAME_LOSE, { H: this.firstHuman() }));
  }

  /** A person wrote in the chat: one bot answers, sometimes a second one joins in. */
  onHumanChat(fromName: string, text: string): void {
    if (!this.ready()) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    const lower = text.toLowerCase();
    const named = bots.find((b) => lower.includes(b.name.toLowerCase()));
    const first = named ?? bots[Math.floor(this.host.rng() * bots.length)];
    const pool = this.replyPool(lower);
    if (!this.chance(0.9)) return;
    this.later(1800 + this.rand(3200), () => this.sayAs(first, pool, { H: fromName }));
    const others = bots.filter((b) => b.seat !== first.seat);
    if (others.length && this.chance(0.3)) {
      const second = others[Math.floor(this.host.rng() * others.length)];
      this.later(5500 + this.rand(3500), () => this.sayAs(second, this.chance(0.5) ? LAUGH_BACK : GENERIC_BACK, { H: fromName }));
    }
  }

  // ---- internals ----

  private replyPool(lower: string): string[] {
    if (/\b(hi|hey|hello|yo|sup|what'?s up|wassup|howdy)\b/.test(lower)) return HELLO_BACK;
    if (/\b(gg|good game|well played|wp)\b/.test(lower)) return GG_BACK;
    if (/\b(thanks|thank you|thx|ty)\b/.test(lower)) return THANKS_BACK;
    if (/\b(bot|robot|real person|real people|human|computer|ai)\b/.test(lower) && lower.includes('?')) return BOTQ_BACK;
    if (/\b(lol|lmao|haha|hahaha|funny|😂|🤣)\b/.test(lower) || lower.includes('😂') || lower.includes('🤣')) return LAUGH_BACK;
    if (/\b(trash|beat you|beat y'?all|gonna win|about to win|lose|losing|sandbag|set you|crush)\b/.test(lower)) return TRASH_BACK;
    if (lower.includes('?')) return QUESTION_BACK;
    return GENERIC_BACK;
  }

  private greet(): void {
    if (!this.ready() || this.greeted) return;
    this.greeted = true;
    const bots = this.host.bots();
    if (!bots.length) return;
    const first = bots[Math.floor(this.host.rng() * bots.length)];
    const i = Math.floor(this.host.rng() * HELLO.length);
    this.say(first, HELLO[i], { H: this.firstHuman() });
    if (bots.length > 1 && this.chance(0.6)) {
      const other = bots.filter((b) => b.seat !== first.seat);
      const second = other[Math.floor(this.host.rng() * other.length)];
      const j = (i + 1 + Math.floor(this.host.rng() * (HELLO.length - 1))) % HELLO.length; // never the same line twice
      this.later(2500 + this.rand(2500), () => this.say(second, HELLO[j], { H: this.firstHuman() }));
    }
  }

  private armAmbient(): void {
    if (!this.on) return;
    if (this.ambient) clearTimeout(this.ambient);
    const ms = (40000 + this.rand(50000)) * this.pace;
    this.ambient = setTimeout(() => { this.ambient = null; this.ambientTick(); }, ms);
    this.ambient.unref?.();
  }

  private ambientTick(): void {
    if (!this.on) return;
    if (this.ready() && this.host.playing() && Date.now() >= this.convoUntil && !this.cooling()) {
      if (this.chance(0.6)) this.startThread(); else {
        const bots = this.host.bots();
        if (bots.length) this.sayAs(bots[Math.floor(this.host.rng() * bots.length)], QUIPS);
      }
    }
    this.armAmbient();
  }

  /** A short back-and-forth between two bots (or one bot talking if only one is seated). */
  private startThread(): void {
    const bots = this.host.bots();
    if (!bots.length) return;
    const all = THREADS.map((_, i) => i).filter((i) => !this.usedThreads.has(i));
    const pool = all.length ? all : THREADS.map((_, i) => i);
    if (!all.length) this.usedThreads.clear();
    const idx = pool[Math.floor(this.host.rng() * pool.length)];
    this.usedThreads.add(idx);
    const a = bots[Math.floor(this.host.rng() * bots.length)];
    const rest = bots.filter((b) => b.seat !== a.seat);
    const b = rest.length ? rest[Math.floor(this.host.rng() * rest.length)] : null;
    const lines = THREADS[idx];
    let at = 0;
    lines.forEach((line, i) => {
      const speaker = i % 2 === 0 ? a : (b ?? a);
      if (!b && i % 2 === 1) return; // a lone bot only says its own lines
      at += i === 0 ? 0 : 3500 + this.rand(3500);
      this.later(at, () => this.say(speaker, line, { H: this.firstHuman(), B: b?.name ?? '' }));
    });
    this.convoUntil = Date.now() + (at + 4000) * this.pace;
  }

  private ready(): boolean { return this.on && this.host.humans().length > 0; }
  private cooling(): boolean { return Date.now() - this.lastSpoke < MIN_GAP_MS * this.pace || Date.now() < this.convoUntil; }
  private chance(p: number): boolean { return this.host.rng() < p; }
  private rand(n: number): number { return Math.floor(this.host.rng() * n); }
  private firstHuman(): string { return this.host.humans()[0]?.name ?? 'friend'; }

  private pickOther(bots: Bot[], seat: number): Bot | null {
    const others = bots.filter((b) => b.seat !== seat);
    const list = others.length ? others : bots;
    return list.length ? list[Math.floor(this.host.rng() * list.length)] : null;
  }

  private sayOne(bot: Bot | null, pool: string[], vars: Record<string, string> = {}): void { if (bot) this.sayAs(bot, pool, vars); }
  private sayAs(bot: Bot, pool: string[], vars: Record<string, string> = {}): void {
    this.say(bot, pool[Math.floor(this.host.rng() * pool.length)], vars);
  }

  private say(bot: Bot, template: string, vars: Record<string, string> = {}): void {
    if (!this.ready()) return;
    // The seat may have changed hands since this was scheduled: only the same bot still in that seat speaks.
    if (!this.host.bots().some((b) => b.seat === bot.seat && b.name === bot.name)) return;
    const text = template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, CONVO_LIMIT);
    if (!text) return;
    this.lastSpoke = Date.now();
    this.host.say(bot.seat, bot.name, text);
  }

  /** Run fn after ms (scaled by the pace); cleared on stop(). */
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); if (this.on) fn(); }, ms * this.pace);
    t.unref?.();
    this.timers.add(t);
  }
}
