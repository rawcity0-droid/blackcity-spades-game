// Table talk for bots: friendly small talk between the bots, reactions to what happens in the game,
// and replies when a person writes in the chat. Everything is short, playful and server-side only.
// Nothing here touches the cards or the rules.

import { Rng } from '../engine/cards.js';

export interface BotChatHost {
  rng: Rng;
  /** Bots currently seated at the table. */
  bots(): Bot[];
  /** First names of the people seated at the table who are connected. */
  humans(): { seat: number; name: string }[];
  say(seat: number, name: string, text: string): void;
  /** True while a game is being played (small talk stops after the final hand). */
  playing(): boolean;
}

/** trash: this bot is a trash talker (uses the TRASH_* lines on top of the friendly ones).
 *  attitude: friendly (default), competitive (trash talker) or elite (cocky: looks down on the other team). */
export type Attitude = 'friendly' | 'competitive' | 'elite';
type Bot = { seat: number; name: string; trash?: boolean; attitude?: Attitude };
const attitudeOf = (b: Bot): Attitude => b.attitude ?? (b.trash ? 'competitive' : 'friendly');

/** Big moments start a short reply chain: one player reacts, their partner backs them up, an opponent answers.
 *  `lead` is said by the team the moment is good for (or about), `backup` by that player's partner, `reply` by the other team.
 *  PG-13 card-table talk only: no threats, no slurs, nothing about who people are. Exported for the clean-words test. */
type Lines = Record<Attitude, string[]>;
export const MOMENT_LINES: Record<'set' | 'nilMade' | 'nilBroken' | 'run' | 'close' | 'gameEnd', { lead: Lines; backup: Lines; reply: Lines }> = {
  set: { // the team that made it while the other team got set
    lead: {
      friendly: ['Whew, we got through that one', 'Made it! Tough hand for y’all'],
      competitive: ['Set! Write that down', 'Y’all got set. Count your books next time', 'Overbid and underdelivered'],
      elite: ['We run this table', 'Y’all scared of the board', 'Bring the 2 of spades next time', 'This is what top tier looks like', 'Elite table, elite books'],
    },
    backup: {
      friendly: ['Nice work, partner', 'Good teamwork right there'],
      competitive: ['Tell ’em, partner', 'That’s how we do it', 'Facts. We don’t miss'],
      elite: ['Said what I said 💅', 'Partner, they not ready for us', 'Light work. Next hand'],
    },
    reply: {
      friendly: ['Okay, okay, y’all got that one', 'Good hand, we’ll get the next one'],
      competitive: ['Relax, it’s one hand', 'Keep that same energy when we come back', 'Scoreboard ain’t final yet', 'Enjoy it, it won’t last'],
      elite: ['A lucky hand doesn’t make y’all elite', 'Cute. We’re still the better team', 'One set and they think they’re champions'],
    },
  },
  nilMade: { // the team whose Nil held
    lead: {
      friendly: ['Nil made! Didn’t think that was gonna happen', 'Whew, Nil held up'],
      competitive: ['Nil made. Y’all couldn’t catch me', 'Couldn’t touch me all hand'],
      elite: ['Nil made. Clean. Like always', 'Zero books, a hundred points. Easy', 'Y’all never had a chance at that Nil'],
    },
    backup: {
      friendly: ['Great Nil, partner!', 'Nice job covering that'],
      competitive: ['I had your back the whole way', 'That’s my partner right there'],
      elite: ['Covered like a pro', 'We make it look easy'],
    },
    reply: {
      friendly: ['Okay, nice Nil', 'Respect, that was a good Nil'],
      competitive: ['Next time we’re coming for that Nil', 'Lucky. Try that again'],
      elite: ['Enjoy it. That won’t happen twice', 'We let that one slide'],
    },
  },
  nilBroken: { // the team that broke the other team’s Nil
    lead: {
      friendly: ['Oof, sorry about the Nil', 'Got the Nil, sorry y’all'],
      competitive: ['Nil busted! Thank you, come again', 'There goes the Nil. Should’ve bid 2'],
      elite: ['A Nil? Against us? Come on now', 'Nobody hides from us'],
    },
    backup: {
      friendly: ['Good catch, partner', 'Tough break for them'],
      competitive: ['We saw that coming a mile away', 'Caught ’em slipping'],
      elite: ['Too easy, partner', 'They really thought that would work'],
    },
    reply: {
      friendly: ['Ha, worth a try', 'Ah well, we’ll still make our bid'],
      competitive: ['It’s fine, we’re still making the bid', 'Laugh now, we’ll get it back'],
      elite: ['One hand. We’re still running this', 'Don’t get comfortable'],
    },
  },
  run: { // the team that just took four tricks in a row
    lead: {
      friendly: ['Cards are being nice to us', 'On a little roll here'],
      competitive: ['Keep ’em coming', 'Book after book after book', 'You can’t hang with this'],
      elite: ['Too easy', 'We run this table', 'Take notes', 'Bring the 2 of spades next time'],
    },
    backup: {
      friendly: ['Keep it going!', 'Nice run, partner'],
      competitive: ['We locked in', 'Don’t stop now'],
      elite: ['They’re not ready for this', 'Partner, we’re just warming up'],
    },
    reply: {
      friendly: ['Okay, save some books for us', 'Y’all are rolling'],
      competitive: ['Enjoy it while it lasts', 'Long hand, we’re not done', 'Big talk, let’s see the final count'],
      elite: ['Lucky cards. We’re still the better team', 'Cute run. Watch this'],
    },
  },
  close: { // close score late in the game; lead is the team that is ahead
    lead: {
      friendly: ['Tight game, this is fun', 'Close one, let’s finish strong'],
      competitive: ['Close game, no mistakes now', 'Every book counts from here'],
      elite: ['Close? Nah. We’re just making it interesting', 'Pressure is a privilege. We live here'],
    },
    backup: {
      friendly: ['We got this, partner', 'Steady, steady'],
      competitive: ['We got this', 'Lock in, partner'],
      elite: ['This is our table', 'They know how this ends'],
    },
    reply: {
      friendly: ['Anybody’s game right now', 'Good game either way'],
      competitive: ['Nah, this one is ours', 'Y’all scared of the board?', 'We’re right there, don’t blink'],
      elite: ['We’ve been here before. Y’all haven’t', 'Watch how champions close'],
    },
  },
  gameEnd: { // the winning team
    lead: {
      friendly: ['gg everybody, that was fun', 'Good game, y’all'],
      competitive: ['That’s game. Run it back if you want another lesson', 'gg, put some respect on our names'],
      elite: ['We run this table. gg', 'That’s game. Y’all can take notes on the way out', 'Elite. gg though'],
    },
    backup: {
      friendly: ['Great game, partner', 'Fun one, y’all'],
      competitive: ['Told y’all', 'Never in doubt'],
      elite: ['Another one 💅', 'Like we said: our table'],
    },
    reply: {
      friendly: ['gg, y’all played well', 'Good game, run it back?'],
      competitive: ['Run it back. That was a warm-up', 'Lucky cards, that’s all that was', 'gg. Next one is ours'],
      elite: ['Enjoy it. That won’t happen again', 'Fine. gg. Rematch, right now'],
    },
  },
};

/** Every line a computer player can say (for the clean-words test). */
export function allChatLines(): string[] {
  const out: string[] = [...THREADS.flat(), ...QUIPS, ...HELLO, ...HELLO_BACK, ...GG_BACK, ...THANKS_BACK, ...LAUGH_BACK, ...QUESTION_BACK, ...BOTQ_BACK,
    ...GENERIC_BACK, ...TRASH_BACK, ...BIG_BID, ...NIL, ...WIN_TRICK, ...HUMAN_WIN_TRICK, ...SET, ...MADE, ...GAME_WIN, ...GAME_LOSE, ...Object.values(TRASH_LINES).flat()];
  for (const m of Object.values(MOMENT_LINES)) for (const part of [m.lead, m.backup, m.reply]) out.push(...Object.values(part).flat());
  return out;
}

/** Most lines the computer players say per hand (reply chains included), so the chat never floods. */
export const MAX_LINES_PER_HAND = 6;
/** Pause between reply chains. */
const CHAIN_GAP_MS = 20000;

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

// ---- trash talk: only bots with chatStyle 'trash' use these. Card-table smack only: clean, no insults about who people are. ----
/** Exported so tests can check that only trash talkers use them. */
export const TRASH_LINES = {
  bigBid: ['{N}? You sure about that? I got a spade for every one of those', '{N} books? Bold. Wrong, but bold', 'Bidding {N} with that hand? I’ll be watching', '{N}?! Somebody call the bank, you’re writing checks you can’t cash'],
  nil: ['Nil? Oh this is gonna be fun for me', 'Nil? I’m coming for you, no hiding', 'You went Nil? I hope you like eating books', 'Nil with those cards? Brave. Real brave'],
  nilBust: ['Nil busted! Thank you, come again 😂', 'There goes the Nil. Should’ve bid 2', 'Caught you! Nil is officially dead', 'That Nil lasted about as long as my patience'],
  win: ['Sit down', 'Mine. Again', 'Take notes', 'Too easy', 'You can’t hang with this', 'That’s called skill'],
  set: ['Set! Write that down 😂', 'Y’all got SET. Who taught you to bid?', 'Overbid and underdelivered', 'Set like a dinner table', 'Books don’t lie, y’all were short'],
  roast: ['I’ve seen better hands at a car wash', 'Y’all playing spades or go fish?', 'Somebody at this table is scared of their own spades', 'I could play this hand with my eyes closed', 'Don’t worry, losing builds character', 'Is this your first time? Be honest', 'My grandma bids better than this, and she’s been retired since ’98'],
  gameWin: ['Run it back if you want another lesson', 'gg, put some respect on my name', 'That’s game. Y’all can take notes on the way out', 'Easy money. gg though'],
  gameLose: ['Lucky cards, that’s all that was', 'Alright, you got me. Don’t get used to it', 'Run it back, that was a warm-up'],
  back: ['Talk is cheap, books are expensive', 'Keep talking, I’ll keep taking books', 'You talk a lot for somebody who’s losing', 'Cute. Now play a card', 'Say less, play more'],
};

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
  private linesThisHand = 0;   // rate limit: MAX_LINES_PER_HAND
  private lastChain = -Infinity;
  private run = { team: -1, count: 0 }; // tricks in a row by one team this hand

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

  /** nil: false when a 0 is a plain zero (team-minimum tables), so the Nil lines stay quiet. */
  onBid(seat: number, bid: number, nil = true): void {
    if (!this.ready() || this.cooling()) return;
    const bots = this.host.bots();
    const trash = this.trashOpponent(seat);
    if (bid === 0 && nil && this.chance(0.7)) return trash ? this.sayAs(trash, TRASH_LINES.nil) : this.sayOne(this.pickOther(bots, seat), NIL);
    if (bid >= 7 && this.chance(0.5)) return trash ? this.sayAs(trash, TRASH_LINES.bigBid, { N: String(bid) }) : this.sayOne(this.pickOther(bots, seat), BIG_BID, { N: String(bid) });
  }

  /** nilBust: the winner had bid Nil and this was their first trick. */
  onTrick(winner: number, nilBust = false): void {
    if (!this.ready()) return;
    const team = winner % 2;
    this.run = this.run.team === team ? { team, count: this.run.count + 1 } : { team, count: 1 };
    if (this.run.count === 4 && this.chain('run', team)) return;
    if (nilBust) {
      const trash = this.trashOpponent(winner);
      if (trash && this.chance(0.8)) return this.sayAs(trash, TRASH_LINES.nilBust);
    }
    if (this.cooling()) return;
    const bot = this.host.bots().find((b) => b.seat === winner);
    if (bot?.trash && this.chance(0.18)) return this.sayAs(bot, TRASH_LINES.win);
    if (bot && this.chance(0.1)) return this.sayAs(bot, WIN_TRICK);
    const human = this.host.humans().find((h) => h.seat === winner);
    if (human && this.chance(0.15)) return this.sayOne(this.pickOther(this.host.bots(), winner), HUMAN_WIN_TRICK, { H: human.name });
  }

  /** teamsMade: for each team, whether it made its bid (null if it had no bid).
   *  extra: Nil results ({team, made}) and the scores after the hand, for the big-moment reply chains. */
  onHandEnd(teamsMade: [boolean | null, boolean | null], extra: { nils?: { team: number; made: boolean }[]; scores?: [number, number]; target?: number } = {}): void {
    this.linesThisHand = 0;
    this.run = { team: -1, count: 0 };
    if (!this.ready()) return;
    // Big moments first: a set, a Nil made or broken, a close score late in the game
    if (teamsMade[0] === false && teamsMade[1] !== false && this.chain('set', 1)) return;
    if (teamsMade[1] === false && teamsMade[0] !== false && this.chain('set', 0)) return;
    const nil = extra.nils?.[0];
    if (nil && this.chain(nil.made ? 'nilMade' : 'nilBroken', nil.made ? nil.team : 1 - nil.team)) return;
    const sc = extra.scores;
    if (sc && extra.target && Math.abs(sc[0] - sc[1]) <= 40 && Math.max(sc[0], sc[1]) >= extra.target * 0.7 && this.chain('close', sc[0] >= sc[1] ? 0 : 1)) return;
    if (this.cooling() || !this.chance(0.6)) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    const bot = bots[Math.floor(this.host.rng() * bots.length)];
    const team = bot.seat % 2;
    const mine = teamsMade[team];
    // A trash talker whose team made it while the other team got set rubs it in
    const gloater = bots.find((b) => b.trash && teamsMade[b.seat % 2] !== false && teamsMade[(b.seat + 1) % 2] === false);
    if (gloater && this.chance(0.8)) return this.sayAs(gloater, TRASH_LINES.set);
    if (mine === false) return this.sayAs(bot, SET);
    if (mine === true) return this.sayAs(bot, MADE);
  }

  onGameEnd(winnerTeam: number): void {
    if (!this.ready()) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    this.linesThisHand = 0;
    this.lastChain = -Infinity; // the end of the game always gets its say
    if (this.chain('gameEnd', winnerTeam, 1500)) return;
    const bot = bots[Math.floor(this.host.rng() * bots.length)];
    const won = bot.seat % 2 === winnerTeam;
    const pool = bot.trash ? (won ? TRASH_LINES.gameWin : TRASH_LINES.gameLose) : won ? GAME_WIN : GAME_LOSE;
    this.later(1500 + this.rand(2500), () => this.sayAs(bot, pool, { H: this.firstHuman() }));
  }

  /** A person wrote in the chat: one bot answers, sometimes a second one joins in. */
  onHumanChat(fromName: string, text: string): void {
    if (!this.ready()) return;
    const bots = this.host.bots();
    if (!bots.length) return;
    const lower = text.toLowerCase();
    const named = bots.find((b) => lower.includes(b.name.toLowerCase()));
    const first = named ?? bots[Math.floor(this.host.rng() * bots.length)];
    let pool = this.replyPool(lower);
    if (first.trash && (pool === TRASH_BACK || pool === GENERIC_BACK) && this.chance(0.6)) pool = TRASH_LINES.back;
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
        if (bots.length) {
          const b = bots[Math.floor(this.host.rng() * bots.length)];
          this.sayAs(b, b.trash && this.chance(0.6) ? TRASH_LINES.roast : QUIPS);
        }
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

  /** A big moment: the lead team reacts, the partner backs them up, the other team answers (2-3 lines, a few
   *  seconds apart). Each speaker talks in their own attitude. False when nobody can speak or chains are cooling down. */
  private chain(moment: keyof typeof MOMENT_LINES, leadTeam: number, startMs = 800): boolean {
    if (Date.now() - this.lastChain < CHAIN_GAP_MS * this.pace) return false;
    const bots = this.host.bots();
    const team = (t: number) => bots.filter((b) => b.seat % 2 === t);
    const lead = team(leadTeam), other = team(1 - leadTeam);
    const m = MOMENT_LINES[moment];
    const steps: [Bot, string[]][] = [];
    const first = lead[Math.floor(this.host.rng() * lead.length)];
    if (first) {
      steps.push([first, m.lead[attitudeOf(first)]]);
      const mate = lead.find((b) => b.seat !== first.seat);
      if (mate && (attitudeOf(first) !== 'friendly' || this.chance(0.5))) steps.push([mate, m.backup[attitudeOf(mate)]]);
    }
    const answer = other.find((b) => attitudeOf(b) !== 'friendly') ?? other[0];
    if (answer) steps.push([answer, m.reply[attitudeOf(answer)]]);
    if (steps.length < 2) return false; // one line is not a back-and-forth; the normal reactions cover it
    this.lastChain = Date.now();
    let at = startMs;
    steps.forEach(([b, pool], i) => {
      if (i) at += 2500 + this.rand(1500);
      this.later(at, () => this.sayAs(b, pool, { H: this.firstHuman() }));
    });
    this.convoUntil = Date.now() + (at + 3000) * this.pace;
    return true;
  }

  private ready(): boolean { return this.on && this.host.humans().length > 0; }
  private cooling(): boolean { return Date.now() - this.lastSpoke < MIN_GAP_MS * this.pace || Date.now() < this.convoUntil; }
  private chance(p: number): boolean { return this.host.rng() < p; }
  private rand(n: number): number { return Math.floor(this.host.rng() * n); }
  private firstHuman(): string { return this.host.humans()[0]?.name ?? 'friend'; }

  /** A trash-talking bot on the other team from this seat, if one is seated. */
  private trashOpponent(seat: number): Bot | null {
    const list = this.host.bots().filter((b) => b.trash && b.seat % 2 !== seat % 2);
    return list.length ? list[Math.floor(this.host.rng() * list.length)] : null;
  }

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
    if (!text || this.linesThisHand >= MAX_LINES_PER_HAND) return;
    this.linesThisHand++;
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
