// Strong bots vs normal bots: plays N bot-only games and prints how often the strong team wins.
// Usage: npx tsx scripts/sim-strong.ts [games] [target]
import { mulberry32 } from '../src/engine/cards.js';
import { simulateGame } from '../src/engine/sim.js';
import { Skill } from '../src/engine/bot.js';

const games = Number(process.argv[2] ?? 400);
const target = Number(process.argv[3] ?? 500);
let strongWins = 0;
for (let i = 0; i < games; i++) {
  const strongTeam = i % 2; // swap sides every game so seat order can't skew the result
  const skills: Skill[] = [0, 1, 2, 3].map((s) => (s % 2 === strongTeam ? 'strong' : 'normal'));
  const r = simulateGame({ target, rng: mulberry32(1000 + i), skills });
  if (r.winner === strongTeam) strongWins++;
}
console.log(`strong team won ${strongWins} of ${games} games (${((100 * strongWins) / games).toFixed(1)}%), target ${target}`);
