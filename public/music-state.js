// Table music: the parts that need no audio hardware (preferences and the chord chart), so they can be unit tested.
// The sound itself is generated in the browser by music.js with the Web Audio API. No audio files, nothing downloaded.

export const MUSIC_DEFAULT = Object.freeze({ on: false, vol: 0.5 }); // off until the user taps, middling volume

/** Parse what localStorage held. Anything odd falls back to the defaults (off); volume is clamped to 0..1. */
export function parseMusicPrefs(raw) {
  let o = null;
  try { o = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { o = null; }
  if (!o || typeof o !== 'object') return { ...MUSIC_DEFAULT };
  const v = Number(o.vol);
  const vol = Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : MUSIC_DEFAULT.vol;
  return { on: o.on === true, vol };
}

export const serializeMusicPrefs = (p) => JSON.stringify({ on: p.on === true, vol: parseMusicPrefs(JSON.stringify(p)).vol });

/** Slider position 0..1 to a master gain. Squared so the low end is gentle; the cap keeps even "high" soft. */
export const MAX_GAIN = 0.3;
export const gainForVolume = (vol) => MAX_GAIN * Math.min(1, Math.max(0, vol)) ** 2;

// ---- the chord chart: slow, mellow, 8 bars that loop (I vi ii V iii VI7 ii V) in C ----
export const BPM = 72;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

//             bass  pad voices (soft, held)    e-piano voicing (played in short pulses)
export const CHORDS = [
  { name: 'Cmaj9', bass: 36, pad: [55, 59, 62, 64], keys: [64, 67, 71, 74] },
  { name: 'Am9', bass: 33, pad: [55, 59, 60, 64], keys: [64, 67, 71, 72] },
  { name: 'Dm9', bass: 38, pad: [53, 57, 60, 64], keys: [65, 69, 72, 76] },
  { name: 'G13', bass: 31, pad: [53, 59, 64, 67], keys: [64, 65, 71, 76] },
  { name: 'Em7', bass: 40, pad: [55, 59, 62, 67], keys: [62, 67, 71, 74] },
  { name: 'A7', bass: 33, pad: [55, 59, 61, 67], keys: [61, 67, 71, 76] },
  { name: 'Dm9', bass: 38, pad: [53, 57, 60, 64], keys: [65, 69, 72, 76] },
  { name: 'G13', bass: 31, pad: [53, 59, 64, 67], keys: [64, 65, 71, 76] },
];

/** Where in the bar (in beats) the electric piano plays; one pattern is picked per bar. */
export const COMP_PATTERNS = [[0, 1.5, 2.5], [0, 2, 3.5], [0.5, 2, 3], [0, 1.5, 3]];
