// Spades rules engine: bidding, play validation, trick winner, hand scoring and game end.
// Seats: 0=N 1=E 2=S 3=W, clockwise. Partners are 0&2 (team 0) and 1&3 (team 1).
// The state object is mutated in place by placeBid / playCard / nextHand.

import { Card, Rng, dealHands, rankOf, secureRng, suitOf } from './cards.js';
import { CONFIG } from '../config.js';

export type Team = 0 | 1;
export type Phase = 'bidding' | 'playing' | 'handOver' | 'gameOver';

export const teamOf = (seat: number): Team => (seat % 2) as Team;
export const partnerOf = (seat: number): number => (seat + 2) % 4;
export const nextSeat = (seat: number): number => (seat + 1) % 4;

export const LOSE_SCORE = CONFIG.loseScore;
export const BAG_LIMIT = CONFIG.bagLimit;
export const BAG_PENALTY = CONFIG.bagPenalty;
export const NIL_BONUS = CONFIG.nilBonus;

export class EngineError extends Error {}

export interface TrickPlay { seat: number; card: Card }
export interface CompletedTrick { plays: TrickPlay[]; winner: number }

export interface TeamHandResult {
  bid: number;            // combined bid of the non-nil players
  tricks: number;         // tricks taken by the non-nil players
  made: boolean | null;   // null when the team had no non-nil bid
  contractPoints: number; // +10/bid trick if made, -10/bid trick if set
  bagsGained: number;     // overtricks + tricks taken by nil bidders
  nilPoints: number;      // +100/-100 per nil bidder
  nil: { seat: number; made: boolean }[];
  bagPenalty: number;     // negative multiple of 100 when bags crossed 10
  delta: number;          // total change in score this hand
}

export interface HandResult {
  handNo: number;
  bids: number[];
  tricks: number[];        // tricks per seat
  teams: [TeamHandResult, TeamHandResult];
  scores: [number, number]; // scores after this hand
  bags: [number, number];   // bags after this hand
}

export interface GameState {
  target: number;
  breakRule: boolean;   // true: spades cannot be led until broken (default). false: lead spades any time.
  sandbags: boolean;    // true: bags are counted and penalised (default). false: no bag points, no counting, no penalty.
  rng: Rng;
  phase: Phase;
  handNo: number;
  dealer: number;
  turn: number;
  hands: Card[][];
  bids: (number | null)[];
  trick: TrickPlay[];
  lastTrick: CompletedTrick | null;
  tricksWon: number[];
  spadesBroken: boolean;
  scores: [number, number];
  bags: [number, number];
  lastHand: HandResult | null;
  winner: Team | null;
}

export interface GameOptions { target?: number; rng?: Rng; dealer?: number; breakRule?: boolean; sandbags?: boolean }

export function createGame(opts: GameOptions = {}): GameState {
  const g: GameState = {
    target: opts.target ?? 500,
    breakRule: opts.breakRule ?? true,
    sandbags: opts.sandbags ?? true,
    rng: opts.rng ?? secureRng,
    phase: 'bidding',
    handNo: 0,
    dealer: opts.dealer ?? 0,
    turn: 0,
    hands: [],
    bids: [null, null, null, null],
    trick: [],
    lastTrick: null,
    tricksWon: [0, 0, 0, 0],
    spadesBroken: false,
    scores: [0, 0],
    bags: [0, 0],
    lastHand: null,
    winner: null,
  };
  dealNewHand(g);
  return g;
}

function dealNewHand(g: GameState): void {
  g.handNo += 1;
  g.hands = dealHands(g.rng);
  g.bids = [null, null, null, null];
  g.trick = [];
  g.lastTrick = null;
  g.tricksWon = [0, 0, 0, 0];
  g.spadesBroken = false;
  g.phase = 'bidding';
  g.turn = nextSeat(g.dealer); // player left of the dealer bids and leads first
}

/** Move on after a hand: rotate the dealer and deal. Only valid in phase 'handOver'. */
export function nextHand(g: GameState): void {
  if (g.phase !== 'handOver') throw new EngineError('Hand is not over');
  g.dealer = nextSeat(g.dealer);
  dealNewHand(g);
}

// ---------- bidding ----------

/** Bids a player may make: minBid..maxBid (CONFIG.rules), plus 0 = Nil when CONFIG.rules.allowNil. */
export function legalBids(): number[] {
  const { minBid, maxBid, allowNil } = CONFIG.rules;
  const bids = Array.from({ length: maxBid - minBid + 1 }, (_, i) => minBid + i);
  return allowNil ? [0, ...bids] : bids;
}

export function placeBid(g: GameState, seat: number, bid: number): void {
  if (g.phase !== 'bidding') throw new EngineError('Not bidding');
  if (seat !== g.turn) throw new EngineError('Not your turn');
  if (!legalBids().includes(bid)) {
    const { minBid, maxBid, allowNil } = CONFIG.rules;
    throw new EngineError(`Bid must be ${minBid} to ${maxBid}${allowNil ? ' (or Nil)' : ''}`);
  }
  g.bids[seat] = bid;
  if (g.bids.every((b) => b !== null)) {
    g.phase = 'playing';
    g.turn = nextSeat(g.dealer);
  } else {
    g.turn = nextSeat(seat);
  }
}

// ---------- play ----------

export function legalPlays(g: GameState, seat: number): Card[] {
  if (g.phase !== 'playing' || seat !== g.turn) return [];
  const hand = g.hands[seat];
  if (g.trick.length === 0) {
    const onlySpades = hand.every((c) => suitOf(c) === 'S');
    if (!g.breakRule || g.spadesBroken || onlySpades) return hand.slice();
    return hand.filter((c) => suitOf(c) !== 'S');
  }
  const lead = suitOf(g.trick[0].card);
  const follow = hand.filter((c) => suitOf(c) === lead);
  return follow.length > 0 ? follow : hand.slice();
}

/** True if `card` beats the current best card of a trick: same suit and higher, or a spade over a non-spade.
 *  (A card that is neither of those, including an off-suit discard, can never win.) */
export function beats(card: Card, best: Card): boolean {
  const cs = suitOf(card);
  if (cs === suitOf(best)) return rankOf(card) > rankOf(best);
  return cs === 'S';
}

export function trickWinner(plays: TrickPlay[]): number {
  let best = plays[0];
  for (const p of plays.slice(1)) if (beats(p.card, best.card)) best = p;
  return best.seat;
}

export interface PlayOutcome {
  trick: CompletedTrick | null; // set when this card completed a trick
  handDone: boolean;
}

export function playCard(g: GameState, seat: number, card: Card): PlayOutcome {
  if (g.phase !== 'playing') throw new EngineError('Not playing');
  if (seat !== g.turn) throw new EngineError('Not your turn');
  if (!legalPlays(g, seat).includes(card)) throw new EngineError('Illegal card');
  const hand = g.hands[seat];
  hand.splice(hand.indexOf(card), 1);
  g.trick.push({ seat, card });
  if (suitOf(card) === 'S') g.spadesBroken = true;

  if (g.trick.length < 4) {
    g.turn = nextSeat(seat);
    return { trick: null, handDone: false };
  }
  const winner = trickWinner(g.trick);
  const done: CompletedTrick = { plays: g.trick, winner };
  g.lastTrick = done;
  g.tricksWon[winner] += 1;
  g.trick = [];
  g.turn = winner;
  if (g.hands.every((h) => h.length === 0)) {
    finishHand(g);
    return { trick: done, handDone: true };
  }
  return { trick: done, handDone: false };
}

// ---------- scoring ----------

/** Score one hand for a team. Pure: takes bids/tricks of the team's two seats and its running bags. */
export function scoreTeam(
  seats: [number, number],
  bids: number[],
  tricks: number[],
  bagsBefore: number,
  sandbags = true,
): { result: TeamHandResult; bagsAfter: number } {
  let bid = 0;
  let won = 0;
  let nilTricks = 0;
  const nil: { seat: number; made: boolean }[] = [];
  let nilPoints = 0;
  for (const s of seats) {
    if (bids[s] === 0) {
      const made = tricks[s] === 0;
      nil.push({ seat: s, made });
      nilPoints += made ? NIL_BONUS : -NIL_BONUS;
      nilTricks += tricks[s]; // a nil bidder's tricks never count toward the team bid; they become bags
    } else {
      bid += bids[s];
      won += tricks[s];
    }
  }
  let made: boolean | null = null;
  let contractPoints = 0;
  let overtricks = 0;
  if (bid > 0) {
    made = won >= bid;
    if (made) {
      contractPoints = 10 * bid;
      overtricks = won - bid;
    } else {
      contractPoints = -10 * bid;
    }
  }
  const bagsGained = sandbags ? overtricks + nilTricks : 0;
  let bags = bagsBefore + bagsGained;
  let bagPenalty = 0;
  while (sandbags && bags >= BAG_LIMIT) {
    bags -= BAG_LIMIT;
    bagPenalty -= BAG_PENALTY;
  }
  const delta = contractPoints + bagsGained + nilPoints + bagPenalty;
  return {
    result: { bid, tricks: won, made, contractPoints, bagsGained, nilPoints, nil, bagPenalty, delta },
    bagsAfter: bags,
  };
}

/** Decide the winner from running scores, or null to keep playing (including exact ties). */
export function gameWinner(scores: [number, number], target: number): Team | null {
  const lost = scores.map((s) => s <= LOSE_SCORE);
  if (lost[0] !== lost[1]) return lost[0] ? 1 : 0;
  if (lost[0] && lost[1]) return scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
  const reached = scores.map((s) => s >= target);
  if (!reached[0] && !reached[1]) return null;
  if (reached[0] !== reached[1]) return reached[0] ? 0 : 1;
  return scores[0] === scores[1] ? null : scores[0] > scores[1] ? 0 : 1;
}

function finishHand(g: GameState): void {
  const bids = g.bids.map((b) => b ?? 0);
  const t0 = scoreTeam([0, 2], bids, g.tricksWon, g.bags[0], g.sandbags);
  const t1 = scoreTeam([1, 3], bids, g.tricksWon, g.bags[1], g.sandbags);
  g.scores = [g.scores[0] + t0.result.delta, g.scores[1] + t1.result.delta];
  g.bags = [t0.bagsAfter, t1.bagsAfter];
  g.lastHand = {
    handNo: g.handNo,
    bids,
    tricks: g.tricksWon.slice(),
    teams: [t0.result, t1.result],
    scores: [g.scores[0], g.scores[1]],
    bags: [g.bags[0], g.bags[1]],
  };
  g.winner = gameWinner(g.scores, g.target);
  g.phase = g.winner === null ? 'handOver' : 'gameOver';
}
