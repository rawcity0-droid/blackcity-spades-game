// Card rendering as inline SVG (100 x 140 viewBox): big corner indexes (rotated copy bottom-right),
// number-card pips in a standard layout, a single large ace pip, a bold original card back.
// Court cards (J/Q/K) come from court-art.js (swappable). No images, fonts or CDNs are used.
//
// Suit colors follow the brief: spades indigo with a gold outline, hearts coral-red, diamonds amber,
// clubs emerald. Suits also differ by SHAPE, and every pip has a dark outline, so color is never the only cue.

import { s } from './svg.js';
import { drawCourt } from './court-art.js';

export const OUT = '#1b1330';
export const COLORS = { S: '#4b2fb5', H: '#ff5a4d', D: '#ffa41f', C: '#12a865' };
const TEXT = { S: '#2f1d86', H: '#d7261b', D: '#b8610a', C: '#0b7a47' }; // darker shades for rank text on the light face
const GOLD = '#f2b705';
const FACE = '#fffdf6';

export const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANK_NAMES = { A: 'Ace', T: '10', J: 'Jack', Q: 'Queen', K: 'King' };
export const cardName = (code) => `${RANK_NAMES[code[0]] ?? code[0]} of ${SUIT_NAMES[code[1]]}`;

// Suit shapes drawn around (0,0) in a roughly 22 x 23 box. Each returns [{tag, attrs}].
const SHAPES = {
  S: [{ tag: 'path', attrs: { d: 'M0 -11 C0 -11 -11 -2 -11 4 C-11 8 -8 9.5 -5.5 9.5 C-3.5 9.5 -2 8.7 -1.2 7.5 C-1.5 10 -2.5 11 -4.5 11.5 L4.5 11.5 C2.5 11 1.5 10 1.2 7.5 C2 8.7 3.5 9.5 5.5 9.5 C8 9.5 11 8 11 4 C11 -2 0 -11 0 -11 Z' } }],
  H: [{ tag: 'path', attrs: { d: 'M0 10.5 C-9 4 -11 0 -11 -4 C-11 -8 -8 -10 -5.5 -10 C-3 -10 -1 -8.5 0 -6.5 C1 -8.5 3 -10 5.5 -10 C8 -10 11 -8 11 -4 C11 0 9 4 0 10.5 Z' } }],
  D: [{ tag: 'path', attrs: { d: 'M0 -11.5 L9 0 L0 11.5 L-9 0 Z' } }],
  C: [
    { tag: 'circle', attrs: { cx: 0, cy: -5.5, r: 5.4 } },
    { tag: 'circle', attrs: { cx: -5.9, cy: 3.2, r: 5.4 } },
    { tag: 'circle', attrs: { cx: 5.9, cy: 3.2, r: 5.4 } },
    { tag: 'circle', attrs: { cx: 0, cy: 0, r: 4.2 } },
    { tag: 'path', attrs: { d: 'M-1.8 3 L-4 11.5 L4 11.5 L1.8 3 Z' } },
  ],
};

/** A suit symbol centered at (cx, cy) with the given width in card units; dark outline underneath. */
export function pip(suit, cx, cy, size, rotate = 0) {
  const k = size / 22;
  const g = s('g', { transform: `translate(${cx} ${cy}) rotate(${rotate}) scale(${k})` });
  const outline = suit === 'S' ? 4.6 : 3.4;
  for (const sh of SHAPES[suit]) g.append(s(sh.tag, { ...sh.attrs, fill: OUT, stroke: OUT, 'stroke-width': outline, 'stroke-linejoin': 'round' }));
  for (const sh of SHAPES[suit]) {
    g.append(s(sh.tag, suit === 'S'
      ? { ...sh.attrs, fill: COLORS.S, stroke: GOLD, 'stroke-width': 1.9, 'stroke-linejoin': 'round' } // thick gold ring on the trump suit
      : { ...sh.attrs, fill: COLORS[suit] }));
  }
  if (suit === 'S') g.append(s('path', { d: 'M-2.2 -2.5 C-3.5 -0.5 -5 1 -6 3', stroke: '#9a86ff', 'stroke-width': 1.3, fill: 'none', 'stroke-linecap': 'round' }));
  return g;
}

// Pip positions on the card face: columns L/C/R and rows (card units)
const L = 39, C = 50, R = 61;
const ROW4 = [31, 56.7, 83.3, 109];
const LAYOUT = {
  2: [[C, 31], [C, 109]],
  3: [[C, 31], [C, 70], [C, 109]],
  4: [[L, 31], [R, 31], [L, 109], [R, 109]],
  5: [[L, 31], [R, 31], [C, 70], [L, 109], [R, 109]],
  6: [[L, 31], [R, 31], [L, 70], [R, 70], [L, 109], [R, 109]],
  7: [[L, 31], [R, 31], [C, 50.5], [L, 70], [R, 70], [L, 109], [R, 109]],
  8: [[L, 31], [R, 31], [C, 50.5], [L, 70], [R, 70], [C, 89.5], [L, 109], [R, 109]],
  9: [[L, 31], [R, 31], [L, 56.7], [R, 56.7], [C, 70], [L, 83.3], [R, 83.3], [L, 109], [R, 109]],
  10: [[L, 31], [R, 31], [C, 43.8], [L, 56.7], [R, 56.7], [L, 83.3], [R, 83.3], [C, 96.2], [L, 109], [R, 109]],
};

function rankLabel(r) { return r === 'T' ? '10' : r; }

function corner(rank, suit) {
  const label = rankLabel(rank);
  return s('g', {},
    s('text', {
      x: 14.5, y: 35, 'text-anchor': 'middle', 'font-size': label.length > 1 ? 27 : 38, 'font-weight': 900,
      'font-family': 'Arial Black, Arial, Helvetica, sans-serif', fill: TEXT[suit], stroke: FACE, 'stroke-width': 3,
      'paint-order': 'stroke', 'letter-spacing': label.length > 1 ? -2 : 0,
    }, label),
    pip(suit, 14.5, 55.5, 21),
  );
}

function buildFront(code) {
  const rank = code[0];
  const suit = code[1];
  const svg = s('svg', { viewBox: '0 0 100 140', class: 'card-svg', role: 'img', 'aria-label': cardName(code), focusable: 'false' });
  svg.append(s('rect', { x: 1.5, y: 1.5, width: 97, height: 137, rx: 9, fill: FACE, stroke: OUT, 'stroke-width': 3 }));
  if (rank === 'A') {
    svg.append(pip(suit, 50, 72, 54));
  } else if ('JQK'.includes(rank)) {
    svg.append(s('g', { transform: 'translate(30 21)' }, drawCourt(suit, rank, { s, pip, colors: COLORS, OUT })));
  } else {
    const n = rank === 'T' ? 10 : Number(rank);
    for (const [x, y] of LAYOUT[n]) svg.append(pip(suit, x, y, 17, y > 70 ? 180 : 0));
  }
  svg.append(corner(rank, suit));
  svg.append(s('g', { transform: 'rotate(180 50 70)' }, corner(rank, suit)));
  return svg;
}

function buildBack() {
  const svg = s('svg', { viewBox: '0 0 100 140', class: 'card-svg', role: 'img', 'aria-label': 'Card back', focusable: 'false' });
  svg.append(s('rect', { x: 1.5, y: 1.5, width: 97, height: 137, rx: 9, fill: '#fffdf6', stroke: OUT, 'stroke-width': 3 }));
  svg.append(s('rect', { x: 7, y: 7, width: 86, height: 126, rx: 5, fill: '#2b1a73', stroke: OUT, 'stroke-width': 1.5 }));
  const clip = 'cardback-clip';
  const defs = s('defs', {}, s('clipPath', { id: clip }, s('rect', { x: 7, y: 7, width: 86, height: 126, rx: 5 })));
  svg.append(defs);
  const pattern = s('g', { 'clip-path': `url(#${clip})` });
  // skyline stripes at the bottom, diamond lattice, dots in the four suit colors
  for (let i = -8; i <= 18; i++) {
    pattern.append(s('line', { x1: i * 12, y1: 0, x2: i * 12 + 140, y2: 140, stroke: '#4a34a8', 'stroke-width': 1.6 }));
    pattern.append(s('line', { x1: i * 12 + 140, y1: 0, x2: i * 12, y2: 140, stroke: '#4a34a8', 'stroke-width': 1.6 }));
  }
  const dotColors = [COLORS.H, COLORS.D, COLORS.C, GOLD];
  let k = 0;
  for (let row = 0; row < 11; row++) {
    for (let col = 0; col < 8; col++) {
      const x = 7 + col * 12 + (row % 2 ? 6 : 0);
      const y = 7 + row * 12.4;
      pattern.append(s('circle', { cx: x, cy: y, r: 1.9, fill: dotColors[k++ % 4] }));
    }
  }
  svg.append(pattern);
  svg.append(s('rect', { x: 12, y: 12, width: 76, height: 116, rx: 4, fill: 'none', stroke: GOLD, 'stroke-width': 1.4 }));
  svg.append(s('circle', { cx: 50, cy: 70, r: 25, fill: '#1b1330', stroke: GOLD, 'stroke-width': 3 }));
  svg.append(s('circle', { cx: 50, cy: 70, r: 20, fill: '#2b1a73', stroke: '#9a86ff', 'stroke-width': 1 }));
  svg.append(pip('S', 50, 70, 30));
  return svg;
}

const cache = new Map();
/** A fresh SVG element for a card code like "AS" or "TH". */
export function renderCard(code) {
  if (!cache.has(code)) cache.set(code, buildFront(code));
  return cache.get(code).cloneNode(true);
}

export function renderBack() {
  if (!cache.has('back')) cache.set('back', buildBack());
  return cache.get('back').cloneNode(true);
}
