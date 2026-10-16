// Heuristic bot. chooseBid() estimates tricks from the bot's own hand; choosePlay() picks from
// legalPlays() only, so it can never make an illegal move. It reads only its own hand plus public state.

import { Card, rankOf, suitOf } from './cards.js';
import { GameState, beats, legalPlays, partnerOf, teamOf } from './game.js';

const ACE = 12, KING = 11, QUEEN = 10, TEN = 8;

/** Estimate how many tricks a hand will take and turn it into a bid (0 = nil, 1..13). */
export function chooseBid(g: GameState, seat: number): number {
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
  if (est < 1.1 && spades.length <= 2 && !highSpade && highCards <= 1 && partnerBid !== 0) return 0;

  return Math.max(1, Math.min(13, Math.round(est)));
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

export function choosePlay(g: GameState, seat: number): Card {
  const legal = legalPlays(g, seat);
  if (legal.length === 0) throw new Error('Bot has no legal play');
  if (legal.length === 1) return legal[0];

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

