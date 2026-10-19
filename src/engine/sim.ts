// Instant bot-vs-bot game simulation, used for bot-only tournament matches and tests.

import { Rng, secureRng } from './cards.js';
import { GameState, Team, createGame, nextHand, placeBid, playCard } from './game.js';
import { Skill, chooseBid, choosePlay } from './bot.js';

export interface SimResult {
  winner: Team;
  scores: [number, number];
  hands: number;
  capped: boolean; // true if the safety cap on hands was hit
}

/** Advance a game one step using bots for every seat. Returns false when the game is over. */
export function botStep(g: GameState, skills?: Skill[]): boolean {
  const skill = skills?.[g.turn] ?? 'normal';
  switch (g.phase) {
    case 'bidding': placeBid(g, g.turn, chooseBid(g, g.turn, skill)); return true;
    case 'playing': playCard(g, g.turn, choosePlay(g, g.turn, skill)); return true;
    case 'handOver': nextHand(g); return true;
    default: return false;
  }
}

export function simulateGame(opts: { target: number; rng?: Rng; maxHands?: number; breakRule?: boolean; sandbags?: boolean; skills?: Skill[] }): SimResult {
  const g = createGame({ target: opts.target, rng: opts.rng ?? secureRng, dealer: 0, breakRule: opts.breakRule, sandbags: opts.sandbags });
  const cap = opts.maxHands ?? 300;
  while (g.phase !== 'gameOver') {
    if (g.phase === 'handOver' && g.handNo >= cap) {
      // Extremely unlikely: break the deadlock by score (ties go to team 0)
      return { winner: g.scores[1] > g.scores[0] ? 1 : 0, scores: g.scores, hands: g.handNo, capped: true };
    }
    botStep(g, opts.skills);
  }
  return { winner: g.winner as Team, scores: g.scores, hands: g.handNo, capped: false };
}
