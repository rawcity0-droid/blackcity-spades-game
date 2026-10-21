// Bot personas: a name, sometimes a picture (public/faces/<face>.jpg), a chat style and a skill level.
// Used for bots at tables and for bot slots in brackets and events, so a bot looks the same everywhere.

import { CONFIG } from '../config.js';
import { Rng } from '../engine/cards.js';
import { Skill } from '../engine/bot.js';

export type ChatStyle = 'chill' | 'trash';
export interface Persona { name: string; face?: string; chatStyle: ChatStyle; skill: Skill }

export const BOT_NAMES = [
  'Ace', 'Duke', 'Queenie', 'Jax', 'Maverick', 'Sage', 'Rook', 'Dottie',
  'Blaze', 'Nova', 'Pip', 'Otis', 'Big Mike', 'Lil Tone', 'Peanut', 'Smoke',
  'Tank', 'Slim', 'Cash', 'Showtime', 'Ghost', 'Bishop', 'Truck',
  'Mookie', 'Boogie', 'Pooh', 'Scoop', 'Juice', 'Fats', 'Money Mal', 'Cookie',
  'Shorty', 'Tito', 'Sticks', 'Rico', 'Deuce', 'Squeaky', 'Biscuit', 'Gizmo',
  'Rell', 'Tay', 'Nene', 'Keke', 'Mama Jo', 'Auntie Em', 'Big Cuz',
  'Low', 'Zeke', 'Flip', 'Hustle', 'Pockets', 'Dollar', 'Big Hen', 'Lucky',
  'Spade Dad', 'Sweets', 'Cheeks', 'Bam', 'Hollis', 'Crenshaw', 'Flatbush', 'Lenox',
  'Broad St', 'Southside', 'Eastside', 'Westside', 'Northside', 'The Block', '5th Ward', 'Uptown',
  'Eastwick', 'Lakeview', 'Rosedale', 'Parkway', 'Marcy', 'Fulton', 'Jefferson', 'Division',
  'Atlas', 'Domino', 'Dap', 'Loc', 'Gunner', 'Sarge', 'Moe', 'Chilly',
  'Pinky', 'Wavy', 'Kilo', 'Big Sis', 'Lil Ray', 'Mook', 'CJ', 'June',
  'Boots', 'Rocco', 'Tre', 'Cap', 'Rude Boy', 'OG Ray', 'Tea', 'Ride',
  'Cuz', 'Pop', 'Nikki B',
];

/** Bots that come with a photo (public/faces/<face>.jpg). "Raw 1" is the owner's own. */
export const FACE_BOTS: { name: string; face: string }[] = [
  { name: 'Marcus', face: 'marcus' }, { name: 'Tasha', face: 'tasha' }, { name: 'Luis', face: 'luis' },
  { name: 'Keisha', face: 'keisha' }, { name: 'Big Jerome', face: 'jerome' }, { name: 'Mari', face: 'mari' },
  { name: 'Dre', face: 'dre' }, { name: 'Miss Pearl', face: 'pearl' }, { name: 'Cooper', face: 'cooper' }, { name: 'Kim', face: 'kim' },
  // Not every player uses a selfie: cars, graphics, pets and cartoon avatars (all original, no real people or brands)
  { name: 'Lowrider Lou', face: 'lowrider' }, { name: 'King Spade', face: 'crown' }, { name: 'Midnight Moe', face: 'muscle' },
  { name: 'Fresh Kicks', face: 'kicks' }, { name: 'Brick', face: 'pitbull' }, { name: 'Big Cat Leo', face: 'lion' },
  { name: 'Red Hood Rome', face: 'anime2' }, { name: 'Four Aces', face: 'aces' }, { name: 'Whiskers', face: 'cat' },
  { name: 'Buckets', face: 'hoops' }, { name: 'Spray Can Sam', face: 'graffiti' }, { name: 'Lone Wolf', face: 'wolf' },
  { name: 'Granny Hands', face: 'granny' }, { name: 'Boombox Benny', face: 'boombox' }, { name: 'Purple Rain', face: 'anime1' },
  { name: 'Chopper Chuck', face: 'chopper' },
];
export const RAW_ONE = { name: 'Raw 1', face: 'raw1' };

/** Pick a persona whose name is not in `used` (names already taken at the table or in the tournament). */
export function pickPersona(rng: Rng, used: Set<string>): Persona {
  const chatStyle: ChatStyle = rng() < CONFIG.botPersonality.trashChance ? 'trash' : 'chill';
  const skill: Skill = rng() < CONFIG.botPersonality.strongChance ? 'strong' : 'normal';
  if (!used.has(RAW_ONE.name) && rng() < CONFIG.botFaces.rawOneChance) return { ...RAW_ONE, chatStyle, skill };
  const faces = FACE_BOTS.filter((f) => !used.has(f.name));
  if (faces.length && rng() < CONFIG.botFaces.chance) return { ...faces[Math.floor(rng() * faces.length)], chatStyle, skill };
  const free = BOT_NAMES.filter((n) => !used.has(n));
  if (free.length) return { name: free[Math.floor(rng() * free.length)], chatStyle, skill };
  for (let n = 2; ; n++) if (!used.has(`Player ${n}`)) return { name: `Player ${n}`, chatStyle, skill };
}
