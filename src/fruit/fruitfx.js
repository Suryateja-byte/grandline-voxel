// The visual identity of the six devil fruits.
//
// WHY this is not "a particle burst with six tints": a power you cannot name from its
// silhouette is a power the player never learns to fear or to want. So each fruit gets its own
// SHAPE, and the shape is what carries the read:
//
//   gomu   a single stretched limb — one long box that actually reaches from the shoulder to
//          wherever the fist is. Length is the whole read.
//   mera   a rolling volume — overlapping blobs that tumble forward and shed embers upward.
//   hie    crystal growth — angular shards that GROW out of the surface with staggered delays.
//   suna   a streaming column — a helix of small grains rising and dispersing.
//   gura   a cracking ring — a flat expanding ring of shattered plates, plus a decal that stays.
//   zushi  a dark sphere with orbiting debris — solid, still, and it eats the light around it.
//
// Everything is chunky axis-aligned voxels because that is what the rest of the game is
// (ART_BAR §1, §4): per-face shading, 2–3 tonal steps per surface, no soft sprites.
// Colours come only from the P.fruit* entries — telegraph colours belong to the telegraph.
//
// Rendering strategy: one shared voxel material (compiled during App.prewarm because the
// system pushes it into app.extraMaterials before prewarm runs), and two CubeBatch meshes —
// a transient batch rebuilt every frame, and a persistent decal batch for terrain scars.
// Two draw calls for every effect in the game, and zero shader compiles during play.

import * as THREE from 'three';
import { P, mixHex, shadeDown, shadeUp, FACE_SHADE } from '../gen/palette.js';
import { paintSolid } from '../gen/texture.js';
import { makeVoxelMaterial } from '../render/materials.js';
import { clamp, clamp01, lerp, TAU, halton, ease } from '../core/math.js';

/** Tile names this module registers. Kept here so check tooling can assert on them. */
export const FX_TILES = Object.freeze([
  'fx_gomu', 'fx_gomu_deep',
  'fx_mera', 'fx_mera_core',
  'fx_hie', 'fx_hie_deep',
  'fx_suna', 'fx_suna_dark',
  'fx_gura', 'fx_gura_dark',
  'fx_zushi', 'fx_zushi_dark',
  'fx_crack',
]);

/**
 * Which of Cluster C's impact recipes (src/render/fx.js `_impactParticles`) each fruit borrows
 * for its sparks. The bespoke silhouette is ours; the sparks must match the rest of the game.
 */
export const FX_IMPACT_KIND = Object.freeze({
  gomu: 'blunt', mera: 'flame', hie: 'frost', suna: 'sand', gura: 'quake', zushi: 'gravity',
});

/** Signature colour per fruit. Read by the HUD, the wheel, and rig.setAura. */
export const FRUIT_COLORS = Object.freeze({
  gomu: P.fruitGomu,
  mera: P.fruitMera,
  hie: P.fruitHie,
  suna: P.fruitSuna,
  gura: P.fruitGura,
  zushi: P.fruitZushi,
});

/**
 * Register the fruit FX tiles into the texture library.
 *
 * MUST be called before `TextureLibrary.build()` — a DataArrayTexture has a fixed layer count,
 * so a layer added after the upload does not exist on the GPU. The boot path calls this from
 * `App.opts.registerTiles` (see ARCHITECTURE §9, FRUIT request 1).
 *
 * @param {import('../gen/texture.js').TextureLibrary} tex
 */
export function registerFruitFxTiles(tex) {
  const t = (n, paint) => tex.add(n, paint);
  // stepCount gives every surface the 2–3 tonal steps ART_BAR §4 demands; speckle keeps the
  // flat faces from reading as plastic.
  t('fx_gomu', paintSolid(P.fruitGomu, { stepCount: 3, speckle: 0.06, speckleColor: shadeUp(P.fruitGomu, 1) }));
  t('fx_gomu_deep', paintSolid(shadeDown(P.fruitGomu, 0.8), { stepCount: 2, grain: 0.05 }));
  t('fx_mera', paintSolid(P.fruitMera, { stepCount: 3, speckle: 0.14, speckleColor: P.fruitMeraHot }));
  t('fx_mera_core', paintSolid(P.fruitMeraHot, { stepCount: 2, speckle: 0.1, speckleColor: P.fruitMera }));
  t('fx_hie', paintSolid(P.fruitHie, { stepCount: 3, grain: 0.07, speckle: 0.08, speckleColor: 0xffffff }));
  t('fx_hie_deep', paintSolid(P.fruitHieDeep, { stepCount: 3, grain: 0.05 }));
  t('fx_suna', paintSolid(P.fruitSuna, { stepCount: 3, speckle: 0.18, speckleColor: P.fruitSunaDark, grain: 0.1 }));
  t('fx_suna_dark', paintSolid(P.fruitSunaDark, { stepCount: 2, speckle: 0.12, speckleColor: P.fruitSuna }));
  t('fx_gura', paintSolid(P.fruitGura, { stepCount: 3, speckle: 0.07, speckleColor: shadeUp(P.fruitGura, 1) }));
  t('fx_gura_dark', paintSolid(P.fruitGuraDark, { stepCount: 2, grain: 0.08 }));
  t('fx_zushi', paintSolid(P.fruitZushi, { stepCount: 3, speckle: 0.06, speckleColor: shadeUp(P.fruitZushi, 1) }));
  // The zushi core is a *dark* sphere, not a glowing one — it reads as mass, which is the point.
  t('fx_zushi_dark', paintSolid(mixHex(P.fruitZushiDark, P.uiInk, 0.55), { stepCount: 2, grain: 0.04 }));
  t('fx_crack', paintSolid(mixHex(P.rockDark, P.fruitGuraDark, 0.35), { stepCount: 3, speckle: 0.12, speckleColor: P.fruitGura }));
}

// ---------------------------------------------------------------------------
// CubeBatch — many voxels, one draw call, rewritten per frame
// ---------------------------------------------------------------------------

/** Unit-cube corner table, face order matching FACE_SHADE: +Y, -Y, +X, -X, +Z, -Z. */
const CUBE_FACES = [
  { n: [0, 1, 0], v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];
const FACE_UV = [[0, 0], [0, 1], [1, 1], [1, 0]];

/**
 * A preallocated pile of axis-aligned boxes drawn as one mesh.
 *
 * WHY not InstancedMesh: three's program cache key includes `instanceMatrix`, so an instanced
 * material is a *different* program from the prewarmed one and would compile on first use —
 * ARCHITECTURE §1.6 calls that a gate failure. Rewriting 24 floats per box is cheaper than a
 * shader compile and it lets each box carry its own atlas layer.
 */
export class CubeBatch {
  /**
   * @param {number} maxCubes capacity
   * @param {THREE.Material} material shared voxel material
   * @param {string} name
   */
  constructor(maxCubes, material, name) {
    this.max = maxCubes;
    this.count = 0;
    const verts = maxCubes * 24;
    this.pos = new Float32Array(verts * 3);
    this.layer = new Float32Array(verts);
    const nrm = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const shade = new Float32Array(verts);
    const ao = new Float32Array(verts);
    const idx = new Uint32Array(maxCubes * 36);
    for (let c = 0; c < maxCubes; c++) {
      for (let f = 0; f < 6; f++) {
        const face = CUBE_FACES[f];
        for (let k = 0; k < 4; k++) {
          const v = (c * 24) + f * 4 + k;
          nrm[v * 3] = face.n[0]; nrm[v * 3 + 1] = face.n[1]; nrm[v * 3 + 2] = face.n[2];
          uv[v * 2] = FACE_UV[k][0]; uv[v * 2 + 1] = FACE_UV[k][1];
          shade[v] = FACE_SHADE[f];
          ao[v] = 1;
        }
        const base = c * 24 + f * 4;
        const o = (c * 6 + f) * 6;
        idx[o] = base; idx[o + 1] = base + 1; idx[o + 2] = base + 2;
        idx[o + 3] = base; idx[o + 4] = base + 2; idx[o + 5] = base + 3;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aLayer', new THREE.BufferAttribute(this.layer, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
    g.setAttribute('aAo', new THREE.BufferAttribute(ao, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    // FX are local and short-lived; a fixed generous sphere beats recomputing bounds per frame.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.userData.castShadow = false;
    this.mesh.renderOrder = 6;
  }

  begin() { this.count = 0; }

  /**
   * Add one box.
   * @param {number} x @param {number} y @param {number} z centre
   * @param {number} sx @param {number} sy @param {number} sz half-extents in metres
   * @param {number} layer atlas layer index
   * @returns {boolean} false when the batch is full
   */
  cube(x, y, z, sx, sy, sz, layer) {
    if (this.count >= this.max || sx <= 0 || sy <= 0 || sz <= 0) return false;
    const c = this.count++;
    const p = this.pos, L = this.layer;
    let v = c * 24;
    for (let f = 0; f < 6; f++) {
      const cv = CUBE_FACES[f].v;
      for (let k = 0; k < 4; k++, v++) {
        p[v * 3] = x + cv[k][0] * sx;
        p[v * 3 + 1] = y + cv[k][1] * sy;
        p[v * 3 + 2] = z + cv[k][2] * sz;
        L[v] = layer;
      }
    }
    return true;
  }

  /** Upload whatever was written since begin(). */
  end() {
    const verts = this.count * 24;
    const g = this.geometry;
    g.setDrawRange(0, this.count * 36);
    const pa = g.getAttribute('position');
    const la = g.getAttribute('aLayer');
    pa.updateRanges = [{ start: 0, count: verts * 3 }];
    la.updateRanges = [{ start: 0, count: verts }];
    pa.needsUpdate = true;
    la.needsUpdate = true;
    this.mesh.visible = this.count > 0;
  }

  dispose() { this.geometry.dispose(); }
}

// ---------------------------------------------------------------------------
// Effect records
// ---------------------------------------------------------------------------

/** Effects refreshed every step by a running ability expire this long after the last call. */
const HOLD_LIFE = 0.10;
const MAX_RECORDS = 72;
const MAX_CUBES = 1400;
const MAX_DECAL_CUBES = 900;

/**
 * The fruit FX front-end. One instance, owned by FruitSystem.
 *
 * Every method is safe to call before `attach()` (headless checks, or a boot order where FX
 * geometry does not exist): the record is still tracked so the simulation side stays identical,
 * only the geometry write is skipped.
 */
export class FruitFx {
  constructor(sys) {
    this.sys = sys;
    /** @type {Array<object>} live effect records, oldest first */
    this.records = [];
    this.enabled = false;
    this.batch = null;
    this.decals = null;
    this.material = null;
    this.group = null;
    this.layers = null;
    this.time = 0;
    /** Aura currently requested on the player rig: [hex, strength]. */
    this.aura = { hex: P.fruitGomu, v: 0, target: 0 };
    this.stats = { records: 0, cubes: 0, decalCubes: 0 };
    /** Cluster C impact recipe for the burst currently being emitted. */
    this._impactKind = null;
    this._decalDirty = false;
    this._decalCubes = [];
  }

  /**
   * Build geometry and hook into the scene. Called from the FruitSystem factory, which runs
   * inside App.boot's `onSystems` hook — before `prewarmAll()`, so the material compiles there.
   * @param {object} app
   */
  attach(app) {
    this.app = app;
    if (!app || !app.atlas || !app.renderer || !app.tex) return this;
    if (!app.tex.has(FX_TILES[0])) {
      // Tiles were never registered. Run without geometry rather than throwing — the powers
      // still work, they just have no bespoke silhouette. Say so loudly once: a silent
      // degradation here looks like "the fruit has no effects", which is a much worse bug
      // report than "the boot path is missing one call".
      this.missingTiles = true;
      if (typeof console !== 'undefined') {
        console.warn('[fruit] registerFruitFxTiles(tex) was not called from App.opts.registerTiles '
          + '— fruit powers will run without their bespoke effect geometry. See ARCHITECTURE §9.');
      }
      return this;
    }
    this.layers = Object.create(null);
    for (const n of FX_TILES) this.layers[n] = app.tex.layerOf(n);
    this.material = makeVoxelMaterial(app.atlas, app.renderer.shadow.uniforms, {
      name: 'fruitFx', rimBoost: 1.5,
    });
    app.extraMaterials = (app.extraMaterials || []).concat([this.material]);
    this.batch = new CubeBatch(MAX_CUBES, this.material, 'fruitFx');
    this.decals = new CubeBatch(MAX_DECAL_CUBES, this.material, 'fruitDecals');
    this.decals.mesh.renderOrder = 5;
    this.group = new THREE.Group();
    this.group.name = 'fruitFx';
    this.group.userData.castShadow = false;
    this.group.add(this.batch.mesh, this.decals.mesh);
    (app.rootFx || app.scene).add(this.group);
    this.enabled = true;
    return this;
  }

  layerOf(name) { return this.layers ? this.layers[name] : 0; }

  // --- record plumbing -----------------------------------------------------

  /**
   * Create or refresh a record. `key` de-duplicates held effects so an ability calling its
   * fx method every step produces one effect, not sixty.
   */
  _hold(key, kind, p) {
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      if (r.key === key) {
        Object.assign(r, p);
        r.life = HOLD_LIFE; r.age = 0; r.held = true;
        return r;
      }
    }
    return this._push(key, kind, p, HOLD_LIFE, true);
  }

  _push(key, kind, p, life, held) {
    if (this.records.length >= MAX_RECORDS) this.records.shift();
    const r = Object.assign({ key, kind, age: 0, life, held: !!held, t0: this.time }, p);
    this.records.push(r);
    return r;
  }

  _drop(key) {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].key === key) this.records.splice(i, 1);
    }
  }

  /**
   * Age every record. Deterministic: called from the fixed step, never from render.
   * @param {number} dt
   */
  step(dt) {
    this.time += dt;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      r.age += dt;
      if (r.age >= r.life) this.records.splice(i, 1);
    }
    // Aura follows the requested value with a fixed rate so it never pops.
    const d = this.aura.target - this.aura.v;
    const rate = d > 0 ? 6.0 : 2.4;
    this.aura.v = clamp01(this.aura.v + clamp(d, -rate * dt, rate * dt));
    this.stats.records = this.records.length;
  }

  /**
   * Ask the character rig for a fruit aura. Cluster B owns `rig.setAura(hex, strength)`;
   * we degrade to nothing when the rig is not there yet.
   * @param {number} hex colour from P.fruit*
   * @param {number} v 0..1
   */
  setAura(hex, v) {
    this.aura.hex = hex;
    this.aura.target = clamp01(v);
    // Cluster C's FxSystem owns the actor-level aura (it writes actor.aura AND forwards to
    // rig.setAura), so going through it keeps the fruit glow identical to a telegraph tell.
    const f = this.app && this.app.fx;
    const actor = this.sys && this.sys.playerRef;
    if (f && f.setAura && actor) { f.setAura(actor, hex, this.aura.v); return; }
    const rig = this.sys && this.sys.rig;
    if (rig && rig.setAura) rig.setAura(hex, this.aura.v);
  }

  // --- gomu ----------------------------------------------------------------

  /**
   * The stretched limb. `d` carries the cast's origin and direction; `len` is how far the fist
   * has travelled. The limb is ONE long box from shoulder to fist — that is the silhouette.
   */
  gomuLimb(d, len) {
    this._hold('gomu.limb', 'gomuLimb', { ox: d.ox, oy: d.oy, oz: d.oz, dx: d.dx, dy: d.dy, dz: d.dz, len });
    this.setAura(P.fruitGomu, 0.35 + 0.4 * clamp01(len / 18));
    if (this.sys && this.sys.rig && this.sys.rig.setLimbStretch) {
      // Preferred path: the rig's own arm extends, so the limb is genuinely part of the
      // character rather than a prop floating beside it (ARCHITECTURE §9, FRUIT request 3).
      this.sys.rig.setLimbStretch('armR', len, d.dx, d.dy, d.dz);
    }
  }

  gomuLimbEnd() {
    this._drop('gomu.limb');
    this.setAura(P.fruitGomu, 0);
    if (this.sys && this.sys.rig && this.sys.rig.setLimbStretch) this.sys.rig.setLimbStretch('armR', 0, 0, 0, 0);
  }

  gomuGatling(body, k) {
    this._hold('gomu.gat', 'gomuGatling', { x: body.x, y: body.y, z: body.z, yaw: body.yaw, k });
    this.setAura(P.fruitGomu, 0.55 + 0.35 * Math.sin(k * Math.PI));
  }

  gomuGatlingEnd() { this._drop('gomu.gat'); this.setAura(P.fruitGomu, 0); }

  gomuBalloon(body, k) {
    this._hold('gomu.balloon', 'gomuBalloon', { x: body.x, y: body.y, z: body.z, k });
    this.setAura(P.fruitGomu, 0.3 + 0.5 * k);
  }

  gomuBalloonEnd() { this._drop('gomu.balloon'); this.setAura(P.fruitGomu, 0); }

  /** The return shot: the balloon snaps flat and throws a plate of rubber outward. */
  gomuRecoil(body) {
    this._push('gomu.recoil.' + this.records.length, 'gomuRecoil',
      { x: body.x, y: body.y + 1.1, z: body.z, yaw: body.yaw }, 0.42);
    this.appFxBurst(body.x, body.y + 1.1, body.z, P.fruitGomu, 22);
  }

  // --- mera ----------------------------------------------------------------

  meraCone(body, dx, dz, reach, k) {
    this._hold('mera.cone', 'meraCone', { x: body.x, y: body.y + 1.25, z: body.z, dx, dz, reach, k });
    this.setAura(P.fruitMera, 0.5 + 0.4 * k);
  }

  meraConeEnd() { this._drop('mera.cone'); this.setAura(P.fruitMera, 0); }

  meraPillar(x, y, z, k, strength) {
    this._hold('mera.pillar', 'meraPillar', { x, y, z, k, strength });
    this.setAura(P.fruitMera, 0.75);
  }

  meraPillarEnd() { this._drop('mera.pillar'); this.setAura(P.fruitMera, 0); }

  meraKindle(x, y, z, k) {
    this._hold('mera.kindle', 'meraKindle', { x, y, z, k });
    this.setAura(P.fruitMera, 0.4);
  }

  meraKindleEnd() { this._drop('mera.kindle'); this.setAura(P.fruitMera, 0); }

  /** A block just burned away — leave a short-lived flame where it stood. */
  meraBurnMark(x, y, z) {
    this._push('mera.burn.' + Math.round(x * 4) + '_' + Math.round(y * 4) + '_' + Math.round(z * 4),
      'meraBurnMark', { x, y, z }, 1.1);
  }

  // --- hie -----------------------------------------------------------------

  /** An enemy encased. The block grows over 0.25 s then holds for the freeze duration. */
  hieEncase(x, y, z, seconds) {
    this._push('hie.encase.' + this.records.length, 'hieEncase', { x, y, z }, seconds);
    this.setAura(P.fruitHie, 0.8);
    this.appFxBurst(x, y + 1, z, P.fruitHie, 18);
  }

  hieGrow(x, y, z, r) {
    this._push('hie.grow.' + this.records.length, 'hieGrow', { x, y, z, r }, 1.4);
    this.setAura(P.fruitHie, 0.6);
  }

  hieWall(x, y, z, dx, dz, k) {
    this._hold('hie.wall', 'hieWall', { x, y, z, dx, dz, k });
    this.setAura(P.fruitHie, 0.7);
  }

  hieSpike(x, y, z, h) {
    this._push('hie.spike.' + Math.round(x * 8) + '_' + Math.round(z * 8), 'hieSpike', { x, y, z, h }, 2.2);
    this.setAura(P.fruitHie, 0.6);
  }

  hieSpikeEnd() { this.setAura(P.fruitHie, 0); }

  /** A frozen target has been struck — crystalline debris, not a generic puff. */
  shatter(pos) {
    this._push('hie.shatter.' + this.records.length, 'shatter', { x: pos.x, y: pos.y + 1, z: pos.z }, 0.55);
    this.appFxBurst(pos.x, pos.y + 1, pos.z, P.fruitHieDeep, 30);
  }

  /** A walkable sheet of sea ice appeared. Purely a marker; the sheet itself is world voxels. */
  hieSheet(x, y, z, r) {
    this._push('hie.sheet.' + Math.round(x) + '_' + Math.round(z), 'hieSheet', { x, y, z, r }, 0.8);
  }

  // --- suna ----------------------------------------------------------------

  sunaGhost(body, k) {
    this._hold('suna.ghost', 'sunaGhost', { x: body.x, y: body.y, z: body.z, k });
    this.setAura(P.fruitSuna, 0.35 + 0.35 * k);
  }

  sunaGhostEnd() { this._drop('suna.ghost'); this.setAura(P.fruitSuna, 0); }

  /** Wet sand: the body drops out of its own dispersion. Reads as failure, not as a cooldown. */
  sunaCollapse(body) {
    this._push('suna.collapse', 'sunaCollapse', { x: body.x, y: body.y, z: body.z }, 0.7);
    this.appFxBurst(body.x, body.y + 0.8, body.z, P.fruitSunaDark, 26);
  }

  sunaStorm(body, k, integrity) {
    this._hold('suna.storm', 'sunaStorm', { x: body.x, y: body.y, z: body.z, k, integrity });
    this.setAura(P.fruitSuna, 0.5 + 0.4 * k);
  }

  sunaStormEnd() { this._drop('suna.storm'); this.setAura(P.fruitSuna, 0); }

  /** The drain: a thin thread of grains running from the victim back to the caster's hand. */
  sunaDrain(from, to) {
    this._push('suna.drain.' + this.records.length, 'sunaDrain',
      { ax: from.x, ay: from.y + 1.1, az: from.z, bx: to.x, by: to.y + 1.3, bz: to.z }, 0.6);
  }

  /** The burrow column — sand thrown up where the player enters or leaves the ground. */
  sunaBurrow(x, y, z, rising) {
    this._push('suna.burrow.' + this.records.length, 'sunaBurrow', { x, y, z, rising: !!rising }, 0.8);
    this.appFxBurst(x, y + 0.4, z, P.fruitSuna, 24);
  }

  /** The glide stream: a continuous column of grains under the player. */
  sunaStream(body, k) {
    this._hold('suna.stream', 'sunaStream', { x: body.x, y: body.y, z: body.z, k, yaw: body.yaw });
    this.setAura(P.fruitSuna, 0.4);
  }

  sunaStreamEnd() { this._drop('suna.stream'); this.setAura(P.fruitSuna, 0); }

  // --- gura ----------------------------------------------------------------

  guraRing(x, y, z, r, k) {
    this._push('gura.ring.' + this.records.length, 'guraRing', { x, y, z, r }, 0.6);
    this.setAura(P.fruitGura, 0.8);
  }

  guraRingEnd() { this.setAura(P.fruitGura, 0); }

  /**
   * A crack decal that persists. Written into the decal batch once, then left alone — the
   * ground stays broken, which is the whole promise of a quake fruit.
   */
  guraDecal(x, y, z, r) {
    const f = this.app && this.app.fx;
    if (f && f.quakeCrack) f.quakeCrack(x, y, z, r);
    if (!this.enabled) return;
    const rng = this.sys.rng.fork('decal:' + Math.round(x) + ':' + Math.round(z));
    const arms = 5 + (rng.u32() % 3);
    for (let a = 0; a < arms; a++) {
      const ang = (a / arms) * TAU + rng.sym() * 0.35;
      const len = r * (0.5 + rng.f() * 0.6);
      const segs = Math.max(2, Math.round(len / 0.6));
      for (let s = 1; s <= segs; s++) {
        const d = (s / segs) * len;
        const wob = rng.sym() * 0.35;
        const px = x + Math.cos(ang) * d - Math.sin(ang) * wob;
        const pz = z + Math.sin(ang) * d + Math.cos(ang) * wob;
        const py = (this.sys.heightAtSafe(px, pz) || y) + 0.06;
        const w = lerp(0.34, 0.08, s / segs);
        this._decalCubes.push({ x: px, y: py, z: pz, sx: w, sy: 0.06, sz: w, layer: this.layerOf('fx_crack') });
      }
    }
    while (this._decalCubes.length > MAX_DECAL_CUBES) this._decalCubes.shift();
    this._decalDirty = true;
  }

  guraSeaRings(body, k) {
    this._hold('gura.sea', 'guraSeaRings', { x: body.x, y: body.y, z: body.z, k });
    this.setAura(P.fruitGura, 0.9);
  }

  guraSeaRingsEnd() { this._drop('gura.sea'); this.setAura(P.fruitGura, 0); }

  /** The shockwave leap: a compressed disc of cracked plates under the feet. */
  guraLeap(x, y, z) {
    this._push('gura.leap.' + this.records.length, 'guraRing', { x, y, z, r: 4.5 }, 0.5);
    this.appFxBurst(x, y + 0.3, z, P.fruitGura, 26);
  }

  // --- zushi ---------------------------------------------------------------

  zushiWell(x, y, z, k, r) {
    this._hold('zushi.well', 'zushiWell', { x, y, z, k, r });
    const f = this.app && this.app.fx;
    if (f && f.gravityWell && k < 0.05) f.gravityWell(x, y, z, r * 2.2, 0.9);
    this.setAura(P.fruitZushi, 0.6);
  }

  zushiWellEnd() { this._drop('zushi.well'); this.setAura(P.fruitZushi, 0); }

  /** A visible line of pull between a caught target and the well. */
  zushiTether(from, to) {
    this._hold('zushi.tether.' + Math.round(from.x * 2) + '_' + Math.round(from.z * 2), 'zushiTether',
      { ax: from.x, ay: from.y + 1.0, az: from.z, bx: to.x, by: to.y, bz: to.z });
  }

  zushiCrush(x, y, z, r, k) {
    this._hold('zushi.crush', 'zushiCrush', { x, y, z, r, k });
    this.setAura(P.fruitZushi, 0.5 + 0.4 * k);
  }

  zushiCrushEnd() { this._drop('zushi.crush'); this.setAura(P.fruitZushi, 0); }

  zushiSphere(body, k) {
    this._hold('zushi.sphere', 'zushiSphere', { x: body.x, y: body.y + 1.0, z: body.z, k });
    this.setAura(P.fruitZushi, 0.9);
  }

  zushiSphereEnd() { this._drop('zushi.sphere'); this.setAura(P.fruitZushi, 0); }

  zushiImpact(x, y, z, r) {
    this._push('zushi.impact.' + this.records.length, 'zushiImpact', { x, y, z, r }, 0.7);
    this.appFxBurst(x, y + 0.5, z, P.fruitZushi, 34);
  }

  /** The rideable well: the same dark sphere, parked, with a lift column above it. */
  zushiLift(x, y, z, k) {
    this._hold('zushi.lift', 'zushiLift', { x, y, z, k });
    this.setAura(P.fruitZushi, 0.6);
  }

  zushiLiftEnd() { this._drop('zushi.lift'); this.setAura(P.fruitZushi, 0); }

  // --- shared --------------------------------------------------------------

  /** Generic point impact in a fruit's own colour. */
  impactAt(x, y, z, fruitId) {
    const hex = FRUIT_COLORS[fruitId] || P.fruitGomu;
    this._push('impact.' + this.records.length, 'impact', { x, y, z, fruitId }, 0.3);
    this._impactKind = this._kindFor(fruitId);
    this.appFxBurst(x, y, z, hex, 14);
    this._impactKind = null;
  }

  /**
   * Ask Cluster C's shared FX pool for a mote burst. Purely additive: the fruit silhouette is
   * already drawn by this module, so a missing pool costs sparkle, not readability.
   */
  appFxBurst(x, y, z, hex, count) {
    const f = this.app && this.app.fx;
    if (!f || !f.impact) return;
    // fx.impact() is Cluster C's single entry point and it picks the particle recipe from
    // `kind`. Passing the fruit's element there is what makes fruit sparks match sword sparks.
    f.impact({
      pos: [x, y, z],
      kind: this._impactKind || 'blunt',
      strength: clamp(count / 22, 0.2, 1.6),
      hitstop: 0, shake: 0,
    });
  }

  /** Which of Cluster C's impact recipes this fruit's sparks use. */
  _kindFor(fruitId) {
    return FX_IMPACT_KIND[fruitId] || 'blunt';
  }

  /** Wind-up ground marker. Colour is a telegraph colour by design — it is a telegraph. */
  telegraphCircle(x, y, z, r, color, seconds) {
    // Cluster C's `telegraphs()` is a per-frame managed list driven by the telegraph scheduler.
    // A one-shot player wind-up marker is a ground ring, which is the same decal shader and so
    // reads as the same language without borrowing the enemy telegraph pipeline.
    const f = this.app && this.app.fx;
    if (f && f.ring) f.ring(x, y, z, r, color, seconds);
    this._push('tel.' + this.records.length, 'telegraph', { x, y, z, r, color }, seconds);
  }

  // -------------------------------------------------------------------------
  // Geometry build — render only, never mutates simulation state
  // -------------------------------------------------------------------------

  /**
   * Rebuild the transient batch from the current record set.
   * @param {number} alpha interpolation alpha (unused: FX are authored in sim time)
   */
  preRender(alpha) {
    if (!this.enabled) return;
    if (this._decalDirty) this._buildDecals();
    const b = this.batch;
    b.begin();
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      const fn = BUILDERS[r.kind];
      if (fn) fn(this, b, r, clamp01(r.age / r.life));
    }
    b.end();
    this.stats.cubes = b.count;
  }

  _buildDecals() {
    const d = this.decals;
    d.begin();
    for (const c of this._decalCubes) d.cube(c.x, c.y, c.z, c.sx, c.sy, c.sz, c.layer);
    d.end();
    this.stats.decalCubes = d.count;
    this._decalDirty = false;
  }

  /** Forget every persistent decal — used on load and on world regeneration. */
  clearDecals() { this._decalCubes.length = 0; this._decalDirty = true; }

  dispose() {
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    if (this.batch) this.batch.dispose();
    if (this.decals) this.decals.dispose();
    if (this.material) this.material.dispose();
    this.records.length = 0;
    this.enabled = false;
  }
}

// ---------------------------------------------------------------------------
// Builders — one per effect kind. `t` is 0..1 through the record's life.
// ---------------------------------------------------------------------------

/** Deterministic scatter from an integer index; no state, no rng advance. */
function h1(i) { return halton(i, 2); }
function h2(i) { return halton(i, 3); }
function h3(i) { return halton(i, 5); }

const BUILDERS = {

  // GOMU — one long box. The reach IS the effect.
  gomuLimb(fx, b, r) {
    const L = fx.layerOf('fx_gomu');
    const Ld = fx.layerOf('fx_gomu_deep');
    const len = Math.max(0.001, r.len);
    const segs = Math.max(1, Math.min(26, Math.round(len / 0.8)));
    for (let i = 0; i < segs; i++) {
      const d = (i + 0.5) / segs * len;
      // The limb tapers and thins as it stretches — rubber under tension.
      const thin = lerp(0.24, 0.13, i / segs) * lerp(1, 0.72, clamp01(len / 18));
      b.cube(r.ox + r.dx * d, r.oy + r.dy * d, r.oz + r.dz * d, thin, thin, thin, i % 4 === 3 ? Ld : L);
    }
    // The fist: a deliberately chunky block so the business end reads at distance.
    b.cube(r.ox + r.dx * len, r.oy + r.dy * len, r.oz + r.dz * len, 0.42, 0.42, 0.42, L);
  },

  gomuGatling(fx, b, r) {
    const L = fx.layerOf('fx_gomu');
    const Ld = fx.layerOf('fx_gomu_deep');
    const arms = 14;
    for (let i = 0; i < arms; i++) {
      const a = r.yaw + (i / arms) * TAU + r.k * 26;
      const reach = 1.2 + h1(i) * 2.0;
      const y = r.y + 0.9 + h2(i) * 0.9;
      const segs = 3;
      for (let s = 1; s <= segs; s++) {
        const d = (s / segs) * reach;
        b.cube(r.x - Math.sin(a) * d, y, r.z - Math.cos(a) * d, 0.17, 0.17, 0.17, s === segs ? L : Ld);
      }
    }
  },

  gomuBalloon(fx, b, r) {
    const L = fx.layerOf('fx_gomu');
    const R = lerp(0.5, 1.55, ease.outBack(clamp01(r.k)));
    sphereShell(b, r.x, r.y + 1.05, r.z, R, 0.30, L);
  },

  gomuRecoil(fx, b, r, t) {
    const L = fx.layerOf('fx_gomu');
    const R = lerp(0.6, 5.2, ease.outExpo(t));
    const n = 18;
    const s = lerp(0.42, 0.1, t);
    for (let i = 0; i < n; i++) {
      const a = r.yaw + (i / n) * TAU;
      b.cube(r.x - Math.sin(a) * R, r.y + h1(i) * 0.6, r.z - Math.cos(a) * R, s, s, s, L);
    }
  },

  // MERA — a rolling volume that tumbles forward and sheds embers.
  meraCone(fx, b, r) {
    const L = fx.layerOf('fx_mera');
    const Lc = fx.layerOf('fx_mera_core');
    const blobs = 30;
    for (let i = 0; i < blobs; i++) {
      const f = h1(i);
      const d = f * r.reach;
      const spreadR = 0.35 + d * 0.30;
      const px = -r.dz, pz = r.dx;
      const off = (h2(i) * 2 - 1) * spreadR;
      const up = (h3(i) * 2 - 1) * spreadR + Math.sin(f * 6 + r.k * 9) * 0.25;
      // Size grows with distance: the volume rolls outward and opens up.
      const s = lerp(0.30, 0.66, f) * (0.7 + 0.3 * Math.sin(f * 11 + r.k * 14));
      b.cube(r.x + r.dx * d + px * off, r.y + up, r.z + r.dz * d + pz * off, s, s, s, f < 0.35 ? Lc : L);
    }
    // Embers peel off the top of the volume.
    for (let i = 0; i < 8; i++) {
      const f = h2(i);
      const d = f * r.reach;
      b.cube(r.x + r.dx * d, r.y + 0.8 + f * 1.4 + r.k * 0.8, r.z + r.dz * d, 0.11, 0.11, 0.11, Lc);
    }
  },

  meraPillar(fx, b, r) {
    const L = fx.layerOf('fx_mera');
    const Lc = fx.layerOf('fx_mera_core');
    const h = lerp(0.5, 8.0, ease.outQuart(clamp01(r.k))) * (0.4 + 0.6 * (r.strength || 1));
    const rings = Math.max(2, Math.round(h / 0.7));
    for (let i = 0; i < rings; i++) {
      const f = i / rings;
      const rr = lerp(1.25, 0.42, f) + Math.sin(f * 9 + r.k * 8) * 0.16;
      const n = 7;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * TAU + f * 2.4 + r.k * 3;
        const s = lerp(0.34, 0.16, f);
        b.cube(r.x + Math.cos(a) * rr, r.y + 0.3 + f * h, r.z + Math.sin(a) * rr, s, s, s, j % 3 === 0 ? Lc : L);
      }
    }
  },

  meraKindle(fx, b, r) {
    const L = fx.layerOf('fx_mera');
    const Lc = fx.layerOf('fx_mera_core');
    for (let i = 0; i < 20; i++) {
      const a = h1(i) * TAU;
      const rad = 0.6 + h2(i) * 3.6;
      const rise = ((h3(i) + r.k * 1.4) % 1) * 2.2;
      const s = lerp(0.28, 0.09, rise / 2.2);
      b.cube(r.x + Math.cos(a) * rad, r.y + 0.2 + rise, r.z + Math.sin(a) * rad, s, s, s, i % 3 ? L : Lc);
    }
  },

  meraBurnMark(fx, b, r, t) {
    const L = fx.layerOf('fx_mera_core');
    const s = lerp(0.30, 0.04, t);
    b.cube(r.x, r.y + 0.3 + t * 0.9, r.z, s, s * 1.5, s, L);
  },

  // HIE — angular crystal that GROWS. Staggered per shard so it reads as crystallising.
  hieEncase(fx, b, r, t) {
    const L = fx.layerOf('fx_hie');
    const Ld = fx.layerOf('fx_hie_deep');
    const grow = clamp01(t * 6);
    const shrink = t > 0.88 ? 1 - (t - 0.88) / 0.12 : 1;
    const k = grow * shrink;
    b.cube(r.x, r.y + 1.0, r.z, 0.75 * k, 1.15 * k, 0.75 * k, Ld);
    for (let i = 0; i < 10; i++) {
      const g = clamp01((t - i * 0.012) * 8) * shrink;
      if (g <= 0) continue;
      const a = h1(i) * TAU;
      const rad = 0.55 + h2(i) * 0.45;
      const y = 0.25 + h3(i) * 1.8;
      const s = (0.14 + h2(i) * 0.20) * g;
      b.cube(r.x + Math.cos(a) * rad, r.y + y, r.z + Math.sin(a) * rad, s, s * 2.1, s, L);
    }
  },

  hieGrow(fx, b, r, t) {
    const L = fx.layerOf('fx_hie');
    const Ld = fx.layerOf('fx_hie_deep');
    const fade = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    for (let i = 0; i < 22; i++) {
      const g = clamp01((t - i * 0.02) * 7) * fade;
      if (g <= 0) continue;
      const a = h1(i) * TAU;
      const rad = h2(i) * r.r;
      const s = (0.16 + h3(i) * 0.22) * g;
      b.cube(r.x + Math.cos(a) * rad, r.y + s * 0.9, r.z + Math.sin(a) * rad, s, s * 1.5, s, i % 4 ? L : Ld);
    }
  },

  hieWall(fx, b, r) {
    const L = fx.layerOf('fx_hie');
    const Ld = fx.layerOf('fx_hie_deep');
    const k = ease.outQuart(clamp01(r.k));
    const half = 3.0;
    const cols = 9;
    for (let i = 0; i < cols; i++) {
      const f = (i / (cols - 1)) * 2 - 1;
      const off = f * half;
      // The centre grows first; the ends lag, which reads as ice spreading.
      const g = clamp01((k - Math.abs(f) * 0.35) * 1.8);
      if (g <= 0) continue;
      const h = (4.6 - Math.abs(f) * 1.1) * g;
      const x = r.x + r.dx * off, z = r.z + r.dz * off;
      const layers = Math.max(1, Math.round(h / 0.8));
      for (let j = 0; j < layers; j++) {
        const s = lerp(0.42, 0.26, j / layers);
        b.cube(x, r.y + 0.3 + j * 0.8, z, s, 0.42, s, j % 3 === 2 ? Ld : L);
      }
    }
  },

  hieSpike(fx, b, r, t) {
    const L = fx.layerOf('fx_hie');
    const Ld = fx.layerOf('fx_hie_deep');
    const g = clamp01(t * 9) * (t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1);
    const h = r.h * g;
    const seg = 4;
    for (let i = 0; i < seg; i++) {
      const f = i / seg;
      const s = lerp(0.34, 0.07, f);
      b.cube(r.x, r.y + f * h + s, r.z, s, h / seg * 0.6, s, i === seg - 1 ? L : Ld);
    }
  },

  shatter(fx, b, r, t) {
    const L = fx.layerOf('fx_hie');
    const Ld = fx.layerOf('fx_hie_deep');
    for (let i = 0; i < 20; i++) {
      const a = h1(i) * TAU;
      const rad = t * (2.0 + h2(i) * 2.4);
      const y = r.y + h3(i) * 1.6 - t * t * 3.2;
      const s = lerp(0.24, 0.05, t);
      b.cube(r.x + Math.cos(a) * rad, y, r.z + Math.sin(a) * rad, s, s, s, i % 3 ? L : Ld);
    }
  },

  hieSheet(fx, b, r, t) {
    const L = fx.layerOf('fx_hie');
    const g = clamp01(t * 4) * (1 - t);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const rad = r.r * (0.5 + 0.5 * h1(i));
      b.cube(r.x + Math.cos(a) * rad, r.y + 0.12, r.z + Math.sin(a) * rad, 0.4 * g, 0.1, 0.4 * g, L);
    }
  },

  // SUNA — a streaming column of grains. Never a ball; always motion along an axis.
  sunaGhost(fx, b, r) {
    const L = fx.layerOf('fx_suna');
    const Ld = fx.layerOf('fx_suna_dark');
    const n = 34;
    for (let i = 0; i < n; i++) {
      const f = (h1(i) + fx.time * 0.55) % 1;
      const a = h2(i) * TAU + fx.time * 1.6;
      const rad = 0.42 + Math.sin(f * Math.PI) * 0.45;
      const s = lerp(0.13, 0.05, f) * r.k;
      b.cube(r.x + Math.cos(a) * rad, r.y + f * 2.1, r.z + Math.sin(a) * rad, s, s, s, i % 3 ? L : Ld);
    }
  },

  sunaCollapse(fx, b, r, t) {
    const Ld = fx.layerOf('fx_suna_dark');
    for (let i = 0; i < 24; i++) {
      const a = h1(i) * TAU;
      const rad = h2(i) * 1.2;
      const y = r.y + 1.6 * (1 - t) * h3(i);
      const s = lerp(0.16, 0.06, t);
      b.cube(r.x + Math.cos(a) * rad, y, r.z + Math.sin(a) * rad, s, s, s, Ld);
    }
  },

  sunaStorm(fx, b, r) {
    const L = fx.layerOf('fx_suna');
    const Ld = fx.layerOf('fx_suna_dark');
    const rad = lerp(3, 9, ease.outCubic(clamp01(r.k)));
    const n = 64;
    for (let i = 0; i < n; i++) {
      // Grains ride a widening helix — the storm has a direction of travel, not just a radius.
      const spin = fx.time * 3.4 + h1(i) * TAU;
      const rr = rad * (0.35 + 0.65 * h2(i));
      const y = ((h3(i) + fx.time * 0.5) % 1) * 4.2;
      const s = 0.16 * (0.5 + 0.5 * (r.integrity === undefined ? 1 : r.integrity));
      b.cube(r.x + Math.cos(spin) * rr, r.y + 0.2 + y, r.z + Math.sin(spin) * rr, s, s, s, i % 4 ? L : Ld);
    }
  },

  sunaDrain(fx, b, r, t) {
    const Ld = fx.layerOf('fx_suna_dark');
    const n = 14;
    for (let i = 0; i < n; i++) {
      const f = ((i / n) + t * 1.6) % 1;
      const s = lerp(0.13, 0.05, f);
      b.cube(lerp(r.ax, r.bx, f), lerp(r.ay, r.by, f) + Math.sin(f * Math.PI) * 0.35, lerp(r.az, r.bz, f), s, s, s, Ld);
    }
  },

  sunaBurrow(fx, b, r, t) {
    const L = fx.layerOf('fx_suna');
    const n = 22;
    for (let i = 0; i < n; i++) {
      const f = clamp01((t * 1.4) - h1(i) * 0.3);
      const rad = 0.35 + f * 1.5;
      const a = h2(i) * TAU;
      const y = r.y + (r.rising ? f * 2.2 : (1 - f) * 1.4) * (0.4 + h3(i));
      const s = lerp(0.20, 0.05, f);
      b.cube(r.x + Math.cos(a) * rad, y, r.z + Math.sin(a) * rad, s, s, s, L);
    }
  },

  sunaStream(fx, b, r) {
    const L = fx.layerOf('fx_suna');
    const Ld = fx.layerOf('fx_suna_dark');
    const n = 40;
    for (let i = 0; i < n; i++) {
      const f = (h1(i) + fx.time * 1.1) % 1;
      const back = f * 4.5;
      const a = h2(i) * TAU;
      const rad = 0.3 + f * 0.9;
      const s = lerp(0.19, 0.06, f);
      b.cube(
        r.x + Math.sin(r.yaw) * back + Math.cos(a) * rad,
        r.y - 0.35 - f * 0.5 + Math.sin(a) * rad * 0.5,
        r.z + Math.cos(r.yaw) * back + Math.sin(a) * rad,
        s, s, s, i % 3 ? L : Ld,
      );
    }
  },

  // GURA — a flat ring of shattered plates. The ground is the effect.
  guraRing(fx, b, r, t) {
    const L = fx.layerOf('fx_gura');
    const Ld = fx.layerOf('fx_gura_dark');
    const rad = r.r * ease.outExpo(t);
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const jitter = 1 + (h1(i) - 0.5) * 0.22;
      const s = lerp(0.55, 0.14, t) * (0.7 + h2(i) * 0.6);
      const lift = Math.sin(t * Math.PI) * (0.5 + h3(i) * 1.4);
      b.cube(r.x + Math.cos(a) * rad * jitter, r.y + 0.15 + lift, r.z + Math.sin(a) * rad * jitter,
        s, s * 0.55, s, i % 3 ? L : Ld);
    }
  },

  guraSeaRings(fx, b, r) {
    const L = fx.layerOf('fx_gura');
    const Ld = fx.layerOf('fx_gura_dark');
    // Three concentric rings at different phases: the sea answering in sequence.
    for (let ring = 0; ring < 3; ring++) {
      const phase = clamp01(r.k * 1.5 - ring * 0.28);
      if (phase <= 0) continue;
      const rad = lerp(6, 40, ease.outQuad(phase));
      const n = 30;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + ring * 0.1;
        const h = Math.sin(phase * Math.PI) * (2.2 - ring * 0.5);
        b.cube(r.x + Math.cos(a) * rad, r.y + h * 0.5, r.z + Math.sin(a) * rad,
          1.1, Math.max(0.2, h), 1.1, ring === 1 ? Ld : L);
      }
    }
  },

  // ZUSHI — a solid dark sphere with debris in orbit. Still, heavy, distortion-free.
  zushiWell(fx, b, r) {
    const Ld = fx.layerOf('fx_zushi_dark');
    const L = fx.layerOf('fx_zushi');
    const R = r.r * (0.35 + 0.65 * ease.outCubic(clamp01(r.k)));
    sphereShell(b, r.x, r.y, r.z, R * 0.55, R * 0.32, Ld);
    orbitDebris(b, fx.time, r.x, r.y, r.z, R * 1.25, 16, L);
  },

  zushiTether(fx, b, r) {
    const L = fx.layerOf('fx_zushi');
    const n = 8;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const s = lerp(0.16, 0.07, f);
      b.cube(lerp(r.ax, r.bx, f), lerp(r.ay, r.by, f), lerp(r.az, r.bz, f), s, s, s, L);
    }
  },

  zushiCrush(fx, b, r) {
    const L = fx.layerOf('fx_zushi');
    const Ld = fx.layerOf('fx_zushi_dark');
    const n = 24;
    const press = ease.outQuad(clamp01(r.k));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      // A ceiling of mass descending onto the circle.
      const y = r.y + lerp(6.5, 0.6, press) + Math.sin(a * 3) * 0.3;
      b.cube(r.x + Math.cos(a) * r.r * 0.92, y, r.z + Math.sin(a) * r.r * 0.92, 0.5, 0.28, 0.5, i % 3 ? Ld : L);
    }
    for (let i = 0; i < 10; i++) {
      const a = h1(i) * TAU, rad = h2(i) * r.r * 0.75;
      b.cube(r.x + Math.cos(a) * rad, r.y + 0.12, r.z + Math.sin(a) * rad, 0.42 * press, 0.09, 0.42 * press, Ld);
    }
  },

  zushiSphere(fx, b, r) {
    const Ld = fx.layerOf('fx_zushi_dark');
    const L = fx.layerOf('fx_zushi');
    const R = lerp(0.7, 2.1, ease.outBack(clamp01(r.k)));
    sphereShell(b, r.x, r.y, r.z, R, R * 0.42, Ld);
    orbitDebris(b, fx.time, r.x, r.y, r.z, R * 1.5, 12, L);
  },

  zushiImpact(fx, b, r, t) {
    const L = fx.layerOf('fx_zushi');
    const Ld = fx.layerOf('fx_zushi_dark');
    const rad = r.r * ease.outExpo(t);
    const n = 22;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const s = lerp(0.5, 0.1, t);
      b.cube(r.x + Math.cos(a) * rad, r.y + 0.2 + Math.sin(t * Math.PI) * (0.4 + h1(i) * 1.6), r.z + Math.sin(a) * rad,
        s, s, s, i % 4 ? L : Ld);
    }
  },

  zushiLift(fx, b, r) {
    const Ld = fx.layerOf('fx_zushi_dark');
    const L = fx.layerOf('fx_zushi');
    sphereShell(b, r.x, r.y, r.z, 1.1, 0.5, Ld);
    for (let i = 0; i < 12; i++) {
      const f = ((h1(i) + fx.time * 0.9) % 1);
      const a = h2(i) * TAU + fx.time * 2.2;
      b.cube(r.x + Math.cos(a) * 1.4, r.y + f * 7.0, r.z + Math.sin(a) * 1.4, 0.16, 0.16, 0.16, L);
    }
  },

  impact(fx, b, r, t) {
    const name = 'fx_' + (r.fruitId || 'gomu');
    const L = fx.layers && fx.layers[name] !== undefined ? fx.layers[name] : fx.layerOf('fx_gomu');
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = h1(i) * TAU;
      const rad = t * (0.6 + h2(i) * 1.6);
      const s = lerp(0.26, 0.05, t);
      b.cube(r.x + Math.cos(a) * rad, r.y + (h3(i) - 0.35) * 1.1 + t * 0.5, r.z + Math.sin(a) * rad, s, s, s, L);
    }
  },

  // The telegraph is intentionally NOT drawn here — Cluster C owns telegraph rendering so all
  // telegraphs in the game look alike. The record exists only so the timing is observable.
  telegraph() {},
};

/** A hollow-ish voxel sphere: cubes on a Fibonacci shell. Reads round without a mesh. */
function sphereShell(batch, cx, cy, cz, radius, cubeSize, layer) {
  const n = 30;
  const inc = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const a = inc * i;
    batch.cube(cx + Math.cos(a) * rr * radius, cy + y * radius, cz + Math.sin(a) * rr * radius,
      cubeSize, cubeSize, cubeSize, layer);
  }
}

/** Chunks in orbit — the zushi read: mass pulling loose matter around itself. */
function orbitDebris(batch, time, cx, cy, cz, radius, n, layer) {
  for (let i = 0; i < n; i++) {
    const tilt = (h1(i) - 0.5) * 1.4;
    const a = time * (0.9 + h2(i) * 1.3) + h3(i) * TAU;
    const s = 0.11 + h2(i) * 0.16;
    batch.cube(
      cx + Math.cos(a) * radius,
      cy + Math.sin(a) * radius * Math.sin(tilt),
      cz + Math.sin(a) * radius * Math.cos(tilt),
      s, s, s, layer,
    );
  }
}

export default FruitFx;
