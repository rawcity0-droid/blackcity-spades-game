// Heuristic bot. chooseBid() estimates tricks from the bot's own hand; choosePlay() picks from
// legalPlays() only, so it can never make an illegal move. It reads only its own hand plus public state.

import { Card, rankOf, suitOf } from './cards.js';
import { CONFIG } from '../config.js';
import { GameState, beats, legalBids, legalPlays, partnerOf, teamOf } from './game.js';

const ACE = 12, KING = 11, QUEEN = 10, TEN = 8;

/** Estimate how many tricks a hand will take and turn it into a bid: CONFIG.rules.minBid..maxBid, or 0 = nil for a very weak hand when Nil is allowed. */
/** How well a bot plays: 'normal' is the plain heuristic, 'strong' also counts cards, reads voids and plays around Nil bids. */
export type Skill = 'normal' | 'strong';

export function chooseBid(g: GameState, seat: number, skill: Skill = 'normal'): number {
  const hand = g.hands[seat];
  const bySuit = (s: string) => hand.filter((c) => suitOf(c) === s);
  const spades = bySuit('S');
  let est = 0;

  // Spades: top honors plus length beyond three
  for (const c of spades) {
    const r = rankOf(c);
    if (r === ACE) est += 1;
    else if (r === KING) est += spades.length >= 2 ? 0.9 : 0.4;
    else if (r === QUEEN) est += spades.length >= 3 ? 0.6 : 0.2;
    else if (r === 9 && spades.length >= 4) est += 0.3; // jack
  }
  if (spades.length > 3) est += (spades.length - 3) * 0.9;

  // Side suits: aces, guarded kings, and short suits that can be ruffed
  for (const s of ['H', 'D', 'C']) {
    const cards = bySuit(s);
    const ranks = cards.map(rankOf);
    if (ranks.includes(ACE)) est += 1;
    if (ranks.includes(KING)) est += cards.length >= 2 ? 0.7 : 0.2;
    if (ranks.includes(QUEEN) && cards.length >= 3 && ranks.includes(KING)) est += 0.3;
    if (spades.length >= 3) {
      if (cards.length === 0) est += 1;
      else if (cards.length === 1) est += 0.5;
    }
  }

  // Nil: a very weak hand with no high spades and few high cards
  const highSpade = spades.some((c) => rankOf(c) >= TEN);
  const highCards = hand.filter((c) => rankOf(c) >= KING).length;
  const partnerBid = g.bids[partnerOf(seat)];
  if (skill === 'strong') return strongBid(g, seat, est, spades.length, highSpade);
  if (CONFIG.rules.allowNil && est < 1.1 && spades.length <= 2 && !highSpade && highCards <= 1 && partnerBid !== 0 && legalBids(g, seat).includes(0)) return 0;

  const want = Math.max(CONFIG.rules.minBid, Math.min(CONFIG.rules.maxBid, Math.round(est)));
  // Team minimum: if the bid would leave the pair short, bid what is needed (the lowest legal bid at or above the wish)
  const legal = legalBids(g, seat);
  return legal.includes(want) ? want : legal.filter((b) => b >= want)[0] ?? legal[legal.length - 1];
}

/** Tricks the seat's team still needs: combined non-nil bid minus tricks won by non-nil players. */
function tricksStillNeeded(g: GameState, seat: number): number {
  const team = teamOf(seat);
  let need = 0;
  for (let s = 0; s < 4; s++) {
    if (teamOf(s) !== team) continue;
    const bid = g.bids[s] ?? 0;
    if (bid > 0) need += bid - g.tricksWon[s];
  }
  return need;
}

const byRankAsc = (a: Card, b: Card) => rankOf(a) - rankOf(b);
const lowest = (cards: Card[]) => cards.slice().sort(byRankAsc)[0];
const highest = (cards: Card[]) => cards.slice().sort(byRankAsc)[cards.length - 1];

/** Current winning play of the trick in progress. */
function currentWinner(g: GameState): { seat: number; card: Card } {
  let best = g.trick[0];
  for (const p of g.trick.slice(1)) if (beats(p.card, best.card)) best = p;
  return best;
}

export function choosePlay(g: GameState, seat: number, skill: Skill = 'normal'): Card {
  const legal = legalPlays(g, seat);
  if (legal.length === 0) throw new Error('Bot has no legal play');
  if (legal.length === 1) return legal[0];
  if (skill === 'strong') return strongPlay(g, seat, legal);
  return normalPlay(g, seat, legal);
}

/** The plain heuristic (normal bots, and the fallback for strong bots). */
function normalPlay(g: GameState, seat: number, legal: Card[]): Card {
  const partner = partnerOf(seat);
  const iAmNil = g.bids[seat] === 0;
  const partnerNilAlive = g.bids[partner] === 0 && g.tricksWon[partner] === 0;
  const wantTricks = tricksStillNeeded(g, seat) > 0;
  const nonSpades = legal.filter((c) => suitOf(c) !== 'S');

  // ---- leading ----
  if (g.trick.length === 0) {
    if (iAmNil) return lowest(nonSpades.length ? nonSpades : legal);
    if (wantTricks || partnerNilAlive) {
      const aces = nonSpades.filter((c) => rankOf(c) === ACE);
      if (aces.length) return aces[0];
      const bigSpades = g.spadesBroken ? legal.filter((c) => suitOf(c) === 'S' && rankOf(c) >= KING) : [];
      if (bigSpades.length) return highest(bigSpades);
      const kings = nonSpades.filter((c) => rankOf(c) === KING);
      if (kings.length) return kings[0];
    }
    return lowest(nonSpades.length ? nonSpades : legal);
  }

  // ---- following ----
  const leadSuit = suitOf(g.trick[0].card);
  const win = currentWinner(g);
  const canFollow = legal.some((c) => suitOf(c) === leadSuit);
  const winners = legal.filter((c) => beats(c, win.card));
  const last = g.trick.length === 3;

  if (iAmNil) {
    const under = legal.filter((c) => !beats(c, win.card));
    if (under.length) return highest(under); // duck as high as safely possible
    // Forced to win: use the lowest card; when discarding avoid trumping if we can
    const safe = canFollow ? legal : nonSpades.length ? nonSpades : legal;
    return lowest(safe);
  }

  const partnerWinning = win.seat === partner;
  const cheapDump = (): Card => {
    if (canFollow) return lowest(legal);
    return lowest(nonSpades.length ? nonSpades : legal); // discard the lowest side card, keep trumps
  };

  if (partnerWinning && !partnerNilAlive) {
    // Partner is winning: add nothing unless they might be overtaken by a cheap-to-beat card
    const partnerCard = win.card;
    if (!last && wantTricks && suitOf(partnerCard) !== 'S' && rankOf(partnerCard) < QUEEN && winners.length) {
      return lowest(winners);
    }
    return cheapDump();
  }
  if (partnerWinning && partnerNilAlive) {
    // Take the trick away from our nil partner
    return winners.length ? lowest(winners) : cheapDump();
  }
  if (wantTricks || partnerNilAlive) {
    return winners.length ? lowest(winners) : cheapDump();
  }
  // Contract already made: avoid bags by ducking under the winner when possible
  const under = legal.filter((c) => !beats(c, win.card));
  if (under.length && canFollow) return highest(under);
  return cheapDump();
}


// ======================= strong bots =======================
// Same inputs as the normal bot (own hand + public table state), but they remember every card played this hand.

function bidFrom(g: GameState, seat: number, want: number): number {
  want = Math.max(CONFIG.rules.minBid, Math.min(CONFIG.rules.maxBid, want));
  const legal = legalBids(g, seat).filter((b) => b > 0 || want === 0);
  return legal.includes(want) ? want : legal.filter((b) => b >= want)[0] ?? legal[legal.length - 1];
}

/** Strong bots bid Nil a bit more often on weak hands (the +100 is worth it) and otherwise bid their estimate. Tuned with scripts/sim-strong.ts. */
function strongBid(g: GameState, seat: number, est: number, spadeCount: number, highSpade: boolean): number {
  const hand = g.hands[seat];
  const partnerBid = g.bids[partnerOf(seat)];
  const highCards = hand.filter((c) => rankOf(c) >= KING).length;
  if (CONFIG.rules.allowNil && est < 1.8 && spadeCount <= 3 && !highSpade && highCards <= 1 && partnerBid !== 0 && legalBids(g, seat).includes(0)) return 0;
  return bidFrom(g, seat, Math.round(est));
}

/** Cards nobody can see yet from this seat: not in my hand, not played this hand, not on the table. */
function unseenCards(g: GameState, seat: number): Set<Card> {
  const known = new Set<Card>(g.hands[seat]);
  for (const t of g.played ?? []) for (const p of t) known.add(p.card);
  for (const p of g.trick) known.add(p.card);
  const out = new Set<Card>();
  for (const s of ['S', 'H', 'D', 'C']) for (const r of '23456789TJQKA') if (!known.has(r + s)) out.add(r + s);
  return out;
}

/** Suits each seat has shown it has none of (failed to follow). */
function voids(g: GameState): Set<string>[] {
  const v = [0, 1, 2, 3].map(() => new Set<string>());
  for (const t of [...(g.played ?? []), g.trick]) {
    if (!t.length) continue;
    const lead = suitOf(t[0].card);
    for (const p of t.slice(1)) if (suitOf(p.card) !== lead) v[p.seat].add(lead);
  }
  return v;
}

/** No unseen card of the same suit outranks this card. */
function isTop(card: Card, unseen: Set<Card>): boolean {
  for (const c of unseen) if (suitOf(c) === suitOf(card) && rankOf(c) > rankOf(card)) return false;
  return true;
}

function strongPlay(g: GameState, seat: number, legal: Card[]): Card {
  const partner = partnerOf(seat);
  const opps = [(seat + 1) % 4, (seat + 3) % 4];
  const unseen = unseenCards(g, seat);
  const vd = voids(g);
  const spadesOut = [...unseen].some((c) => suitOf(c) === 'S');
  const iAmNil = g.bids[seat] === 0;
  const partnerNilAlive = g.bids[partner] === 0 && g.tricksWon[partner] === 0;
  const oppNil = opps.filter((o) => g.bids[o] === 0 && g.tricksWon[o] === 0);
  const wantTricks = tricksStillNeeded(g, seat) > 0;
  const nonSpades = legal.filter((c) => suitOf(c) !== 'S');

  // ---- leading ----
  if (g.trick.length === 0) {
    if (!iAmNil && (wantTricks || partnerNilAlive)) {
      // Don't lead a king into an unseen ace: lead low instead
      const plan = normalPlay(g, seat, legal);
      if (suitOf(plan) !== 'S' && !isTop(plan, unseen) && rankOf(plan) >= QUEEN && !partnerNilAlive) return lowest(nonSpades.length ? nonSpades : legal);
      return plan;
    }
    if (!iAmNil && oppNil.length && !partnerNilAlive) {
      // Hunt the Nil: lead low in a suit the Nil player still holds
      const pool = legal.filter((c) => !vd[oppNil[0]].has(suitOf(c)));
      if (pool.length) return lowest(pool);
    }
    return normalPlay(g, seat, legal);
  }

  // ---- following ----
  const leadSuit = suitOf(g.trick[0].card);
  const win = currentWinner(g);
  const canFollow = legal.some((c) => suitOf(c) === leadSuit);
  const winners = legal.filter((c) => beats(c, win.card));
  const under = legal.filter((c) => !beats(c, win.card));
  const toPlay = [1, 2, 3].slice(0, 3 - g.trick.length).map((k) => (seat + k) % 4);
  /** Would this card still be winning after everybody else plays? (partner doesn't count as a threat) */
  const holds = (c: Card) => toPlay.every((s) => {
    if (s === partner) return true;
    if (suitOf(c) === 'S') return isTop(c, unseen) || (vd[s].has('S'));
    if (vd[s].has(leadSuit)) return vd[s].has('S') || !spadesOut;
    return isTop(c, unseen);
  });

  if (iAmNil) {
    if (under.length) return highest(under);
    if (!canFollow) return highest(nonSpades.length ? nonSpades : legal); // forced to discard: shed the most dangerous card
    return lowest(legal);
  }

  // An opponent's Nil is winning this trick: stay under it if we can (only when our own bid doesn't need this trick)
  if (oppNil.includes(win.seat) && under.length && (!wantTricks || toPlay.length > 0)) {
    return canFollow ? highest(under) : highest(under.filter((c) => suitOf(c) !== 'S').length ? under.filter((c) => suitOf(c) !== 'S') : under);
  }

  if (!partnerNilAlive && win.seat === partner && holds(win.card)) {
    // Partner has it won: never overtake, just throw the cheapest card
    if (canFollow) return lowest(legal);
    return lowest(nonSpades.length ? nonSpades : legal);
  }

  if (wantTricks && winners.length) {
    const sure = winners.filter(holds);
    if (sure.length) return lowest(sure);
  }

  if (!wantTricks && !partnerNilAlive && under.length) {
    // Contract is safe: avoid bags. Duck as high as possible; if not following, shed high side cards.
    if (canFollow) return highest(under);
    const side = under.filter((c) => suitOf(c) !== 'S');
    return highest(side.length ? side : under);
  }

  return normalPlay(g, seat, legal);
}
