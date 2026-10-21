// "Create Tournament" (premium host): a multi-table event of one to eight tables.
// Players join with the event code. When the organizer starts it, entrants are seated at tables of four in
// join order (human seats first, bots fill the rest); only as many tables as needed are opened (at most the
// number the organizer chose). Every table plays ONE game to the event target; the event ends when all
// tables are finished and the winning teams are listed. Event tables reuse the tournament-table rules
// (no joining mid-game, forfeit / fast-forward when a team or everyone leaves).

import { CONFIG } from '../config.js';
import { secureRng } from '../engine/cards.js';
import { Persona, pickPersona } from './personas.js';

export interface EventSeat { playerId: string | null; name: string; persona?: Persona } // playerId null = bot
export type EventTableStatus = 'live' | 'done';

export interface EventTableEntry {
  no: number;
  seats: EventSeat[];            // by table seat 0..3 (0&2 = Team 1, 1&3 = Team 2)
  tableId: string | null;
  tableCode: string | null;
  status: EventTableStatus;
  winner: 0 | 1 | null;
  scores: [number, number] | null;
  forfeit: boolean;
}

export type EState = 'registering' | 'running' | 'finished' | 'cancelled';
type Result<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

export interface EventHost {
  /** Create and start a real table for this entry; return its id and join code. */
  createEventTable(ev: TableEvent, entry: EventTableEntry): { id: string; code: string };
  changed(ev: TableEvent): void;
}

export interface EventInit {
  id: string;
  code: string;
  tables: number;
  target: number;
  organizerId: string;
  /** Premium host's bidding rule for every table this opens: true = partners must bid at least CONFIG.rules.premiumTeamMin together. Default true. */
  teamMin4?: boolean;
  /** Jokers mode for every table this opens (implies Team min 4, no bags). */
  jokers?: boolean;
  host: EventHost;
}

/** Entrants k=0..3 of a table take seats 0,2,1,3 so that consecutive joiners are partners. */
const SEAT_ORDER = [0, 2, 1, 3];

export class TableEvent {
  readonly id: string;
  readonly code: string;
  readonly tables: number;
  readonly target: number;
  readonly organizerId: string;
  readonly teamMin4: boolean;
  readonly jokers: boolean;
  readonly createdAt = Date.now();
  state: EState = 'registering';
  finishedAt: number | null = null;
  entrants: { playerId: string; name: string }[] = [];
  viewers = new Set<string>();
  results: EventTableEntry[] = [];
  private host: EventHost;

  constructor(init: EventInit) {
    this.id = init.id;
    this.code = init.code;
    this.tables = init.tables;
    this.target = init.target;
    this.organizerId = init.organizerId;
    this.jokers = init.jokers === true;
    this.teamMin4 = this.jokers || init.teamMin4 !== false;
    this.host = init.host;
  }

  get capacity(): number { return this.tables * 4; }
  hasEntrant(pid: string): boolean { return this.entrants.some((e) => e.playerId === pid); }
  hasPlayer(pid: string): boolean {
    return this.hasEntrant(pid) || this.results.some((r) => r.seats.some((s) => s.playerId === pid));
  }
  audience(): string[] {
    const ids = new Set<string>([...this.entrants.map((e) => e.playerId), ...this.viewers]);
    for (const r of this.results) for (const s of r.seats) if (s.playerId) ids.add(s.playerId);
    return [...ids];
  }

  join(pid: string, name: string): Result {
    if (this.state !== 'registering') return fail('wrong_state', 'Registration is closed');
    if (this.hasEntrant(pid)) return { ok: true };
    if (this.entrants.length >= this.capacity) return fail('full', 'This tournament is full');
    this.entrants.push({ playerId: pid, name });
    this.host.changed(this);
    return { ok: true };
  }

  leave(pid: string): Result<{ cancelled: boolean }> {
    if (this.state === 'registering') {
      if (pid === this.organizerId) { this.state = 'cancelled'; this.host.changed(this); return { ok: true, cancelled: true }; }
      this.entrants = this.entrants.filter((e) => e.playerId !== pid);
    }
    this.viewers.delete(pid);
    this.host.changed(this);
    return { ok: true, cancelled: false };
  }

  start(pid: string): Result {
    if (pid !== this.organizerId) return fail('not_allowed', 'Only the organizer can start the tournament');
    if (this.state !== 'registering') return fail('wrong_state', 'Already started');
    const count = Math.min(this.tables, Math.max(1, Math.ceil(this.entrants.length / 4)));
    this.state = 'running';
    this.results = [];
    const used = new Set<string>(this.entrants.map((e) => e.name)); // bot names are unique across the whole event
    for (let i = 0; i < count; i++) {
      const group = this.entrants.slice(i * 4, i * 4 + 4);
      const seats: EventSeat[] = [0, 1, 2, 3].map(() => ({ playerId: null, name: '' }));
      group.forEach((e, k) => { seats[SEAT_ORDER[k]] = { playerId: e.playerId, name: e.name }; });
      seats.forEach((s, k) => { if (!s.playerId) seats[k] = this.botSeat(used); });
      const entry: EventTableEntry = { no: i + 1, seats, tableId: null, tableCode: null, status: 'live', winner: null, scores: null, forfeit: false };
      this.results.push(entry);
      const t = this.host.createEventTable(this, entry);
      entry.tableId = t.id;
      entry.tableCode = t.code;
    }
    this.host.changed(this);
    return { ok: true };
  }

  private botSeat(used: Set<string>): EventSeat {
    const persona = pickPersona(secureRng, used);
    used.add(persona.name);
    return { playerId: null, name: persona.name, persona };
  }

  tableResult(matchId: string, winner: 0 | 1, scores: [number, number], forfeit: boolean): void {
    const entry = this.results.find((r) => `t${r.no}` === matchId);
    if (!entry || entry.status === 'done' || this.state !== 'running') return;
    entry.status = 'done';
    entry.winner = winner;
    entry.scores = [scores[0], scores[1]];
    entry.forfeit = forfeit;
    entry.tableId = null;
    entry.tableCode = null;
    if (this.results.every((r) => r.status === 'done')) { this.state = 'finished'; this.finishedAt = Date.now(); }
    this.host.changed(this);
  }

  view(pid: string): object {
    const team = (e: EventTableEntry, side: 0 | 1) => {
      const seats = side === 0 ? [e.seats[0], e.seats[2]] : [e.seats[1], e.seats[3]];
      return {
        name: seats.map((s) => s.name).join(' & '),
        players: seats.map((s) => ({ name: s.name, bot: s.playerId === null, face: s.playerId === null ? s.persona?.face : undefined })),
        mine: seats.some((s) => s.playerId === pid),
      };
    };
    const tables = this.results.map((e) => ({
      no: e.no,
      status: e.status,
      teams: [team(e, 0), team(e, 1)],
      winner: e.winner,
      scores: e.scores,
      forfeit: e.forfeit,
      tableId: e.status === 'live' ? e.tableId : null,
      tableCode: e.status === 'live' ? e.tableCode : null,
    }));
    return {
      t: 'event',
      id: this.id,
      code: this.code,
      tables: this.tables,
      teamMin: this.teamMin4 ? CONFIG.rules.premiumTeamMin : 0,
      jokers: this.jokers,
      target: this.target,
      state: this.state,
      isOrganizer: pid === this.organizerId,
      joined: this.hasPlayer(pid),
      capacity: this.capacity,
      entrants: this.entrants.map((e) => ({ name: e.name, organizer: e.playerId === this.organizerId })),
      results: tables,
      winners: tables.filter((x) => x.status === 'done' && x.winner !== null)
        .map((x) => ({ table: x.no, team: x.teams[x.winner as 0 | 1], scores: x.scores })),
    };
  }
}

export const EVENT_MAX_TABLES = Math.max(...CONFIG.eventTableOptions);
