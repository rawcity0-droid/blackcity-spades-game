// Instant bot-vs-bot game simulation, used for bot-only tournament matches and tests.

import { Rng, secureRng } from './cards.js';
import { GameState, Team, createGame, nextHand, placeBid, playCard } from './game.js';
import { chooseBid, choosePlay } from './bot.js';

export interface SimResult {
  winner: Team;
  scores: [number, number];
  hands: number;
  capped: boolean; // true if the safety cap on hands was hit
}

/** Advance a game one step using bots for every seat. Returns false when the game is over. */
export function botStep(g: GameState): boolean {
  switch (g.phase) {
    case 'bidding': placeBid(g, g.turn, chooseBid(g, g.turn)); return true;
    case 'playing': playCard(g, g.turn, choosePlay(g, g.turn)); return true;
    case 'handOver': nextHand(g); return true;
    default: return false;
  }
}

export function simulateGame(opts: { target: number; rng?: Rng; maxHands?: number }): SimResult {
  const g = createGame({ target: opts.target, rng: opts.rng ?? secureRng, dealer: 0 });
  const cap = opts.maxHands ?? 300;
  while (g.phase !== 'gameOver') {
    if (g.phase === 'handOver' && g.handNo >= cap) {
      // Extremely unlikely: break the deadlock by score (ties go to team 0)
      return { winner: g.scores[1] > g.scores[0] ? 1 : 0, scores: g.scores, hands: g.handNo, capped: true };
    }
    botStep(g);
  }
  return { winner: g.winner as Team, scores: g.scores, hands: g.handNo, capped: false };
}
