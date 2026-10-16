// Cards, deck, seeded RNG and shuffle. A card is a 2-char string: rank + suit, e.g. "AS", "TH", "2C".

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Card = string;
export type Rng = () => number; // returns a float in [0, 1)

export const SUITS: Suit[] = ['S', 'H', 'C', 'D']; // display order: black/red alternate, spades first
export const RANKS = '23456789TJQKA'; // index = rank value (0 = deuce ... 12 = ace)

export const suitOf = (c: Card): Suit => c[1] as Suit;
export const rankOf = (c: Card): number => RANKS.indexOf(c[0]);
export const isCard = (c: unknown): c is Card =>
  typeof c === 'string' && /^[2-9TJQKA][SHDC]$/.test(c);

/** Deterministic RNG (mulberry32) for tests and reproducible games. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default RNG for real games: backed by the platform crypto source. */
export const secureRng: Rng = () => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle<T>(items: readonly T[], rng: Rng = secureRng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sort for display: suits in SUITS order, high rank first. */
export function sortHand(hand: Card[]): Card[] {
  return hand.slice().sort((x, y) => {
    const ds = SUITS.indexOf(suitOf(x)) - SUITS.indexOf(suitOf(y));
    return ds !== 0 ? ds : rankOf(y) - rankOf(x);
  });
}

/** Deal a shuffled deck into 4 sorted hands of 13. */
export function dealHands(rng: Rng = secureRng): Card[][] {
  const deck = shuffle(newDeck(), rng);
  return [0, 1, 2, 3].map((i) => sortHand(deck.slice(i * 13, i * 13 + 13)));
}
