// The ocean. Owner: Cluster A (render).
//
// Sea of Thieves is the bar: the water must *drive* the ship, not be a backdrop the ship
// slides on. That requires the CPU and GPU to agree on wave height to the millimetre, so
// `sampleHeight()` below is a line-for-line port of the vertex shader's displacement.
//
// Geometry is a camera-centred radial grid: dense near the viewer, coarse at the horizon,
// snapped to a grid so it does not swim. ~14k vertices covers 6 km of ocean.

import * as THREE from 'three';
import { P, mixHex } from '../gen/palette.js';
import { clamp01, lerp, TAU } from '../core/math.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Gerstner wave train. Kept small: 4 waves is enough silhouette, 8 is not affordable. */
export const WAVES = [
  //  dirAngle,  wavelength, steepness, amplitude
  { a: 0.00, len: 62.0, steep: 0.62, amp: 1.00 },
  { a: 0.62, len: 31.0, steep: 0.52, amp: 0.52 },
  { a: -0.85, len: 17.0, steep: 0.44, amp: 0.26 },
  { a: 1.90, len: 8.5, steep: 0.36, amp: 0.13 },
];

const WATER_VERT = /* glsl */`
precision highp float;
out vec3 vWorld;
out vec3 vNormalW;
out float vCrest;
out float vDist;

uniform float uTime;
uniform vec3 uCameraPos;
uniform float uWaveScale;
uniform float uWindAngle;
uniform vec4 uWaveA;   // wavelength per wave
uniform vec4 uWaveS;   // steepness per wave
uniform vec4 uWaveM;   // amplitude per wave
uniform vec4 uWaveD;   // direction angle offset per wave

// Gerstner displacement + analytic normal. MUST match sampleHeight() in water.js.
// A is amplitude in METRES; Q is steepness in 0..1 and only pinches the crests horizontally.
// Conflating the two is the classic Gerstner bug: it makes "a breeze" produce 5 m swells.
vec3 gerstner(vec2 p, out vec3 nrm) {
  vec3 disp = vec3(0.0);
  vec3 T = vec3(1.0, 0.0, 0.0);   // dP/dx
  vec3 B = vec3(0.0, 0.0, 1.0);   // dP/dz
  for (int i = 0; i < 4; i++) {
    float len = uWaveA[i];
    float Q = uWaveS[i];
    float A = uWaveM[i] * uWaveScale;
    float ang = uWindAngle + uWaveD[i];
    vec2 d = vec2(cos(ang), sin(ang));
    float k = 6.28318530718 / len;
    float c = sqrt(9.81 / k);
    float f = k * (dot(d, p) - c * uTime);
    float sf = sin(f), cf = cos(f);
    float QA = Q * A;
    disp.x += d.x * QA * cf;
    disp.z += d.y * QA * cf;
    disp.y += A * sf;
    float kA = k * A;
    T += vec3(-Q * kA * d.x * d.x * sf,  kA * d.x * cf, -Q * kA * d.x * d.y * sf);
    B += vec3(-Q * kA * d.x * d.y * sf,  kA * d.y * cf, -Q * kA * d.y * d.y * sf);
  }
  nrm = normalize(cross(B, T));
  if (nrm.y < 0.0) nrm = -nrm;
  return disp;
}

void main() {
  // position.xz is a radial grid in local space; recentre on the camera each frame.
  vec2 base = position.xz + uCameraPos.xz;
  vec3 nrm;
  vec3 disp = gerstner(base, nrm);
  vec3 world = vec3(base.x + disp.x, disp.y, base.y + disp.z);
  vWorld = world;
  vNormalW = nrm;
  // Crest factor drives foam: how far above the local mean this vertex sits.
  vCrest = clamp(disp.y / max(uWaveScale * 1.35, 0.001), -1.0, 1.0);
  vDist = length(position.xz);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const WATER_FRAG = /* glsl */`
precision highp float;
in vec3 vWorld;
in vec3 vNormalW;
in float vCrest;
in float vDist;
layout(location = 0) out vec4 fragColor;

uniform vec3 uCameraPos;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSSSColor;
uniform vec3 uFoamColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uNight;
uniform float uStorm;
uniform float uWaveScale;
// Up to 8 nearby islands: xyz = centre, w = shore radius. Shore gradient + foam come from these.
uniform vec4 uIslands[8];
uniform int uIslandCount;
// Wake points laid by the ship: xy = world xz, z = age 0..1, w = strength
uniform vec4 uWake[16];
uniform int uWakeCount;

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}

// Cheap procedural sky lookup so reflections agree with the sky dome without a cubemap pass.
vec3 skyLookup(vec3 d) {
  float t = pow(clamp(d.y * 0.5 + 0.5, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizonColor, uSkyColor, smoothstep(0.42, 0.96, t));
  float sd = clamp(dot(d, uSunDir), 0.0, 1.0);
  col += uSunColor * (pow(sd, 8.0) * 0.30 + pow(sd, 200.0) * 1.4) * (1.0 - uNight) * (1.0 - uStorm * 0.8);
  return col;
}

void main() {
  vec3 v = uCameraPos - vWorld;
  float viewDist = length(v);
  v /= max(viewDist, 1e-4);

  // Detail normal: two scrolling noise layers add the small chop the vertex grid cannot afford.
  vec2 p = vWorld.xz;
  float e = 0.75;
  float n1 = vnoise(p * 0.13 + vec2(uTime * 0.06, uTime * 0.031));
  float nx = vnoise((p + vec2(e, 0.0)) * 0.13 + vec2(uTime * 0.06, uTime * 0.031)) - n1;
  float nz = vnoise((p + vec2(0.0, e)) * 0.13 + vec2(uTime * 0.06, uTime * 0.031)) - n1;
  float chop = mix(0.9, 2.4, clamp(uWaveScale * 0.5, 0.0, 1.4));
  vec3 n = normalize(vNormalW + vec3(-nx, 0.0, -nz) * chop * 9.0);
  // Flatten the normal with distance so the horizon stays calm instead of boiling.
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(220.0, 1400.0, viewDist)));

  // --- shore proximity -----------------------------------------------------
  float shore = 1.0;   // 1 = open ocean, 0 = at the beach
  for (int i = 0; i < 8; i++) {
    if (i >= uIslandCount) break;
    vec4 isl = uIslands[i];
    float d = length(vWorld.xz - isl.xy) - isl.z;
    shore = min(shore, clamp(d / max(isl.w, 1.0), 0.0, 1.0));
  }

  // --- base colour ---------------------------------------------------------
  vec3 deep = uDeepColor;
  vec3 shallow = uShallowColor;
  vec3 base = mix(shallow, deep, smoothstep(0.0, 0.55, shore));

  // Sub-surface glow through the back of wave crests, strongest looking toward the sun.
  float backlight = pow(clamp(dot(-v, uSunDir), 0.0, 1.0), 3.0);
  float crestUp = clamp(vCrest, 0.0, 1.0);
  base += uSSSColor * crestUp * (0.14 + backlight * 0.5) * (1.0 - uNight * 0.8);

  // --- reflection ----------------------------------------------------------
  vec3 r = reflect(-v, n);
  r.y = abs(r.y);
  vec3 refl = skyLookup(r);
  // Tint the reflection toward the sea's own hue. Physically the reflection is pure sky, but a
  // low camera over water is almost all grazing angle, so an untinted reflection turns the
  // entire ocean into a second copy of the sky and the horizon disappears. Sea of Thieves and
  // every stylised ocean cheat exactly here.
  refl = mix(refl, refl * (base * 1.7 + 0.25), 0.42);

  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  // A hard cap is the single most important line in this shader: it guarantees the sea keeps
  // at least ~62% of its body colour no matter how grazing the view gets.
  fres = min(fres, 0.38) * mix(1.0, 0.66, uStorm);

  vec3 col = mix(base * (0.66 + uSunIntensity * 0.24), refl, fres);

  // Aerial perspective: the far sea gets slightly deeper and cooler before fog lifts it, which
  // is what draws a readable horizon line instead of a seamless blend into the sky.
  float far = smoothstep(150.0, 2200.0, viewDist);
  col = mix(col, col * vec3(0.86, 0.94, 1.02) * 0.94, far * 0.55);

  // Sun glitter. This has to be a SPARSE sparkle, not a specular wash: with the sun near
  // zenith a broad lobe covers the whole visible ocean and bleaches it to sky colour, which is
  // exactly what a naive pow(N.H, k) does here. So: a very tight lobe, gated by a noise mask
  // that only lets a fraction of the surface sparkle, and confined to the mid distance where
  // real sun glitter lives (you do not get glitter directly under your own feet).
  vec3 h = normalize(uSunDir + v);
  float ndh = clamp(dot(n, h), 0.0, 1.0);
  float lobe = pow(ndh, 900.0);
  float band = smoothstep(6.0, 40.0, viewDist) * (1.0 - smoothstep(300.0, 1200.0, viewDist));
  float sparkMask = smoothstep(0.62, 0.86, vnoise(p * 3.1 + vec2(uTime * 0.9, -uTime * 0.6)));
  float glitter = lobe * (0.55 + sparkMask * 2.4) * band;
  col += uSunColor * glitter * (1.0 - uNight * 0.9) * (1.0 - uStorm * 0.7);

  // --- foam ----------------------------------------------------------------
  float foam = 0.0;
  // Crest foam, only on genuinely steep water.
  float crestFoam = smoothstep(0.62, 0.95, vCrest) * smoothstep(0.35, 1.1, uWaveScale);
  foam += crestFoam;
  // Shore band with a scalloped edge — a straight foam line reads as a bug.
  float scallop = vnoise(p * 0.35 + vec2(uTime * 0.05, 0.0)) * 0.28;
  float shoreFoam = smoothstep(0.16 + scallop, 0.0, shore);
  // Pulse the shore foam so it reads as surf rather than a decal.
  shoreFoam *= 0.65 + 0.35 * sin(uTime * 1.1 + vWorld.x * 0.08 + vWorld.z * 0.06);
  foam += shoreFoam;
  // Ship wake.
  for (int i = 0; i < 16; i++) {
    if (i >= uWakeCount) break;
    vec4 w = uWake[i];
    float d = length(vWorld.xz - w.xy);
    float radius = 1.6 + w.z * 22.0;
    float ring = smoothstep(radius, radius - 3.2, d) * smoothstep(radius - 7.0, radius - 3.0, d);
    foam += ring * w.w * (1.0 - w.z);
  }
  foam = clamp(foam, 0.0, 1.0);
  // Break the foam into cells so it reads as bubbles, matching the chunky art direction.
  float foamTex = smoothstep(0.35, 0.75, vnoise(p * 1.7 + vec2(uTime * 0.25, uTime * 0.18)));
  vec3 foamCol = uFoamColor * (0.82 + 0.18 * foamTex);
  col = mix(col, foamCol, foam * (0.55 + 0.45 * foamTex));

  // --- fog -----------------------------------------------------------------
  float fogAmt = 1.0 - exp(-uFogDensity * viewDist * viewDist);
  float sunAmt = pow(clamp(dot(-v, uSunDir), 0.0, 1.0), 4.0);
  vec3 fogCol = mix(uFogColor, uSunColor, sunAmt * 0.35 * (1.0 - uNight));
  col = mix(col, fogCol, clamp(fogAmt, 0.0, 1.0));

  fragColor = vec4(col, 1.0);
}`;

/**
 * Radial ocean grid. Rings grow geometrically so near water is dense and the horizon is cheap.
 */
function buildOceanGeometry(rings = 110, segments = 128, innerR = 1.4, outerR = 6000) {
  const pos = [];
  const idx = [];
  const ringR = new Float32Array(rings + 1);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    ringR[i] = innerR * Math.pow(outerR / innerR, Math.pow(t, 1.45));
  }
  // Centre vertex
  pos.push(0, 0, 0);
  for (let i = 0; i <= rings; i++) {
    const r = ringR[i];
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * TAU;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  // Inner fan
  for (let s = 0; s < segments; s++) {
    idx.push(0, 1 + s, 1 + ((s + 1) % segments));
  }
  for (let i = 0; i < rings; i++) {
    const a0 = 1 + i * segments;
    const b0 = 1 + (i + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      idx.push(a0 + s, b0 + s, b0 + s1);
      idx.push(a0 + s, b0 + s1, a0 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), outerR * 1.2);
  return geo;
}

export class Water {
  constructor() {
    this.time = 0;
    this.waveScale = 0.55;
    this.windAngle = 0.4;
    this.uniforms = {
      uTime: { value: 0 },
      uCameraPos: { value: new THREE.Vector3() },
      uWaveScale: { value: 0.55 },
      uWindAngle: { value: 0.4 },
      uWaveA: { value: new THREE.Vector4(...WAVES.map(w => w.len)) },
      uWaveS: { value: new THREE.Vector4(...WAVES.map(w => w.steep)) },
      uWaveM: { value: new THREE.Vector4(...WAVES.map(w => w.amp)) },
      uWaveD: { value: new THREE.Vector4(...WAVES.map(w => w.a)) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunColor: { value: C(P.sunLight) },
      uSunIntensity: { value: 1.45 },
      uSkyColor: { value: C(P.skyZenith) },
      uHorizonColor: { value: C(P.skyHorizon) },
      uDeepColor: { value: C(P.seaDeep) },
      uShallowColor: { value: C(P.seaShallow) },
      uSSSColor: { value: C(P.seaSSS) },
      uFoamColor: { value: C(P.seaFoam) },
      uFogColor: { value: C(P.skyHorizon) },
      uFogDensity: { value: 0.00000030 },
      uNight: { value: 0 },
      uStorm: { value: 0 },
      uIslands: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 1)) },
      uIslandCount: { value: 0 },
      uWake: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 1, 0)) },
      uWakeCount: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: WATER_VERT,
      fragmentShader: WATER_FRAG,
      // DoubleSide is deliberate: the radial fan winds clockwise seen from above, and the
      // player can also be underwater looking up at the surface. One-sided water is invisible
      // from one of those two positions and it is not obvious which until you check.
      side: THREE.DoubleSide,
      fog: false,
    });
    this.material.name = 'water';
    this.mesh = new THREE.Mesh(buildOceanGeometry(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'ocean';
    this.mesh.userData.castShadow = false;
    this._wake = [];
  }

  /**
   * CPU wave height — a line-for-line port of the vertex shader.
   * Returns { y, nx, ny, nz, dx, dz } where dx/dz are the horizontal Gerstner displacement.
   * Ship physics, buoyancy, swimming and splash FX all sample this.
   */
  sampleHeight(x, z, out) {
    const t = this.time;
    const scale = this.waveScale;
    let dxs = 0, dys = 0, dzs = 0;
    let tx = 1, ty = 0, tz = 0;
    let bx = 0, by = 0, bz = 1;
    for (let i = 0; i < 4; i++) {
      const w = WAVES[i];
      const A = w.amp * scale;
      const Q = w.steep;
      const ang = this.windAngle + w.a;
      const dX = Math.cos(ang), dZ = Math.sin(ang);
      const k = TAU / w.len;
      const c = Math.sqrt(9.81 / k);
      const f = k * (dX * x + dZ * z - c * t);
      const sf = Math.sin(f), cf = Math.cos(f);
      const QA = Q * A, kA = k * A;
      dxs += dX * QA * cf;
      dzs += dZ * QA * cf;
      dys += A * sf;
      tx += -Q * kA * dX * dX * sf; ty += kA * dX * cf; tz += -Q * kA * dX * dZ * sf;
      bx += -Q * kA * dX * dZ * sf; by += kA * dZ * cf; bz += -Q * kA * dZ * dZ * sf;
    }
    let nx = by * tz - bz * ty;
    let ny = bz * tx - bx * tz;
    let nz = bx * ty - by * tx;
    const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
    nx *= inv; ny *= inv; nz *= inv;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const o = out || {};
    o.y = dys; o.nx = nx; o.ny = ny; o.nz = nz; o.dx = dxs; o.dz = dzs;
    return o;
  }

  /** Height only — the hot path for buoyancy sampling. */
  heightAt(x, z) {
    const t = this.time, scale = this.waveScale;
    let y = 0;
    for (let i = 0; i < 4; i++) {
      const w = WAVES[i];
      const amp = w.amp * scale;
      const ang = this.windAngle + w.a;
      const k = TAU / w.len;
      const c = Math.sqrt(9.81 / k);
      const f = k * (Math.cos(ang) * x + Math.sin(ang) * z - c * t);
      y += amp * Math.sin(f);
    }
    return y;
  }

  /** Ship writes wake points here; they age out over ~4 seconds. */
  addWake(x, z, strength) {
    this._wake.push({ x, z, age: 0, strength });
    if (this._wake.length > 16) this._wake.shift();
  }

  setNearbyIslands(list) {
    const u = this.uniforms.uIslands.value;
    const n = Math.min(8, list.length);
    for (let i = 0; i < n; i++) {
      u[i].set(list[i].x, list[i].z, list[i].radius, list[i].falloff || 34);
    }
    this.uniforms.uIslandCount.value = n;
  }

  step(dt) {
    this.time += dt;
    for (let i = this._wake.length - 1; i >= 0; i--) {
      this._wake[i].age += dt / 4.2;
      if (this._wake[i].age >= 1) this._wake.splice(i, 1);
    }
  }

  /** Push per-frame state into uniforms. `env` is Sky.env. */
  update(env, cameraPos, weather) {
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uCameraPos.value.copy(cameraPos);
    this.waveScale = weather.waveScale;
    u.uWaveScale.value = this.waveScale;
    u.uWindAngle.value = this.windAngle;
    u.uSunDir.value.copy(env.sunDir);
    u.uSunColor.value.copy(env.sunColor);
    u.uSunIntensity.value = env.sunIntensity;
    u.uSkyColor.value.copy(env.skyColor);
    u.uHorizonColor.value.copy(env.fogColor);
    u.uFogColor.value.copy(env.fogColor);
    u.uFogDensity.value = env.fogDensity;
    u.uNight.value = env.night;
    u.uStorm.value = env.storm;

    let deep = mixHex(P.seaDeep, P.seaDeepNight, env.night);
    let shallow = mixHex(P.seaShallow, P.seaShallowNight, env.night);
    deep = mixHex(deep, P.seaDeepStorm, env.storm * 0.85);
    shallow = mixHex(shallow, P.seaShallowStorm, env.storm * 0.85);
    u.uDeepColor.value.setHex(deep, THREE.SRGBColorSpace);
    u.uShallowColor.value.setHex(shallow, THREE.SRGBColorSpace);

    const wk = u.uWake.value;
    for (let i = 0; i < this._wake.length; i++) {
      const w = this._wake[i];
      wk[i].set(w.x, w.z, w.age, w.strength);
    }
    u.uWakeCount.value = this._wake.length;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
