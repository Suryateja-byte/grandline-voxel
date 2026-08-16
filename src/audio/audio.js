// The audio facade. One object the rest of the game talks to; everything below it is
// procedural synthesis (sfx.js), adaptive music (music.js) and DSP (synth.js).
//
// Three rules shape this file:
//
// 1. It must never throw. Headless capture, a browser that refuses an AudioContext, a call
//    before init() — all of it has to degrade to silence, because a missing sound must not
//    be able to fail a screenshot gate. Every public method checks `this.ctx` first.
// 2. Combat is never drowned by weather. Voices carry a priority; when the 24-voice cap is
//    reached a new sound may steal a *lower*-priority voice and nothing else. Ambience beds
//    live outside the cap (they are a fixed handful of loops) so they can never consume it.
// 3. Positional audio is manual: distance attenuation, an equal-power stereo pan derived from
//    the listener's yaw, and a one-pole air-absorption filter. PannerNode's HRTF panning costs
//    far more than it buys in a game where the camera is behind the player.
//
// Time: the simulation clock never reaches this file. Scheduling uses ctx.currentTime, the
// audio hardware clock, which is the only clock that can place a sample accurately — and is
// explicitly not a wall-clock read of the kind ARCHITECTURE §1.3 bans from simulation.

import { Rng } from '../core/rng.js';
import { clamp, clamp01, damp, lerp } from '../core/math.js';
import { SFX, SFX_NAMES, renderSfx } from './sfx.js';
import { bufferFromData, impulseResponse } from './synth.js';
import { MusicDirector, MUSIC_STATES } from './music.js';

/** Concurrent one-shot voices. Beyond this, priority decides who lives. */
export const MAX_VOICES = 24;

const AMBIENCE_KEYS = ['wind', 'rain', 'waves', 'jungle', 'underwater'];

/** Which bank entries back each ambience channel. `wind` crossfades two beds by strength. */
const AMBIENCE_BEDS = {
  wind: ['wind_light', 'wind_strong'],
  rain: ['rain'],
  waves: ['wave_lap'],
  jungle: ['jungle_ambience'],
};

function getAudioContextCtor() {
  const g = globalThis;
  return g.AudioContext || g.webkitAudioContext || null;
}

/** Handle returned by `loop()` when audio is unavailable. Same shape, does nothing. */
const NULL_LOOP = {
  stop() {}, setVolume() {}, setRate() {}, setPosition() {}, get playing() { return false; },
};

export class AudioSystem {
  /**
   * @param {number} seed world seed — the entire sound bank is derived from it
   * @param {{enabled?:boolean}} [opts]
   */
  constructor(seed, opts = {}) {
    this.seed = (seed >>> 0) || 1;
    this.rng = new Rng(this.seed);
    this.ctx = null;
    this._ready = false;
    this.master = 0.8;
    /** Per-bus user volumes (settings sliders). Applied when the graph exists. */
    this.sfxVol = 1;
    this.musicVol = 0.5;
    this.muted = false;
    this.musicState = 'calm_sea';
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this.voices = [];
    this._loops = new Set();
    this._bank = new Map();
    this._nextId = 1;
    this._amb = {};
    this._ambTarget = {};
    this._ambLoops = {};
    for (const k of AMBIENCE_KEYS) { this._amb[k] = 0; this._ambTarget[k] = 0; }
    // Capture mode renders frames with no user gesture and no need for sound; booting an
    // AudioContext there costs boot time and can log warnings into the harness error list.
    this.enabled = opts.enabled !== undefined ? opts.enabled : !globalThis.__CAPTURE;
    this.stats = { played: 0, stolen: 0, dropped: 0, baked: 0 };
  }

  /** True once the graph exists. Sounds may be requested before the bank finishes baking. */
  get ready() {
    return this._ready;
  }

  /**
   * Build the context, the mix graph, the reverb impulse and the music director, then bake
   * the sound bank. Beds (world loops) are left to bake on first use so boot is not paying
   * for weather the player may never see.
   * @returns {Promise<AudioSystem>}
   */
  async init() {
    if (!this.enabled) return this;
    const Ctor = getAudioContextCtor();
    if (!Ctor) return this;
    try {
      this.ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (e) {
      this.ctx = null;
      return this;
    }
    const ctx = this.ctx;

    // --- mix graph ---------------------------------------------------------
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : this.master;
    this.masterGain.connect(ctx.destination);

    // One lowpass for the whole mix: this is what "underwater" is, and doing it once here
    // is free compared with filtering every voice.
    this.masterFilter = ctx.createBiquadFilter();
    this.masterFilter.type = 'lowpass';
    this.masterFilter.frequency.value = 20000;
    this.masterFilter.Q.value = 0.6;
    this.masterFilter.connect(this.masterGain);

    // Gentle glue compression. It is also the mechanism that makes a cannon duck the weather
    // instead of summing with it into mush.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 22;
    this.comp.ratio.value = 3.2;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.18;
    this.comp.connect(this.masterFilter);

    this.buses = {};
    for (const [name, vol] of [['sfx', this.sfxVol], ['music', this.musicVol], ['ambience', 0.7]]) {
      const g = ctx.createGain();
      g.gain.value = vol;
      g.connect(this.comp);
      this.buses[name] = g;
    }

    // --- procedural reverb (no impulse file exists, or could) ---------------
    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;
    this.reverb.buffer = impulseResponse(ctx, Rng.fromName(this.seed, 'audio:ir'), {
      seconds: 2.0, decay: 2.5, predelay: 0.014, earlies: 9, bright: 7200, dark: 850,
    });
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.comp);

    // --- music -------------------------------------------------------------
    this.music = new MusicDirector(ctx, this.buses.music, this.seed);
    this.music.build();
    this.music.setState(this.musicState, { immediate: true });

    this._ready = true;

    // --- bake ---------------------------------------------------------------
    // Highest priority first, so if boot is cut short the sounds that exist are the ones the
    // first thirty seconds of play needs. Yield between small batches so a loading screen
    // keeps animating; the whole bank is roughly a second of synthesis, once, ever.
    const order = SFX_NAMES.slice().sort((a, b) => (SFX[b].prio || 0) - (SFX[a].prio || 0));
    for (let i = 0; i < order.length; i++) {
      this._bake(order[i]);
      if ((i & 3) === 3) await new Promise((res) => setTimeout(res, 0));
    }
    return this;
  }

  /** Resume the context. Call from a real user gesture; browsers require one. */
  unlock() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
  }

  /** Synthesise and cache one sound's variants. Safe to call repeatedly. */
  _bake(name) {
    if (!this.ctx || this._bank.has(name)) return this._bank.get(name);
    const d = SFX[name];
    if (!d) return null;
    const bufs = renderSfx(name, this.ctx.sampleRate, this.seed)
      .map((data) => bufferFromData(this.ctx, data));
    this._bank.set(name, bufs);
    this.stats.baked++;
    return bufs;
  }

  // -------------------------------------------------------------------------
  // Voice management
  // -------------------------------------------------------------------------

  /** Reclaim a slot for `prio`, or return false if nothing quieter is playing. */
  _makeRoom(prio) {
    if (this.voices.length < MAX_VOICES) return true;
    let victim = null;
    for (const v of this.voices) {
      if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.id < victim.id)) victim = v;
    }
    if (!victim || victim.prio >= prio) { this.stats.dropped++; return false; }
    this._kill(victim, 0.02);
    this.stats.stolen++;
    return true;
  }

  _kill(voice, fade = 0.02) {
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
    if (!voice.src) return;
    const now = this.ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + fade);
      voice.src.stop(now + fade + 0.005);
    } catch (e) { /* already finished */ }
    voice.src = null;
  }

  /**
   * Build and start one voice. Returns null when the sound was dropped by the voice cap.
   * @param {string} name
   * @param {object} o { volume, rate, variant, pan, reverb, prio, delay, loop, filter }
   */
  _spawn(name, o) {
    const ctx = this.ctx;
    const d = SFX[name];
    const bufs = this._bank.get(name) || this._bake(name);
    if (!bufs || !bufs.length) return null;

    const prio = o.prio !== undefined ? o.prio : d.prio;
    if (!o.loop && !this._makeRoom(prio)) return null;

    const variant = o.variant !== undefined
      ? Math.abs(o.variant | 0) % bufs.length
      : (bufs.length > 1 ? this.rng.u32() % bufs.length : 0);
    const src = ctx.createBufferSource();
    src.buffer = bufs[variant];
    src.playbackRate.value = clamp(o.rate !== undefined ? o.rate : 1, 0.06, 8);
    if (o.loop) src.loop = true;

    const gain = ctx.createGain();
    const vol = (o.volume !== undefined ? o.volume : 1) * d.gain;
    gain.gain.value = clamp(vol, 0, 4);

    let tail = gain;
    let filter = null;
    if (o.cutoff && o.cutoff < 15000) {
      filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = o.cutoff;
      filter.Q.value = 0.5;
      tail.connect(filter);
      tail = filter;
    }
    let panner = null;
    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = clamp(o.pan || 0, -1, 1);
      tail.connect(panner);
      tail = panner;
    }
    src.connect(gain);

    const bus = this.buses[o.bus || (o.loop && d.cat === 'world' ? 'ambience' : 'sfx')];
    tail.connect(bus);

    const send = o.reverb !== undefined ? o.reverb : d.reverb;
    let sendGain = null;
    if (send > 0.02 && this.reverb.buffer) {
      sendGain = ctx.createGain();
      sendGain.gain.value = send;
      tail.connect(sendGain);
      sendGain.connect(this.reverb);
    }

    const when = ctx.currentTime + Math.max(0, o.delay || 0);
    src.start(when);
    const voice = {
      id: this._nextId++, name, prio, src, gain, panner, filter, sendGain, bus,
      def: d, x: o.x, y: o.y, z: o.z, positional: o.positional === true, baseVol: vol,
    };
    if (!o.loop) {
      this.voices.push(voice);
      src.onended = () => {
        const i = this.voices.indexOf(voice);
        if (i >= 0) this.voices.splice(i, 1);
        voice.src = null;
      };
    }
    this.stats.played++;
    return voice;
  }

  // -------------------------------------------------------------------------
  // Public playback API
  // -------------------------------------------------------------------------

  /**
   * Fire a non-positional sound. Never awaited, never throws.
   * @param {string} name bank entry
   * @param {{volume?:number, rate?:number, variant?:number, pan?:number, reverb?:number,
   *          prio?:number, delay?:number}} [opts]
   */
  play(name, opts = {}) {
    if (!this.ctx || !SFX[name]) return null;
    return this._spawn(name, opts);
  }

  /**
   * Fire a sound at a world position. Attenuation, stereo pan and air absorption are all
   * resolved once, at spawn time — one-shots are short enough that tracking them per frame
   * would cost more than it would ever be worth.
   */
  playAt(name, x, y, z, opts = {}) {
    if (!this.ctx) return null;
    const d = SFX[name];
    if (!d) return null;
    if (d.ui) return this._spawn(name, opts);
    const sp = this._spatial(x, y, z, d);
    if (!sp) return null;
    return this._spawn(name, Object.assign({}, opts, {
      volume: (opts.volume !== undefined ? opts.volume : 1) * sp.gain,
      pan: sp.pan, cutoff: sp.cutoff, positional: true, x, y, z,
    }));
  }

  /** Distance gain, stereo pan and air-absorption cutoff, or null when out of range. */
  _spatial(x, y, z, d) {
    const L = this.listener;
    const dx = x - L.x, dy = y - L.y, dz = z - L.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const ref = d.ref || 5, max = d.maxDist || 60;
    if (dist >= max) return null;
    const att = dist <= ref ? 1 : (ref / dist) * (1 - (dist - ref) / (max - ref));
    if (att < 0.004) return null;
    // right vector for yaw = atan2(dx, dz): forward is (sin, cos), so right is (-cos, sin)
    const right = -dx * Math.cos(L.yaw) + dz * Math.sin(L.yaw);
    const spread = clamp01((dist - 1.2) / 3);   // no hard panning right on top of the listener
    const pan = dist > 1e-3 ? clamp(right / dist, -1, 1) * 0.85 * spread : 0;
    const cutoff = lerp(19000, 800, clamp01(Math.sqrt(dist / max)));
    return { gain: att, pan, cutoff, dist };
  }

  /**
   * Start a looping sound. Loops sit outside the one-shot voice cap: they are a small fixed
   * set (weather, fire, a spinning capstan) and letting them compete for combat's voices is
   * exactly the failure this system is meant to prevent.
   * @param {string} name
   * @param {{volume?:number, rate?:number, fadeIn?:number, x?:number, y?:number, z?:number,
   *          bus?:string, reverb?:number}} [opts]
   * @returns {{stop:(fade?:number)=>void, setVolume:(v:number)=>void,
   *            setRate:(r:number)=>void, setPosition:(x:number,y:number,z:number)=>void}}
   */
  loop(name, opts = {}) {
    if (!this.ctx || !SFX[name]) return NULL_LOOP;
    const positional = opts.x !== undefined;
    const d = SFX[name];
    let sp = null;
    if (positional) {
      sp = this._spatial(opts.x, opts.y || 0, opts.z, d);
    }
    const voice = this._spawn(name, Object.assign({}, opts, {
      loop: true,
      volume: (opts.volume !== undefined ? opts.volume : 1) * (sp ? sp.gain : 1),
      pan: sp ? sp.pan : (opts.pan || 0),
      cutoff: sp ? sp.cutoff : 0,
      positional,
    }));
    if (!voice) return NULL_LOOP;

    const ctx = this.ctx;
    const fadeIn = opts.fadeIn !== undefined ? opts.fadeIn : 0.4;
    const target = voice.gain.gain.value;
    if (fadeIn > 0) {
      voice.gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      voice.gain.gain.linearRampToValueAtTime(target, ctx.currentTime + fadeIn);
    }
    voice.userVol = opts.volume !== undefined ? opts.volume : 1;
    voice.spatialGain = sp ? sp.gain : 1;
    this._loops.add(voice);

    const self = this;
    const handle = {
      get playing() { return self._loops.has(voice); },
      stop(fade = 0.35) {
        if (!self._loops.has(voice)) return;
        self._loops.delete(voice);
        self._kill(voice, Math.max(0.01, fade));
      },
      setVolume(v) {
        voice.userVol = clamp(v, 0, 4);
        if (!voice.src) return;
        const g = voice.userVol * voice.def.gain * voice.spatialGain;
        voice.gain.gain.setTargetAtTime(g, self.ctx.currentTime, 0.05);
      },
      setRate(r) {
        if (!voice.src) return;
        voice.src.playbackRate.setTargetAtTime(clamp(r, 0.06, 8), self.ctx.currentTime, 0.05);
      },
      setPosition(x, y, z) {
        voice.x = x; voice.y = y; voice.z = z; voice.positional = true;
      },
    };
    return handle;
  }

  // -------------------------------------------------------------------------
  // Music and ambience
  // -------------------------------------------------------------------------

  /**
   * Crossfade the score to a new state.
   * @param {'calm_sea'|'sail'|'island'|'tension'|'combat'|'boss'|'victory'|'night'} state
   * @param {{fade?:number, immediate?:boolean}} [opts]
   */
  setMusic(state, opts = {}) {
    if (!MUSIC_STATES[state]) return;
    this.musicState = state;
    if (this.music) this.music.setState(state, opts);
  }

  /**
   * Set ambience bed strengths, each 0..1. Beds are created on first use and then simply
   * ride their gain, so switching weather never restarts anything audible.
   * @param {{wind?:number, rain?:number, waves?:number, jungle?:number, underwater?:number}} a
   */
  setAmbience(a = {}) {
    for (const k of AMBIENCE_KEYS) {
      if (a[k] !== undefined) this._ambTarget[k] = clamp01(a[k]);
    }
  }

  /** Where the ears are. yaw follows the project convention: yaw = atan2(dx, dz). */
  setListener(x, y, z, yaw) {
    this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw;
  }

  _ensureBed(key) {
    if (!this.ctx || this._ambLoops[key]) return this._ambLoops[key];
    const names = AMBIENCE_BEDS[key];
    if (!names) return null;
    const beds = names.map((n) => this.loop(n, { volume: 0.0001, fadeIn: 0, bus: 'ambience' }));
    this._ambLoops[key] = beds;
    return beds;
  }

  _applyAmbience() {
    for (const key of AMBIENCE_KEYS) {
      const v = this._amb[key];
      if (key === 'underwater') continue;
      if (v < 0.002 && !this._ambLoops[key]) continue;
      const beds = this._ensureBed(key);
      if (!beds) continue;
      if (key === 'wind') {
        // two beds crossfaded by strength: a gale is not a breeze played louder
        beds[0].setVolume(v * clamp01(1 - (v - 0.35) / 0.4));
        beds[1].setVolume(v * clamp01((v - 0.3) / 0.5));
      } else {
        beds[0].setVolume(v);
      }
    }
    const uw = this._amb.underwater;
    if (this.masterFilter) {
      const now = this.ctx.currentTime;
      // interpolate the cutoff in log frequency: hearing is logarithmic, and a linear sweep
      // spends most of its travel in the top octave where nothing is happening
      const cut = Math.exp(lerp(Math.log(20000), Math.log(420), uw));
      this.masterFilter.frequency.setTargetAtTime(cut, now, 0.12);
      // Underwater ducks the music proportionally to the user's music volume, never over it.
      this.buses.music.gain.setTargetAtTime(this.musicVol * lerp(1, 0.44, uw), now, 0.2);
    }
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * One fixed simulation step. Reads no wall clock: `dt` comes from the fixed timestep and
   * all scheduling is done against the audio hardware clock.
   */
  step(dt) {
    if (!this.ctx) return;
    let changed = false;
    for (const k of AMBIENCE_KEYS) {
      const t = this._ambTarget[k];
      if (Math.abs(this._amb[k] - t) > 1e-4) {
        this._amb[k] = damp(this._amb[k], t, 0.02, dt);
        changed = true;
      }
    }
    if (changed) this._applyAmbience();

    // positional loops follow the listener; there are only ever a handful of them
    for (const v of this._loops) {
      if (!v.positional || !v.src) continue;
      const sp = this._spatial(v.x, v.y || 0, v.z, v.def);
      const now = this.ctx.currentTime;
      v.spatialGain = sp ? sp.gain : 0;
      v.gain.gain.setTargetAtTime((v.userVol || 1) * v.def.gain * v.spatialGain, now, 0.08);
      if (v.panner && sp) v.panner.pan.setTargetAtTime(sp.pan, now, 0.08);
      if (v.filter && sp) v.filter.frequency.setTargetAtTime(sp.cutoff, now, 0.1);
    }

    if (this.music) this.music.step(dt);
  }

  // -------------------------------------------------------------------------
  // Mix / persistence
  // -------------------------------------------------------------------------

  /** @param {number} v 0..1 */
  setMasterVolume(v) {
    this.master = clamp01(v);
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.master, this.ctx.currentTime, 0.05);
    }
  }

  /** Sound-effects bus volume. @param {number} v 0..1 */
  setSfxVolume(v) {
    this.sfxVol = clamp01(v);
    if (this.buses && this.buses.sfx) {
      this.buses.sfx.gain.setTargetAtTime(this.sfxVol, this.ctx.currentTime, 0.05);
    }
  }

  /** Music bus volume. @param {number} v 0..1 */
  setMusicVolume(v) {
    this.musicVol = clamp01(v);
    if (this.buses && this.buses.music) {
      this.buses.music.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.05);
    }
  }

  setMuted(b) {
    this.muted = !!b;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.master, this.ctx.currentTime, 0.05);
    }
  }

  /** Save payload (ARCHITECTURE §7). Only settings — nothing reconstructible from the seed. */
  serialize() {
    return {
      master: this.master,
      muted: this.muted,
      music: this.musicState,
      ambience: Object.assign({}, this._ambTarget),
    };
  }

  deserialize(o) {
    if (!o) return;
    if (typeof o.master === 'number') this.setMasterVolume(o.master);
    if (typeof o.muted === 'boolean') this.setMuted(o.muted);
    if (o.music && MUSIC_STATES[o.music]) this.setMusic(o.music, { immediate: true });
    if (o.ambience) {
      this.setAmbience(o.ambience);
      // restoring a save should not fade the weather in from nothing
      for (const k of AMBIENCE_KEYS) this._amb[k] = this._ambTarget[k];
      if (this.ctx) this._applyAmbience();
    }
  }

  /** Stop everything and release the context. */
  dispose() {
    if (!this.ctx) return;
    for (const v of this.voices.slice()) this._kill(v, 0.01);
    for (const v of Array.from(this._loops)) { this._loops.delete(v); this._kill(v, 0.01); }
    if (this.music) this.music.dispose();
    this._bank.clear();
    if (this.ctx.close) this.ctx.close();
    this.ctx = null;
    this._ready = false;
  }
}

export { SFX_NAMES, MUSIC_STATES };
