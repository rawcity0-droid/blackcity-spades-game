// Single-elimination tournament: registration, random seeding, bracket, bot-vs-bot instant matches,
// and automatic advancement. Human matches are played at real tables created through the host callback.
// Team 0 of a match sits at seats 0&2, team 1 at seats 1&3.

import { CONFIG, tournamentTarget } from '../config.js';
import { Rng, secureRng, shuffle } from '../engine/cards.js';
import { simulateGame } from '../engine/sim.js';

export interface Slot { playerId: string | null; name: string } // playerId null = bot
export interface TeamRef { id: number; name: string; slots: [Slot, Slot] }
export type MatchStatus = 'waiting' | 'live' | 'done';

export interface Match {
  id: string;
  round: number;
  index: number;
  teams: [TeamRef | null, TeamRef | null];
  winner: 0 | 1 | null;
  score: [number, number] | null;
  status: MatchStatus;
  tableId: string | null;
  tableCode: string | null;
  target: number;
  simulated: boolean;
}

export type TState = 'registering' | 'running' | 'finished' | 'cancelled';
type Result<T = object> = ({ ok: true } & T) | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

export interface TournamentHost {
  /** Create and start a table for a human match; return its id and join code. */
  createMatchTable(t: Tournament, m: Match, label: string): { id: string; code: string };
  changed(t: Tournament): void;
}

export interface TournamentInit {
  id: string;
  code: string;
  size: number;
  organizerId: string;
  isPublic: boolean;
  host: TournamentHost;
  rng?: Rng;
}

export function roundName(size: number, round: number): string {
  const teams = size / 2 ** round;
  return teams === 2 ? 'Final' : teams === 4 ? 'Semifinals' : teams === 8 ? 'Quarterfinals' : `Round of ${teams}`;
}

export class Tournament {
  readonly id: string;
  readonly code: string;
  readonly size: number;
  readonly organizerId: string;
  readonly isPublic: boolean;
  readonly createdAt = Date.now();
  state: TState = 'registering';
  finishedAt: number | null = null;
  entrants: { playerId: string; name: string }[] = [];
  viewers = new Set<string>();
  rounds: Match[][] = [];
  champion: TeamRef | null = null;
  runnerUp: TeamRef | null = null;
  private host: TournamentHost;
  private rng: Rng;

  constructor(init: TournamentInit) {
    this.id = init.id;
    this.code = init.code;
    this.size = init.size;
    this.organizerId = init.organizerId;
    this.isPublic = init.isPublic;
    this.host = init.host;
    this.rng = init.rng ?? secureRng;
  }

  get totalRounds(): number { return Math.log2(this.size); }
  get maxEntrants(): number { return this.size * CONFIG.limits.maxEntrantsPerTournamentTeam; }

  hasEntrant(pid: string): boolean { return this.entrants.some((e) => e.playerId === pid); }

  /** True if this player is part of the tournament (registered, or on a team in the bracket). */
  hasPlayer(pid: string): boolean {
    return this.hasEntrant(pid) || this.rounds.some((r) => r.some((m) => m.teams.some((t) => t?.slots.some((s) => s.playerId === pid))));
  }

  /** Everyone who should receive bracket updates. */
  audience(): string[] {
    const ids = new Set<string>([...this.entrants.map((e) => e.playerId), ...this.viewers]);
    for (const r of this.rounds) for (const m of r) for (const t of m.teams) for (const s of t?.slots ?? []) if (s.playerId) ids.add(s.playerId);
    return [...ids];
  }

  join(pid: string, name: string): Result {
    if (this.state !== 'registering') return fail('wrong_state', 'Registration is closed');
    if (this.hasEntrant(pid)) return { ok: true };
    if (this.entrants.length >= this.maxEntrants) return fail('full', 'This tournament is full');
    this.entrants.push({ playerId: pid, name });
    this.host.changed(this);
    return { ok: true };
  }

  /** Leave: before the start this removes the entrant (the organizer leaving cancels it);
   *  while running the player's team slot turns into a bot for matches not yet played. */
  leave(pid: string): Result<{ cancelled: boolean }> {
    if (this.state === 'registering') {
      if (pid === this.organizerId) { this.state = 'cancelled'; this.host.changed(this); return { ok: true, cancelled: true }; }
      this.entrants = this.entrants.filter((e) => e.playerId !== pid);
    } else if (this.state === 'running') {
      for (const r of this.rounds) for (const m of r) {
        if (m.status === 'done') continue; // live matches too: the TeamRef is shared with the later rounds the team may reach
        for (const t of m.teams) for (const s of t?.slots ?? []) if (s.playerId === pid) { s.playerId = null; s.name = 'Bot'; }
      }
    }
    this.viewers.delete(pid);
    this.host.changed(this);
    return { ok: true, cancelled: false };
  }

  start(pid: string): Result {
    if (pid !== this.organizerId) return fail('not_allowed', 'Only the organizer can start the tournament');
    if (this.state !== 'registering') return fail('wrong_state', 'Already started');
    this.build();
    this.state = 'running';
    for (const m of this.rounds[0]) this.resolve(m);
    this.host.changed(this);
    return { ok: true };
  }

  /** Pair solos, add a bot partner to a leftover solo, fill with bot teams, shuffle seeding, build the bracket. */
  private build(): void {
    const teams: TeamRef[] = [];
    const humans = this.entrants;
    for (let i = 0; i < humans.length; i += 2) {
      const a = humans[i];
      const b = humans[i + 1];
      const slots: [Slot, Slot] = [
        { playerId: a.playerId, name: a.name },
        b ? { playerId: b.playerId, name: b.name } : { playerId: null, name: 'Bot' },
      ];
      teams.push({ id: 0, name: `${slots[0].name} & ${slots[1].name}`, slots });
    }
    let botTeams = 0;
    while (teams.length < this.size) {
      botTeams += 1;
      teams.push({ id: 0, name: `Bot Team ${botTeams}`, slots: [{ playerId: null, name: 'Bot' }, { playerId: null, name: 'Bot' }] });
    }
    const seeded = shuffle(teams, this.rng);
    seeded.forEach((t, i) => { t.id = i + 1; });
    const total = this.totalRounds;
    this.rounds = [];
    for (let r = 0; r < total; r++) {
      const count = this.size / 2 ** (r + 1);
      this.rounds.push(Array.from({ length: count }, (_, index) => ({
        id: `r${r}m${index}`, round: r, index,
        teams: [null, null] as [TeamRef | null, TeamRef | null],
        winner: null, score: null, status: 'waiting' as MatchStatus, tableId: null, tableCode: null,
        target: tournamentTarget(r, total), simulated: false,
      })));
    }
    this.rounds[0].forEach((m, i) => { m.teams = [seeded[2 * i], seeded[2 * i + 1]]; });
  }

  findMatch(matchId: string): Match | undefined {
    for (const r of this.rounds) for (const m of r) if (m.id === matchId) return m;
    return undefined;
  }

  /** A match is ready: simulate it if it has no humans, otherwise open a table. */
  private resolve(m: Match): void {
    if (m.status !== 'waiting' || !m.teams[0] || !m.teams[1]) return;
    const hasHuman = m.teams.some((t) => t?.slots.some((s) => s.playerId !== null));
    if (!hasHuman) {
      const res = simulateGame({ target: m.target, rng: this.rng });
      m.simulated = true;
      this.complete(m, res.winner, res.scores);
      return;
    }
    const label = `${roundName(this.size, m.round)} · to ${m.target}`;
    const table = this.host.createMatchTable(this, m, label);
    m.tableId = table.id;
    m.tableCode = table.code;
    m.status = 'live';
  }

  /** Record a finished match (from a real table or a simulation) and advance the winner. */
  matchResult(matchId: string, winner: 0 | 1, score: [number, number]): void {
    const m = this.findMatch(matchId);
    if (!m || m.status === 'done' || this.state !== 'running') return;
    this.complete(m, winner, score);
    this.host.changed(this);
  }

  private complete(m: Match, winner: 0 | 1, score: [number, number]): void {
    m.winner = winner;
    m.score = [score[0], score[1]];
    m.status = 'done';
    m.tableId = null;
    m.tableCode = null;
    const win = m.teams[winner] as TeamRef;
    const lose = m.teams[1 - winner] as TeamRef;
    if (m.round === this.totalRounds - 1) {
      this.champion = win;
      this.runnerUp = lose;
      this.state = 'finished';
      this.finishedAt = Date.now();
      return;
    }
    const next = this.rounds[m.round + 1][m.index >> 1];
    next.teams[m.index & 1] = win;
    this.resolve(next);
  }

  // ---------- views ----------

  view(pid: string): object {
    const teamView = (t: TeamRef | null) => t && {
      id: t.id,
      name: t.name,
      players: t.slots.map((s) => ({ name: s.name, bot: s.playerId === null })),
      mine: t.slots.some((s) => s.playerId === pid),
    };
    return {
      t: 'tournament',
      id: this.id,
      code: this.code,
      size: this.size,
      state: this.state,
      isPublic: this.isPublic,
      isOrganizer: pid === this.organizerId,
      joined: this.hasPlayer(pid),
      capacity: this.maxEntrants,
      entrants: this.entrants.map((e) => ({ name: e.name, organizer: e.playerId === this.organizerId })),
      champion: this.champion && teamView(this.champion),
      runnerUp: this.runnerUp && teamView(this.runnerUp),
      rounds: this.rounds.map((r, ri) => ({
        name: roundName(this.size, ri),
        target: tournamentTarget(ri, this.totalRounds),
        matches: r.map((m) => ({
          id: m.id,
          teams: [teamView(m.teams[0]), teamView(m.teams[1])],
          winner: m.winner,
          score: m.score,
          status: m.status,
          simulated: m.simulated,
          tableId: m.status === 'live' ? m.tableId : null,
          tableCode: m.status === 'live' ? m.tableCode : null,
        })),
      })),
    };
  }
}
