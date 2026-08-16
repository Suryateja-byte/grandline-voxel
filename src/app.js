// The application. Owns boot order, the fixed-step loop, and the render call.
//
// Three run modes, all sharing this exact code path so evidence is never captured from a
// different game than the one people play:
//   'play'    — RAF loop, real input
//   'capture' — no RAF; the harness drives step()/render() explicitly for deterministic shots
//   'profile' — RAF loop with scripted input and the profiler enabled

import * as THREE from 'three';
import { Clock, FIXED_DT } from './core/clock.js';
import { profiler } from './core/profiler.js';
import { parseSeed, Rng } from './core/rng.js';
import { TextureLibrary, registerCommonTiles } from './gen/texture.js';
import { BlockRegistry } from './gen/voxel.js';
import { Renderer } from './render/renderer.js';
import { Sky, WEATHER } from './render/sky.js';
import { Water } from './render/water.js';
import { makeVoxelMaterial, makeActorMaterial, updateShared, rebindAtlas } from './render/materials.js';
import { clamp01, lerp, damp } from './core/math.js';

export const MODE = { PLAY: 'play', CAPTURE: 'capture', PROFILE: 'profile' };

export class App {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.mode = opts.mode || MODE.PLAY;
    this.seed = parseSeed(opts.seed);
    this.opts = opts;
    this.clock = new Clock();
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 7000);
    this.camera.position.set(0, 6, 12);
    this.errors = [];
    this.bootMs = 0;
    this.systems = [];
    this.dayT = opts.dayT !== undefined ? opts.dayT : 0.32;
    this.dayLengthS = 900;            // 15 real minutes per in-game day
    this.timeFrozen = false;
    this.post = { underwater: 0, damage: 0, fruitTint: 0, fruitColor: new THREE.Color(1, 1, 1), exposure: 1, time: 0 };
    this.weatherKey = 'clear';
    this.weatherNext = 'clear';
    this.weatherBlend = 1;
    this.stats = { boot: 0, prewarmMs: 0, tiles: 0 };
  }

  async boot() {
    const t0 = performance.now();

    // --- procedural texture library ---------------------------------------
    this.tex = new TextureLibrary(this.seed);
    registerCommonTiles(this.tex);
    if (this.opts.registerTiles) this.opts.registerTiles(this.tex);
    this.blocks = new BlockRegistry();
    // Character tiles must be registered before the atlas is uploaded — a DataArrayTexture has a
    // fixed layer count, so a layer added later would not exist on the GPU.
    if (this.opts.registerCharacterTiles !== false) {
      const { CHARACTER_SPECS, registerCharacterTiles } = await import('./gen/charmodel.js');
      for (const id of Object.keys(CHARACTER_SPECS)) registerCharacterTiles(this.tex, CHARACTER_SPECS[id]);
      const { registerPropTiles, preparePropBlocks } = await import('./gen/props.js');
      registerPropTiles(this.tex);
      // The block registry must also be complete before the atlas is uploaded: preparePropBlocks
      // registers tiles of its own, and a DataArrayTexture has a fixed layer count. A tile added
      // after build() has no GPU layer, and every face using it samples out of range and renders
      // black — which is exactly how the first assembled build looked.
      const { buildBlocks } = await import('./gen/blocks.js');
      const bb = buildBlocks(this.tex);
      if (preparePropBlocks) preparePropBlocks(this.tex, bb.reg, bb.B);
      this.blocks = bb.reg;
      this.B = bb.B;
      // Fruit FX, weather/world and ship tiles must ALSO exist before the atlas is uploaded.
      // No entry ever passed opts.registerTiles, so the fruit silhouettes and the rain/foam
      // tiles silently degraded (and the ship's late self-registration forced a second atlas
      // upload every boot). Registering here covers every entry in one place; each import is
      // optional so a build without that system still boots.
      for (const [path, fn] of [
        ['./fruit/fruitfx.js', 'registerFruitFxTiles'],
        ['./world/world.js', 'registerWorldTiles'],
        ['./ship/shipmodel.js', 'registerShipTiles'],
      ]) {
        try {
          const m = await import(/* @vite-ignore */ path);
          if (m && typeof m[fn] === 'function') m[fn](this.tex);
        } catch (e) {
          console.warn('[boot] ' + fn + ' skipped: ' + String((e && e.message) || e).split('\n')[0]);
        }
      }
    }

    // --- renderer ----------------------------------------------------------
    this.renderer = new Renderer(this.canvas, {
      msaa: this.opts.msaa !== undefined ? this.opts.msaa : 0,
      shadowSize: this.opts.shadowSize || 1024,
      preserveDrawingBuffer: this.mode === MODE.CAPTURE,
      resolutionScale: this.opts.resolutionScale || 1,
      // Wall-clock-adaptive quality (dynamic resolution, alternate-frame far cascade).
      // Entries opt in explicitly; capture mode must never pass these.
      dynamicRes: !!this.opts.dynamicRes,
      temporalShadows: !!this.opts.temporalShadows,
      drsBudgetMs: this.opts.drsBudgetMs,
      drsUpMarginMs: this.opts.drsUpMarginMs,
    });
    this.renderer.setSize(this.opts.width || 1920, this.opts.height || 1080);
    this.camera.aspect = (this.opts.width || 1920) / (this.opts.height || 1080);
    this.camera.updateProjectionMatrix();

    // --- sky + water -------------------------------------------------------
    this.sky = new Sky();
    this.water = new Water();
    this.scene.add(this.sky.mesh);
    this.scene.add(this.water.mesh);

    // --- material set (all compiled during prewarm) ------------------------
    this.atlas = this.tex.build(this.renderer.gl.capabilities.getMaxAnisotropy ? 4 : 1);
    this.stats.tiles = this.tex.count;
    this.stats.tilesAtUpload = this.tex.count;
    const su = this.renderer.shadow.uniforms;
    this.materials = {
      terrain: makeVoxelMaterial(this.atlas, su, { name: 'terrain', rimBoost: 0.55 }),
      terrainCutout: makeVoxelMaterial(this.atlas, su, {
        name: 'terrainCutout', rimBoost: 0.7, alphaTest: 0.5, side: THREE.DoubleSide,
      }),
      prop: makeVoxelMaterial(this.atlas, su, { name: 'prop', rimBoost: 0.75 }),
      ship: makeVoxelMaterial(this.atlas, su, { name: 'ship', rimBoost: 0.85 }),
      actor: makeActorMaterial(this.atlas, su, { name: 'actor', rimBoost: 1.10 }),
    };

    this.rootStatic = new THREE.Group(); this.rootStatic.name = 'static';
    this.rootActors = new THREE.Group(); this.rootActors.name = 'actors';
    this.rootFx = new THREE.Group(); this.rootFx.name = 'fx';
    this.rootFx.userData.castShadow = false;
    this.scene.add(this.rootStatic, this.rootActors, this.rootFx);

    if (this.opts.onSystems) await this.opts.onSystems(this);

    // A texture array has a fixed layer count. Any tile registered after upload has no GPU
    // storage, and every face using it samples out of range and renders black. This is a hard
    // invariant, so it is asserted rather than trusted.
    this.stats.tilesAfterSystems = this.tex.count;
    if (this.tex.count !== this.stats.tilesAtUpload) {
      const added = this.tex.names.slice(this.stats.tilesAtUpload);
      console.warn('[atlas] ' + added.length + ' tile(s) registered AFTER the texture array was ' +
        'uploaded and have no GPU layer: ' + added.slice(0, 12).join(', ') +
        (added.length > 12 ? ' ...' : ''));
      // Re-upload rather than render black. Costs one extra upload at boot, never during play.
      this.atlas.dispose();
      this.atlas = this.tex.build(4);
      this.stats.materialsRebound = rebindAtlas(this.atlas);
      if (this.onAtlasRebuilt) this.onAtlasRebuilt(this.atlas);
      this.stats.atlasRebuilt = true;
    }

    // --- shader pre-warm ---------------------------------------------------
    this.stats.prewarmMs = await this.prewarmAll();

    this.sky.update(this.dayT, 0);
    this.bootMs = performance.now() - t0;
    this.stats.boot = this.bootMs;
    return this;
  }

  /**
   * Build a throwaway scene containing one tiny mesh per material and compile everything.
   * Runs before the first presented frame so play never stalls on a shader.
   */
  async prewarmAll() {
    const warm = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    geo.setAttribute('aLayer', new THREE.Float32BufferAttribute([0, 0, 0], 1));
    geo.setAttribute('aShade', new THREE.Float32BufferAttribute([1, 1, 1], 1));
    geo.setAttribute('aAo', new THREE.Float32BufferAttribute([1, 1, 1], 1));
    this._warmGeo = geo;
    const mats = Object.values(this.materials).concat(this.extraMaterials || []);
    for (const m of mats) {
      const mesh = new THREE.Mesh(geo, m);
      mesh.frustumCulled = false;
      warm.add(mesh);
    }
    // Share the REAL geometries, not stand-ins. three's program cache key depends on the
    // geometry's attribute set, so warming the ocean material on a PlaneGeometry produces a
    // different key than the ocean's own position-only radial grid and the shader relinks on
    // the first frame. Geometry may safely belong to meshes in two scenes.
    const skyWarm = new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material);
    skyWarm.frustumCulled = false;
    warm.add(skyWarm);
    const waterWarm = new THREE.Mesh(this.water.mesh.geometry, this.water.material);
    waterWarm.frustumCulled = false;
    warm.add(waterWarm);
    // The shadow pass swaps in a depth-only material via scene.overrideMaterial, which
    // compileAsync does not see. Warm it explicitly with a real mesh or it links the first time
    // anything casts a shadow — which is exactly the "zero shader compiles during play" gate.
    const depthWarm = new THREE.Mesh(geo, this.renderer.shadow.depthMat);
    depthWarm.frustumCulled = false;
    warm.add(depthWarm);
    const ms = await this.renderer.prewarm(warm, this.camera);
    warm.clear();
    return ms;
  }

  /** Register a system. Systems are stepped in insertion order — see ARCHITECTURE §4. */
  addSystem(name, sys) {
    sys.__name = name;
    this.systems.push(sys);
    this[name] = sys;
    return sys;
  }

  setWeather(key, immediate) {
    if (immediate) {
      this.weatherKey = key; this.weatherNext = key; this.weatherBlend = 1;
      this.sky.setWeatherBlend(key, key, 1);
    } else {
      this.weatherKey = this.weatherNext;
      this.weatherNext = key;
      this.weatherBlend = 0;
    }
  }

  /** One fixed simulation step. Deterministic. No rendering, no wall-clock reads. */
  step(dt) {
    const p = profiler;
    p.zone('sim');
    if (!this.timeFrozen) this.dayT = (this.dayT + dt / this.dayLengthS) % 1;

    if (this.weatherBlend < 1) {
      this.weatherBlend = clamp01(this.weatherBlend + dt / 18);
      this.sky.setWeatherBlend(this.weatherKey, this.weatherNext, this.weatherBlend);
      if (this.weatherBlend >= 1) this.weatherKey = this.weatherNext;
    }
    this.water.windAngle += dt * 0.004;
    this.water.step(dt);

    for (const s of this.systems) {
      if (s.step) {
        p.zone(s.__name);
        s.step(dt, this);
        p.endZone();
      }
    }
    this.clock.commitStep();
    p.endZone();
  }

  /** Render one frame. Must not mutate simulation state. */
  render(alpha) {
    const p = profiler;
    p.zone('draw');
    const env = this.sky.update(this.dayT, this.clock.simTime);
    this.sky.uniforms.uTime.value = this.clock.simTime;

    for (const s of this.systems) if (s.preRender) s.preRender(alpha, this);

    this.water.update(env, this.camera.position, this.sky.weather);
    updateShared(env, this.camera.position, this.clock.simTime, this.post.wetness || 0);

    this.post.time = this.clock.simTime;
    this.post.exposure = env.exposure;
    const shadowCenter = (this.shadowFocus || this.camera.position);
    this.renderer.render(this.scene, this.camera, env, this.post,
      [this.sky.mesh, this.water.mesh, this.rootFx], shadowCenter);
    p.endZone();
  }

  /** Advance `seconds` of simulation deterministically. Used by capture and playtest. */
  simulate(seconds) {
    const n = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < n; i++) this.step(FIXED_DT);
    return n;
  }

  resize(w, h) {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.renderer.dispose();
    this.sky.dispose();
    this.water.dispose();
    for (const s of this.systems) if (s.dispose) s.dispose();
  }
}
