// One Spades table: seats (human or bot), the game, timers, spectators, and per-player views.
// The server is authoritative. view() gives a seated player only their own hand; spectators and
// queued players never receive any hand data.

import { CONFIG } from '../config.js';
import { Card, Rng, secureRng } from '../engine/cards.js';
import {
  CompletedTrick, EngineError, GameState, Team, createGame, legalPlays, nextHand, placeBid, playCard,
  teamOf, PlayOutcome,
} from '../engine/game.js';
import { Skill, chooseBid, choosePlay } from '../engine/bot.js';
import { BotChat } from './botchat.js';

export type SeatKind = 'empty' | 'bot' | 'human';
export type TableStatus = 'waiting' | 'playing' | 'finished';

export interface SeatInfo {
  kind: SeatKind;
  name: string;
  playerId: string | null;
  connected: boolean;       // socket is connected (humans only)
  botControlled: boolean;   // a bot is playing this human's seat until the next hand
  botActed: boolean;        // the bot has acted for this seat in the current hand
  disconnectedAt: number | null;
  ready: boolean;
  face?: string;            // bots only: id of a profile photo in public/faces
  chatStyle?: ChatStyle;    // bots only: 'trash' bots talk more smack in the chat
  skill?: Skill;            // bots only: 'strong' bots play better (src/engine/bot.ts)
}

export type ChatStyle = 'chill' | 'trash';

export type Timings = { -readonly [K in keyof typeof CONFIG.timing]: number };
export const defaultTimings = (): Timings => ({ ...CONFIG.timing });

export interface TableHooks {
  send(playerId: string, msg: object): void;
  changed(): void;
  destroyed(table: Table, participants: string[]): void;
  released(playerId: string, table: Table): void;
  matchOver?(table: Table, winner: Team, scores: [number, number], forfeit: boolean): void;
}

export interface TableInit {
  id: string;
  code: string;
  isPublic: boolean;
  target: number;
  breakRule?: boolean;
  sandbags?: boolean;
  hostId: string | null;
  practice?: boolean; // a solo table against bots: never listed, never joinable by anyone else
  teamMin?: number; // the partners' bids must add up to at least this (Premium-hosted tables); 0 or unset = regular spades
  quick?: boolean; // made by Quick play (random match): only changes how the table is labelled
  timings: Timings;
  hooks: TableHooks;
  rng?: Rng;
  tournament?: { id: string; matchId: string; label: string };
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

const BOT_NAMES = [
  'Ace', 'Duke', 'Queenie', 'Jax', 'Maverick', 'Sage', 'Rook', 'Dottie',
  'Blaze', 'Nova', 'Pip', 'Otis', 'Big Mike', 'Lil Tone', 'Peanut', 'Smoke',
  'Tank', 'Slim', 'Cash', 'Showtime', 'Ghost', 'Bishop', 'Truck',
  'Mookie', 'Boogie', 'Pooh', 'Scoop', 'Juice', 'Fats', 'Money Mal', 'Cookie',
  'Shorty', 'Tito', 'Sticks', 'Rico', 'Deuce', 'Squeaky', 'Biscuit', 'Gizmo',
  'Rell', 'Tay', 'Nene', 'Keke', 'Mama Jo', 'Auntie Em', 'Big Cuz',
  'Low', 'Zeke', 'Flip', 'Hustle', 'Pockets', 'Dollar', 'Big Hen', 'Lucky',
  'Spade Dad', 'Sweets', 'Cheeks', 'Bam', 'Hollis', 'Crenshaw', 'Flatbush', 'Lenox',
  'Broad St', 'Southside', 'Eastside', 'Westside', 'Northside', 'The Block', '5th Ward', 'Uptown',
  'Eastwick', 'Lakeview', 'Rosedale', 'Parkway', 'Marcy', 'Fulton', 'Jefferson', 'Division',
  'Atlas', 'Domino', 'Dap', 'Loc', 'Gunner', 'Sarge', 'Moe', 'Chilly',
  'Pinky', 'Wavy', 'Kilo', 'Big Sis', 'Lil Ray', 'Mook', 'CJ', 'June',
  'Boots', 'Rocco', 'Tre', 'Cap', 'Rude Boy', 'OG Ray', 'Tea', 'Ride',
  'Cuz', 'Pop', 'Nikki B',
];

/** Bots that come with a photo (public/faces/<face>.jpg). "Raw 1" is the owner's own. */
export const FACE_BOTS: { name: string; face: string }[] = [
  { name: 'Marcus', face: 'marcus' }, { name: 'Tasha', face: 'tasha' }, { name: 'Luis', face: 'luis' },
  { name: 'Keisha', face: 'keisha' }, { name: 'Big Jerome', face: 'jerome' }, { name: 'Mari', face: 'mari' },
  { name: 'Dre', face: 'dre' }, { name: 'Miss Pearl', face: 'pearl' }, { name: 'Cooper', face: 'cooper' }, { name: 'Kim', face: 'kim' },
  // Not every player uses a selfie: cars, graphics, pets and cartoon avatars (all original, no real people or brands)
  { name: 'Lowrider Lou', face: 'lowrider' }, { name: 'King Spade', face: 'crown' }, { name: 'Midnight Moe', face: 'muscle' },
  { name: 'Fresh Kicks', face: 'kicks' }, { name: 'Brick', face: 'pitbull' }, { name: 'Big Cat Leo', face: 'lion' },
  { name: 'Red Hood Rome', face: 'anime2' }, { name: 'Four Aces', face: 'aces' }, { name: 'Whiskers', face: 'cat' },
  { name: 'Buckets', face: 'hoops' }, { name: 'Spray Can Sam', face: 'graffiti' }, { name: 'Lone Wolf', face: 'wolf' },
  { name: 'Granny Hands', face: 'granny' }, { name: 'Boombox Benny', face: 'boombox' }, { name: 'Purple Rain', face: 'anime1' },
  { name: 'Chopper Chuck', face: 'chopper' },
];
export const RAW_ONE = { name: 'Raw 1', face: 'raw1' };

export interface ChatLine { from: string; role: 'player' | 'watcher'; text: string; ts: number; by: string }

export class Table {
  readonly id: string;
  readonly code: string;
  readonly isPublic: boolean;
  target: number;
  breakRule: boolean;
  sandbags: boolean;
  readonly tournament?: { id: string; matchId: string; label: string };
  hostId: string | null;
  /** Who created the table; unlike hostId it never passes to someone else when the host leaves. Null for tournament tables. */
  readonly creatorId: string | null;
  readonly practice: boolean;
  readonly quick: boolean;
  teamMin: number;
  seats: SeatInfo[] = [0, 1, 2, 3].map(() => emptySeat());
  watchers = new Set<string>();
  waiters: string[] = [];                 // watchers who asked for a seat; seated between hands
  private waiterNames = new Map<string, string>();
  game: GameState | null = null;
  status: TableStatus = 'waiting';
  pause: CompletedTrick | null = null;    // end of a hand: the last trick is shown and play is blocked
  collect: CompletedTrick | null = null;  // mid-hand: the completed trick stays visible but does NOT block the next lead
  /** Last CONFIG.chat.history chat lines; cleared with the table. Chat never carries hands. */
  chat: ChatLine[] = [];
  private chatSent = new Set<string>();      // people who already got the history since they (re)joined
  forfeit = false;
  fastForward = false;
  teamHadHumans: [boolean, boolean] = [false, false];

  private timings: Timings;
  private hooks: TableHooks;
  private rng: Rng;
  private timer: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private collectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private endTimer: NodeJS.Timeout | null = null;
  private dead = false;
  private botChat: BotChat;

  constructor(init: TableInit) {
    this.id = init.id;
    this.code = init.code;
    this.isPublic = init.isPublic;
    this.target = init.target;
    this.breakRule = init.breakRule ?? true;
    this.sandbags = init.sandbags ?? true;
    this.hostId = init.hostId;
    this.creatorId = init.hostId;
    this.practice = init.practice === true;
    this.quick = init.quick === true;
    this.teamMin = init.teamMin ?? 0;
    this.timings = init.timings;
    this.hooks = init.hooks;
    this.rng = init.rng ?? secureRng;
    this.botChat = new BotChat({
      rng: this.rng,
      bots: () => this.seats.map((s, i) => ({ seat: i, name: s.name, kind: s.kind, trash: s.chatStyle === 'trash' })).filter((b) => b.kind === 'bot'),
      humans: () => this.seats.map((s, i) => ({ seat: i, name: s.name, kind: s.kind, on: s.connected })).filter((h) => h.kind === 'human' && h.on),
      say: (seat, name, text) => this.postBotChat(seat, name, text),
      playing: () => this.status === 'playing',
    }, init.tournament ? 0 : this.timings.botChatPace ?? 0);
    this.tournament = init.tournament;
  }

  // ---------- seats and people ----------

  seatOf(pid: string): number {
    return this.seats.findIndex((s) => s.kind === 'human' && s.playerId === pid);
  }
  isWatching(pid: string): boolean { return this.watchers.has(pid); }
  hasPerson(pid: string): boolean { return this.seatOf(pid) >= 0 || this.watchers.has(pid); }
  private humans(): SeatInfo[] { return this.seats.filter((s) => s.kind === 'human'); }
  connectedHumans(): number { return this.humans().filter((s) => s.connected).length; }
  humanCount(): number { return this.humans().length; }
  participants(): string[] {
    return [...this.humans().map((s) => s.playerId as string), ...this.watchers];
  }
  /** Seats a new player could take right now (empty seats before start, bot seats after). */
  openSeats(): number {
    if (this.tournament) return 0;
    const free = this.seats.filter((s) => s.kind === 'empty' || s.kind === 'bot').length;
    return Math.max(0, free - this.waiters.length);
  }

  /** Pick a name (and sometimes a photo) for a new bot: never one already at this table. */
  private botPersona(): { name: string; face?: string; chatStyle: ChatStyle; skill: Skill } {
    const chatStyle: ChatStyle = this.rng() < CONFIG.botPersonality.trashChance ? 'trash' : 'chill';
    const skill: Skill = this.rng() < CONFIG.botPersonality.strongChance ? 'strong' : 'normal';
    const used = new Set(this.seats.map((s) => s.name));
    if (!used.has(RAW_ONE.name) && this.rng() < CONFIG.botFaces.rawOneChance) return { ...RAW_ONE, chatStyle, skill };
    const faces = FACE_BOTS.filter((f) => !used.has(f.name));
    if (faces.length && this.rng() < CONFIG.botFaces.chance) return { ...faces[Math.floor(this.rng() * faces.length)], chatStyle, skill };
    const free = BOT_NAMES.filter((n) => !used.has(n));
    return { name: free.length ? free[Math.floor(this.rng() * free.length)] : 'Bot', chatStyle, skill };
  }

  /** Put a human directly in a seat (used for tournament match setup and by sit()). */
  seatHuman(seat: number, pid: string, name: string, connected: boolean): void {
    this.seats[seat] = { ...emptySeat(), kind: 'human', name, playerId: pid, connected };
    this.watchers.delete(pid);
    this.waiters = this.waiters.filter((w) => w !== pid);
    if (this.hostId === null && !this.tournament) this.hostId = pid;
  }
  seatBot(seat: number): void {
    this.seats[seat] = { ...emptySeat(), kind: 'bot', ...this.botPersona() };
  }
  seatNamedBot(seat: number, name: string): void {
    this.seats[seat] = { ...emptySeat(), kind: 'bot', name };
  }

  /** Ask for a seat: immediate if one is free before the game / between hands, otherwise queued. */
  sit(pid: string, name: string, connected = true): Result<{ queued: boolean }> {
    if (this.tournament) return fail('not_allowed', 'Tournament tables cannot be joined');
    if (this.seatOf(pid) >= 0) return { ok: true, queued: false };
    if (this.waiters.includes(pid)) return { ok: true, queued: true };
    if (this.openSeats() <= 0) return fail('full', 'This table has no open seat');
    const betweenHands = this.status !== 'playing' || (this.game?.phase === 'handOver' && !this.pause);
    if (betweenHands) {
      const idx = this.seats.findIndex((s) => s.kind === 'empty');
      const i = idx >= 0 ? idx : this.seats.findIndex((s) => s.kind === 'bot');
      this.seatHuman(i, pid, name, connected);
    } else {
      this.waiters.push(pid);
      this.waiterNames.set(pid, name);
      this.watchers.add(pid);
    }
    this.afterPeopleChange();
    return { ok: true, queued: !betweenHands };
  }

  watch(pid: string): Result {
    if (this.seatOf(pid) >= 0) return { ok: true };
    this.watchers.add(pid);
    this.broadcast();
    this.hooks.changed();
    return { ok: true };
  }

  unwatch(pid: string): void {
    const had = this.watchers.delete(pid);
    this.chatSent.delete(pid);
    this.waiters = this.waiters.filter((w) => w !== pid);
    this.waiterNames.delete(pid);
    if (had) { this.broadcast(); this.hooks.changed(); }
  }

  /** A person leaves for good: seated humans become bots (or empty seats before the game starts). */
  leave(pid: string): void {
    const i = this.seatOf(pid);
    if (i < 0) { this.unwatch(pid); return; }
    if (this.status === 'waiting') this.seats[i] = emptySeat();
    else this.seatBot(i);
    if (this.hostId === pid) {
      const next = this.humans().find((s) => s.connected) ?? this.humans()[0];
      this.hostId = next ? (next.playerId as string) : null;
    }
    this.afterPeopleChange();
  }

  setConnected(pid: string, connected: boolean): void {
    const i = this.seatOf(pid);
    if (i < 0) { if (!connected) this.unwatch(pid); return; }
    const s = this.seats[i];
    s.connected = connected;
    if (!connected) {
      this.chatSent.delete(pid); // resend the history when they come back
      s.disconnectedAt = Date.now();
      s.botControlled = true; // a bot plays this seat right away
    } else {
      s.disconnectedAt = null;
      // Retake the seat now if no bot has acted for it this hand (or between hands); otherwise at the next hand
      const inHand = this.status === 'playing' && (this.game?.phase === 'bidding' || this.game?.phase === 'playing');
      if (!inHand || !s.botActed) s.botControlled = false;
    }
    this.afterPeopleChange();
  }

  private afterPeopleChange(): void {
    this.broadcast();
    this.hooks.changed();
    this.evaluateAbsence();
    this.advance();
  }

  // ---------- starting ----------

  start(pid: string): Result {
    if (this.status !== 'waiting') return fail('wrong_state', 'Game already started');
    if (pid !== this.hostId) return fail('not_allowed', 'Only the host can start');
    this.startGame();
    return { ok: true };
  }

  /** Host only, before the game starts: change target / break rule / sandbags. */
  setRules(pid: string, patch: { target?: number; breakRule?: boolean; sandbags?: boolean; teamMin4?: boolean }): Result {
    if (this.status !== 'waiting') return fail('wrong_state', 'Rules can only be changed before the game starts');
    if (pid !== this.hostId) return fail('not_allowed', 'Only the host can change the rules');
    if (patch.target !== undefined) {
      if (!(CONFIG.tableTargets as readonly number[]).includes(patch.target)) return fail('bad_message', 'Bad target score');
      this.target = patch.target;
    }
    if (patch.breakRule !== undefined) this.breakRule = patch.breakRule;
    if (patch.sandbags !== undefined) this.sandbags = patch.sandbags;
    // Bidding rule (Premium-hosted tables only; Play now / quick and practice tables always use regular bidding)
    if (patch.teamMin4 !== undefined && !this.quick && !this.practice) this.teamMin = patch.teamMin4 ? CONFIG.rules.premiumTeamMin : 0;
    this.broadcast();
    this.hooks.changed();
    return { ok: true };
  }

  /** Host only, before the game starts: fill every open seat with a bot. */
  addBots(pid: string): Result {
    if (this.status !== 'waiting') return fail('wrong_state', 'Game already started');
    if (pid !== this.hostId) return fail('not_allowed', 'Only the host can add bots');
    this.seats.forEach((s, i) => { if (s.kind === 'empty') this.seatBot(i); });
    this.broadcast();
    this.hooks.changed();
    return { ok: true };
  }

  /** Host only, before the game starts: rotate the three non-host seats so the host gets a different partner
   *  (the host keeps seat 1). Each press moves everyone one place; three presses return to the start. */
  swapPartners(pid: string): Result {
    if (this.status !== 'waiting') return fail('wrong_state', 'Game already started');
    if (pid !== this.hostId) return fail('not_allowed', 'Only the host can swap partners');
    const hostSeat = this.seatOf(pid);
    const ring = [0, 1, 2, 3].filter((i) => i !== hostSeat);
    if (hostSeat < 0 || ring.length !== 3) return fail('not_seated', 'Take a seat first');
    const saved = ring.map((i) => this.seats[i]);
    ring.forEach((seat, k) => { this.seats[seat] = saved[(k + 2) % 3]; });
    this.broadcast();
    this.hooks.changed();
    return { ok: true };
  }

  /** Fill empty seats with bots and deal. Used by the host, quick-play and tournaments. */
  startGame(): void {
    this.seats.forEach((s, i) => { if (s.kind === 'empty') this.seatBot(i); });
    this.teamHadHumans = [0, 1].map((t) => this.seats.some((s, i) => i % 2 === t && s.kind === 'human')) as [boolean, boolean];
    this.game = createGame({ target: this.target, breakRule: this.breakRule, sandbags: this.sandbags, teamMin: this.teamMin, rng: this.rng, dealer: Math.floor(this.rng() * 4) });
    this.status = 'playing';
    this.resetHandFlags();
    this.broadcast();
    this.hooks.changed();
    this.evaluateAbsence();
    this.botChat.start();
    this.advance();
  }

  rematch(pid: string): Result {
    if (this.tournament) return fail('not_allowed', 'No rematch in a tournament');
    if (this.status !== 'finished') return fail('wrong_state', 'Game is not finished');
    if (pid !== this.hostId) return fail('not_allowed', 'Only the host can start a rematch');
    this.seatWaiters();
    this.startGame();
    return { ok: true };
  }

  ready(pid: string): Result {
    const i = this.seatOf(pid);
    if (i < 0) return fail('not_seated', 'You are not seated');
    this.seats[i].ready = true;
    this.broadcast();
    this.advance();
    return { ok: true };
  }

  // ---------- actions ----------

  bid(pid: string, bid: number): Result {
    const g = this.game;
    const i = this.seatOf(pid);
    if (i < 0) return fail('not_seated', 'Spectators cannot act');
    if (!g || this.status !== 'playing' || this.pause) return fail('wrong_state', 'Not now');
    if (this.seats[i].botControlled) return fail('wrong_state', 'A bot is playing your seat until the next hand');
    try { placeBid(g, i, bid); } catch (e) { return this.engineFail(e); }
    this.botChat.onBid(i, bid);
    this.broadcast();
    this.advance();
    return { ok: true };
  }

  play(pid: string, card: Card): Result {
    const g = this.game;
    const i = this.seatOf(pid);
    if (i < 0) return fail('not_seated', 'Spectators cannot act');
    if (!g || this.status !== 'playing' || this.pause) return fail('wrong_state', 'Not now');
    if (this.seats[i].botControlled) return fail('wrong_state', 'A bot is playing your seat until the next hand');
    let out: PlayOutcome;
    try { out = playCard(g, i, card); } catch (e) { return this.engineFail(e); }
    this.afterPlay(out);
    return { ok: true };
  }

  private engineFail(e: unknown) {
    if (e instanceof EngineError) return fail('illegal', e.message);
    throw e;
  }

  private afterPlay(out: PlayOutcome): void {
    if (out.trick) {
      const w = out.trick.winner;
      const nilBust = this.game?.bids[w] === 0 && this.game.tricksWon[w] === 1; // a Nil bid just took its first trick
      this.botChat.onTrick(w, nilBust);
    }
    if (out.handDone && this.game?.lastHand) { const r = this.game.lastHand.teams; this.botChat.onHandEnd([r[0].made, r[1].made]); }
    const pauseMs = this.fastForward ? 0 : this.timings.trickPauseMs;
    if (out.trick && pauseMs > 0 && !out.handDone) {
      // The hand goes on: show the finished trick (and its winner) for a moment, but let the winner lead at once.
      this.collect = out.trick;
      if (this.collectTimer) clearTimeout(this.collectTimer);
      this.collectTimer = setTimeout(() => { this.collect = null; this.collectTimer = null; this.broadcast(); }, pauseMs);
      this.afterPause();
      return;
    }
    if (out.trick && pauseMs > 0) {
      this.pause = out.trick;
      this.broadcast();
      this.pauseTimer = setTimeout(() => { this.pause = null; this.pauseTimer = null; this.afterPause(); }, pauseMs);
      return;
    }
    this.afterPause();
  }

  private afterPause(): void {
    if (this.dead) return;
    if (this.game?.phase === 'gameOver') this.finishGame(false);
    this.broadcast();
    this.advance();
  }

  private finishGame(forfeit: boolean): void {
    if (this.status === 'finished') return;
    this.status = 'finished';
    this.forfeit = forfeit;
    this.clearTimer();
    this.hooks.changed();
    const g = this.game as GameState;
    if (g.winner !== null && !forfeit) this.botChat.onGameEnd(g.winner);
    if (this.tournament && this.hooks.matchOver) {
      const winner = g.winner as Team;
      const wait = this.fastForward || forfeit ? Math.min(this.timings.matchEndPauseMs, forfeit ? 2000 : 0) : this.timings.matchEndPauseMs;
      this.endTimer = setTimeout(() => this.hooks.matchOver?.(this, winner, [g.scores[0], g.scores[1]], forfeit), wait);
    }
  }

  /** Tournament forfeit: the other team wins at once. */
  private forfeitTeam(losing: Team): void {
    const g = this.game;
    if (!g || this.status !== 'playing') return;
    g.winner = (1 - losing) as Team;
    g.phase = 'gameOver';
    this.pause = null;
    this.finishGame(true);
    this.broadcast();
  }

  // ---------- driving the game (bots, timers) ----------

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private botControls(i: number): boolean {
    const s = this.seats[i];
    return s.kind === 'bot' || (s.kind === 'human' && s.botControlled);
  }

  /** Decide what happens next: wait for a human, schedule a bot move, or schedule the next hand. */
  advance(): void {
    if (this.dead || this.status !== 'playing' || !this.game) return;
    this.clearTimer();
    if (this.pause) return;
    const g = this.game;
    if (this.connectedHumans() === 0 && !this.fastForward) return; // paused until someone returns (or abandon rules apply)
    if (g.phase === 'handOver') {
      const everyoneReady = this.humans().filter((s) => s.connected).every((s) => s.ready);
      const wait = this.fastForward || everyoneReady ? 0 : this.timings.handPauseMs;
      this.timer = setTimeout(() => this.startNextHand(), wait);
      return;
    }
    if (g.phase === 'gameOver') return;
    if (!this.botControls(g.turn)) return; // waiting for a connected human
    const delay = this.fastForward || this.connectedHumans() === 0 ? 0 : this.timings.botDelayMs;
    this.timer = setTimeout(() => this.botMove(), delay);
  }

  /** Seat's bot skill: a seated bot's own skill; a bot standing in for a person plays normally. */
  private skillOf(seat: number): Skill {
    const s = this.seats[seat];
    return s.kind === 'bot' ? s.skill ?? 'normal' : 'normal';
  }

  private botMove(): void {
    this.timer = null;
    const g = this.game;
    if (!g || this.status !== 'playing' || this.pause || !this.botControls(g.turn)) return;
    const seat = g.turn;
    const s = this.seats[seat];
    try {
      if (g.phase === 'bidding') {
        const bid = chooseBid(g, seat, this.skillOf(seat));
        placeBid(g, seat, bid);
        if (s.kind === 'bot') this.botChat.onBid(seat, bid);
        if (s.kind === 'human') s.botActed = true;
        this.broadcast();
        this.advance();
      } else if (g.phase === 'playing') {
        const out = playCard(g, seat, choosePlay(g, seat, this.skillOf(seat)));
        if (s.kind === 'human') s.botActed = true;
        this.afterPlay(out);
      }
    } catch (e) {
      // Should never happen; fall back to the first legal card so the game cannot stall.
      if (g.phase === 'playing') this.afterPlay(playCard(g, seat, legalPlays(g, seat)[0]));
      else throw e;
    }
  }

  private resetHandFlags(): void {
    for (const s of this.seats) { s.ready = false; s.botActed = false; }
  }

  private startNextHand(): void {
    this.timer = null;
    const g = this.game;
    if (!g || g.phase !== 'handOver' || this.status !== 'playing') return;
    this.collect = null;
    // Humans who reconnected during the last hand take their seats back now
    for (const s of this.seats) if (s.kind === 'human' && s.connected) s.botControlled = false;
    this.releaseStaleSeats();
    this.seatWaiters();
    nextHand(g);
    this.resetHandFlags();
    this.broadcast();
    this.hooks.changed();
    this.advance();
  }

  private releaseStaleSeats(): void {
    if (this.waiters.length === 0) return;
    const now = Date.now();
    this.seats.forEach((s, i) => {
      if (s.kind === 'human' && !s.connected && s.disconnectedAt !== null &&
          now - s.disconnectedAt > this.timings.seatHoldMs && this.waiters.length > 0) {
        const pid = s.playerId as string;
        this.seatBot(i);
        this.hooks.released(pid, this);
      }
    });
  }

  private seatWaiters(): void {
    while (this.waiters.length > 0) {
      const i = this.seats.findIndex((s) => s.kind === 'bot' || s.kind === 'empty');
      if (i < 0) break;
      const pid = this.waiters.shift() as string;
      const name = this.waiterNames.get(pid) ?? 'Player';
      this.waiterNames.delete(pid);
      this.seatHuman(i, pid, name, true);
    }
  }

  // ---------- absence rules (idle tables, tournament forfeits) ----------

  /** Normal tables: destroy when abandoned. Tournament tables: forfeit or fast-forward. */
  private evaluateAbsence(): void {
    if (this.dead) return;
    if (this.tournament) { this.evaluateTournamentAbsence(); return; }
    if (this.humanCount() === 0) { // nobody left to play for (spectators alone do not keep a table alive)
      this.setIdle(null, 0);
      queueMicrotask(() => this.destroy());
      return;
    }
    this.setIdle(this.connectedHumans() === 0, this.timings.emptyTableTtlMs, () => this.destroy());
  }

  /** Arm (once) or clear the idle timer. */
  private setIdle(needed: boolean | null, ms: number, fn?: () => void): void {
    if (!needed) { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = null; return; }
    if (this.idleTimer) return; // already counting down
    this.idleTimer = setTimeout(() => { this.idleTimer = null; fn?.(); }, ms);
  }

  private teamHumans(t: number): SeatInfo[] {
    return this.seats.filter((s, i) => i % 2 === t && s.kind === 'human');
  }

  private evaluateTournamentAbsence(): void {
    if (this.status !== 'playing') { this.setIdle(null, 0); return; }
    // Every human of a team left for good: the other team advances (if it has humans)
    for (const t of [0, 1] as Team[]) {
      if (this.teamHadHumans[t] && this.teamHumans(t).length === 0 && this.teamHumans(1 - t).length > 0) {
        this.forfeitTeam(t);
        return;
      }
    }
    if (this.humanCount() === 0) { this.fastForward = true; this.setIdle(null, 0); return; }
    const absent = (t: number) => this.teamHadHumans[t] && this.teamHumans(t).every((s) => !s.connected);
    const needed = this.connectedHumans() === 0 || absent(0) || absent(1);
    this.setIdle(needed, this.timings.abandonMs, () => {
      if (this.status !== 'playing') return;
      if (this.connectedHumans() === 0) { this.fastForward = true; this.advance(); return; }
      for (const t of [0, 1] as Team[]) if (absent(t)) { this.forfeitTeam(t); return; }
    });
  }

  // ---------- views ----------

  private phaseFor(): string {
    if (this.status === 'waiting' || !this.game) return 'waiting';
    if (this.pause) return 'playing';
    return this.game.phase === 'gameOver' ? 'finished' : this.game.phase;
  }

  /** Snapshot for one person. Only a seated player gets `hand`/`legal`; everyone else sees public info only. */
  view(pid: string): object {
    const g = this.game;
    const me = this.seatOf(pid);
    const phase = this.phaseFor();
    const mine = me >= 0 ? this.seats[me] : null;
    const myTurn = !!g && me >= 0 && g.turn === me && !this.pause && !mine?.botControlled && this.status === 'playing';
    const view: Record<string, unknown> = {
      t: 'table',
      id: this.id,
      code: this.code,
      isPublic: this.isPublic,
      practice: this.practice,
      quick: this.quick,
      bidRules: { minBid: CONFIG.rules.minBid, maxBid: CONFIG.rules.maxBid, allowNil: CONFIG.rules.allowNil, teamMin: this.teamMin },
      target: this.target,
      rules: { target: this.target, breakRule: this.breakRule, sandbags: this.sandbags },
      hostSeat: this.hostId ? this.seatOf(this.hostId) : -1,
      phase,
      mySeat: me,
      spectator: me < 0,
      queued: this.waiters.includes(pid),
      spectators: this.watchers.size,
      isHost: pid === this.hostId,
      openSeats: this.openSeats(),
      botControlled: !!mine?.botControlled,
      seats: this.seats.map((s, i) => ({
        kind: s.kind,
        name: s.name,
        face: s.kind === 'bot' ? s.face : undefined,
        connected: s.kind === 'human' ? s.connected : true,
        botControlled: s.kind === 'human' && s.botControlled,
        cards: g ? g.hands[i].length : 0,
        bid: g ? g.bids[i] : null,
        tricks: g ? g.tricksWon[i] : 0,
        ready: s.ready,
      })),
      dealer: g ? g.dealer : null,
      handNo: g ? g.handNo : 0,
      turn: g && this.status === 'playing' && !this.pause && (g.phase === 'bidding' || g.phase === 'playing') ? g.turn : null,
      trick: this.pause ? this.pause.plays : g ? g.trick : [],
      trickWinner: this.pause ? this.pause.winner : null,
      collect: this.collect && !this.pause ? { plays: this.collect.plays, winner: this.collect.winner } : null,
      lastTrick: g?.lastTrick ?? null,
      spadesBroken: g ? g.spadesBroken : false,
      scores: g ? g.scores : [0, 0],
      bags: g ? g.bags : [0, 0],
      lastHand: g?.lastHand ?? null,
      winner: this.status === 'finished' && g ? g.winner : null,
      forfeit: this.forfeit,
      tournament: this.tournament ? { id: this.tournament.id, label: this.tournament.label } : null,
    };
    if (g && me >= 0) {
      view.hand = g.hands[me];
      view.legal = myTurn && g.phase === 'playing' ? legalPlays(g, me) : [];
      view.canBid = myTurn && g.phase === 'bidding';
    }
    return view;
  }

  broadcast(): void {
    if (this.dead) return;
    for (const s of this.seats) {
      if (s.kind === 'human' && s.connected) { this.hooks.send(s.playerId as string, this.view(s.playerId as string)); this.sendChatHistory(s.playerId as string); }
    }
    for (const w of this.watchers) { this.hooks.send(w, this.view(w)); this.sendChatHistory(w); }
  }

  // ---------- chat ----------

  private sendChatHistory(pid: string): void {
    if (this.chatSent.has(pid)) return;
    this.chatSent.add(pid);
    this.hooks.send(pid, { t: 'chatHistory', table: this.id, msgs: this.chat.map((l) => this.chatOut(l, pid)) });
  }

  private chatOut(l: ChatLine, to: string) {
    return { from: l.from, role: l.role, text: l.text, ts: l.ts, mine: l.by === to };
  }

  /** Post a (pre-sanitized) message from a seated player or a watcher and send it to everyone at the table. */
  postChat(pid: string, name: string, text: string): boolean {
    if (this.dead || !this.hasPerson(pid)) return false;
    this.pushChat({ from: name, role: this.seatOf(pid) >= 0 ? 'player' : 'watcher', text, ts: Date.now(), by: pid });
    this.botChat.onHumanChat(name, text);
    return true;
  }

  /** A bot says something at the table (see botchat.ts). */
  private postBotChat(seat: number, name: string, text: string): void {
    if (this.dead || this.seats[seat]?.kind !== 'bot' || this.seats[seat].name !== name) return;
    this.pushChat({ from: name, role: 'player', text, ts: Date.now(), by: `bot:${seat}` });
  }

  private pushChat(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CONFIG.chat.history) this.chat.splice(0, this.chat.length - CONFIG.chat.history);
    for (const s of this.seats) {
      if (s.kind === 'human' && s.connected) this.hooks.send(s.playerId as string, { t: 'chatMsg', table: this.id, ...this.chatOut(line, s.playerId as string) });
    }
    for (const w of this.watchers) this.hooks.send(w, { t: 'chatMsg', table: this.id, ...this.chatOut(line, w) });
  }

  // ---------- teardown ----------

  destroy(): void {
    if (this.dead) return;
    const people = this.participants();
    this.dispose();
    this.hooks.destroyed(this, people);
  }

  dispose(): void {
    this.dead = true;
    this.botChat.stop();
    this.chat = [];
    this.chatSent.clear();
    for (const t of [this.timer, this.pauseTimer, this.collectTimer, this.idleTimer, this.endTimer]) if (t) clearTimeout(t);
    this.timer = this.pauseTimer = this.collectTimer = this.idleTimer = this.endTimer = null;
  }

  teamOfSeat(i: number): Team { return teamOf(i); }
}

function emptySeat(): SeatInfo {
  return { kind: 'empty', name: '', playerId: null, connected: false, botControlled: false, botActed: false, disconnectedAt: null, ready: false };
}
