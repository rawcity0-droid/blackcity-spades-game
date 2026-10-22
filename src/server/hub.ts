// Hub: players, tables, tournaments, the lobby, free-vs-paid checks, and message routing.
// Transport-agnostic: server.ts feeds it WebSocket events. Each player has a stable id derived from
// their reconnect token; the subscription store is keyed by that id.

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { CONFIG, formatPrice } from '../config.js';
import { Rng, secureRng } from '../engine/cards.js';
import { Team } from '../engine/game.js';
import { CODE_ALPHABET, ClientMsg, EMAIL_RE, ErrorCode, RateLimiter, parseClientMessage } from './protocol.js';
import { EventTableEntry, TableEvent } from './event.js';
import { Billing, BillingError } from './billing.js';
import { isTestNick, logActivity } from './activity.js';
import { SubscriptionStore } from './subscriptions.js';
import { Table, Timings, defaultTimings } from './table.js';
import { Match, Tournament } from './tournament.js';

export interface Player {
  id: string;
  token: string;
  nick: string;
  ws: WebSocket | null;
  tableId: string | null;       // table where this player holds a seat (or is queued for one)
  watchTableId: string | null;  // table being watched read-only
  tournamentId: string | null;
  eventId: string | null;       // multi-table event ("Create Tournament")
  lastSeen: number;
  face?: string;                // picked avatar (already checked by validAvatar); none = a fixed random one
}

export interface Conn {
  ws: WebSocket;
  player: Player | null;
  limiter: RateLimiter;
  strikes: number;
  /** Timestamps of recent Restore Premium attempts on this connection. */
  restoreTries: number[];
  confirmTries: number[];
  checkoutTries: number[];
  chatTries: number[];
  /** Origin used for Stripe success/cancel URLs (from the upgrade request, or PUBLIC_BASE_URL). */
  baseUrl: string;
  /** Client IP (for the owner-code lockout only; never logged). */
  ip: string;
}

export interface HubOptions {
  /** Stripe billing. Default: disabled (Go Premium says billing is not set up). Tests inject one pointing at a mock. */
  billing?: Billing;
  /** Overrides CONFIG.ownerEmails (tests). */
  ownerEmails?: string[];
  /** Overrides process.env.OWNER_CODE (tests). Must be exactly 6 digits, otherwise the owner code is off. */
  ownerCode?: string;
  timings?: Partial<Timings>;
  devUnlock?: boolean;
  store?: SubscriptionStore;
  rng?: Rng;
  rateLimit?: { burst: number; perSecond: number }; // tests raise this
}

export const hostIdFromToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

export const upgradeMessage = (): string => `Upgrade to host — $${formatPrice(CONFIG.subscriptionPriceUsdPerMonth)}/month`;
export const inviteMessage = (): string => 'Playing with others needs an invite from a Premium host, or go Premium to host your own';
export const hostNotPremiumMessage = (): string => 'That game was not made by a Premium host, so free players cannot join it. Ask a Premium host for a code, or go Premium';

const NAME_REQUIRED: ReadonlySet<string> = new Set([
  'createTable', 'joinTable', 'watchTable', 'joinCode', 'watchCode', 'quickPlay', 'createFriend',
  'createTournament', 'joinTournament', 'watchTournament', 'createEvent',
]);

const UNREACHABLE = 'We couldn’t reach the billing service. Try again in a moment.';

export class Hub {
  players = new Map<string, Player>();            // by player id
  private byToken = new Map<string, Player>();
  tables = new Map<string, Table>();
  tournaments = new Map<string, Tournament>();
  events = new Map<string, TableEvent>();
  private codes = new Map<string, { kind: 'table' | 'tournament' | 'event' | 'tournamentTeam' | 'eventTeam'; id: string }>(); // *Team: a player-made team code
  readonly store: SubscriptionStore;
  readonly devUnlock: boolean;
  private ownerEmails: Set<string>;
  private ownerCode: Buffer | null;
  /** Wrong owner-code tries (timestamps), per player id and per IP. */
  private codeFails = new Map<string, number[]>();
  readonly billing: Billing;
  private recheckTried = new Map<string, number>();
  private restoreTriesAll: number[] = [];
  private timings: Timings;
  private rng: Rng;
  private rate: { burst: number; perSecond: number };
  private lobbyTimer: NodeJS.Timeout | null = null;
  /** Free players waiting for random opponents (Quick play), oldest first. */
  private matchQueue: { id: string; since: number }[] = [];
  private matchTimer: NodeJS.Timeout | null = null;
  connections = 0;

  constructor(opts: HubOptions = {}) {
    this.store = opts.store ?? new SubscriptionStore(null);
    this.devUnlock = !!opts.devUnlock;
    this.billing = opts.billing ?? new Billing({});
    const code = opts.ownerCode ?? process.env.OWNER_CODE ?? '';
    this.ownerCode = /^\d{6}$/.test(code) ? Buffer.from(code) : null;
    this.ownerEmails = new Set((opts.ownerEmails ?? CONFIG.ownerEmails).map((e) => e.trim().toLowerCase()).filter(Boolean));
    this.timings = { ...defaultTimings(), ...opts.timings };
    this.rng = opts.rng ?? secureRng;
    this.rate = opts.rateLimit ?? { burst: 30, perSecond: 15 };
  }

  // ---------- connection plumbing ----------

  attach(ws: WebSocket, baseUrl = '', ip = ''): Conn | null {
    if (this.connections >= CONFIG.limits.maxConnections) return null;
    this.connections += 1;
    return { ws, player: null, limiter: new RateLimiter(this.rate.burst, this.rate.perSecond), strikes: 0, restoreTries: [], confirmTries: [], checkoutTries: [], chatTries: [], baseUrl: CONFIG.publicBaseUrl || baseUrl, ip };
  }

  onMessage(conn: Conn, raw: string): void {
    if (!conn.limiter.allow()) {
      conn.strikes += 1;
      if (conn.strikes > 50) { conn.ws.close(1008, 'rate limit'); return; }
      this.sendWs(conn.ws, { t: 'error', code: 'rate_limited', message: 'Slow down' });
      return;
    }
    const parsed = parseClientMessage(raw);
    if ('error' in parsed) { this.sendWs(conn.ws, { t: 'error', code: 'bad_message', message: parsed.error }); return; }
    const msg = parsed.msg;
    if (msg.t === 'ping') { this.sendWs(conn.ws, { t: 'pong' }); return; }
    if (msg.t === 'hello') { this.hello(conn, msg); return; }
    const p = conn.player;
    if (!p) { this.sendWs(conn.ws, { t: 'error', code: 'not_hello', message: 'Send hello first' }); return; }
    p.lastSeen = Date.now();
    const run = (): void => {
      try {
        switch (msg.t) {
          case 'restorePremium': this.guard(() => this.restorePremium(conn, p, msg.email), () => this.send(p.id, { t: 'restoreResult', ok: false, code: 'unreachable', message: UNREACHABLE })); return;
          case 'confirmPremium': this.guard(() => this.confirmPremium(conn, p, msg.sessionId), () => this.send(p.id, { t: 'premiumResult', ok: false, code: 'unreachable', message: UNREACHABLE })); return;
          case 'chat': this.chat(conn, p, msg.text); return;
          case 'ownerCode': this.ownerCodeUnlock(conn, p, msg.code); return;
          case 'goPremium': this.guard(() => this.goPremium(conn, p), () => this.notice(p, 'error', 'Could not start checkout. Please try again in a moment.')); return;
          default: this.route(p, msg);
        }
      } catch (e) {
        this.err(p, 'bad_message', 'Something went wrong');
        console.error('handler error', e);
      }
    };
    // A Stripe-backed Premium that was last verified long ago is re-checked before it is used for a gated action.
    const gated = msg.t === 'createTable' || msg.t === 'quickPlay' || msg.t === 'setRules' || msg.t === 'createTournament' || msg.t === 'createEvent' || msg.t === 'editTournament' || msg.t === 'editEvent';
    if (gated && this.isStale(p)) void this.recheck(p).then(run, run);
    else run();
  }

  /** Run an async handler; if it throws, answer with the fallback so the client never waits forever. */
  private guard(fn: () => Promise<void> | void, fallback: () => void): void {
    Promise.resolve().then(fn).catch((e) => { console.error('handler error', e instanceof BillingError ? e.message : 'unexpected'); fallback(); });
  }

  onClose(conn: Conn): void {
    this.connections = Math.max(0, this.connections - 1);
    const p = conn.player;
    if (!p || p.ws !== conn.ws) return; // replaced by a newer connection
    p.ws = null;
    p.lastSeen = Date.now();
    this.dequeue(p.id); // a disconnect leaves the random-match queue
    if (p.watchTableId) { this.tables.get(p.watchTableId)?.unwatch(p.id); p.watchTableId = null; }
    const seated = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (seated && seated.seatOf(p.id) >= 0) seated.setConnected(p.id, false);
    else if (seated) { seated.unwatch(p.id); p.tableId = null; } // queued for a seat: just drop out
    for (const t of this.tournaments.values()) t.viewers.delete(p.id);
    for (const e of this.events.values()) e.viewers.delete(p.id);
    this.markLobbyDirty();
  }

  close(): void {
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
    if (this.matchTimer) clearTimeout(this.matchTimer);
    for (const t of this.tables.values()) t.dispose();
    this.tables.clear();
  }

  // ---------- sending ----------

  private sendWs(ws: WebSocket, msg: object): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  send(pid: string, msg: object): void {
    const p = this.players.get(pid);
    if (p?.ws) this.sendWs(p.ws, msg);
  }
  private err(p: Player, code: ErrorCode, message: string): void {
    this.send(p.id, { t: 'error', code, message });
  }
  private isSubscribed(p: Player): boolean { return this.store.isSubscribed(p.id); }

  /** True when this player may only play bots and join by invitation (free, and the one-setting rule is on). */
  private needsInvite(p: Player): boolean { return CONFIG.hostOnly.playWithOthersNeedsInvite && !this.isSubscribed(p); }

  /** A code is an invitation only when whoever made the table / tournament / event is a Premium member right now. */
  private creatorIsPremium(creatorId: string | null | undefined): boolean { return !!creatorId && this.store.isSubscribed(creatorId); }

  /** Who created the table; tables that belong to a tournament or event follow that organizer. */
  private tableCreator(t: Table): string | null {
    if (t.tournament) return this.tournaments.get(t.tournament.id)?.organizerId ?? this.events.get(t.tournament.id)?.organizerId ?? null;
    return t.creatorId;
  }

  // ---------- hello / identity ----------

  /** Show a new avatar pick at the player's table right away. */
  private refreshFace(p: Player): void {
    const t = p.tableId ? this.tables.get(p.tableId) : undefined;
    t?.broadcast();
  }

  private hello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (conn.player) return;
    this.sweep();
    let p = msg.token ? this.byToken.get(msg.token) : undefined;
    const resumed = !!p;
    if (!p) {
      const token = msg.token ?? crypto.randomBytes(16).toString('hex'); // an unknown well-formed token is adopted (restart continuity)
      p = { id: hostIdFromToken(token), token, nick: msg.nick, ws: null, tableId: null, watchTableId: null, tournamentId: null, eventId: null, lastSeen: Date.now() };
      this.players.set(p.id, p);
      this.byToken.set(token, p);
    }
    if (p.ws && p.ws !== conn.ws) {
      const old = p.ws;
      p.ws = null;
      old.close(4000, 'replaced');
    }
    p.ws = conn.ws;
    if (msg.nick) p.nick = msg.nick;
    p.face = msg.face;
    p.lastSeen = Date.now();
    conn.player = p;
    logActivity('hello', { resumed, test: isTestNick(p.nick) });
    this.sendWs(conn.ws, {
      t: 'welcome', token: p.token, id: p.id, nick: p.nick, resumed,
      subscribed: this.isSubscribed(p),
      config: {
        priceUsdPerMonth: CONFIG.subscriptionPriceUsdPerMonth,
        tableTargets: CONFIG.tableTargets,
        tournamentSizes: CONFIG.tournamentSizes,
        tournamentTargetEarly: CONFIG.tournamentTargetEarly,
        tournamentTargetFinal: CONFIG.tournamentTargetFinal,
        quickPlayTarget: CONFIG.quickPlayTarget,
        freeMatchTarget: CONFIG.freeMatchTarget,
        defaultTarget: CONFIG.defaultTarget,
        eventTableOptions: CONFIG.eventTableOptions,
        eventTarget: CONFIG.eventTarget,
        codeLength: CONFIG.codeLength,
        rules: { minBid: CONFIG.rules.minBid, maxBid: CONFIG.rules.maxBid, allowNil: CONFIG.rules.allowNil, loseScore: CONFIG.loseScore, bagLimit: CONFIG.bagLimit, bagPenalty: CONFIG.bagPenalty, nilBonus: CONFIG.nilBonus },
        devUnlock: this.devUnlock,
        playWithOthersNeedsInvite: CONFIG.hostOnly.playWithOthersNeedsInvite,
      },
    });
    this.sendMatching(p); // a second tab / reload while still queued shows the waiting state again
    // A reload never lands back on something that is over: a finished table, bracket or event is dropped and the lobby is shown.
    const done = (x?: { state: string }) => !x || x.state === 'finished' || x.state === 'cancelled';
    let table = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (table && table.status === 'finished' && !table.tournament) { table.leave(p.id); table = undefined; }
    if (table && table.seatOf(p.id) >= 0) table.setConnected(p.id, true);
    else { p.tableId = null; this.sendWs(conn.ws, this.lobbyMessage()); }
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (t && !done(t)) this.send(p.id, t.view(p.id)); else { p.tournamentId = null; t?.viewers.delete(p.id); }
    const ev = p.eventId ? this.events.get(p.eventId) : undefined;
    if (ev && !done(ev)) this.send(p.id, ev.view(p.id)); else { p.eventId = null; ev?.viewers.delete(p.id); }
    if (this.isStale(p)) void this.recheck(p); // a cancelled subscription is noticed when the player comes back
  }

  /** Drop long-gone state lazily (called on each hello and lobby build). */
  private sweep(): void {
    const now = Date.now();
    for (const [id, t] of this.tournaments) {
      const old = (t.finishedAt && now - t.finishedAt > 30 * 60000) || t.state === 'cancelled' ||
        (t.state === 'registering' && now - t.createdAt > 3 * 3600000);
      if (old) this.removeTournament(id);
    }
    for (const [id, e] of this.events) {
      const old = (e.finishedAt && now - e.finishedAt > 30 * 60000) || e.state === 'cancelled' ||
        (e.state === 'registering' && now - e.createdAt > 3 * 3600000);
      if (old) this.removeEvent(id);
    }
    for (const [id, p] of this.players) {
      if (!p.ws && !p.tableId && !p.tournamentId && !p.eventId && now - p.lastSeen > 3600000) {
        this.players.delete(id);
        this.byToken.delete(p.token);
      }
    }
  }

  /** One code per team for the organizer to hand out (two people per code are partners). */
  private makeTeamCodes(kind: 'tournamentTeam' | 'eventTeam', id: string, count: number): string[] {
    return Array.from({ length: count }, () => { const c = this.newCode(); this.codes.set(c, { kind, id }); return c; });
  }

  private dropTeamCodes(kind: 'tournamentTeam' | 'eventTeam', id: string): void {
    for (const [c, v] of this.codes) if (v.kind === kind && v.id === id) this.codes.delete(c);
  }

  /** Organizer, before the start: change the settings; team codes follow the new team count (existing ones are kept). */
  private editSettings(p: Player, kind: 'tournament' | 'event', patch: { size?: number; tables?: number; target?: number; isPublic?: boolean; teamMin4?: boolean; jokers?: boolean; setsOut?: boolean; bigBids?: boolean }): void {
    const x = kind === 'tournament' ? (p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined) : (p.eventId ? this.events.get(p.eventId) : undefined);
    if (!x) return this.err(p, 'not_found', 'You are not in a tournament');
    if (p.id === x.organizerId && CONFIG.hostOnly.hostTournaments && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage());
    const teamKind = kind === 'tournament' ? 'tournamentTeam' : 'eventTeam';
    const newCodes = (n: number) => Array.from({ length: n }, () => { const c = this.newCode(); this.codes.set(c, { kind: teamKind, id: x.id }); return c; });
    const r = x.edit(p.id, patch, newCodes);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    for (const c of r.removedCodes) this.codes.delete(c);
    this.markLobbyDirty();
  }

  /** Organizer: swap / pair / unpair people before the start. */
  private arrangeTeams(p: Player, action: 'swap' | 'pair' | 'unpair', a: number, b?: number): void {
    const x = (p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined) ?? (p.eventId ? this.events.get(p.eventId) : undefined);
    if (!x) return this.err(p, 'not_found', 'You are not in a tournament');
    const r = x.arrange(p.id, action, a, b);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
  }

  private removeTournament(id: string, why?: string): void {
    const t = this.tournaments.get(id);
    if (!t) return;
    this.tournaments.delete(id);
    this.codes.delete(t.code);
    this.dropTeamCodes('tournamentTeam', id);
    for (const pid of t.audience()) {
      const p = this.players.get(pid);
      if (p && p.tournamentId === id) { p.tournamentId = null; this.send(pid, { t: 'tournamentLeft', reason: why ?? (t.state === 'cancelled' ? 'The organizer cancelled the tournament' : '') }); }
    }
  }

  private removeEvent(id: string, why?: string): void {
    const e = this.events.get(id);
    if (!e) return;
    this.events.delete(id);
    this.codes.delete(e.code);
    this.dropTeamCodes('eventTeam', id);
    for (const pid of e.audience()) {
      const p = this.players.get(pid);
      if (p && p.eventId === id) { p.eventId = null; this.send(pid, { t: 'eventLeft', reason: why ?? (e.state === 'cancelled' ? 'The organizer cancelled the tournament' : '') }); }
    }
  }

  // ---------- routing ----------

  private route(p: Player, msg: ClientMsg): void {
    // Anything that seats the player, lets them watch, or creates something needs a display name first.
    // Practice (a table of bots on this device) is the one exception: a nameless player is seated as 'You'.
    const practice = msg.t === 'createTable' && msg.practice === true && msg.isPublic;
    if (NAME_REQUIRED.has(msg.t) && !p.nick && !practice) {
      return this.err(p, 'name_required', 'Enter your name first');
    }
    switch (msg.t) {
      case 'setFace': p.face = msg.face; return this.refreshFace(p);
      case 'setNick': p.nick = msg.nick; return this.send(p.id, { t: 'nick', nick: p.nick });
      case 'createTable': return this.createTable(p, msg.isPublic, msg.target, msg.breakRule, msg.sandbags, practice, msg.teamMin4 !== false, msg.jokers === true, msg.setsOut === true, msg.bigBids === true);
      case 'setRules':
        if (msg.bigBids && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage()); // Big bids is Premium only
        return this.tableAction(p, (t) => t.setRules(p.id, msg));
      case 'addBots': return this.tableAction(p, (t) => t.addBots(p.id));
      case 'swapPartners': return this.tableAction(p, (t) => t.swapPartners(p.id));
      case 'createEvent': return this.createEvent(p, msg.tables, msg.target ?? CONFIG.eventTarget, msg.teamMin4 !== false, msg.jokers === true, msg.setsOut === true, msg.bigBids === true);
      case 'startEvent': return this.startEvent(p);
      case 'leaveEvent': return this.leaveEvent(p);
      case 'editTournament': return this.editSettings(p, 'tournament', msg);
      case 'editEvent': return this.editSettings(p, 'event', msg);
      case 'arrangeTeams': return this.arrangeTeams(p, msg.action, msg.a, msg.b);
      case 'joinTable': return this.joinTable(p, this.tables.get(msg.id), true);
      case 'watchTable': return this.watchTable(p, this.tables.get(msg.id), true);
      case 'joinCode': return this.joinCode(p, msg.code);
      case 'watchCode': return this.watchCode(p, msg.code);
      case 'quickPlay': return this.quickPlay(p);
      case 'createFriend': return this.createFriend(p);
      case 'cancelMatch': return void this.cancelMatch(p);
      case 'startTable': return this.tableAction(p, (t) => t.start(p.id));
      case 'bid': return this.tableAction(p, (t) => t.bid(p.id, msg.bid));
      case 'play': return this.tableAction(p, (t) => t.play(p.id, msg.card));
      case 'ready': return this.tableAction(p, (t) => t.ready(p.id));
      case 'rematch': return this.tableAction(p, (t) => t.rematch(p.id));
      case 'leaveTable': return this.leaveTable(p);
      case 'endGame': return this.endGame(p);
      case 'createTournament': return this.createTournament(p, msg.size, msg.isPublic, msg.teamMin4 !== false, msg.jokers === true, msg.setsOut === true, msg.bigBids === true);
      case 'joinTournament': return this.joinTournament(p, this.tournaments.get(msg.id), true);
      case 'watchTournament': return this.watchTournament(p, this.tournaments.get(msg.id));
      case 'startTournament': return this.startTournament(p);
      case 'leaveTournament': return this.leaveTournament(p);
      case 'devToggleSubscription': return this.devToggle(p);
      default: return;
    }
  }

  /** Run a table action for a player who must hold a seat; spectators are rejected here and again in Table. */
  private tableAction(p: Player, fn: (t: Table) => { ok: boolean; code?: string; message?: string }): void {
    const t = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (!t) return this.err(p, 'not_seated', 'You are not seated at a table (spectators cannot act)');
    const r = fn(t);
    if (!r.ok) this.err(p, (r.code ?? 'illegal') as ErrorCode, r.message ?? 'Not allowed');
  }

  private busyReason(p: Player): string | null {
    if (this.inQueue(p.id)) return 'You are finding players. Cancel that first';
    this.releaseFinishedTable(p);
    if (p.tableId) return 'Leave your current table first';
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (t && (t.state === 'registering' || t.state === 'running')) return 'You are in a tournament. Leave it first';
    const ev = p.eventId ? this.events.get(p.eventId) : undefined;
    if (ev && (ev.state === 'registering' || ev.state === 'running')) return 'You are in a tournament. Leave it first';
    return null;
  }

  /** A game that is over (or a table that no longer exists) never blocks starting something new: leave it quietly.
   *  Without this, a player who went back home from the game-over screen got "Leave your current table first" on Play now. */
  private releaseFinishedTable(p: Player): void {
    if (!p.tableId) return;
    const t = this.tables.get(p.tableId);
    if (t && (t.status !== 'finished' || t.tournament)) return; // tournament tables hand the player back to the bracket themselves
    p.tableId = null;
    t?.leave(p.id);
    this.send(p.id, { t: 'left', reason: '' });
  }

  private newId(taken: (id: string) => boolean): string {
    for (;;) {
      const id = crypto.randomBytes(4).toString('hex');
      if (!taken(id)) return id;
    }
  }
  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < CONFIG.codeLength; i++) c += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
      if (!this.codes.has(c)) return c;
    }
  }

  // ---------- tables ----------

  private makeTable(opts: { isPublic: boolean; target: number; breakRule?: boolean; sandbags?: boolean; hostId: string | null; practice?: boolean; quick?: boolean; friend?: boolean; teamMin4?: boolean; jokers?: boolean; setsOut?: boolean; bigBids?: boolean; tournament?: { id: string; matchId: string; label: string } }): Table {
    const id = this.newId((x) => this.tables.has(x));
    const code = this.newCode();
    const table = new Table({
      id, code, isPublic: opts.isPublic, target: opts.target, breakRule: opts.breakRule, sandbags: opts.sandbags, hostId: opts.hostId, practice: opts.practice, quick: opts.quick, friend: opts.friend, teamMin: opts.quick || opts.practice || opts.teamMin4 === false ? 0 : CONFIG.rules.premiumTeamMin, jokers: opts.jokers === true, setsOut: opts.setsOut === true, bigBids: opts.bigBids === true, timings: this.timings,
      tournament: opts.tournament, rng: this.rng,
      hooks: {
        send: (pid, msg) => this.send(pid, msg),
        faceOf: (pid) => this.players.get(pid)?.face,
        changed: () => this.markLobbyDirty(),
        destroyed: (t, people) => this.tableDestroyed(t, people),
        released: (pid, t) => this.releasePlayer(pid, t),
        matchOver: (t, winner, scores, forfeit) => this.matchOver(t, winner, scores, forfeit),
        gameEnded: (t, winner, scores, forfeit) => {
          const tour = t.tournament ? this.tournaments.get(t.tournament.id) : undefined;
          const s = tour && t.tournament ? tour.recordGame(t.tournament.matchId, winner, scores, forfeit) : null;
          if (s?.decided && tour && t.tournament) {
            const m = tour.findMatch(t.tournament.matchId);
            logActivity('series_end', { tournamentId: tour.id, tableId: t.id, round: m ? m.round + 1 : null, final: m ? m.round === tour.totalRounds - 1 : null, bestOf: 2 * s.need - 1, wins: s.wins, winner, forfeit, ...this.testFlag(t) });
          }
          return s;
        },
        gameStarted: (t) => logActivity('game_start', this.gameFields(t)),
        gameFinished: (t, winner, scores, forfeit, seconds) => logActivity('game_end', { ...this.gameFields(t), winner, scores, forfeit, seconds }),
      },
    });
    this.tables.set(id, table);
    this.codes.set(code, { kind: 'table', id });
    return table;
  }

  /** Tables made by a Premium player's "Quick play at a public table". */
  private quickTables = new Set<string>();

  private tableKind(t: Table): string {
    if (t.tournament) return this.events.has(t.tournament.id) ? 'event' : 'tournament';
    if (t.friend) return 'friend';
    if (t.quick) return 'playnow';
    if (this.quickTables.has(t.id)) return 'quickplay';
    return 'hosted';
  }

  private testFlag(t: Table): { test?: true } {
    return t.seats.some((s) => s.kind === 'human' && isTestNick(s.name)) ? { test: true } : {};
  }

  private gameFields(t: Table): Record<string, unknown> {
    const humans = t.seats.filter((s) => s.kind === 'human').length;
    const bots = t.seats.filter((s) => s.kind === 'bot').length;
    return { tableId: t.id, kind: this.tableKind(t), humans, bots, target: t.target, ...this.testFlag(t) };
  }

  private tableDestroyed(t: Table, people: string[]): void {
    this.tables.delete(t.id);
    this.quickTables.delete(t.id);
    this.codes.delete(t.code);
    for (const pid of people) this.releasePlayer(pid, t, 'The table closed');
    this.markLobbyDirty();
  }

  private releasePlayer(pid: string, t: Table, reason = 'You gave up your seat'): void {
    const p = this.players.get(pid);
    if (!p) return;
    let changed = false;
    if (p.tableId === t.id) { p.tableId = null; changed = true; }
    if (p.watchTableId === t.id) { p.watchTableId = null; changed = true; }
    if (changed) {
      this.send(pid, { t: 'left', reason });
      this.sendLobbyTo(p);
    }
  }

  private matchOver(t: Table, winner: Team, scores: [number, number], _forfeit: boolean): void {
    const info = t.tournament;
    const people = t.participants();
    t.dispose();
    this.tables.delete(t.id);
    this.quickTables.delete(t.id);
    this.codes.delete(t.code);
    for (const pid of people) this.releasePlayer(pid, t, 'Match finished');
    const tour = info ? this.tournaments.get(info.id) : undefined;
    if (tour && info) {
      const was = tour.state;
      tour.matchResult(info.matchId, winner, scores);
      if (was !== 'finished' && tour.state === 'finished') this.logTournamentEnd(tour);
    }
    const ev = info ? this.events.get(info.id) : undefined;
    if (ev && info) {
      const was = ev.state;
      ev.tableResult(info.matchId, winner, scores, _forfeit);
      if (was !== 'finished' && ev.state === 'finished') logActivity('tournament_end', { kind: 'event', tournamentId: ev.id, ...this.testOrg(ev.organizerId) });
    }
    this.markLobbyDirty();
  }

  private leaveCurrent(p: Player): void {
    if (p.watchTableId) { this.tables.get(p.watchTableId)?.unwatch(p.id); p.watchTableId = null; }
  }

  private createTable(p: Player, isPublic: boolean, target: number, breakRule?: boolean, sandbags?: boolean, practice = false, teamMin4 = true, jokers = false, setsOut = false, bigBids = false): void {
    if (bigBids && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage()); // Big bids is Premium only
    if (!practice) {
      if (!isPublic && CONFIG.hostOnly.privateTables && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage());
      if (this.needsInvite(p)) return this.err(p, 'upgrade_required', inviteMessage());
    }
    if (practice && jokers && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage()); // Jokers is a Premium mode, practice too
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    // Practice is a solo table against bots: not public, so it is never listed or joinable by id, and joining it by code is refused too.
    const table = this.makeTable({ isPublic: practice ? false : isPublic, target, breakRule, sandbags, hostId: p.id, practice, teamMin4, jokers, setsOut, bigBids });
    table.seatHuman(0, p.id, p.nick || (practice ? 'You' : ''), true);
    p.tableId = table.id;
    table.broadcast();
    this.markLobbyDirty();
  }

  private joinCode(p: Player, code: string): void {
    const target = this.codes.get(code);
    if (!target) return this.err(p, 'not_found', 'No table or tournament with that code');
    if (target.kind === 'tournament') return this.joinTournament(p, this.tournaments.get(target.id), false);
    if (target.kind === 'event') return this.joinEvent(p, this.events.get(target.id));
    if (target.kind === 'tournamentTeam') return this.joinTournament(p, this.tournaments.get(target.id), false, code);
    if (target.kind === 'eventTeam') return this.joinEvent(p, this.events.get(target.id), code);
    this.joinTable(p, this.tables.get(target.id), false);
  }

  /** Free "Play with a friend": a private code; the one friend who joins sits across as partner and the game starts at once. */
  private createFriend(p: Player): void {
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    const table = this.makeTable({ isPublic: false, target: CONFIG.freeMatchTarget, hostId: p.id, quick: true, friend: true });
    table.seatHuman(0, p.id, p.nick, true);
    p.tableId = table.id;
    table.broadcast();
    const timer = setTimeout(() => {
      if (this.tables.get(table.id) !== table || table.status !== 'waiting') return;
      for (const pid of table.participants()) {
        const q = this.players.get(pid);
        if (q && q.tableId === table.id) { q.tableId = null; this.send(pid, { t: 'left', reason: 'Nobody joined with your code, so it expired' }); this.sendLobbyTo(q); }
      }
      table.destroy();
    }, CONFIG.friendCodeTtlMs);
    timer.unref?.();
  }

  private joinFriend(p: Player, t: Table): void {
    if (t.status !== 'waiting' || t.seats[2].kind !== 'empty') return this.err(p, 'full', 'This game is full. Want a full table with friends? Host with Premium.');
    if (p.tableId === t.id) return;
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    this.leaveCurrent(p);
    t.seatHuman(2, p.id, p.nick, true); // across from the creator: partners
    p.tableId = t.id;
    t.startGame(); // the two other seats get computer players
    this.markLobbyDirty();
  }

  private joinTable(p: Player, t: Table | undefined, byId: boolean): void {
    if (t && t.friend && !byId) return this.joinFriend(p, t);
    if (t && t.friend) return this.err(p, 'not_found', 'Table not found');
    if (byId && this.needsInvite(p)) return this.err(p, 'upgrade_required', inviteMessage()); // the lobby list is for watching; free players need a code
    if (!t || (byId && !t.isPublic)) return this.err(p, 'not_found', 'Table not found');
    if (t.practice) return this.err(p, 'not_allowed', 'That is a solo practice table');
    if (!byId && this.needsInvite(p) && !this.creatorIsPremium(this.tableCreator(t))) return this.err(p, 'not_allowed', hostNotPremiumMessage());
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    this.leaveCurrent(p);
    const r = t.sit(p.id, p.nick, true);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    p.tableId = t.id; // queued players are tracked too; Table sends them a spectator view until seated
  }

  private watchCode(p: Player, code: string): void {
    const target = this.codes.get(code);
    if (!target) return this.err(p, 'not_found', 'No table or tournament with that code');
    if (target.kind === 'tournament' || target.kind === 'tournamentTeam') return this.watchTournament(p, this.tournaments.get(target.id));
    if (target.kind === 'event' || target.kind === 'eventTeam') return this.watchEvent(p, this.events.get(target.id));
    this.watchTable(p, this.tables.get(target.id), false);
  }

  private watchTable(p: Player, t: Table | undefined, byId: boolean): void {
    if (!t || (byId && !t.isPublic && !t.tournament)) return this.err(p, 'not_found', 'Table not found');
    if (!CONFIG.spectatePrivateTables && !t.isPublic && !t.tournament) return this.err(p, 'not_allowed', 'This table cannot be watched');
    if (p.tableId) return this.err(p, 'busy', 'Leave your current table first');
    if (this.inQueue(p.id)) return this.err(p, 'busy', 'You are finding players. Cancel that first');
    if (p.watchTableId === t.id) return;
    this.leaveCurrent(p);
    p.watchTableId = t.id;
    t.watch(p.id);
    if (t.tournament) {
      const tour = this.tournaments.get(t.tournament.id);
      if (tour && !tour.hasPlayer(p.id)) { tour.viewers.add(p.id); this.send(p.id, tour.view(p.id)); }
      const ev = this.events.get(t.tournament.id);
      if (ev && !ev.hasPlayer(p.id)) { ev.viewers.add(p.id); this.send(p.id, ev.view(p.id)); }
    }
  }

  private quickPlay(p: Player): void {
    if (this.inQueue(p.id)) return this.sendMatching(p); // pressed twice: just show the waiting state again
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    // Free players cannot choose who they play with: Quick play puts them in the random-match queue, and bots fill empty seats after a short wait.
    if (this.needsInvite(p)) {
      if (CONFIG.freeRandomMatch) return this.enqueue(p);
      return this.startMatch([p.id]); // switched off: a solo game against bots
    }
    const candidates = [...this.tables.values()]
      .filter((t) => t.isPublic && !t.practice && !t.tournament && t.openSeats() > 0 && t.status !== 'finished')
      .sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1) || b.humanCount() - a.humanCount());
    if (candidates.length > 0) return this.joinTable(p, candidates[0], true);
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    const table = this.makeTable({ isPublic: true, target: CONFIG.quickPlayTarget, hostId: p.id, practice: false });
    this.quickTables.add(table.id);
    table.seatHuman(0, p.id, p.nick, true);
    p.tableId = table.id;
    table.startGame(); // bots fill the other seats at once
  }

  // ---------- random-match queue (free players' Quick play) ----------

  private inQueue(id: string): boolean { return this.matchQueue.some((q) => q.id === id); }

  private enqueue(p: Player): void {
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    this.matchQueue.push({ id: p.id, since: Date.now() });
    if (this.matchQueue.length >= 4) return this.formMatch();
    this.broadcastMatching();
    this.armMatchTimer();
  }

  private dequeue(id: string): boolean {
    const i = this.matchQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    this.matchQueue.splice(i, 1);
    if (this.matchQueue.length === 0 && this.matchTimer) { clearTimeout(this.matchTimer); this.matchTimer = null; }
    else this.armMatchTimer();
    this.broadcastMatching();
    return true;
  }

  private cancelMatch(p: Player): void {
    if (this.dequeue(p.id)) this.send(p.id, { t: 'matching', active: false });
  }

  /** Everyone waiting is told how many are queued and how long until bots fill in. */
  private broadcastMatching(): void { for (const q of this.matchQueue) { const p = this.players.get(q.id); if (p) this.sendMatching(p); } }

  private sendMatching(p: Player): void {
    const q = this.matchQueue.find((x) => x.id === p.id);
    if (!q) return;
    const waitMs = this.timings.matchWaitMs;
    const first = this.matchQueue[0].since;
    this.send(p.id, { t: 'matching', active: true, waiting: this.matchQueue.length, size: 4, remainingMs: Math.max(0, first + waitMs - Date.now()), waitMs });
  }

  /** One timer for the oldest waiting player: when their wait is over, everyone queued starts together with bots in the empty seats. */
  private armMatchTimer(): void {
    if (this.matchTimer) { clearTimeout(this.matchTimer); this.matchTimer = null; }
    if (this.matchQueue.length === 0) return;
    const delay = Math.max(0, this.matchQueue[0].since + this.timings.matchWaitMs - Date.now());
    this.matchTimer = setTimeout(() => { this.matchTimer = null; this.formMatch(); }, delay);
    this.matchTimer.unref?.();
  }

  /** Take up to four queued players and start their table; bots fill whatever seats are empty. */
  private formMatch(): void {
    const ids = this.matchQueue.splice(0, 4).map((q) => q.id).filter((id) => !!this.players.get(id)?.ws);
    if (this.matchTimer) { clearTimeout(this.matchTimer); this.matchTimer = null; }
    this.armMatchTimer();
    this.broadcastMatching();
    if (ids.length > 0) this.startMatch(ids);
  }

  /** A random-match table: one human is a solo practice game, two to four are a private, unlisted table (nobody can join it by id or code mid-game). */
  private startMatch(ids: string[]): void {
    const people = ids.map((id) => this.players.get(id)!);
    if (this.tables.size >= CONFIG.limits.maxTables) { for (const p of people) { this.send(p.id, { t: 'matching', active: false }); this.err(p, 'too_many', 'The server is busy. Try again soon'); } return; }
    const solo = people.length === 1;
    const table = this.makeTable({ isPublic: false, target: CONFIG.freeMatchTarget, hostId: people[0].id, practice: solo, quick: true });
    people.forEach((p, i) => { this.leaveCurrent(p); table.seatHuman(i, p.id, p.nick, true); p.tableId = table.id; });
    // No notice about who was found: the table just appears with everyone's names.
    for (const p of people) this.send(p.id, { t: 'matching', active: false });
    table.startGame();
    this.markLobbyDirty();
  }

  private leaveTable(p: Player): void {
    if (p.tableId) {
      const t = this.tables.get(p.tableId);
      p.tableId = null;
      t?.leave(p.id);
    } else if (p.watchTableId) {
      this.leaveCurrent(p);
    } else return;
    this.send(p.id, { t: 'left', reason: '' });
    this.sendLobbyTo(p);
    this.markLobbyDirty();
  }

  /**
   * Host "End game": ends the whole thing for everyone at any moment and sends every person home.
   * Organizer of a tournament / event: the whole bracket or event and all its tables. Host of a table: that table.
   * A random "Play now" table with other people on it has no real host, so there it is the same as Leave.
   */
  private endGame(p: Player): void {
    const reason = 'The host ended the game';
    const tour = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    const ev = p.eventId ? this.events.get(p.eventId) : undefined;
    const org = tour && tour.organizerId === p.id ? tour : ev && ev.organizerId === p.id ? ev : undefined;
    if (org) {
      for (const t of [...this.tables.values()]) if (t.tournament?.id === org.id) this.closeTable(t, reason);
      if (org.state !== 'finished') org.state = 'cancelled';
      if (org === tour) this.removeTournament(org.id, reason); else this.removeEvent(org.id, reason);
      for (const vid of org.viewers) {
        const v = this.players.get(vid);
        if (v && v.tournamentId !== org.id && v.eventId !== org.id) this.send(vid, { t: org === tour ? 'tournamentLeft' : 'eventLeft', reason });
      }
      org.viewers.clear();
      this.markLobbyDirty();
      return;
    }
    const t = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (!t || t.tournament || t.hostId !== p.id) {
      if (t || p.tournamentId || p.eventId) return this.err(p, 'not_allowed', 'Only the host can end the game for everyone. You can still leave');
      return this.leaveTable(p);
    }
    if (t.quick && !t.friend && t.humanCount() > 1) return this.leaveTable(p);
    this.closeTable(t, reason);
  }

  /** Close a table now: timers stop, everyone seated or watching is sent home with the reason. */
  private closeTable(t: Table, reason: string): void {
    const people = [...new Set([...t.participants(), ...t.watchers, ...t.waiters])];
    t.dispose();
    this.tables.delete(t.id);
    this.quickTables.delete(t.id);
    this.codes.delete(t.code);
    for (const pid of people) this.releasePlayer(pid, t, reason);
    this.markLobbyDirty();
  }

  // ---------- tournaments ----------

  private createTournament(p: Player, size: number, isPublic: boolean, teamMin4 = true, jokers = false, setsOut = false, bigBids = false): void {
    if (CONFIG.hostOnly.hostTournaments && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage());
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.tournaments.size >= CONFIG.limits.maxTournaments) return this.err(p, 'too_many', 'Too many tournaments right now');
    this.leaveCurrent(p);
    const id = this.newId((x) => this.tournaments.has(x));
    const code = this.newCode();
    const t = new Tournament({ id, code, size, organizerId: p.id, isPublic, teamMin4, jokers, setsOut, bigBids, rng: this.rng, host: this.tournamentHost() });
    this.tournaments.set(id, t);
    this.codes.set(code, { kind: 'tournament', id });
    const teamCodes = this.makeTeamCodes('tournamentTeam', id, size);
    t.pairing.setCodes(teamCodes);
    t.join(p.id, p.nick, teamCodes[0]); // the organizer is in Team 1
    p.tournamentId = id;
    this.pushTournament(t);
    this.markLobbyDirty();
  }

  private joinTournament(p: Player, t: Tournament | undefined, byId: boolean, teamCode?: string): void {
    if (byId && this.needsInvite(p)) return this.err(p, 'upgrade_required', inviteMessage());
    if (!t || (byId && !t.isPublic)) return this.err(p, 'not_found', 'Tournament not found');
    if (this.needsInvite(p) && !this.creatorIsPremium(t.organizerId)) return this.err(p, 'not_allowed', hostNotPremiumMessage());
    if (p.tournamentId === t.id) return this.pushTournament(t);
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    this.leaveCurrent(p);
    const r = t.join(p.id, p.nick, teamCode);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    p.tournamentId = t.id;
    t.viewers.delete(p.id);
    this.pushTournament(t);
  }

  private watchTournament(p: Player, t: Tournament | undefined): void {
    if (!t) return this.err(p, 'not_found', 'Tournament not found');
    t.viewers.add(p.id);
    this.send(p.id, t.view(p.id));
  }

  private startTournament(p: Player): void {
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (!t) return this.err(p, 'not_found', 'You are not in a tournament');
    const r = t.start(p.id);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    logActivity('tournament_start', { kind: 'tournament', tournamentId: t.id, size: t.size, rounds: t.totalRounds, humans: t.entrants.length, ...this.testOrg(t.organizerId) });
    if (t.state === 'finished') this.logTournamentEnd(t); // an all-bot bracket can finish at once
  }

  private testOrg(pid: string): { test?: true } {
    return isTestNick(this.players.get(pid)?.nick) ? { test: true } : {};
  }

  private logTournamentEnd(t: Tournament): void {
    logActivity('tournament_end', { kind: 'tournament', tournamentId: t.id, size: t.size, champion: t.champion?.name ?? null, ...this.testOrg(t.organizerId) });
  }

  private leaveTournament(p: Player): void {
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (!t) {
      p.tournamentId = null;
      for (const x of this.tournaments.values()) x.viewers.delete(p.id);
      this.send(p.id, { t: 'tournamentLeft', reason: '' });
      return;
    }
    // If the player is seated at one of this tournament's tables, they leave that table first
    const table = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (table?.tournament?.id === t.id) {
      p.tableId = null;
      table.leave(p.id);
      this.send(p.id, { t: 'left', reason: '' });
    }
    p.tournamentId = null;
    const r = t.leave(p.id);
    this.send(p.id, { t: 'tournamentLeft', reason: '' });
    this.sendLobbyTo(p);
    if (r.ok && r.cancelled) this.removeTournament(t.id);
    else this.pushTournament(t);
  }

  private tournamentHost() {
    return {
      createMatchTable: (t: Tournament, m: Match, label: string) => this.createMatchTable(t, m, label),
      changed: (t: Tournament) => { this.pushTournament(t); this.markLobbyDirty(); },
    };
  }

  private pushTournament(t: Tournament): void {
    for (const pid of t.audience()) {
      const p = this.players.get(pid);
      if (!p || !p.ws) continue;
      if (p.tournamentId === t.id || t.viewers.has(pid)) this.send(pid, t.view(pid));
    }
  }

  private createMatchTable(t: Tournament, m: Match, label: string): { id: string; code: string } {
    const table = this.makeTable({ isPublic: false, target: m.target, hostId: null, teamMin4: t.teamMin4, jokers: t.jokers, setsOut: t.setsOut, bigBids: t.bigBids, tournament: { id: t.id, matchId: m.id, label } });
    m.teams.forEach((team, side) => {
      const seats = side === 0 ? [0, 2] : [1, 3];
      team!.slots.forEach((slot, k) => {
        const seat = seats[k];
        const pl = slot.playerId ? this.players.get(slot.playerId) : undefined;
        if (!pl) { table.seatBot(seat, slot.persona); return; }
        this.leaveCurrent(pl);
        if (pl.tableId) this.tables.get(pl.tableId)?.leave(pl.id);
        table.seatHuman(seat, pl.id, pl.nick, !!pl.ws);
        pl.tableId = table.id;
      });
    });
    table.series = t.series(m);
    table.startGame();
    return { id: table.id, code: table.code };
  }

  // ---------- multi-table events ("Create Tournament", one to eight tables) ----------

  private createEvent(p: Player, tables: number, target: number, teamMin4 = true, jokers = false, setsOut = false, bigBids = false): void {
    if (CONFIG.hostOnly.hostTournaments && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage());
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.events.size >= CONFIG.limits.maxEvents) return this.err(p, 'too_many', 'Too many tournaments right now');
    this.leaveCurrent(p);
    const id = this.newId((x) => this.events.has(x));
    const code = this.newCode();
    const ev = new TableEvent({ id, code, tables, target, teamMin4, jokers, setsOut, bigBids, organizerId: p.id, host: this.eventHost() });
    this.events.set(id, ev);
    this.codes.set(code, { kind: 'event', id });
    const teamCodes = this.makeTeamCodes('eventTeam', id, tables * 2);
    ev.pairing.setCodes(teamCodes);
    ev.join(p.id, p.nick, teamCodes[0]); // the organizer is in Team 1
    p.eventId = id;
    this.pushEvent(ev);
  }

  private joinEvent(p: Player, ev: TableEvent | undefined, teamCode?: string): void {
    if (!ev) return this.err(p, 'not_found', 'Tournament not found');
    if (this.needsInvite(p) && !this.creatorIsPremium(ev.organizerId)) return this.err(p, 'not_allowed', hostNotPremiumMessage());
    if (p.eventId === ev.id) return this.pushEvent(ev);
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    this.leaveCurrent(p);
    const r = ev.join(p.id, p.nick, teamCode);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    p.eventId = ev.id;
    ev.viewers.delete(p.id);
    this.pushEvent(ev);
  }

  private watchEvent(p: Player, ev: TableEvent | undefined): void {
    if (!ev) return this.err(p, 'not_found', 'Tournament not found');
    ev.viewers.add(p.id);
    this.send(p.id, ev.view(p.id));
  }

  private startEvent(p: Player): void {
    const ev = p.eventId ? this.events.get(p.eventId) : undefined;
    if (!ev) return this.err(p, 'not_found', 'You are not in a tournament');
    const r = ev.start(p.id);
    if (!r.ok) return this.err(p, r.code as ErrorCode, r.message);
    logActivity('tournament_start', { kind: 'event', tournamentId: ev.id, ...this.testOrg(ev.organizerId) });
  }

  private leaveEvent(p: Player): void {
    const ev = p.eventId ? this.events.get(p.eventId) : undefined;
    if (!ev) {
      p.eventId = null;
      for (const x of this.events.values()) x.viewers.delete(p.id);
      this.send(p.id, { t: 'eventLeft', reason: '' });
      return;
    }
    const table = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (table?.tournament?.id === ev.id) {
      p.tableId = null;
      table.leave(p.id);
      this.send(p.id, { t: 'left', reason: '' });
    }
    p.eventId = null;
    const r = ev.leave(p.id);
    this.send(p.id, { t: 'eventLeft', reason: '' });
    this.sendLobbyTo(p);
    if (r.ok && r.cancelled) this.removeEvent(ev.id);
    else this.pushEvent(ev);
  }

  private eventHost() {
    return {
      createEventTable: (ev: TableEvent, entry: EventTableEntry) => this.createEventTable(ev, entry),
      changed: (ev: TableEvent) => { this.pushEvent(ev); this.markLobbyDirty(); },
    };
  }

  private pushEvent(ev: TableEvent): void {
    for (const pid of ev.audience()) {
      const p = this.players.get(pid);
      if (!p || !p.ws) continue;
      if (p.eventId === ev.id || ev.viewers.has(pid)) this.send(pid, ev.view(pid));
    }
  }

  private createEventTable(ev: TableEvent, entry: EventTableEntry): { id: string; code: string } {
    const table = this.makeTable({
      isPublic: false, target: ev.target, hostId: null, teamMin4: ev.teamMin4, jokers: ev.jokers, setsOut: ev.setsOut, bigBids: ev.bigBids,
      tournament: { id: ev.id, matchId: `t${entry.no}`, label: `Table ${entry.no} · to ${ev.target}` },
    });
    entry.seats.forEach((slot, seat) => {
      const pl = slot.playerId ? this.players.get(slot.playerId) : undefined;
      if (!pl) { table.seatBot(seat, slot.persona); return; }
      this.leaveCurrent(pl);
      if (pl.tableId) this.tables.get(pl.tableId)?.leave(pl.id);
      table.seatHuman(seat, pl.id, pl.nick, !!pl.ws);
      pl.tableId = table.id;
    });
    table.startGame();
    return { id: table.id, code: table.code };
  }

  // ---------- chat ----------

  /** Table chat: needs a name, a table to be at (seated or watching) and stays under the per-connection rate limit. */
  private chat(conn: Conn, p: Player, text: string): void {
    if (!p.nick) return this.err(p, 'name_required', 'Enter your name first');
    const t = (p.tableId && this.tables.get(p.tableId)) || (p.watchTableId && this.tables.get(p.watchTableId)) || null;
    if (!t || !t.hasPerson(p.id)) return this.err(p, 'not_seated', 'Join or watch a table to chat');
    if (!this.allow(conn.chatTries, CONFIG.chat.burst, CONFIG.chat.windowMs)) {
      return this.notice(p, 'info', `Slow down: ${CONFIG.chat.burst} messages every ${CONFIG.chat.windowMs / 1000} seconds.`);
    }
    t.postChat(p.id, p.nick, text);
  }

  // ---------- subscription / Stripe billing (see billing.ts) ----------

  private notice(p: Player, kind: 'info' | 'error', message: string): void {
    this.send(p.id, { t: 'notice', kind, message });
  }

  private allow(tries: number[], max: number, windowMs = 60000, now = Date.now()): boolean {
    while (tries.length && now - tries[0] > windowMs) tries.shift();
    if (tries.length >= max) return false;
    tries.push(now);
    return true;
  }

  /** True when a Stripe-backed Premium is old enough that it should be verified again. Owner/dev unlocks never expire. */
  private isStale(p: Player): boolean {
    const r = this.store.get(p.id);
    return !!r && r.source === 'stripe' && this.billing.enabled && Date.now() - (r.verifiedAt ?? 0) > CONFIG.stripeRecheckMs;
  }

  /**
   * Ask Stripe whether this player's subscription is still active. Cancelled / past due / unpaid locks Premium. If Stripe
   * cannot be reached the previous state is kept until the grace period after the last good verification has run out.
   */
  private async recheck(p: Player): Promise<void> {
    const rec = this.store.get(p.id);
    if (!rec || rec.source !== 'stripe' || !this.billing.enabled) return;
    const now = Date.now();
    if (now - (this.recheckTried.get(p.id) ?? 0) < 60000) return; // at most once a minute per player
    this.recheckTried.set(p.id, now);
    const lock = (why: string) => {
      this.store.set(p.id, false);
      this.send(p.id, { t: 'subscription', subscribed: false });
      this.notice(p, 'info', why);
    };
    try {
      const active = rec.subscriptionId ? await this.billing.isSubscriptionActive(rec.subscriptionId) : false;
      if (active) this.store.markVerified(p.id);
      else lock('Your Premium subscription is no longer active.');
    } catch {
      if (now - (rec.verifiedAt ?? 0) > CONFIG.stripeRecheckMs + CONFIG.stripeGraceMs) lock('Premium could not be confirmed. Use Restore Premium once you are online.');
    }
  }

  /**
   * "Go Premium". With Stripe configured this creates a Checkout Session and sends the hosted-checkout URL (`checkout`).
   * Without it: DEV_UNLOCK flips the flag in test mode, otherwise a friendly "not set up yet" notice. Exactly one reply.
   */
  private async goPremium(conn: Conn, p: Player): Promise<void> {
    if (this.billing.enabled) {
      if (this.isSubscribed(p)) return this.notice(p, 'info', 'Premium is already active on this device.');
      if (!this.allow(conn.checkoutTries, 10)) return this.notice(p, 'error', 'Too many tries. Wait a minute and try again.');
      try {
        const url = await this.billing.createCheckoutSession(p.id, conn.baseUrl || `http://localhost`);
        this.send(p.id, { t: 'checkout', url });
        logActivity('checkout_started', { test: isTestNick(p.nick) });
      } catch {
        this.notice(p, 'error', 'Could not start checkout. Please try again in a moment.');
      }
      return;
    }
    if (!this.devUnlock) return this.notice(p, 'info', 'Billing is not set up yet. Premium checkout is coming soon.');
    this.store.set(p.id, true);
    this.send(p.id, { t: 'subscription', subscribed: true });
    this.notice(p, 'info', 'Premium switched on (test mode, no payment was taken).');
  }

  /**
   * Back from Stripe Checkout (?premium=success&session_id=...). The session is retrieved from Stripe and Premium is only
   * unlocked for a completed, paid, subscription-mode session whose subscription is active/trialing on our price.
   * The first host to claim a session keeps it (a replay from another browser is refused; Restore by email can re-link).
   * Idempotent for the same host. Exactly one `premiumResult` per request.
   */
  private async confirmPremium(conn: Conn, p: Player, sessionId: string): Promise<void> {
    const reply = (ok: boolean, code: string, message: string) => this.send(p.id, { t: 'premiumResult', ok, code, message });
    if (!this.billing.enabled) return reply(false, 'billing_off', 'Billing is not set up yet.');
    if (!this.allow(conn.confirmTries, 10) || !this.allow(this.confirmTriesAll, 60)) return reply(false, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    let out;
    try { out = await this.billing.verifyCheckoutSession(sessionId); } catch { return reply(false, 'unreachable', UNREACHABLE); }
    if (!out.ok) {
      const msg: Record<string, string> = {
        bad_session: 'We couldn’t find that checkout. If you were charged, use Restore Premium with your email.',
        not_paid: 'That checkout isn’t paid yet. If you just paid, wait a moment and reload the page.',
        wrong_plan: 'That purchase isn’t an active Premium subscription.',
        inactive: 'That purchase isn’t an active Premium subscription.',
      };
      return reply(false, out.code, msg[out.code]);
    }
    if (this.store.claimSession(sessionId, p.id) !== p.id) {
      return reply(false, 'claimed', 'That purchase is already linked to another device. Use Restore Premium with your email to use it here.');
    }
    const already = this.isSubscribed(p);
    this.store.setStripe(p.id, out.sub);
    if (!already) logActivity('checkout_completed', { test: isTestNick(p.nick) }); // verified with Stripe; a repeat confirm is not counted again
    this.send(p.id, { t: 'subscription', subscribed: true });
    return reply(true, 'ok', 'Premium is active.');
  }

  private confirmTriesAll: number[] = [];

  /**
   * "Restore Premium / I'm the owner". An email in OWNER_EMAILS unlocks Premium (no expiry). Otherwise, with Stripe set up,
   * the email is looked up on Stripe for an active/trialing subscription on our price. The email is NOT verified (nothing
   * proves the caller owns it). Every attempt gets exactly one `restoreResult`; a miss never says why.
   */
  private async restorePremium(conn: Conn, p: Player, rawEmail: string): Promise<void> {
    const reply = (ok: boolean, code: string, message: string) => this.send(p.id, { t: 'restoreResult', ok, code, message });
    if (!this.allow(conn.restoreTries, CONFIG.restoreAttemptsPerMinute) || !this.allow(this.restoreTriesAll, CONFIG.restoreAttemptsPerMinute * 6)) {
      return reply(false, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    }
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return reply(false, 'bad_email', 'Enter a valid email address.');
    if (this.ownerEmails.has(email)) {
      this.store.set(p.id, true, 'owner');
      this.send(p.id, { t: 'subscription', subscribed: true });
      return reply(true, 'ok', 'Premium restored. Welcome back.');
    }
    if (this.billing.enabled) {
      let found = null;
      try { found = await this.billing.findActiveByEmail(email, this.store.customersForEmail(email)); } catch { return reply(false, 'unreachable', UNREACHABLE); }
      if (found) {
        this.store.setStripe(p.id, found); // re-links this subscription to this device
        this.send(p.id, { t: 'subscription', subscribed: true });
        return reply(true, 'ok', 'Premium restored. Welcome back.');
      }
    } else if (this.devUnlock) {
      this.store.set(p.id, true);
      this.send(p.id, { t: 'subscription', subscribed: true });
      return reply(true, 'ok', 'Premium restored (test mode, nothing was verified).');
    }
    return reply(false, 'not_found', 'That email doesn’t have active Premium on this server yet.');
  }

  /**
   * Hidden owner panel: a correct OWNER_CODE (exactly 6 digits, from the environment) unlocks Premium on this device like
   * the OWNER_EMAILS restore (no expiry). 5 wrong tries per 15 minutes per player and per IP, then locked out.
   * The code is never logged or echoed. Exactly one ownerCodeResult per request.
   */
  private ownerCodeUnlock(conn: Conn, p: Player, code: string): void {
    const reply = (ok: boolean, rcode: string, message: string) => this.send(p.id, { t: 'ownerCodeResult', ok, code: rcode, message });
    if (!this.ownerCode) return reply(false, 'not_available', 'Not available.');
    const now = Date.now();
    const keys = ['p:' + p.id, ...(conn.ip ? ['ip:' + conn.ip] : [])];
    const recent = (k: string) => {
      const a = (this.codeFails.get(k) ?? []).filter((x) => now - x < CONFIG.ownerCodeWindowMs);
      this.codeFails.set(k, a);
      return a;
    };
    if (keys.some((k) => recent(k).length >= CONFIG.ownerCodeMaxFails)) return reply(false, 'locked', 'Too many wrong codes. Try again in 15 minutes.');
    const given = Buffer.from(/^\d{6}$/.test(code) ? code : '------');
    const ok = given.length === this.ownerCode.length && crypto.timingSafeEqual(given, this.ownerCode);
    logActivity('owner_code_unlock', { ok });
    if (!ok) {
      for (const k of keys) recent(k).push(now);
      const locked = keys.some((k) => recent(k).length >= CONFIG.ownerCodeMaxFails);
      return reply(false, locked ? 'locked' : 'wrong', locked ? 'Too many wrong codes. Try again in 15 minutes.' : 'That code is not right.');
    }
    this.store.set(p.id, true, 'owner');
    this.send(p.id, { t: 'subscription', subscribed: true });
    return reply(true, 'ok', 'Premium unlocked on this device.');
  }

  private devToggle(p: Player): void {
    if (!this.devUnlock) return this.err(p, 'not_allowed', 'Dev unlock is off');
    const on = this.store.toggle(p.id);
    this.send(p.id, { t: 'subscription', subscribed: on });
  }

  /** Used by the dev-only HTTP endpoint. */
  devSetSubscription(token: string, active?: boolean): boolean | null {
    if (!this.devUnlock) return null;
    const id = hostIdFromToken(token);
    const on = active === undefined ? !this.store.isSubscribed(id) : active;
    this.store.set(id, on);
    this.send(id, { t: 'subscription', subscribed: on });
    return on;
  }

  // ---------- lobby ----------

  lobbyMessage(): object {
    this.sweep();
    const tables = [...this.tables.values()]
      .filter((t) => t.isPublic && !t.tournament && t.status !== 'finished')
      .map((t) => ({
        id: t.id,
        host: t.seats.find((s) => s.playerId === t.hostId)?.name ?? 'Table',
        humans: t.humanCount(),
        open: t.openSeats(),
        target: t.target,
        status: t.status,
        spectators: t.watchers.size,
      }));
    const tournaments = [...this.tournaments.values()]
      .filter((t) => t.isPublic && (t.state === 'registering' || t.state === 'running'))
      .map((t) => ({
        id: t.id, code: t.code, size: t.size, state: t.state,
        organizer: t.entrants.find((e) => e.playerId === t.organizerId)?.name ?? 'Organizer',
        entrants: t.entrants.length, capacity: t.maxEntrants,
      }));
    return { t: 'lobby', tables, tournaments, online: [...this.players.values()].filter((p) => p.ws).length };
  }

  private sendLobbyTo(p: Player): void {
    if (p.ws && !p.tableId && !p.watchTableId) this.send(p.id, this.lobbyMessage());
  }

  markLobbyDirty(): void {
    if (this.lobbyTimer) return;
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null;
      const msg = this.lobbyMessage();
      for (const p of this.players.values()) if (p.ws && !p.tableId && !p.watchTableId) this.send(p.id, msg);
    }, 250);
    this.lobbyTimer.unref?.();
  }
}

