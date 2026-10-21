// Teams of a tournament or multi-table event, before it starts.
// The organizer gets one team code per team (Team 1..N) to hand out; the two people who enter the same code
// are partners (2 per code). The organizer sits in Team 1. Players who join with the plain tournament code are
// solo: they fill open teams from the end, two solos together. A team of one gets a computer partner at the start.
// The organizer can swap two people, make two people partners, or split a team.

export interface Entrant { playerId: string; name: string; key: number } // key: public id for the organizer's taps
type Result = { ok: true } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

export class Pairing {
  private slots: { code: string; members: string[] }[] = [];
  private solo = new Set<string>(); // joined with the plain code (may be paired with another solo)

  /** One code per team, Team 1 first. */
  setCodes(codes: string[]): void { this.slots = codes.map((code) => ({ code, members: [] })); }
  get count(): number { return this.slots.length; }
  codes(): string[] { return this.slots.map((s) => s.code); }

  /** Change the number of teams, keeping the first teams and their codes. `extra` are codes for added teams.
   *  People in removed teams move into the kept teams: a pair into an empty team, otherwise one by one into open spots.
   *  The caller checks first that everyone fits. Returns the codes of the removed teams. */
  resize(count: number, extra: string[]): string[] {
    const removed = this.slots.slice(count);
    this.slots = [...this.slots.slice(0, count), ...extra.slice(0, Math.max(0, count - this.slots.length)).map((code) => ({ code, members: [] as string[] }))];
    for (const r of removed) {
      if (!r.members.length) continue;
      const empty = this.slots.find((x) => x.members.length === 0);
      if (empty) { empty.members = r.members; continue; }
      for (const pid of r.members) this.slots.find((x) => x.members.length < 2)?.members.push(pid);
    }
    return removed.map((r) => r.code);
  }

  hasCode(code: string): boolean { return this.slots.some((s) => s.code === code); }
  private slotOf(pid: string) { return this.slots.find((s) => s.members.includes(pid)); }
  partnerOf(pid: string): string | undefined { return this.slotOf(pid)?.members.find((m) => m !== pid); }

  /** Place a new entrant: into their team code's team, or (solo) into an open team. */
  add(pid: string, code?: string): Result {
    if (code) {
      const s = this.slots.find((x) => x.code === code);
      if (!s) return fail('not_found', 'That team code is not active');
      if (s.members.length >= 2) return fail('full', 'That team is already full');
      s.members.push(pid);
      return { ok: true };
    }
    const fromEnd = [...this.slots].reverse();
    const s = fromEnd.find((x) => x.members.length === 1 && this.solo.has(x.members[0]))
      ?? fromEnd.find((x) => x.members.length === 0)
      ?? fromEnd.find((x) => x.members.length === 1);
    if (!s) return fail('full', 'This tournament is full');
    s.members.push(pid);
    this.solo.add(pid);
    return { ok: true };
  }

  /** A player left before the start: their partner stays, now alone in the team. */
  remove(pid: string): void {
    const s = this.slotOf(pid);
    if (s) s.members = s.members.filter((m) => m !== pid);
    this.solo.delete(pid);
  }

  /** Teams with at least one person, in team order (one or two player ids each). */
  teams(_entrants?: Entrant[]): string[][] { return this.slots.filter((s) => s.members.length).map((s) => [...s.members]); }

  /** Organizer edit by public entrant keys: 'swap' and 'pair' take two people, 'unpair' (split) one. */
  arrange(entrants: Entrant[], action: 'swap' | 'pair' | 'unpair', a: number, b?: number): Result {
    const pa = entrants.find((e) => e.key === a)?.playerId;
    const pb = b === undefined ? undefined : entrants.find((e) => e.key === b)?.playerId;
    if (!pa || (action !== 'unpair' && !pb)) return fail('not_found', 'Player not found');
    const sa = this.slotOf(pa)!;
    if (action === 'unpair') {
      const mate = this.partnerOf(pa);
      if (!mate) return { ok: true };
      const empty = [...this.slots].reverse().find((x) => x.members.length === 0);
      if (!empty) return fail('full', 'There is no empty team to move them to');
      sa.members = [pa]; empty.members = [mate];
      return { ok: true };
    }
    if (pa === pb) return fail('not_allowed', 'Pick two different players');
    const sb = this.slotOf(pb!)!;
    if (sa === sb) return { ok: true };
    if (action === 'swap') {
      sa.members[sa.members.indexOf(pa)] = pb!;
      sb.members[sb.members.indexOf(pb!)] = pa;
      return { ok: true };
    }
    // pair: b moves in with a; a's old partner (if any) takes b's place
    const mate = this.partnerOf(pa);
    sb.members = sb.members.filter((m) => m !== pb);
    if (mate) sb.members.push(mate);
    sa.members = [pa, pb!];
    return { ok: true };
  }

  /** The teams for the registration screen. Team codes and empty teams are shown only to the organizer. */
  view(entrants: Entrant[], organizerId: string, viewer: string) {
    const byId = new Map(entrants.map((e) => [e.playerId, e]));
    const org = viewer === organizerId;
    return this.slots.map((s, i) => ({
      no: i + 1,
      code: org ? s.code : null,
      fill: s.members.length === 0 ? 'empty' : s.members.length === 1 ? '1 of 2' : 'full',
      members: s.members.map((pid) => ({ key: byId.get(pid)!.key, name: byId.get(pid)!.name, organizer: pid === organizerId, me: pid === viewer })),
    })).filter((t) => org || t.members.length > 0);
  }
}
