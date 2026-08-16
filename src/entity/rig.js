// The rig: a THREE.Group hierarchy over the parts that buildCharacter() produced.
// Owner: Cluster B (character / rig / animation / camera).
//
// charmodel emits every part's geometry **relative to that part's own pivot**, and reports
// each pivot in model space (feet on y = 0, centred on x = 0). The rig therefore never touches
// vertices: it places each node at (its pivot - its parent's pivot) once at construction, and
// after that only writes rotations, small offsets and scales. That is the entire reason parts
// exist, and it is why setPose() costs a handful of float writes per actor.
//
// Hierarchy (ARCHITECTURE, Cluster B brief):
//   root
//    └ hips
//       ├ torso
//       │   ├ head
//       │   │   └ hat        (identity element — the silhouette breaker)
//       │   ├ armL
//       │   ├ armR ─ weapon
//       │   └ extra          (cape / backpack / fin; charmodel says which parent it wants)
//       ├ legL
//       └ legR
//
// Rotation order is ZXY on every node so that roll is applied outermost, matching the
// convention charmodel's silhouette test uses for the authored bind poses. Get this wrong and
// every archetype's authored stance silently changes shape.

import * as THREE from 'three';
import { JOINTS } from './anim.js';
import { clamp01 } from '../core/math.js';
import { makeActorMaterial } from '../render/materials.js';

/** Which node parents which part. `extra` is resolved from the part's own `attach` field. */
const PARENT_OF = Object.freeze({
  torso: 'hips',
  head: 'torso',
  armL: 'torso',
  armR: 'torso',
  legL: 'hips',
  legR: 'hips',
  hat: 'head',
  weapon: 'armR',
});

/** Parts the rig will not try to place if charmodel did not emit them. */
const OPTIONAL = Object.freeze(['hat', 'weapon', 'extra']);

/** Colour slots that have already reported a bad value, so a bad caller warns once, not per frame. */
const _colorWarned = new Set();

/**
 * Write a palette hex into a colour uniform.
 *
 * `null` / `undefined` means "keep whatever colour is already there", which is what the
 * strength-only calls (`setFlash(null, 0)`) want.
 *
 * A value that cannot be a `P.*` hex is REJECTED rather than written, and that guard is the
 * whole point of this function. `THREE.Color.setHex()` floors its argument, so a 0..1 strength
 * arriving in the colour slot silently becomes 0x000000 — the surface turns pure black and
 * nothing anywhere reports a problem. That is exactly how the player shipped as a silhouette.
 * Refusing the write leaves the previous (valid) colour in place and says so once.
 *
 * @param {{value: THREE.Color}} uniform @param {number|null|undefined} color @param {string} who
 */
function writeColorHex(uniform, color, who) {
  if (color === undefined || color === null) return;
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) {
    if (!_colorWarned.has(who)) {
      _colorWarned.add(who);
      console.warn(`[rig] ${who}(color, v): ${color} is not a P.* hex colour and was ignored. ` +
        'Every rig effect setter takes the colour first and the 0..1 strength second.');
    }
    return;
  }
  uniform.value.setHex(color, THREE.SRGBColorSpace);
}

export class Rig {
  /**
   * @param {object} app the App (reads app.materials.actor, app.atlas, app.renderer)
   * @param {object} built output of buildCharacter() from src/gen/charmodel.js
   * @param {object} [opts] { material, castShadow, ownMaterial }
   */
  constructor(app, built, opts = {}) {
    this.app = app;
    this.built = built;
    this.id = built.id;
    this.height = built.height;
    this.hipY = built.hipY;
    this.shoulderY = built.shoulderY;
    this.headY = built.headY;

    this.material = Rig.resolveMaterial(app, opts);
    /** True when this rig owns its material and may drive flash/aura/dissolve/tint per actor. */
    this.ownsMaterial = this.material !== (app && app.materials && app.materials.actor)
      && !!(this.material && this.material.uniforms);

    this.root = new THREE.Group();
    this.root.name = 'rig:' + built.id;
    this.root.rotation.order = 'ZXY';

    this.hips = new THREE.Group();
    this.hips.name = 'hips';
    this.hips.rotation.order = 'ZXY';
    this.hips.position.set(0, built.hipY, 0);
    this.root.add(this.hips);

    /** @type {Record<string, THREE.Object3D>} node per part name, plus `hips`. */
    this.nodes = Object.create(null);
    this.nodes.hips = this.hips;
    /** @type {Record<string, THREE.Mesh>} */
    this.meshes = Object.create(null);

    this._buildParts(opts);
    this._bindHandOffsets();

    /** Scratch used by worldPointOf so it never allocates during a frame. */
    this._scratch = new THREE.Vector3();
    this.visible = true;
    this.baseX = 0; this.baseY = 0; this.baseZ = 0; this.baseYaw = 0;
  }

  /**
   * Pick the material this rig draws with.
   *
   * A per-actor material is created when the app can supply the atlas and shadow uniforms,
   * because flash / aura / dissolve / tint are *per actor* — writing them on the one shared
   * `app.materials.actor` would flash every character in the world at once. The clone is built
   * by calling the factory again rather than by `material.clone()`: three deep-copies uniform
   * objects on clone, which would sever the shared lighting uniforms that `updateShared()`
   * writes once per frame. Constructing it from the same module-level shader strings keeps
   * three's program cache key identical, so no shader is compiled during play (ARCHITECTURE §1.6).
   *
   * @param {object} app @param {object} opts
   * @returns {THREE.Material}
   */
  static resolveMaterial(app, opts = {}) {
    if (opts.material) return opts.material;
    const shared = app && app.materials ? app.materials.actor : null;
    if (opts.ownMaterial === false) {
      if (!shared) throw new Error('Rig: no actor material available');
      return shared;
    }
    const atlas = app ? app.atlas : null;
    const shadowU = app && app.renderer && app.renderer.shadow ? app.renderer.shadow.uniforms : null;
    if (atlas && shadowU) {
      return makeActorMaterial(atlas, shadowU, {
        name: 'actor:' + (opts.name || 'rig'),
        rimBoost: opts.rimBoost !== undefined ? opts.rimBoost : 1.55,
      });
    }
    if (shared) return shared;
    throw new Error('Rig: no actor material and no atlas to build one from');
  }

  /** Create one mesh per part, positioned from the spec's pivots. No hardcoded offsets. */
  _buildParts(opts) {
    const parts = this.built.parts;
    const castShadow = opts.castShadow !== false;

    // hips is a bare group; every real part hangs off it. Order matters only in that a parent
    // must exist before its children, which PARENT_OF's declaration order already guarantees.
    const order = ['torso', 'head', 'armL', 'armR', 'legL', 'legR', 'hat', 'weapon', 'extra'];
    for (const key of order) {
      const part = parts[key];
      if (!part) {
        if (!OPTIONAL.includes(key)) throw new Error(`Rig: character ${this.id} has no part "${key}"`);
        continue;
      }
      const parentName = key === 'extra' ? (part.attach === 'head' ? 'head' : 'torso') : PARENT_OF[key];
      const parent = this.nodes[parentName];
      if (!parent) throw new Error(`Rig: part "${key}" wants missing parent "${parentName}"`);
      const parentPivot = parentName === 'hips'
        ? [0, this.built.hipY, 0]
        : parts[parentName].pivot;

      const mesh = new THREE.Mesh(part.geometry, this.material);
      mesh.name = key;
      mesh.rotation.order = 'ZXY';
      mesh.position.set(
        part.pivot[0] - parentPivot[0],
        part.pivot[1] - parentPivot[1],
        part.pivot[2] - parentPivot[2],
      );
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;   // voxel characters self-shadow badly; AO already carries it
      // Per-part frustum culling is correct here because three transforms the geometry's
      // bounding sphere by the node's world matrix, and every part's geometry is authored
      // around its own pivot. The sphere is inflated once because setPose() translates joints
      // by up to a few decimetres, and a part that pops at the screen edge is worse than the
      // handful of triangles the tighter sphere would have saved.
      if (!part.geometry.boundingSphere) part.geometry.computeBoundingSphere();
      if (!part.geometry.userData.rigInflated) {
        part.geometry.boundingSphere.radius *= 1.35;
        part.geometry.userData.rigInflated = true;
      }
      mesh.userData.part = key;
      parent.add(mesh);
      this.nodes[key] = mesh;
      this.meshes[key] = mesh;
      /** Bind-pose position, so setPose() can add offsets without accumulating drift. */
      mesh.userData.bindPos = mesh.position.clone();
    }
  }

  /** Hand attachment points, expressed in each arm node's local space. */
  _bindHandOffsets() {
    const p = this.built.parts;
    const hl = this.built.handL, hr = this.built.handR;
    this._handLocalL = new THREE.Vector3(
      hl[0] - p.armL.pivot[0], hl[1] - p.armL.pivot[1], hl[2] - p.armL.pivot[2]);
    this._handLocalR = new THREE.Vector3(
      hr[0] - p.armR.pivot[0], hr[1] - p.armR.pivot[1], hr[2] - p.armR.pivot[2]);
    // Chest and head sample points, again derived from the spec rather than guessed.
    const g = this.built.metrics;
    this._chestLocal = new THREE.Vector3(0, (this.built.shoulderY - this.built.hipY) * 0.62, 0);
    this._headLocal = new THREE.Vector3(0, g.headHeight * 0.5, 0);
  }

  /** Add this rig to a parent object (normally app.rootActors). @param {THREE.Object3D} parent */
  addTo(parent) {
    parent.add(this.root);
    return this;
  }

  /** Show or hide the whole rig. @param {boolean} v */
  setVisible(v) {
    this.visible = !!v;
    this.root.visible = this.visible;
    return this;
  }

  /**
   * Place the rig in the world. The actor calls this every frame with its interpolated
   * transform; setPose() then layers the pose's own root offset and extra yaw on top, so the
   * actor never has to know that, say, attack_3 spins the body through 150 degrees.
   * @param {number} x @param {number} y @param {number} z @param {number} yaw radians
   */
  setTransform(x, y, z, yaw) {
    this.baseX = x; this.baseY = y; this.baseZ = z; this.baseYaw = yaw;
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;
    return this;
  }

  /**
   * Apply a pose (see src/entity/anim.js makePose) to the hierarchy.
   * Rotations are absolute; positional channels are offsets added to the bind position.
   * @param {object} pose
   */
  setPose(pose) {
    if (!pose) return this;
    const r = this.root;
    const yaw = this.baseYaw || 0;
    r.rotation.x = pose.rootRot[0];
    r.rotation.z = pose.rootRot[2];
    r.rotation.y = yaw + pose.rootRot[1];
    r.scale.set(pose.rootScale[0], pose.rootScale[1], pose.rootScale[2]);
    // The root offset is authored in model space (+Z is forward, matching charmodel's painted
    // face plane and the yaw convention in ARCHITECTURE §3), so it has to ride the facing.
    const rp = pose.rootPos;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    r.position.set(
      (this.baseX || 0) + rp[0] * c + rp[2] * s,
      (this.baseY || 0) + rp[1],
      (this.baseZ || 0) - rp[0] * s + rp[2] * c,
    );

    for (let i = 0; i < JOINTS.length; i++) {
      const name = JOINTS[i];
      const node = this.nodes[name];
      if (!node) continue;
      const j = pose.j[name];
      node.rotation.x = j.r[0];
      node.rotation.y = j.r[1];
      node.rotation.z = j.r[2];
      if (name === 'hips') {
        node.position.set(j.p[0], this.built.hipY + j.p[1], j.p[2]);
      } else {
        const b = node.userData.bindPos;
        node.position.set(b.x + j.p[0], b.y + j.p[1], b.z + j.p[2]);
      }
    }
    return this;
  }

  /**
   * World-space position of a named attachment point. FX, fruit powers and combat use this to
   * spawn effects at the hand that is actually swinging rather than at the actor's origin.
   * @param {'handL'|'handR'|'head'|'chest'|'feet'|'hips'} name
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3}
   */
  worldPointOf(name, out) {
    const o = out || this._scratch;
    this.root.updateWorldMatrix(true, true);
    switch (name) {
      case 'handL':
        return this.nodes.armL.localToWorld(o.copy(this._handLocalL));
      case 'handR':
        return this.nodes.armR.localToWorld(o.copy(this._handLocalR));
      case 'head':
        return this.nodes.head.localToWorld(o.copy(this._headLocal));
      case 'chest':
        return this.nodes.torso.localToWorld(o.copy(this._chestLocal));
      case 'hips':
        return this.hips.getWorldPosition(o);
      case 'feet':
      default:
        return this.root.getWorldPosition(o);
    }
  }

  /**
   * Capsule bounds for physics and hit tests, in metres.
   * Radius comes from the widest of torso and hips rather than from the head, because a chibi
   * head is 1.5-1.7x the torso and using it would give the character a barrel for a body.
   * @returns {{radius:number, height:number, centerY:number}}
   */
  bounds() {
    if (!this._bounds) {
      const m = this.built.metrics;
      const vox = this.built.voxelSize;
      const torsoW = this.built.spec.build.torsoW * vox;
      const legSpan = (this.built.parts.legL.pivot[0] - this.built.parts.legR.pivot[0]) + vox * 2;
      const radius = Math.max(torsoW, Math.abs(legSpan)) * 0.5;
      this._bounds = { radius, height: m.height, centerY: m.height * 0.5 };
    }
    return this._bounds;
  }

  // -- shader-driven actor effects -------------------------------------------
  // Each is a no-op when this rig shares the global actor material, because writing them there
  // would apply the effect to every character on screen. Actors that need effects get their own.
  //
  // EVERY setter here takes (colour, strength), in that order. That uniformity is not a style
  // preference: setFlash used to take (strength, colour) while its three siblings took
  // (colour, strength), and every caller in the game — fx.js's setFlash/setAura, fruitfx's aura
  // — writes colour first. The mismatch turned P.hitFlash (0xffffff) into a strength of 1 and
  // the strength 0.85 into a colour of 0x000000, so `mix(col, black, 1.0)` painted the player a
  // solid black silhouette for the whole session. Do not reintroduce an odd one out.

  /**
   * Hit flash.
   * @param {number|null} [color] hex from P.*; null/undefined keeps the current flash colour
   * @param {number} v 0..1
   */
  setFlash(color, v) {
    const u = this.ownsMaterial ? this.material.uniforms : null;
    if (!u) return this;
    writeColorHex(u.uFlashColor, color, 'setFlash');
    u.uFlash.value = clamp01(v);
    return this;
  }

  /** Fruit-power aura. @param {number} color hex from P.* @param {number} v 0..1 */
  setAura(color, v) {
    const u = this.ownsMaterial ? this.material.uniforms : null;
    if (!u) return this;
    writeColorHex(u.uAuraColor, color, 'setAura');
    u.uAura.value = Math.max(0, v);
    return this;
  }

  /** Voxel dissolve, used for deaths and logia intangibility. @param {number} v 0..1 */
  setDissolve(v) {
    const u = this.ownsMaterial ? this.material.uniforms : null;
    if (!u) return this;
    u.uDissolve.value = clamp01(v);
    return this;
  }

  /** Albedo tint (frozen, burning, poisoned). @param {number} color hex @param {number} v 0..1 */
  setTint(color, v) {
    const u = this.ownsMaterial ? this.material.uniforms : null;
    if (!u) return this;
    writeColorHex(u.uTintColor, color, 'setTint');
    u.uTint.value = clamp01(v);
    return this;
  }

  /** Clear every shader effect back to neutral. */
  clearEffects() {
    return this.setFlash(null, 0).setAura(null, 0).setDissolve(0).setTint(null, 0);
  }

  /** Detach from the scene and release GPU resources this rig owns. */
  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    // Geometry belongs to the built character (shared by every instance of the archetype) and
    // is NOT disposed here. The per-actor material is ours, so it is.
    if (this.ownsMaterial && this.material && this.material.dispose) this.material.dispose();
    this.nodes = Object.create(null);
    this.meshes = Object.create(null);
  }
}

/**
 * Build a rig for a character.
 * @param {object} app
 * @param {object} built output of buildCharacter()
 * @param {object} [opts]
 * @returns {Rig}
 */
export function createRig(app, built, opts) {
  return new Rig(app, built, opts);
}

export default Rig;
