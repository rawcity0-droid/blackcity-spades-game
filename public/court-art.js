// Court-card art: the 12 original "Blackcity neighborhood" characters (J/Q/K x 4 suits), drawn from
// basic shapes as inline SVG. Flat colors, thick dark outlines, half-body figures mirrored top/bottom.
//
// SWAP-IN CONTRACT: replace this file with any module that exports
//   drawCourt(suit, rank, ctx) -> SVGElement   // suit: 'S'|'H'|'D'|'C', rank: 'J'|'Q'|'K'
// The returned element is drawn in a panel whose local coordinates are 40 wide x 98 tall
// (it is placed at x=30,y=21 of the 100x140 card). ctx gives you: ctx.s (SVG builder),
// ctx.pip(suit, cx, cy, size) (a suit symbol), ctx.colors[suit], ctx.OUT (outline color).
// cards.js does not know anything else about the characters.

const SKIN = { a: '#f1c27d', b: '#c68642', c: '#8d5524', d: '#e0ac69', e: '#ffdbac', f: '#a1665e' };
const TINT = { S: '#e6e0ff', H: '#ffe2dd', D: '#ffefcc', C: '#d9f4e6' };

// One entry per character. outfit/accent colors follow the suit palette from the brief.
const CAST = {
  SJ: { skin: SKIN.b, hair: 'short', hairC: '#1d1530', outfit: '#6d4fd6', accent: '#f2b705', hood: true, head: 'hoodHair', prop: 'skate' },
  SQ: { skin: SKIN.c, hair: 'updo', hairC: '#1d1530', outfit: '#5a3fc0', accent: '#f2b705', head: 'none', prop: 'mic', lashes: true, earrings: true },
  SK: { skin: SKIN.d, hair: 'short', hairC: '#3b3b46', outfit: '#4a34a8', accent: '#f2b705', head: 'shako', prop: 'drum', mustache: true },
  HJ: { skin: SKIN.e, hair: 'curly', hairC: '#7a3b12', outfit: '#ff6b5e', accent: '#fff4d6', head: 'bandana', prop: 'pie', freckles: true },
  HQ: { skin: SKIN.a, hair: 'long', hairC: '#5a2d1b', outfit: '#ff6b5e', accent: '#fff4d6', head: 'pastry', prop: 'whisk', lashes: true, apron: true },
  HK: { skin: SKIN.f, hair: 'short', hairC: '#1d1530', outfit: '#ff6b5e', accent: '#ffffff', head: 'chef', prop: 'spatula', beard: true, coat: true },
  DJ: { skin: SKIN.d, hair: 'short', hairC: '#2a1b0e', outfit: '#ffb02e', accent: '#1b1330', head: 'helmet', prop: 'bag', freckles: true },
  DQ: { skin: SKIN.b, hair: 'bob', hairC: '#1d1530', outfit: '#ff9a1f', accent: '#ffd36b', head: 'none', prop: 'scissors', lashes: true, scarf: true },
  DK: { skin: SKIN.e, hair: 'short', hairC: '#8a8a95', outfit: '#d9822b', accent: '#ffb02e', head: 'goggles', prop: 'wrench', mustache: true },
  CJ: { skin: SKIN.c, hair: 'short', hairC: '#1d1530', outfit: '#22b573', accent: '#ffffff', head: 'cap', prop: 'can', freckles: false },
  CQ: { skin: SKIN.a, hair: 'long', hairC: '#2a1b0e', outfit: '#17a265', accent: '#d9f4e6', head: 'leaves', prop: 'trowel', lashes: true, apron: true },
  CK: { skin: SKIN.d, hair: 'short', hairC: '#9a9aa5', outfit: '#0f9d58', accent: '#ffffff', head: 'cap', prop: 'whistle', beard: true, jacket: true },
};

export function drawCourt(suit, rank, ctx) {
  const { s, OUT } = ctx;
  const c = CAST[suit + rank];
  const half = figure(c, suit, ctx);
  return s('g', {},
    s('rect', { x: 0, y: 0, width: 40, height: 98, rx: 3, fill: TINT[suit], stroke: OUT, 'stroke-width': 1.4 }),
    // suit accent corners (top-right and bottom-left)
    s('path', { d: 'M40 0 L40 11 L29 0 Z', fill: ctx.colors[suit] }),
    s('path', { d: 'M0 98 L0 87 L11 98 Z', fill: ctx.colors[suit] }),
    half,
    s('g', { transform: 'rotate(180 20 49)' }, figure(c, suit, ctx)),
    s('line', { x1: 0, y1: 49, x2: 40, y2: 49, stroke: OUT, 'stroke-width': 1 }),
    s('circle', { cx: 20, cy: 49, r: 6.2, fill: '#fffdf6', stroke: OUT, 'stroke-width': 1.2 }),
    ctx.pip(suit, 20, 49, 8.5),
  );
}

// ---------- one half-body figure in a 40 x 49 box (cut at the waist on y = 49) ----------

function figure(c, suit, ctx) {
  const { s, OUT } = ctx;
  const stroke = { stroke: OUT, 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' };
  const g = s('g', {});
  const add = (...n) => n.forEach((x) => g.append(x));
  const HEAD_Y = 22;

  // back hair for long styles
  if (c.hair === 'long') add(s('path', { d: 'M9 20 C8 8 32 8 31 20 L33 40 L7 40 Z', fill: c.hairC, ...stroke }));
  if (c.hair === 'bob') add(s('path', { d: 'M8.5 22 C7 6 33 6 31.5 22 L32 32 L8 32 Z', fill: c.hairC, ...stroke }));

  // body
  add(s('path', { d: 'M3 49 C3 38 9 34 20 34 C31 34 37 38 37 49 Z', fill: c.outfit, ...stroke }));
  // outfit details
  if (c.hood) add(s('path', { d: 'M9 38 C10 31 30 31 31 38 C27 36 13 36 9 38 Z', fill: '#4a34a8', ...stroke }));
  if (c.apron) add(s('path', { d: 'M12 49 L13 38 L27 38 L28 49 Z', fill: c.accent, ...stroke }), ctx.pip(suit, 20, 44, 6.5));
  if (c.coat) add(s('line', { x1: 20, y1: 36, x2: 20, y2: 49, stroke: OUT, 'stroke-width': 1.2 }), s('circle', { cx: 16, cy: 42, r: 1.3, fill: OUT }), s('circle', { cx: 24, cy: 42, r: 1.3, fill: OUT }));
  if (c.jacket) add(s('path', { d: 'M3 49 C3 40 5 37 8 36 L9 49 Z', fill: c.accent, ...stroke }), s('path', { d: 'M37 49 C37 40 35 37 32 36 L31 49 Z', fill: c.accent, ...stroke }));
  if (c.scarf) add(s('path', { d: 'M10 36 C16 40 24 40 30 36 L31 41 C24 45 16 45 9 41 Z', fill: c.accent, ...stroke }), s('path', { d: 'M24 41 L27 49 L22 48 Z', fill: c.accent, ...stroke }));
  if (!c.apron && !c.scarf) add(ctx.pip(suit, 20, 43.5, 6.5)); // suit worn on the chest
  if (c.prop === 'skate') add(s('path', { d: 'M6 35 L32 49', stroke: '#f2b705', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' })); // courier strap

  // head
  add(s('ellipse', { cx: 20, cy: HEAD_Y, rx: 9.2, ry: 10, fill: c.skin, ...stroke }));
  // ears
  add(s('circle', { cx: 10.8, cy: HEAD_Y + 1, r: 2, fill: c.skin, ...stroke }), s('circle', { cx: 29.2, cy: HEAD_Y + 1, r: 2, fill: c.skin, ...stroke }));
  if (c.earrings) add(s('circle', { cx: 10.6, cy: HEAD_Y + 4.2, r: 1.4, fill: '#f2b705', stroke: OUT, 'stroke-width': 0.8 }), s('circle', { cx: 29.4, cy: HEAD_Y + 4.2, r: 1.4, fill: '#f2b705', stroke: OUT, 'stroke-width': 0.8 }));

  // hair on top
  const hair = (d) => add(s('path', { d, fill: c.hairC, ...stroke }));
  if (c.hair === 'short' && !['shako', 'chef', 'helmet', 'cap', 'bandana'].includes(c.head)) hair('M10.5 20 C10 10 30 10 29.5 20 C27 15 13 15 10.5 20 Z');
  if (c.hair === 'short' && ['cap', 'helmet', 'bandana'].includes(c.head)) hair('M10.8 21 C11 17 29 17 29.2 21 C26 18.5 14 18.5 10.8 21 Z');
  if (c.hair === 'curly') [[12, 14], [17, 11.5], [23, 11.5], [28, 14], [10.5, 19], [29.5, 19]].forEach(([x, y]) => add(s('circle', { cx: x, cy: y, r: 3.6, fill: c.hairC, ...stroke })));
  if (c.hair === 'long' || c.hair === 'bob') hair('M10 21 C9 8 31 8 30 21 C27 14 15 13 10 21 Z');
  if (c.hair === 'updo') { hair('M10 21 C9 9 31 9 30 21 C27 15 14 15 10 21 Z'); add(s('circle', { cx: 20, cy: 7.5, r: 4.5, fill: c.hairC, ...stroke })); }
  if (c.head === 'hoodHair') add(s('path', { d: 'M8 26 C4 8 36 8 32 26 C32 16 26 12 20 12 C14 12 8 16 8 26 Z', fill: '#4a34a8', ...stroke }));

  // face
  add(s('ellipse', { cx: 16.2, cy: HEAD_Y + 0.5, rx: 1.5, ry: 1.9, fill: OUT }), s('ellipse', { cx: 23.8, cy: HEAD_Y + 0.5, rx: 1.5, ry: 1.9, fill: OUT }));
  add(s('circle', { cx: 16.7, cy: HEAD_Y - 0.1, r: 0.55, fill: '#fff' }), s('circle', { cx: 24.3, cy: HEAD_Y - 0.1, r: 0.55, fill: '#fff' }));
  add(s('circle', { cx: 13.6, cy: HEAD_Y + 4.2, r: 2, fill: '#ff6b5e', opacity: 0.35 }), s('circle', { cx: 26.4, cy: HEAD_Y + 4.2, r: 2, fill: '#ff6b5e', opacity: 0.35 }));
  add(s('path', { d: `M16 ${HEAD_Y + 5} Q20 ${HEAD_Y + 9.5} 24 ${HEAD_Y + 5}`, fill: '#fff', stroke: OUT, 'stroke-width': 1.3, 'stroke-linecap': 'round' }));
  if (c.lashes) add(s('path', { d: `M14.2 ${HEAD_Y - 1.2} L12.8 ${HEAD_Y - 2.4} M25.8 ${HEAD_Y - 1.2} L27.2 ${HEAD_Y - 2.4}`, stroke: OUT, 'stroke-width': 1, 'stroke-linecap': 'round' }));
  if (c.freckles) [[15, 25], [17.5, 26], [22.5, 26], [25, 25]].forEach(([x, y]) => add(s('circle', { cx: x, cy: y - 2, r: 0.5, fill: '#7a3b12' })));
  if (c.mustache) add(s('path', { d: `M13.5 ${HEAD_Y + 4} C16 ${HEAD_Y + 2} 19 ${HEAD_Y + 3} 20 ${HEAD_Y + 4.2} C21 ${HEAD_Y + 3} 24 ${HEAD_Y + 2} 26.5 ${HEAD_Y + 4} C24 ${HEAD_Y + 6} 21 ${HEAD_Y + 4.8} 20 ${HEAD_Y + 4.6} C19 ${HEAD_Y + 4.8} 16 ${HEAD_Y + 6} 13.5 ${HEAD_Y + 4} Z`, fill: c.hairC, ...stroke, 'stroke-width': 1 }));
  if (c.beard) add(s('path', { d: `M10.6 ${HEAD_Y + 2} C10.5 ${HEAD_Y + 12} 29.5 ${HEAD_Y + 12} 29.4 ${HEAD_Y + 2} C27 ${HEAD_Y + 7} 24 ${HEAD_Y + 9} 20 ${HEAD_Y + 9} C16 ${HEAD_Y + 9} 13 ${HEAD_Y + 7} 10.6 ${HEAD_Y + 2} Z`, fill: c.hairC, ...stroke, 'stroke-width': 1.2 }),
    s('path', { d: `M16 ${HEAD_Y + 5.2} Q20 ${HEAD_Y + 8.4} 24 ${HEAD_Y + 5.2}`, fill: '#fff', stroke: OUT, 'stroke-width': 1.1, 'stroke-linecap': 'round' }));

  // headwear
  headwear(c, add, s, OUT, stroke, ctx, suit);
  // prop (held at the side)
  prop(c, add, s, OUT, stroke, ctx, suit);
  return g;
}

function headwear(c, add, s, OUT, stroke, ctx, suit) {
  const GOLD = '#f2b705';
  switch (c.head) {
    case 'shako': // drum-major hat with plume
      add(s('rect', { x: 11.5, y: 3.5, width: 17, height: 11, rx: 1.5, fill: GOLD, ...stroke }),
        s('rect', { x: 11.5, y: 11, width: 17, height: 3, fill: '#4a34a8', ...stroke, 'stroke-width': 1 }),
        s('path', { d: 'M20 4 C18 -1 24 -1 22 3', fill: '#fff', ...stroke, 'stroke-width': 1.1 }),
        s('rect', { x: 9.5, y: 13.5, width: 21, height: 2.4, rx: 1.2, fill: '#4a34a8', ...stroke, 'stroke-width': 1.1 }));
      break;
    case 'chef':
      add(s('path', { d: 'M11 14 C6 12 8 3 14 5 C16 0 24 0 26 5 C32 3 34 12 29 14 Z', fill: '#fff', ...stroke }),
        s('rect', { x: 11, y: 12.5, width: 18, height: 3.6, rx: 1, fill: c.outfit, ...stroke, 'stroke-width': 1.2 }));
      break;
    case 'helmet':
      add(s('path', { d: 'M9.5 19 C9 5 31 5 30.5 19 Z', fill: c.outfit, ...stroke }),
        s('path', { d: 'M20 6 L20 18', stroke: OUT, 'stroke-width': 1.3 }),
        s('rect', { x: 8.5, y: 17, width: 23, height: 2.4, rx: 1.2, fill: c.accent, ...stroke, 'stroke-width': 1.1 }));
      break;
    case 'cap':
      add(s('path', { d: 'M9.8 19 C9.5 6 30.5 6 30.2 19 Z', fill: c.outfit, ...stroke }),
        s('path', { d: 'M9 19 L2.5 21 C4 23.5 9 22.5 13 20.5 Z', fill: c.outfit, ...stroke }),
        s('circle', { cx: 20, cy: 6.6, r: 1.5, fill: '#fff', ...stroke, 'stroke-width': 1 }));
      break;
    case 'bandana':
      add(s('path', { d: 'M10 17.5 C14 14.5 26 14.5 30 17.5 L29.5 21 C25 18.5 15 18.5 10.5 21 Z', fill: c.outfit, ...stroke }),
        s('path', { d: 'M29 18 L35 15 L34 21 Z', fill: c.outfit, ...stroke, 'stroke-width': 1.2 }));
      break;
    case 'pastry': // crown of pastries
      add(s('path', { d: 'M11 13 L12 5 L16 9 L20 3 L24 9 L28 5 L29 13 Z', fill: GOLD, ...stroke }));
      [[13.5, 4.5], [20, 2.6], [26.5, 4.5]].forEach(([x, y]) => add(s('circle', { cx: x, cy: y, r: 2.6, fill: '#f4c27a', ...stroke, 'stroke-width': 1.1 })));
      break;
    case 'leaves':
      [[11, 12, -50], [15, 8.5, -25], [20, 7.5, 0], [25, 8.5, 25], [29, 12, 50]].forEach(([x, y, r]) =>
        add(s('ellipse', { cx: x, cy: y, rx: 2.6, ry: 4.6, fill: '#22b573', transform: `rotate(${r} ${x} ${y})`, ...stroke, 'stroke-width': 1.2 })));
      add(s('circle', { cx: 20, cy: 11, r: 1.6, fill: '#ffb02e', ...stroke, 'stroke-width': 0.9 }));
      break;
    case 'goggles': // flat cap + goggles pushed up
      add(s('path', { d: 'M9.8 17 C9.5 6 30.5 6 30.2 17 Z', fill: '#6b4a2b', ...stroke }),
        s('rect', { x: 9.5, y: 14, width: 21, height: 2.4, fill: '#3a2a18', ...stroke, 'stroke-width': 1 }),
        s('circle', { cx: 15.5, cy: 12, r: 3.6, fill: c.accent, ...stroke }), s('circle', { cx: 24.5, cy: 12, r: 3.6, fill: c.accent, ...stroke }),
        s('circle', { cx: 14.6, cy: 11, r: 1, fill: '#fff' }), s('circle', { cx: 23.6, cy: 11, r: 1, fill: '#fff' }));
      break;
    default:
  }
}

function prop(c, add, s, OUT, stroke, ctx, suit) {
  const GOLD = '#f2b705';
  const hand = (x, y) => s('circle', { cx: x, cy: y, r: 2.7, fill: c.skin, ...stroke, 'stroke-width': 1.2 });
  switch (c.prop) {
    case 'skate': // board under the arm
      add(s('rect', { x: 1, y: 40, width: 17, height: 4.2, rx: 2.1, fill: GOLD, ...stroke, 'stroke-width': 1.3 }),
        s('circle', { cx: 5, cy: 46.2, r: 1.8, fill: '#fff', ...stroke, 'stroke-width': 1 }), s('circle', { cx: 14, cy: 46.2, r: 1.8, fill: '#fff', ...stroke, 'stroke-width': 1 }), hand(19, 43));
      break;
    case 'mic':
      add(s('rect', { x: 31, y: 35, width: 3, height: 12, rx: 1.4, fill: '#2a1b6b', ...stroke, 'stroke-width': 1.1 }),
        s('circle', { cx: 32.5, cy: 33, r: 4, fill: GOLD, ...stroke }), hand(32.5, 44));
      break;
    case 'drum':
      add(s('path', { d: 'M3 41 L3 48 C3 51 17 51 17 48 L17 41 Z', fill: GOLD, ...stroke }),
        s('ellipse', { cx: 10, cy: 41, rx: 7, ry: 2.6, fill: '#fff', ...stroke }),
        s('path', { d: 'M5 42 L8 49 M10 43 L10 50 M15 42 L12 49', stroke: '#4a34a8', 'stroke-width': 1 }));
      add(s('line', { x1: 28, y1: 30, x2: 34, y2: 41, stroke: OUT, 'stroke-width': 1.6, 'stroke-linecap': 'round' }), s('circle', { cx: 27.6, cy: 29.4, r: 1.8, fill: '#fff', ...stroke, 'stroke-width': 1 }), hand(33.5, 41));
      break;
    case 'pie': // heart-shaped pie
      add(ctx.pip('H', 31, 41, 15), hand(24, 46));
      add(s('path', { d: 'M26 38 L30 36 M31 36 L36 38', stroke: '#fff4d6', 'stroke-width': 1.3, 'stroke-linecap': 'round' }));
      break;
    case 'whisk':
      add(s('line', { x1: 33, y1: 47, x2: 33, y2: 37, stroke: OUT, 'stroke-width': 2, 'stroke-linecap': 'round' }),
        s('ellipse', { cx: 33, cy: 33, rx: 3.4, ry: 5, fill: 'none', ...stroke, 'stroke-width': 1.1 }), s('line', { x1: 33, y1: 28, x2: 33, y2: 38, stroke: OUT, 'stroke-width': 1 }), hand(33, 44));
      break;
    case 'spatula':
      add(s('line', { x1: 30, y1: 48, x2: 35, y2: 36, stroke: OUT, 'stroke-width': 2, 'stroke-linecap': 'round' }),
        s('rect', { x: 31, y: 28, width: 8, height: 8, rx: 1.4, fill: '#bfc4d4', transform: 'rotate(15 35 32)', ...stroke, 'stroke-width': 1.2 }), hand(31, 44));
      break;
    case 'bag': // messenger bag with diamond badge
      add(s('path', { d: 'M6 35 L34 49', stroke: OUT, 'stroke-width': 3, 'stroke-linecap': 'round' }), s('path', { d: 'M6 35 L34 49', stroke: '#1b1330', 'stroke-width': 1.4 }),
        s('rect', { x: 26, y: 40, width: 12, height: 9, rx: 2, fill: '#fff4d6', ...stroke, 'stroke-width': 1.3 }), ctx.pip('D', 32, 45, 5));
      break;
    case 'scissors':
      add(s('path', { d: 'M28 49 L36 33 M36 49 L28 33', stroke: OUT, 'stroke-width': 3.4, 'stroke-linecap': 'round' }), s('path', { d: 'M28 49 L36 33 M36 49 L28 33', stroke: '#e5e9f5', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
        s('circle', { cx: 27.5, cy: 31.5, r: 2.4, fill: 'none', ...stroke, 'stroke-width': 1.2 }), s('circle', { cx: 36.5, cy: 31.5, r: 2.4, fill: 'none', ...stroke, 'stroke-width': 1.2 }));
      break;
    case 'wrench':
      add(s('rect', { x: 31, y: 33, width: 3.6, height: 15, rx: 1.6, fill: '#bfc4d4', transform: 'rotate(18 32 40)', ...stroke, 'stroke-width': 1.2 }),
        s('circle', { cx: 28.6, cy: 32, r: 3.6, fill: '#bfc4d4', ...stroke, 'stroke-width': 1.2 }), s('rect', { x: 27.4, y: 28, width: 2.4, height: 4, fill: ctx.colors.D }), hand(34, 45));
      break;
    case 'can': // watering can
      add(s('path', { d: 'M22 38 L22 49 L36 49 L36 38 Z', fill: '#bfc4d4', ...stroke }),
        s('path', { d: 'M22 41 L14 35', stroke: OUT, 'stroke-width': 2.6, 'stroke-linecap': 'round' }), s('path', { d: 'M22 41 L14 35', stroke: '#bfc4d4', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
        s('path', { d: 'M36 40 C42 40 42 47 36 47', fill: 'none', ...stroke, 'stroke-width': 1.5 }),
        s('rect', { x: 22, y: 38, width: 14, height: 3, fill: ctx.colors.C, ...stroke, 'stroke-width': 1 }));
      break;
    case 'trowel':
      add(s('line', { x1: 32, y1: 49, x2: 32, y2: 40, stroke: OUT, 'stroke-width': 2.4, 'stroke-linecap': 'round' }),
        s('path', { d: 'M32 40 C27 38 28 31 32 28 C36 31 37 38 32 40 Z', fill: '#bfc4d4', ...stroke, 'stroke-width': 1.2 }), hand(32, 46));
      break;
    case 'whistle':
      add(s('path', { d: 'M13 35 C15 44 25 44 27 35', fill: 'none', stroke: OUT, 'stroke-width': 1.3 }),
        s('rect', { x: 15.5, y: 41.5, width: 9, height: 5, rx: 2.4, fill: GOLD, ...stroke, 'stroke-width': 1.2 }), s('circle', { cx: 18, cy: 44, r: 1, fill: OUT }));
      break;
    default:
  }
}
