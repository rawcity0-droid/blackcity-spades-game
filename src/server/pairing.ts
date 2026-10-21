// Who partners with whom in a tournament or multi-table event, before it starts.
// - A player can "Make a team": they get a team code, and whoever joins with it is locked in as their partner.
// - Solo entrants are paired with each other in join order; a solo left over gets a computer partner at the start.
// - The organizer can swap two people, pair two people, or split a pair; their edits override team codes.
// teams() is the single source of truth: the registration screen shows it and the start builds from it.

export interface Entrant { playerId: string; name: string; key: number } // key: public id for the organizer's taps
type Result = { ok: true } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

export class Pairing {
  private partner = new Map<string, string>(); // locked pairs, stored both ways
  private codes = new Map<string, string>();   // team code -> the player who made it

  partnerOf(pid: string): string | undefined { return this.partner.get(pid); }
  codeOf(pid: string): string | undefined { for (const [c, owner] of this.codes) if (owner === pid) return c; return undefined; }
  hasCode(code: string): boolean { return this.codes.has(code); }
  /** Spots held for partners who have a team code but have not joined yet. */
  openCodes(): number { let n = 0; for (const owner of this.codes.values()) if (!this.partner.has(owner)) n++; return n; }

  /** The teams as they will be built: each is one or two player ids, in join order of their first member. */
  teams(entrants: Entrant[]): string[][] {
    const ids = new Set(entrants.map((e) => e.playerId));
    const placed = new Set<string>();
    const out: string[][] = [];
    let openSolo: string[] | null = null;
    for (const { playerId: pid } of entrants) {
      if (placed.has(pid)) continue;
      placed.add(pid);
      const mate = this.partner.get(pid);
      if (mate && ids.has(mate)) { placed.add(mate); out.push([pid, mate]); }
      else if (this.codeOf(pid)) out.push([pid]); // waiting for the partner with their code
      else if (openSolo) { openSolo.push(pid); openSolo = null; }
      else { openSolo = [pid]; out.push(openSolo); }
    }
    return out;
  }

  lock(a: string, b: string): void {
    this.unlock(a); this.unlock(b);
    this.dropCode(a); this.dropCode(b);
    this.partner.set(a, b); this.partner.set(b, a);
  }

  unlock(pid: string): void {
    const mate = this.partner.get(pid);
    if (mate) this.partner.delete(mate);
    this.partner.delete(pid);
  }

  makeCode(pid: string, code: string): Result {
    if (this.partner.has(pid)) return fail('not_allowed', 'You already have a partner');
    this.dropCode(pid);
    this.codes.set(code, pid);
    return { ok: true };
  }

  /** Check a team code for someone about to join with it. */
  checkCode(code: string): Result {
    const owner = this.codes.get(code);
    if (!owner) return fail('not_found', 'That team code is no longer active');
    if (this.partner.has(owner)) return fail('full', 'That team is already full');
    return { ok: true };
  }

  /** The joiner used the code: they become the code maker's partner. */
  useCode(code: string, pid: string): void {
    const owner = this.codes.get(code);
    if (!owner) return;
    this.lock(owner, pid);
    this.codes.set(code, owner); // kept so a 3rd person with the code hears "already full"
  }

  /** A player left before the start: their partner becomes solo and their team code stops working. */
  remove(pid: string): void {
    const mate = this.partner.get(pid);
    this.unlock(pid);
    this.dropCode(pid);
    if (mate) this.dropCode(mate);
  }

  /** Organizer: a and b trade places. Both teams they end up in are then locked as shown. */
  swap(entrants: Entrant[], a: string, b: string): Result {
    const teams = this.teams(entrants);
    const ta = teams.find((t) => t.includes(a));
    const tb = teams.find((t) => t.includes(b));
    if (!ta || !tb) return fail('not_found', 'Player not found');
    if (ta === tb) return { ok: true };
    ta[ta.indexOf(a)] = b;
    tb[tb.indexOf(b)] = a;
    for (const t of [ta, tb]) {
      for (const pid of t) { this.unlock(pid); this.dropCode(pid); }
      if (t.length === 2) this.lock(t[0], t[1]);
    }
    return { ok: true };
  }

  /** Organizer: make a and b partners (their old partners become solo). */
  pair(a: string, b: string): Result {
    if (a === b) return fail('not_allowed', 'Pick two different players');
    this.lock(a, b);
    return { ok: true };
  }

  /** Organizer: split a's team; both become solo. Returns the old partner. */
  unpair(pid: string): string | undefined {
    const mate = this.partner.get(pid);
    this.remove(pid);
    return mate;
  }

  /** An organizer edit by public entrant keys: 'swap' and 'pair' take two people, 'unpair' one.
   *  After an unpair the old partner moves to the end of the join order so the two are not paired again at once. */
  arrange(entrants: Entrant[], action: 'swap' | 'pair' | 'unpair', a: number, b?: number): Result {
    const ea = entrants.find((e) => e.key === a);
    const eb = b === undefined ? undefined : entrants.find((e) => e.key === b);
    if (!ea || (action !== 'unpair' && !eb)) return fail('not_found', 'Player not found');
    if (action === 'swap') return this.swap(entrants, ea.playerId, eb!.playerId);
    if (action === 'pair') return this.pair(ea.playerId, eb!.playerId);
    const mate = this.unpair(ea.playerId);
    const i = entrants.findIndex((e) => e.playerId === mate);
    if (i >= 0) entrants.push(...entrants.splice(i, 1));
    return { ok: true };
  }

  /** The teams for the registration screen. Team codes are shown only to the player who made them. */
  view(entrants: Entrant[], organizerId: string, viewer: string) {
    const byId = new Map(entrants.map((e) => [e.playerId, e]));
    return this.teams(entrants).map((t) => {
      const owner = t.length === 1 && this.codeOf(t[0]) ? t[0] : null;
      return {
        members: t.map((pid) => ({ key: byId.get(pid)!.key, name: byId.get(pid)!.name, organizer: pid === organizerId, me: pid === viewer })),
        locked: t.length === 2 && this.partner.has(t[0]),
        waitingCode: owner === null ? null : owner === viewer ? this.codeOf(owner)! : '',
      };
    });
  }

  private dropCode(pid: string): void {
    const c = this.codeOf(pid);
    if (c) this.codes.delete(c);
  }
}
