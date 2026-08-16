// The shared lighting model. Every lit surface in the game runs this exact code, which is
// why the frame reads as one place. Owner: rendering/lighting/sky/water/tonemap cluster.
//
// Model (from reference/ART_BAR.md §4 and §5):
//   key      = sun * wrapped N.L * shadow           -- one strong sun, upper-left
//   ambient  = hemispheric(cool sky above, warm bounce below)
//   rim      = sky-coloured fresnel on upward-facing edges   <- the signature look
//   faceTint = baked per-face voxel shading 1.00 / 0.86 / 0.74 + corner AO
//   shadowed albedo shifts blue-violet instead of going black
//
// All materials share ONE uniforms object per named uniform, so `updateShared()` updates
// every material in the scene in a single write. Adding a material never adds a per-frame cost.
//
// GLSL3 throughout: the voxel mesher packs a texture-array layer index per vertex, which
// needs sampler2DArray, which needs WebGL2 + GLSL 300 es.

import * as THREE from 'three';
import { SHADOW_GLSL } from './shadows.js';
import { P } from '../gen/palette.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Shared uniform objects. Referenced (not copied) by every material. */
export const shared = {
  uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
  uSunColor: { value: C(P.sunLight) },
  uSunIntensity: { value: 1.45 },
  uSkyColor: { value: C(P.skyZenith) },
  uGroundColor: { value: C(P.sand) },
  uAmbient: { value: 0.55 },
  uRimColor: { value: C(P.skyHorizon) },
  uRimStrength: { value: 1.0 },
  uFogColor: { value: C(P.skyHorizon) },
  uFogDensity: { value: 0.00000030 },
  uTime: { value: 0 },
  uCameraPos: { value: new THREE.Vector3() },
  uShadowTint: { value: new THREE.Color(0.46, 0.47, 0.66) },
  uNight: { value: 0 },
  uStorm: { value: 0 },
  uWetness: { value: 0 },
};

/**
 * Every material this module creates, so a late texture-array rebuild can re-point all of them.
 * Rigs build a private actor material per character (for per-character hit flash), so walking
 * the scene graph is not sufficient — materials exist that are not attached to any mesh yet.
 */
export const createdMaterials = [];

/** Re-point every material at a new atlas. Called if boot has to rebuild the texture array. */
export function rebindAtlas(atlas) {
  let n = 0;
  for (const m of createdMaterials) {
    if (m.uniforms && m.uniforms.uAtlas) { m.uniforms.uAtlas.value = atlas; n++; }
  }
  return n;
}

/** Merge shared + shadow uniforms into a per-material uniform block. */
export function withShared(extra, shadowUniforms) {
  return Object.assign({}, shared, shadowUniforms || {}, extra || {});
}

export const LIGHT_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uAmbient;
uniform vec3 uRimColor;
uniform float uRimStrength;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uCameraPos;
uniform vec3 uShadowTint;
uniform float uNight;
uniform float uStorm;
uniform float uWetness;

// Wrapped diffuse. w=0 is lambert; w>0 lets light bleed past the terminator so the dark
// side of a voxel keeps its hue instead of dropping to black.
float wrapDiffuse(float ndl, float w) {
  return clamp((ndl + w) / (1.0 + w), 0.0, 1.0);
}

// Hemispheric ambient: cool sky from above, warm bounce from sand/water below.
vec3 hemiAmbient(vec3 n) {
  return mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5) * uAmbient;
}

vec3 applyFog(vec3 col, vec3 v, float viewDist) {
  float fogAmt = 1.0 - exp(-uFogDensity * viewDist * viewDist);
  float sunAmt = pow(clamp(dot(-v, uSunDir), 0.0, 1.0), 4.0);
  vec3 fogCol = mix(uFogColor, uSunColor, sunAmt * 0.32 * (1.0 - uNight));
  return mix(col, fogCol, clamp(fogAmt, 0.0, 1.0));
}

/**
 * The one lighting function.
 * albedo   : surface colour, already face-tinted
 * n        : world normal
 * worldPos : world position
 * ao       : 1 = open, 0 = fully occluded (from the voxel mesher)
 * shadow   : 1 = lit, 0 = shadowed (from getShadow)
 * rimBoost : per-material multiplier; characters get more than terrain
 */
vec3 shadeSurface(vec3 albedo, vec3 n, vec3 worldPos, float ao, float shadow, float rimBoost) {
  vec3 viewVec = uCameraPos - worldPos;
  float viewDist = length(viewVec);
  vec3 v = viewVec / max(viewDist, 1e-4);

  float ndl = dot(n, uSunDir);
  float lightAmt = wrapDiffuse(ndl, 0.32) * shadow;

  // ART_BAR §5: shadowed albedo shifts blue-violet and holds ~60% luminance, never black.
  vec3 shadedAlbedo = mix(albedo * uShadowTint * 1.6, albedo, clamp(lightAmt * 1.15, 0.0, 1.0));

  vec3 key = uSunColor * uSunIntensity * lightAmt;
  vec3 amb = hemiAmbient(n) * mix(0.55, 1.0, ao);
  vec3 col = shadedAlbedo * (key + amb);

  // Rim: sky-coloured, and it must stay a RIM. A low fresnel exponent turns this into a
  // full-surface wash that bleaches every character to cream — measured, not theorised: at
  // exponent 3 and gain 0.85 the rim term alone reached ~1.1 in linear, on top of a key of
  // ~1.3, so the tone map clipped everything to white. Exponent 5 confines it to the
  // silhouette; the gain is then set so the brightest rim sits just under the key.
  float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 5.0);
  float upward = clamp(n.y * 0.5 + 0.55, 0.0, 1.0);
  // Strongest where the sun is NOT already lighting the surface — that is what makes an edge
  // read as an edge instead of adding a second, flatter key light.
  float rimFalloff = mix(1.0, 0.35, clamp(ndl, 0.0, 1.0));
  col += uRimColor * fres * upward * rimFalloff * uRimStrength * rimBoost * 0.42 * mix(0.5, 1.0, shadow);

  // Wet surfaces (rain / shoreline) get a tight sky-coloured sheen, never plastic specular.
  if (uWetness > 0.01) {
    vec3 h = normalize(uSunDir + v);
    float spec = pow(clamp(dot(n, h), 0.0, 1.0), 48.0);
    col += uSunColor * spec * uWetness * 0.35 * shadow;
    col = mix(col, col * 0.88, uWetness * 0.32);
  }

  return applyFog(col, v, viewDist);
}
`;

/** Vertex shader shared by all voxel geometry (chunks, props, ship, actors). */
export const VOXEL_VERT = /* glsl */`
in float aShade;
in float aAo;
in float aLayer;
out vec3 vWorld;
out vec3 vNormal;
out float vShade;
out float vAo;
out float vLayer;
out vec2 vUv;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vShade = aShade;
  vAo = aAo;
  vLayer = aLayer;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG_HEAD = /* glsl */`
precision highp float;
precision highp sampler2DArray;
in vec3 vWorld;
in vec3 vNormal;
in float vShade;
in float vAo;
in float vLayer;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2DArray uAtlas;
uniform float uRimBoost;
uniform float uAlphaTest;
`;

export const VOXEL_FRAG = /* glsl */`
${FRAG_HEAD}
${LIGHT_GLSL}
${SHADOW_GLSL}
void main() {
  vec4 tex = texture(uAtlas, vec3(fract(vUv), vLayer));
  if (tex.a < uAlphaTest) discard;
  vec3 n = normalize(vNormal);
  float viewDist = distance(uCameraPos, vWorld);
  float shadow = getShadow(vWorld, dot(n, uSunDir), viewDist);
  fragColor = vec4(shadeSurface(tex.rgb * vShade, n, vWorld, vAo, shadow, uRimBoost), 1.0);
}`;

/**
 * Actor fragment shader. Adds hit flash, a fruit-power aura, and a voxel dissolve for deaths.
 * Characters get a higher rim boost — ART_BAR §2 wants them to pop off the sky.
 */
export const ACTOR_FRAG = /* glsl */`
${FRAG_HEAD}
${LIGHT_GLSL}
${SHADOW_GLSL}
uniform vec3 uFlashColor;
uniform float uFlash;
uniform vec3 uAuraColor;
uniform float uAura;
uniform float uDissolve;
uniform float uTint;
uniform vec3 uTintColor;

float h31(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

void main() {
  vec4 tex = texture(uAtlas, vec3(fract(vUv), vLayer));
  if (tex.a < uAlphaTest) discard;
  if (uDissolve > 0.001) {
    if (h31(floor(vWorld * 6.0)) < uDissolve) discard;
  }
  vec3 albedo = tex.rgb * vShade;
  albedo = mix(albedo, uTintColor, uTint);
  vec3 n = normalize(vNormal);
  float viewDist = distance(uCameraPos, vWorld);
  float shadow = getShadow(vWorld, dot(n, uSunDir), viewDist);
  vec3 col = shadeSurface(albedo, n, vWorld, vAo, shadow, uRimBoost);

  if (uAura > 0.001) {
    vec3 v = normalize(uCameraPos - vWorld);
    float f = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.0);
    col += uAuraColor * (uAura * (0.30 + f * 1.6));
  }
  col = mix(col, uFlashColor, uFlash);
  fragColor = vec4(col, 1.0);
}`;

function baseParams(atlas, shadowUniforms, extra, frag, opts) {
  return {
    glslVersion: THREE.GLSL3,
    uniforms: withShared(Object.assign({
      uAtlas: { value: atlas },
      uRimBoost: { value: opts.rimBoost !== undefined ? opts.rimBoost : 0.8 },
      uAlphaTest: { value: opts.alphaTest !== undefined ? opts.alphaTest : 0.5 },
    }, extra), shadowUniforms),
    vertexShader: VOXEL_VERT,
    fragmentShader: frag,
    side: opts.side || THREE.FrontSide,
    fog: false,
  };
}

/** Terrain / prop / ship material. One instance is shared by all chunk meshes. */
export function makeVoxelMaterial(atlas, shadowUniforms, opts = {}) {
  const m = new THREE.ShaderMaterial(baseParams(atlas, shadowUniforms, null, VOXEL_FRAG, opts));
  m.name = opts.name || 'voxel';
  createdMaterials.push(m);
  return m;
}

export function makeActorMaterial(atlas, shadowUniforms, opts = {}) {
  const m = new THREE.ShaderMaterial(baseParams(atlas, shadowUniforms, {
    uFlashColor: { value: new THREE.Color(1, 1, 1) },
    uFlash: { value: 0 },
    uAuraColor: { value: new THREE.Color(0, 0, 0) },
    uAura: { value: 0 },
    uDissolve: { value: 0 },
    uTint: { value: 0 },
    uTintColor: { value: new THREE.Color(1, 1, 1) },
  }, ACTOR_FRAG, Object.assign({ rimBoost: 1.55 }, opts)));
  m.name = opts.name || 'actor';
  createdMaterials.push(m);
  return m;
}

/** Push this frame's sky environment into the shared uniforms. One call, whole scene. */
export function updateShared(env, cameraPos, simTime, wetness) {
  shared.uSunDir.value.copy(env.sunDir);
  shared.uSunColor.value.copy(env.sunColor);
  shared.uSunIntensity.value = env.sunIntensity;
  shared.uSkyColor.value.copy(env.skyColor);
  shared.uGroundColor.value.copy(env.groundColor);
  shared.uAmbient.value = env.ambientIntensity;
  shared.uRimColor.value.copy(env.rimColor);
  shared.uRimStrength.value = env.rimStrength;
  shared.uFogColor.value.copy(env.fogColor);
  shared.uFogDensity.value = env.fogDensity;
  shared.uCameraPos.value.copy(cameraPos);
  shared.uTime.value = simTime;
  shared.uNight.value = env.night;
  shared.uStorm.value = env.storm;
  shared.uWetness.value = wetness || 0;
}
