// "Create Tournament" (premium host): a multi-table event of one to eight tables.
// Players join with the event code. When the organizer starts it, the teams (team codes, organizer edits,
// solos paired in join order) are seated two per table (bots fill the rest); only as many tables as needed are opened (at most the
// number the organizer chose). Every table plays ONE game to the event target; the event ends when all
// tables are finished and the winning teams are listed. Event tables reuse the tournament-table rules
// (no joining mid-game, forfeit / fast-forward when a team or everyone leaves).

import { fallbackAvatar } from './avatar.js';
import { CONFIG } from '../config.js';
import { secureRng } from '../engine/cards.js';
import { Persona, pickPersona } from './personas.js';
import { Entrant, Pairing } from './pairing.js';

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
  /** "2 sets and out" at every table this opens (each game of a series counts fresh). */
  setsOut?: boolean;
  bigBids?: boolean;
  host: EventHost;
}

/** People k=0..3 of a table (two teams) take seats 0,2,1,3 so that each team's two players are partners. */
const SEAT_ORDER = [0, 2, 1, 3];

export class TableEvent {
  readonly id: string;
  readonly code: string;
  tables: number;
  target: number;
  readonly organizerId: string;
  teamMin4: boolean;
  jokers: boolean;
  setsOut: boolean;
  bigBids: boolean;
  readonly createdAt = Date.now();
  state: EState = 'registering';
  finishedAt: number | null = null;
  entrants: Entrant[] = [];
  readonly pairing = new Pairing();
  private nextKey = 1;
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
    this.setsOut = init.setsOut === true;
    this.bigBids = init.bigBids === true;
    this.teamMin4 = this.jokers || init.teamMin4 !== false;
    this.host = init.host;
    this.pairing.setCodes(Array.from({ length: this.tables * 2 }, () => '')); // the hub hands out the real team codes
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

  /** Join; with one of the organizer's team codes the player joins that team, otherwise they fill an open team. */
  join(pid: string, name: string, teamCode?: string): Result {
    if (this.state !== 'registering') return fail('wrong_state', 'Registration is closed');
    if (this.hasEntrant(pid)) return { ok: true };
    if (this.entrants.length >= this.capacity) return fail('full', 'This tournament is full');
    const r = this.pairing.add(pid, teamCode);
    if (!r.ok) return r;
    this.entrants.push({ playerId: pid, name, key: this.nextKey++ });
    this.host.changed(this);
    return { ok: true };
  }

  /** Organizer, before the start: change the number of tables, target or bidding rule. Joined players are kept;
   *  people in teams that no longer exist move into open teams. Refused if more people joined than the new tables seat. */
  edit(pid: string, patch: { tables?: number; target?: number; teamMin4?: boolean; jokers?: boolean; setsOut?: boolean; bigBids?: boolean }, newCodes: (n: number) => string[]): Result<{ removedCodes: string[]; addedCodes: string[] }> {
    if (pid !== this.organizerId) return fail('not_allowed', 'Only the organizer can change the settings');
    if (this.state !== 'registering') return fail('wrong_state', 'Settings can’t be changed after the start. You can end the tournament from the menu.');
    let removedCodes: string[] = [];
    let addedCodes: string[] = [];
    if (patch.target !== undefined && !(CONFIG.tableTargets as readonly number[]).includes(patch.target)) return fail('bad_message', 'Bad target score');
    if (patch.tables !== undefined && patch.tables !== this.tables) {
      if (!(CONFIG.eventTableOptions as readonly number[]).includes(patch.tables)) return fail('bad_message', 'Choose 1 to 8 tables');
      if (this.entrants.length > patch.tables * 4) return fail('full', `${this.entrants.length} people have joined, but ${patch.tables} ${patch.tables === 1 ? 'table seats' : 'tables seat'} only ${patch.tables * 4}. Ask some to leave or pick more tables.`);
      addedCodes = newCodes(Math.max(0, (patch.tables - this.tables) * 2));
      removedCodes = this.pairing.resize(patch.tables * 2, addedCodes);
      this.tables = patch.tables;
    }
    if (patch.target !== undefined) this.target = patch.target;
    if (patch.setsOut !== undefined) this.setsOut = patch.setsOut;
    if (patch.bigBids !== undefined) this.bigBids = patch.bigBids;
    if (patch.teamMin4 !== undefined || patch.jokers !== undefined) {
      this.jokers = patch.jokers === true;
      this.teamMin4 = this.jokers || patch.teamMin4 !== false;
    }
    this.host.changed(this);
    return { ok: true, removedCodes, addedCodes };
  }

  /** Organizer only, before the start: swap two people, pair two people, or split a pair. */
  arrange(pid: string, action: 'swap' | 'pair' | 'unpair', a: number, b?: number): Result {
    if (pid !== this.organizerId) return fail('not_allowed', 'Only the organizer can change the teams');
    if (this.state !== 'registering') return fail('wrong_state', 'Teams are locked once the tournament starts');
    const r = this.pairing.arrange(this.entrants, action, a, b);
    if (r.ok) this.host.changed(this);
    return r;
  }

  leave(pid: string): Result<{ cancelled: boolean }> {
    if (this.state === 'registering') {
      if (pid === this.organizerId) { this.state = 'cancelled'; this.host.changed(this); return { ok: true, cancelled: true }; }
      this.pairing.remove(pid);
      this.entrants = this.entrants.filter((e) => e.playerId !== pid);
    }
    this.viewers.delete(pid);
    this.host.changed(this);
    return { ok: true, cancelled: false };
  }

  start(pid: string): Result {
    if (pid !== this.organizerId) return fail('not_allowed', 'Only the organizer can start the tournament');
    if (this.state !== 'registering') return fail('wrong_state', 'Already started');
    // Two teams per table, as shown at registration; a team of one leaves its partner seat to a bot
    const byId = new Map(this.entrants.map((e) => [e.playerId, e]));
    const people = this.pairing.teams(this.entrants).flatMap((t) => [byId.get(t[0])!, t[1] ? byId.get(t[1])! : null]);
    const count = Math.min(this.tables, Math.max(1, Math.ceil(people.length / 4)));
    this.state = 'running';
    this.results = [];
    const used = new Set<string>(this.entrants.map((e) => e.name)); // bot names are unique across the whole event
    for (let i = 0; i < count; i++) {
      const group = people.slice(i * 4, i * 4 + 4);
      const seats: EventSeat[] = [0, 1, 2, 3].map(() => ({ playerId: null, name: '' }));
      group.forEach((e, k) => { if (e) seats[SEAT_ORDER[k]] = { playerId: e.playerId, name: e.name }; });
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
        players: seats.map((s) => ({ name: s.name, bot: s.playerId === null, face: s.playerId === null ? s.persona?.face ?? fallbackAvatar('n:' + s.name) : undefined })),
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
      setsOut: this.setsOut,
      bigBids: this.bigBids,
      target: this.target,
      state: this.state,
      isOrganizer: pid === this.organizerId,
      joined: this.hasPlayer(pid),
      capacity: this.capacity,
      entrants: this.entrants.map((e) => ({ name: e.name, organizer: e.playerId === this.organizerId })),
      teams: this.state === 'registering' ? this.pairing.view(this.entrants, this.organizerId, pid) : [],
      results: tables,
      winners: tables.filter((x) => x.status === 'done' && x.winner !== null)
        .map((x) => ({ table: x.no, team: x.teams[x.winner as 0 | 1], scores: x.scores })),
    };
  }
}

export const EVENT_MAX_TABLES = Math.max(...CONFIG.eventTableOptions);
