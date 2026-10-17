// Soft procedural lounge music with the Web Audio API: a slow chord loop with a warm pad, electric-piano-like pulses,
// a gentle sine bass and brush-like noise. Everything is synthesized here: no audio files, no downloads, no libraries.
// Starts only from a user tap (start() is called from a click handler), fades in and out, and stops without clicks:
// every note has its own envelope, and on stop all voices are ended and disconnected and the context is suspended.

import { BAR, BEAT, CHORDS, COMP_PATTERNS, gainForVolume, midiToHz } from './music-state.js';

export function createMusic() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const supported = !!AC;
  let ctx = null;
  let master = null;
  let bus = null;
  let noise = null;
  let timer = 0;
  let stopTimer = 0;
  let playing = false;
  let heldByVisibility = false;
  let volume = 0.5;
  let nextBar = 0;
  let barIdx = 0;
  const voices = new Set();

  function build() {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    bus = ctx.createGain();
    const soft = ctx.createBiquadFilter(); // takes the edge off everything
    soft.type = 'lowpass';
    soft.frequency.value = 3000;
    soft.Q.value = 0.4;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.ratio.value = 3;
    bus.connect(soft).connect(comp).connect(master).connect(ctx.destination);
    const len = ctx.sampleRate; // one second of white noise for the brushes
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Track a source so stop() can end it and nothing stays connected. */
  function track(src, ...nodes) {
    const v = { src, nodes };
    voices.add(v);
    src.onended = () => { voices.delete(v); for (const n of [src, ...nodes]) { try { n.disconnect(); } catch { /* already gone */ } } };
  }

  /** One enveloped oscillator: ramps in and out (never starts or stops at full level, so no clicks). */
  function tone(type, hz, at, dur, peak, { attack = 0.01, release = 0.3, detune = 0, decay = 0 } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = hz;
    o.detune.value = detune;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + attack);
    let end;
    if (decay) { // e-piano: plucked, then rings out (exponential fall to near silence, then a final ramp to zero)
      end = at + attack + decay * 5;
      g.gain.exponentialRampToValueAtTime(0.0002, end);
      g.gain.linearRampToValueAtTime(0, end + 0.05);
    } else {
      g.gain.setValueAtTime(peak, at + Math.max(attack, dur));
      end = at + dur + release;
      g.gain.linearRampToValueAtTime(0, end);
    }
    o.connect(g).connect(bus);
    o.start(at);
    o.stop(end + 0.1);
    track(o, g);
  }

  function brush(at, peak) {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 5200;
    f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.03);
    g.gain.linearRampToValueAtTime(0, at + 0.22);
    s.connect(f).connect(g).connect(bus);
    s.start(at, Math.random() * 0.7, 0.3);
    track(s, f, g);
  }

  function scheduleBar(i, t0) {
    const c = CHORDS[i % CHORDS.length];
    // pad: warm, slow, overlapping into the next bar
    c.pad.forEach((m, k) => {
      const hz = midiToHz(m);
      tone('sine', hz, t0, BAR, 0.035, { attack: 0.9, release: 1.0, detune: k % 2 ? 4 : -4 });
      tone('triangle', hz, t0, BAR, 0.012, { attack: 1.1, release: 1.0, detune: k % 2 ? -5 : 5 });
    });
    // bass: root on one, a softer fifth later
    const bass = (m, at, peak, dur) => { const hz = midiToHz(m); tone('sine', hz, at, dur, peak, { attack: 0.03, release: 0.35 }); tone('triangle', hz * 2, at, dur, peak * 0.25, { attack: 0.03, release: 0.3 }); };
    bass(c.bass, t0, 0.16, BEAT * 1.3);
    bass(c.bass + (i % 2 ? 12 : 7), t0 + BEAT * 2.5, 0.1, BEAT * 1.0);
    // electric piano: short pulses on a picked pattern, lightly strummed
    const pat = COMP_PATTERNS[Math.floor(Math.random() * COMP_PATTERNS.length)];
    pat.forEach((beat, n) => {
      const at = t0 + beat * BEAT + (beat % 1 ? BEAT * 0.1 : 0); // a touch of swing on the off-beats
      const chosen = c.keys.filter((_, k) => (n + k) % 4 !== 3).slice(0, n === 0 ? 4 : 3);
      chosen.forEach((m, k) => {
        const hz = midiToHz(m);
        const st = at + k * 0.022;
        tone('sine', hz, st, 0.05, 0.06, { attack: 0.008, release: 2.0, decay: 0.55 });
        tone('sine', hz * 2, st, 0.05, 0.016, { attack: 0.006, release: 0.5, decay: 0.12 }); // the bell-like "tine"
      });
    });
    // brushes: soft on the backbeat, a whisper on the downbeats
    brush(t0 + BEAT, 0.05);
    brush(t0 + BEAT * 3, 0.05);
    brush(t0 + BEAT * 2.67, 0.014);
    brush(t0, 0.016);
    brush(t0 + BEAT * 2, 0.016);
  }

  function tick() {
    if (!playing || !ctx) return;
    while (nextBar < ctx.currentTime + 1.5) {
      scheduleBar(barIdx, nextBar);
      nextBar += BAR;
      barIdx += 1;
    }
  }

  function fadeTo(value, seconds) {
    const now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(value, now + seconds);
  }

  async function start(vol) {
    if (!supported) return false;
    volume = vol;
    clearTimeout(stopTimer);
    if (!ctx) build();
    try { if (ctx.state === 'suspended') await ctx.resume(); } catch { return false; }
    if (playing) { setVolume(vol); return true; }
    playing = true;
    nextBar = ctx.currentTime + 0.2;
    tick();
    timer = setInterval(tick, 400);
    fadeTo(gainForVolume(volume), 1.6);
    return true;
  }

  /** Fade out, then end every voice and suspend the context so nothing keeps running. */
  function stop(fade = 1.2) {
    if (!ctx || !playing) return;
    playing = false;
    clearInterval(timer);
    fadeTo(0, fade);
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      if (playing || !ctx) return;
      for (const v of [...voices]) { try { v.src.stop(); } catch { /* not started or already ended */ } try { v.src.disconnect(); v.nodes.forEach((n) => n.disconnect()); } catch { /* ok */ } }
      voices.clear();
      ctx.suspend().catch(() => {});
    }, fade * 1000 + 80);
  }

  function setVolume(vol) {
    volume = vol;
    if (ctx && playing) { const now = ctx.currentTime; master.gain.cancelScheduledValues(now); master.gain.setTargetAtTime(gainForVolume(vol), now, 0.12); }
  }

  // Pause while the tab is hidden (saves battery, nobody hears it anyway) and carry on when it is back.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && playing) { heldByVisibility = true; stop(0.4); }
    else if (!document.hidden && heldByVisibility) { heldByVisibility = false; start(volume); }
  });

  return { supported, start, stop, setVolume, get playing() { return playing; }, get voiceCount() { return voices.size; } };
}
