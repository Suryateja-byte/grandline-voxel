// Docking, boarding, disembarking, fast travel and being boarded. Owner: SHIP.
//
// Two hard rules drive every line of this file:
//
//  1. The deck is a MOVING PLATFORM. While the player is aboard, their authoritative position
//     is stored in ship-local metres and converted to world space after the hull has moved.
//     Storing a world position and nudging it by the ship's delta accumulates error and the
//     player slowly slides off the stern; storing it in ship space cannot drift, by construction.
//
//  2. Getting on and off never puts anybody in the water or inside terrain. Every transition
//     goes through a validator (`deckPoint` / `shorePoint`) that either returns a point known
//     to be standable or refuses the transition. A refused transition is a prompt that stays on
//     screen. An unvalidated one is a player swimming for the horizon.

import { clamp, clamp01, lerp, smoothstep, angleDelta, TAU } from '../core/math.js';
import { Rng } from '../core/rng.js';
import { deckHalfWidth, deckHeightAt, DECK_Z_RANGE } from './shipmodel.js';
import { playAt } from './sailing.js';

/**
 * Distance from the island's dock point at which the docking prompt appears. Generous on
 * purpose: the prompt is the game telling you where the harbour is, and a tight radius means
 * coasting the last thirty metres under bare poles hoping something lights up.
 */
export const DOCK_PROMPT_RANGE = 44;
/** Distance from the ship at which a player ashore may board. */
export const BOARD_RANGE = 5.5;
/** How far off the dock point the ship berths — half-beam plus a fender's worth of water. */
const BERTH_DIST = 6.0;
/** Seconds for the gangplank to run out or stow. */
const PLANK_TIME = 1.4;
/** Seconds between marine-patrol rolls while at sea. */
const PATROL_ROLL_S = 22;
/** Range at which a patrol grapples and the boarding fight starts. */
const GRAPPLE_RANGE = 13;

export const DOCK_STATE = Object.freeze({
  SAILING: 'sailing',
  APPROACH: 'approach',
  DOCKING: 'docking',
  DOCKED: 'docked',
  UNDOCKING: 'undocking',
  VOYAGE: 'voyage',
});

/**
 * Normalise whatever the world gives us into one island shape.
 * Accepts the LANDMARKS record shape (`worldPos` + local `dockPos`) and the flat harness shape
 * (`x/z/dockX/dockZ`) so this works before and after the world owner lands their API.
 * @param {object[]} list
 */
export function normaliseIslands(list) {
  const out = [];
  for (const it of list || []) {
    if (!it) continue;
    const wx = it.worldPos ? it.worldPos[0] : (it.x !== undefined ? it.x : 0);
    const wz = it.worldPos ? it.worldPos[1] : (it.z !== undefined ? it.z : 0);
    let dx = it.dockX, dz = it.dockZ;
    if (dx === undefined && it.dockPos) { dx = wx + it.dockPos[0]; dz = wz + it.dockPos[1]; }
    if (dx === undefined) { dx = wx; dz = wz + (it.radius || 60); }
    out.push({
      id: it.id,
      name: it.name || it.id,
      x: wx, z: wz,
      dockX: dx, dockZ: dz,
      radius: it.radius || 60,
      tier: it.difficultyTier || 1,
    });
  }
  return out;
}

/**
 * Berth pose alongside an island's pier: the ship lies broadside on, starboard side to the
 * dock, so the gangplank (which lives on the starboard rail) runs straight onto the planks.
 * @param {object} isl a normalised island
 * @returns {{x:number, z:number, yaw:number, ox:number, oz:number}} `o*` is the seaward unit vector
 */
export function berthPose(isl) {
  let ox = isl.dockX - isl.x, oz = isl.dockZ - isl.z;
  const len = Math.hypot(ox, oz) || 1;
  ox /= len; oz /= len;
  // starboard = (cos yaw, -sin yaw) must equal -outward, so the pier is off the starboard beam.
  const yaw = Math.atan2(oz, -ox);
  return { x: isl.dockX + ox * BERTH_DIST, z: isl.dockZ + oz * BERTH_DIST, yaw, ox, oz };
}

/**
 * Docking, boarding and travel state machine. Owned and stepped by ShipSystem; kept separate
 * because none of it is physics and mixing the two makes both untestable.
 */
export class DockController {
  /** @param {{seed?:number, islands?:object[]}} [opts] */
  constructor(opts = {}) {
    this.state = DOCK_STATE.SAILING;
    this.islands = normaliseIslands(opts.islands || []);
    this.discovered = new Set();
    this.rng = new Rng(((opts.seed >>> 0) || 1) ^ 0x444f434b).fork('dock');

    /** The island whose dock we are near or berthed at. */
    this.nearIsland = null;
    this.nearDist = Infinity;
    /** 0..1 gangplank extension. */
    this.plank = 0;
    /** Prompt the UI should show, or null. Never a placeholder — if it is set, it works. */
    this.prompt = null;

    /** Player aboard? While true, `playerLocal` is authoritative and world pos is derived. */
    this.aboard = false;
    this.playerLocal = { x: 0, y: 0, z: 0 };
    /** Where the player was standing ashore, so undocking cannot lose them. */
    this.lastShore = null;

    /** Scripted voyage state. */
    this.voyage = null;
    /** Marine patrol closing on us, or null. */
    this.patrol = null;
    /** Deck positions the boarders were placed on, or null. Read by the enemy owner and the HUD. */
    this.boarders = null;
    this.boarded = false;
    this._patrolAcc = 0;
    this._transition = 0;
  }

  /** Replace the island table (the world owner calls this once its islands exist). */
  setIslands(list) { this.islands = normaliseIslands(list); return this; }

  /**
   * Moor instantly at an island's berth: DOCKED state, plank out, anchor down. Setup only —
   * the new-game start berth and save restoration; play-time docking runs the state machine.
   * @param {object} body SailingBody
   * @param {string} islandId
   * @returns {boolean} false when the island is unknown
   */
  berthAtIsland(body, islandId) {
    const isl = this.islands.find((i) => i.id === islandId) || null;
    if (!isl) return false;
    const b = berthPose(isl);
    body.pos.x = b.x; body.pos.z = b.z; body.yaw = b.yaw;
    body.vel.x = 0; body.vel.z = 0; body.yawRate = 0;
    body.sailTarget = 0;
    if (!body.anchorDown && typeof body.toggleAnchor === 'function') body.toggleAnchor();
    body.anchorPos.x = isl.dockX; body.anchorPos.z = isl.dockZ;
    this.state = DOCK_STATE.DOCKED;
    this.nearIsland = isl;
    this.nearDist = Math.hypot(isl.dockX - body.pos.x, isl.dockZ - body.pos.z);
    this.plank = 1;
    this.voyage = null;
    this.discover(isl.id);
    return true;
  }

  /** Mark an island discovered; only discovered islands are fast-travel destinations. */
  discover(id) { if (id) this.discovered.add(id); return this; }

  /** Islands the map may offer as fast-travel destinations. */
  destinations() {
    return this.islands.filter((i) => this.discovered.has(i.id));
  }

  /** Nearest island dock to a world position. @returns {{isl:object, dist:number}|null} */
  nearestDock(x, z) {
    let best = null, bd = Infinity;
    for (const i of this.islands) {
      const d = Math.hypot(i.dockX - x, i.dockZ - z);
      if (d < bd) { bd = d; best = i; }
    }
    return best ? { isl: best, dist: bd } : null;
  }

  // -------------------------------------------------------------------------
  // Safe points
  // -------------------------------------------------------------------------

  /**
   * A point on the deck that is guaranteed inside the bulwarks and on a walkable surface.
   * @param {number} lx ship-local x (metres)
   * @param {number} lz ship-local z (metres)
   * @returns {{x:number,y:number,z:number}}
   */
  deckPoint(lx, lz) {
    const z = clamp(lz, DECK_Z_RANGE.aft, DECK_Z_RANGE.fore);
    const half = Math.max(0.3, deckHalfWidth(z) - 0.35);
    return { x: clamp(lx, -half, half), y: deckHeightAt(z), z };
  }

  /**
   * A standable point ashore at the head of the gangplank. Walks inland from the dock point
   * until the terrain is properly above water, and returns null if it never is — in which case
   * the disembark is refused rather than dropping the player in the sea.
   *
   * @param {object} isl normalised island
   * @param {object} world anything with heightAt(x, z); optional
   * @returns {{x:number,y:number,z:number}|null}
   */
  shorePoint(isl, world) {
    const b = berthPose(isl);
    const h = (x, z) => (world && typeof world.heightAt === 'function' ? world.heightAt(x, z) : 1.6);
    // Step from the dock point toward the island centre. The pier itself is the first candidate.
    for (let step = 0; step <= 14; step++) {
      const t = step * 1.1;
      const x = isl.dockX - b.ox * t;
      const z = isl.dockZ - b.oz * t;
      const y = h(x, z);
      if (Number.isFinite(y) && y > 0.35) return { x, y, z };
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Player handoff
  // -------------------------------------------------------------------------

  /**
   * Put the player on deck. Always succeeds with a validated point — this is the call that
   * must never fail, because the alternative is a player in the water with no way back.
   * @param {object} body SailingBody
   * @param {{x:number,y:number,z:number}} [fromWorld] where they were standing
   */
  boardPlayer(body, fromWorld) {
    let lx = deckHalfWidth(0) - 0.9, lz = 0;
    if (fromWorld) {
      const l = body.toLocal(fromWorld.x, fromWorld.y, fromWorld.z);
      lx = l.x; lz = l.z;
      this.lastShore = { x: fromWorld.x, y: fromWorld.y, z: fromWorld.z };
    }
    const p = this.deckPoint(lx, lz);
    this.playerLocal.x = p.x; this.playerLocal.y = p.y; this.playerLocal.z = p.z;
    this.aboard = true;
    return this.worldPlayerPos(body);
  }

  /**
   * Take the player ashore. Refuses (returns null) unless the ship is docked, the gangplank is
   * out, and a standable point exists.
   * @returns {{x:number,y:number,z:number}|null}
   */
  disembarkPlayer(body, world) {
    if (this.state !== DOCK_STATE.DOCKED || this.plank < 0.98 || !this.nearIsland) return null;
    const sp = this.shorePoint(this.nearIsland, world);
    if (!sp) return null;
    this.aboard = false;
    this.lastShore = sp;
    return sp;
  }

  /** Ship-local -> world for whoever is aboard. Called after the hull has moved this step. */
  worldPlayerPos(body, out) {
    return body.toWorld(this.playerLocal.x, this.playerLocal.y, this.playerLocal.z, out);
  }

  /**
   * Record where the player walked to this step, in ship space. The player controller moves
   * them in world space; this folds that back into the local frame and re-validates it, so
   * walking into the rail stops you instead of dropping you over the side.
   */
  trackPlayer(body, worldPos) {
    if (!this.aboard || !worldPos) return;
    const l = body.toLocal(worldPos.x, worldPos.y, worldPos.z);
    const p = this.deckPoint(l.x, l.z);
    this.playerLocal.x = p.x;
    this.playerLocal.z = p.z;
    // Vertical is free within a metre of the deck so jumping still works, but never below it.
    this.playerLocal.y = clamp(l.y, p.y, p.y + 3.2);
  }

  // -------------------------------------------------------------------------
  // Docking
  // -------------------------------------------------------------------------

  /**
   * True when the ship may dock right now.
   *
   * Deliberately does NOT require the hull to be afloat: nudging the shallows next to a pier is
   * exactly the moment a player wants "press to dock" to work, and the DOCKING warp lifts the
   * ship back into its berth. Requiring open water there strands people on the beach they were
   * trying to land on.
   */
  canDock(body) {
    return this.state === DOCK_STATE.APPROACH && !!this.nearIsland && body.speed < 3.2;
  }

  /** Begin docking. Anchors, warps gently to the berth and runs the gangplank out. */
  beginDock(body, ctx) {
    if (!this.canDock(body)) return false;
    this.state = DOCK_STATE.DOCKING;
    this._transition = 0;
    body.sailTarget = 0;
    if (!body.anchorDown) body.toggleAnchor();
    body.anchorPos.x = this.nearIsland.dockX;
    body.anchorPos.z = this.nearIsland.dockZ;
    this.discover(this.nearIsland.id);
    if (ctx && ctx.audio) playAt(ctx.audio, 'anchor_drop', body.pos.x, body.pos.y, body.pos.z, {});
    if (ctx && ctx.quests && typeof ctx.quests.notify === 'function') {
      ctx.quests.notify('islandDocked', { islandId: this.nearIsland.id });
    }
    return true;
  }

  /** Cast off. Stows the plank, weighs anchor and hands control back to the rig. */
  beginUndock(body) {
    if (this.state !== DOCK_STATE.DOCKED) return false;
    this.state = DOCK_STATE.UNDOCKING;
    this._transition = 0;
    return true;
  }

  // -------------------------------------------------------------------------
  // Fast travel
  // -------------------------------------------------------------------------

  /**
   * Sail to a discovered island. This is a real voyage, not a fade: the hull is driven along a
   * smooth course while buoyancy, wake and spray keep running, so the montage is the same ship
   * on the same sea, just at a different pace.
   *
   * @param {object} body SailingBody
   * @param {string} islandId must be discovered
   * @returns {boolean} false if the destination is unknown or we are not free to leave
   */
  fastTravelTo(body, islandId) {
    if (this.state === DOCK_STATE.VOYAGE) return false;
    const isl = this.islands.find((i) => i.id === islandId);
    if (!isl || !this.discovered.has(islandId)) return false;
    const b = berthPose(isl);
    const sx = body.pos.x, sz = body.pos.z;
    const dist = Math.hypot(b.x - sx, b.z - sz);
    // Course: out on the current heading, a long middle leg, then in on the berth's approach.
    const fwd = body.forward();
    const out = Math.min(140, Math.max(45, dist * 0.18));
    const p0 = { x: sx, z: sz };
    const p1 = { x: sx + fwd.x * out, z: sz + fwd.z * out };
    const p3 = { x: b.x + b.ox * 26, z: b.z + b.oz * 26 };
    const p2 = { x: p3.x + b.ox * Math.min(180, dist * 0.22), z: p3.z + b.oz * Math.min(180, dist * 0.22) };
    // Duration: long enough to read as a voyage, short enough that nobody puts the pad down.
    const seconds = clamp(7 + dist / 900, 7, 22);
    this.voyage = { isl, p0, p1, p2, p3, t: 0, seconds, prevX: sx, prevZ: sz };
    this.state = DOCK_STATE.VOYAGE;
    this.plank = 0;
    body.scripted = true;
    body.sailTarget = 1;
    if (body.anchorDown) body.toggleAnchor();
    return true;
  }

  /** Cubic Bezier point on the voyage course. */
  _coursePoint(v, t) {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return {
      x: a * v.p0.x + b * v.p1.x + c * v.p2.x + d * v.p3.x,
      z: a * v.p0.z + b * v.p1.z + c * v.p2.z + d * v.p3.z,
    };
  }

  /** Drive one step of the scripted voyage. Returns true while it is still running. */
  _stepVoyage(dt, body, ctx) {
    const v = this.voyage;
    if (!v) return false;
    v.t = clamp01(v.t + dt / v.seconds);
    // Ease in and out so the ship gathers way and then rounds up, instead of teleporting at
    // constant speed like a camera rail.
    const s = smoothstep(0, 1, v.t);
    const p = this._coursePoint(v, s);
    const vx = (p.x - v.prevX) / dt;
    const vz = (p.z - v.prevZ) / dt;
    v.prevX = p.x; v.prevZ = p.z;
    body.pos.x = p.x; body.pos.z = p.z;
    body.vel.x = vx; body.vel.z = vz;
    const sp = Math.hypot(vx, vz);
    if (sp > 0.05) {
      const want = Math.atan2(vx, vz);
      body.yaw += angleDelta(body.yaw, want) * clamp01(dt * 3.4);
      body.yawRate = angleDelta(body.yaw, want) * 2;
    }
    if (v.t >= 1) {
      body.scripted = false;
      body.vel.x *= 0.25; body.vel.z *= 0.25;
      this.voyage = null;
      this.state = DOCK_STATE.SAILING;
      this.nearIsland = v.isl;
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') {
        ctx.ui.toast('Made landfall at ' + v.isl.name, 'info');
      }
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Marine patrols
  // -------------------------------------------------------------------------

  /**
   * Roll for a marine patrol. High bounty means the Navy comes looking; when they close, they
   * grapple and the fight happens ON YOUR DECK, which is the point of the whole mechanic.
   */
  _stepPatrol(dt, body, ctx) {
    const bounty = ctx.quests && typeof ctx.quests.bountyState === 'function'
      ? ctx.quests.bountyState() : null;
    const chance = bounty ? (bounty.marinePatrolChance || 0) : 0;

    if (this.patrol) {
      const pt = this.patrol;
      // Close on the ship's future position — a patrol that steers at where you were never
      // catches anybody and reads as broken.
      const lead = 2.4;
      const tx = body.pos.x + body.vel.x * lead;
      const tz = body.pos.z + body.vel.z * lead;
      const dx = tx - pt.x, dz = tz - pt.z;
      const d = Math.hypot(dx, dz) || 1;
      const want = Math.atan2(dx, dz);
      pt.yaw += angleDelta(pt.yaw, want) * clamp01(dt * 1.1);
      // Slightly faster than the player's best speed, or they can simply outrun the story.
      const speed = Math.min(pt.speed, 2.2 + body.speed * 1.05);
      pt.x += Math.sin(pt.yaw) * speed * dt;
      pt.z += Math.cos(pt.yaw) * speed * dt;
      if (ctx.water) pt.y = ctx.water.heightAt(pt.x, pt.z);
      pt.dist = d;
      pt.timer += dt;
      if (d < GRAPPLE_RANGE && !this.boarded) this._triggerBoarding(body, ctx);
      if (pt.timer > 190 || d > 420) this.patrol = null;   // they give up eventually
      return;
    }
    if (this.state !== DOCK_STATE.SAILING || chance <= 0) return;
    this._patrolAcc += dt;
    if (this._patrolAcc < PATROL_ROLL_S) return;
    this._patrolAcc = 0;
    if (!this.rng.chance(clamp01(chance))) return;
    // Spawn upwind and astern: they come out of the weather, which is both fair and dramatic.
    const a = this.rng.range(0, TAU);
    const r = 260 + this.rng.range(0, 90);
    this.patrol = {
      x: body.pos.x + Math.cos(a) * r,
      z: body.pos.z + Math.sin(a) * r,
      y: 0, yaw: a + Math.PI, speed: 6.2, timer: 0, dist: r,
      tier: bounty ? bounty.tierIndex : 1,
    };
    if (ctx.ui && typeof ctx.ui.toast === 'function') ctx.ui.toast('Marine patrol on the horizon', 'warn');
    if (ctx.audio) playAt(ctx.audio, 'wave_crash', body.pos.x, body.pos.y, body.pos.z, { volume: 0.3 });
  }

  /** Grapple: marines board, and the fight is on deck. */
  _triggerBoarding(body, ctx) {
    this.boarded = true;
    const count = clamp(2 + Math.round((this.patrol.tier || 1) * 0.9), 2, 6);
    const spawned = [];
    for (let i = 0; i < count; i++) {
      // Place every marine on a validated deck point — a boarder inside the hull is a bug the
      // player reads as the game being broken, not as the Navy being sneaky.
      const lz = lerp(DECK_Z_RANGE.aft + 1.5, DECK_Z_RANGE.fore - 1.5, (i + 0.5) / count);
      const lx = (i % 2 === 0 ? 1 : -1) * (deckHalfWidth(lz) - 0.8);
      const p = this.deckPoint(lx, lz);
      const w = body.toWorld(p.x, p.y, p.z);
      spawned.push({ kind: i === 0 ? 'marine_officer' : 'marine_recruit', x: w.x, y: w.y, z: w.z });
    }
    if (ctx.enemies && typeof ctx.enemies.spawnWave === 'function') {
      ctx.enemies.spawnWave({
        kind: 'marine_officer', count, around: [body.pos.x, body.pos.z], radius: 6, onDeck: true, points: spawned,
      });
    }
    if (ctx.ui && typeof ctx.ui.toast === 'function') ctx.ui.toast('Marines are boarding!', 'danger');
    if (ctx.audio) playAt(ctx.audio, 'hull_creak', body.pos.x, body.pos.y, body.pos.z, { volume: 0.9 });
    this.boarders = spawned;
  }

  /** Combat over: the patrol sheers off. Called by ShipSystem when combat goes quiet. */
  repelBoarders() {
    this.boarded = false;
    this.boarders = null;
    this.patrol = null;
  }

  // -------------------------------------------------------------------------
  // Step
  // -------------------------------------------------------------------------

  /**
   * @param {number} dt fixed step
   * @param {object} body SailingBody
   * @param {object} ctx { world, water, ui, audio, quests, enemies, input }
   */
  step(dt, body, ctx = {}) {
    if (this.state === DOCK_STATE.VOYAGE) {
      this._stepVoyage(dt, body, ctx);
      this.prompt = 'Sailing to ' + (this.voyage ? this.voyage.isl.name : 'port');
      return;
    }

    const near = this.nearestDock(body.pos.x, body.pos.z);
    this.nearDist = near ? near.dist : Infinity;

    switch (this.state) {
      case DOCK_STATE.SAILING: {
        this.plank = Math.max(0, this.plank - dt / PLANK_TIME);
        if (near && near.dist < DOCK_PROMPT_RANGE) {
          this.nearIsland = near.isl;
          this.state = DOCK_STATE.APPROACH;
          this.discover(near.isl.id);
        } else {
          this.nearIsland = null;
          this.prompt = null;
        }
        break;
      }
      case DOCK_STATE.APPROACH: {
        if (!near || near.dist > DOCK_PROMPT_RANGE * 1.15) {
          this.state = DOCK_STATE.SAILING;
          this.prompt = null;
          break;
        }
        this.nearIsland = near.isl;
        this.prompt = this.canDock(body)
          ? 'Dock at ' + near.isl.name
          : 'Slow down to dock at ' + near.isl.name;
        break;
      }
      case DOCK_STATE.DOCKING: {
        this._transition += dt;
        const b = berthPose(this.nearIsland);
        // Warp in gently rather than snapping: the hull still rides the swell the whole time.
        const k = clamp01(dt * 1.25);
        body.pos.x += (b.x - body.pos.x) * k;
        body.pos.z += (b.z - body.pos.z) * k;
        body.yaw += angleDelta(body.yaw, b.yaw) * k;
        body.vel.x *= 0.86; body.vel.z *= 0.86;
        body.yawRate *= 0.8;
        const settled = Math.hypot(b.x - body.pos.x, b.z - body.pos.z) < 0.45
          && Math.abs(angleDelta(body.yaw, b.yaw)) < 0.05;
        if (settled || this._transition > 8) {
          body.pos.x = b.x; body.pos.z = b.z; body.yaw = b.yaw;
          body.vel.x = 0; body.vel.z = 0; body.yawRate = 0;
          this.plank = Math.min(1, this.plank + dt / PLANK_TIME);
          if (this.plank >= 1) {
            this.state = DOCK_STATE.DOCKED;
            if (ctx.audio) playAt(ctx.audio, 'hull_creak', body.pos.x, body.pos.y, body.pos.z, {});
          }
        }
        this.prompt = 'Docking at ' + this.nearIsland.name;
        break;
      }
      case DOCK_STATE.DOCKED: {
        const b = berthPose(this.nearIsland);
        // Moored. She still heaves with the swell — that is what makes a berth feel like water
        // rather than a car park — but springs and fenders take the roll and pitch out of her.
        // Without that a storm rolls the lee rail down to the surface and the gangplank becomes
        // a diving board, which is exactly what the boarding half of tools/check-ship.mjs found.
        body.pos.x = b.x; body.pos.z = b.z;
        body.yaw += angleDelta(body.yaw, b.yaw) * clamp01(dt * 4);
        body.vel.x = 0; body.vel.z = 0;
        body.yawRate *= 1 - clamp01(dt * 6);
        const moor = clamp01(dt * 2.6);
        body.roll -= body.roll * moor;
        body.pitch -= body.pitch * moor;
        body.rollRate -= body.rollRate * clamp01(dt * 4.5);
        body.pitchRate -= body.pitchRate * clamp01(dt * 4.5);
        // Ride the surface beside the pier. Free-floating, the hull lags a big swell by up to a
        // couple of metres; alongside, the lines and fenders hold her at the level of the water
        // she is moored in, which is the difference between a deck and a wading pool.
        if (ctx.water) {
          const surf = ctx.water.heightAt(b.x, b.z);
          body.pos.y += (surf - body.pos.y) * clamp01(dt * 2.6);
          body.vel.y -= body.vel.y * clamp01(dt * 3.2);
        }
        this.plank = 1;
        this.prompt = this.aboard
          ? 'Go ashore at ' + this.nearIsland.name
          : 'Board ship';
        break;
      }
      case DOCK_STATE.UNDOCKING: {
        this._transition += dt;
        this.plank = Math.max(0, this.plank - dt / PLANK_TIME);
        if (this.plank <= 0) {
          if (body.anchorDown) body.toggleAnchor();
          this.state = DOCK_STATE.APPROACH;
        }
        this.prompt = 'Casting off';
        break;
      }
      default: break;
    }

    this._stepPatrol(dt, body, ctx);
  }

  serialize() {
    return {
      state: this.state === DOCK_STATE.VOYAGE ? DOCK_STATE.SAILING : this.state,
      island: this.nearIsland ? this.nearIsland.id : null,
      plank: this.plank,
      aboard: this.aboard,
      local: [this.playerLocal.x, this.playerLocal.y, this.playerLocal.z],
      discovered: Array.from(this.discovered),
      shore: this.lastShore ? [this.lastShore.x, this.lastShore.y, this.lastShore.z] : null,
    };
  }

  deserialize(o) {
    if (!o) return this;
    this.state = o.state || DOCK_STATE.SAILING;
    this.plank = o.plank || 0;
    this.aboard = !!o.aboard;
    if (o.local) { this.playerLocal.x = o.local[0]; this.playerLocal.y = o.local[1]; this.playerLocal.z = o.local[2]; }
    this.discovered = new Set(Array.isArray(o.discovered) ? o.discovered : []);
    this.nearIsland = o.island ? (this.islands.find((i) => i.id === o.island) || null) : null;
    this.lastShore = o.shore ? { x: o.shore[0], y: o.shore[1], z: o.shore[2] } : null;
    this.voyage = null;
    return this;
  }
}

export default DockController;
