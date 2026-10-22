// Avatars: preset pictures (public/faces) and custom faces drawn as SVG from a short code.
// A custom code is "c" + one base-36 digit per part, in PARTS order. Keep counts in step with src/server/avatar.ts.

export const PRESETS = [
  ['aces', 'Four Aces'], ['crown', 'King Spade'], ['graffiti', 'Flame Spade'], ['lion', 'Big Cat'], ['wolf', 'Lone Wolf'],
  ['cat', 'Cool Cat'], ['pitbull', 'Brick'], ['kicks', 'Fresh Kicks'], ['hoops', 'Buckets'], ['boombox', 'Boombox'],
  ['lowrider', 'Lowrider'], ['chopper', 'Chopper'], ['muscle', 'Midnight'],
];

const SKIN = ['#f9dcc4', '#f1c7a2', '#e5ad83', '#d39a6a', '#c08552', '#a86b3c', '#8d5527', '#74431f', '#5e3418', '#4a2812', '#3a1f0f', '#2c170b'];
const HAIRC = ['#111', '#2b1b10', '#4a2e1a', '#7a4a24', '#b07a3f', '#d9b25f', '#9a9a9a', '#f2f2f2', '#8e2b6d'];
const SHIRT = ['#1d1d1d', '#f4f4f0', '#c8102e', '#1f4fd1', '#1a8f4a', '#e8c764', '#6a2bb3', '#ff7a1a', '#2a9fb8', '#e05aa0'];
const BG = ['#e8c764', '#2f4f3a', '#3a3f8f', '#8f3a3a', '#1e1e24', '#5aa6c8', '#c86ad4', '#e48c4a', '#7bbf6a', '#d6d2c4'];

export const PARTS = [
  { key: 'skin', label: 'Skin', n: SKIN.length, swatch: SKIN },
  { key: 'shape', label: 'Face', n: 3, names: ['Round', 'Oval', 'Square'] },
  { key: 'hair', label: 'Hair', n: 16, names: ['Bald', 'Buzz', 'Fade', 'Waves', 'Afro', 'Locs', 'Braids', 'Cornrows', 'Bun', 'Ponytail', 'Curls', 'Long', 'Bob', 'Frohawk', 'Twists', 'Side part'] },
  { key: 'hairColor', label: 'Hair color', n: HAIRC.length, swatch: HAIRC },
  { key: 'brows', label: 'Brows', n: 4, names: ['Natural', 'Thick', 'Arched', 'Serious'] },
  { key: 'eyes', label: 'Eyes', n: 5, names: ['Classic', 'Wide', 'Chill', 'Wink', 'Lashes'] },
  { key: 'nose', label: 'Nose', n: 3, names: ['Button', 'Broad', 'Long'] },
  { key: 'mouth', label: 'Mouth', n: 6, names: ['Smile', 'Big grin', 'Smirk', 'Straight face', 'Laughing', 'Oooh'] },
  { key: 'facial', label: 'Beard', n: 6, names: ['None', 'Stubble', 'Mustache', 'Goatee', 'Full beard', 'Chin strap'] },
  { key: 'glasses', label: 'Glasses', n: 5, names: ['None', 'Round', 'Square', 'Shades', 'Gold aviators'] },
  { key: 'hat', label: 'Hat', n: 5, names: ['None', 'Fitted cap', 'Durag', 'Beanie', 'Cap backwards'] },
  { key: 'jewelry', label: 'Jewelry', n: 5, names: ['None', 'Studs', 'Hoops', 'Gold chain', 'Studs + chain'] },
  { key: 'shirt', label: 'Shirt', n: SHIRT.length, swatch: SHIRT },
  { key: 'bg', label: 'Background', n: BG.length, swatch: BG },
];

export const isCustom = (code) => typeof code === 'string' && code.length === PARTS.length + 1 && /^c[0-9a-z]+$/.test(code) &&
  PARTS.every((p, i) => parseInt(code[i + 1], 36) < p.n);
export const decode = (code) => Object.fromEntries(PARTS.map((p, i) => [p.key, parseInt(code[i + 1], 36)]));
export const encode = (o) => 'c' + PARTS.map((p) => Math.max(0, Math.min(p.n - 1, o[p.key] | 0)).toString(36)).join('');
export const randomCode = () => encode(Object.fromEntries(PARTS.map((p) => [p.key, Math.floor(Math.random() * p.n)])));

/** Same hash as the server's fallbackAvatar, so a name without a picture always gets the same face. */
export function seededCode(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let code = 'c';
  for (const p of PARTS) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; code += (h % p.n).toString(36); }
  return code;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1).replace(/^(.)(.)(.)$/, '$1$1$2$2$3$3'), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** SVG markup for a custom code (100 x 100). */
export function avatarSvg(code) {
  const a = decode(code);
  const skin = SKIN[a.skin], sk2 = shade(skin, 0.85), hc = HAIRC[a.hairColor], shirt = SHIRT[a.shirt];
  const ink = '#1b1410';
  const rx = [23, 21, 23][a.shape], ry = [24, 27, 25][a.shape];
  const head = a.shape === 2
    ? `<rect x="${50 - rx}" y="${47 - ry}" width="${rx * 2}" height="${ry * 2}" rx="13" fill="${skin}"/>`
    : `<ellipse cx="50" cy="47" rx="${rx}" ry="${ry}" fill="${skin}"/>`;
  const L = 50 - rx, R = 50 + rx, top = 47 - ry;
  const back = {
    4: `<circle cx="50" cy="${top + 14}" r="${rx + 12}" fill="${hc}"/>`,
    5: Array.from({ length: 8 }, (_, i) => `<rect x="${L - 4 + i * ((rx * 2 + 8 - 6) / 7)}" y="${top + 6}" width="6" height="52" rx="3" fill="${hc}"/>`).join(''),
    6: Array.from({ length: 7 }, (_, i) => `<path d="M${L - 2 + i * ((rx * 2 + 4) / 6)} ${top + 8} v46" stroke="${hc}" stroke-width="5" stroke-dasharray="4 1.5" stroke-linecap="round"/>`).join(''),
    9: `<path d="M${R - 4} ${top + 10} q16 14 6 44 q-6 6 -8 -4 q6 -20 -4 -30z" fill="${hc}"/>`,
    11: `<path d="M${L - 3} ${top + 12} q-4 40 4 54 h${rx * 2 - 2} q8 -14 4 -54z" fill="${hc}"/>`,
    12: `<path d="M${L - 4} ${top + 10} q-3 26 4 32 h${rx * 2} q7 -6 4 -32z" fill="${hc}"/>`,
  }[a.hair] || '';
  const body = `<path d="M14 100 q4 -24 36 -26 q32 2 36 26z" fill="${shirt}"/><rect x="43" y="66" width="14" height="12" fill="${sk2}"/>` +
    `<path d="M41 75 q9 7 18 0" stroke="${shade(shirt, 0.75)}" stroke-width="3" fill="none"/>`;
  const ears = `<ellipse cx="${L + 1}" cy="49" rx="4" ry="6" fill="${sk2}"/><ellipse cx="${R - 1}" cy="49" rx="4" ry="6" fill="${sk2}"/>`;
  const jw = a.jewelry;
  const ear = jw === 1 || jw === 4 ? `<circle cx="${L}" cy="55" r="1.8" fill="#f3f3f3"/><circle cx="${R}" cy="55" r="1.8" fill="#f3f3f3"/>`
    : jw === 2 ? `<circle cx="${L}" cy="58" r="3.5" stroke="#e8c764" stroke-width="1.5" fill="none"/><circle cx="${R}" cy="58" r="3.5" stroke="#e8c764" stroke-width="1.5" fill="none"/>` : '';
  const chain = jw >= 3 ? `<path d="M38 77 q12 14 24 0" stroke="#e8c764" stroke-width="2.4" fill="none" stroke-dasharray="2.5 1"/>` : '';
  const beard = [
    '',
    `<path d="M${L + 3} 52 q2 20 ${rx - 3} 21 q${rx - 3} -1 ${rx - 3} -21 q-4 12 -${rx - 3} 13 q-${rx - 3} -1 -${rx - 3} -13z" fill="${hc}" opacity=".28"/>`,
    `<path d="M41 60 q9 -5 18 0 q-9 -1 -18 0z" stroke="${hc}" stroke-width="3" fill="${hc}"/>`,
    `<path d="M41 60 q9 -5 18 0" stroke="${hc}" stroke-width="2.5" fill="none"/><path d="M45 66 q5 8 10 0 q-5 2 -10 0z" fill="${hc}" stroke="${hc}" stroke-width="2"/>`,
    `<path d="M${L + 2} 48 q0 26 ${rx - 2} 26 q${rx - 2} 0 ${rx - 2} -26 q-3 12 -8 13 q-${rx - 10} -6 -${rx * 2 - 20} 0 q-5 -1 -8 -13z" fill="${hc}"/>`,
    `<path d="M${L + 2} 48 q2 26 ${rx - 2} 25 q${rx - 2} 1 ${rx - 2} -25" stroke="${hc}" stroke-width="3" fill="none"/>`,
  ][a.facial];
  const mouth = [
    `<path d="M43 61 q7 6 14 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    `<path d="M42 59 h16 q-1 9 -8 9 q-7 0 -8 -9z" fill="#fff" stroke="${ink}" stroke-width="1.8"/>`,
    `<path d="M44 62 q6 2 13 -3" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`,
    `<path d="M44 62 h12" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>`,
    `<path d="M42 59 h16 q-1 11 -8 11 q-7 0 -8 -11z" fill="#5a1e1e"/><path d="M45 66 q5 -3 10 0 q-5 4 -10 0z" fill="#e2626a"/>`,
    `<ellipse cx="50" cy="62" rx="3.5" ry="4" fill="#5a1e1e"/>`,
  ][a.mouth];
  const nose = [
    `<path d="M48 53 q2 2 4 0" stroke="${shade(skin, 0.65)}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    `<path d="M45 53 q2 3 5 1 q3 2 5 -1" stroke="${shade(skin, 0.6)}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    `<path d="M50 44 l-2 10 h4" stroke="${shade(skin, 0.65)}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  ][a.nose];
  const eye = (x, wink) => wink ? `<path d="M${x - 3.5} 46 q3.5 -3 7 0" stroke="${ink}" stroke-width="2" fill="none" stroke-linecap="round"/>` : [
    `<circle cx="${x}" cy="46" r="2.6" fill="${ink}"/>`,
    `<ellipse cx="${x}" cy="46" rx="4" ry="4.2" fill="#fff"/><circle cx="${x}" cy="46.5" r="2.4" fill="${ink}"/><circle cx="${x + 0.8}" cy="45.5" r=".8" fill="#fff"/>`,
    `<path d="M${x - 3.5} 46 h7" stroke="${ink}" stroke-width="2" stroke-linecap="round"/><circle cx="${x}" cy="47" r="1.8" fill="${ink}"/>`,
    `<circle cx="${x}" cy="46" r="2.6" fill="${ink}"/>`,
    `<circle cx="${x}" cy="46" r="2.8" fill="${ink}"/><path d="M${x - 4} 43.5 l-1.8 -1.6 M${x + 4} 43.5 l1.8 -1.6" stroke="${ink}" stroke-width="1.4"/>`,
  ][a.eyes];
  const eyes = eye(41, false) + eye(59, a.eyes === 3);
  const brow = (x, s) => [
    `<path d="M${x - 4} 39 q4 -2 8 0" stroke="${hc}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
    `<path d="M${x - 5} 39 q5 -3 10 0" stroke="${hc}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`,
    `<path d="M${x - 4} 39.5 q${s * 2 + 2} -5 8 0" stroke="${hc}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
    `<path d="M${x - 4.5} ${s < 0 ? 38 : 40} L${x + 4.5} ${s < 0 ? 40 : 38}" stroke="${hc}" stroke-width="2.6" stroke-linecap="round"/>`,
  ][a.brows];
  const brows = brow(41, -1) + brow(59, 1);
  const cap = (y) => `M${L - 1} ${y} q0 -${ry - 2} ${rx + 1} -${ry - 2} q${rx + 1} 0 ${rx + 1} ${ry - 2}z`;
  const fr = `M${L} 44 q-1 -${ry + 1} ${rx} -${ry + 1} q${rx + 1} 0 ${rx} ${ry + 1}`; // hairline cap
  const front = [
    '',
    `<path d="${fr} q-4 -10 -${rx} -10 q-${rx - 4} 0 -${rx} 10z" fill="${hc}" opacity=".55"/>`,
    `<path d="${fr} q-3 -12 -${rx} -12 q-${rx - 3} 0 -${rx} 12z" fill="${hc}"/><path d="M${L} 44 v-8 M${R} 44 v-8" stroke="${hc}" stroke-width="1.5" opacity=".4"/>`,
    `<path d="${fr} q-3 -12 -${rx} -12 q-${rx - 3} 0 -${rx} 12z" fill="${hc}"/>` + [0, 1, 2].map((k) => `<path d="M${L + 6} ${top + 5 + k * 5} q${rx - 6} -5 ${rx * 2 - 12} 0" stroke="${shade(hc === '#111' ? '#555555' : hc, 1.35)}" stroke-width="1.2" fill="none"/>`).join(''),
    `<path d="${fr} q-3 -10 -${rx} -10 q-${rx - 3} 0 -${rx} 10z" fill="${hc}"/>`,
    `<path d="${fr} q-3 -11 -${rx} -11 q-${rx - 3} 0 -${rx} 11z" fill="${hc}"/>`,
    `<path d="${fr} q-3 -11 -${rx} -11 q-${rx - 3} 0 -${rx} 11z" fill="${hc}"/>`,
    `<path d="${fr} q-3 -12 -${rx} -12 q-${rx - 3} 0 -${rx} 12z" fill="${hc}"/>` + [-12, -4, 4, 12].map((d) => `<path d="M${50 + d} ${top + 14} q${d / 4} -8 ${d / 3} -15" stroke="${shade(skin, 0.9)}" stroke-width="1.1" fill="none"/>`).join(''),
    `<path d="${fr} q-3 -11 -${rx} -11 q-${rx - 3} 0 -${rx} 11z" fill="${hc}"/><circle cx="50" cy="${top - 6}" r="9" fill="${hc}"/>`,
    `<path d="${fr} q-3 -11 -${rx} -11 q-${rx - 3} 0 -${rx} 11z" fill="${hc}"/>`,
    Array.from({ length: 11 }, (_, i) => { const t = Math.PI * (i / 10); return `<circle cx="${50 - Math.cos(t) * (rx + 1)}" cy="${top + 12 - Math.sin(t) * 13}" r="7" fill="${hc}"/>`; }).join(''),
    `<path d="${fr} q-6 -14 -${rx + 4} -8 q-${rx - 6} 2 -${rx - 4} 22z" fill="${hc}"/>`,
    `<path d="${fr} q-3 -8 -${rx} -12 q-${rx - 3} 4 -${rx} 18z" fill="${hc}"/>`,
    `<path d="${fr} q-4 -10 -${rx} -10 q-${rx - 4} 0 -${rx} 10z" fill="${hc}" opacity=".5"/><rect x="42" y="${top - 12}" width="16" height="24" rx="8" fill="${hc}"/>`,
    Array.from({ length: 9 }, (_, i) => `<rect x="${L - 2 + i * ((rx * 2 - 2) / 8)}" y="${top - 6}" width="5" height="16" rx="2.5" fill="${hc}" transform="rotate(${(i - 4) * 6} ${L + i * ((rx * 2) / 8)} ${top + 4})"/>`).join('') + `<path d="${fr} q-3 -10 -${rx} -10 q-${rx - 3} 0 -${rx} 10z" fill="${hc}"/>`,
    `<path d="${fr} q-3 -11 -${rx - 8} -14 q-${rx + 2} 2 -${rx + 8} 14z" fill="${hc}"/><path d="M${L + 14} ${top + 2} l-2 7" stroke="${skin}" stroke-width="1.6"/>`,
  ][a.hair];
  const hat = ['',
    `<path d="${cap(38)}" fill="${shirt === '#1d1d1d' ? '#c8102e' : '#1d1d1d'}"/><path d="M${L - 2} 37 h${rx * 2 + 4} q-4 6 -${rx + 2} 6 q-${rx - 2} 0 -${rx + 2} -6z" fill="${shade(shirt === '#1d1d1d' ? '#c8102e' : '#1d1d1d', 0.7)}"/><circle cx="50" cy="${top + 1}" r="1.8" fill="#e8c764"/>`,
    `<path d="${cap(42)}" fill="${shade(shirt, 0.9)}"/><path d="M${R - 2} 40 q10 4 12 22" stroke="${shade(shirt, 0.9)}" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M${L + 4} 40 q${rx - 4} -6 ${rx * 2 - 8} 0" stroke="${shade(shirt, 0.7)}" stroke-width="1.5" fill="none"/>`,
    `<path d="${cap(38)}" fill="${shade(shirt, 0.85)}"/><rect x="${L - 2}" y="33" width="${rx * 2 + 4}" height="8" rx="3" fill="${shade(shirt, 0.7)}"/><circle cx="50" cy="${top - 4}" r="4" fill="${shade(shirt, 0.7)}"/>`,
    `<path d="${cap(38)}" fill="#1d1d1d"/><path d="M${L - 6} 38 q${rx + 6} -4 ${rx * 2 + 12} 0 l-2 3 h-${rx * 2 + 8}z" fill="#2c2c2c"/><path d="M${L + 2} 38 l8 -16" stroke="#444" stroke-width="2"/>`,
  ][a.hat];
  const gl = ['',
    `<g stroke="${ink}" stroke-width="1.8" fill="rgba(255,255,255,.15)"><circle cx="41" cy="46" r="6"/><circle cx="59" cy="46" r="6"/><path d="M47 46 h6" fill="none"/></g>`,
    `<g stroke="${ink}" stroke-width="2" fill="rgba(255,255,255,.15)"><rect x="34" y="41" width="13" height="10" rx="2"/><rect x="53" y="41" width="13" height="10" rx="2"/><path d="M47 45 h6" fill="none"/></g>`,
    `<g fill="#111"><rect x="33" y="41" width="15" height="10" rx="4"/><rect x="52" y="41" width="15" height="10" rx="4"/></g><path d="M48 44 h4" stroke="#111" stroke-width="2"/><path d="M36 43 l4 0" stroke="#fff" stroke-width="1" opacity=".5"/>`,
    `<g stroke="#c9a23c" stroke-width="1.6" fill="rgba(60,40,10,.55)"><path d="M33 42 h14 q0 10 -7 10 q-7 0 -7 -10z"/><path d="M53 42 h14 q0 10 -7 10 q-7 0 -7 -10z"/><path d="M47 43 h6" fill="none"/></g>`,
  ][a.glasses];
  // Durag, beanie and caps cover the top of the hair; tall styles stay visible under nothing.
  const showFront = a.hat === 0 || [4, 13].includes(a.hair) === false;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${BG[a.bg]}"/>` +
    back + body + ears + head + ear + beard + mouth + nose + eyes + brows + (a.hat && [4, 8, 13].includes(a.hair) ? '' : showFront ? front : '') + hat + gl + chain + '</svg>';
}

export const avatarSrc = (code) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(avatarSvg(code));
