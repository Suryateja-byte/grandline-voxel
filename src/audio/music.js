// Adaptive music. Four synthesised instruments, eight states, one key.
//
// The design constraint that shapes everything here: the player crosses between calm sailing,
// an island, a fight and a boss in the space of a minute, and the music has to follow without
// ever sounding like a track was cut off. So there is no track. There is one harmonic world —
// D natural minor, which is also F major, so "bright" and "dark" states share every note —
// and a set of layers whose gains crossfade. A state change re-voices and re-tempos; it never
// restarts anything.
//
// Phrases are generated per four bars from a seeded Rng keyed on the phrase index, so the
// melody never repeats literally and there is no loop point to hear. Motifs are reused inside
// a phrase (bars 1 and 3) so it still sounds composed rather than random.
//
// Instruments:
//   pluck  Karplus-Strong string  — melody and bass, warm and short
//   pad    six detuned oscillators that glide between chord tones — never restarts, so it
//          cannot click, and a chord change costs one setTargetAtTime per voice
//   drum   synthesised low hit — pitch-dropping body plus a filtered tail
//   bell   inharmonic struck partials — accents, night sparkle, victory fanfare

import { Rng } from '../core/rng.js';
import { clamp, clamp01, lerp } from '../core/math.js';
import { bufferFromData, pluckString, bellTone, percussiveHit, midiHz } from './synth.js';

/** D3. Every state shares this tonic so a crossfade can never land out of key. */
export const TONIC = 50;

/** D natural minor / F major. Semitones from the tonic. */
const SCALE = [0, 2, 3, 5, 7, 8, 10];
/** Pentatonic subset used for fast passages, where every note must be safe. */
const PENTA = [0, 3, 5, 7, 10];

const QUALITY = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  min7: [0, 3, 10],
  sus: [0, 5, 7],
};

const ch = (root, quality) => ({ root, quality });

// i - VI - III - VII and friends. Roots are semitones above the tonic.
const PROG = {
  adventure: [ch(0, 'min'), ch(8, 'maj'), ch(3, 'maj'), ch(10, 'maj')],
  calm: [ch(3, 'maj'), ch(10, 'maj'), ch(0, 'min'), ch(8, 'maj')],
  brood: [ch(0, 'min'), ch(0, 'min'), ch(8, 'maj'), ch(10, 'maj')],
  boss: [ch(0, 'min'), ch(10, 'maj'), ch(8, 'maj'), ch(7, 'maj')], // the V major is the dread
  bright: [ch(3, 'maj'), ch(10, 'maj'), ch(5, 'min'), ch(8, 'maj')],
  nocturne: [ch(0, 'min7'), ch(8, 'maj'), ch(3, 'maj'), ch(7, 'sus')],
};

/**
 * A state is a mix (layer gains), a tempo, a progression and a melodic character.
 * `density` is the chance a rhythm slot survives; `octave` shifts the melodic register.
 */
export const MUSIC_STATES = {
  calm_sea: {
    bpm: 62, prog: 'calm', mix: { pad: 0.85, pluck: 0.5, bass: 0.35, drum: 0, bell: 0.25 },
    density: 0.4, octave: 12, melodyInst: 'pluck', padCut: 900, bassEighths: false,
  },
  sail: {
    bpm: 92, prog: 'adventure', mix: { pad: 0.6, pluck: 0.8, bass: 0.6, drum: 0.35, bell: 0.2 },
    density: 0.75, octave: 12, melodyInst: 'pluck', padCut: 1400, bassEighths: false,
  },
  island: {
    bpm: 84, prog: 'bright', mix: { pad: 0.5, pluck: 0.85, bass: 0.5, drum: 0.2, bell: 0.45 },
    density: 0.8, octave: 12, melodyInst: 'pluck', padCut: 1800, bassEighths: false,
  },
  tension: {
    bpm: 74, prog: 'brood', mix: { pad: 0.8, pluck: 0.18, bass: 0.7, drum: 0.45, bell: 0.12 },
    density: 0.28, octave: 0, melodyInst: 'bell', padCut: 620, bassEighths: false,
  },
  combat: {
    bpm: 132, prog: 'adventure', mix: { pad: 0.45, pluck: 0.75, bass: 0.95, drum: 0.9, bell: 0.3 },
    density: 0.85, octave: 12, melodyInst: 'pluck', padCut: 1500, bassEighths: true,
  },
  boss: {
    bpm: 144, prog: 'boss', mix: { pad: 0.7, pluck: 0.7, bass: 1.0, drum: 1.0, bell: 0.4 },
    density: 0.9, octave: 0, melodyInst: 'pluck', padCut: 1100, bassEighths: true,
  },
  victory: {
    bpm: 112, prog: 'bright', mix: { pad: 0.6, pluck: 0.8, bass: 0.5, drum: 0.5, bell: 0.85 },
    density: 0.8, octave: 24, melodyInst: 'bell', padCut: 2200, bassEighths: false,
  },
  night: {
    bpm: 54, prog: 'nocturne', mix: { pad: 0.7, pluck: 0.3, bass: 0.3, drum: 0, bell: 0.4 },
    density: 0.3, octave: 24, melodyInst: 'bell', padCut: 700, bassEighths: false,
  },
};

export const MUSIC_STATE_NAMES = Object.keys(MUSIC_STATES);

/** Sixteenth-note offsets within a bar. Picked per bar, so no two bars scan alike. */
const RHYTHMS = [
  [0, 4, 8, 12], [0, 3, 6, 8, 12], [0, 4, 6, 10, 12], [0, 2, 4, 8, 10],
  [0, 6, 8, 14], [0, 4, 8, 10, 12], [2, 4, 8, 12, 14], [0, 8], [0, 4, 7, 8, 12, 15],
];
/** Kick weights over the 16 slots of a bar. */
const DRUMS = [
  [1, 0, 0, 0, 0, 0, 0.5, 0, 1, 0, 0, 0, 0, 0, 0.4, 0],
  [1, 0, 0, 0.4, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 0, 0, 0.3],
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0],
  [1, 0, 0.3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.6, 0],
];

const LAYERS = ['pad', 'pluck', 'bass', 'drum', 'bell'];

/**
 * Adaptive music director. Owns its own node graph under the destination it is handed.
 * Every method is a no-op when there is no AudioContext, so headless callers are safe.
 */
export class MusicDirector {
  /**
   * @param {BaseAudioContext|null} ctx
   * @param {AudioNode|null} destination bus to play into
   * @param {number} seed world seed
   */
  constructor(ctx, destination, seed) {
    this.ctx = ctx || null;
    this.seed = seed >>> 0;
    this.rng = new Rng(seed);
    this.state = 'calm_sea';
    this.pending = null;
    this.bpm = MUSIC_STATES.calm_sea.bpm;
    this.targetBpm = this.bpm;
    this.enabled = !!ctx;
    this.beat = 0;              // global 16th-note counter
    this.nextTime = 0;          // ctx time of the next 16th
    this.lookahead = 0.4;
    this.volume = 1;
    this._plucks = new Map();
    this._bells = new Map();
    this._drums = null;
    this._phrase = null;
    this._phraseIdx = -1;
    this._chordIdx = -1;
    this.gains = {};
    if (!this.ctx || !destination) { this.enabled = false; return; }

    this.out = ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(destination);
    for (const l of LAYERS) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.out);
      this.gains[l] = g;
    }

    // --- pad: three slots, two detuned saws each, gliding between chord tones forever ---
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.7;
    this.padFilter.connect(this.gains.pad);
    this.padSlots = [];
    for (let i = 0; i < 3; i++) {
      const g = ctx.createGain();
      g.gain.value = 0.16;
      if (ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = (i - 1) * 0.45;  // spread the chord tones so the pad has width
        g.connect(pan);
        pan.connect(this.padFilter);
      } else {
        g.connect(this.padFilter);
      }
      const oscs = [];
      for (let k = 0; k < 2; k++) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(TONIC + 12);
        o.detune.value = (k === 0 ? -6 : 7) + i * 2;
        o.connect(g);
        o.start();
        oscs.push(o);
      }
      this.padSlots.push({ oscs, gain: g });
    }
  }

  /** Bake the sampled instruments this state set will need. Cheap; caches grow lazily. */
  build() {
    if (!this.enabled) return;
    const sr = this.ctx.sampleRate;
    const r = Rng.fromName(this.seed, 'music:drum');
    this._drums = {
      low: bufferFromData(this.ctx, percussiveHit(r, sr, {
        dur: 0.5, click: 0.25, clickFreq: 1400, bodyFreq: 118, bodyEnd: 44,
        bodyDecay: 0.11, bodyGlide: 0.32, tail: 0.3, tailFreq: 260, tailEnd: 140,
        tailQ: 1.6, tailDecay: 0.07, drive: 2.2,
      })),
      soft: bufferFromData(this.ctx, percussiveHit(r, sr, {
        dur: 0.28, click: 0.4, clickFreq: 2600, bodyFreq: 210, bodyEnd: 150,
        bodyDecay: 0.03, tail: 0.5, tailFreq: 1900, tailQ: 3, tailDecay: 0.035,
      })),
    };
  }

  _pluck(midi) {
    let b = this._plucks.get(midi);
    if (!b) {
      const hz = midiHz(midi);
      // low notes ring longer and darker, exactly as a real string does
      const len = clamp(2.4 - (midi - 38) * 0.028, 0.8, 2.4);
      const r = Rng.fromName(this.seed, `music:pluck:${midi}`);
      b = bufferFromData(this.ctx, pluckString(r, this.ctx.sampleRate, hz, len, {
        damp: clamp01(0.28 + (midi - 50) * 0.008), body: midi < 55 ? 0.3 : 0.12,
      }));
      this._plucks.set(midi, b);
    }
    return b;
  }

  _bell(midi) {
    let b = this._bells.get(midi);
    if (!b) {
      b = bufferFromData(this.ctx, bellTone(this.ctx.sampleRate, midiHz(midi), 1.6, {
        decay: 0.34, spread: 0.6, phase: true,
      }));
      this._bells.set(midi, b);
    }
    return b;
  }

  _shot(buffer, time, gain, layer, rate = 1, pan = 0) {
    if (!buffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    if (ctx.createStereoPanner && pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      src.connect(g); g.connect(p); p.connect(this.gains[layer]);
    } else {
      src.connect(g); g.connect(this.gains[layer]);
    }
    src.start(time);
  }

  /**
   * Crossfade to a new state. Layer gains ramp immediately; harmony and tempo change at the
   * next bar so the transition lands on a downbeat instead of cutting across one.
   * @param {string} name
   * @param {{fade?:number, immediate?:boolean}} opts
   */
  setState(name, opts = {}) {
    const st = MUSIC_STATES[name];
    if (!st) return;
    this.state = name;
    if (!this.enabled) return;
    const fade = opts.fade !== undefined ? opts.fade : 1.5;
    const now = this.ctx.currentTime;
    for (const l of LAYERS) {
      const g = this.gains[l];
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.linearRampToValueAtTime((st.mix[l] || 0) * 0.7, now + (opts.immediate ? 0.02 : fade));
    }
    this.padFilter.frequency.cancelScheduledValues(now);
    this.padFilter.frequency.setValueAtTime(this.padFilter.frequency.value, now);
    this.padFilter.frequency.linearRampToValueAtTime(st.padCut, now + (opts.immediate ? 0.02 : fade));
    this.targetBpm = st.bpm;
    if (opts.immediate) this.bpm = st.bpm;
    this.pending = name;
  }

  /** Master gain for the music bed (0..1). */
  setVolume(v) {
    this.volume = clamp01(v);
    if (this.enabled) this.out.gain.value = this.volume;
  }

  /** Silence the bed without tearing down the graph. */
  stop(fade = 1) {
    if (!this.enabled) return;
    const now = this.ctx.currentTime;
    for (const l of LAYERS) {
      this.gains[l].gain.cancelScheduledValues(now);
      this.gains[l].gain.setValueAtTime(this.gains[l].gain.value, now);
      this.gains[l].gain.linearRampToValueAtTime(0, now + fade);
    }
  }

  /** Chord voicing for a progression slot, kept inside one comfortable octave. */
  _voicing(chord) {
    const iv = QUALITY[chord.quality] || QUALITY.min;
    let base = TONIC + 12 + chord.root;
    if (base > TONIC + 19) base -= 12;
    return iv.map((i) => base + i);
  }

  /** Nearest scale degree index to a semitone offset, for snapping melodies to chords. */
  _snap(deg, chord, scale) {
    const iv = QUALITY[chord.quality] || QUALITY.min;
    const want = (chord.root + iv[0]) % 12;
    let best = deg, bestD = 99;
    for (let d = deg - 3; d <= deg + 3; d++) {
      const pc = ((this._degree(d, scale) % 12) + 12) % 12;
      const dist = Math.min((pc - want + 12) % 12, (want - pc + 12) % 12);
      const cost = dist * 4 + Math.abs(d - deg);
      if (cost < bestD) { bestD = cost; best = d; }
    }
    return best;
  }

  /** Semitone offset from the tonic for a scale-degree index (may be negative). */
  _degree(d, scale) {
    const len = scale.length;
    const oct = Math.floor(d / len);
    return scale[((d % len) + len) % len] + oct * 12;
  }

  /**
   * Generate one four-bar phrase. Bars 0 and 2 share a motif (bar 2 transposed a scale step)
   * so the phrase sounds authored; bars 1 and 3 are free, and bar 3 always cadences down to a
   * chord tone. Every draw comes from a phrase-indexed stream, so phrase 40 is as fresh as
   * phrase 1 and any given phrase is reproducible from the seed.
   */
  _makePhrase(idx, st) {
    const rng = this.rng.fork(`phrase:${this.state}:${idx}`);
    const scale = st.density > 0.7 ? PENTA : SCALE;
    const prog = PROG[st.prog];
    const bars = [];
    const motifRhythm = rng.pick(RHYTHMS);
    const motif = [];
    for (let i = 0; i < motifRhythm.length; i++) motif.push(rng.int(-2, 2));

    let deg = rng.int(2, 5);
    for (let bar = 0; bar < 4; bar++) {
      const chord = prog[bar % prog.length];
      const useMotif = bar === 0 || bar === 2;
      const rhythm = useMotif ? motifRhythm : rng.pick(RHYTHMS);
      const notes = [];
      if (useMotif && bar === 2) deg = this._snap(deg + rng.int(-1, 2), chord, scale);
      for (let i = 0; i < rhythm.length; i++) {
        if (!rng.chance(st.density)) continue;
        if (useMotif) deg += motif[i % motif.length];
        else deg += rng.pick([-2, -1, -1, 0, 1, 1, 2]);
        if (bar === 3 && i >= rhythm.length - 2) deg = this._snap(Math.max(0, deg - 1), chord, scale);
        if (i === 0) deg = this._snap(deg, chord, scale);
        deg = clamp(deg, -2, scale.length * 2 + 1);
        notes.push({
          slot: rhythm[i],
          semi: this._degree(deg, scale),
          vel: rhythm[i] % 4 === 0 ? rng.range(0.75, 1) : rng.range(0.4, 0.72),
        });
      }
      bars.push({ notes, drum: DRUMS[rng.u32() % DRUMS.length], fill: bar === 3 && rng.chance(0.5) });
    }
    return bars;
  }

  /**
   * Advance scheduling. `dt` is the fixed simulation step; the audio clock does the actual
   * timing, because sample-accurate scheduling is the only thing that stops a bed drifting.
   */
  step(dt) {
    if (!this.enabled) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    if (this.nextTime === 0 || this.nextTime < now - 1) this.nextTime = now + 0.08;

    // tempo eases toward the target so a state change accelerates rather than jump-cuts
    this.bpm = lerp(this.bpm, this.targetBpm, clamp01(dt * 1.2));

    let guard = 0;
    while (this.nextTime < now + this.lookahead && guard++ < 64) {
      const st = MUSIC_STATES[this.state];
      const sixteenth = 60 / this.bpm / 4;
      const slot = this.beat % 16;
      const barIdx = Math.floor(this.beat / 16);
      const phraseIdx = Math.floor(barIdx / 4);
      const barInPhrase = barIdx % 4;

      if (slot === 0 && this.pending) {
        // apply harmony/character on the downbeat
        this.pending = null;
        this._phraseIdx = -1;
      }
      if (phraseIdx !== this._phraseIdx) {
        this._phraseIdx = phraseIdx;
        this._phrase = this._makePhrase(phraseIdx, st);
      }
      const prog = PROG[st.prog];
      const chord = prog[barInPhrase % prog.length];
      const bar = this._phrase[barInPhrase];
      const t = this.nextTime;

      if (slot === 0) {
        const v = this._voicing(chord);
        for (let i = 0; i < this.padSlots.length; i++) {
          for (const o of this.padSlots[i].oscs) {
            o.frequency.setTargetAtTime(midiHz(v[i % v.length]), t, 0.07);
          }
        }
        // bass root, plus a fifth on the second half for the driving states
        this._shot(this._pluck(TONIC + chord.root - 12), t, 0.55, 'bass');
      }
      if (st.bassEighths && slot % 4 === 2) {
        this._shot(this._pluck(TONIC + chord.root), t, 0.3, 'bass');
      } else if (!st.bassEighths && slot === 8) {
        this._shot(this._pluck(TONIC + chord.root + 7 - 12), t, 0.32, 'bass');
      }

      const dw = bar.drum[slot];
      if (dw > 0 && this._drums) {
        this._shot(this._drums.low, t, 0.55 * dw, 'drum', 1);
        if (slot % 8 === 4) this._shot(this._drums.soft, t, 0.3 * dw, 'drum', 1, 0.25);
      }
      if (bar.fill && slot >= 12 && slot % 2 === 0 && this._drums) {
        this._shot(this._drums.soft, t, 0.35, 'drum', 1 + (slot - 12) * 0.06, (slot - 13) * 0.3);
      }

      for (const nt of bar.notes) {
        if (nt.slot !== slot) continue;
        const midi = TONIC + st.octave + nt.semi;
        if (st.melodyInst === 'bell') {
          this._shot(this._bell(midi), t, nt.vel * 0.4, 'bell', 1, (nt.semi % 5) * 0.08);
        } else {
          this._shot(this._pluck(midi), t, nt.vel * 0.5, 'pluck', 1, (nt.semi % 7 - 3) * 0.07);
        }
      }
      // a bell accent on the first beat of a phrase gives the ear a landmark
      if (slot === 0 && barInPhrase === 0 && st.mix.bell > 0.15) {
        this._shot(this._bell(TONIC + 24 + chord.root), t, 0.22, 'bell', 1, -0.2);
      }

      this.nextTime += sixteenth;
      this.beat++;
    }
  }

  dispose() {
    if (!this.enabled) return;
    for (const s of this.padSlots) for (const o of s.oscs) { try { o.stop(); } catch (e) { /* already stopped */ } }
    try { this.out.disconnect(); } catch (e) { /* detached */ }
    this.enabled = false;
  }
}
