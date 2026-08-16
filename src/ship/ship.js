// ShipSystem — the facade the rest of the game talks to. Owner: SHIP.
//
// It owns four things and delegates everything else:
//   * the voxel model and its scene graph (shipmodel.js)
//   * the rigid body and the rig (sailing.js)
//   * docking, boarding and travel (dock.js)
//   * the crew standing on the deck (crewaboard.js)
//
// Registered by src/game.js as `app.addSystem('ship', createShipSystem(app))`, and stepped in
// the fixed order from ARCHITECTURE §4. Everything it reads from other owners is feature
// detected, so it runs correctly today with only render + gen + quest present, and gains
// spray, sound, crew rigs and enemy boarders as those land, with no edit here.

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, angleDelta } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { buildShipModel, registerShipTiles, shipTier, SHIP_UPGRADE_VISUALS, deckHalfWidth, deckHeightAt, DECK_Z_RANGE } from './shipmodel.js';
import { SailingBody, applyHelmInput, playAt } from './sailing.js';
import { DockController, DOCK_STATE, BOARD_RANGE } from './dock.js';
import { CrewAboard } from './crewaboard.js';

/** Base hull integrity. `reinforced_hull` adds 60 on top of this. */
export const BASE_HULL_HP = 140;
/** Player mount states. */
export const MOUNT = Object.freeze({ ASHORE: 'ashore', ABOARD: 'aboard' });

/** Read an {x,y,z} out of either a Vector3-like or a [x,y,z] array. */
function readVec(v, out) {
  const o = out || {};
  if (!v) { o.x = 0; o.y = 0; o.z = 0; return o; }
  if (Array.isArray(v)) { o.x = v[0]; o.y = v[1]; o.z = v[2]; return o; }
  o.x = v.x || 0; o.y = v.y || 0; o.z = v.z || 0;
  return o;
}

/** Ship upgrade ids the quest layer has already granted, or [] when it is not present. */
function questUpgradeIds(app) {
  const q = app && (app.quests || app.quest);
  if (q && typeof q.shipUpgrades === 'function') {
    const u = q.shipUpgrades();
    if (u && Array.isArray(u.ids)) return u.ids;
  }
  return [];
}

/** Write an {x,y,z} into either a Vector3-like or a [x,y,z] array, in place. */
function writeVec(target, x, y, z) {
  if (!target) return;
  if (Array.isArray(target)) { target[0] = x; target[1] = y; target[2] = z; return; }
  target.x = x; target.y = y; target.z = z;
}

export class ShipSystem {
  /**
   * @param {object} app the App
   * @param {object} [opts] { upgrades, seed, start:[x,z], islands }
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.seed = (opts.seed !== undefined ? opts.seed : (app && app.seed)) >>> 0 || 1;
    this.rng = new Rng(this.seed).fork('ship');
    // Take the fitted upgrades from the quest layer at construction, not at the first step:
    // discovering them later forces a model rebuild, and a rebuild is ~240 ms of meshing that
    // would land as a visible hitch on the frame after load.
    this.upgrades = (opts.upgrades || questUpgradeIds(app)).slice();

    this.model = null;
    this.body = new SailingBody({ seed: this.seed });
    this.dock = new DockController({ seed: this.seed, islands: opts.islands || [] });
    this.crew = new CrewAboard({ seed: this.seed, animator: opts.animator || null });

    /** Hull integrity. Damage comes through takeDamage(); never write hp directly. */
    this.hull = { hp: BASE_HULL_HP, maxHp: BASE_HULL_HP };
    this.sinking = 0;

    /** Player mount state machine. */
    this.mount = MOUNT.ASHORE;
    this.mountLock = 0;

    /** Render interpolation snapshots. preRender may read these; step writes them. */
    this._prev = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this._cur = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

    this.root = null;
    this.meshes = null;
    this.crewRoot = null;
    this._crewNodes = new Map();
    this._creakAcc = 0;
    this._repairAcc = 0;
    this._tmp = { x: 0, y: 0, z: 0 };

    if (opts.start) {
      this.body.pos.x = opts.start[0];
      this.body.pos.z = opts.start[1];
      if (opts.start.length > 2) this.body.yaw = opts.start[2];
    }
    this._snap();

    if (app && app.tex && app.blocks) this.build(app);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  /**
   * Build (or rebuild) the model and its scene graph. Safe to call again after an upgrade.
   * Runs headless too: without `app.materials` it builds geometry and skips the meshes.
   */
  build(app) {
    const tex = app.tex, reg = app.blocks;
    if (!tex || !reg) return this;
    const crewColour = this._crewColour(app);
    const next = buildShipModel(tex, reg, { seed: this.seed, upgrades: this.upgrades, crewColour });
    this._disposeMeshes();
    if (this.model) this._disposeGeometry(this.model);
    this.model = next;
    this.body.setPoints(next.buoyancy);
    this.crew.stations = next.stations;
    this.crew.tex = tex;
    this.crew.reg = reg;
    this.crew.dirty = true;
    this.hull.maxHp = BASE_HULL_HP + this._upgradeEffect(app).hullMaxAdd;
    this.hull.hp = Math.min(this.hull.hp, this.hull.maxHp);
    if (app.materials && app.materials.ship) this._buildScene(app);
    return this;
  }

  _crewColour(app) {
    const q = app && (app.quests || app.quest);
    if (q && typeof q.activeBonuses === 'function') {
      const b = q.activeBonuses();
      if (b && b.pennant) return b.pennant;
    }
    return 0;
  }

  _upgradeEffect(app) {
    const q = app && (app.quests || app.quest);
    let e = {};
    if (q && typeof q.shipUpgrades === 'function') e = q.shipUpgrades().effect || {};
    return {
      hullMaxAdd: e.hullMaxAdd || 0,
      ramDamageMult: e.ramDamageMult || 1,
      stormSpeedMult: e.stormSpeedMult || 1,
      stormDriftMult: e.stormDriftMult || 1,
      broadsideCount: e.broadsideCount || 2,
      cannonDamageMult: e.cannonDamageMult || 1,
    };
  }

  /** Build the THREE scene graph. One group per animated part, each rotating about its pivot. */
  _buildScene(app) {
    const mat = app.materials.ship;
    const m = this.model;
    const root = new THREE.Group();
    root.name = 'ship';
    const mk = (geo, pivot) => {
      const g = new THREE.Group();
      if (pivot) g.position.set(pivot[0], pivot[1], pivot[2]);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      g.add(mesh);
      root.add(g);
      return g;
    };

    const hullMesh = new THREE.Mesh(m.hull.geometry, mat);
    hullMesh.frustumCulled = false;
    hullMesh.name = 'ship:hull';
    root.add(hullMesh);

    const sails = {
      full: mk(m.parts.sail.full.geometry, m.parts.sail.pivot),
      half: mk(m.parts.sail.half.geometry, m.parts.sail.pivot),
      furled: mk(m.parts.sail.furled.geometry, m.parts.sail.pivot),
    };
    const meshes = {
      hull: hullMesh,
      sails,
      wheel: mk(m.parts.wheel.geometry, m.parts.wheel.pivot),
      flag: mk(m.parts.flag.geometry, m.parts.flag.pivot),
      anchor: mk(m.parts.anchor.geometry, m.parts.anchor.pivot),
      rudder: mk(m.parts.rudder.geometry, m.parts.rudder.pivot),
      gangplank: mk(m.parts.gangplank.geometry, m.parts.gangplank.pivot),
    };
    if (m.parts.topsail) {
      meshes.topsails = {
        full: mk(m.parts.topsail.full.geometry, m.parts.topsail.pivot),
        half: mk(m.parts.topsail.half.geometry, m.parts.topsail.pivot),
        furled: mk(m.parts.topsail.furled.geometry, m.parts.topsail.pivot),
      };
    }

    this.crewRoot = new THREE.Group();
    this.crewRoot.name = 'ship:crew';
    root.add(this.crewRoot);

    this.root = root;
    this.meshes = meshes;
    (app.rootActors || app.scene).add(root);

    // A second hull, shared geometry, for the marine patrol. One extra draw call, no extra memory.
    const patrol = new THREE.Mesh(m.hull.geometry, mat);
    patrol.frustumCulled = false;
    patrol.visible = false;
    patrol.name = 'ship:patrol';
    (app.rootActors || app.scene).add(patrol);
    this.patrolMesh = patrol;
    return this;
  }

  // -------------------------------------------------------------------------
  // Upgrades, damage
  // -------------------------------------------------------------------------

  /**
   * Fit the upgrades the quest layer has awarded. Rebuilds the model when the set changes, so
   * the reward is visible on the ship within one step of being granted.
   * @param {string[]} ids from QuestSystem.shipUpgrades().ids
   */
  setUpgrades(ids) {
    const next = (ids || []).filter((i) => SHIP_UPGRADE_VISUALS[i]).sort();
    if (next.join(',') === this.upgrades.slice().sort().join(',')) return false;
    this.upgrades = next;
    if (this.app && this.app.tex) this.build(this.app);
    return true;
  }

  /** Visible upgrade tier, 0..3. */
  get tier() { return shipTier(this.upgrades); }

  /**
   * Damage the hull. The only way hp goes down.
   * @param {number} amount
   * @param {string} [cause] 'ram' | 'cannon' | 'ground' | 'storm'
   */
  takeDamage(amount, cause = 'hit') {
    if (amount <= 0) return this.hull.hp;
    this.hull.hp = Math.max(0, this.hull.hp - amount);
    const app = this.app;
    if (app && app.audio) playAt(app.audio, 'hull_creak', this.body.pos.x, this.body.pos.y, this.body.pos.z, { volume: 0.8 });
    if (app && app.ui && typeof app.ui.toast === 'function' && this.hull.hp < this.hull.maxHp * 0.3) {
      app.ui.toast('Hull is failing', 'danger');
    }
    this._lastDamageCause = cause;
    return this.hull.hp;
  }

  /** Repair the hull. Docking and the shipwright both come through here. */
  repair(amount) {
    this.hull.hp = Math.min(this.hull.maxHp, this.hull.hp + Math.max(0, amount));
    return this.hull.hp;
  }

  // -------------------------------------------------------------------------
  // Player mount / dismount
  // -------------------------------------------------------------------------

  /** World position of the head of the gangplank — where a player boards from. */
  boardingPoint(out) {
    const m = this.model;
    const pivot = m ? m.parts.gangplank.pivot : [2.75, 2.75, 0];
    const reach = 4.5 * this.dock.plank;
    return this.body.toWorld(pivot[0] + reach, pivot[1] - 1.1 * this.dock.plank, pivot[2], out);
  }

  /** Can the player standing at `worldPos` step aboard right now? */
  canBoard(worldPos) {
    if (this.mount === MOUNT.ABOARD) return false;
    if (this.dock.state !== DOCK_STATE.DOCKED || this.dock.plank < 0.9) return false;
    const bp = this.boardingPoint(this._tmp);
    return Math.hypot(bp.x - worldPos.x, bp.z - worldPos.z) < BOARD_RANGE;
  }

  /**
   * Put the player on deck. Always lands them on a validated deck point.
   * @returns {boolean} true if the state changed
   */
  boardPlayer(worldPos) {
    if (this.mount === MOUNT.ABOARD) return false;
    const p = this.dock.boardPlayer(this.body, worldPos);
    this.mount = MOUNT.ABOARD;
    this.mountLock = 0.4;
    this._writePlayer(p.x, p.y, p.z);
    const app = this.app;
    if (app && app.player) app.player.onShip = true;
    if (app && app.audio) playAt(app.audio, 'rope_creak', p.x, p.y, p.z, {});
    return true;
  }

  /**
   * Take the player ashore. Refuses unless docked with the plank out and a standable point
   * exists; a refusal leaves them exactly where they were.
   * @returns {boolean}
   */
  disembarkPlayer() {
    if (this.mount !== MOUNT.ABOARD) return false;
    const app = this.app;
    const sp = this.dock.disembarkPlayer(this.body, app && app.world);
    if (!sp) return false;
    this.mount = MOUNT.ASHORE;
    this.mountLock = 0.4;
    this._writePlayer(sp.x, sp.y + 0.05, sp.z);
    if (app && app.player) app.player.onShip = false;
    return true;
  }

  _writePlayer(x, y, z) {
    const app = this.app;
    if (app && app.player && app.player.pos) writeVec(app.player.pos, x, y, z);
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  /**
   * One fixed simulation step.
   * @param {number} dt exactly 1/60
   * @param {object} app
   */
  step(dt, app) {
    const water = app.water;
    const weather = (app.sky && app.sky.weather) || { wind: 4, waveScale: 0.55, storm: 0 };
    const quests = app.quests || app.quest || null;
    const input = app.input && app.input.state ? app.input.state : null;

    this._prev.x = this._cur.x; this._prev.y = this._cur.y; this._prev.z = this._cur.z;
    this._prev.yaw = this._cur.yaw; this._prev.pitch = this._cur.pitch; this._prev.roll = this._cur.roll;

    // --- quest-driven state: upgrades and crew bonuses -------------------------------------
    if (quests) {
      if (typeof quests.shipUpgrades === 'function') this.setUpgrades(quests.shipUpgrades().ids);
      if (typeof quests.crew === 'function') {
        this.crew.sync(quests.crew());
        if (typeof quests.activeBonuses === 'function') {
          this.crew.applyBonuses(quests.activeBonuses(), this.hull, dt);
        }
      }
    }
    this.body.setModifiers(this.crew.bonus, this._upgradeEffect(app));

    // --- controls -------------------------------------------------------------------------
    if (this.mountLock > 0) this.mountLock -= dt;
    const aboard = this.mount === MOUNT.ABOARD;
    if (aboard && input && this.dock.state !== DOCK_STATE.VOYAGE) {
      applyHelmInput(this.body, input, dt);
      if (input.pressed && input.pressed.interact && this.mountLock <= 0) this._interact(app);
      // The anchor key is the harbour key: cast off from a berth, or dock from an approach.
      // (castOff existed but nothing called it — before this, no input path could leave the
      // berth at all; only menu fast-travel undocked.) applyHelmInput's plain anchor toggle
      // fires on the same press; both transitions re-assert the anchor they need, so the
      // double action is self-correcting — see beginDock/UNDOCKING in dock.js.
      if (input.pressed && input.pressed.anchor && this.mountLock <= 0) {
        if (this.dock.state === DOCK_STATE.DOCKED) { if (this.castOff()) this.mountLock = 0.5; }
        else if (this.dock.state === DOCK_STATE.APPROACH) { if (this.tryDock()) this.mountLock = 0.5; }
      }
    }
    // Ashore, interact boards when the player stands at the gangplank. The player's own
    // interact cone offers the same action when the plank is in view; this branch catches a
    // player standing on the plank facing any direction, so KeyE always works at the berth.
    // pendingInteract is checked so a press already spent on an NPC does not also board.
    if (!aboard && input && this.mountLock <= 0 && input.pressed && input.pressed.interact
      && this.dock.state === DOCK_STATE.DOCKED) {
      const p = app.player;
      if (p && p.pos && !p.pendingInteract && this.canBoard(p.pos)) this.boardPlayer(p.pos);
    }

    // --- physics --------------------------------------------------------------------------
    const ctx = {
      water,
      weather,
      fx: app.fx || null,
      audio: app.audio || null,
      world: app.world || null,
      ui: app.ui || null,
      quests,
      enemies: app.enemies || null,
      input,
    };
    this.body.step(dt, ctx);
    this.dock.step(dt, this.body, ctx);

    // --- crew -----------------------------------------------------------------------------
    const fighting = !!(app.combat && app.combat.active) || this.dock.boarded;
    this.crew.step(dt, {
      body: this.body,
      weather,
      combat: fighting,
      threat: app.combat && typeof app.combat.nearestThreat === 'function' ? app.combat.nearestThreat() : null,
      docked: this.dock.state === DOCK_STATE.DOCKED,
    });
    if (fighting && !this.dock.boarded) this.dock.repelBoarders();

    // --- hull ------------------------------------------------------------------------------
    if (this.body.beached && this.body.speed > 1.4) {
      this.takeDamage(this.body.speed * 5.5 * dt, 'ground');
    }
    if (weather.storm > 0.7 && this.body.broaching > 0.75) {
      this.takeDamage(dt * 4.2 * weather.storm, 'storm');
    }
    if (this.dock.state === DOCK_STATE.DOCKED) {
      // In port, the ship gets patched up. Slowly, so it never replaces the shipwright.
      this._repairAcc += dt;
      if (this._repairAcc > 1) { this._repairAcc -= 1; this.repair(1.6); }
    }
    this.sinking = clamp01(1 - this.hull.hp / Math.max(1, this.hull.maxHp * 0.25));

    // --- player as a passenger --------------------------------------------------------------
    // Re-check the LIVE mount, not the `aboard` local captured before _interact ran: a
    // disembark mid-step would otherwise be overwritten here, teleporting the freshly-landed
    // player back to the deck coordinates — over open water, with no deck under them.
    if (this.mount === MOUNT.ABOARD) {
      const pos = app.player && app.player.pos ? readVec(app.player.pos, this._tmp) : null;
      if (pos) {
        this.dock.trackPlayer(this.body, pos);
        const w = this.dock.worldPlayerPos(this.body);
        this._writePlayer(w.x, w.y, w.z);
      }
    }

    // --- ambience ---------------------------------------------------------------------------
    this._creakAcc += dt;
    if (this._creakAcc > 3.4 && app.audio) {
      this._creakAcc = 0;
      const heavy = Math.abs(this.body.rollRate) > 0.14 || Math.abs(this.body.pitchRate) > 0.10;
      if (heavy || this.rng.chance(0.28)) {
        playAt(app.audio, heavy ? 'hull_creak' : 'rope_creak',
          this.body.pos.x, this.body.pos.y + 2, this.body.pos.z, { volume: 0.4 + this.body.luff * 0.3 });
      }
      if (this.body.luff > 0.45 && this.body.sailTrim > 0.2) {
        playAt(app.audio, 'sail_flap', this.body.pos.x, this.body.pos.y + 6, this.body.pos.z, { volume: 0.55 });
      }
    }

    this._snap();
    return this;
  }

  _interact(app) {
    const d = this.dock;
    if (d.state === DOCK_STATE.APPROACH) {
      if (d.beginDock(this.body, { audio: app.audio, quests: app.quests || app.quest })) this.mountLock = 0.5;
      return;
    }
    if (d.state === DOCK_STATE.DOCKED) {
      if (!this.disembarkPlayer() && app.ui && typeof app.ui.toast === 'function') {
        app.ui.toast('No safe footing ashore', 'warn');
      }
      return;
    }
    if (d.state === DOCK_STATE.DOCKING || d.state === DOCK_STATE.UNDOCKING) return;
    // At sea, interact casts off nothing and does nothing else — the helm is the interaction.
  }

  /**
   * Ask to dock at the island we are approaching. The public form of what pressing `interact`
   * does — the harness and the playtest drive this, and so does _interact().
   * @returns {boolean} true if docking started
   */
  tryDock() {
    return this.dock.beginDock(this.body, {
      audio: this.app && this.app.audio,
      quests: this.app && (this.app.quests || this.app.quest),
    });
  }

  /** Cast off from a berth. Bound to the anchor key while docked. */
  castOff() {
    if (this.dock.state !== DOCK_STATE.DOCKED) return false;
    if (this.mount !== MOUNT.ABOARD) return false;
    return this.dock.beginUndock(this.body);
  }

  /**
   * Moor the ship at an island's berth immediately, gangplank out. Setup only (new game,
   * loads): play-time docking goes through the DOCKING state machine, never through this.
   * @param {string} islandId
   * @returns {boolean}
   */
  berthAt(islandId) {
    const ok = this.dock.berthAtIsland(this.body, islandId);
    if (!ok) return false;
    this._snap();
    this._prev.x = this._cur.x; this._prev.y = this._cur.y; this._prev.z = this._cur.z;
    this._prev.yaw = this._cur.yaw; this._prev.pitch = this._cur.pitch; this._prev.roll = this._cur.roll;
    return true;
  }

  /**
   * Fast-travel to a discovered island. Runs a real scripted voyage — see dock.js.
   * @param {string} islandId
   */
  fastTravel(islandId) {
    if (this.dock.state === DOCK_STATE.DOCKED) this.dock.beginUndock(this.body);
    return this.dock.fastTravelTo(this.body, islandId);
  }

  _snap() {
    const b = this.body;
    this._cur.x = b.pos.x; this._cur.y = b.pos.y; this._cur.z = b.pos.z;
    this._cur.yaw = b.yaw; this._cur.pitch = b.pitch; this._cur.roll = b.roll;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /**
   * Interpolate the hull and drive every animated part. Render only — mutates no simulation
   * state, per ARCHITECTURE §4.
   * @param {number} alpha 0..1 between the last two fixed steps
   * @param {object} app
   */
  preRender(alpha, app) {
    if (!this.root) return;
    const a = this._prev, b = this._cur;
    const x = lerp(a.x, b.x, alpha), y = lerp(a.y, b.y, alpha), z = lerp(a.z, b.z, alpha);
    const yaw = a.yaw + angleDelta(a.yaw, b.yaw) * alpha;
    const pitch = lerp(a.pitch, b.pitch, alpha);
    const roll = lerp(a.roll, b.roll, alpha);
    this.root.position.set(x, y, z);
    // Yaw about world Y, then pitch about the hull's own X, then roll about its own Z.
    this.root.rotation.set(0, 0, 0);
    this.root.rotation.order = 'YXZ';
    this.root.rotation.y = yaw;
    this.root.rotation.x = pitch;
    this.root.rotation.z = roll;

    const t = app.clock ? app.clock.simTime + alpha / 60 : 0;
    const body = this.body;
    const M = this.meshes;

    // --- sail: pick the state, brace the yard, shiver when it luffs -------------------------
    this._setSail(M.sails, body, t, 1);
    if (M.topsails) this._setSail(M.topsails, body, t, 0.7);

    // --- wheel ------------------------------------------------------------------------------
    M.wheel.rotation.set(0, 0, 0);
    M.wheel.rotation.z = -body.wheelAngle;

    // --- flag: streams downwind, in ship space, with a travelling ripple --------------------
    const fwd = body.forward(), stb = body.lateral();
    const wx = Math.cos(body.windAngle), wz = Math.sin(body.windAngle);
    const localWind = Math.atan2(wx * stb.x + wz * stb.z, wx * fwd.x + wz * fwd.z);
    const gust = Math.sin(t * 3.1) * 0.10 + Math.sin(t * 1.7 + 1.3) * 0.06;
    M.flag.rotation.set(0, 0, 0);
    M.flag.rotation.y = localWind + gust * (0.5 + clamp01(body.windSpeed / 18));
    M.flag.rotation.z = Math.sin(t * 2.3) * 0.09;

    // --- anchor: drops on its cable, swings with the roll ------------------------------------
    const drop = body.anchorDeploy;
    M.anchor.position.y = this.model.parts.anchor.pivot[1] - drop * 5.2;
    M.anchor.rotation.set(0, 0, 0);
    M.anchor.rotation.z = Math.sin(t * 0.9) * 0.10 * (1 - drop) - body.roll * 0.5;

    // --- rudder --------------------------------------------------------------------------
    M.rudder.rotation.set(0, 0, 0);
    M.rudder.rotation.y = -body.helm * 0.60;

    // --- gangplank: swings down and out when docked ------------------------------------------
    const p = clamp01(this.dock.plank);
    M.gangplank.visible = p > 0.02;
    M.gangplank.rotation.set(0, 0, 0);
    M.gangplank.rotation.z = lerp(1.25, -0.28, smoothstep(0, 1, p));

    // --- crew ----------------------------------------------------------------------------
    this._syncCrewNodes(app);
    this._poseCrew();

    // --- patrol ship ----------------------------------------------------------------------
    if (this.patrolMesh) {
      const pt = this.dock.patrol;
      this.patrolMesh.visible = !!pt;
      if (pt) {
        this.patrolMesh.position.set(pt.x, pt.y || 0, pt.z);
        this.patrolMesh.rotation.set(0, pt.yaw, 0);
      }
    }
  }

  _setSail(group, body, t, scale) {
    const trim = body.sailTrim * scale;
    const which = trim < 0.16 ? 'furled' : trim < 0.62 ? 'half' : 'full';
    for (const k of ['full', 'half', 'furled']) {
      const g = group[k];
      if (!g) continue;
      g.visible = k === which;
      if (!g.visible) continue;
      g.rotation.set(0, 0, 0);
      g.rotation.y = body.yardAngle;
      // Luffing: the cloth shakes about the yard. A filled sail is dead still, and the contrast
      // between the two is the readable signal that you are pointing too close to the wind.
      const shake = body.luff * (Math.sin(t * 11.3) * 0.10 + Math.sin(t * 6.7) * 0.06);
      g.rotation.x = shake;
      g.rotation.z = shake * 0.4 - body.roll * 0.10;
    }
  }

  /** Create or drop crew scene nodes when the roster changes. */
  _syncCrewNodes(app) {
    if (!this.crewRoot || !this.crew.dirty) return;
    this.crew.dirty = false;
    const mat = app.materials && app.materials.actor;
    if (!mat) return;
    for (const [id, node] of this._crewNodes) {
      if (!this.crew.members.find((m) => m.id === id)) {
        this.crewRoot.remove(node.root);
        this._crewNodes.delete(id);
      }
    }
    for (const m of this.crew.members) {
      if (this._crewNodes.has(m.id) || !m.model) continue;
      const root = new THREE.Group();
      root.name = 'crew:' + m.id;
      const groups = {};
      const parts = m.model.parts;
      const put = (key, parent, base) => {
        const pl = parts[key];
        if (!pl) return null;
        const g = new THREE.Group();
        g.position.set(pl.pivot[0] - (base ? base[0] : 0), pl.pivot[1] - (base ? base[1] : 0), pl.pivot[2] - (base ? base[2] : 0));
        const mesh = new THREE.Mesh(pl.geometry, mat);
        mesh.frustumCulled = false;
        g.add(mesh);
        parent.add(g);
        groups[key] = g;
        return g;
      };
      put('torso', root);
      const head = put('head', root);
      if (head && parts.hat) {
        const hat = new THREE.Mesh(parts.hat.geometry, mat);
        hat.frustumCulled = false;
        head.add(hat);
      }
      put('armL', root);
      const armR = put('armR', root);
      if (armR && parts.weapon) {
        const w = new THREE.Mesh(parts.weapon.geometry, mat);
        w.frustumCulled = false;
        w.position.set(
          parts.weapon.pivot[0] - parts.armR.pivot[0],
          parts.weapon.pivot[1] - parts.armR.pivot[1],
          parts.weapon.pivot[2] - parts.armR.pivot[2],
        );
        armR.add(w);
      }
      put('legL', root);
      put('legR', root);
      if (parts.extra) put('extra', root);
      this.crewRoot.add(root);
      this._crewNodes.set(m.id, { root, groups });
    }
  }

  /** Apply each crew member's pose. Reads the animator's output; writes only to the scene. */
  _poseCrew() {
    for (const m of this.crew.members) {
      const node = this._crewNodes.get(m.id);
      if (!node) continue;
      const pose = (m.anim && (m.anim.pose || (typeof m.anim.getPose === 'function' && m.anim.getPose()))) || null;
      const root = node.root;
      const r = pose && pose.root ? pose.root : null;
      root.position.set(m.pos.x, m.pos.y + (r ? r.y : 0), m.pos.z);
      root.rotation.order = 'YXZ';
      root.rotation.set(r ? r.pitch : 0, m.yaw + (r ? r.yaw : 0), r ? r.roll : 0);
      if (!pose) continue;
      for (const key of Object.keys(node.groups)) {
        const t = pose[key];
        if (!t) continue;
        const g = node.groups[key];
        g.rotation.set(t.rx || 0, t.ry || 0, t.rz || 0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Harness / HUD surface (ARCHITECTURE §9)
  // -------------------------------------------------------------------------

  get pos() { return this.body.pos; }
  get yaw() { return this.body.yaw; }
  get docked() { return this.dock.state === DOCK_STATE.DOCKED; }
  get speedKnots() { return this.body.speedKnots; }
  get pointOfSail() { return this.body.pointOfSail; }
  get heelAngle() { return this.body.heelAngle; }
  get prompt() { return this.dock.prompt; }

  /** Everything the HUD draws about the ship, in one read. */
  hud() {
    const r = this.body.readout();
    r.hull = this.hull.hp;
    r.hullMax = this.hull.maxHp;
    r.tier = this.tier;
    r.upgrades = this.upgrades.slice();
    r.dockState = this.dock.state;
    r.prompt = this.dock.prompt;
    r.island = this.dock.nearIsland ? this.dock.nearIsland.name : null;
    r.crew = this.crew.view();
    r.patrol = this.dock.patrol ? { dist: this.dock.patrol.dist, boarded: this.dock.boarded } : null;
    r.aboard = this.mount === MOUNT.ABOARD;
    return r;
  }

  serialize() {
    return {
      body: this.body.serialize(),
      dock: this.dock.serialize(),
      crew: this.crew.serialize(),
      hull: this.hull.hp,
      upgrades: this.upgrades.slice(),
      mount: this.mount,
    };
  }

  deserialize(o) {
    if (!o) return this;
    this.body.deserialize(o.body);
    this.dock.deserialize(o.dock);
    if (Array.isArray(o.upgrades)) this.setUpgrades(o.upgrades);
    this.crew.deserialize(o.crew);
    if (typeof o.hull === 'number') this.hull.hp = clamp(o.hull, 0, this.hull.maxHp);
    this.mount = o.mount === MOUNT.ABOARD ? MOUNT.ABOARD : MOUNT.ASHORE;
    this._snap();
    this._prev.x = this._cur.x; this._prev.y = this._cur.y; this._prev.z = this._cur.z;
    this._prev.yaw = this._cur.yaw; this._prev.pitch = this._cur.pitch; this._prev.roll = this._cur.roll;
    return this;
  }

  _disposeMeshes() {
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    if (this.patrolMesh && this.patrolMesh.parent) this.patrolMesh.parent.remove(this.patrolMesh);
    this.root = null;
    this.meshes = null;
    this.crewRoot = null;
    this._crewNodes.clear();
    this.patrolMesh = null;
  }

  _disposeGeometry(model) {
    if (!model) return;
    if (model.hull && model.hull.geometry) model.hull.geometry.dispose();
    const walk = (o) => {
      if (!o) return;
      if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose();
      for (const k of ['full', 'half', 'furled']) if (o[k]) walk(o[k]);
    };
    for (const k of Object.keys(model.parts)) walk(model.parts[k]);
  }

  dispose() {
    this._disposeMeshes();
    this._disposeGeometry(this.model);
    this.crew.dispose();
    this.model = null;
  }
}

/**
 * Factory registered by src/game.js.
 * @param {object} app
 * @param {object} [opts] { upgrades, seed, start:[x,z,yaw], islands, animator }
 * @returns {ShipSystem}
 */
export function createShipSystem(app, opts = {}) {
  return new ShipSystem(app, opts);
}

export { registerShipTiles, DOCK_STATE, deckHalfWidth, deckHeightAt, DECK_Z_RANGE };
export default ShipSystem;
