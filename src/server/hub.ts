// Hub: players, tables, tournaments, the lobby, free-vs-paid checks, and message routing.
// Transport-agnostic: server.ts feeds it WebSocket events. Each player has a stable id derived from
// their reconnect token; the subscription store is keyed by that id.

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { CONFIG, formatPrice } from '../config.js';
import { Rng, secureRng } from '../engine/cards.js';
import { Team } from '../engine/game.js';
import { ClientMsg, ErrorCode, RateLimiter, parseClientMessage } from './protocol.js';
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
  lastSeen: number;
}

export interface Conn {
  ws: WebSocket;
  player: Player | null;
  limiter: RateLimiter;
  strikes: number;
}

export interface HubOptions {
  timings?: Partial<Timings>;
  devUnlock?: boolean;
  store?: SubscriptionStore;
  rng?: Rng;
  rateLimit?: { burst: number; perSecond: number }; // tests raise this
}

export const hostIdFromToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

export const upgradeMessage = (): string => `Upgrade to host — $${formatPrice(CONFIG.subscriptionPriceUsdPerMonth)}/month`;

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export class Hub {
  players = new Map<string, Player>();            // by player id
  private byToken = new Map<string, Player>();
  tables = new Map<string, Table>();
  tournaments = new Map<string, Tournament>();
  private codes = new Map<string, { kind: 'table' | 'tournament'; id: string }>();
  readonly store: SubscriptionStore;
  readonly devUnlock: boolean;
  private timings: Timings;
  private rng: Rng;
  private rate: { burst: number; perSecond: number };
  private lobbyTimer: NodeJS.Timeout | null = null;
  connections = 0;

  constructor(opts: HubOptions = {}) {
    this.store = opts.store ?? new SubscriptionStore(null);
    this.devUnlock = !!opts.devUnlock;
    this.timings = { ...defaultTimings(), ...opts.timings };
    this.rng = opts.rng ?? secureRng;
    this.rate = opts.rateLimit ?? { burst: 30, perSecond: 15 };
  }

  // ---------- connection plumbing ----------

  attach(ws: WebSocket): Conn | null {
    if (this.connections >= CONFIG.limits.maxConnections) return null;
    this.connections += 1;
    return { ws, player: null, limiter: new RateLimiter(this.rate.burst, this.rate.perSecond), strikes: 0 };
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
    try {
      this.route(p, msg);
    } catch (e) {
      this.err(p, 'bad_message', 'Something went wrong');
      console.error('handler error', e);
    }
  }

  onClose(conn: Conn): void {
    this.connections = Math.max(0, this.connections - 1);
    const p = conn.player;
    if (!p || p.ws !== conn.ws) return; // replaced by a newer connection
    p.ws = null;
    p.lastSeen = Date.now();
    if (p.watchTableId) { this.tables.get(p.watchTableId)?.unwatch(p.id); p.watchTableId = null; }
    const seated = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (seated && seated.seatOf(p.id) >= 0) seated.setConnected(p.id, false);
    else if (seated) { seated.unwatch(p.id); p.tableId = null; } // queued for a seat: just drop out
    for (const t of this.tournaments.values()) t.viewers.delete(p.id);
    this.markLobbyDirty();
  }

  close(): void {
    if (this.lobbyTimer) clearTimeout(this.lobbyTimer);
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

  // ---------- hello / identity ----------

  private hello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (conn.player) return;
    this.sweep();
    let p = msg.token ? this.byToken.get(msg.token) : undefined;
    const resumed = !!p;
    if (!p) {
      const token = msg.token ?? crypto.randomBytes(16).toString('hex'); // an unknown well-formed token is adopted (restart continuity)
      p = { id: hostIdFromToken(token), token, nick: msg.nick, ws: null, tableId: null, watchTableId: null, tournamentId: null, lastSeen: Date.now() };
      this.players.set(p.id, p);
      this.byToken.set(token, p);
    }
    if (p.ws && p.ws !== conn.ws) {
      const old = p.ws;
      p.ws = null;
      old.close(4000, 'replaced');
    }
    p.ws = conn.ws;
    p.nick = msg.nick;
    p.lastSeen = Date.now();
    conn.player = p;
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
        devUnlock: this.devUnlock,
      },
    });
    const table = p.tableId ? this.tables.get(p.tableId) : undefined;
    if (table && table.seatOf(p.id) >= 0) table.setConnected(p.id, true);
    else { p.tableId = null; this.sendWs(conn.ws, this.lobbyMessage()); }
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (t) this.send(p.id, t.view(p.id)); else p.tournamentId = null;
  }

  /** Drop long-gone state lazily (called on each hello and lobby build). */
  private sweep(): void {
    const now = Date.now();
    for (const [id, t] of this.tournaments) {
      const old = (t.finishedAt && now - t.finishedAt > 30 * 60000) || t.state === 'cancelled' ||
        (t.state === 'registering' && now - t.createdAt > 3 * 3600000);
      if (old) this.removeTournament(id);
    }
    for (const [id, p] of this.players) {
      if (!p.ws && !p.tableId && !p.tournamentId && now - p.lastSeen > 3600000) {
        this.players.delete(id);
        this.byToken.delete(p.token);
      }
    }
  }

  private removeTournament(id: string): void {
    const t = this.tournaments.get(id);
    if (!t) return;
    this.tournaments.delete(id);
    this.codes.delete(t.code);
    for (const pid of t.audience()) {
      const p = this.players.get(pid);
      if (p && p.tournamentId === id) { p.tournamentId = null; this.send(pid, { t: 'tournamentLeft', reason: t.state === 'cancelled' ? 'The organizer cancelled the tournament' : '' }); }
    }
  }

  // ---------- routing ----------

  private route(p: Player, msg: ClientMsg): void {
    switch (msg.t) {
      case 'createTable': return this.createTable(p, msg.isPublic, msg.target);
      case 'joinTable': return this.joinTable(p, this.tables.get(msg.id), true);
      case 'watchTable': return this.watchTable(p, this.tables.get(msg.id), true);
      case 'joinCode': return this.joinCode(p, msg.code);
      case 'watchCode': return this.watchCode(p, msg.code);
      case 'quickPlay': return this.quickPlay(p);
      case 'startTable': return this.tableAction(p, (t) => t.start(p.id));
      case 'bid': return this.tableAction(p, (t) => t.bid(p.id, msg.bid));
      case 'play': return this.tableAction(p, (t) => t.play(p.id, msg.card));
      case 'ready': return this.tableAction(p, (t) => t.ready(p.id));
      case 'rematch': return this.tableAction(p, (t) => t.rematch(p.id));
      case 'leaveTable': return this.leaveTable(p);
      case 'createTournament': return this.createTournament(p, msg.size, msg.isPublic);
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
    if (p.tableId) return 'Leave your current table first';
    const t = p.tournamentId ? this.tournaments.get(p.tournamentId) : undefined;
    if (t && (t.state === 'registering' || t.state === 'running')) return 'You are in a tournament. Leave it first';
    return null;
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
      for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(this.rng() * CODE_CHARS.length)];
      if (!this.codes.has(c)) return c;
    }
  }

  // ---------- tables ----------

  private makeTable(opts: { isPublic: boolean; target: number; hostId: string | null; tournament?: { id: string; matchId: string; label: string } }): Table {
    const id = this.newId((x) => this.tables.has(x));
    const code = this.newCode();
    const table = new Table({
      id, code, isPublic: opts.isPublic, target: opts.target, hostId: opts.hostId, timings: this.timings,
      tournament: opts.tournament, rng: this.rng,
      hooks: {
        send: (pid, msg) => this.send(pid, msg),
        changed: () => this.markLobbyDirty(),
        destroyed: (t, people) => this.tableDestroyed(t, people),
        released: (pid, t) => this.releasePlayer(pid, t),
        matchOver: (t, winner, scores, forfeit) => this.matchOver(t, winner, scores, forfeit),
      },
    });
    this.tables.set(id, table);
    this.codes.set(code, { kind: 'table', id });
    return table;
  }

  private tableDestroyed(t: Table, people: string[]): void {
    this.tables.delete(t.id);
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
    this.codes.delete(t.code);
    for (const pid of people) this.releasePlayer(pid, t, 'Match finished');
    const tour = info ? this.tournaments.get(info.id) : undefined;
    if (tour && info) tour.matchResult(info.matchId, winner, scores);
    this.markLobbyDirty();
  }

  private leaveCurrent(p: Player): void {
    if (p.watchTableId) { this.tables.get(p.watchTableId)?.unwatch(p.id); p.watchTableId = null; }
  }

  private createTable(p: Player, isPublic: boolean, target: number): void {
    if (!isPublic && CONFIG.hostOnly.privateTables && !this.isSubscribed(p)) {
      return this.err(p, 'upgrade_required', upgradeMessage());
    }
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    const table = this.makeTable({ isPublic, target, hostId: p.id });
    table.seatHuman(0, p.id, p.nick, true);
    p.tableId = table.id;
    table.broadcast();
    this.markLobbyDirty();
  }

  private joinCode(p: Player, code: string): void {
    const target = this.codes.get(code);
    if (!target) return this.err(p, 'not_found', 'No table or tournament with that code');
    if (target.kind === 'tournament') return this.joinTournament(p, this.tournaments.get(target.id), false);
    this.joinTable(p, this.tables.get(target.id), false);
  }

  private joinTable(p: Player, t: Table | undefined, byId: boolean): void {
    if (!t || (byId && !t.isPublic)) return this.err(p, 'not_found', 'Table not found');
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
    if (target.kind === 'tournament') return this.watchTournament(p, this.tournaments.get(target.id));
    this.watchTable(p, this.tables.get(target.id), false);
  }

  private watchTable(p: Player, t: Table | undefined, byId: boolean): void {
    if (!t || (byId && !t.isPublic && !t.tournament)) return this.err(p, 'not_found', 'Table not found');
    if (!CONFIG.spectatePrivateTables && !t.isPublic && !t.tournament) return this.err(p, 'not_allowed', 'This table cannot be watched');
    if (p.tableId) return this.err(p, 'busy', 'Leave your current table first');
    if (p.watchTableId === t.id) return;
    this.leaveCurrent(p);
    p.watchTableId = t.id;
    t.watch(p.id);
    if (t.tournament) {
      const tour = this.tournaments.get(t.tournament.id);
      if (tour && !tour.hasPlayer(p.id)) { tour.viewers.add(p.id); this.send(p.id, tour.view(p.id)); }
    }
  }

  private quickPlay(p: Player): void {
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    const candidates = [...this.tables.values()]
      .filter((t) => t.isPublic && !t.tournament && t.openSeats() > 0 && t.status !== 'finished')
      .sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1) || b.humanCount() - a.humanCount());
    if (candidates.length > 0) return this.joinTable(p, candidates[0], true);
    if (this.tables.size >= CONFIG.limits.maxTables) return this.err(p, 'too_many', 'The server is busy. Try again soon');
    this.leaveCurrent(p);
    const table = this.makeTable({ isPublic: true, target: CONFIG.quickPlayTarget, hostId: p.id });
    table.seatHuman(0, p.id, p.nick, true);
    p.tableId = table.id;
    table.startGame(); // bots fill the other seats at once
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

  // ---------- tournaments ----------

  private createTournament(p: Player, size: number, isPublic: boolean): void {
    if (CONFIG.hostOnly.hostTournaments && !this.isSubscribed(p)) return this.err(p, 'upgrade_required', upgradeMessage());
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    if (this.tournaments.size >= CONFIG.limits.maxTournaments) return this.err(p, 'too_many', 'Too many tournaments right now');
    this.leaveCurrent(p);
    const id = this.newId((x) => this.tournaments.has(x));
    const code = this.newCode();
    const t = new Tournament({ id, code, size, organizerId: p.id, isPublic, rng: this.rng, host: this.tournamentHost() });
    this.tournaments.set(id, t);
    this.codes.set(code, { kind: 'tournament', id });
    t.join(p.id, p.nick);
    p.tournamentId = id;
    this.pushTournament(t);
    this.markLobbyDirty();
  }

  private joinTournament(p: Player, t: Tournament | undefined, byId: boolean): void {
    if (!t || (byId && !t.isPublic)) return this.err(p, 'not_found', 'Tournament not found');
    if (p.tournamentId === t.id) return this.pushTournament(t);
    const busy = this.busyReason(p);
    if (busy) return this.err(p, 'busy', busy);
    this.leaveCurrent(p);
    const r = t.join(p.id, p.nick);
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
    if (!r.ok) this.err(p, r.code as ErrorCode, r.message);
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
    const table = this.makeTable({ isPublic: false, target: m.target, hostId: null, tournament: { id: t.id, matchId: m.id, label } });
    m.teams.forEach((team, side) => {
      const seats = side === 0 ? [0, 2] : [1, 3];
      team!.slots.forEach((slot, k) => {
        const seat = seats[k];
        const pl = slot.playerId ? this.players.get(slot.playerId) : undefined;
        if (!pl) { table.seatBot(seat); return; }
        this.leaveCurrent(pl);
        if (pl.tableId) this.tables.get(pl.tableId)?.leave(pl.id);
        table.seatHuman(seat, pl.id, pl.nick, !!pl.ws);
        pl.tableId = table.id;
      });
    });
    table.startGame();
    return { id: table.id, code: table.code };
  }

  // ---------- subscription (dev stub) ----------

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

