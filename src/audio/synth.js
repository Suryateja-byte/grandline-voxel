// Procedural audio synthesis toolkit. No audio files exist in this project, by rule —
// every sound is computed into a Float32Array here and handed to WebAudio as a buffer.
//
// The file is split into two layers on purpose:
//   1. Pure DSP over Float32Array. No AudioContext, no DOM. This runs under node, which is
//      what makes the whole sound bank testable headless and keeps `import` side-effect free.
//   2. Three thin bridges (renderBuffer, bufferFromData, impulseResponse) that wrap layer 1
//      into AudioBuffers. Each no-ops on a null ctx so headless capture never throws.
//
// Determinism: anything that needs randomness takes an Rng (src/core/rng.js). Math.random is
// banned repo-wide, so two runs of the same seed produce bit-identical sample data.

import { TAU, clamp, clamp01, lerp } from '../core/math.js';

/** Fallback rate used when synthesising without a context (tests, node). */
export const SR_DEFAULT = 48000;

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

// A linearly-interpolated sine table. 4096 points puts the interpolation error near -78 dB,
// which is inaudible, and sine is evaluated tens of millions of times while the bank bakes.
const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((i / SINE_N) * TAU);

/** Table sine over a normalised phase (turns). */
export function tsin(p) {
  const t = (p - Math.floor(p)) * SINE_N;
  const i = t | 0;
  const f = t - i;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * f;
}

/** Waveshapes over a normalised phase (turns). Not band-limited — filter after use. */
export const wave = {
  sine: tsin,
  saw: (p) => 2 * (p - Math.floor(p + 0.5)),
  square: (p, duty = 0.5) => (p - Math.floor(p) < duty ? 1 : -1),
  triangle: (p) => {
    const t = p - Math.floor(p);
    return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
  },
};

/**
 * A stateful oscillator. Phase accumulates across calls, so frequency may change every
 * sample without the discontinuity you get from evaluating sin(2*pi*f*t) directly —
 * that discontinuity is exactly what makes naive pitch sweeps click.
 * @param {'sine'|'saw'|'square'|'triangle'} kind
 * @param {number} sr sample rate
 * @param {number} phase0 initial phase in turns
 * @returns {(freq:number, arg?:number)=>number}
 */
export function makeOsc(kind, sr, phase0 = 0) {
  const shape = wave[kind] || wave.sine;
  let p = phase0;
  const inv = 1 / sr;
  return (freq, arg) => {
    const v = shape(p, arg);
    p += freq * inv;
    if (p >= 1e6) p -= 1e6; // keep float precision sane on long beds
    return v;
  };
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Flat-spectrum noise in [-1,1]. */
export function whiteNoise(rng, n, out) {
  const x = out || new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.sym();
  return x;
}

/** -3 dB/octave noise (Paul Kellett's economy filter). The natural bed for wind and hiss. */
export function pinkNoise(rng, n, out) {
  const x = out || new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.sym();
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.32;
  }
  return x;
}

/** -6 dB/octave noise. Rumble, thunder tails, distant surf. `leak` stops DC runaway. */
export function brownNoise(rng, n, leak = 0.997, out) {
  const x = out || new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) {
    y = y * leak + rng.sym() * 0.06;
    x[i] = clamp(y * 3.2, -1, 1);
  }
  return x;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * Classic ADSR sampled into an array. Times in seconds; sustain is a level in 0..1.
 * The decay and release legs are power curves rather than lines because linear amplitude
 * decay reads as a synthetic "ramp down" instead of a physical body dying away.
 */
export function adsr(n, sr, { a = 0.004, d = 0.08, s = 0.5, r = 0.2, curve = 2.2 } = {}) {
  const out = new Float32Array(n);
  const aN = Math.max(1, Math.round(a * sr));
  const dN = Math.max(1, Math.round(d * sr));
  const rN = Math.max(1, Math.round(r * sr));
  const rel = Math.max(aN + dN, n - rN);
  for (let i = 0; i < n; i++) {
    if (i < aN) out[i] = i / aN;
    else if (i < aN + dN) out[i] = s + (1 - s) * Math.pow(1 - (i - aN) / dN, curve);
    else if (i < rel) out[i] = s;
    else out[i] = s * Math.pow(1 - (i - rel) / Math.max(1, n - rel), curve);
  }
  return out;
}

/**
 * Exponential decay with a short anti-click attack. `tau` is the 1/e time in seconds.
 * Computed as a multiplicative recurrence rather than Math.exp per sample — it is exact,
 * and the bank renders ~70 sounds at boot so the transcendental count actually matters.
 */
export function expEnv(n, sr, tau, attack = 0.0015) {
  const out = new Float32Array(n);
  const aN = Math.max(1, Math.round(attack * sr));
  const g = Math.exp(-1 / (Math.max(1e-5, tau) * sr));
  let v = 1;
  for (let i = 0; i < n; i++) {
    out[i] = (i < aN ? i / aN : 1) * v;
    v *= g;
  }
  return out;
}

/** Power ramp from `from` to `to` across n samples. curve>1 eases out, <1 eases in. */
export function ramp(n, from, to, curve = 1) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = lerp(from, to, Math.pow(i / Math.max(1, n - 1), curve));
  return out;
}

// ---------------------------------------------------------------------------
// Filters. All operate in place and return the same array.
// ---------------------------------------------------------------------------

const poleCoef = (fc, sr) => Math.exp(-TAU * clamp(fc, 8, sr * 0.48) / sr);

/** One-pole lowpass. */
export function lowpass1(x, fc, sr) {
  const a = poleCoef(fc, sr), b = 1 - a;
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = y * a + x[i] * b; x[i] = y; }
  return x;
}

/** One-pole highpass (the differentiating complement of lowpass1). */
export function highpass1(x, fc, sr) {
  const rc = 1 / (TAU * clamp(fc, 4, sr * 0.48));
  const dt = 1 / sr;
  const a = rc / (rc + dt);
  let yPrev = 0, xPrev = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    yPrev = a * (yPrev + xi - xPrev);
    xPrev = xi;
    x[i] = yPrev;
  }
  return x;
}

/**
 * Two-pole state-variable bandpass (Chamberlin). Q sets the ring; above ~12 it self-rings,
 * which is how the metallic sounds in the bank get their tail without a delay line.
 */
export function bandpass(x, fc, q, sr) {
  let low = 0, band = 0;
  const f = 2 * Math.sin(Math.PI * clamp(fc, 8, sr * 0.45) / sr);
  const damp = 1 / Math.max(0.5, q);
  const g = Math.min(2.4, Math.sqrt(Math.max(0.5, q)));
  for (let i = 0; i < x.length; i++) {
    const high = x[i] - low - damp * band;
    band += f * high;
    low += f * band;
    x[i] = band * g;
  }
  return x;
}

/**
 * Modulated filters recompute their coefficient once per control block rather than once
 * per sample. 16 samples at 48 kHz is 0.33 ms — far below any audible stepping — and it
 * removes two transcendentals per sample from the hottest loops in the whole project.
 */
export const CTRL = 16;

/** Lowpass whose cutoff glides f0 -> f1 (exponentially in frequency) across the array. */
export function lowpassSweep(x, f0, f1, sr, curve = 1) {
  const n = x.length;
  const l0 = Math.log(Math.max(8, f0)), l1 = Math.log(Math.max(8, f1));
  const inv = 1 / Math.max(1, n - 1);
  let y = 0, a = poleCoef(Math.exp(l0), sr);
  for (let i = 0; i < n; i++) {
    if ((i & (CTRL - 1)) === 0) a = poleCoef(Math.exp(lerp(l0, l1, Math.pow(i * inv, curve))), sr);
    y = y * a + x[i] * (1 - a);
    x[i] = y;
  }
  return x;
}

/** Bandpass whose centre glides f0 -> f1. The backbone of every whoosh in the bank. */
export function bandpassSweep(x, f0, f1, q, sr, curve = 1) {
  const n = x.length;
  const l0 = Math.log(Math.max(8, f0)), l1 = Math.log(Math.max(8, f1));
  const inv = 1 / Math.max(1, n - 1);
  const damp = 1 / Math.max(0.5, q);
  const g = Math.min(2.4, Math.sqrt(Math.max(0.5, q)));
  let low = 0, band = 0, f = 0;
  for (let i = 0; i < n; i++) {
    if ((i & (CTRL - 1)) === 0) {
      const fc = clamp(Math.exp(lerp(l0, l1, Math.pow(i * inv, curve))), 8, sr * 0.45);
      f = 2 * Math.sin(Math.PI * fc / sr);
    }
    const high = x[i] - low - damp * band;
    band += f * high;
    low += f * band;
    x[i] = band * g;
  }
  return x;
}

/** Removes the DC drift that brown noise and heavy saturation leave behind. */
export function dcBlock(x, sr) {
  const r = 1 - 40 / sr;
  let xPrev = 0, yPrev = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    yPrev = xi - xPrev + r * yPrev;
    xPrev = xi;
    x[i] = yPrev;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Shaping and utility
// ---------------------------------------------------------------------------

/** Single-sample soft clip, normalised so unity in stays near unity out. */
export function softClip(v, drive = 2) {
  return Math.tanh(v * drive) / Math.tanh(drive);
}

/** Array soft clip. Adds the harmonic thickness that makes impacts feel loud when quiet. */
export function saturate(x, drive = 2) {
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) * norm;
  return x;
}

export function scaleArr(x, g) {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

export function reverseArr(x) {
  for (let i = 0, j = x.length - 1; i < j; i++, j--) { const t = x[i]; x[i] = x[j]; x[j] = t; }
  return x;
}

/** Peak-normalise. Returns the array untouched if it is silent. */
export function normalize(x, peak = 0.95) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  if (m < 1e-6) return x;
  return scaleArr(x, peak / m);
}

/** Short fades at both ends. Without this every one-shot starts and ends on a click. */
export function fadeEdges(x, sr, inMs = 1.5, outMs = 8) {
  const a = Math.min(x.length, Math.max(1, Math.round((inMs / 1000) * sr)));
  const b = Math.min(x.length - a, Math.max(1, Math.round((outMs / 1000) * sr)));
  for (let i = 0; i < a; i++) x[i] *= i / a;
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
  return x;
}

/** Add `src * gain` into `dst` starting at a sample offset. Clips at the end of dst. */
export function mixInto(dst, src, gain = 1, offset = 0) {
  const o = Math.max(0, Math.round(offset));
  const n = Math.min(src.length, dst.length - o);
  for (let i = 0; i < n; i++) dst[o + i] += src[i] * gain;
  return dst;
}

/** Same, with the offset expressed in seconds. */
export function mixAt(dst, src, gain, seconds, sr) {
  return mixInto(dst, src, gain, Math.round(seconds * sr));
}

/**
 * Turn a one-shot bed into a seamless loop by crossfading the tail back over the head.
 * The returned array is shorter by the crossfade length and has no discontinuity at the
 * wrap, which is what stops long ambience from ticking once a bar.
 */
export function loopify(x, sr, crossfade = 0.35) {
  const f = Math.min(Math.floor(x.length / 3), Math.max(1, Math.round(crossfade * sr)));
  const m = x.length - f;
  const out = new Float32Array(m);
  out.set(x.subarray(0, m));
  for (let i = 0; i < f; i++) {
    const w = i / f;
    out[i] = x[i] * w + x[m + i] * (1 - w);
  }
  return out;
}

/**
 * Resample-based pitch shift. ratio > 1 raises pitch and shortens the sound (varispeed,
 * like a tape machine) — this is the honest cheap shift, and the sound bank only uses it
 * for *variation within one recipe*, never to fake a second sound out of a first.
 */
export function pitchShift(x, ratio) {
  const r = clamp(ratio, 0.125, 8);
  const n = Math.max(1, Math.floor(x.length / r));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * r;
    const i0 = Math.floor(s);
    const i1 = Math.min(x.length - 1, i0 + 1);
    out[i] = lerp(x[i0], x[i1], s - i0);
  }
  return out;
}

/**
 * The workhorse percussive shape: transient click + pitched body + filtered tail.
 * Everything in the bank that "lands" is built on this, with wildly different parameters —
 * a footstep, a hull bump and a cannon are the same three-part anatomy at different scales.
 * @param {import('../core/rng.js').Rng} rng
 * @param {number} sr
 * @param {object} o
 * @returns {Float32Array}
 */
export function percussiveHit(rng, sr, o = {}) {
  const dur = o.dur !== undefined ? o.dur : 0.32;
  const n = Math.max(4, Math.round(dur * sr));
  const out = new Float32Array(n);

  // 1. transient — a few milliseconds of highpassed noise, the part the ear reads as "hard"
  const clickAmt = o.click !== undefined ? o.click : 0.5;
  if (clickAmt > 0) {
    const cN = Math.max(2, Math.round((o.clickMs || 5) / 1000 * sr));
    const c = whiteNoise(rng, cN);
    highpass1(c, o.clickFreq || 2400, sr);
    const ce = expEnv(cN, sr, (o.clickMs || 5) / 3000, 0.0003);
    for (let i = 0; i < cN; i++) c[i] *= ce[i];
    mixInto(out, c, clickAmt);
  }

  // 2. body — a sine gliding down in pitch; the glide is what gives weight
  const bodyAmt = o.body !== undefined ? o.body : 1;
  if (bodyAmt > 0) {
    const f0 = o.bodyFreq || 120, f1 = o.bodyEnd !== undefined ? o.bodyEnd : f0 * 0.55;
    const osc = makeOsc(o.bodyWave || 'sine', sr);
    const env = expEnv(n, sr, o.bodyDecay || dur * 0.28, 0.001);
    const l0 = Math.log(f0), l1 = Math.log(Math.max(8, f1));
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      out[i] += osc(Math.exp(lerp(l0, l1, Math.pow(t, o.bodyGlide || 0.45)))) * env[i] * bodyAmt;
    }
  }

  // 3. tail — resonant noise that carries the material (wood, metal, sand, water)
  const tailAmt = o.tail !== undefined ? o.tail : 0.4;
  if (tailAmt > 0) {
    const t = whiteNoise(rng, n);
    bandpassSweep(t, o.tailFreq || 900, o.tailEnd || (o.tailFreq || 900) * 0.7, o.tailQ || 3, sr);
    const te = expEnv(n, sr, o.tailDecay || dur * 0.22, 0.001);
    for (let i = 0; i < n; i++) t[i] *= te[i];
    mixInto(out, t, tailAmt);
  }

  if (o.drive) saturate(out, o.drive);
  return fadeEdges(out, sr, 0.4, 6);
}

// ---------------------------------------------------------------------------
// Reverb impulse response (procedural — there is no .wav to load)
// ---------------------------------------------------------------------------

/**
 * One channel of a room impulse: silence for the predelay, a pattern of discrete early
 * reflections, then an exponentially decaying noise tail that darkens as it dies (high
 * frequencies are absorbed first in any real room, and skipping that is what makes
 * synthetic reverb sound like a hiss instead of a space).
 */
export function impulseResponseData(rng, n, sr, o = {}) {
  const out = new Float32Array(n);
  const decay = o.decay !== undefined ? o.decay : 2.4;
  const pre = Math.round((o.predelay !== undefined ? o.predelay : 0.012) * sr);
  const bright = o.bright !== undefined ? o.bright : 7000;
  const dark = o.dark !== undefined ? o.dark : 900;

  const tail = whiteNoise(rng, Math.max(1, n - pre));
  const lb = Math.log(bright), ld = Math.log(dark);
  const gDec = Math.exp(-decay * 3.2 / Math.max(1, tail.length));
  const gBuild = Math.exp(-60 / sr);
  let y = 0, a = poleCoef(bright, sr), dec = 1, build = 1;
  for (let i = 0; i < tail.length; i++) {
    // time-varying one-pole: cutoff walks bright -> dark across the tail, because a room
    // absorbs highs first and a tail that stays bright reads as hiss, not as a space
    if ((i & (CTRL - 1)) === 0) a = poleCoef(Math.exp(lerp(lb, ld, Math.sqrt(i / tail.length))), sr);
    y = y * a + tail[i] * (1 - a);
    tail[i] = y * dec * (1 - build); // reflections take a moment to become dense
    dec *= gDec;
    build *= gBuild;
  }
  mixInto(out, tail, 1, pre);

  const earlies = o.earlies !== undefined ? o.earlies : 8;
  const burst = Math.max(2, Math.round(0.0016 * sr));
  for (let e = 0; e < earlies; e++) {
    const at = pre + Math.round(rng.range(0.004, o.earlySpread || 0.075) * sr);
    const g = (1 - e / earlies) * rng.range(0.35, 0.8) * (o.earlyGain || 0.9);
    const b = whiteNoise(rng, burst);
    lowpass1(b, rng.range(2200, 8000), sr);
    for (let i = 0; i < burst; i++) b[i] *= 1 - i / burst;
    mixInto(out, b, g, at);
  }
  return normalize(out, o.peak !== undefined ? o.peak : 0.55);
}

/**
 * Build a stereo ConvolverNode impulse. The two channels are drawn from the same Rng but
 * different draws, so they decorrelate — that decorrelation *is* the sense of width.
 *
 * The result is energy-normalised, not peak-normalised: a convolver's output level is the
 * IR's total energy, so a raw two-second noise tail comes back roughly twenty times louder
 * than the dry signal. Normalising here (rather than leaving it to ConvolverNode.normalize)
 * keeps the wet level identical across browsers.
 * @returns {AudioBuffer|null} null when there is no context (headless).
 */
export function impulseResponse(ctx, rng, o = {}) {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const n = Math.max(16, Math.round((o.seconds !== undefined ? o.seconds : 2.1) * sr));
  const chans = [impulseResponseData(rng, n, sr, o), impulseResponseData(rng, n, sr, o)];
  let e = 0;
  for (const c of chans) for (let i = 0; i < n; i++) e += c[i] * c[i];
  const g = (o.energy !== undefined ? o.energy : 1) / Math.max(1e-9, Math.sqrt(e / chans.length));
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) buf.copyToChannel(scaleArr(chans[c], g), c);
  return buf;
}

// ---------------------------------------------------------------------------
// AudioBuffer bridges
// ---------------------------------------------------------------------------

/**
 * Fill an AudioBuffer from a per-sample function.
 * @param {BaseAudioContext|null} ctx
 * @param {number} seconds
 * @param {(t:number, i:number, sr:number)=>number|number[]} fn mono sample, or [l,r]
 * @param {number} channels
 * @returns {AudioBuffer|null}
 */
export function renderBuffer(ctx, seconds, fn, channels = 1) {
  if (!ctx) return null;
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const buf = ctx.createBuffer(channels, n, sr);
  const chans = [];
  for (let c = 0; c < channels; c++) chans.push(new Float32Array(n));
  const inv = 1 / sr;
  for (let i = 0; i < n; i++) {
    const v = fn(i * inv, i, sr);
    if (typeof v === 'number') { for (let c = 0; c < channels; c++) chans[c][i] = v; }
    else { for (let c = 0; c < channels; c++) chans[c][i] = v[c] || 0; }
  }
  for (let c = 0; c < channels; c++) buf.copyToChannel(chans[c], c);
  return buf;
}

/**
 * Wrap already-synthesised sample data in an AudioBuffer.
 * @param {BaseAudioContext|null} ctx
 * @param {Float32Array|Float32Array[]} data mono array, or one array per channel
 */
export function bufferFromData(ctx, data) {
  if (!ctx) return null;
  const chans = data instanceof Float32Array ? [data] : data;
  const n = chans[0].length;
  const buf = ctx.createBuffer(chans.length, n, ctx.sampleRate);
  for (let c = 0; c < chans.length; c++) buf.copyToChannel(chans[c], c);
  return buf;
}

/** Equal-power pan weights for a pan position in [-1,1]. */
export function panGains(pan) {
  const a = (clamp(pan, -1, 1) + 1) * 0.25 * Math.PI;
  return [Math.cos(a), Math.sin(a)];
}

/** MIDI note -> Hz. Concert A = 440. Used by the music layer and the melodic SFX. */
export function midiHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/**
 * Karplus-Strong plucked string. A noise burst circulating through a short delay with a
 * damping filter: the cheapest way to get a real string body, and fully deterministic.
 * @param {import('../core/rng.js').Rng} rng
 */
export function pluckString(rng, sr, hz, seconds, o = {}) {
  const n = Math.max(8, Math.round(seconds * sr));
  const len = Math.max(2, Math.round(sr / clamp(hz, 20, sr / 3)));
  const buf = new Float32Array(len);
  // A lowpassed burst gives a warm, round attack; raw white is thin and buzzy.
  whiteNoise(rng, len, buf);
  lowpass1(buf, o.excite !== undefined ? o.excite : hz * 6, sr);
  normalize(buf, 1);
  const out = new Float32Array(n);
  const damp = o.damp !== undefined ? o.damp : 0.5;   // 0 = bright/long, 1 = dull/short
  const loss = 1 - clamp01(damp) * 0.012 - 0.0006;
  let idx = 0, prev = 0;
  const blend = 0.5 + clamp01(damp) * 0.28;
  for (let i = 0; i < n; i++) {
    const cur = buf[idx];
    const v = (cur * (1 - blend) + prev * blend) * loss;
    prev = cur;
    buf[idx] = v;
    out[i] = cur;
    idx = (idx + 1) % len;
  }
  if (o.body) {
    // A touch of the fundamental under the string keeps low notes from sounding hollow.
    const osc = makeOsc('sine', sr);
    const env = expEnv(n, sr, seconds * 0.3, 0.004);
    for (let i = 0; i < n; i++) out[i] += osc(hz) * env[i] * o.body;
  }
  return fadeEdges(normalize(out, 0.9), sr, 1, 25);
}

/**
 * Inharmonic struck-metal tone (bell, ping, chime, armour). Partial ratios that are *not*
 * integers are the whole trick — integer partials read as a flute, not as metal.
 */
export function bellTone(sr, hz, seconds, o = {}) {
  const n = Math.max(8, Math.round(seconds * sr));
  const out = new Float32Array(n);
  const ratios = o.ratios || [1, 2.01, 2.99, 4.21, 5.43, 6.79];
  const amps = o.amps || [1, 0.62, 0.42, 0.28, 0.17, 0.1];
  const decay = o.decay !== undefined ? o.decay : seconds * 0.34;
  for (let k = 0; k < ratios.length; k++) {
    const f = hz * ratios[k];
    if (f > sr * 0.45) continue;
    const osc = makeOsc('sine', sr, o.phase ? (k * 0.137) % 1 : 0);
    // higher partials die first, exactly as in a struck bar
    const env = expEnv(n, sr, decay / (1 + k * (o.spread !== undefined ? o.spread : 0.55)), 0.0012);
    const a = amps[k] !== undefined ? amps[k] : 0.1;
    for (let i = 0; i < n; i++) out[i] += osc(f) * env[i] * a;
  }
  return fadeEdges(normalize(out, 0.9), sr, 0.6, 12);
}
