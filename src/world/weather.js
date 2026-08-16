// Weather.
//
// Weather is a FIELD, not a state machine: a slow-drifting lattice of cells over the sea,
// each with a hashed severity, sampled bilinearly at the player's position. Sailing into a
// cell is what changes the weather, so the sky ahead of you is information — a dark band on
// the horizon is a squall you are about to enter, and turning away actually avoids it.
//
// It is a pure function of (world seed, position, simulated time). Two runs of the same seed
// see the same front arrive at the same second at the same place, which is what makes a
// stormy shot reproducible in capture and a stormy scenario comparable in the profiler.
//
// Per-island bias (islands.js `weatherBias`) leans the local field: Whisper Sands is nearly
// always clear, Frost Floe is nearly always not.
//
// Rain is one wrapping box of streak quads per layer, not a particle system. The box is 2x
// the height it displays and slides downward, so the loop is seamless and the whole of the
// rain costs two draw calls and one vector write per frame.
//
// PINNING. A field is the right model for play and the wrong model for evidence: a shot that
// asks for `breezy` must get `breezy`, not whatever front happens to be passing the focus on
// step 360. `pin(key)` freezes the system on one preset — the field is not sampled at all while
// pinned, so no amount of simulated time can overwrite it — and `unpin()` hands the sky back to
// the field as an ordinary cross-blend rather than a cut. When nothing is pinned the weather is
// exactly what it always was: a pure function of (seed, position, simulated time).

import * as THREE from 'three';
import { Rng, hash3, mix32, hashFloat } from '../core/rng.js';
import { clamp, clamp01, lerp, halton, TAU } from '../core/math.js';
import { VoxelVolume, meshVolume } from '../gen/voxel.js';
import { WEATHER } from '../render/sky.js';

/** Weather cell edge in metres. A front is a few cells across. */
export const CELL_M = 3600;
/** Cell drift velocity, m/s. About 8 m/s: a front crosses a cell in seven minutes. */
export const DRIFT_X = -7.4;
export const DRIFT_Z = 2.9;

/** Severity band per weather key, and the key order used to classify a severity. */
export const WEATHER_BANDS = Object.freeze([
  { key: 'clear', max: 0.30, severity: 0.14 },
  { key: 'breezy', max: 0.52, severity: 0.40 },
  { key: 'overcast', max: 0.72, severity: 0.62 },
  { key: 'squall', max: 0.88, severity: 0.80 },
  { key: 'storm', max: 1.01, severity: 0.95 },
]);

/** Hysteresis: severity must pass a band edge by this much before the key changes. */
const BAND_HYSTERESIS = 0.035;

const SALT_CELL = 0x3b9aca07;

/**
 * Severity of one weather cell. Pure in (seed, cell coordinate).
 * @param {number} seed @param {number} cx @param {number} cz
 * @returns {number} 0..1
 */
export function cellSeverity(seed, cx, cz) {
  const h = hash3(cx, cz, 0, seed ^ SALT_CELL);
  // Skewed low, because calm is the common case and a uniform draw makes the Grand Line
  // permanently overcast. One cell in sixteen is then promoted to a genuine storm cell: a
  // rare cell that survives the bilinear smoothing instead of being averaged into a drizzle.
  let s = Math.pow(hashFloat(h), 1.8);
  if (hashFloat(mix32(h)) > 0.958) s = clamp01(s * 0.35 + 0.70);
  return s;
}

/**
 * The drifting severity field.
 * @param {number} seed @param {number} x @param {number} z @param {number} t simulated seconds
 * @returns {number} 0..1
 */
export function fieldSeverity(seed, x, z, t) {
  const px = (x - DRIFT_X * t) / CELL_M;
  const pz = (z - DRIFT_Z * t) / CELL_M;
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const s00 = cellSeverity(seed, ix, iz);
  const s10 = cellSeverity(seed, ix + 1, iz);
  const s01 = cellSeverity(seed, ix, iz + 1);
  const s11 = cellSeverity(seed, ix + 1, iz + 1);
  const v = lerp(lerp(s00, s10, sx), lerp(s01, s11, sx), sz);
  // Bilinear interpolation regresses hard to the mean; the contrast curve puts the extremes
  // back so a storm cell still arrives as a storm and not as a grey afternoon.
  return clamp01(0.5 + (v - 0.5) * 1.45);
}

/** Mean severity implied by a weatherBias distribution over the five presets. */
export function biasSeverity(bias) {
  let sum = 0, w = 0;
  for (const band of WEATHER_BANDS) {
    const p = bias[band.key] || 0;
    sum += p * band.severity;
    w += p;
  }
  return w > 0 ? sum / w : 0.4;
}

/** @param {number} sev @returns {string} weather key */
export function keyForSeverity(sev) {
  for (const b of WEATHER_BANDS) if (sev < b.max) return b.key;
  return 'storm';
}

/** The nominal severity of a band, so a pinned key still reports a sensible severity. */
export function severityForKey(key) {
  const b = WEATHER_BANDS.find((w) => w.key === key);
  return b ? b.severity : 0.14;
}

/**
 * Build one wrapping layer of rain streaks.
 * The geometry is 2x boxH tall with the same pattern in both halves, so sliding it down by
 * up to boxH always shows a full, identical-looking box: the loop has no visible seam.
 * @returns {THREE.BufferGeometry}
 */
function buildRainLayer(count, boxW, boxH, streakW, streakH, layer, lean) {
  const pos = [], nor = [], uv = [], lay = [], sha = [], ao = [], idx = [];
  let v = 0;
  const quad = (x, y, z, ax, az) => {
    // Two crossed quads per streak so it reads from any heading without billboarding.
    const hw = streakW * 0.5;
    const x0 = x - hw * ax, z0 = z - hw * az;
    const x1 = x + hw * ax, z1 = z + hw * az;
    const tilt = lean * streakH;
    pos.push(x0, y, z0, x1, y, z1, x1 + tilt, y + streakH, z1, x0 + tilt, y + streakH, z0);
    for (let k = 0; k < 4; k++) { nor.push(0, 0, 1); lay.push(layer); sha.push(1); ao.push(1); }
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    v += 4;
  };
  for (let i = 0; i < count; i++) {
    // Halton keeps the streaks evenly spread, so thinning by draw range stays uniform.
    const x = (halton(i, 2) - 0.5) * boxW;
    const z = (halton(i, 3) - 0.5) * boxW;
    const y = halton(i, 5) * boxH;
    quad(x, y, z, 1, 0);
    quad(x, y, z, 0, 1);
    quad(x, y + boxH, z, 1, 0);
    quad(x, y + boxH, z, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aLayer', new THREE.Float32BufferAttribute(lay, 1));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(sha, 1));
  g.setAttribute('aAo', new THREE.Float32BufferAttribute(ao, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, boxH, 0), boxW);
  g.userData.triangles = idx.length / 3;
  g.userData.perStreak = 24;      // indices per streak (4 quads x 6)
  return g;
}

export class WeatherSystem {
  /**
   * @param {object} app
   * @param {{world?:object, seed?:number, rainStreaks?:number, headless?:boolean}} opts
   */
  constructor(app, opts = {}) {
    this.app = app || null;
    this.world = opts.world || (app && app.world) || null;
    this.seed = (opts.seed !== undefined ? opts.seed : (this.world ? this.world.seed : (app ? app.seed : 1))) >>> 0;
    this.rng = Rng.fromName(this.seed, 'weather');
    this.time = 0;

    this.severity = 0.2;
    this.key = 'clear';
    this.rain = 0;
    this.storm = 0;
    this.wetness = 0;
    this.windAngle = 0.4;
    /**
     * Non-null while the weather is pinned to one preset. Shots and profile scenarios set it;
     * gameplay never does. While it is set, `step()` does not sample the field at all.
     * @type {?string}
     */
    this.pinnedKey = null;
    /** Set while a bolt is on screen; consumed by preRender and pushed to app.post. */
    this.flash = 0;
    this.strikes = 0;
    this.boltTimer = 0;
    this.boltPos = new THREE.Vector3();
    this.nextStrikeIn = 6;

    this.group = null;
    this.rainMeshes = [];
    this.boltMesh = null;
    this._boltGeos = [];

    /**
     * `App.setWeather` before this system wrapped it. Everything in here that wants to move the
     * sky calls this, never `app.setWeather`, so a pin can never recurse into itself.
     * @type {?(key:string, immediate?:boolean)=>void}
     */
    this._setSky = null;
    this._installAppHook();

    if (!opts.headless) this._buildVisuals(opts);
  }

  // --- pinning -------------------------------------------------------------

  /**
   * Wrap `app.setWeather` so its documented "immediate" argument means *pin*, and publish
   * `app.pinWeather` / `app.unpinWeather`.
   *
   * Why a wrapper and not a change in app.js: `setWeather(key, true)` is already the verb every
   * shot and every profile scenario uses to demand a specific sky, and app.js is Cluster A's
   * file. Wrapping it here keeps the two meanings of the call in the one module that owns the
   * distinction — `setWeather(key)` still means "drift there over eighteen seconds", which is
   * what this system itself calls on a band change.
   */
  _installAppHook() {
    const app = this.app;
    if (!app || typeof app.setWeather !== 'function') return;
    if (app.__weatherPinned) return;       // a second WeatherSystem must not double-wrap
    const raw = app.setWeather.bind(app);
    this._setSky = raw;
    const sys = this;
    app.setWeather = function (key, immediate) {
      if (immediate) sys.pin(key);
      else raw(key, false);
    };
    app.pinWeather = (key) => sys.pin(key);
    app.unpinWeather = () => sys.unpin();
    app.__weatherPinned = true;
  }

  /** Move the sky, bypassing the pin wrapper. */
  _sky(key, immediate) {
    if (this._setSky) this._setSky(key, immediate);
    else if (this.app && this.app.setWeather) this.app.setWeather(key, immediate);
  }

  /**
   * Freeze the weather on one preset. Idempotent, and safe to call before the world has
   * streamed: nothing here reads the world.
   * @param {string} key one of WEATHER_BANDS
   * @returns {this}
   */
  pin(key) {
    const preset = WEATHER[key];
    if (!preset) return this;              // unknown key: leave the field alone
    this.pinnedKey = key;
    this.key = key;
    this.severity = severityForKey(key);
    // Snap the derived channels. A pinned shot must BE the weather it asked for on the first
    // frame it renders, not three seconds of lerp later.
    this.rain = preset.rain;
    this.storm = preset.storm;
    this.wetness = preset.rain > 0.05 ? 1 : 0;
    if (this.app && this.app.post) {
      this.app.post.wetness = this.wetness;
      this.app.post.flash = 0;
    }
    this._sky(key, true);
    return this;
  }

  /**
   * Release the pin and let the field take over again. The sky resumes as an ordinary
   * cross-blend toward whatever the field says here and now — never a cut — and rain, storm
   * and wetness lerp back at their normal rates from wherever the pin left them.
   * @returns {this}
   */
  unpin() {
    if (this.pinnedKey === null) return this;
    this.pinnedKey = null;
    const f = this.world ? this.world.focus : { x: 0, z: 0 };
    const want = keyForSeverity(this.sampleAt(f.x, f.z, this.time).severity);
    if (want !== this.key) {
      this._sky(want, false);              // 18 s blend from the pinned preset to the field
      this.key = want;
    }
    return this;
  }

  /** @returns {boolean} */
  get pinned() { return this.pinnedKey !== null; }

  _buildVisuals(opts) {
    const app = this.app;
    if (!app || !app.materials || !app.rootFx) return;
    const tex = app.tex;
    const pick = (want, fallback) => (tex && tex.has(want) ? tex.layerOf(want) : (tex ? tex.layerOf(fallback) : 0));
    const rainLayer = pick('rain_streak', 'sail');

    this.group = new THREE.Group();
    this.group.name = 'weather';
    app.rootFx.add(this.group);

    // Two layers: a dense close one and a sparse wide one. The parallax between them is
    // what makes rain read as volume instead of as a texture on the lens.
    //
    // Streak width is the whole ball game. The first version used 0.10 m near and 0.26 m far,
    // and measured off the storm shot at 1280 px those are 10-20 px wide on screen: the rain
    // read as falling planks. Halved and more, and lengthened to match, a streak is a 3-5 px
    // line — which is what rain is. The streaks are drawn against an alphaTest cutout material
    // so there is no soft edge to hide behind, and thinness is the only lever there is.
    const n0 = opts.rainStreaks || 620;
    const n1 = Math.round(n0 * 0.55);
    const near = buildRainLayer(n0, 34, 15, 0.045, 2.1, rainLayer, 0.22);
    near.userData.rain = { h: 15, speed: 22, count: n0 };
    const far = buildRainLayer(n1, 96, 30, 0.105, 5.0, rainLayer, 0.3);
    far.userData.rain = { h: 30, speed: 15, count: n1 };
    for (const g of [near, far]) {
      const m = new THREE.Mesh(g, app.materials.terrainCutout);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 20;
      this.group.add(m);
      this.rainMeshes.push(m);
    }

    // Lightning bolts: three authored jagged columns, built once at boot so no geometry is
    // created during play and no shader is compiled after prewarm.
    const world = this.world;
    const B = world ? world.B : null;
    const reg = world ? world.reg : null;
    if (B && reg) {
      const bright = B.snow !== undefined ? B.snow : B.metal;
      for (let v = 0; v < 3; v++) {
        const r = Rng.fromName(this.seed, 'bolt' + v);
        const vol = new VoxelVolume(14, 120, 14);
        let x = 7, z = 7;
        for (let y = 119; y >= 0; y--) {
          vol.set(x, y, z, bright);
          vol.set(x + 1, y, z, bright);
          if (r.chance(0.30)) x = clamp(x + r.int(-1, 1), 1, 11);
          if (r.chance(0.24)) z = clamp(z + r.int(-1, 1), 1, 11);
          if (r.chance(0.05) && y > 20) {   // a fork that dies out
            let bx = x, bz = z;
            for (let k = 0; k < r.int(6, 16); k++) {
              bx = clamp(bx + r.int(-1, 1), 0, 13);
              bz = clamp(bz + r.int(-1, 1), 0, 13);
              vol.set(bx, y - k, bz, bright);
            }
          }
        }
        const g = meshVolume(vol, reg, { scale: 0.5, origin: [-3.5, 0, -3.5], ao: false });
        this._boltGeos.push(g);
      }
      this.boltMesh = new THREE.Mesh(this._boltGeos[0], app.materials.terrain);
      this.boltMesh.frustumCulled = false;
      this.boltMesh.visible = false;
      this.group.add(this.boltMesh);
    }
  }

  // --- sampling ------------------------------------------------------------

  /**
   * Weather at an arbitrary point and time. Read this to forecast: the ship's
   * weather-warning crew bonus and the map's storm markers both want it.
   * @param {number} x @param {number} z @param {number} [t] simulated seconds
   * @returns {{severity:number, key:string, rain:number, storm:number, wind:number}}
   */
  sampleAt(x, z, t) {
    const time = t === undefined ? this.time : t;
    let sev = fieldSeverity(this.seed, x, z, time);
    if (this.world) {
      const wb = this.world.weatherBiasAt(x, z);
      if (wb) sev = lerp(sev, biasSeverity(wb.bias), wb.influence * 0.75);
      const ev = this.world.seaEventAt(x, z);
      if (ev) {
        // A becalmed zone is a hole in the weather; a whirlpool churns the sky above it.
        if (ev.kind === 'becalmed') sev = lerp(sev, 0.05, ev.t);
        else if (ev.kind === 'whirlpool') sev = lerp(sev, 0.86, ev.t * 0.7);
      }
    }
    const key = keyForSeverity(sev);
    const preset = WEATHER[key];
    return { severity: sev, key, rain: preset.rain, storm: preset.storm, wind: preset.wind };
  }

  // --- system --------------------------------------------------------------

  /**
   * @param {number} dt @param {object} app
   */
  step(dt, app) {
    const a = app || this.app;
    this.time += dt;
    const pinned = this.pinnedKey !== null;
    // Where the weather is being experienced. Lightning is placed relative to it whether or
    // not the key is pinned, so it is resolved once, outside the branch.
    const f = this.world ? this.world.focus : { x: 0, z: 0 };

    if (pinned) {
      // The field is not sampled at all while pinned. This is the whole point: a shot that
      // simulates six seconds of streaming must not have the sky changed underneath it.
      this.key = this.pinnedKey;
      this.severity = severityForKey(this.key);
    } else {
      const s = this.sampleAt(f.x, f.z, this.time);
      this.severity = s.severity;

      // Hysteresis on the band edge, so a severity hovering on a boundary does not flicker
      // the whole sky back and forth every second.
      const cur = WEATHER_BANDS.find((b) => b.key === this.key) || WEATHER_BANDS[0];
      const wantKey = keyForSeverity(this.severity);
      if (wantKey !== this.key) {
        const idxCur = WEATHER_BANDS.indexOf(cur);
        const idxWant = WEATHER_BANDS.findIndex((b) => b.key === wantKey);
        const edge = idxWant > idxCur ? cur.max : WEATHER_BANDS[Math.max(0, idxCur - 1)].max;
        const past = idxWant > idxCur
          ? this.severity > edge + BAND_HYSTERESIS
          : this.severity < edge - BAND_HYSTERESIS;
        if (past) {
          this.key = wantKey;
          this._sky(wantKey, false);
          if (a && a.audio && a.audio.play) a.audio.play('weather_change', { key: wantKey });
        }
      }
    }

    const preset = WEATHER[this.key];
    // Pinned, the derived channels are held exactly; unpinned they ease as they always did.
    const k = pinned ? 1 : clamp01(dt * 0.35);
    this.rain = lerp(this.rain, preset.rain, k);
    this.storm = lerp(this.storm, preset.storm, k);
    this.windAngle += dt * (0.03 + this.storm * 0.05);

    // Surfaces wet in fourteen seconds and dry in fifty-five. The asymmetry is what sells
    // the transition: the world stays glossy for a while after the squall has passed.
    const raining = this.rain > 0.05;
    this.wetness = pinned ? (raining ? 1 : 0)
      : clamp01(this.wetness + (raining ? dt / 14 : -dt / 55));
    if (a && a.post) a.post.wetness = this.wetness;

    // Lightning. Strike interval is drawn from the simulation stream, so it is part of the
    // deterministic state and lands on the same fixed step on every machine.
    if (this.boltTimer > 0) this.boltTimer = Math.max(0, this.boltTimer - dt);
    this.flash = this.boltTimer > 0 ? clamp01(this.boltTimer / 0.14) : 0;
    if (this.storm > 0.45) {
      this.nextStrikeIn -= dt * (0.4 + this.storm * 2.4);
      if (this.nextStrikeIn <= 0) {
        this.nextStrikeIn = this.rng.range(2.2, 9.5);
        const ang = this.rng.f() * TAU;
        const dist = this.rng.range(180, 900);
        this.boltPos.set(f.x + Math.cos(ang) * dist, 0, f.z + Math.sin(ang) * dist);
        this.boltVariant = this.rng.u32() % 3;
        this.boltTimer = 0.16;
        this.strikes++;
        this.flash = 1;
        if (a && a.audio && a.audio.play) a.audio.play('thunder', { dist });
        if (a && a.fx && a.fx.impact) a.fx.impact({ shake: clamp(0.5 - dist / 2400, 0, 0.4) });
      }
    } else {
      this.nextStrikeIn = this.rng.range(3, 8);
    }
    if (a && a.post) a.post.flash = this.flash;
  }

  /**
   * Render-only. Slides the rain boxes, places the bolt and lifts the exposure during a
   * strike. Sky.env is regenerated from scratch every frame by Cluster A, so modulating it
   * here is a per-frame offset and never accumulates.
   * @param {number} alpha @param {object} app
   */
  preRender(alpha, app) {
    const a = app || this.app;
    if (!a) return;
    const t = this.time;

    if (this.rainMeshes.length) {
      const cam = a.camera ? a.camera.position : null;
      const show = this.rain > 0.03;
      for (let i = 0; i < this.rainMeshes.length; i++) {
        const m = this.rainMeshes[i];
        m.visible = show;
        if (!show) continue;
        const p = m.geometry.userData.rain;
        const fall = (t * p.speed) % p.h;
        if (cam) m.position.set(cam.x, cam.y - p.h * 0.35 - fall, cam.z);
        m.rotation.y = this.windAngle;
        // Intensity by draw range: fewer streaks, same uniform spread, no material change
        // and therefore no shader variant.
        const per = m.geometry.userData.perStreak;
        const streaks = Math.max(1, Math.round(p.count * clamp01(this.rain)));
        m.geometry.setDrawRange(0, streaks * per);
      }
    }

    if (this.boltMesh) {
      const on = this.boltTimer > 0;
      this.boltMesh.visible = on;
      if (on) {
        this.boltMesh.geometry = this._boltGeos[this.boltVariant % this._boltGeos.length];
        this.boltMesh.position.copy(this.boltPos);
      }
    }

    // Sky.update() reassigns exposure, ambientIntensity and rimStrength from scratch at the
    // top of every App.render, so this is a per-frame offset that cannot accumulate. It is
    // the documented lighting channel (ARCHITECTURE section 6) until composite.js consumes
    // app.post.flash directly — see the WORLD request in section 9.
    if (this.flash > 0 && a.sky && a.sky.env) {
      const env = a.sky.env;
      env.exposure *= 1 + this.flash * 0.55;
      env.ambientIntensity *= 1 + this.flash * 0.9;
      env.rimStrength *= 1 + this.flash * 0.6;
    }
  }

  serialize() {
    return {
      time: this.time, key: this.key, wetness: this.wetness,
      rngState: this.rng.s, next: this.nextStrikeIn, pinned: this.pinnedKey,
    };
  }

  deserialize(o) {
    if (!o) return;
    this.time = o.time || 0;
    this.key = o.key || 'clear';
    this.wetness = o.wetness || 0;
    this.pinnedKey = o.pinned || null;
    if (o.rngState) this.rng.s = o.rngState >>> 0;
    if (o.next !== undefined) this.nextStrikeIn = o.next;
    // Restore the sky without pinning: a loaded game must resume the drifting field, and
    // app.setWeather(key, true) now means "pin", which would freeze the player's weather.
    this._sky(this.key, true);
  }

  report() {
    return {
      key: this.key, severity: this.severity, rain: this.rain,
      storm: this.storm, wetness: this.wetness, strikes: this.strikes,
      pinned: this.pinnedKey,
    };
  }

  dispose() {
    // Hand app.setWeather back, or a second App built in the same page inherits a wrapper
    // closed over a disposed system.
    if (this.app && this.app.__weatherPinned && this._setSky) {
      this.app.setWeather = this._setSky;
      this.app.__weatherPinned = false;
    }
    for (const m of this.rainMeshes) m.geometry.dispose();
    this.rainMeshes.length = 0;
    for (const g of this._boltGeos) g.dispose();
    this._boltGeos.length = 0;
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
  }
}

/**
 * Factory used by src/game.js.
 * @param {object} app @param {object} [opts]
 * @returns {WeatherSystem}
 */
export function createWeatherSystem(app, opts = {}) {
  return new WeatherSystem(app, opts);
}

export default WeatherSystem;
