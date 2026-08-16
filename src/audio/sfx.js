// The sound bank. Every entry is an independent synthesis recipe — a different anatomy,
// not the same click at a different playback rate. That matters more than it sounds like it
// should: a bank built from one shape re-pitched is instantly recognisable as fake, and the
// ear stops believing the world about ninety seconds in.
//
// A recipe is a pure function (sampleRate, Rng) -> Float32Array (mono) or [left, right].
// No AudioContext is touched here, so the whole bank renders and can be measured headless.
//
// Metadata carried per sound:
//   cat      grouping + default mix/priority
//   gain     mix level relative to its bus
//   prio     voice-stealing priority; combat outranks ambience, always (see audio.js)
//   ref      distance in metres at which attenuation starts
//   maxDist  distance at which the sound is inaudible
//   reverb   send amount into the procedural convolution reverb
//   variants how many independently seeded renders to bake (repetition fatigue killer)
//   loop     bed sounds, rendered seam-free with synth.loopify

import { Rng } from '../core/rng.js';
import { TAU, clamp, clamp01, lerp } from '../core/math.js';
import {
  whiteNoise, pinkNoise, brownNoise, makeOsc, adsr, expEnv, ramp,
  lowpass1, highpass1, bandpass, lowpassSweep, bandpassSweep, dcBlock,
  saturate, scaleArr, normalize, fadeEdges, mixInto, mixAt, loopify,
  percussiveHit, bellTone, pluckString, midiHz, CTRL,
} from './synth.js';

// ---------------------------------------------------------------------------
// Local composition helpers
// ---------------------------------------------------------------------------

const nsamp = (sr, dur) => Math.max(4, Math.round(dur * sr));

// Path filters evaluate their frequency curve at control rate (synth.CTRL samples), same
// reasoning as the sweeps in synth.js: inaudible stepping, a third of the render cost.

/** Bandpass whose centre follows an arbitrary path fn(t in 0..1) -> Hz. */
function bpPath(x, q, sr, fn) {
  const n = x.length;
  const inv = 1 / Math.max(1, n - 1);
  const damp = 1 / Math.max(0.5, q);
  const g = Math.min(2.4, Math.sqrt(Math.max(0.5, q)));
  let low = 0, band = 0, f = 0;
  for (let i = 0; i < n; i++) {
    if ((i & (CTRL - 1)) === 0) f = 2 * Math.sin(Math.PI * clamp(fn(i * inv), 20, sr * 0.45) / sr);
    const high = x[i] - low - damp * band;
    band += f * high;
    low += f * band;
    x[i] = band * g;
  }
  return x;
}

/** Lowpass whose cutoff follows an arbitrary path fn(t) -> Hz. */
function lpPath(x, sr, fn) {
  const n = x.length;
  const inv = 1 / Math.max(1, n - 1);
  let y = 0, a = 0;
  for (let i = 0; i < n; i++) {
    if ((i & (CTRL - 1)) === 0) a = Math.exp(-TAU * clamp(fn(i * inv), 12, sr * 0.48) / sr);
    y = y * a + x[i] * (1 - a);
    x[i] = y;
  }
  return x;
}

function noiseOf(rng, sr, dur, kind) {
  const n = nsamp(sr, dur);
  if (kind === 'pink') return pinkNoise(rng, n);
  if (kind === 'brown') return brownNoise(rng, n);
  return whiteNoise(rng, n);
}

/** Pitched tone with an exponential frequency glide and an exponential amplitude decay. */
function glide(sr, dur, f0, f1, o = {}) {
  const n = nsamp(sr, dur);
  const out = new Float32Array(n);
  const osc = makeOsc(o.wave || 'sine', sr, o.phase || 0);
  const env = o.env || expEnv(n, sr, o.tau !== undefined ? o.tau : dur * 0.3, o.attack !== undefined ? o.attack : 0.002);
  const l0 = Math.log(Math.max(6, f0)), l1 = Math.log(Math.max(6, f1));
  const curve = o.curve !== undefined ? o.curve : 0.5;
  const vib = o.vib || 0, vibHz = o.vibHz || 6;
  const inv = 1 / Math.max(1, n - 1);
  let base = 0, f = 0;
  for (let i = 0; i < n; i++) {
    const t = i * inv;
    if ((i & (CTRL - 1)) === 0) base = Math.exp(lerp(l0, l1, Math.pow(t, curve)));
    f = vib ? base * (1 + Math.sin(t * dur * TAU * vibHz) * vib) : base;
    out[i] += osc(f, o.duty) * env[i];
  }
  return scaleArr(out, o.amp !== undefined ? o.amp : 1);
}

/** Sum of fixed-pitch decaying partials. spec entries are [ratio, amp, decaySeconds]. */
function modes(sr, dur, base, spec) {
  const n = nsamp(sr, dur);
  const out = new Float32Array(n);
  for (const [r, a, d] of spec) {
    const f = base * r;
    if (f > sr * 0.45) continue;
    const osc = makeOsc('sine', sr);
    const env = expEnv(n, sr, d, 0.0006);
    for (let i = 0; i < n; i++) out[i] += osc(f) * env[i] * a;
  }
  return out;
}

/**
 * Scattered short bandpassed grains. This is how every granular material in the bank is
 * made — sand, snow, fire pops, ice shards, splinters — with only the statistics changed.
 */
function grains(rng, sr, dur, o) {
  const n = nsamp(sr, dur);
  const out = new Float32Array(n);
  const count = o.count || 12;
  const [gmA, gmB] = o.ms || [4, 18];
  const [fA, fB] = o.f || [900, 5000];
  const [gA, gB] = o.gain || [0.3, 1];
  for (let i = 0; i < count; i++) {
    const u = i / count;
    const at = o.at ? o.at(u, rng) : rng.f() * dur * 0.93;
    const gm = rng.range(gmA, gmB) / 1000;
    const gn = Math.max(3, Math.round(gm * sr));
    const g = whiteNoise(rng, gn);
    bandpass(g, Math.exp(rng.range(Math.log(fA), Math.log(fB))), o.q || 5, sr);
    const e = expEnv(gn, sr, gm * 0.36, 0.0003);
    for (let k = 0; k < gn; k++) g[k] *= e[k];
    const amp = rng.range(gA, gB) * (o.shape ? o.shape(u) : 1);
    mixAt(out, g, amp, at, sr);
  }
  return out;
}

/** Resonant ticks at explicit times — ratchets, chains, ratcheting wheels, latches. */
function ticks(rng, sr, dur, times, o = {}) {
  const out = new Float32Array(nsamp(sr, dur));
  const [fA, fB] = o.f || [1100, 2600];
  for (let i = 0; i < times.length; i++) {
    const f = Math.exp(rng.range(Math.log(fA), Math.log(fB)));
    const d = o.decay !== undefined ? o.decay : 0.022;
    const t = modes(sr, d * 4, f, [[1, 1, d], [2.37, 0.5, d * 0.5], [4.11, 0.22, d * 0.3]]);
    const cl = whiteNoise(rng, Math.max(3, Math.round(0.002 * sr)));
    highpass1(cl, 3000, sr);
    for (let k = 0; k < cl.length; k++) cl[k] *= 1 - k / cl.length;
    mixInto(t, cl, o.click !== undefined ? o.click : 0.5);
    mixAt(out, t, (o.gain !== undefined ? o.gain : 1) * rng.range(0.7, 1), times[i], sr);
  }
  return out;
}

/**
 * Stick-slip: the physics of every creak in the game. Friction builds, releases, builds
 * again, at an irregular rate. Feeding that irregular pulse train through a sharp resonator
 * is what turns noise into "wood under load".
 */
function stickSlip(rng, sr, dur, o = {}) {
  const n = nsamp(sr, dur);
  const src = new Float32Array(n);
  const rateA = o.rate ? o.rate[0] : 40, rateB = o.rate ? o.rate[1] : 70;
  let next = 0, i = 0;
  while (i < n) {
    const rate = lerp(rateA, rateB, i / n) * rng.range(0.6, 1.5);
    const step = Math.max(2, Math.round(sr / rate));
    next = i + step;
    const amp = rng.range(0.4, 1);
    for (let k = 0; k < step && i + k < n; k++) src[i + k] = amp * (1 - k / step) * (k < 2 ? 1 : 0.25);
    i = next;
  }
  bandpass(src, o.res || 220, o.q || 9, sr);
  const env = o.env || adsr(n, sr, { a: dur * 0.18, d: dur * 0.3, s: 0.7, r: dur * 0.4, curve: 1.6 });
  for (let k = 0; k < n; k++) src[k] *= env[k];
  return src;
}

/** Amplitude tremolo in place. */
function tremolo(x, sr, hz, depth, phase = 0) {
  for (let i = 0; i < x.length; i++) {
    x[i] *= 1 - depth * 0.5 * (1 - Math.cos((i / sr) * TAU * hz + phase));
  }
  return x;
}

/** Apply an arbitrary amplitude shape fn(t in 0..1). */
function shape(x, fn) {
  const n = x.length;
  for (let i = 0; i < n; i++) x[i] *= fn(i / (n - 1));
  return x;
}

const hann = (t) => 0.5 - 0.5 * Math.cos(clamp01(t) * TAU);
/** Fast rise, slow fall — the amplitude signature of anything struck or thrown. */
const swell = (t, rise = 0.18, curve = 2) =>
  t < rise ? Math.pow(t / rise, 0.7) : Math.pow(1 - (t - rise) / (1 - rise), curve);

// ---------------------------------------------------------------------------
// Category defaults
// ---------------------------------------------------------------------------

const CAT = {
  combat: { prio: 100, gain: 0.85, ref: 5, maxDist: 55, reverb: 0.18, variants: 1 },
  movement: { prio: 50, gain: 0.42, ref: 3, maxDist: 26, reverb: 0.10, variants: 3 },
  world: { prio: 22, gain: 0.55, ref: 14, maxDist: 190, reverb: 0.34, variants: 1 },
  ship: { prio: 66, gain: 0.68, ref: 8, maxDist: 110, reverb: 0.24, variants: 1 },
  fruit: { prio: 95, gain: 0.9, ref: 7, maxDist: 90, reverb: 0.26, variants: 1 },
  ui: { prio: 92, gain: 0.5, ref: 0, maxDist: 0, reverb: 0.06, variants: 1, ui: true },
};

/** @type {Record<string, object>} */
export const SFX = {};

function def(name, cat, opts, render) {
  SFX[name] = Object.assign({ name, cat, loop: false }, CAT[cat], opts, { render });
}

// ===========================================================================
// COMBAT
// ===========================================================================

def('swing_light', 'combat', { gain: 0.55, prio: 88, variants: 3, maxDist: 34 }, (sr, rng) => {
  const x = noiseOf(rng, sr, 0.2, 'white');
  bandpassSweep(x, 900, 3100, 3.5, sr, 0.7);
  shape(x, (t) => swell(t, 0.16, 2.4));
  // a thin whistle riding the blade edge — sells "sharp" without adding brightness
  mixInto(x, glide(sr, 0.2, 2500, 1500, { amp: 0.11, tau: 0.05 }), 1);
  return fadeEdges(normalize(x, 0.85), sr);
});

def('swing_heavy', 'combat', { gain: 0.75, prio: 90, variants: 3, maxDist: 44 }, (sr, rng) => {
  const x = noiseOf(rng, sr, 0.4, 'brown');
  mixInto(x, noiseOf(rng, sr, 0.4, 'white'), 0.5);
  bandpassSweep(x, 210, 950, 2.2, sr, 0.8);
  shape(x, (t) => swell(t, 0.3, 1.8));
  mixInto(x, glide(sr, 0.4, 96, 52, { amp: 0.34, tau: 0.13, curve: 0.6 }), 1);
  saturate(x, 1.7);
  return fadeEdges(normalize(x, 0.92), sr);
});

def('swing_whoosh', 'combat', { gain: 0.5, prio: 80, variants: 2, maxDist: 38 }, (sr, rng) => {
  const x = noiseOf(rng, sr, 0.52, 'pink');
  // centre passes the listener: up then down, which is the doppler read, not a filter sweep
  bpPath(x, 4.5, sr, (t) => 500 + 2600 * Math.sin(Math.min(1, t * 1.05) * Math.PI));
  shape(x, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.4));
  return fadeEdges(normalize(x, 0.8), sr, 6, 20);
});

def('hit_flesh', 'combat', { gain: 0.95, variants: 3 }, (sr, rng) => {
  const x = percussiveHit(rng, sr, {
    dur: 0.3, click: 0.3, clickFreq: 1800, clickMs: 4,
    bodyFreq: 155, bodyEnd: 58, bodyDecay: 0.07, bodyGlide: 0.35,
    tail: 0.5, tailFreq: 430, tailEnd: 260, tailQ: 1.4, tailDecay: 0.055, drive: 2.2,
  });
  // a mid slap on top so it reads over music without needing more low end
  const slap = noiseOf(rng, sr, 0.08, 'white');
  bandpass(slap, 950, 2.2, sr);
  shape(slap, (t) => Math.pow(1 - t, 2.5));
  mixInto(x, slap, 0.45);
  return fadeEdges(normalize(x, 0.95), sr);
});

def('hit_armor', 'combat', { gain: 0.9, variants: 3 }, (sr, rng) => {
  const dur = 0.55;
  const x = modes(sr, dur, 385, [
    [1, 1, 0.10], [1.71, 0.72, 0.075], [2.43, 0.55, 0.05],
    [3.13, 0.38, 0.035], [4.29, 0.24, 0.022], [6.11, 0.14, 0.014],
  ]);
  const clank = noiseOf(rng, sr, 0.05, 'white');
  bandpass(clank, 3200, 2.5, sr);
  shape(clank, (t) => Math.pow(1 - t, 3));
  mixInto(x, clank, 0.55);
  mixInto(x, glide(sr, dur, 112, 84, { amp: 0.4, tau: 0.045 }), 1);
  saturate(x, 1.5);
  return fadeEdges(normalize(x, 0.95), sr);
});

def('hit_crit', 'combat', { gain: 1.0, prio: 110, variants: 2, reverb: 0.3 }, (sr, rng) => {
  const dur = 0.62;
  const x = percussiveHit(rng, sr, {
    dur, click: 0.55, clickFreq: 2600, bodyFreq: 195, bodyEnd: 62,
    bodyDecay: 0.09, tail: 0.35, tailFreq: 700, tailQ: 2, tailDecay: 0.08, drive: 2.6,
  });
  // the sting: two detuned partials climbing — a crit should sound like it *goes up*
  mixInto(x, glide(sr, dur, 1180, 1810, { amp: 0.3, tau: 0.16, curve: 0.8 }), 1);
  mixInto(x, glide(sr, dur, 1790, 2740, { amp: 0.2, tau: 0.13, curve: 0.8 }), 1);
  const splash = noiseOf(rng, sr, 0.2, 'white');
  bandpassSweep(splash, 3200, 6400, 2, sr);
  shape(splash, (t) => Math.pow(1 - t, 2));
  mixInto(x, splash, 0.4);
  return fadeEdges(normalize(x, 1), sr);
});

def('block', 'combat', { gain: 0.8, variants: 3 }, (sr, rng) => {
  const dur = 0.28;
  const x = modes(sr, dur, 244, [[1, 1, 0.055], [2.72, 0.6, 0.03], [5.15, 0.3, 0.014]]);
  const burst = noiseOf(rng, sr, 0.045, 'white');
  bandpass(burst, 1550, 6, sr);
  shape(burst, (t) => Math.pow(1 - t, 2.2));
  mixInto(x, burst, 0.7);
  mixInto(x, glide(sr, dur, 92, 70, { amp: 0.45, tau: 0.035 }), 1);
  saturate(x, 1.8);
  return fadeEdges(normalize(x, 0.9), sr);
});

def('parry', 'combat', { gain: 0.95, prio: 112, variants: 2, reverb: 0.42 }, (sr, rng) => {
  const dur = 1.25;
  // a struck bar, not a bell: partials wide apart and the fundamental barely present
  const x = bellTone(sr, 1565, dur, {
    ratios: [1, 1.51, 2.13, 2.87, 3.94, 5.62, 7.31],
    amps: [0.7, 1, 0.66, 0.45, 0.3, 0.2, 0.12],
    decay: 0.42, spread: 0.75, phase: true,
  });
  const spark = noiseOf(rng, sr, 0.06, 'white');
  highpass1(spark, 5200, sr);
  shape(spark, (t) => Math.pow(1 - t, 3));
  mixInto(x, spark, 0.5);
  mixInto(x, glide(sr, 0.09, 2100, 3300, { amp: 0.35, tau: 0.03, curve: 0.6 }), 1);
  return fadeEdges(normalize(x, 1), sr, 0.4, 40);
});

def('dodge_woosh', 'combat', { gain: 0.5, prio: 84, variants: 3, maxDist: 30 }, (sr, rng) => {
  const x = noiseOf(rng, sr, 0.42, 'pink');
  bpPath(x, 5.5, sr, (t) => 3900 * Math.pow(0.18, t));
  tremolo(x, sr, 17, 0.28);
  shape(x, (t) => swell(t, 0.22, 1.6));
  return fadeEdges(normalize(x, 0.78), sr, 5, 25);
});

def('guard_break', 'combat', { gain: 1.0, prio: 108, reverb: 0.3 }, (sr, rng) => {
  const dur = 0.9;
  const x = new Float32Array(nsamp(sr, dur));
  // five shards falling in pitch — the sound of a guard coming apart, not one impact
  for (let i = 0; i < 5; i++) {
    const f = 1900 * Math.pow(0.72, i);
    const p = modes(sr, 0.3, f, [[1, 1, 0.05], [2.31, 0.5, 0.03], [3.77, 0.25, 0.018]]);
    mixAt(x, p, 0.7 - i * 0.09, 0.012 + i * 0.048, sr);
  }
  const crack = noiseOf(rng, sr, 0.09, 'white');
  bandpassSweep(crack, 5000, 1400, 2, sr);
  shape(crack, (t) => Math.pow(1 - t, 2));
  mixInto(x, crack, 0.85);
  mixInto(x, glide(sr, dur, 78, 44, { amp: 0.6, tau: 0.24, curve: 0.5 }), 1);
  saturate(x, 2.2);
  return fadeEdges(normalize(x, 1), sr, 0.3, 30);
});

def('enemy_windup', 'combat', { gain: 0.7, prio: 104, maxDist: 40, reverb: 0.2 }, (sr, rng) => {
  const dur = 0.75;
  const n = nsamp(sr, dur);
  const x = glide(sr, dur, 88, 152, { wave: 'saw', curve: 1.6, env: ramp(n, 0.15, 1, 1.8) });
  lpPath(x, sr, (t) => 300 * Math.pow(7.3, t));
  const air = noiseOf(rng, sr, dur, 'pink');
  bandpassSweep(air, 400, 1500, 2.5, sr, 1.5);
  shape(air, (t) => Math.pow(t, 2.2) * 0.5);
  mixInto(x, air, 0.6);
  // the muscle "set" right before the swing: the last cue you get for free
  mixAt(x, ticks(rng, sr, 0.09, [0], { f: [520, 900], decay: 0.018, gain: 0.35 }), 1, dur - 0.1, sr);
  return fadeEdges(normalize(x, 0.8), sr, 8, 14);
});

def('enemy_windup_unblockable', 'combat', { gain: 0.85, prio: 118, maxDist: 46, reverb: 0.24 }, (sr, rng) => {
  const dur = 0.85;
  const n = nsamp(sr, dur);
  const env = ramp(n, 0.2, 1, 2.2);
  // two squares a quarter-tone apart beat against each other; ring modulation adds the
  // metallic buzz that says "this one cannot be blocked" before any UI does
  const a = glide(sr, dur, 147, 262, { wave: 'square', duty: 0.42, curve: 1.5, env });
  const b = glide(sr, dur, 152, 271, { wave: 'square', duty: 0.31, curve: 1.5, env });
  const x = new Float32Array(n);
  const ring = makeOsc('sine', sr);
  for (let i = 0; i < n; i++) {
    const r = 0.45 + 0.55 * ring(31);
    x[i] = (a[i] * 0.6 + b[i] * 0.6) * r;
  }
  lpPath(x, sr, (t) => 700 * Math.pow(5.2, t));
  saturate(x, 3.4);
  const growl = noiseOf(rng, sr, dur, 'brown');
  bandpassSweep(growl, 260, 620, 4, sr);
  tremolo(growl, sr, 23, 0.6);
  shape(growl, (t) => Math.pow(t, 1.6) * 0.8);
  mixInto(x, growl, 0.7);
  const screech = glide(sr, dur, 1900, 3400, { amp: 0.16, curve: 2.4, env });
  mixInto(x, screech, 1);
  return fadeEdges(normalize(dcBlock(x, sr), 0.95), sr, 8, 14);
});

def('death_enemy', 'combat', { gain: 0.9, reverb: 0.3 }, (sr, rng) => {
  const dur = 0.95;
  const x = glide(sr, dur, 235, 68, { wave: 'saw', curve: 0.7, tau: 0.3, amp: 0.7 });
  bpPath(x, 3, sr, (t) => lerp(900, 220, Math.pow(t, 0.7)));
  const poof = noiseOf(rng, sr, dur, 'pink');
  bandpassSweep(poof, 2200, 500, 1.6, sr, 0.6);
  shape(poof, (t) => Math.pow(1 - t, 2.2));
  mixInto(x, poof, 0.55);
  mixAt(x, percussiveHit(rng, sr, {
    dur: 0.35, click: 0.2, bodyFreq: 120, bodyEnd: 48, bodyDecay: 0.09, tail: 0.2, tailFreq: 350,
  }), 0.8, 0.5, sr);
  return fadeEdges(normalize(x, 0.92), sr, 2, 40);
});

def('death_player', 'combat', { gain: 1.0, prio: 125, ui: true, reverb: 0.5 }, (sr, rng) => {
  const dur = 2.1;
  const x = new Float32Array(nsamp(sr, dur));
  // two heartbeats, then the world goes under water and stops
  for (let i = 0; i < 2; i++) {
    mixAt(x, percussiveHit(rng, sr, {
      dur: 0.4, click: 0.1, bodyFreq: 92, bodyEnd: 46, bodyDecay: 0.11, tail: 0.15, tailFreq: 180,
    }), 0.85 - i * 0.25, 0.02 + i * 0.42, sr);
  }
  mixInto(x, glide(sr, dur, 74, 36, { curve: 0.8, tau: 0.85, amp: 0.55, attack: 0.02 }), 1);
  const wash = noiseOf(rng, sr, dur, 'brown');
  bandpassSweep(wash, 900, 120, 1.4, sr, 0.7);
  shape(wash, (t) => Math.pow(1 - t, 1.4) * 0.7);
  mixInto(x, wash, 0.6);
  lpPath(x, sr, (t) => 2000 * Math.pow(0.09, t));
  return fadeEdges(normalize(x, 0.95), sr, 3, 120);
});

def('level_up', 'combat', { gain: 0.75, prio: 120, ui: true, reverb: 0.4 }, (sr, rng) => {
  const dur = 1.6;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [62, 65, 69, 74, 77]; // D minor triad climbing two octaves
  for (let i = 0; i < notes.length; i++) {
    const b = bellTone(sr, midiHz(notes[i] + 12), 1.0, { decay: 0.3, phase: true });
    mixAt(x, b, 0.55 - i * 0.04, 0.03 + i * 0.075, sr);
  }
  // a swelling saw bed underneath so the arpeggio lands on something, not on silence
  const pad = new Float32Array(x.length);
  for (const m of [50, 57, 62]) {
    const o1 = makeOsc('saw', sr), o2 = makeOsc('saw', sr, 0.33);
    const f = midiHz(m);
    for (let i = 0; i < pad.length; i++) pad[i] += (o1(f) + o2(f * 1.006)) * 0.16;
  }
  lowpassSweep(pad, 500, 2600, sr);
  shape(pad, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.6) * 0.55);
  mixInto(x, pad, 1);
  return fadeEdges(normalize(x, 0.9), sr, 4, 90);
});

// ===========================================================================
// MOVEMENT
// ===========================================================================

def('step_sand', 'movement', { gain: 0.34 }, (sr, rng) => {
  const x = grains(rng, sr, 0.16, {
    count: 11, ms: [4, 16], f: [700, 4600], q: 3.5, gain: [0.3, 1],
    at: (u, r) => r.range(0, 0.055), shape: (u) => 1 - u * 0.5,
  });
  lowpass1(x, 5200, sr);
  mixInto(x, glide(sr, 0.16, 96, 62, { amp: 0.22, tau: 0.028 }), 1);
  return fadeEdges(normalize(x, 0.7), sr, 0.5, 12);
});

def('step_grass', 'movement', { gain: 0.3 }, (sr, rng) => {
  const x = noiseOf(rng, sr, 0.14, 'white');
  bandpassSweep(x, 1300, 3100, 2.2, sr, 0.6);
  shape(x, (t) => Math.pow(1 - t, 2.6) * (t < 0.06 ? t / 0.06 : 1));
  mixInto(x, grains(rng, sr, 0.14, { count: 5, ms: [3, 9], f: [3000, 6500], q: 6, gain: [0.15, 0.5] }), 1);
  mixInto(x, glide(sr, 0.14, 88, 60, { amp: 0.14, tau: 0.022 }), 1);
  return fadeEdges(normalize(x, 0.66), sr, 0.5, 12);
});

def('step_wood', 'movement', { gain: 0.38 }, (sr, rng) => {
  const dur = 0.22;
  const x = modes(sr, dur, 192, [[1, 1, 0.05], [2.24, 0.5, 0.028], [4.71, 0.25, 0.012], [7.9, 0.1, 0.007]]);
  const cl = noiseOf(rng, sr, 0.03, 'white');
  bandpass(cl, 2400, 3, sr);
  shape(cl, (t) => Math.pow(1 - t, 2.5));
  mixInto(x, cl, 0.5);
  return fadeEdges(normalize(x, 0.72), sr, 0.4, 10);
});

def('step_stone', 'movement', { gain: 0.36 }, (sr, rng) => {
  const dur = 0.17;
  const x = modes(sr, dur, 735, [[1, 0.6, 0.018], [1.93, 0.4, 0.011], [3.61, 0.2, 0.007]]);
  const cl = noiseOf(rng, sr, 0.025, 'white');
  bandpass(cl, 2900, 4.5, sr);
  shape(cl, (t) => Math.pow(1 - t, 3));
  mixInto(x, cl, 0.9);
  mixInto(x, glide(sr, dur, 130, 100, { amp: 0.2, tau: 0.02 }), 1);
  return fadeEdges(normalize(x, 0.72), sr, 0.4, 10);
});

def('step_snow', 'movement', { gain: 0.28 }, (sr, rng) => {
  const x = grains(rng, sr, 0.2, {
    count: 16, ms: [2.5, 8], f: [3800, 9500], q: 7, gain: [0.2, 0.8],
    at: (u, r) => r.range(0, 0.07), shape: (u) => 1 - u * 0.6,
  });
  // the low "compression" under the squeak is what makes snow read as deep
  mixInto(x, glide(sr, 0.2, 74, 52, { amp: 0.3, tau: 0.045, attack: 0.006 }), 1);
  lowpass1(x, 11000, sr);
  return fadeEdges(normalize(x, 0.6), sr, 1, 16);
});

def('jump', 'movement', { gain: 0.45, variants: 2, prio: 58 }, (sr, rng) => {
  const dur = 0.28;
  const cloth = noiseOf(rng, sr, dur, 'pink');
  bandpassSweep(cloth, 900, 2600, 2, sr, 0.6);
  shape(cloth, (t) => Math.pow(1 - t, 2) * (t < 0.05 ? t / 0.05 : 1));
  const x = cloth;
  mixInto(x, glide(sr, dur, 118, 196, { amp: 0.28, curve: 0.7, tau: 0.07 }), 1);
  mixInto(x, percussiveHit(rng, sr, { dur: 0.12, click: 0.35, bodyFreq: 150, bodyEnd: 95, bodyDecay: 0.03, tail: 0.15, tailFreq: 800 }), 0.5);
  return fadeEdges(normalize(x, 0.7), sr, 1, 14);
});

def('land_soft', 'movement', { gain: 0.5, variants: 2, prio: 60 }, (sr, rng) => {
  const x = percussiveHit(rng, sr, {
    dur: 0.28, click: 0.18, clickFreq: 1600, bodyFreq: 132, bodyEnd: 72,
    bodyDecay: 0.06, tail: 0.35, tailFreq: 520, tailQ: 2, tailDecay: 0.05,
  });
  return fadeEdges(normalize(x, 0.75), sr);
});

def('land_hard', 'movement', { gain: 0.8, variants: 2, prio: 72, maxDist: 40 }, (sr, rng) => {
  const dur = 0.52;
  const x = percussiveHit(rng, sr, {
    dur, click: 0.65, clickFreq: 3200, bodyFreq: 98, bodyEnd: 41,
    bodyDecay: 0.1, bodyGlide: 0.35, tail: 0.5, tailFreq: 720, tailEnd: 300,
    tailQ: 1.6, tailDecay: 0.11, drive: 2.6,
  });
  mixInto(x, grains(rng, sr, dur, { count: 8, ms: [3, 12], f: [1200, 5000], q: 5, gain: [0.1, 0.35], at: (u, r) => r.range(0.01, 0.2) }), 1);
  return fadeEdges(normalize(x, 0.95), sr);
});

def('swim_stroke', 'movement', { gain: 0.5, variants: 3, prio: 56 }, (sr, rng) => {
  const dur = 0.55;
  const x = noiseOf(rng, sr, dur, 'brown');
  mixInto(x, noiseOf(rng, sr, dur, 'white'), 0.35);
  bpPath(x, 2.6, sr, (t) => 300 + 1100 * Math.sin(clamp01(t) * Math.PI));
  tremolo(x, sr, 9, 0.4, rng.f() * TAU);
  shape(x, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.2));
  for (let i = 0; i < 3; i++) {
    mixAt(x, glide(sr, 0.09, rng.range(280, 420), rng.range(600, 900), { amp: 0.12, tau: 0.02, curve: 0.6 }),
      1, rng.range(0.05, 0.4), sr);
  }
  return fadeEdges(normalize(x, 0.7), sr, 6, 30);
});

def('water_enter', 'movement', { gain: 0.85, prio: 74, maxDist: 45, reverb: 0.2 }, (sr, rng) => {
  const dur = 0.75;
  const x = noiseOf(rng, sr, dur, 'white');
  bpPath(x, 1.8, sr, (t) => (t < 0.12 ? lerp(500, 6200, t / 0.12) : 6200 * Math.pow(0.19, (t - 0.12) / 0.88)));
  shape(x, (t) => swell(t, 0.05, 2.4));
  mixInto(x, glide(sr, dur, 165, 68, { amp: 0.45, tau: 0.09, curve: 0.4 }), 1);
  // bubbles rising away underneath, each a short chirp
  for (let i = 0; i < 5; i++) {
    const f = rng.range(320, 760);
    mixAt(x, glide(sr, 0.07, f, f * 0.55, { amp: 0.14, tau: 0.018 }), 1, rng.range(0.1, 0.55), sr);
  }
  return fadeEdges(normalize(x, 0.95), sr, 0.6, 40);
});

def('water_exit', 'movement', { gain: 0.6, prio: 68, maxDist: 35, reverb: 0.2 }, (sr, rng) => {
  const dur = 0.8;
  const x = noiseOf(rng, sr, dur, 'white');
  bpPath(x, 2.2, sr, (t) => lerp(600, 3200, Math.pow(t, 0.6)));
  shape(x, (t) => (t < 0.4 ? Math.pow(t / 0.4, 1.4) : Math.pow(1 - (t - 0.4) / 0.6, 2.4)));
  for (let i = 0; i < 3; i++) {
    const f = [1750, 2350, 1420][i];
    mixAt(x, bellTone(sr, f, 0.3, { ratios: [1, 2.4, 4.1], amps: [1, 0.4, 0.15], decay: 0.06 }),
      0.2, 0.42 + i * 0.11, sr);
  }
  return fadeEdges(normalize(x, 0.75), sr, 6, 40);
});

def('climb', 'movement', { gain: 0.42, variants: 3, prio: 54 }, (sr, rng) => {
  const dur = 0.4;
  const x = stickSlip(rng, sr, dur, { rate: [22, 34], res: 1400, q: 6 });
  const hiss = noiseOf(rng, sr, dur, 'white');
  bandpass(hiss, 2600, 2, sr);
  shape(hiss, (t) => hann(t) * 0.4);
  mixInto(x, hiss, 0.5);
  return fadeEdges(normalize(x, 0.6), sr, 6, 25);
});

// ===========================================================================
// WORLD
// ===========================================================================

/** Stereo bed helper: renders the same recipe twice from one Rng so channels decorrelate. */
function stereoBed(sr, rng, dur, xfade, make) {
  return [loopify(make(rng, sr, dur), sr, xfade), loopify(make(rng, sr, dur), sr, xfade)];
}

def('wave_lap', 'world', { gain: 0.5, loop: true, ref: 6, maxDist: 90, variants: 1 }, (sr, rng) =>
  stereoBed(sr, rng, 3.2, 0.5, (r, s, dur) => {
    const x = noiseOf(r, s, dur, 'pink');
    bpPath(x, 1.4, s, (t) => 320 + 520 * (0.5 + 0.5 * Math.sin(t * TAU * 1.5)));
    shape(x, (t) => 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * TAU * 1.5 - 1.2), 1.8));
    return normalize(x, 0.6);
  }));

def('wave_crash', 'world', { gain: 0.7, prio: 30, ref: 10, maxDist: 150 }, (sr, rng) => {
  const dur = 2.1;
  const x = noiseOf(rng, sr, dur, 'white');
  bpPath(x, 1.2, sr, (t) => (t < 0.15 ? lerp(600, 5200, t / 0.15) : 5200 * Math.pow(0.15, (t - 0.15) / 0.85)));
  shape(x, (t) => swell(t, 0.12, 1.7));
  const rumble = noiseOf(rng, sr, dur, 'brown');
  lowpass1(rumble, 220, sr);
  shape(rumble, (t) => swell(t, 0.2, 1.3) * 0.8);
  mixInto(x, rumble, 0.9);
  return fadeEdges(normalize(x, 0.85), sr, 8, 120);
});

def('wind_light', 'world', { gain: 0.4, loop: true, ui: true, prio: 18 }, (sr, rng) =>
  stereoBed(sr, rng, 4.2, 0.7, (r, s, dur) => {
    const x = noiseOf(r, s, dur, 'pink');
    const p1 = r.f() * TAU, p2 = r.f() * TAU;
    bpPath(x, 2.2, s, (t) => 240 + 520 * (0.5 + 0.5 * Math.sin(t * TAU * 0.7 + p1))
      + 180 * Math.sin(t * TAU * 1.9 + p2));
    shape(x, (t) => 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * TAU * 0.5 + p1)));
    return normalize(x, 0.55);
  }));

def('wind_strong', 'world', { gain: 0.6, loop: true, ui: true, prio: 18 }, (sr, rng) =>
  stereoBed(sr, rng, 4.2, 0.7, (r, s, dur) => {
    const x = noiseOf(r, s, dur, 'pink');
    const p1 = r.f() * TAU;
    bpPath(x, 1.6, s, (t) => 340 + 1500 * (0.5 + 0.5 * Math.sin(t * TAU * 1.3 + p1)));
    // a resonant howl through rigging: one narrow band, moving slowly
    const howl = noiseOf(r, s, dur, 'white');
    bpPath(howl, 15, s, (t) => 460 + 190 * Math.sin(t * TAU * 0.45 + p1 * 0.5));
    shape(howl, (t) => 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(t * TAU * 0.6), 2));
    mixInto(x, howl, 0.5);
    shape(x, (t) => 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * TAU * 0.9 + 1)));
    return normalize(x, 0.7);
  }));

def('rain', 'world', { gain: 0.55, loop: true, ui: true, prio: 18 }, (sr, rng) =>
  stereoBed(sr, rng, 3.4, 0.6, (r, s, dur) => {
    const x = noiseOf(r, s, dur, 'white');
    highpass1(x, 1600, s);
    bandpass(x, 4200, 0.9, s);
    scaleArr(x, 0.55);
    mixInto(x, grains(r, s, dur, { count: 170, ms: [1.5, 5], f: [2500, 9000], q: 9, gain: [0.05, 0.35] }), 1);
    return normalize(x, 0.7);
  }));

def('thunder_near', 'world', { gain: 1.0, prio: 45, ui: true, reverb: 0.5 }, (sr, rng) => {
  const dur = 3.5;
  const x = new Float32Array(nsamp(sr, dur));
  const crack = noiseOf(rng, sr, 0.35, 'white');
  bpPath(crack, 1.1, sr, (t) => (t < 0.02 ? 7000 : lerp(6000, 500, Math.pow(t, 0.5))));
  shape(crack, (t) => Math.pow(1 - t, 2.6));
  saturate(crack, 3);
  mixInto(x, crack, 1);
  const roll = noiseOf(rng, sr, dur, 'brown');
  lowpass1(roll, 260, sr);
  // the roll is not a smooth decay: it lurches, because the sound arrives off many surfaces
  const w1 = rng.f() * TAU, w2 = rng.f() * TAU;
  shape(roll, (t) => Math.pow(1 - t, 1.5)
    * (0.5 + 0.3 * Math.sin(t * TAU * 1.7 + w1) + 0.2 * Math.sin(t * TAU * 4.3 + w2)));
  mixInto(x, roll, 1.4);
  return fadeEdges(normalize(dcBlock(x, sr), 1), sr, 0.3, 200);
});

def('thunder_far', 'world', { gain: 0.7, prio: 30, ui: true, reverb: 0.55 }, (sr, rng) => {
  const dur = 4.2;
  const x = noiseOf(rng, sr, dur, 'brown');
  lowpass1(x, 130, sr);
  lowpass1(x, 190, sr);
  const w = rng.f() * TAU;
  shape(x, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.1)
    * (0.6 + 0.4 * Math.sin(t * TAU * 1.1 + w)) * (t < 0.2 ? Math.pow(t / 0.2, 1.5) : 1));
  return fadeEdges(normalize(dcBlock(x, sr), 0.75), sr, 30, 300);
});

def('gull', 'world', { gain: 0.45, prio: 26, ref: 20, maxDist: 220 }, (sr, rng) => {
  const dur = 0.95;
  const x = new Float32Array(nsamp(sr, dur));
  const cries = 2 + (rng.u32() % 2);
  let at = 0.02;
  for (let c = 0; c < cries; c++) {
    const len = rng.range(0.13, 0.2);
    const n = nsamp(sr, len);
    const cry = new Float32Array(n);
    const osc = makeOsc('saw', sr);
    const base = rng.range(900, 1250);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // pitch arcs up then falls away — a flat cry sounds like a toy
      const f = base * (1 + 0.55 * Math.sin(t * Math.PI) - 0.25 * t);
      cry[i] = osc(f) * Math.pow(Math.sin(clamp01(t) * Math.PI), 0.8);
    }
    bandpass(cry, 2100, 2.4, sr);
    mixAt(x, cry, 0.9 - c * 0.18, at, sr);
    at += len + rng.range(0.07, 0.16);
  }
  return fadeEdges(normalize(x, 0.6), sr, 3, 30);
});

def('jungle_ambience', 'world', { gain: 0.45, loop: true, ui: true, prio: 16 }, (sr, rng) =>
  stereoBed(sr, rng, 6.5, 0.9, (r, s, dur) => {
    const n = nsamp(s, dur);
    const x = new Float32Array(n);
    // leaf bed
    const leaves = pinkNoise(r, n);
    bandpass(leaves, 2400, 1.1, s);
    tremolo(leaves, s, 0.31, 0.5, r.f() * TAU);
    mixInto(x, leaves, 0.35);
    // two cricket layers at different rates; the beat between them is the "alive" cue
    for (let layer = 0; layer < 2; layer++) {
      const rate = layer === 0 ? 11 : 7.3;
      const carrier = layer === 0 ? 4600 : 6100;
      const osc = makeOsc('sine', s);
      const g = makeOsc('square', s, r.f());
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const gate = g(rate, 0.22) > 0 ? 1 : 0;
        buf[i] = osc(carrier + Math.sin(i / s * TAU * 33) * 220) * gate;
      }
      bandpass(buf, carrier, 6, s);
      tremolo(buf, s, 0.23 + layer * 0.11, 0.7, r.f() * TAU);
      mixInto(x, buf, layer === 0 ? 0.16 : 0.11);
    }
    // a few birds, sparse enough that the loop point never lands on one
    for (let b = 0; b < 4; b++) {
      const at = r.range(0.2, dur - 0.9);
      const len = r.range(0.06, 0.12);
      const bn = nsamp(s, len);
      const chirp = new Float32Array(bn);
      const osc = makeOsc('sine', s);
      const f0 = r.range(1800, 3200);
      for (let i = 0; i < bn; i++) {
        const t = i / (bn - 1);
        chirp[i] = osc(f0 * (1 + 0.7 * t)) * Math.pow(Math.sin(clamp01(t) * Math.PI), 1.4);
      }
      mixAt(x, chirp, r.range(0.12, 0.3), at, s);
    }
    return normalize(x, 0.6);
  }));

def('cave_drip', 'world', { gain: 0.5, prio: 28, ref: 4, maxDist: 40, reverb: 0.7 }, (sr, rng) => {
  const dur = 0.6;
  const n = nsamp(sr, dur);
  const x = new Float32Array(n);
  // the signature of a drip is the pitch bending UP as the cavity closes behind it
  const osc = makeOsc('sine', sr);
  const f0 = rng.range(900, 1500);
  const env = expEnv(n, sr, 0.09, 0.0008);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    x[i] = osc(f0 * (1 + 1.6 * Math.pow(t, 0.35))) * env[i];
  }
  const plip = noiseOf(rng, sr, 0.012, 'white');
  highpass1(plip, 3000, sr);
  shape(plip, (t) => Math.pow(1 - t, 2));
  mixInto(x, plip, 0.35);
  return fadeEdges(normalize(x, 0.65), sr, 0.4, 30);
});

def('fire_crackle', 'world', { gain: 0.5, loop: true, ref: 3, maxDist: 26, prio: 20 }, (sr, rng) =>
  stereoBed(sr, rng, 4.5, 0.6, (r, s, dur) => {
    const n = nsamp(s, dur);
    const roar = brownNoise(r, n);
    lowpass1(roar, 420, s);
    tremolo(roar, s, 1.7, 0.35, r.f() * TAU);
    tremolo(roar, s, 0.43, 0.4, r.f() * TAU);
    scaleArr(roar, 0.8);
    mixInto(roar, grains(r, s, dur, { count: 46, ms: [1.5, 7], f: [1400, 6500], q: 8, gain: [0.1, 0.7] }), 1);
    return normalize(roar, 0.65);
  }));

def('lava_bubble', 'world', { gain: 0.55, prio: 24, ref: 4, maxDist: 45 }, (sr, rng) => {
  const dur = 1.7;
  const x = noiseOf(rng, sr, dur, 'brown');
  lowpass1(x, 180, sr);
  scaleArr(x, 0.5);
  const viscous = noiseOf(rng, sr, dur, 'white');
  bandpass(viscous, 420, 2, sr);
  tremolo(viscous, sr, 3.1, 0.7);
  mixInto(x, viscous, 0.2);
  // glugs: pitch rises as the bubble grows, then it pops
  for (let i = 0; i < 4; i++) {
    const at = rng.range(0.05, dur - 0.4);
    const g = glide(sr, 0.3, rng.range(55, 80), rng.range(150, 210), { curve: 1.4, tau: 0.11, amp: 0.7 });
    mixAt(x, g, rng.range(0.5, 1), at, sr);
    const pop = noiseOf(rng, sr, 0.05, 'white');
    bandpass(pop, rng.range(700, 1600), 4, sr);
    shape(pop, (t) => Math.pow(1 - t, 3));
    mixAt(x, pop, 0.3, at + 0.26, sr);
  }
  return fadeEdges(normalize(x, 0.7), sr, 20, 90);
});

// ===========================================================================
// SHIP
// ===========================================================================

def('sail_flap', 'ship', { gain: 0.6, variants: 2, ref: 6, maxDist: 60 }, (sr, rng) => {
  const dur = 0.95;
  const x = new Float32Array(nsamp(sr, dur));
  let at = 0.01;
  for (let i = 0; i < 3; i++) {
    const len = rng.range(0.1, 0.16);
    const f = noiseOf(rng, sr, len, 'pink');
    bandpassSweep(f, rng.range(420, 620), rng.range(900, 1400), 2.2, sr, 0.7);
    shape(f, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 0.7));
    mixAt(x, f, 0.9 - i * 0.12, at, sr);
    mixAt(x, glide(sr, 0.12, 96, 62, { amp: 0.2, tau: 0.03 }), 1, at, sr);
    at += len + rng.range(0.1, 0.19);
  }
  return fadeEdges(normalize(x, 0.75), sr, 4, 40);
});

def('sail_raise', 'ship', { gain: 0.6, ref: 5, maxDist: 55 }, (sr, rng) => {
  const dur = 1.8;
  const times = [];
  let t = 0.02, gap = 0.14;
  while (t < 1.5) { times.push(t); gap = Math.max(0.055, gap * 0.93); t += gap; }
  const x = ticks(rng, sr, dur, times, { f: [900, 1900], decay: 0.014, gain: 0.55, click: 0.7 });
  mixInto(x, stickSlip(rng, sr, dur, { rate: [45, 90], res: 640, q: 8 }), 0.55);
  const cloth = noiseOf(rng, sr, dur, 'pink');
  bandpassSweep(cloth, 700, 1800, 1.8, sr);
  shape(cloth, (t2) => Math.pow(Math.sin(clamp01(t2) * Math.PI), 1.2) * 0.5);
  mixInto(x, cloth, 0.5);
  return fadeEdges(normalize(x, 0.8), sr, 4, 60);
});

def('sail_drop', 'ship', { gain: 0.65, ref: 5, maxDist: 55 }, (sr, rng) => {
  const dur = 1.15;
  const x = noiseOf(rng, sr, dur, 'pink');
  bpPath(x, 2, sr, (t) => 2700 * Math.pow(0.22, t));
  shape(x, (t) => swell(t, 0.1, 1.3));
  mixAt(x, percussiveHit(rng, sr, { dur: 0.4, click: 0.2, bodyFreq: 105, bodyEnd: 55, bodyDecay: 0.1, tail: 0.35, tailFreq: 400, tailQ: 1.6 }), 0.7, 0.62, sr);
  for (let i = 0; i < 2; i++) {
    const f = noiseOf(rng, sr, 0.13, 'pink');
    bandpass(f, rng.range(500, 800), 2.2, sr);
    shape(f, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 0.8));
    mixAt(x, f, 0.4, 0.72 + i * 0.19, sr);
  }
  return fadeEdges(normalize(x, 0.8), sr, 6, 60);
});

def('hull_creak', 'ship', { gain: 0.5, variants: 2, ref: 4, maxDist: 40, reverb: 0.15 }, (sr, rng) => {
  const dur = 2.0;
  const x = stickSlip(rng, sr, dur, { rate: [16, 26], res: 168, q: 11 });
  const upper = stickSlip(rng, sr, dur, { rate: [33, 47], res: 520, q: 8 });
  mixInto(x, upper, 0.35);
  // a slow low groan under the ticks: the timber itself, not the joint
  const groan = glide(sr, dur, 62, 54, { wave: 'triangle', curve: 1, tau: 5, vib: 0.05, vibHz: 0.7, amp: 0.4 });
  shape(groan, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.5));
  mixInto(x, groan, 1);
  return fadeEdges(normalize(x, 0.62), sr, 25, 90);
});

def('rope_creak', 'ship', { gain: 0.42, variants: 2, ref: 3, maxDist: 26 }, (sr, rng) => {
  const dur = 0.95;
  const x = stickSlip(rng, sr, dur, { rate: [48, 72], res: 940, q: 13 });
  const air = noiseOf(rng, sr, dur, 'white');
  bandpass(air, 2200, 3, sr);
  shape(air, (t) => hann(t) * 0.25);
  mixInto(x, air, 0.4);
  return fadeEdges(normalize(x, 0.55), sr, 12, 60);
});

def('anchor_drop', 'ship', { gain: 0.85, ref: 7, maxDist: 80, reverb: 0.28 }, (sr, rng) => {
  const dur = 1.9;
  const times = [];
  for (let i = 0; i < 18; i++) times.push(rng.range(0.0, 1.0));
  times.sort((a, b) => a - b);
  const x = ticks(rng, sr, dur, times, { f: [1400, 3600], decay: 0.03, gain: 0.55, click: 0.6 });
  shape(x, (t) => 1 - 0.35 * clamp01(t * 2));
  const splash = SFX.water_enter.render(sr, rng.fork('anchor_splash'));
  mixAt(x, splash, 0.9, 1.05, sr);
  const sink = noiseOf(rng, sr, 0.7, 'brown');
  lowpass1(sink, 300, sr);
  shape(sink, (t) => Math.pow(1 - t, 1.6));
  mixAt(x, sink, 0.6, 1.15, sr);
  return fadeEdges(normalize(x, 0.9), sr, 3, 80);
});

def('dock_bump', 'ship', { gain: 0.8, variants: 2, ref: 5, maxDist: 50 }, (sr, rng) => {
  const dur = 0.75;
  const x = modes(sr, dur, 68, [[1, 1, 0.13], [1.94, 0.5, 0.08], [3.4, 0.22, 0.04]]);
  mixInto(x, modes(sr, dur, 235, [[1, 0.4, 0.06], [2.2, 0.2, 0.03]]), 1);
  const thud = percussiveHit(rng, sr, { dur: 0.3, click: 0.4, clickFreq: 1200, bodyFreq: 88, bodyEnd: 52, bodyDecay: 0.08, tail: 0.3, tailFreq: 340, tailQ: 1.8 });
  mixInto(x, thud, 0.9);
  mixAt(x, stickSlip(rng, sr, 0.4, { rate: [20, 32], res: 300, q: 9 }), 0.35, 0.2, sr);
  saturate(x, 1.6);
  return fadeEdges(normalize(x, 0.9), sr, 1, 50);
});

def('cannon_fire', 'ship', { gain: 1.0, prio: 115, ref: 20, maxDist: 400, reverb: 0.45 }, (sr, rng) => {
  const dur = 2.0;
  const x = new Float32Array(nsamp(sr, dur));
  const crack = noiseOf(rng, sr, 0.06, 'white');
  highpass1(crack, 2200, sr);
  shape(crack, (t) => Math.pow(1 - t, 2.5));
  mixInto(x, crack, 0.7);
  const boom = noiseOf(rng, sr, 0.9, 'white');
  lpPath(boom, sr, (t) => 4200 * Math.pow(0.022, Math.pow(t, 0.45)));
  shape(boom, (t) => swell(t, 0.012, 2.2));
  mixInto(x, boom, 2.2);
  mixInto(x, glide(sr, dur, 68, 26, { curve: 0.35, tau: 0.3, amp: 0.9, attack: 0.001 }), 1);
  const tail = noiseOf(rng, sr, dur, 'brown');
  lowpass1(tail, 150, sr);
  const w = rng.f() * TAU;
  shape(tail, (t) => Math.pow(1 - t, 1.8) * (0.6 + 0.4 * Math.sin(t * TAU * 2.3 + w)));
  mixInto(x, tail, 1.1);
  saturate(x, 3);
  return fadeEdges(normalize(dcBlock(x, sr), 1), sr, 0.2, 150);
});

def('cannon_impact', 'ship', { gain: 0.95, prio: 108, ref: 12, maxDist: 260, reverb: 0.4 }, (sr, rng) => {
  const dur = 1.35;
  const x = percussiveHit(rng, sr, {
    dur, click: 0.8, clickFreq: 2800, bodyFreq: 82, bodyEnd: 34,
    bodyDecay: 0.22, tail: 0.5, tailFreq: 520, tailEnd: 200, tailQ: 1.3, tailDecay: 0.3, drive: 2.8,
  });
  // splinters: hard, dry, and spread over a quarter second
  mixInto(x, grains(rng, sr, dur, {
    count: 14, ms: [3, 14], f: [900, 4200], q: 6, gain: [0.15, 0.6],
    at: (u, r) => r.range(0.005, 0.26),
  }), 1);
  mixInto(x, modes(sr, dur, 190, [[1, 0.35, 0.09], [2.31, 0.2, 0.05], [4.7, 0.1, 0.025]]), 1);
  return fadeEdges(normalize(x, 1), sr, 0.3, 90);
});

def('ship_wheel', 'ship', { gain: 0.5, variants: 2, ref: 3, maxDist: 22 }, (sr, rng) => {
  const dur = 0.85;
  const times = [];
  let t = 0.01, gap = 0.075;
  for (let i = 0; i < 6; i++) { times.push(t); t += gap; gap *= 1.22; }
  const x = ticks(rng, sr, dur, times, { f: [700, 1500], decay: 0.02, gain: 0.6, click: 0.4 });
  mixInto(x, stickSlip(rng, sr, dur, { rate: [30, 22], res: 420, q: 7 }), 0.3);
  return fadeEdges(normalize(x, 0.6), sr, 3, 40);
});

// ===========================================================================
// DEVIL FRUIT
// ===========================================================================

def('gomu_stretch', 'fruit', { gain: 0.8 }, (sr, rng) => {
  const dur = 0.6;
  const n = nsamp(sr, dur);
  // rubber = a pitch that climbs and *keeps* climbing, with the wobble of stored tension
  const x = glide(sr, dur, 175, 540, {
    wave: 'triangle', curve: 1.5, vib: 0.045, vibHz: 7.5,
    env: shape(ramp(n, 0.3, 1, 1.4), (t) => (t > 0.9 ? (1 - t) / 0.1 : 1)),
  });
  bpPath(x, 6, sr, (t) => lerp(400, 1500, Math.pow(t, 1.4)));
  const creak = stickSlip(rng, sr, dur, { rate: [70, 130], res: 1300, q: 7 });
  mixInto(x, creak, 0.32);
  return fadeEdges(normalize(x, 0.85), sr, 5, 25);
});

def('gomu_snap', 'fruit', { gain: 0.95, prio: 100 }, (sr, rng) => {
  const dur = 0.34;
  const x = glide(sr, dur, 760, 150, { wave: 'triangle', curve: 0.28, tau: 0.06, amp: 0.9 });
  const slap = noiseOf(rng, sr, 0.09, 'white');
  bandpass(slap, 1750, 2.5, sr);
  shape(slap, (t) => Math.pow(1 - t, 2.4));
  mixInto(x, slap, 0.75);
  mixInto(x, glide(sr, dur, 120, 62, { amp: 0.35, tau: 0.05 }), 1);
  saturate(x, 2.2);
  return fadeEdges(normalize(x, 0.95), sr);
});

def('mera_ignite', 'fruit', { gain: 0.9, reverb: 0.3 }, (sr, rng) => {
  const dur = 0.85;
  const x = noiseOf(rng, sr, dur, 'pink');
  bpPath(x, 1.5, sr, (t) => (t < 0.14 ? lerp(220, 3000, t / 0.14) : 3000 * Math.pow(0.18, (t - 0.14) / 0.86)));
  shape(x, (t) => swell(t, 0.09, 1.6));
  mixInto(x, glide(sr, dur, 78, 40, { amp: 0.5, tau: 0.11, curve: 0.5 }), 1);
  mixInto(x, grains(rng, sr, dur, { count: 22, ms: [2, 9], f: [1600, 7000], q: 8, gain: [0.08, 0.4], at: (u, r) => r.range(0.02, 0.6) }), 1);
  saturate(x, 1.8);
  return fadeEdges(normalize(x, 0.95), sr, 1, 60);
});

def('mera_whoosh', 'fruit', { gain: 0.75 }, (sr, rng) => {
  const dur = 0.68;
  const x = noiseOf(rng, sr, dur, 'pink');
  bpPath(x, 2.8, sr, (t) => 700 + 900 * Math.sin(clamp01(t) * Math.PI * 1.4));
  tremolo(x, sr, 14, 0.35);
  shape(x, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.1));
  mixInto(x, grains(rng, sr, dur, { count: 14, ms: [2, 7], f: [2000, 6000], q: 9, gain: [0.06, 0.3] }), 1);
  return fadeEdges(normalize(x, 0.8), sr, 6, 40);
});

def('hie_freeze', 'fruit', { gain: 0.85, reverb: 0.4 }, (sr, rng) => {
  const dur = 1.05;
  const n = nsamp(sr, dur);
  const x = new Float32Array(n);
  // a crystal lattice forming: six partials fading in at staggered times, none decaying
  const base = 2380;
  for (let k = 0; k < 6; k++) {
    const osc = makeOsc('sine', sr, k * 0.19);
    const f = base * [1, 1.34, 1.79, 2.21, 2.68, 3.11][k];
    const start = k * 0.07;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = t < start ? 0 : Math.pow(Math.sin(clamp01((t - start) / (1 - start)) * Math.PI), 1.3);
      x[i] += osc(f) * a * (0.3 - k * 0.035);
    }
  }
  const frost = noiseOf(rng, sr, dur, 'white');
  bandpassSweep(frost, 800, 7600, 2, sr, 1.3);
  shape(frost, (t) => Math.pow(t, 1.6) * Math.pow(1 - t, 0.5) * 1.6);
  mixInto(x, frost, 0.55);
  mixInto(x, glide(sr, dur, 92, 38, { amp: 0.4, curve: 0.6, tau: 0.28 }), 1);
  return fadeEdges(normalize(x, 0.9), sr, 4, 70);
});

def('hie_shatter', 'fruit', { gain: 0.9, prio: 100 }, (sr, rng) => {
  const dur = 0.9;
  const x = new Float32Array(nsamp(sr, dur));
  // density falls off fast: 22 shards, most of them in the first 120 ms
  for (let i = 0; i < 22; i++) {
    const u = i / 22;
    const at = Math.pow(rng.f(), 2.2) * 0.55;
    const f = rng.range(2400, 8200);
    const p = modes(sr, 0.28, f, [[1, 1, 0.035 + rng.f() * 0.05], [2.13, 0.4, 0.02], [3.41, 0.2, 0.012]]);
    mixAt(x, p, rng.range(0.2, 0.8) * (1 - u * 0.5), at, sr);
  }
  const splash = noiseOf(rng, sr, 0.3, 'white');
  bandpassSweep(splash, 6000, 2400, 1.6, sr);
  shape(splash, (t) => Math.pow(1 - t, 2));
  mixInto(x, splash, 0.5);
  mixInto(x, glide(sr, 0.3, 150, 60, { amp: 0.35, tau: 0.06 }), 1);
  return fadeEdges(normalize(x, 0.92), sr, 0.4, 60);
});

def('suna_scatter', 'fruit', { gain: 0.7 }, (sr, rng) => {
  const dur = 0.95;
  const x = noiseOf(rng, sr, dur, 'white');
  highpass1(x, 2400, sr);
  bpPath(x, 1.2, sr, (t) => lerp(3200, 6400, t));
  // grain density thins as the sand disperses — a flat hiss reads as steam, not sand
  shape(x, (t) => Math.pow(1 - t, 1.3) * (t < 0.06 ? t / 0.06 : 1));
  mixInto(x, grains(rng, sr, dur, {
    count: 34, ms: [1.5, 6], f: [2600, 9000], q: 10, gain: [0.05, 0.3],
    at: (u, r) => Math.pow(r.f(), 1.6) * dur * 0.9,
  }), 1);
  mixInto(x, glide(sr, 0.25, 130, 70, { amp: 0.18, tau: 0.05 }), 1);
  return fadeEdges(normalize(x, 0.75), sr, 2, 60);
});

def('suna_burrow', 'fruit', { gain: 0.75 }, (sr, rng) => {
  const dur = 0.95;
  const x = noiseOf(rng, sr, dur, 'white');
  bpPath(x, 1.6, sr, (t) => 4200 * Math.pow(0.075, Math.pow(t, 0.8)));
  shape(x, (t) => swell(t, 0.14, 1.2));
  const rumble = noiseOf(rng, sr, dur, 'brown');
  lowpass1(rumble, 210, sr);
  shape(rumble, (t) => Math.pow(t, 1.2) * Math.pow(1 - t, 0.6) * 1.8);
  mixInto(x, rumble, 0.9);
  mixInto(x, glide(sr, dur, 145, 52, { amp: 0.3, curve: 0.7, tau: 0.3 }), 1);
  return fadeEdges(normalize(x, 0.85), sr, 6, 70);
});

def('gura_crack', 'fruit', { gain: 1.0, prio: 112, reverb: 0.45 }, (sr, rng) => {
  const dur = 0.75;
  const x = new Float32Array(nsamp(sr, dur));
  // a low compression arrives *before* the crack — air being pushed out of the way
  mixInto(x, shape(glide(sr, 0.09, 44, 120, { curve: 1.6, tau: 0.06, amp: 0.5 }), (t) => Math.pow(t, 1.5)), 1);
  const crack = noiseOf(rng, sr, 0.22, 'white');
  bpPath(crack, 1.1, sr, (t) => (t < 0.008 ? 9000 : lerp(7000, 900, Math.pow(t, 0.4))));
  shape(crack, (t) => Math.pow(1 - t, 3));
  saturate(crack, 3.5);
  mixAt(x, crack, 1, 0.085, sr);
  const glass = modes(sr, 0.6, 1720, [[1, 0.5, 0.09], [1.63, 0.35, 0.06], [2.41, 0.22, 0.04], [3.87, 0.12, 0.02]]);
  mixAt(x, glass, 0.55, 0.088, sr);
  mixAt(x, glide(sr, 0.5, 90, 34, { amp: 0.6, curve: 0.4, tau: 0.14 }), 1, 0.085, sr);
  return fadeEdges(normalize(dcBlock(x, sr), 1), sr, 2, 70);
});

def('gura_boom', 'fruit', { gain: 1.0, prio: 120, ref: 25, maxDist: 500, reverb: 0.5 }, (sr, rng) => {
  const dur = 2.9;
  const n = nsamp(sr, dur);
  const x = new Float32Array(n);
  const sub = makeOsc('sine', sr), sub2 = makeOsc('sine', sr, 0.5);
  const env = expEnv(n, sr, 0.75, 0.008);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = lerp(31, 19, Math.pow(t, 0.4));
    x[i] = (sub(f) * 0.9 + sub2(f * 1.503) * 0.35) * env[i];
  }
  const roar = noiseOf(rng, sr, dur, 'brown');
  lowpass1(roar, 95, sr);
  lowpass1(roar, 140, sr);
  const w = rng.f() * TAU;
  shape(roar, (t) => Math.pow(1 - t, 1.4) * (0.65 + 0.35 * Math.sin(t * TAU * 1.6 + w)));
  mixInto(x, roar, 1.5);
  const debris = grains(rng, sr, dur, { count: 26, ms: [3, 16], f: [300, 2600], q: 4, gain: [0.05, 0.25], at: (u, r) => Math.pow(r.f(), 1.4) * 1.6 });
  mixInto(x, debris, 1);
  saturate(x, 2.4);
  return fadeEdges(normalize(dcBlock(x, sr), 1), sr, 3, 200);
});

def('zushi_pull', 'fruit', { gain: 0.8, reverb: 0.35 }, (sr, rng) => {
  const dur = 1.15;
  const n = nsamp(sr, dur);
  const x = new Float32Array(n);
  // gravity: pitch falls while loudness rises. The contradiction is the whole effect.
  const a = makeOsc('saw', sr), b = makeOsc('saw', sr, 0.4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = lerp(410, 82, Math.pow(t, 0.75));
    x[i] = (a(f) + b(f * 1.0075)) * 0.5 * Math.pow(t, 1.1);
  }
  bpPath(x, 7, sr, (t) => 380 + 260 * Math.sin(t * TAU * 2.6));
  const drone = glide(sr, dur, 55, 41, { wave: 'triangle', curve: 1, tau: 4, amp: 0.4 });
  shape(drone, (t) => Math.pow(t, 1.3));
  mixInto(x, drone, 1);
  const dust = noiseOf(rng, sr, dur, 'pink');
  bpPath(dust, 2, sr, (t) => lerp(2800, 600, t));
  shape(dust, (t) => Math.pow(t, 1.6) * 0.6);
  mixInto(x, dust, 0.5);
  return fadeEdges(normalize(x, 0.85), sr, 8, 70);
});

def('zushi_slam', 'fruit', { gain: 1.0, prio: 110, ref: 12, maxDist: 200, reverb: 0.42 }, (sr, rng) => {
  const dur = 1.35;
  const x = percussiveHit(rng, sr, {
    dur, click: 0.5, clickFreq: 1400, bodyFreq: 72, bodyEnd: 28,
    bodyDecay: 0.3, bodyGlide: 0.3, tail: 0.4, tailFreq: 300, tailEnd: 120,
    tailQ: 1.5, tailDecay: 0.35, drive: 3,
  });
  // a metallic crush ring: mass being compressed, not just landing
  mixInto(x, modes(sr, dur, 128, [[1, 0.5, 0.2], [2.71, 0.3, 0.1], [5.32, 0.15, 0.05], [8.1, 0.07, 0.03]]), 1);
  const crush = noiseOf(rng, sr, 0.5, 'white');
  bandpassSweep(crush, 2400, 400, 2.5, sr, 0.6);
  shape(crush, (t) => Math.pow(1 - t, 1.8));
  mixInto(x, crush, 0.55);
  return fadeEdges(normalize(dcBlock(x, sr), 1), sr, 0.3, 90);
});

// ===========================================================================
// UI / QUEST
// ===========================================================================

def('ui_move', 'ui', { gain: 0.3, prio: 94 }, (sr, rng) => {
  const dur = 0.1;
  const x = bellTone(sr, 1174, dur, { ratios: [1, 2.76], amps: [1, 0.25], decay: 0.022 });
  const cl = noiseOf(rng, sr, 0.006, 'white');
  highpass1(cl, 4000, sr);
  shape(cl, (t) => 1 - t);
  mixInto(x, cl, 0.2);
  return fadeEdges(normalize(x, 0.55), sr, 0.3, 8);
});

def('ui_confirm', 'ui', { gain: 0.4, prio: 96 }, (sr, rng) => {
  const dur = 0.32;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [74, 81]; // D5 -> A5, an open fifth: reads as "yes" in any key
  for (let i = 0; i < notes.length; i++) {
    const t = glide(sr, 0.22, midiHz(notes[i]), midiHz(notes[i]), { wave: 'triangle', tau: 0.06, amp: 0.6 });
    mixAt(t, bellTone(sr, midiHz(notes[i]) * 2, 0.2, { decay: 0.05 }), 0.25, 0, sr);
    mixAt(x, t, 0.9, i * 0.075, sr);
  }
  return fadeEdges(normalize(x, 0.7), sr, 1, 30);
});

def('ui_cancel', 'ui', { gain: 0.35, prio: 96 }, (sr, rng) => {
  const dur = 0.3;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [69, 62]; // falling fifth, and muffled — refusal, not failure
  for (let i = 0; i < notes.length; i++) {
    const t = glide(sr, 0.2, midiHz(notes[i]), midiHz(notes[i]), { wave: 'square', duty: 0.35, tau: 0.05, amp: 0.4 });
    lowpass1(t, 1700, sr);
    mixAt(x, t, 0.9, i * 0.07, sr);
  }
  return fadeEdges(normalize(x, 0.6), sr, 1, 30);
});

def('quest_accept', 'ui', { gain: 0.5, prio: 98, reverb: 0.2 }, (sr, rng) => {
  const dur = 1.0;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [62, 65, 69];
  for (let i = 0; i < notes.length; i++) {
    mixAt(x, pluckString(rng, sr, midiHz(notes[i] + 12), 0.7, { damp: 0.4, body: 0.15 }),
      0.6 - i * 0.05, i * 0.11, sr);
  }
  return fadeEdges(normalize(x, 0.75), sr, 1, 60);
});

def('quest_step', 'ui', { gain: 0.45, prio: 98, reverb: 0.28 }, (sr, rng) => {
  const dur = 0.95;
  const x = bellTone(sr, midiHz(81), dur, { decay: 0.28, phase: true });
  const shimmer = noiseOf(rng, sr, 0.4, 'white');
  bandpassSweep(shimmer, 5000, 8500, 3, sr);
  shape(shimmer, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 2) * 0.35);
  mixInto(x, shimmer, 0.3);
  return fadeEdges(normalize(x, 0.7), sr, 1, 60);
});

def('quest_complete', 'ui', { gain: 0.6, prio: 102, reverb: 0.35 }, (sr, rng) => {
  const dur = 2.1;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [74, 81, 86, 89];
  for (let i = 0; i < notes.length; i++) {
    mixAt(x, bellTone(sr, midiHz(notes[i]), 1.2, { decay: 0.34, phase: true }), 0.5 - i * 0.05, i * 0.13, sr);
    mixAt(x, pluckString(rng, sr, midiHz(notes[i] - 24), 1.0, { damp: 0.5, body: 0.3 }), 0.3, i * 0.13, sr);
  }
  const pad = new Float32Array(x.length);
  for (const m of [50, 57, 62, 66]) {
    const o1 = makeOsc('saw', sr), o2 = makeOsc('saw', sr, 0.27);
    const f = midiHz(m);
    for (let i = 0; i < pad.length; i++) pad[i] += (o1(f) + o2(f * 1.005)) * 0.12;
  }
  lowpassSweep(pad, 400, 2200, sr);
  shape(pad, (t) => Math.pow(Math.sin(clamp01(t) * Math.PI), 1.5) * 0.5);
  mixInto(x, pad, 1);
  return fadeEdges(normalize(x, 0.85), sr, 3, 120);
});

def('coin_pickup', 'ui', { gain: 0.45, prio: 95, variants: 3 }, (sr, rng) => {
  const dur = 0.5;
  const x = new Float32Array(nsamp(sr, dur));
  const f0 = midiHz(91);
  mixAt(x, bellTone(sr, f0, 0.35, { ratios: [1, 2.41, 4.1], amps: [1, 0.4, 0.2], decay: 0.09 }), 0.8, 0, sr);
  mixAt(x, bellTone(sr, f0 * 2, 0.35, { ratios: [1, 2.41, 4.1], amps: [1, 0.35, 0.15], decay: 0.08 }), 0.6, 0.055, sr);
  mixInto(x, grains(rng, sr, dur, { count: 6, ms: [2, 6], f: [6000, 11000], q: 10, gain: [0.05, 0.2] }), 1);
  return fadeEdges(normalize(x, 0.72), sr, 0.5, 40);
});

def('chest_open', 'ui', { gain: 0.6, prio: 96, ui: false, ref: 4, maxDist: 30, reverb: 0.3 }, (sr, rng) => {
  const dur = 1.4;
  const x = new Float32Array(nsamp(sr, dur));
  const creak = stickSlip(rng, sr, 0.75, { rate: [26, 14], res: 700, q: 10 });
  mixAt(x, creak, 0.8, 0.0, sr);
  mixAt(x, ticks(rng, sr, 0.2, [0.0, 0.035], { f: [1200, 2200], decay: 0.02, gain: 0.7 }), 0.7, 0.72, sr);
  for (let i = 0; i < 3; i++) {
    mixAt(x, bellTone(sr, midiHz([81, 86, 89][i]), 0.7, { decay: 0.2, phase: true }), 0.2, 0.8 + i * 0.07, sr);
  }
  return fadeEdges(normalize(x, 0.8), sr, 2, 90);
});

def('bounty_up', 'ui', { gain: 0.7, prio: 104, reverb: 0.45 }, (sr, rng) => {
  const dur = 2.5;
  const n = nsamp(sr, dur);
  const x = new Float32Array(n);
  // a drone climbing a minor second: the interval the ear refuses to settle on
  const a = makeOsc('saw', sr), b = makeOsc('saw', sr, 0.31);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const f = lerp(55, 87, Math.pow(t, 1.7));
    x[i] = (a(f) * 0.5 + b(f * 1.06) * 0.4) * Math.pow(t, 0.8);
  }
  lowpassSweep(x, 300, 1500, sr);
  tremolo(x, sr, 5.5, 0.35);
  const swellNoise = noiseOf(rng, sr, dur, 'pink');
  bandpassSweep(swellNoise, 400, 2600, 1.5, sr, 1.6);
  shape(swellNoise, (t) => Math.pow(t, 2.4) * 0.7);
  mixInto(x, swellNoise, 0.5);
  mixAt(x, bellTone(sr, midiHz(50), 1.4, { decay: 0.4, phase: true }), 0.55, 1.55, sr);
  mixAt(x, bellTone(sr, midiHz(51), 1.4, { decay: 0.36, phase: true }), 0.3, 1.62, sr);
  saturate(x, 1.6);
  return fadeEdges(normalize(x, 0.9), sr, 8, 200);
});

def('crew_join', 'ui', { gain: 0.6, prio: 100, reverb: 0.35 }, (sr, rng) => {
  const dur = 2.0;
  const x = new Float32Array(nsamp(sr, dur));
  const notes = [50, 57, 62, 66, 69]; // D major, spread wide and warm
  for (let i = 0; i < notes.length; i++) {
    mixAt(x, pluckString(rng, sr, midiHz(notes[i]), 1.3, { damp: 0.42, body: 0.25 }),
      0.55 - i * 0.04, i * 0.085, sr);
  }
  mixAt(x, bellTone(sr, midiHz(86), 1.2, { decay: 0.32, phase: true }), 0.28, 0.42, sr);
  return fadeEdges(normalize(x, 0.8), sr, 2, 120);
});

def('save_done', 'ui', { gain: 0.3, prio: 90 }, (sr, rng) => {
  const dur = 0.8;
  const x = new Float32Array(nsamp(sr, dur));
  mixAt(x, bellTone(sr, midiHz(67), 0.55, { ratios: [1, 2.03, 3.2], amps: [1, 0.3, 0.12], decay: 0.16 }), 0.6, 0, sr);
  mixAt(x, bellTone(sr, midiHz(72), 0.55, { ratios: [1, 2.03, 3.2], amps: [1, 0.28, 0.1], decay: 0.15 }), 0.45, 0.1, sr);
  lowpass1(x, 4000, sr);
  return fadeEdges(normalize(x, 0.45), sr, 1, 60);
});

// ---------------------------------------------------------------------------
// Bank rendering
// ---------------------------------------------------------------------------

/** Every sound name in the bank, in declaration order. */
export const SFX_NAMES = Object.keys(SFX);

/**
 * Render one sound's variants as raw sample data.
 * @param {string} name
 * @param {number} sr
 * @param {number} seed world seed — the same seed always gives the same bank
 * @returns {Array<Float32Array|Float32Array[]>} one entry per variant
 */
export function renderSfx(name, sr, seed) {
  const d = SFX[name];
  if (!d) return [];
  const out = [];
  const count = Math.max(1, d.variants || 1);
  for (let v = 0; v < count; v++) {
    // A per-(name, variant) stream: adding a sound never shifts another sound's samples.
    out.push(d.render(sr, Rng.fromName(seed, `sfx:${name}:${v}`)));
  }
  return out;
}

/** Peak level of a rendered variant, for mix self-checks. */
export function peakOf(data) {
  const chans = data instanceof Float32Array ? [data] : data;
  let m = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; }
  return m;
}
