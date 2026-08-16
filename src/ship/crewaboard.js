// The crew, on deck. Owner: SHIP.
//
// Recruiting somebody in a quest has to change what you SEE, not just a number in a menu. So
// every member of `app.quests.crew()` gets a real voxel body built from CHARACTER_SPECS, a
// station on the ship, a station-specific idle, a walk between stations, and a reaction to
// weather and to being boarded. Their passive bonuses are already computed by the quest layer;
// this file reads `activeBonuses()` and applies the two that belong to the ship — the
// navigator's sail speed and the shipwright's hull repair.
//
// Animation: Cluster B owns src/entity/anim.js and its Animator. That file is consumed, never
// edited, and it is injected rather than imported so this module loads and runs before it
// exists (see `setAnimator`). Until it is wired, `CrewPoser` below drives the same part list
// with the same clip names — a complete procedural animator, not a placeholder.
//
// Everything here is deterministic: phases advance by the fixed dt, decisions come from a
// seeded Rng, and nothing reads the wall clock.

import { clamp, clamp01, lerp, smoothstep, angleDelta, TAU } from '../core/math.js';
import { Rng, hashString } from '../core/rng.js';
import { CHARACTER_SPECS, buildCharacter } from '../gen/charmodel.js';
import { deckHalfWidth, deckHeightAt, DECK_Z_RANGE } from './shipmodel.js';

/** The five working stations. Each has its own idle; each is somewhere you can actually stand. */
export const STATIONS = Object.freeze(['helm', 'rigging', 'lookout', 'galley', 'repair']);

/**
 * Crew id -> character archetype. There are exactly seven recruitable people and exactly seven
 * `crew_*` archetypes, so this is a bijection: nobody aboard is a visual duplicate of anybody
 * else, which is the whole point of the silhouette rules in ART_BAR §1.
 *
 * The pairings follow the portraits in src/quest/crew.js — Ferra Yune is green-haired with an
 * eye scar, which is the swordsman archetype exactly; Sen Ishiba is the formal black-and-gold
 * duellist, which is the musician's top-hat silhouette.
 */
export const CREW_ARCHETYPE = Object.freeze({
  pell_marren: 'crew_sniper',
  ferra_yune: 'crew_swordsman',
  odd_bracken: 'crew_shipwright',
  sena_brill: 'crew_doctor',
  basil_ord: 'crew_cook',
  nia_sarrow: 'crew_navigator',
  sen_ishiba: 'crew_musician',
});

/** Role -> home station. Where you find each person when nothing is happening. */
export const ROLE_STATION = Object.freeze({
  Helmsman: 'helm',
  Navigator: 'helm',
  Sniper: 'lookout',
  Shipwright: 'repair',
  Cook: 'galley',
  Doctor: 'galley',
  Swordsman: 'rigging',
});

/** Walking speed on deck, m/s. Slow: it is a small ship and they are not in a hurry. */
const WALK_SPEED = 1.5;
const CLIMB_SPEED = 1.9;

// ---------------------------------------------------------------------------
// The fallback animator
// ---------------------------------------------------------------------------

/**
 * Procedural pose driver for one crew member.
 *
 * Emits the same shape a rig expects: per-part euler rotations and offsets, plus a root
 * transform. All clips are pure functions of a phase that advances by dt, so two runs with the
 * same inputs produce identical poses.
 */
export class CrewPoser {
  constructor(seed = 1) {
    this.phase = 0;
    this.blend = 1;
    this.clip = 'idle_helm';
    this.prev = 'idle_helm';
    this.rng = new Rng((seed >>> 0) || 1);
    this.offset = this.rng.range(0, TAU);   // so a line of crew never breathes in unison
    this.pose = {
      root: { y: 0, pitch: 0, roll: 0, yaw: 0 },
      torso: { rx: 0, ry: 0, rz: 0 },
      head: { rx: 0, ry: 0, rz: 0 },
      armL: { rx: 0, ry: 0, rz: 0 },
      armR: { rx: 0, ry: 0, rz: 0 },
      legL: { rx: 0, ry: 0, rz: 0 },
      legR: { rx: 0, ry: 0, rz: 0 },
    };
  }

  /** Switch clip. Cross-fades over ~0.25 s so nobody snaps between poses. */
  play(clip) {
    if (clip === this.clip) return;
    this.prev = this.clip;
    this.clip = clip;
    this.blend = 0;
  }

  /** @param {number} dt fixed step @param {object} [env] { speed, storm, heel, pitch } */
  step(dt, env = {}) {
    this.phase += dt;
    this.blend = clamp01(this.blend + dt * 4);
    const a = CrewPoser.evaluate(this.prev, this.phase + this.offset, env);
    const b = CrewPoser.evaluate(this.clip, this.phase + this.offset, env);
    const t = smoothstep(0, 1, this.blend);
    const p = this.pose;
    for (const k of Object.keys(p)) {
      const A = a[k] || ZERO, B = b[k] || ZERO;
      for (const c of Object.keys(p[k])) p[k][c] = lerp(A[c] || 0, B[c] || 0, t);
    }
    return p;
  }

  /**
   * One clip, evaluated at a phase. Static so the same table can drive a preview tool.
   * @param {string} clip
   * @param {number} t seconds
   * @param {object} env
   */
  static evaluate(clip, t, env) {
    const sway = Math.sin(t * 1.1) * 0.05 + Math.sin(t * 0.37) * 0.03;
    const breathe = Math.sin(t * 1.6) * 0.035;
    const heel = env.heel || 0;
    const out = {
      root: { y: 0, pitch: 0, roll: -heel * 0.55, yaw: 0 },
      torso: { rx: breathe, ry: sway, rz: heel * 0.22 },
      head: { rx: -breathe * 0.6, ry: sway * 1.4, rz: -heel * 0.18 },
      armL: { rx: 0, ry: 0, rz: 0.10 + breathe },
      armR: { rx: 0, ry: 0, rz: -0.10 - breathe },
      legL: { rx: 0, ry: 0, rz: 0 },
      legR: { rx: 0, ry: 0, rz: 0 },
    };
    switch (clip) {
      case 'idle_helm': {
        // Hands up on the spokes, weight shifting with the swell, small corrections.
        const corr = Math.sin(t * 0.6) * 0.25;
        out.armL.rx = -1.15 + corr * 0.35; out.armL.rz = 0.42;
        out.armR.rx = -1.15 - corr * 0.35; out.armR.rz = -0.42;
        out.torso.ry = corr * 0.16;
        out.root.y = Math.sin(t * 1.1) * 0.02;
        break;
      }
      case 'idle_rigging': {
        // Hauling on a line: a two-beat pull with a recovery.
        const beat = (t * 0.55) % 1;
        const pull = beat < 0.42 ? smoothstep(0, 1, beat / 0.42) : 1 - smoothstep(0, 1, (beat - 0.42) / 0.58);
        out.armL.rx = -2.0 + pull * 1.3; out.armL.rz = 0.25;
        out.armR.rx = -1.8 + pull * 1.5; out.armR.rz = -0.22;
        out.torso.rx = 0.10 + pull * 0.22;
        out.legL.rx = -0.12 - pull * 0.10;
        out.legR.rx = 0.18 + pull * 0.12;
        out.root.y = -pull * 0.08;
        break;
      }
      case 'idle_lookout': {
        // Scanning the horizon, one hand shading the eyes, a slow head sweep.
        const scan = Math.sin(t * 0.32);
        out.head.ry = scan * 0.75;
        out.torso.ry = scan * 0.30;
        out.armR.rx = -2.3; out.armR.rz = -0.55;
        out.armL.rz = 0.16;
        break;
      }
      case 'idle_galley': {
        // Stirring a pot: a small tight circle with the right hand.
        out.armR.rx = -1.05 + Math.sin(t * 2.4) * 0.22;
        out.armR.rz = -0.55 + Math.cos(t * 2.4) * 0.22;
        out.armL.rx = -0.65; out.armL.rz = 0.5;
        out.torso.rx = 0.16;
        out.head.rx = 0.26;
        break;
      }
      case 'idle_repair': {
        // Hammering: fast down-stroke, slow lift, and a recoil in the torso.
        const beat = (t * 1.15) % 1;
        const strike = beat < 0.22 ? 1 - beat / 0.22 : (beat - 0.22) / 0.78;
        out.armR.rx = -2.2 + strike * 1.7;
        out.armR.rz = -0.30;
        out.armL.rx = -1.1; out.armL.rz = 0.44;
        out.torso.rx = 0.20 + (1 - strike) * 0.16;
        out.legL.rx = -0.22; out.legR.rx = 0.10;
        out.root.y = -0.10;
        break;
      }
      case 'walk': {
        const s = t * 5.2;
        const swing = Math.sin(s);
        out.legL.rx = swing * 0.80;
        out.legR.rx = -swing * 0.80;
        out.armL.rx = -swing * 0.55; out.armL.rz = 0.18;
        out.armR.rx = swing * 0.55; out.armR.rz = -0.18;
        out.torso.ry = -swing * 0.13;
        out.root.y = Math.abs(Math.cos(s)) * 0.09;
        break;
      }
      case 'climb': {
        const s = t * 3.6;
        const swing = Math.sin(s);
        out.armL.rx = -2.5 + swing * 0.5; out.armL.rz = 0.35;
        out.armR.rx = -2.5 - swing * 0.5; out.armR.rz = -0.35;
        out.legL.rx = 0.5 - swing * 0.4;
        out.legR.rx = 0.5 + swing * 0.4;
        out.torso.rx = -0.18;
        break;
      }
      case 'brace': {
        // Storm: wide stance, one hand on the rail, head down against the spray.
        const gust = Math.sin(t * 3.1) * 0.10 + Math.sin(t * 1.3) * 0.06;
        out.legL.rz = 0.26; out.legR.rz = -0.26;
        out.armL.rx = -1.5; out.armL.rz = 0.75;
        out.armR.rx = -0.6; out.armR.rz = -0.30;
        out.torso.rx = 0.30 + gust;
        out.head.rx = 0.34;
        out.root.y = -0.16;
        out.root.roll = -heel * 0.8;
        break;
      }
      case 'combat': {
        // Weapon up, side-on, weight back, small bounce. Legible as "ready" at a glance.
        const bob = Math.sin(t * 3.4) * 0.06;
        out.torso.ry = -0.42;
        out.armR.rx = -1.55 + bob; out.armR.rz = -0.20;
        out.armL.rx = -0.75 - bob; out.armL.rz = 0.55;
        out.legL.rx = -0.24; out.legR.rx = 0.26;
        out.head.ry = 0.34;
        out.root.y = -0.06 + bob * 0.4;
        break;
      }
      case 'cheer': {
        const p2 = Math.sin(t * 4.0);
        out.armL.rx = -2.6; out.armL.rz = 0.55 + p2 * 0.2;
        out.armR.rx = -2.6; out.armR.rz = -0.55 - p2 * 0.2;
        out.root.y = Math.max(0, p2) * 0.22;
        out.head.rx = -0.22;
        break;
      }
      default: break;
    }
    return out;
  }
}

const ZERO = { rx: 0, ry: 0, rz: 0, y: 0, pitch: 0, roll: 0, yaw: 0 };

// ---------------------------------------------------------------------------
// Crew aboard
// ---------------------------------------------------------------------------

/**
 * Everybody currently on the ship.
 *
 * Positions are in SHIP-LOCAL metres, exactly like the player's — the deck is a moving
 * platform for the crew too, and doing it any other way makes them swim in place when the ship
 * turns.
 */
export class CrewAboard {
  /**
   * @param {object} opts
   *  tex, reg   texture library + block registry, needed to build bodies (omit for headless)
   *  seed       world seed
   *  stations   station table from the ship model
   *  animator   optional (charModel, seed) => Animator, from Cluster B's src/entity/anim.js
   */
  constructor(opts = {}) {
    this.tex = opts.tex || null;
    this.reg = opts.reg || null;
    this.seed = (opts.seed >>> 0) || 1;
    this.stations = opts.stations || {};
    this.animatorFactory = opts.animator || null;
    /** @type {object[]} */
    this.members = [];
    this._ids = '';
    this._models = new Map();
    /** Sailing-relevant bonuses this crew contributes, read by SailingBody.setModifiers. */
    this.bonus = { sailSpeedMult: 1, turnRateMult: 1, stormDriftMult: 1, hullRepairPerSec: 0 };
    this.repaired = 0;
    this.alarm = 0;      // 0..1, raised when boarded; drives the combat clip
    this.dirty = true;   // set when the roster changes, so ShipSystem rebuilds meshes
  }

  /**
   * Inject Cluster B's Animator factory. Called by the orchestrator once src/entity/anim.js
   * exists; until then the built-in CrewPoser drives the same clips.
   * @param {(model:object, seed:number)=>object} factory
   */
  setAnimator(factory) {
    this.animatorFactory = factory;
    for (const m of this.members) m.anim = this._makeAnim(m);
    return this;
  }

  _makeAnim(m) {
    if (this.animatorFactory) {
      try {
        const a = this.animatorFactory(m.model, m.seed);
        if (a && typeof a.step === 'function' && typeof a.play === 'function') return a;
      } catch (e) {
        // A rig that cannot be built must not take the ship down with it. Fall back and say so.
        this.animError = String(e && e.message ? e.message : e);
      }
    }
    return new CrewPoser(m.seed);
  }

  /** Station position in ship-local metres, with a per-person lateral offset so they do not stack. */
  stationPos(name, slot) {
    const s = this.stations[name] || this.stations.waist || [0, 2.75, 0];
    const off = slot === 0 ? 0 : (slot % 2 === 1 ? 0.9 : -0.9) * Math.ceil(slot / 2);
    const z = clamp(s[2] + (slot >= 3 ? 1.1 : 0), DECK_Z_RANGE.aft, DECK_Z_RANGE.fore);
    if (name === 'lookout') return { x: s[0] + off * 0.4, y: s[1], z: s[2], climb: true };
    const half = Math.max(0.4, deckHalfWidth(z) - 0.5);
    return { x: clamp(s[0] + off, -half, half), y: deckHeightAt(z), z, climb: false };
  }

  /**
   * Rebuild the aboard list from the quest roster. Idempotent — called every step, does real
   * work only when the roster actually changed.
   * @param {object[]} roster from QuestSystem.crew()
   */
  sync(roster) {
    const list = roster || [];
    const key = list.map((c) => c.id).join(',');
    if (key === this._ids) return this;
    this._ids = key;
    this.dirty = true;
    const kept = new Map(this.members.map((m) => [m.id, m]));
    this.members = [];
    const used = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const existing = kept.get(c.id);
      if (existing) { this.members.push(existing); continue; }
      const specId = CREW_ARCHETYPE[c.id] || 'crew_swordsman';
      const spec = CHARACTER_SPECS[specId] || CHARACTER_SPECS.crew_swordsman;
      const home = ROLE_STATION[c.role] || 'rigging';
      used[home] = (used[home] || 0) + 1;
      const seed = (this.seed ^ hashString(c.id)) >>> 0;
      const m = {
        id: c.id,
        name: c.name,
        role: c.role,
        specId,
        spec,
        seed,
        model: this._model(spec, seed),
        home,
        station: home,
        target: home,
        slot: used[home] - 1,
        pos: { x: 0, y: 0, z: 0 },
        yaw: 0,
        path: null,
        state: 'idle',
        wait: 3 + (i * 2.7) % 9,
        rng: new Rng(seed).fork('crewaboard'),
        bark: c.barks && c.barks.length ? c.barks[0] : null,
        barks: c.barks || [],
        bonus: c.bonus || {},
        anim: null,
        clip: 'idle_' + home,
      };
      const sp = this.stationPos(home, m.slot);
      m.pos.x = sp.x; m.pos.y = sp.y; m.pos.z = sp.z;
      m.yaw = home === 'helm' ? 0 : Math.PI;
      m.anim = this._makeAnim(m);
      this.members.push(m);
    }
    return this;
  }

  /** Build (and cache) the voxel body for an archetype. Returns null when headless. */
  _model(spec, seed) {
    if (!this.tex || !this.reg) return null;
    const key = spec.id;
    let m = this._models.get(key);
    if (!m) {
      m = buildCharacter(this.tex, this.reg, spec, this.seed);
      this._models.set(key, m);
    }
    return m;
  }

  /**
   * Apply the crew's ship-relevant passive bonuses.
   * The quest layer already merged everybody's numbers; this only picks out the ones the ship
   * owns and hands them to the hull.
   * @param {object} activeBonuses from QuestSystem.activeBonuses()
   * @param {object} hull { hp, maxHp } — repaired in place by the shipwright
   * @param {number} dt
   */
  applyBonuses(activeBonuses, hull, dt) {
    const b = activeBonuses || {};
    this.bonus.sailSpeedMult = b.sailSpeedMult || 1;
    this.bonus.turnRateMult = b.turnRateMult || 1;
    this.bonus.stormDriftMult = b.stormDriftMult || 1;
    this.bonus.hullRepairPerSec = b.hullRepairPerSec || 0;
    if (hull && this.bonus.hullRepairPerSec > 0 && hull.hp < hull.maxHp) {
      const heal = Math.min(hull.maxHp - hull.hp, this.bonus.hullRepairPerSec * dt);
      hull.hp += heal;
      this.repaired += heal;
    }
    return this.bonus;
  }

  /**
   * Step everybody. Deterministic: all decisions come from each member's own Rng stream.
   *
   * @param {number} dt fixed step
   * @param {object} ctx { body, weather, combat, docked }
   */
  step(dt, ctx = {}) {
    const body = ctx.body;
    const weather = ctx.weather || { storm: 0 };
    const storm = clamp01(weather.storm || 0);
    const fighting = !!ctx.combat;
    this.alarm = fighting ? clamp01(this.alarm + dt * 2.5) : Math.max(0, this.alarm - dt * 1.2);
    const heel = body ? body.heelAngle : 0;
    const env = { heel, storm, speed: body ? body.speed : 0, pitch: body ? body.pitch : 0 };

    for (const m of this.members) {
      this._stepMember(dt, m, ctx, storm, fighting);
      // Everybody leans against the heel and rides the pitch — this is what glues them to the
      // deck instead of leaving them floating above a rolling ship.
      if (m.anim) {
        if (typeof m.anim.play === 'function') m.anim.play(m.clip, env);
        if (typeof m.anim.step === 'function') m.anim.step(dt, env);
      }
    }
    return this;
  }

  _stepMember(dt, m, ctx, storm, fighting) {
    // --- pick a behaviour ---------------------------------------------------------------
    if (fighting) {
      m.state = 'fight';
      m.clip = 'combat';
      if (ctx.body && ctx.threat) {
        const l = ctx.body.toLocal(ctx.threat.x, ctx.threat.y, ctx.threat.z);
        const want = Math.atan2(l.x - m.pos.x, l.z - m.pos.z);
        m.yaw += angleDelta(m.yaw, want) * clamp01(dt * 5);
      }
      return;
    }
    if (storm > 0.55 && m.station !== 'helm' && m.state !== 'walk') {
      m.state = 'brace';
      m.clip = 'brace';
      m.wait = Math.max(m.wait, 1.5);
      return;
    }

    if (m.state === 'walk') {
      this._walk(dt, m);
      return;
    }

    // Idle at station until the timer runs out, then pick somewhere else to be.
    m.state = 'idle';
    m.clip = 'idle_' + m.station;
    m.wait -= dt;
    if (m.wait > 0) return;
    m.wait = m.rng.range(9, 26);
    // Two thirds of the time they go back to their own job; the rest they wander, which is what
    // makes a crew read as people rather than as furniture.
    const next = m.rng.chance(0.62) ? m.home : STATIONS[m.rng.u32() % STATIONS.length];
    if (next === m.station) return;
    m.target = next;
    m.path = this._buildPath(m, next);
    m.state = 'walk';
    m.clip = 'walk';
  }

  /**
   * A path along the centreline. Going fore-and-aft down the middle of the deck keeps everybody
   * clear of the cabin, the cargo and the rail, without needing a navmesh for a 19 m boat.
   */
  _buildPath(m, target) {
    const dst = this.stationPos(target, m.slot);
    const pts = [];
    if (Math.abs(m.pos.x) > 0.25) pts.push({ x: 0, y: deckHeightAt(m.pos.z), z: m.pos.z, climb: false });
    if (dst.climb) {
      const mastZ = this.stations.lookout ? this.stations.lookout[2] : 2;
      pts.push({ x: 0, y: deckHeightAt(mastZ), z: mastZ, climb: false });
      pts.push({ x: dst.x, y: dst.y, z: dst.z, climb: true });
    } else {
      pts.push({ x: 0, y: deckHeightAt(dst.z), z: dst.z, climb: false });
      pts.push({ x: dst.x, y: dst.y, z: dst.z, climb: false });
    }
    return { pts, i: 0 };
  }

  _walk(dt, m) {
    const path = m.path;
    if (!path || path.i >= path.pts.length) {
      m.station = m.target;
      m.state = 'idle';
      m.clip = 'idle_' + m.station;
      m.path = null;
      return;
    }
    const p = path.pts[path.i];
    const dx = p.x - m.pos.x, dz = p.z - m.pos.z, dy = p.y - m.pos.y;
    const flat = Math.hypot(dx, dz);
    if (p.climb) {
      m.clip = 'climb';
      const step = CLIMB_SPEED * dt;
      m.pos.x += dx * clamp01(step / Math.max(flat, 0.001));
      m.pos.z += dz * clamp01(step / Math.max(flat, 0.001));
      m.pos.y += clamp(dy, -step, step);
      if (Math.abs(dy) < 0.05 && flat < 0.12) { path.i++; }
      return;
    }
    m.clip = 'walk';
    if (flat < 0.12) {
      m.pos.y = p.y;
      path.i++;
      return;
    }
    const step = Math.min(WALK_SPEED * dt, flat);
    m.pos.x += (dx / flat) * step;
    m.pos.z += (dz / flat) * step;
    m.pos.y = lerp(m.pos.y, deckHeightAt(m.pos.z), clamp01(dt * 6));
    const want = Math.atan2(dx, dz);
    m.yaw += angleDelta(m.yaw, want) * clamp01(dt * 6);
  }

  /** A line one of them would say right now, or null. UI decides whether to show it. */
  barkFor(id) {
    const m = this.members.find((x) => x.id === id);
    if (!m || !m.barks.length) return null;
    return m.barks[m.rng.u32() % m.barks.length];
  }

  /** Read-only view for the HUD / crew screen. */
  view() {
    return this.members.map((m) => ({
      id: m.id, name: m.name, role: m.role, station: m.station,
      state: m.state, clip: m.clip,
      pos: [m.pos.x, m.pos.y, m.pos.z], yaw: m.yaw,
    }));
  }

  serialize() {
    return {
      repaired: this.repaired,
      members: this.members.map((m) => ({ id: m.id, station: m.station, pos: [m.pos.x, m.pos.y, m.pos.z], yaw: m.yaw })),
    };
  }

  deserialize(o) {
    if (!o) return this;
    this.repaired = o.repaired || 0;
    for (const rec of o.members || []) {
      const m = this.members.find((x) => x.id === rec.id);
      if (!m) continue;
      m.station = rec.station || m.home;
      m.target = m.station;
      m.clip = 'idle_' + m.station;
      m.state = 'idle';
      if (rec.pos) { m.pos.x = rec.pos[0]; m.pos.y = rec.pos[1]; m.pos.z = rec.pos[2]; }
      m.yaw = rec.yaw || 0;
    }
    return this;
  }

  dispose() {
    this._models.clear();
    this.members.length = 0;
  }
}

export default CrewAboard;
