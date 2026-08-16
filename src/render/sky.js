// Procedural sky: gradient dome, sun/moon discs, voxel cloud banks, stars, and the
// atmosphere constants that every other shader reads so the whole frame agrees on light.
//
// Owner: rendering/lighting/sky/water/tonemap cluster.
// Contract: `Sky.env` is the single source of truth for sun direction, light colours and fog.
// Terrain, water, characters and FX all read Sky.env. Nothing else may invent a light colour.

import * as THREE from 'three';
import { P, hex2rgb, mixHex } from '../gen/palette.js';
import { clamp01, lerp, smoothstep, TAU } from '../core/math.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

const SKY_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  // Sky dome is drawn at infinity: strip translation, force depth to far plane.
  mat4 rotOnly = mat4(mat3(viewMatrix));
  vec4 p = projectionMatrix * rotOnly * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */`
precision highp float;
in vec3 vDir;
layout(location = 0) out vec4 fragColor;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uNight;      // 0 = day, 1 = night
uniform float uStorm;      // 0 = clear, 1 = storm
uniform float uTime;
uniform float uCloudCover;

// Hash/noise duplicated here rather than shared, so the sky shader has zero dependencies
// and can be compiled in isolation during the boot pre-warm.
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h21(i), b = h21(i + vec2(1,0)), c = h21(i + vec2(0,1)), d = h21(i + vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
// Octave counts tuned on the target iGPU: the cloud mask is floor-quantised into 3 hard
// tiers below, which erases most detail the 4th/5th octaves would add — but the whole sky
// pays for them at every pixel (~1.7 ms/frame at 1080p for the original 5+5).
float fbm4(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
float fbm3(vec2 p){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

// Chunky voxel-flavoured clouds: quantise the noise field into hard steps so cloud
// edges read as blocks, per ART_BAR (hard-edged white voxel clouds), not as soft fog.
float cloudField(vec3 d){
  if (d.y < 0.015) return 0.0;
  vec2 uv = d.xz / max(d.y, 0.015);
  vec2 drift = vec2(uTime * 0.0035, uTime * 0.0012);
  float base = fbm4(uv * 0.55 + drift);
  float detail = fbm3(uv * 1.9 - drift * 1.7);
  float f = base * 0.72 + detail * 0.28;
  float cover = mix(0.60, 0.30, uCloudCover);
  float m = smoothstep(cover, cover + 0.16, f);
  // Quantise into 3 hard tiers -> blocky silhouette.
  m = floor(m * 3.0 + 0.5) / 3.0;
  // Fade near the horizon so the cloud layer reads as a plane, not a shell.
  m *= smoothstep(0.02, 0.20, d.y);
  return m;
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);

  // Base gradient: strong horizon lift, subtle bleach right at the skyline.
  float t = pow(clamp(up * 0.5 + 0.5, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, smoothstep(0.42, 0.96, t));
  col = mix(col, uHorizon * 1.06, pow(1.0 - clamp(abs(up) * 3.2, 0.0, 1.0), 2.2));

  float sunDot = dot(d, uSunDir);

  // Sun glow: broad warm scatter + tight disc.
  float glow = pow(clamp(sunDot, 0.0, 1.0), 8.0) * 0.35 + pow(clamp(sunDot, 0.0, 1.0), 64.0) * 0.55;
  col += uSunColor * glow * (1.0 - uNight) * (1.0 - uStorm * 0.75);
  float disc = smoothstep(0.9986, 0.9993, sunDot);
  col = mix(col, uSunColor * 1.9, disc * (1.0 - uNight * 0.9) * (1.0 - uStorm * 0.9));

  // Moon: smaller, cooler, with a faint halo.
  float moonDot = dot(d, uMoonDir);
  float mdisc = smoothstep(0.9992, 0.9996, moonDot);
  col = mix(col, vec3(0.92, 0.95, 1.0), mdisc * uNight);
  col += vec3(0.35, 0.42, 0.62) * pow(clamp(moonDot, 0.0, 1.0), 96.0) * 0.35 * uNight;

  // Stars: stable cell hash so they do not shimmer between frames.
  if (uNight > 0.01) {
    vec2 sc = d.xz / max(abs(d.y), 0.08) * 8.0;
    vec2 cell = floor(sc);
    float r = h21(cell);
    if (r > 0.972) {
      vec2 c = fract(sc) - 0.5;
      float star = smoothstep(0.16, 0.0, length(c));
      float tw = 0.65 + 0.35 * sin(uTime * 1.7 + r * 40.0);
      col += vec3(1.0, 0.98, 0.94) * star * tw * uNight * smoothstep(0.03, 0.35, d.y);
    }
  }

  // Clouds, lit from the sun side.
  float cl = cloudField(d);
  if (cl > 0.001) {
    vec3 lit = mix(vec3(1.0), uSunColor, 0.35);
    vec3 shade = mix(vec3(0.78, 0.85, 0.94), vec3(0.42, 0.46, 0.54), uStorm);
    float lightSide = clamp(dot(normalize(d.xz - uSunDir.xz * 0.9), normalize(-uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0);
    vec3 cc = mix(shade, lit, lightSide);
    cc = mix(cc, vec3(0.16, 0.19, 0.26), uNight * 0.72);
    cc = mix(cc, vec3(0.30, 0.33, 0.38), uStorm * 0.65);
    col = mix(col, cc, cl * mix(0.92, 1.0, uStorm));
  }

  fragColor = vec4(col, 1.0);
}`;

/** Weather presets. Blended, never snapped, so transitions are watchable. */
export const WEATHER = {
  clear: { cloud: 0.15, storm: 0.0, wind: 4.0, waveScale: 0.55, rain: 0.0, fog: 0.00000030 },
  breezy: { cloud: 0.40, storm: 0.05, wind: 8.0, waveScale: 0.85, rain: 0.0, fog: 0.00000038 },
  overcast: { cloud: 0.75, storm: 0.25, wind: 11.0, waveScale: 1.05, rain: 0.0, fog: 0.00000055 },
  squall: { cloud: 0.92, storm: 0.65, wind: 17.0, waveScale: 1.5, rain: 0.6, fog: 0.00000090 },
  storm: { cloud: 1.00, storm: 1.00, wind: 24.0, waveScale: 2.1, rain: 1.0, fog: 0.00000140 },
};

export class Sky {
  constructor() {
    this.uniforms = {
      uZenith: { value: C(P.skyZenith) },
      uHorizon: { value: C(P.skyHorizon) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uSunColor: { value: C(P.sunLight) },
      uMoonDir: { value: new THREE.Vector3(-0.4, -0.7, -0.3).normalize() },
      uNight: { value: 0 },
      uStorm: { value: 0 },
      uTime: { value: 0 },
      uCloudCover: { value: 0.2 },
    };

    const geo = new THREE.SphereGeometry(1, 32, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      glslVersion: THREE.GLSL3,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';

    /**
     * The shared lighting environment. READ THIS, never guess.
     * @type {{sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number,
     *  skyColor: THREE.Color, groundColor: THREE.Color, ambientIntensity: number,
     *  fogColor: THREE.Color, fogDensity: number, night: number, storm: number,
     *  rimColor: THREE.Color, rimStrength: number, dayT: number}}
     */
    this.env = {
      sunDir: new THREE.Vector3(0.4, 0.7, 0.3).normalize(),
      sunColor: C(P.sunLight),
      sunIntensity: 1.0,
      skyColor: C(P.skyZenith),
      groundColor: C(P.sand),
      ambientIntensity: 1.0,
      fogColor: C(P.skyHorizon),
      fogDensity: 0.00000030,
      night: 0,
      storm: 0,
      rimColor: C(P.skyHorizon),
      rimStrength: 1.0,
      dayT: 0.3,
      exposure: 1.0,
    };
    this._weather = { ...WEATHER.clear };
  }

  /** Blend toward a weather preset. `t` is a 0..1 blend factor applied this call. */
  setWeatherBlend(fromKey, toKey, t) {
    const a = WEATHER[fromKey] || WEATHER.clear;
    const b = WEATHER[toKey] || WEATHER.clear;
    const w = this._weather;
    for (const k of Object.keys(a)) w[k] = lerp(a[k], b[k], t);
  }

  get weather() { return this._weather; }

  /**
   * @param {number} dayT time of day in [0,1). 0 = midnight, 0.25 = sunrise, 0.5 = noon.
   * @param {number} simTime seconds, for cloud drift and star twinkle.
   */
  update(dayT, simTime) {
    const u = this.uniforms;
    const env = this.env;
    const w = this._weather;

    // Sun travels a tilted arc so shadows sweep across the world instead of rotating flat.
    const ang = (dayT - 0.25) * TAU;
    const sx = Math.cos(ang) * 0.86;
    const sy = Math.sin(ang);
    const sz = Math.cos(ang) * 0.30 + 0.34;
    env.sunDir.set(sx, sy, sz).normalize();
    u.uSunDir.value.copy(env.sunDir);
    u.uMoonDir.value.copy(env.sunDir).multiplyScalar(-1);

    // Night factor ramps across the horizon crossing rather than snapping.
    const night = 1 - smoothstep(-0.14, 0.10, env.sunDir.y);
    env.night = night;
    u.uNight.value = night;

    // Golden hour: strongest when the sun is just above the horizon.
    const golden = smoothstep(0.34, 0.02, Math.abs(env.sunDir.y - 0.10));
    const storm = w.storm;
    env.storm = storm;
    u.uStorm.value = storm;
    u.uCloudCover.value = w.cloud;
    u.uTime.value = simTime;

    // Sky gradient: day -> dusk -> night, then desaturated toward storm.
    const dayZen = P.skyZenith, dayHor = P.skyHorizon;
    const duskZen = P.skyZenithDusk, duskHor = P.skyHorizonDusk;
    const nightZen = P.skyZenithNight, nightHor = P.skyHorizonNight;
    let zen = mixHex(dayZen, duskZen, golden);
    let hor = mixHex(dayHor, duskHor, golden);
    zen = mixHex(zen, nightZen, night);
    hor = mixHex(hor, nightHor, night);
    zen = mixHex(zen, P.skyZenithStorm, storm * 0.8);
    hor = mixHex(hor, P.skyHorizonStorm, storm * 0.8);
    u.uZenith.value.setHex(zen, THREE.SRGBColorSpace);
    u.uHorizon.value.setHex(hor, THREE.SRGBColorSpace);
    env.skyColor.setHex(zen, THREE.SRGBColorSpace);

    // Sun colour warms hard at golden hour; moonlight takes over at night.
    let sunHex = mixHex(P.sunLight, P.sunLightDusk, golden);
    sunHex = mixHex(sunHex, P.moonLight, night);
    sunHex = mixHex(sunHex, 0xb9c4cf, storm * 0.7);
    env.sunColor.setHex(sunHex, THREE.SRGBColorSpace);
    u.uSunColor.value.copy(env.sunColor);

    // Key intensity: full by day, a soft moon key at night. Never zero — silhouettes must read.
    env.sunIntensity = lerp(1.45, 0.34, night) * lerp(1.0, 0.42, storm);

    // Hemispheric ambient. Ground bounce is warm (sand/water), sky fill is cool.
    env.ambientIntensity = lerp(0.55, 0.30, night) * lerp(1.0, 1.25, storm);
    env.groundColor.setHex(mixHex(mixHex(P.sand, P.seaShallow, 0.45), P.skyZenithNight, night), THREE.SRGBColorSpace);

    // Fog is the horizon colour — this is what makes distance read without blur (ART_BAR §6).
    env.fogColor.setHex(hor, THREE.SRGBColorSpace);
    env.fogDensity = w.fog;

    // Rim light is sky-coloured and always present. ART_BAR §5 calls this the single most
    // identifiable feature of the reference, so it is a first-class lighting term, not a hack.
    env.rimColor.setHex(mixHex(hor, 0xffffff, 0.35), THREE.SRGBColorSpace);
    env.rimStrength = lerp(1.0, 0.55, night) * lerp(1.0, 0.7, storm);
    env.dayT = dayT;
    env.exposure = lerp(1.0, 1.18, night) * lerp(1.0, 0.94, storm);
    return env;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
