// The feedback layer. Everything the player feels when something connects.
//
// Hades is the bar: hitstop -> shake -> flash -> knockback -> sound, fired together, every time.
// Miss one and the hit reads as a number changing. This file owns the first four; audio owns the
// fifth and is triggered from combat.js on the same step.
//
// PERFORMANCE CONTRACT — this is not a nicety, it is why the file is shaped like this:
//   * every pool is allocated once, at construction. The hit path never allocates.
//   * three draw calls total for ALL particle, decal and ribbon effects. Everything is batched
//     into three dynamic buffer geometries whose vertex data is rewritten in place each frame.
//   * every material is registered on `app.extraMaterials` BEFORE App.prewarmAll() runs, so all
//     three shaders are compiled during boot (ARCHITECTURE §1.6: zero compiles during play).
//   * the batch geometries carry position/normal/uv exactly like the prewarm stand-in geometry,
//     because three keys its program cache partly on which of those attributes exist — a batch
//     without a `normal` attribute would silently relink on the first frame it drew.
//
// COLOUR — every colour here comes from P.*. The telegraph triad (guard/warn/danger) is passed
// through from combat/telegraph.js untouched; no effect in this file is allowed to use those
// three hues for anything else.

import * as THREE from 'three';
import { P } from '../gen/palette.js';
import { Rng } from '../core/rng.js';
import { clamp, clamp01, lerp, ease, TAU } from '../core/math.js';
import { growthAmount, GROWTH, CB_SHAPE, TELEGRAPH_KIND } from '../combat/telegraph.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Particle visual families. The fragment shader branches on these. */
const PK = { SPARK: 0, MOTE: 1, STREAK: 2, PUFF: 3 };

/** Decal shapes. Matches TELEGRAPH_KIND plus the non-telegraph ground marks. */
const DK = { ARC: 0, LINE: 1, CIRCLE: 2, CONE: 3, POINT: 4, RING: 5, CRACK: 6, WELL: 7 };

/** Colourblind glyph ids. 0 = none. */
const CBG = { NONE: 0, RING: 1, CHEVRON: 2, CROSS: 3 };

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */`
in vec3 aColor;
in vec4 aParam;      // x size, y rotation, z alpha, w kind
in vec4 aParam2;     // x stretch along velocity, y velX, z velZ, w velY
out vec3 vColor;
out vec2 vCorner;
out float vAlpha;
out float vKind;
void main() {
  vColor = aColor;
  vCorner = uv;
  vAlpha = aParam.z;
  vKind = aParam.w;

  // Billboard from the view matrix's basis rows: cheaper and steadier than a lookAt per quad.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  float s = aParam.x;
  float c = cos(aParam.y), sn = sin(aParam.y);
  vec2 q = vec2(uv.x * c - uv.y * sn, uv.x * sn + uv.y * c) * s;

  vec3 world = position + camRight * q.x + camUp * q.y;

  // Streaks stretch along their own velocity so a dash reads as motion, not as dots.
  if (aParam2.x > 0.001) {
    vec3 v = vec3(aParam2.y, aParam2.w, aParam2.z);
    float vl = length(v);
    if (vl > 0.0001) {
      vec3 dir = v / vl;
      world = position + camRight * q.x * 0.35 + camUp * q.y * 0.35 + dir * uv.y * s * aParam2.x;
    }
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const PARTICLE_FRAG = /* glsl */`
precision highp float;
in vec3 vColor;
in vec2 vCorner;
in float vAlpha;
in float vKind;
layout(location = 0) out vec4 fragColor;
void main() {
  float a = vAlpha;
  float r = length(vCorner);
  if (vKind < 0.5) {
    // SPARK: a hot core with a soft falloff. Two steps, not a gradient — the art bar rejects
    // smooth blurs, and a two-step spark still reads as light.
    if (r > 1.0) discard;
    a *= r < 0.45 ? 1.0 : (1.0 - smoothstep(0.45, 1.0, r)) * 0.75;
  } else if (vKind < 1.5) {
    // MOTE: a hard-edged square. ART_BAR §6 wants detached floating voxel motes, so this one
    // deliberately keeps its corners.
    if (abs(vCorner.x) > 1.0 || abs(vCorner.y) > 1.0) discard;
  } else if (vKind < 2.5) {
    // STREAK: a tapered line.
    if (abs(vCorner.x) > 1.0) discard;
    a *= (1.0 - abs(vCorner.y)) * (1.0 - abs(vCorner.x) * 0.6);
  } else {
    // PUFF: soft round, dimmer, for dust and spray.
    if (r > 1.0) discard;
    a *= (1.0 - r) * (1.0 - r);
  }
  if (a <= 0.004) discard;
  fragColor = vec4(vColor * a, a);
}`;

const DECAL_VERT = /* glsl */`
in vec3 aColor;
in vec4 aParam;    // x shape, y t, z halfAngle, w alpha
in vec4 aParam2;   // x growthAmount, y cbGlyph, z sustain, w edgePulse
out vec3 vColor;
out vec2 vLocal;
out vec4 vP;
out vec4 vP2;
void main() {
  vColor = aColor;
  vLocal = uv;
  vP = aParam;
  vP2 = aParam2;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const DECAL_FRAG = /* glsl */`
precision highp float;
in vec3 vColor;
in vec2 vLocal;    // -1..1, +y is the facing direction
in vec4 vP;
in vec4 vP2;
layout(location = 0) out vec4 fragColor;

const float PI = 3.14159265359;

// Signed distance to a stroked ring of radius rr.
float ringBand(float r, float rr, float w) {
  return 1.0 - smoothstep(0.0, w, abs(r - rr));
}

void main() {
  float shape = vP.x;
  float t = vP.y;
  float halfA = vP.z;
  float alpha = vP.w;
  float grow = vP2.x;
  float glyph = vP2.y;
  float sustain = vP2.z;

  float r = length(vLocal);
  float ang = atan(vLocal.x, vLocal.y);   // 0 along +y, the facing direction

  float fill = 0.0;
  float edge = 0.0;
  float lead = 0.0;
  float inside = 0.0;

  if (shape < 0.5 || shape > 2.5 && shape < 3.5) {
    // ARC (0) and CONE (3): a wedge. The cone narrows near the origin.
    float ha = halfA;
    if (shape > 2.5) ha = mix(halfA * 0.25, halfA, clamp(r, 0.0, 1.0));
    if (abs(ang) > ha || r > 1.0) discard;
    inside = 1.0;
    fill = step(r, grow);
    edge = max(ringBand(r, 1.0, 0.075), 1.0 - smoothstep(0.0, 0.055, abs(abs(ang) - ha)));
    // Sweeping leading edge: the rotating hand of the clock.
    float sweepAng = -ha + 2.0 * ha * t;
    lead = 1.0 - smoothstep(0.0, 0.10, abs(ang - sweepAng));
  } else if (shape < 1.5) {
    // LINE (1): a lane. x is across the width, y along the length (0..1 mapped from -1..1).
    if (abs(vLocal.x) > 1.0 || abs(vLocal.y) > 1.0) discard;
    inside = 1.0;
    float along = vLocal.y * 0.5 + 0.5;
    fill = step(along, grow);
    edge = max(1.0 - smoothstep(0.0, 0.09, 1.0 - abs(vLocal.x)),
               1.0 - smoothstep(0.0, 0.045, 1.0 - abs(vLocal.y)));
    lead = 1.0 - smoothstep(0.0, 0.06, abs(along - t));
    r = along;
  } else if (shape < 2.5 || shape > 3.5 && shape < 4.5) {
    // CIRCLE (2) and POINT (4): a disc.
    if (r > 1.0) discard;
    inside = 1.0;
    fill = step(r, grow);
    edge = ringBand(r, 1.0, 0.07);
    lead = ringBand(r, grow, 0.05);
  } else if (shape < 5.5) {
    // RING (5): an impact shockwave — outline only, expanding.
    if (r > 1.0) discard;
    inside = 1.0;
    edge = ringBand(r, max(0.08, grow), 0.10 + 0.12 * t);
    fill = 0.0;
  } else if (shape < 6.5) {
    // CRACK (6): a quake fracture. Radial splinters, hard-edged, no soft glow.
    if (r > 1.0) discard;
    inside = 1.0;
    float spokes = abs(sin(ang * 4.0 + 0.7));
    float w = 0.10 + 0.16 * (1.0 - r);
    float branch = 1.0 - smoothstep(0.0, w, spokes);
    edge = branch * step(r, grow) + ringBand(r, grow, 0.06) * 0.7;
    fill = branch * step(r, grow) * 0.55;
  } else {
    // WELL (7): a gravity well. Concentric rings pulled inward.
    if (r > 1.0) discard;
    inside = 1.0;
    float rings = fract(r * 3.0 + t * 1.6);
    edge = (1.0 - smoothstep(0.0, 0.22, rings)) * (1.0 - r * 0.4);
    fill = (1.0 - r) * 0.30;
  }

  // Colourblind glyphs. Drawn ON TOP, in the same colour, so the shape carries the meaning even
  // when the hue does not survive the viewer's perception.
  float g = 0.0;
  if (glyph > 0.5) {
    vec2 p = vLocal * 2.2;
    float pr = length(p);
    if (glyph < 1.5) {
      g = ringBand(pr, 0.72, 0.11);                            // RING = blockable / parryable
    } else if (glyph < 2.5) {
      float v = abs(p.x) - (p.y + 0.55);                       // CHEVRON = dodgeable
      g = (1.0 - smoothstep(0.0, 0.16, abs(v))) * step(pr, 1.05);
    } else {
      float d = min(abs(p.x - p.y), abs(p.x + p.y));           // CROSS = unblockable
      g = (1.0 - smoothstep(0.0, 0.14, d)) * step(pr, 0.95);
    }
  }

  float a = inside * alpha * (fill * 0.30 + edge * 0.95 + lead * 0.85 + g * 0.9);
  // The strike flash: on the frame the attack lands the whole footprint goes bright, then fades.
  a += inside * alpha * sustain * 0.55;
  if (a <= 0.006) discard;
  vec3 col = vColor * (1.0 + (lead + g) * 0.8 + sustain * 1.2);
  fragColor = vec4(col * min(a, 1.6), clamp(a, 0.0, 0.92));
}`;

const RIBBON_VERT = /* glsl */`
in vec3 aColor;
in vec4 aParam;   // x alpha, y age 0..1, z across -1..1, w unused
out vec3 vColor;
out vec4 vP;
void main() {
  vColor = aColor;
  vP = aParam;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

const RIBBON_FRAG = /* glsl */`
precision highp float;
in vec3 vColor;
in vec4 vP;
layout(location = 0) out vec4 fragColor;
void main() {
  // Bright core, fast falloff across the ribbon; fades along its length so the tail dissolves.
  float across = abs(vP.z);
  float a = vP.x * (1.0 - across * across) * (1.0 - vP.y * vP.y);
  if (a <= 0.005) discard;
  fragColor = vec4(vColor * (1.0 + (1.0 - across) * 1.4) * a, a);
}`;

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

/**
 * A quad batch: N quads sharing one geometry, rewritten in place every frame.
 * `normal` and `uv` are written once and never touched again — `uv` carries the corner.
 */
class QuadBatch {
  /**
   * @param {number} capacity quads
   * @param {THREE.Material} material
   * @param {string[]} extraAttrs names of the extra vec3/vec4 attributes
   * @param {number[]} extraSizes their item sizes
   */
  constructor(capacity, material, extraAttrs, extraSizes) {
    this.capacity = capacity;
    this.count = 0;
    const v = capacity * 4;
    this.pos = new Float32Array(v * 3);
    this.geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(this.pos, 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', posAttr);

    // Static: a constant up-normal (present purely so the program cache key matches the
    // prewarm geometry) and the corner coordinates in uv.
    const nrm = new Float32Array(v * 3);
    const uvs = new Float32Array(v * 2);
    for (let i = 0; i < capacity; i++) {
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k) * 3;
        nrm[o] = 0; nrm[o + 1] = 1; nrm[o + 2] = 0;
      }
      const u = i * 8;
      uvs[u] = -1; uvs[u + 1] = -1;
      uvs[u + 2] = 1; uvs[u + 3] = -1;
      uvs[u + 4] = 1; uvs[u + 5] = 1;
      uvs[u + 6] = -1; uvs[u + 7] = 1;
    }
    this.geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.uvArr = uvs;

    this.extra = {};
    for (let i = 0; i < extraAttrs.length; i++) {
      const size = extraSizes[i];
      const arr = new Float32Array(v * size);
      const at = new THREE.BufferAttribute(arr, size);
      at.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(extraAttrs[i], at);
      this.extra[extraAttrs[i]] = arr;
    }

    const idx = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const b = i * 4, o = i * 6;
      idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
      idx[o + 3] = b; idx[o + 4] = b + 2; idx[o + 5] = b + 3;
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    // A fixed, generous bounding sphere: FX are spawned around the camera and recomputing the
    // bounds every frame costs more than the culling saves.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.userData.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
  }

  begin() { this.count = 0; }

  /** Write one quad's four world corners. @returns {number} the quad index, or -1 when full */
  pushQuad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const o = i * 12;
    const p = this.pos;
    p[o] = x0; p[o + 1] = y0; p[o + 2] = z0;
    p[o + 3] = x1; p[o + 4] = y1; p[o + 5] = z1;
    p[o + 6] = x2; p[o + 7] = y2; p[o + 8] = z2;
    p[o + 9] = x3; p[o + 10] = y3; p[o + 11] = z3;
    return i;
  }

  /** Write one billboard quad: the same centre repeated four times. */
  pushPoint(x, y, z) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const o = i * 12;
    const p = this.pos;
    for (let k = 0; k < 4; k++) { p[o + k * 3] = x; p[o + k * 3 + 1] = y; p[o + k * 3 + 2] = z; }
    return i;
  }

  /** Fill an extra attribute for all four vertices of quad `i`. */
  setVec3(name, i, a, b, c) {
    const arr = this.extra[name];
    const o = i * 12;
    for (let k = 0; k < 4; k++) { arr[o + k * 3] = a; arr[o + k * 3 + 1] = b; arr[o + k * 3 + 2] = c; }
  }

  setVec4(name, i, a, b, c, d) {
    const arr = this.extra[name];
    const o = i * 16;
    for (let k = 0; k < 4; k++) {
      arr[o + k * 4] = a; arr[o + k * 4 + 1] = b; arr[o + k * 4 + 2] = c; arr[o + k * 4 + 3] = d;
    }
  }

  /** Per-vertex vec4 (used by ribbons, whose vertices differ across the strip). */
  setVec4At(name, i, k, a, b, c, d) {
    const arr = this.extra[name];
    const o = i * 16 + k * 4;
    arr[o] = a; arr[o + 1] = b; arr[o + 2] = c; arr[o + 3] = d;
  }

  end() {
    const n = this.count;
    this.geo.setDrawRange(0, n * 6);
    this.geo.attributes.position.addUpdateRange(0, n * 12);
    this.geo.attributes.position.needsUpdate = true;
    for (const k in this.extra) {
      const at = this.geo.attributes[k];
      at.addUpdateRange(0, n * 4 * at.itemSize);
      at.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
  }

  dispose() { this.geo.dispose(); }
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

function makeParticle() {
  return {
    alive: false, kind: PK.SPARK,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    r: 1, g: 1, b: 1,
    size: 0.1, size1: 0.02, rot: 0, spin: 0,
    life: 0, maxLife: 0.5, drag: 2.2, grav: 1, stretch: 0, alpha: 1,
    fadeIn: 0,
  };
}

function makeDecal() {
  return {
    alive: false, shape: DK.CIRCLE,
    x: 0, y: 0, z: 0, dirX: 0, dirZ: 1,
    radius: 1, halfAngle: 1, width: 1,
    r: 1, g: 1, b: 1,
    life: 0, maxLife: 1, alpha: 1, t: 0, grow: 0, sustain: 0,
    glyph: CBG.NONE, growth: GROWTH.FILL,
    /** Telegraph decals are rebuilt every frame from live commands; marks persist on their own. */
    managed: false,
  };
}

function makeTrail() {
  const N = 14;
  return {
    alive: false, n: 0, head: 0, life: 0, maxLife: 0.26,
    r: 1, g: 1, b: 1, width: 0.24,
    // Ring buffer of spine points: (tip, hilt) pairs.
    tx: new Float64Array(N), ty: new Float64Array(N), tz: new Float64Array(N),
    hx: new Float64Array(N), hy: new Float64Array(N), hz: new Float64Array(N),
    age: new Float64Array(N),
    cap: N,
  };
}

// ---------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------

/**
 * FX. One entry point for combat (`impact`), a handful of named effects for everything else, and
 * a per-frame budget so a crowd fight never turns into a strobe.
 */
export class FxSystem {
  /**
   * @param {object} app
   * @param {{particles?:number, decals?:number, trails?:number, seed?:number}} [opts]
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.rng = Rng.fromName((opts.seed !== undefined ? opts.seed : (app && app.seed) || 1) >>> 0, 'fx');

    const nP = opts.particles || 900;
    const nD = opts.decals || 120;
    const nT = opts.trails || 12;

    this.particles = new Array(nP);
    for (let i = 0; i < nP; i++) this.particles[i] = makeParticle();
    this._pNext = 0;

    this.decals = new Array(nD);
    for (let i = 0; i < nD; i++) this.decals[i] = makeDecal();

    this.trails = new Array(nT);
    for (let i = 0; i < nT; i++) this.trails[i] = makeTrail();

    // --- screen shake -------------------------------------------------------
    // Trauma model: callers add trauma, the shake is trauma^2 so small hits barely move the
    // camera and big ones do. A BUDGET refills over time and is spent by every addition, so ten
    // simultaneous hits cannot sum into a seizure — the tenth hit gets almost nothing.
    this.shake = { x: 0, y: 0, roll: 0, trauma: 0 };
    this._shakeBudget = 1;
    this._shakeT = 0;

    // --- hitstop ------------------------------------------------------------
    // Same idea. Hitstop is the strongest feedback tool available and also the easiest to abuse:
    // unbudgeted, a crowd fight becomes a slideshow.
    this._hitstopBudget = 1;

    /** Effects requested this frame, for the profiler and the self-check. */
    this.stats = {
      particles: 0, decals: 0, trails: 0, impacts: 0,
      hitstops: 0, shakes: 0, flashes: 0, damageNumbers: 0,
    };

    /** Persistent ground marks (quake cracks, gravity wells) survive across frames. */
    this._marks = [];

    this._built = false;
    this._speedLineT = 0;
    // One reusable projection closure for damage numbers. Allocating one per hit would put a
    // closure in the hit path, which is exactly what this file promises not to do.
    this._projVec = null;
    this._project = null;

    if (app && app.scene !== undefined) this._buildGpu(app);
  }

  /**
   * Build materials and batches, and register the materials for prewarm.
   * Split out so the system can also be constructed headless (the self-check does exactly that).
   */
  _buildGpu(app) {
    const base = {
      glslVersion: THREE.GLSL3,
      depthTest: true,
      depthWrite: false,
      transparent: true,
      fog: false,
      toneMapped: false,
    };
    this.particleMat = new THREE.ShaderMaterial(Object.assign({}, base, {
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {},
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }));
    this.particleMat.name = 'fxParticle';

    this.decalMat = new THREE.ShaderMaterial(Object.assign({}, base, {
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      uniforms: {},
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      // Ground decals sit 6 cm above the surface AND use a polygon offset: 6 cm alone z-fights on
      // a slope, and offset alone loses to a step in the voxel grid.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    }));
    this.decalMat.name = 'fxDecal';

    this.ribbonMat = new THREE.ShaderMaterial(Object.assign({}, base, {
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      uniforms: {},
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }));
    this.ribbonMat.name = 'fxRibbon';

    this.particleBatch = new QuadBatch(this.particles.length, this.particleMat,
      ['aColor', 'aParam', 'aParam2'], [3, 4, 4]);
    this.decalBatch = new QuadBatch(this.decals.length + 32, this.decalMat,
      ['aColor', 'aParam', 'aParam2'], [3, 4, 4]);
    this.ribbonBatch = new QuadBatch(this.trails.length * 16, this.ribbonMat,
      ['aColor', 'aParam'], [3, 4]);

    this.root = new THREE.Group();
    this.root.name = 'fx';
    this.root.userData.castShadow = false;
    this.root.add(this.particleBatch.mesh, this.decalBatch.mesh, this.ribbonBatch.mesh);
    // Decals under particles, particles over everything: an impact ring behind its own sparks.
    this.decalBatch.mesh.renderOrder = 20;
    this.ribbonBatch.mesh.renderOrder = 21;
    this.particleBatch.mesh.renderOrder = 22;

    if (app.rootFx) app.rootFx.add(this.root);
    else if (app.scene) app.scene.add(this.root);

    // Register for the boot-time shader compile. App.prewarmAll() reads this array after
    // onSystems() and before the first presented frame.
    if (!app.extraMaterials) app.extraMaterials = [];
    app.extraMaterials.push(this.particleMat, this.decalMat, this.ribbonMat);

    this._projVec = new THREE.Vector3();
    const self = this;
    this._project = function projectWorld(w) {
      const cam = self.app.camera;
      const ui = self.app.ui;
      if (!cam) return null;
      const v = self._projVec;
      v.set(w.x, w.y, w.z);
      v.project(cam);
      const vis = v.z < 1 && v.x >= -1.25 && v.x <= 1.25 && v.y >= -1.25 && v.y <= 1.25;
      const W = ui && ui.w ? ui.w : 1920;
      const H = ui && ui.h ? ui.h : 1080;
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H, visible: vis };
    };
    this._built = true;
  }

  // -------------------------------------------------------------------------
  // Particle spawning
  // -------------------------------------------------------------------------

  /** Take a free particle, recycling the oldest when full. */
  _p() {
    const arr = this.particles;
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      const p = arr[(this._pNext + i) % n];
      if (!p.alive) { this._pNext = (this._pNext + i + 1) % n; return p; }
    }
    const p = arr[this._pNext];
    this._pNext = (this._pNext + 1) % n;
    return p;
  }

  /**
   * Emit one particle. All parameters explicit — a spawn helper with option objects would
   * allocate one object per particle, which is the whole problem.
   */
  emit(kind, x, y, z, vx, vy, vz, colour, size, size1, maxLife, drag, grav, stretch, alpha) {
    const p = this._p();
    p.alive = true;
    p.kind = kind;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    const col = colour;
    p.r = ((col >> 16) & 255) / 255;
    p.g = ((col >> 8) & 255) / 255;
    p.b = (col & 255) / 255;
    p.size = size; p.size1 = size1;
    p.rot = this.rng.f() * TAU;
    p.spin = this.rng.sym() * 6;
    p.life = 0; p.maxLife = maxLife;
    p.drag = drag; p.grav = grav; p.stretch = stretch;
    p.alpha = alpha !== undefined ? alpha : 1;
    return p;
  }

  // -------------------------------------------------------------------------
  // Named effects
  // -------------------------------------------------------------------------

  /**
   * THE entry point cluster C uses. Everything a landed hit needs, from one call.
   *
   * @param {object} o
   * @param {{x:number,y:number,z:number}|number[]} o.pos impact point
   * @param {{x:number,z:number}|number[]} [o.dir] impact direction (attacker -> target)
   * @param {string} [o.kind] 'slash'|'stab'|'blunt'|'slam'|'explode'|'bullet'|'block'|'parry'|
   *                          'crit'|'flame'|'frost'|'sand'|'quake'|'gravity'|'water'|'sanction'
   * @param {number} [o.strength] 0..2; 1 is a normal hit
   * @param {object} [o.target] the struck actor — gets the white flash
   * @param {number} [o.damage] routed to the UI as a damage number when present
   * @param {boolean} [o.crit]
   * @param {number} [o.hitstop] seconds; defaults from strength
   * @param {number} [o.shake] trauma 0..1; defaults from strength
   */
  impact(o) {
    // impact() is called from combat, fruit powers, the ship and the weather system. A caller
    // that omits `pos` (weather lightning, for example, which is a screen-wide event) should get
    // a screen-space effect, not a crash in the middle of a frame.
    const pos = o && o.pos;
    if (!pos) {
      if (o && (o.shake || o.hitstop)) {
        if (o.shake) this.addShake(o.shake);
        if (o.hitstop && this.app && this.app.clock) this.app.clock.addHitstop(o.hitstop);
      }
      return;
    }
    const x = Array.isArray(pos) ? pos[0] : pos.x;
    const y = Array.isArray(pos) ? pos[1] : pos.y;
    const z = Array.isArray(pos) ? pos[2] : pos.z;
    let dx = 0, dz = 1;
    if (o.dir) {
      dx = Array.isArray(o.dir) ? o.dir[0] : o.dir.x;
      dz = Array.isArray(o.dir) ? o.dir[2] !== undefined ? o.dir[2] : o.dir.z : o.dir.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) { dx /= d; dz /= d; } else { dx = 0; dz = 1; }
    }
    const kind = o.kind || 'slash';
    const s = clamp(o.strength !== undefined ? o.strength : 1, 0.1, 2.5);
    this.stats.impacts++;

    // --- 1. hitstop --------------------------------------------------------
    const stop = o.hitstop !== undefined ? o.hitstop : 0.05 + 0.05 * s;
    this.addHitstop(stop);

    // --- 2. shake ----------------------------------------------------------
    const trauma = o.shake !== undefined ? o.shake : 0.10 + 0.22 * s;
    this.addShake(trauma);

    // --- 3. flash on the struck body ---------------------------------------
    if (o.target) this.setFlash(o.target, o.crit ? P.critFlash : P.hitFlash, o.crit ? 1 : 0.85);

    // --- 4. particles, per kind -------------------------------------------
    this._impactParticles(kind, x, y, z, dx, dz, s, !!o.crit);

    // --- 5. ground mark ----------------------------------------------------
    if (kind === 'slam' || kind === 'explode' || kind === 'quake' || kind === 'sanction') {
      this.ring(x, this._groundY(x, z, y), z, kind === 'quake' ? 4.0 * s : 2.6 * s,
        kind === 'quake' ? P.fruitGuraDark : P.hitFlash, 0.45);
    }
    if (kind === 'quake') this.quakeCrack(x, this._groundY(x, z, y), z, 3.2 * s);
    if (kind === 'gravity') this.gravityWell(x, this._groundY(x, z, y), z, 4.0 * s, 0.9);

    // --- 6. damage number --------------------------------------------------
    if (o.damage !== undefined && o.damage > 0) {
      this.damageNumber(x, y + 0.5, z, Math.round(o.damage),
        o.crit ? 'crit' : kind === 'block' ? 'block' : kind === 'parry' ? 'parry' : 'hit');
    }
    return this;
  }

  /** Particle recipe per impact kind. Each one has to be nameable with the sound off. */
  _impactParticles(kind, x, y, z, dx, dz, s, crit) {
    const rng = this.rng;
    const n = Math.round(lerp(5, 16, clamp01(s / 2)) );
    switch (kind) {
      case 'parry': {
        // A tight cyan starburst: the single most important read in the game.
        for (let i = 0; i < 22; i++) {
          const a = (i / 22) * TAU + rng.range(-0.1, 0.1);
          const sp = rng.range(7, 14);
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * sp, rng.range(1, 6), Math.cos(a) * sp,
            i % 3 === 0 ? P.parrySpark : P.telegraphGuard, 0.30, 0.02, 0.34, 5.5, 0.4, 0, 1);
        }
        this.ringAt(x, y, z, 1.9, P.parrySpark, 0.30);
        break;
      }
      case 'block': {
        for (let i = 0; i < 8; i++) {
          const a = Math.atan2(-dx, -dz) + rng.range(-0.7, 0.7);
          const sp = rng.range(3, 7);
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * sp, rng.range(0.5, 3), Math.cos(a) * sp,
            P.metal, 0.16, 0.02, 0.22, 6, 1.2, 0, 0.9);
        }
        break;
      }
      case 'stab':
      case 'slash': {
        // Sparks along the blade direction plus stylised motes — bloodless by design (P.bloodless).
        for (let i = 0; i < n; i++) {
          const spread = kind === 'stab' ? 0.35 : 0.95;
          const a = Math.atan2(dx, dz) + rng.range(-spread, spread);
          const sp = rng.range(4, 11) * s;
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * sp, rng.range(1.5, 5.5), Math.cos(a) * sp,
            crit ? P.critFlash : P.hitFlash, crit ? 0.26 : 0.19, 0.02, 0.26, 5.5, 1.1, 0, 1);
        }
        for (let i = 0; i < Math.round(n * 0.6); i++) {
          const a = rng.f() * TAU;
          const sp = rng.range(1.5, 4.5) * s;
          this.emit(PK.MOTE, x, y, z, Math.sin(a) * sp, rng.range(2, 5), Math.cos(a) * sp,
            P.bloodless, 0.10, 0.03, rng.range(0.4, 0.75), 2.2, 1.0, 0, 0.95);
        }
        break;
      }
      case 'blunt': {
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(dx, dz) + rng.range(-1.2, 1.2);
          const sp = rng.range(2.5, 7) * s;
          this.emit(PK.PUFF, x, y, z, Math.sin(a) * sp, rng.range(1, 4), Math.cos(a) * sp,
            P.bloodless, 0.24, 0.06, 0.42, 3.4, 0.5, 0, 0.75);
        }
        break;
      }
      case 'slam':
      case 'explode': {
        const count = kind === 'explode' ? 34 : 24;
        for (let i = 0; i < count; i++) {
          const a = (i / count) * TAU + rng.range(-0.15, 0.15);
          const sp = rng.range(6, 16) * s;
          this.emit(PK.MOTE, x, y + 0.15, z, Math.sin(a) * sp, rng.range(2, 9), Math.cos(a) * sp,
            kind === 'explode' ? (i % 3 ? P.fruitMera : P.fruitMeraHot) : P.dirt,
            0.16, 0.04, rng.range(0.5, 1.0), 1.6, 1.0, 0, 1);
        }
        for (let i = 0; i < 14; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.PUFF, x, y + 0.1, z, Math.sin(a) * rng.range(2, 6), rng.range(0.5, 2.5),
            Math.cos(a) * rng.range(2, 6), P.sandDark, 0.55, 0.1, 0.9, 2.0, 0.15, 0, 0.5);
        }
        break;
      }
      case 'bullet': {
        for (let i = 0; i < 7; i++) {
          const a = Math.atan2(-dx, -dz) + rng.range(-0.6, 0.6);
          const sp = rng.range(4, 9);
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * sp, rng.range(1, 4), Math.cos(a) * sp,
            P.hitFlash, 0.14, 0.01, 0.18, 7, 1.4, 0, 1);
        }
        break;
      }
      case 'flame': {
        for (let i = 0; i < n; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * rng.range(0.6, 2.4), rng.range(1.5, 4),
            Math.cos(a) * rng.range(0.6, 2.4), i % 2 ? P.fruitMera : P.fruitMeraHot,
            0.22, 0.03, rng.range(0.35, 0.7), 2.6, -0.45, 0, 1);
        }
        break;
      }
      case 'frost': {
        for (let i = 0; i < n + 4; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.MOTE, x, y, z, Math.sin(a) * rng.range(2, 6), rng.range(1, 5),
            Math.cos(a) * rng.range(2, 6), i % 3 ? P.fruitHie : P.fruitHieDeep,
            0.13, 0.02, rng.range(0.4, 0.8), 2.0, 0.9, 0, 1);
        }
        break;
      }
      case 'sand': {
        for (let i = 0; i < n + 6; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.PUFF, x, y, z, Math.sin(a) * rng.range(1.5, 5), rng.range(0.5, 3),
            Math.cos(a) * rng.range(1.5, 5), i % 2 ? P.fruitSuna : P.fruitSunaDark,
            0.30, 0.08, rng.range(0.5, 1.1), 2.4, 0.55, 0, 0.7);
        }
        break;
      }
      case 'quake': {
        for (let i = 0; i < 20; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.MOTE, x, y + 0.1, z, Math.sin(a) * rng.range(2, 8), rng.range(3, 10),
            Math.cos(a) * rng.range(2, 8), i % 3 ? P.rock : P.fruitGura,
            0.20, 0.05, rng.range(0.6, 1.2), 1.4, 1.1, 0, 1);
        }
        break;
      }
      case 'gravity': {
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * TAU;
          const rr = rng.range(2.5, 4.5);
          // Spawn on the rim and fly INWARD — the direction is the whole read.
          this.emit(PK.MOTE, x + Math.sin(a) * rr, y + rng.range(0, 2), z + Math.cos(a) * rr,
            -Math.sin(a) * 6, rng.range(-1, 1), -Math.cos(a) * 6,
            i % 2 ? P.fruitZushi : P.fruitZushiDark, 0.15, 0.03, 0.7, 0.6, 0, 0, 1);
        }
        break;
      }
      case 'water': {
        this.splash(x, y, z, s * 1.2);
        break;
      }
      case 'sanction': {
        for (let i = 0; i < 30; i++) {
          const a = (i / 30) * TAU;
          this.emit(PK.STREAK, x, y + 0.4, z, Math.sin(a) * 12, rng.range(2, 8), Math.cos(a) * 12,
            P.telegraphGuard, 0.5, 0.05, 0.5, 2.2, 0.2, 1.6, 1);
        }
        break;
      }
      default: {
        for (let i = 0; i < n; i++) {
          const a = rng.f() * TAU;
          this.emit(PK.SPARK, x, y, z, Math.sin(a) * rng.range(3, 8), rng.range(1, 5),
            Math.cos(a) * rng.range(3, 8), P.hitFlash, 0.18, 0.02, 0.3, 5, 1, 0, 1);
        }
      }
    }
    if (crit) {
      for (let i = 0; i < 10; i++) {
        const a = rng.f() * TAU;
        this.emit(PK.STREAK, x, y, z, Math.sin(a) * 13, rng.range(2, 7), Math.cos(a) * 13,
          P.critFlash, 0.42, 0.04, 0.26, 4.5, 0.8, 1.3, 1);
      }
    }
  }

  /** A ground-plane shockwave ring. */
  ring(x, y, z, radius, colour, life) {
    const d = this._decal();
    if (!d) return null;
    d.alive = true; d.shape = DK.RING; d.managed = false;
    d.x = x; d.y = y + 0.06; d.z = z; d.dirX = 0; d.dirZ = 1;
    d.radius = radius; d.halfAngle = Math.PI; d.width = radius;
    this._setDecalColour(d, colour);
    d.life = 0; d.maxLife = life || 0.4; d.alpha = 1; d.glyph = CBG.NONE;
    d.growth = GROWTH.FILL;
    this.stats.decals++;
    return d;
  }

  /** A ring at an arbitrary height (a parry flash happens at chest height, not on the floor). */
  ringAt(x, y, z, radius, colour, life) {
    const d = this.ring(x, y - 0.06, z, radius, colour, life);
    return d;
  }

  /** A persistent quake fracture that visibly counts down to its collapse. */
  quakeCrack(x, y, z, radius) {
    const d = this._decal();
    if (!d) return null;
    d.alive = true; d.shape = DK.CRACK; d.managed = false;
    d.x = x; d.y = y + 0.05; d.z = z; d.dirX = 0; d.dirZ = 1;
    d.radius = radius; d.halfAngle = Math.PI; d.width = radius;
    this._setDecalColour(d, P.fruitGuraDark);
    d.life = 0; d.maxLife = 1.0; d.alpha = 1; d.glyph = CBG.NONE;
    d.growth = GROWTH.FILL;
    this.stats.decals++;
    return d;
  }

  /** A gravity well: concentric rings pulled inward, plus inward-flying motes. */
  gravityWell(x, y, z, radius, life) {
    const d = this._decal();
    if (!d) return null;
    d.alive = true; d.shape = DK.WELL; d.managed = false;
    d.x = x; d.y = y + 0.05; d.z = z; d.dirX = 0; d.dirZ = 1;
    d.radius = radius; d.halfAngle = Math.PI; d.width = radius;
    this._setDecalColour(d, P.fruitZushi);
    d.life = 0; d.maxLife = life || 1.2; d.alpha = 1; d.glyph = CBG.NONE;
    d.growth = GROWTH.PULSE;
    this.stats.decals++;
    return d;
  }

  /** Footstep / landing dust. */
  dust(x, y, z, strength) {
    const s = clamp(strength, 0.1, 3);
    const n = Math.round(3 + s * 5);
    for (let i = 0; i < n; i++) {
      const a = this.rng.f() * TAU;
      const sp = this.rng.range(0.6, 2.2) * s;
      this.emit(PK.PUFF, x, y + 0.06, z, Math.sin(a) * sp, this.rng.range(0.3, 1.4),
        Math.cos(a) * sp, P.sandDark, 0.26 + s * 0.1, 0.06, 0.55, 2.6, 0.25, 0, 0.55);
    }
  }

  /** Water entry / exit splash. Uses the sea palette so it reads as water, not smoke. */
  splash(x, y, z, strength) {
    const s = clamp(strength, 0.1, 3);
    const n = Math.round(6 + s * 9);
    for (let i = 0; i < n; i++) {
      const a = this.rng.f() * TAU;
      const sp = this.rng.range(1.5, 5) * s;
      this.emit(PK.MOTE, x, y, z, Math.sin(a) * sp, this.rng.range(3, 8) * s, Math.cos(a) * sp,
        i % 4 === 0 ? P.seaFoam : P.seaShallow, 0.13, 0.03, this.rng.range(0.4, 0.8), 1.6, 1.15, 0, 0.95);
    }
    this.ring(x, y, z, 1.4 * s, P.seaFoam, 0.45);
  }

  /** Speed lines for a dash. Deliberately world-space streaks, not a post-process blur — the art
   *  bar forbids motion blur (§6), and streaks read as voxel motes rather than a smear. */
  speedLines(x, y, z, dirX, dirZ, strength) {
    const s = clamp(strength, 0.2, 2);
    const n = Math.round(6 + s * 6);
    for (let i = 0; i < n; i++) {
      const side = this.rng.sym();
      const px = x - dirZ * side * this.rng.range(0.3, 1.1);
      const pz = z + dirX * side * this.rng.range(0.3, 1.1);
      this.emit(PK.STREAK, px, y + this.rng.range(0.2, 1.6), pz,
        -dirX * 9 * s, this.rng.range(-0.5, 0.8), -dirZ * 9 * s,
        P.skyHorizon, 0.55, 0.05, 0.24, 3.2, 0, 1.9, 0.7);
    }
  }

  /** A slash trail. Returns a handle the attacker feeds weapon positions to each step. */
  beginTrail(colour, width) {
    for (let i = 0; i < this.trails.length; i++) {
      const t = this.trails[i];
      if (!t.alive) {
        t.alive = true; t.n = 0; t.head = 0; t.life = 0;
        t.maxLife = 0.30; t.width = width || 0.22;
        const c = colour !== undefined ? colour : P.hitFlash;
        t.r = ((c >> 16) & 255) / 255; t.g = ((c >> 8) & 255) / 255; t.b = (c & 255) / 255;
        this.stats.trails++;
        return t;
      }
    }
    return null;
  }

  /** Push one frame of weapon spine (tip and hilt) into a trail. */
  trailPoint(t, tipX, tipY, tipZ, hiltX, hiltY, hiltZ) {
    if (!t || !t.alive) return;
    const i = t.head;
    t.tx[i] = tipX; t.ty[i] = tipY; t.tz[i] = tipZ;
    t.hx[i] = hiltX; t.hy[i] = hiltY; t.hz[i] = hiltZ;
    t.age[i] = 0;
    t.head = (i + 1) % t.cap;
    if (t.n < t.cap) t.n++;
  }

  /** Stop feeding a trail; it fades out on its own. */
  endTrail(t) { if (t) t.life = Math.max(t.life, 0.0001); }

  /**
   * Convenience: a whole swing arc as one trail, for attacks whose weapon transform is not
   * animated by a rig. Sampled at spawn so it costs nothing per frame.
   */
  slashArc(x, y, z, dirX, dirZ, radius, halfAngle, colour, sweepSign) {
    const t = this.beginTrail(colour !== undefined ? colour : P.hitFlash, radius * 0.10);
    if (!t) return null;
    const base = Math.atan2(dirX, dirZ);
    const N = 10;
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      const a = base + (sweepSign >= 0 ? -1 : 1) * halfAngle * (1 - 2 * f);
      const rr = radius * (0.35 + 0.65 * Math.sin(f * Math.PI));
      this.trailPoint(t,
        x + Math.sin(a) * radius, y + 0.15 * Math.sin(f * Math.PI), z + Math.cos(a) * radius,
        x + Math.sin(a) * rr * 0.28, y, z + Math.cos(a) * rr * 0.28);
    }
    this.endTrail(t);
    return t;
  }

  /** Level-up burst: a gold column of rising motes plus a ground ring. */
  levelUp(x, y, z) {
    for (let i = 0; i < 40; i++) {
      const a = this.rng.f() * TAU;
      const rr = this.rng.range(0.2, 1.3);
      this.emit(PK.MOTE, x + Math.sin(a) * rr, y + this.rng.range(0, 0.6), z + Math.cos(a) * rr,
        Math.sin(a) * 0.7, this.rng.range(4, 9), Math.cos(a) * 0.7,
        i % 3 ? P.uiGold : P.critFlash, 0.15, 0.04, this.rng.range(0.8, 1.5), 0.9, -0.15, 0, 1);
    }
    this.ring(x, y, z, 3.2, P.uiGold, 0.9);
    this.addShake(0.14);
  }

  /**
   * Death dissolve. Drives the actor material's uDissolve through the rig when one exists, and
   * writes a plain field when it does not, so this works before Cluster B's rig lands.
   * @param {object} actor
   * @param {number} t 0..1
   */
  dissolve(actor, t) {
    if (!actor) return;
    if (actor.rig && typeof actor.rig.setDissolve === 'function') actor.rig.setDissolve(t);
    else actor.dissolve = t;
    if (t > 0 && t < 1 && this.rng.f() < 0.4) {
      const h = actor.height || 1.8;
      this.emit(PK.MOTE, actor.x + this.rng.sym() * 0.4, actor.y + this.rng.f() * h,
        actor.z + this.rng.sym() * 0.4, this.rng.sym() * 0.6, this.rng.range(1.2, 2.6),
        this.rng.sym() * 0.6, P.bloodless, 0.11, 0.03, 0.8, 1.4, -0.1, 0, 0.9);
    }
  }

  /**
   * White flash on a struck body. Goes through the rig when present (which drives the actor
   * material's uFlash uniform); otherwise it writes `actor.hitFlash`, which Cluster B reads.
   */
  setFlash(actor, colour, amount) {
    if (!actor) return;
    this.stats.flashes++;
    actor.hitFlash = Math.max(actor.hitFlash || 0, amount);
    actor.hitFlashColor = colour;
    if (actor.rig && typeof actor.rig.setFlash === 'function') actor.rig.setFlash(colour, amount);
  }

  /** Aura on a body — the character-level half of a telegraph. */
  setAura(actor, colour, amount) {
    if (!actor) return;
    actor.auraColor = colour;
    actor.aura = amount;
    if (actor.rig && typeof actor.rig.setAura === 'function') actor.rig.setAura(colour, amount);
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  /**
   * Freeze the simulation briefly. Budgeted: the budget refills at 1/s and every request spends
   * proportionally, so the tenth simultaneous hit adds almost nothing.
   * @param {number} seconds
   */
  addHitstop(seconds) {
    if (!(seconds > 0)) return;
    const allowed = seconds * this._hitstopBudget;
    if (allowed < 0.004) return;
    this._hitstopBudget = Math.max(0.15, this._hitstopBudget - allowed * 3.2);
    this.stats.hitstops++;
    if (this.app && this.app.clock && this.app.clock.addHitstop) this.app.clock.addHitstop(allowed);
  }

  /**
   * Add camera trauma. Same budget logic — a shake that is always maxed is a shake that carries
   * no information.
   * @param {number} trauma 0..1
   */
  addShake(trauma) {
    if (!(trauma > 0)) return;
    const allowed = trauma * this._shakeBudget;
    this._shakeBudget = Math.max(0.2, this._shakeBudget - allowed * 1.6);
    this.shake.trauma = Math.min(1, this.shake.trauma + allowed);
    this.stats.shakes++;
  }

  /** Route a damage number to the UI. UI owns all text (ARCHITECTURE §5). */
  damageNumber(x, y, z, value, kind) {
    const ui = this.app && this.app.ui;
    this.stats.damageNumbers++;
    if (!ui || typeof ui.damageNumber !== 'function') return null;
    return ui.damageNumber({ x, y, z }, value, kind || 'hit', this._project);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  _decal() {
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (!d.alive) return d;
    }
    // Full: steal the oldest non-telegraph mark. Telegraphs are never stolen — a missing
    // telegraph is a gameplay failure, a missing scorch mark is not.
    let best = null, bestLife = -1;
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (d.managed) continue;
      const f = d.life / d.maxLife;
      if (f > bestLife) { bestLife = f; best = d; }
    }
    return best;
  }

  _setDecalColour(d, colour) {
    d.r = ((colour >> 16) & 255) / 255;
    d.g = ((colour >> 8) & 255) / 255;
    d.b = (colour & 255) / 255;
  }

  /** Ground height under a point, falling back to the impact height when no world is loaded. */
  _groundY(x, z, fallback) {
    const app = this.app;
    if (app && app.physics && typeof app.physics.groundAt === 'function') {
      return app.physics.groundAt(x, z);
    }
    if (app && app.world && typeof app.world.heightAt === 'function') return app.world.heightAt(x, z);
    return fallback !== undefined ? fallback : 0;
  }

  /** One fixed step. Deterministic: no wall clock, seeded RNG only. */
  step(dt) {
    // Budgets recover.
    this._shakeBudget = Math.min(1, this._shakeBudget + dt * 1.6);
    this._hitstopBudget = Math.min(1, this._hitstopBudget + dt * 2.2);

    // Trauma decays; shake is trauma SQUARED so small values are genuinely small.
    const sh = this.shake;
    sh.trauma = Math.max(0, sh.trauma - dt * 1.35);
    this._shakeT += dt;
    const amp = sh.trauma * sh.trauma;
    // Three decorrelated frequencies, sampled from a cheap deterministic hash of time rather
    // than a random walk, so a replay reproduces the exact same camera motion.
    const t = this._shakeT;
    sh.x = amp * 0.42 * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 23.1 + 1.7) * 0.4);
    sh.y = amp * 0.34 * (Math.sin(t * 39.7 + 0.9) * 0.6 + Math.sin(t * 61.3 + 2.3) * 0.4);
    sh.roll = amp * 0.045 * Math.sin(t * 31.9 + 0.4);

    // Particles.
    let live = 0;
    const arr = this.particles;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.alive = false; continue; }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag; p.vz *= drag;
      p.vy = (p.vy - 22 * p.grav * dt) * drag;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.spin * dt;
      live++;
    }
    this.stats.particles = live;

    // Decals. MANAGED slots (telegraphs) are skipped entirely: they are owned by whoever calls
    // telegraphs() and are rebuilt there, not aged here.
    //
    // This ordering matters and it bit once: systems step in the order input -> ... -> combat
    // -> ... -> fx (ARCHITECTURE §4), so combat publishes the frame's telegraph decals BEFORE
    // fx.step runs. Clearing managed slots here therefore wiped every telegraph on the same
    // frame it was published, and nothing rendered. Clearing belongs at the top of
    // telegraphs(), where the publisher controls it and step order is irrelevant.
    let dLive = 0;
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (!d.alive) continue;
      if (d.managed) { dLive++; continue; }
      d.life += dt;
      if (d.life >= d.maxLife) { d.alive = false; continue; }
      d.t = d.life / d.maxLife;
      d.alpha = 1 - ease.inQuad(d.t);
      d.grow = d.shape === DK.RING ? ease.outQuart(d.t) : ease.outQuad(d.t);
      dLive++;
    }
    this.stats.decals = dLive;

    // Trails.
    let tLive = 0;
    for (let i = 0; i < this.trails.length; i++) {
      const tr = this.trails[i];
      if (!tr.alive) continue;
      for (let k = 0; k < tr.cap; k++) tr.age[k] += dt;
      if (tr.life > 0) {
        tr.life += dt;
        if (tr.life >= tr.maxLife) { tr.alive = false; tr.n = 0; continue; }
      }
      tLive++;
    }
    this.stats.trails = tLive;
  }

  /**
   * Publish this frame's telegraph decals.
   *
   * Called by combat every step with `telegraphs.commands`. Telegraph decals are MANAGED: they
   * are rebuilt from the live command list rather than aged out, so a cancelled telegraph
   * disappears on the same frame the attack was interrupted. A telegraph that outlives its
   * attack is worse than no telegraph.
   *
   * @param {object[]} commands from TelegraphSystem.commands
   */
  telegraphs(commands) {
    // Retire last frame's managed decals first. Rebuilding from the live command list (rather
    // than ageing them out) is what makes a cancelled telegraph vanish on the exact frame the
    // attack was interrupted — a mark that outlives its attack is worse than no mark at all.
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (d.managed) { d.managed = false; d.alive = false; }
    }
    for (let i = 0; i < commands.length; i++) {
      const c = commands[i];
      const d = this._decalForTelegraph();
      if (!d) continue;
      d.alive = true;
      d.managed = true;
      d.shape = c.kind === TELEGRAPH_KIND.ARC ? DK.ARC
        : c.kind === TELEGRAPH_KIND.LINE ? DK.LINE
          : c.kind === TELEGRAPH_KIND.CONE ? DK.CONE
            : c.kind === TELEGRAPH_KIND.POINT ? DK.POINT : DK.CIRCLE;
      d.x = c.x; d.z = c.z;
      d.y = this._groundY(c.x, c.z, c.y) + 0.06;
      d.dirX = c.dirX; d.dirZ = c.dirZ;
      d.radius = c.radius;
      d.halfAngle = c.halfAngle;
      d.width = c.width;
      this._setDecalColour(d, c.colour);
      d.t = c.t;
      d.alpha = c.alpha;
      d.sustain = c.sustain > 0 ? 1 - c.sustain : (c.fired ? 1 : 0);
      d.grow = growthAmount(c.growth, c.t);
      d.growth = c.growth;
      d.glyph = c.cb === 'off' ? CBG.NONE
        : c.cbShape === CB_SHAPE.RING ? CBG.RING
          : c.cbShape === CB_SHAPE.CHEVRON ? CBG.CHEVRON : CBG.CROSS;

      // The character-level tell: an aura on the body itself. Without this you have to look at
      // the floor to fight, which is the classic ground-decal failure mode.
      if (c.actor && c.tell > 0) {
        this.setAura(c.actor, c.colour, c.tell * 0.85);
        // A pose flash pulse near the end of the wind-up, so the tell peaks before the strike.
        if (c.t > 0.72 && c.t < 0.94) {
          c.actor.hitFlash = Math.max(c.actor.hitFlash || 0, (c.t - 0.72) / 0.22 * 0.35);
          c.actor.hitFlashColor = c.colour;
        }
        // An aura ring at the feet, redrawn every frame so it tracks the body.
        const ring = this._decalForTelegraph();
        if (ring) {
          ring.alive = true; ring.managed = true; ring.shape = DK.RING;
          ring.x = c.actor.x; ring.z = c.actor.z;
          ring.y = this._groundY(c.actor.x, c.actor.z, c.actor.y) + 0.07;
          ring.dirX = c.dirX; ring.dirZ = c.dirZ;
          const rr = (c.actor.radius || 0.45) * 2.6;
          ring.radius = rr; ring.halfAngle = Math.PI; ring.width = rr;
          this._setDecalColour(ring, c.colour);
          ring.t = c.t;
          ring.alpha = 0.55 + 0.45 * c.tell;
          ring.grow = 0.55 + 0.42 * Math.sin(c.t * Math.PI * 3);
          ring.sustain = 0;
          ring.glyph = CBG.NONE;
        }
      }
    }
  }

  /** A slot for a managed (telegraph) decal. Managed slots are recycled first. */
  _decalForTelegraph() {
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (!d.alive) return d;
    }
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (d.managed) return d;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Rebuild the GPU buffers. Render-only: touches no simulation state. */
  preRender() {
    if (!this._built) return;
    this._buildParticles();
    this._buildDecals();
    this._buildTrails();
  }

  _buildParticles() {
    const b = this.particleBatch;
    b.begin();
    const arr = this.particles;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      if (!p.alive) continue;
      const f = p.life / p.maxLife;
      const idx = b.pushPoint(p.x, p.y, p.z);
      if (idx < 0) break;
      const size = lerp(p.size, p.size1, ease.outQuad(f));
      // Fade with a hold: full for the first 55% of the life, then out. A linear fade from
      // frame one makes every particle look half-dead the moment it appears.
      const a = p.alpha * (f < 0.55 ? 1 : 1 - (f - 0.55) / 0.45);
      b.setVec3('aColor', idx, p.r, p.g, p.b);
      b.setVec4('aParam', idx, size, p.rot, a, p.kind);
      b.setVec4('aParam2', idx, p.stretch, p.vx, p.vz, p.vy);
    }
    b.end();
  }

  _buildDecals() {
    const b = this.decalBatch;
    b.begin();
    for (let i = 0; i < this.decals.length; i++) {
      const d = this.decals[i];
      if (!d.alive) continue;
      // Build the ground quad oriented so local +Y is the facing direction.
      const fx = d.dirX, fz = d.dirZ;
      const rx = fz, rz = -fx;      // right-hand perpendicular
      let ex, ez, sx, sz, cx, cz;
      if (d.shape === DK.LINE) {
        // A lane: the quad starts at the origin and extends `radius` forward, `width` across.
        const hw = d.width * 0.5;
        cx = d.x + fx * d.radius * 0.5;
        cz = d.z + fz * d.radius * 0.5;
        ex = fx * d.radius * 0.5; ez = fz * d.radius * 0.5;
        sx = rx * hw; sz = rz * hw;
      } else {
        cx = d.x; cz = d.z;
        ex = fx * d.radius; ez = fz * d.radius;
        sx = rx * d.radius; sz = rz * d.radius;
      }
      const y = d.y;
      const idx = b.pushQuad(
        cx - sx - ex, y, cz - sz - ez,
        cx + sx - ex, y, cz + sz - ez,
        cx + sx + ex, y, cz + sz + ez,
        cx - sx + ex, y, cz - sz + ez);
      if (idx < 0) break;
      b.setVec3('aColor', idx, d.r, d.g, d.b);
      b.setVec4('aParam', idx, d.shape, d.t, d.halfAngle, d.alpha);
      b.setVec4('aParam2', idx, d.grow, d.glyph, d.sustain, 0);
    }
    b.end();
  }

  _buildTrails() {
    const b = this.ribbonBatch;
    b.begin();
    for (let i = 0; i < this.trails.length; i++) {
      const tr = this.trails[i];
      if (!tr.alive || tr.n < 2) continue;
      const fade = tr.life > 0 ? 1 - clamp01(tr.life / tr.maxLife) : 1;
      const start = (tr.head - tr.n + tr.cap) % tr.cap;
      for (let k = 0; k < tr.n - 1; k++) {
        const a = (start + k) % tr.cap;
        const c = (start + k + 1) % tr.cap;
        const idx = b.pushQuad(
          tr.hx[a], tr.hy[a], tr.hz[a],
          tr.tx[a], tr.ty[a], tr.tz[a],
          tr.tx[c], tr.ty[c], tr.tz[c],
          tr.hx[c], tr.hy[c], tr.hz[c]);
        if (idx < 0) break;
        // Age along the ribbon: the tail (oldest sample) is the faint end.
        const ageA = 1 - (k / Math.max(1, tr.n - 1));
        const ageC = 1 - ((k + 1) / Math.max(1, tr.n - 1));
        b.setVec3('aColor', idx, tr.r, tr.g, tr.b);
        b.setVec4At('aParam', idx, 0, fade, ageA, -1, 0);
        b.setVec4At('aParam', idx, 1, fade, ageA, 1, 0);
        b.setVec4At('aParam', idx, 2, fade, ageC, 1, 0);
        b.setVec4At('aParam', idx, 3, fade, ageC, -1, 0);
      }
    }
    b.end();
  }

  /** Clear everything. Used on encounter reset and on load. */
  clear() {
    for (let i = 0; i < this.particles.length; i++) this.particles[i].alive = false;
    for (let i = 0; i < this.decals.length; i++) this.decals[i].alive = false;
    for (let i = 0; i < this.trails.length; i++) { this.trails[i].alive = false; this.trails[i].n = 0; }
    this.shake.trauma = 0;
    this.shake.x = 0; this.shake.y = 0; this.shake.roll = 0;
  }

  serialize() { return null; }   // FX is presentation; a save never restores a spark
  deserialize() {}

  dispose() {
    if (!this._built) return;
    this.particleBatch.dispose();
    this.decalBatch.dispose();
    this.ribbonBatch.dispose();
    this.particleMat.dispose();
    this.decalMat.dispose();
    this.ribbonMat.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

/**
 * Factory. MUST be constructed inside `App.boot`'s `onSystems` hook, because that is the last
 * point before `prewarmAll()` reads `app.extraMaterials`.
 * @param {object} app
 * @param {object} [opts]
 * @returns {FxSystem}
 */
export function createFxSystem(app, opts) {
  return new FxSystem(app, opts);
}

export { PK as PARTICLE_KIND, DK as DECAL_KIND };
