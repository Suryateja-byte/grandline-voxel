// Cascaded shadow maps, hand-rolled.
//
// three.js gives one shadow map per light; we need two cascades and full control of the
// shadow *colour* (ART_BAR §5: shadows are blue-violet at 55-65% luminance, never black),
// so every lit material samples this atlas itself via SHADOW_GLSL below.
//
// Layout: one depth texture, cascades tiled horizontally: 2 x SIZE wide, SIZE tall.
// Cascade cameras are real OrthographicCameras so three's frustum culling works normally.

import * as THREE from 'three';

export const CASCADE_COUNT = 2;

// Scratch vectors for saving renderer state. Module-level so the shadow pass allocates nothing.
const _savedViewport = new THREE.Vector4();
const _savedScissor = new THREE.Vector4();

const DEPTH_VERT = /* glsl */`
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DEPTH_FRAG = /* glsl */`
void main() { gl_FragColor = vec4(1.0); }`;

export class ShadowAtlas {
  constructor(renderer, size = 1024) {
    this.renderer = renderer;
    this.size = size;
    this.enabled = true;
    /**
     * When true, the far cascade (1) refreshes every other frame. The sun moves ~0.0001 rad
     * per frame so a one-frame-old far cascade is invisible, and it is most of the pass's
     * draw calls. Play/profile opt in; capture never does (frame parity is not part of a
     * shot's definition, and deterministic evidence must not depend on it).
     */
    this.temporal = false;
    this._frame = 0;
    this._refresh = [true, true];

    const w = size * CASCADE_COUNT, h = size;
    // Colour attachment is required by WebGL even though we only read depth; keep it tiny.
    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'shadowAtlasColor';

    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.generateMipmaps = false;
    // NOTE: no compareFunction — we do manual PCF, so this must stay a plain sampler2D.
    this.target.depthTexture = depth;

    this.cameras = [];
    this.matrices = [];
    for (let i = 0; i < CASCADE_COUNT; i++) {
      const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 500);
      this.cameras.push(c);
      this.matrices.push(new THREE.Matrix4());
    }
    /** Cascade radii in metres. 0 hugs the player for contact shadows; 1 covers ship + island. */
    this.radii = [24, 105];

    this.depthMat = new THREE.ShaderMaterial({
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.FrontSide,
      fog: false,
    });
    this.depthMat.name = 'shadowDepth';

    this.uniforms = {
      uShadowMap: { value: depth },
      uShadowMat0: { value: this.matrices[0] },
      uShadowMat1: { value: this.matrices[1] },
      uShadowSplit: { value: new THREE.Vector2(this.radii[0], this.radii[1]) },
      uShadowTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uShadowStrength: { value: 1.0 },
    };
  }

  /** Fit cascades around `center` along `sunDir`. Texel-snapped so shadows do not crawl. */
  update(center, sunDir) {
    this._frame = (this._frame + 1) | 0;
    for (let i = 0; i < CASCADE_COUNT; i++) {
      // A skipped cascade keeps BOTH its depth tile and its matrix from the last refresh —
      // updating the matrix without re-rendering would sample old depth through a new
      // projection and the shadows would swim.
      this._refresh[i] = !(this.temporal && i === 1 && (this._frame & 1) === 0);
      if (!this._refresh[i]) continue;
      const r = this.radii[i];
      const cam = this.cameras[i];
      const texel = (2 * r) / this.size;
      const cx = Math.round(center.x / texel) * texel;
      const cy = Math.round(center.y / texel) * texel;
      const cz = Math.round(center.z / texel) * texel;
      const dist = r * 2.6 + 140;
      cam.position.set(cx + sunDir.x * dist, cy + sunDir.y * dist, cz + sunDir.z * dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(cx, cy, cz);
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 1; cam.far = dist * 2 + r * 2;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      this.matrices[i].multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    }
    this.uniforms.uShadowSplit.value.set(this.radii[0], this.radii[1]);
  }

  /**
   * Render the shadow pass.
   * @param {THREE.Scene} scene the real scene
   * @param {THREE.Object3D[]} skip top-level objects that must not cast (sky, water, fx, ui)
   */
  render(scene, skip) {
    if (!this.enabled) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevOverride = scene.overrideMaterial;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevClearAlpha = r.getClearAlpha();
    // three keeps ONE persistent viewport/scissor. Tiling cascades means writing it, so it must
    // be restored exactly — otherwise every later pass renders into a 2048x1024 viewport on a
    // 1920x1080 buffer and you get a magnified crop of the lower-left corner of the frame.
    r.getViewport(_savedViewport);
    r.getScissor(_savedScissor);
    const prevScissorTest = r.getScissorTest();

    const hidden = [];
    for (const o of skip) {
      if (o && o.visible) { o.visible = false; hidden.push(o); }
    }
    scene.overrideMaterial = this.depthMat;

    r.setRenderTarget(this.target);
    r.setClearColor(0xffffff, 1);
    r.autoClear = false;
    r.setScissorTest(true);

    for (let i = 0; i < CASCADE_COUNT; i++) {
      if (!this._refresh[i]) continue;   // temporal: tile keeps last frame's depth
      const x = i * this.size;
      r.setViewport(x, 0, this.size, this.size);
      r.setScissor(x, 0, this.size, this.size);
      // Scissored clear: only this tile. A full-target clear would wipe the depth of a
      // cascade that is deliberately not being re-rendered this frame.
      r.clear(true, true, false);
      r.render(scene, this.cameras[i]);
    }

    scene.overrideMaterial = prevOverride;
    for (const o of hidden) o.visible = true;

    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    r.setScissorTest(prevScissorTest);
    r.setScissor(_savedScissor);
    r.setViewport(_savedViewport);
    r.setClearColor(prevClear, prevClearAlpha);
  }

  dispose() {
    this.target.dispose();
    this.depthMat.dispose();
  }
}

/** GLSL injected into every lit material (terrain, actors, ship, props). */
export const SHADOW_GLSL = /* glsl */`
uniform sampler2D uShadowMap;
uniform mat4 uShadowMat0;
uniform mat4 uShadowMat1;
uniform vec2 uShadowSplit;
uniform vec2 uShadowTexel;
uniform float uShadowStrength;

float shadowTile(vec3 sc, float tileIndex, float bias) {
  vec2 uv = sc.xy * 0.5 + 0.5;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return 1.0;
  uv.x = (uv.x + tileIndex) * 0.5;   // 2 cascades tiled horizontally
  float depth = sc.z * 0.5 + 0.5;
  if (depth > 1.0) return 1.0;
  vec2 o = uShadowTexel;
  float s = 0.0;
  s += step(depth - bias, texture(uShadowMap, uv).r);
  s += step(depth - bias, texture(uShadowMap, uv + vec2( o.x,  o.y)).r);
  s += step(depth - bias, texture(uShadowMap, uv + vec2(-o.x,  o.y)).r);
  s += step(depth - bias, texture(uShadowMap, uv + vec2( o.x, -o.y)).r);
  s += step(depth - bias, texture(uShadowMap, uv + vec2(-o.x, -o.y)).r);
  return s * 0.2;
}

float getShadow(vec3 worldPos, float ndl, float viewDist) {
  if (uShadowStrength <= 0.001) return 1.0;
  float bias = mix(0.0012, 0.0055, 1.0 - clamp(ndl, 0.0, 1.0));
  float s;
  if (viewDist < uShadowSplit.x * 0.85) {
    vec4 p = uShadowMat0 * vec4(worldPos, 1.0);
    s = shadowTile(p.xyz / p.w, 0.0, bias);
  } else {
    vec4 p = uShadowMat1 * vec4(worldPos, 1.0);
    s = shadowTile(p.xyz / p.w, 1.0, bias * 2.6);
    s = mix(s, 1.0, smoothstep(uShadowSplit.y * 0.70, uShadowSplit.y * 0.97, viewDist));
  }
  return mix(1.0, s, uShadowStrength);
}
`;
