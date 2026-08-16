// Render graph + tone mapping. Owner: Cluster A.
//
// Passes, in order:
//   1. shadow      -> depth atlas, 2 cascades
//   2. scene       -> MSAA HDR target (sky, opaque, water, transparent FX)
//   3. brightpass  -> 1/4 res
//   4. blur H, V   -> 1/4 res
//   5. composite   -> canvas (tonemap, bloom, split-tone, vignette, underwater, damage)
//
// Everything is compiled during boot by prewarm(). A shader compiled during play is a
// gate failure, so new materials must be registered before the first frame is presented.

import * as THREE from 'three';
import { ShadowAtlas } from './shadows.js';
import { P } from '../gen/palette.js';

const FS_VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  // Soft knee so the bloom fades in instead of switching on.
  float t = clamp((l - uThreshold) / max(uKnee, 1e-4), 0.0, 1.0);
  fragColor = vec4(c * t * t, 1.0);
}`;

const BLUR_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;   // texel-sized step
void main() {
  // 9-tap Gaussian, linear-sampled to 5 fetches.
  vec3 c = texture(uTex, vUv).rgb * 0.2270270270;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  c += texture(uTex, vUv + o1).rgb * 0.3162162162;
  c += texture(uTex, vUv - o1).rgb * 0.3162162162;
  c += texture(uTex, vUv + o2).rgb * 0.0702702703;
  c += texture(uTex, vUv - o2).rgb * 0.0702702703;
  fragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;

uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uExposure;
uniform float uBloomStrength;
uniform float uVignette;
uniform float uSaturation;
uniform vec3 uLift;        // shadow tint (cool)
uniform vec3 uGain;        // highlight tint (warm)
uniform float uUnderwater; // 0..1
uniform vec3 uUnderwaterColor;
uniform float uDamage;     // 0..1 red edge pulse
uniform vec3 uDamageColor;
uniform float uFruitTint;
uniform vec3 uFruitColor;
uniform float uTime;
uniform vec2 uResolution;
uniform float uFxaa;

// Khronos PBR Neutral tone map: soft highlight rolloff that keeps hue and saturation.
// Chosen over ACES because ACES desaturates exactly the saturated primaries the art bar wants.
vec3 neutralTonemap(vec3 c) {
  const float startCompression = 0.76;
  const float desaturation = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) return c;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, vec3(newPeak), g);
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// FXAA 3.11-style edge AA, one pass, ~10 taps.
// Measured on the target Intel UHD: 4x MSAA on a 1080p fp16 target costs 34 ms/frame, which is
// twice the entire frame budget. This costs a fraction of a millisecond and voxel silhouettes
// are exactly the high-contrast hard edges FXAA handles best.
vec3 fxaa(sampler2D tex, vec2 uv, vec2 rcp) {
  vec3 rgbM = texture(tex, uv).rgb;
  float lM  = luma(rgbM);
  float lNW = luma(texture(tex, uv + vec2(-1.0, -1.0) * rcp).rgb);
  float lNE = luma(texture(tex, uv + vec2( 1.0, -1.0) * rcp).rgb);
  float lSW = luma(texture(tex, uv + vec2(-1.0,  1.0) * rcp).rgb);
  float lSE = luma(texture(tex, uv + vec2( 1.0,  1.0) * rcp).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  float range = lMax - lMin;
  // Flat areas: skip entirely. Most of the screen takes this path.
  if (range < max(0.0312, lMax * 0.125)) return rgbM;

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, -8.0, 8.0) * rcp;

  vec3 rgbA = 0.5 * (texture(tex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                     texture(tex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture(tex, uv + dir * -0.5).rgb +
                                   texture(tex, uv + dir *  0.5).rgb);
  float lB = luma(rgbB);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}

void main() {
  vec3 col = uFxaa > 0.5 ? fxaa(uScene, vUv, 1.0 / uResolution) : texture(uScene, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  col += bloom * uBloomStrength;

  if (uUnderwater > 0.001) {
    float depthFade = mix(1.0, 0.35, uUnderwater);
    col = mix(col, col * uUnderwaterColor * 1.6, uUnderwater * 0.8) * depthFade;
    // Caustic-ish banding, cheap and readable.
    float caust = sin(vUv.y * 90.0 + uTime * 2.0) * sin(vUv.x * 70.0 - uTime * 1.3);
    col += uUnderwaterColor * max(caust, 0.0) * 0.05 * uUnderwater;
  }

  col *= uExposure;
  col = neutralTonemap(col);

  // Split tone: cool lift in shadows, warm gain in highlights (ART_BAR §7).
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = col + uLift * (1.0 - smoothstep(0.0, 0.55, lum)) * 0.06;
  col = col * mix(vec3(1.0), uGain, smoothstep(0.35, 1.0, lum) * 0.5);

  // Saturation.
  lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, uSaturation);

  if (uFruitTint > 0.001) {
    col = mix(col, col * uFruitColor * 1.25 + uFruitColor * 0.06, uFruitTint);
  }

  // Vignette: gentle, never a black frame.
  vec2 q = vUv - 0.5;
  float vig = 1.0 - dot(q, q) * uVignette;
  col *= clamp(vig, 0.0, 1.0);

  if (uDamage > 0.001) {
    float edge = smoothstep(0.18, 0.62, length(q) * 1.35);
    float pulse = 0.72 + 0.28 * sin(uTime * 13.0);
    col = mix(col, uDamageColor, edge * uDamage * pulse);
  }

  col = linearToSrgb(max(col, 0.0));
  // Ordered dither breaks up gradient banding in the sky on 8-bit output.
  float d = (h21(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(col + d, 1.0);
}`;

function fsQuad(material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const m = new THREE.Mesh(geo, material);
  m.frustumCulled = false;
  return m;
}

export class Renderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.msaa = opts.msaa !== undefined ? opts.msaa : 0;
    /** Quality switches. Also used by the perf ablation to attribute cost. */
    this.skipBloom = !!opts.skipBloom;
    this.ldrTarget = !!opts.ldrTarget;
    this.resolutionScale = opts.resolutionScale || 1;
    /**
     * Dynamic resolution. The scene renders into an internal target whose scale adapts to the
     * measured frame time (composite always outputs at native canvas size), which is how every
     * shipped console/laptop title holds frame rate on a weak GPU without deleting features.
     * OFF unless an entry opts in: capture mode must never enable it — the scale depends on
     * wall-clock timing, and deterministic pixel evidence cannot depend on the wall clock.
     * The renderer itself reads no clock; entries pass frame durations into updateDynamicRes.
     */
    this.dynamicRes = !!opts.dynamicRes;
    // Budget default 17.4ms: just over one 60Hz period, so a healthy vsynced frame (~16.7ms
    // RAF gap even when the GPU is idle) never reads as slow, while a missed vsync (~33ms)
    // always does. The vsync-off profiler passes a stricter budget aligned with its gate.
    this._drs = {
      budget: opts.drsBudgetMs || 17.4,
      // Step-up hysteresis: only climb when the whole window clears budget by this margin.
      // Play mode leaves it 0 (vsync-quantised gaps carry no headroom information); the
      // profiler passes ~1.8ms because its batch samples are true cost. Without this the
      // controller HUNTS around the GPU's capacity cliff — measured on the 20-min soak:
      // scale oscillated 0.775-1.0 and the overshoot samples alone pushed p95 to 17.6.
      upMargin: opts.drsUpMarginMs || 0,
      min: 0.7, n: 0, over: 0, maxMs: 0, cooldown: 0,
      minSeen: this.resolutionScale,
    };
    this.outWidth = 1; this.outHeight = 1;

    this.gl = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      failIfMajorPerformanceCaveat: false,
    });
    this.gl.setPixelRatio(1);           // fixed: capture determinism and predictable perf
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;   // we tone map in the composite pass
    this.gl.autoClear = true;
    this.gl.info.autoReset = false;

    this.shadow = new ShadowAtlas(this.gl, opts.shadowSize || 1024);
    // Far cascade refreshed every other frame (sun moves ~0.0001 rad/frame — invisible).
    // Wall-clock-adaptive like dynamicRes, so capture mode never enables it.
    this.shadow.temporal = !!opts.temporalShadows;

    this.width = 1; this.height = 1;
    this.sceneTarget = null;
    this.bloomA = null;
    this.bloomB = null;

    this.brightMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: BRIGHT_FRAG,
      uniforms: { uScene: { value: null }, uThreshold: { value: 1.05 }, uKnee: { value: 0.6 } },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: BLUR_FRAG,
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        uScene: { value: null },
        uBloom: { value: null },
        uExposure: { value: 1.0 },
        uBloomStrength: { value: 0.34 },
        uVignette: { value: 0.42 },
        uSaturation: { value: 1.12 },
        uLift: { value: new THREE.Color(0.30, 0.36, 0.62) },
        uGain: { value: new THREE.Color(1.04, 1.0, 0.94) },
        uUnderwater: { value: 0 },
        uUnderwaterColor: { value: new THREE.Color().setHex(P.seaShallow, THREE.SRGBColorSpace) },
        uDamage: { value: 0 },
        uDamageColor: { value: new THREE.Color().setHex(P.uiRed, THREE.SRGBColorSpace) },
        uFruitTint: { value: 0 },
        uFruitColor: { value: new THREE.Color(1, 1, 1) },
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uFxaa: { value: 1 },
      },
      depthTest: false, depthWrite: false,
    });

    this.fsScene = new THREE.Scene();
    this.fsCamera = new THREE.Camera();
    this.quadBright = fsQuad(this.brightMat);
    this.quadBlur = fsQuad(this.blurMat);
    this.quadComposite = fsQuad(this.compositeMat);

    this.stats = { drawCalls: 0, triangles: 0, programs: 0, shaderCompiles: 0 };
    this._knownPrograms = 0;
    this._prewarmed = false;
  }

  get capabilities() { return this.gl.capabilities; }

  setSize(w, h) {
    const W = Math.max(1, Math.round(w * this.resolutionScale));
    const H = Math.max(1, Math.round(h * this.resolutionScale));
    if (W === this.width && H === this.height && w === this.outWidth && h === this.outHeight) return;
    this.outWidth = w; this.outHeight = h;
    this.width = W; this.height = H;
    this.gl.setSize(w, h, false);

    if (this.sceneTarget) this.sceneTarget.dispose();
    this.sceneTarget = new THREE.WebGLRenderTarget(W, H, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: this.ldrTarget ? THREE.UnsignedByteType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.msaa,
      generateMipmaps: false,
    });

    const bw = Math.max(1, W >> 2), bh = Math.max(1, H >> 2);
    if (this.bloomA) this.bloomA.dispose();
    if (this.bloomB) this.bloomB.dispose();
    const bopts = {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, bopts);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, bopts);
    this.compositeMat.uniforms.uResolution.value.set(W, H);
    // FXAA only makes sense when MSAA is not already resolving the edges.
    this.compositeMat.uniforms.uFxaa.value = this.msaa > 0 ? 0 : 1;
  }

  /**
   * Resize the internal targets to a new resolution scale without touching the canvas.
   * WebGLRenderTarget.setSize keeps the same texture objects (uniforms stay valid) and
   * reallocates GPU storage lazily; no shader relinks, so the zero-compile gate is safe.
   */
  _applyScale(s) {
    this.resolutionScale = s;
    const W = Math.max(1, Math.round(this.outWidth * s));
    const H = Math.max(1, Math.round(this.outHeight * s));
    if (W === this.width && H === this.height) return;
    this.width = W; this.height = H;
    this.sceneTarget.setSize(W, H);
    this.bloomA.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2));
    this.bloomB.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2));
    this.compositeMat.uniforms.uResolution.value.set(W, H);
  }

  /**
   * Dynamic-resolution controller. Entries (play/profile only) call this once per RAF frame
   * with the last frame's wall-clock duration in ms; capture never calls it.
   *
   * Decisions are made per 30-frame window on the FRACTION of over-budget frames, not an
   * average — an average frame time is the one statistic that cannot describe a stutter,
   * here as everywhere else in this project. Down-steps are fast (badly over → 0.10) because
   * a slow first second pollutes p95; up-steps are slow and demand a fully clean window, so
   * the scale cannot oscillate.
   */
  updateDynamicRes(frameMs) {
    if (!this.dynamicRes || !(frameMs > 0)) return;
    const d = this._drs;
    d.n++;
    if (frameMs > d.budget) d.over++;
    if (frameMs > d.maxMs) d.maxMs = frameMs;
    if (d.n < 30) return;
    const overFrac = d.over / d.n;
    const winMax = d.maxMs;
    d.n = 0; d.over = 0; d.maxMs = 0;
    if (d.cooldown > 0) { d.cooldown--; return; }
    let s = this.resolutionScale;
    if (overFrac > 0.05 && s > d.min) {
      // No cooldown on the way down: consecutive over-budget windows step consecutively.
      // A late reaction to a thermal swing records over-budget frames a player would see.
      s = Math.max(d.min, +(s - (overFrac > 0.4 ? 0.10 : 0.05)).toFixed(3));
    } else if (overFrac === 0 && winMax < d.budget - d.upMargin && s < 1) {
      s = Math.min(1, +(s + 0.025).toFixed(3));
      d.cooldown = 6;
    }
    if (s !== this.resolutionScale) {
      d.minSeen = Math.min(d.minSeen, s);
      this._applyScale(s);
    }
  }

  /** Current dynamic-resolution state, for reports and HUD debug. */
  drsState() {
    return {
      enabled: this.dynamicRes,
      scale: this.resolutionScale,
      minSeen: this._drs.minSeen,
      budgetMs: this._drs.budget,
    };
  }

  /**
   * Compile every material before the first presented frame.
   * @param {THREE.Scene} scene a scene containing at least one mesh per distinct material
   * @param {THREE.Camera} camera
   */
  async prewarm(scene, camera) {
    const t0 = performance.now();
    const gl = this.gl;
    const prevTarget = gl.getRenderTarget();

    // three keys shader programs partly by the OUTPUT COLOUR SPACE of the bound render target.
    // Compiling against the canvas (srgb) and then rendering into the HDR target (srgb-linear)
    // silently relinks every world material on the first frame — which is exactly the
    // "zero shader compilations during play" gate. So each pass is pre-warmed with the same
    // render target it will actually run against.
    gl.setRenderTarget(this.sceneTarget);
    await gl.compileAsync(scene, camera);

    // Shadow pass. NOTE: three's compile()/compileAsync() reads `object.material` and ignores
    // `scene.overrideMaterial`, so setting the override here compiles nothing — the depth shader
    // then links on the first frame that actually casts a shadow. The caller therefore puts real
    // meshes carrying `shadow.depthMat` into the prewarm scene instead.
    gl.setRenderTarget(this.shadow.target);
    await gl.compileAsync(scene, this.shadow.cameras[0]);

    // Post chain: bright and blur run into the (linear) bloom targets, composite into the canvas.
    this.brightMat.uniforms.uScene.value = this.sceneTarget.texture;
    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.compositeMat.uniforms.uScene.value = this.sceneTarget.texture;
    this.compositeMat.uniforms.uBloom.value = this.bloomA.texture;
    for (const [quad, target] of [[this.quadBright, this.bloomA], [this.quadBlur, this.bloomB], [this.quadComposite, null]]) {
      this.fsScene.children.length = 0;
      this.fsScene.add(quad);
      gl.setRenderTarget(target);
      await gl.compileAsync(this.fsScene, this.fsCamera);
    }
    this.fsScene.children.length = 0;
    gl.setRenderTarget(prevTarget);

    this._knownPrograms = gl.info.programs ? gl.info.programs.length : 0;
    this._prewarmed = true;
    return performance.now() - t0;
  }

  /** Programs linked since prewarm — must stay at 0 during play. */
  newProgramsSincePrewarm() {
    const n = this.gl.info.programs ? this.gl.info.programs.length : 0;
    return Math.max(0, n - this._knownPrograms);
  }

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {object} env Sky.env
   * @param {object} post { underwater, damage, fruitTint, fruitColor, exposure, time }
   * @param {THREE.Object3D[]} shadowSkip objects that must not cast shadows
   * @param {THREE.Vector3} shadowCenter
   */
  render(scene, camera, env, post, shadowSkip, shadowCenter) {
    const gl = this.gl;
    gl.info.reset();

    this.shadow.update(shadowCenter || camera.position, env.sunDir);
    this.shadow.render(scene, shadowSkip || []);

    gl.setRenderTarget(this.sceneTarget);
    gl.setViewport(0, 0, this.width, this.height);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    gl.render(scene, camera);

    const sceneDraws = gl.info.render.calls;
    const sceneTris = gl.info.render.triangles;

    // Bloom: bright pass then two separable blurs, all at quarter resolution.
    if (this.skipBloom) {
      this.compositeMat.uniforms.uBloomStrength.value = 0;
    } else {
    this.fsScene.children.length = 0;
    this.fsScene.add(this.quadBright);
    this.brightMat.uniforms.uScene.value = this.sceneTarget.texture;
    gl.setRenderTarget(this.bloomA);
    gl.setViewport(0, 0, this.bloomA.width, this.bloomA.height);
    gl.render(this.fsScene, this.fsCamera);

    this.fsScene.children.length = 0;
    this.fsScene.add(this.quadBlur);
    const bw = this.bloomA.width, bh = this.bloomA.height;
    this.blurMat.uniforms.uTex.value = this.bloomA.texture;
    this.blurMat.uniforms.uDir.value.set(1 / bw, 0);
    gl.setRenderTarget(this.bloomB);
    gl.render(this.fsScene, this.fsCamera);
    this.blurMat.uniforms.uTex.value = this.bloomB.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / bh);
    gl.setRenderTarget(this.bloomA);
    gl.render(this.fsScene, this.fsCamera);
    }

    // Composite to the canvas.
    const cu = this.compositeMat.uniforms;
    cu.uScene.value = this.sceneTarget.texture;
    cu.uBloom.value = this.bloomA.texture;
    cu.uExposure.value = (post && post.exposure) || env.exposure || 1;
    cu.uUnderwater.value = (post && post.underwater) || 0;
    cu.uDamage.value = (post && post.damage) || 0;
    cu.uFruitTint.value = (post && post.fruitTint) || 0;
    if (post && post.fruitColor) cu.uFruitColor.value.copy(post.fruitColor);
    cu.uTime.value = (post && post.time) || 0;
    this.fsScene.children.length = 0;
    this.fsScene.add(this.quadComposite);
    gl.setRenderTarget(null);
    // Composite outputs at NATIVE canvas size — internal width/height may be scaled down by
    // dynamic resolution, and a scaled viewport here would render into a corner of the canvas.
    gl.setViewport(0, 0, this.outWidth, this.outHeight);
    gl.render(this.fsScene, this.fsCamera);
    this.fsScene.children.length = 0;

    this.stats.drawCalls = sceneDraws;
    this.stats.triangles = sceneTris;
    this.stats.programs = gl.info.programs ? gl.info.programs.length : 0;
  }

  dispose() {
    this.shadow.dispose();
    if (this.sceneTarget) this.sceneTarget.dispose();
    if (this.bloomA) this.bloomA.dispose();
    if (this.bloomB) this.bloomB.dispose();
    this.brightMat.dispose(); this.blurMat.dispose(); this.compositeMat.dispose();
    this.gl.dispose();
  }
}
