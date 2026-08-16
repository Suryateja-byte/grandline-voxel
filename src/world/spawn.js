// Population: who and what is on an island, and what is out at sea hunting you.
//
// Everything here is deterministic per (island id, world seed). An island's camps, patrol
// routes, wildlife, NPC posts and chests are decided the first time it is built and are
// identical every time after — including after the streamer has thrown the island away and
// rebuilt it, which happens routinely, so "identical" is not a nicety.
//
// The CLEARED SET is what makes that safe. A camp you have defeated is recorded by id, and a
// rebuilt island consults the set before it spawns anything. Without it, sailing away and
// back would resurrect every enemy you have ever beaten, and the save would be a lie.
//
// This system does not own enemies, NPCs or ships — Cluster C and the SHIP owner do. It owns
// the DECISION of what should exist where, publishes it, and hands it over the moment the
// consuming system is present (`app.enemies.spawnWave`, `app.npc.spawn`, `app.ship.spawnPatrol`).
// Until those exist it still draws the things nobody else claims — chests, camp tents and
// marine hulls — so the world is never empty while the rest of the game lands.

import * as THREE from 'three';
import { Rng, hashString } from '../core/rng.js';
import { clamp, TAU } from '../core/math.js';
import { meshVolume } from '../gen/voxel.js';
import { IslandCanvas, shipHull, VOXEL_M } from '../gen/islandbuild.js';
import { NPCS } from '../quest/dialogue.js';
import { QUESTS, ITEMS as QUEST_ITEMS, PROPS as QUEST_PROPS } from '../quest/quests.js';

/**
 * What each island must PLACE for its quest chain to be completable: every itemId a `collect`
 * objective asks for and every propId a `destroy` objective asks for, with the highest count
 * any quest needs. Ids are namespaced `<islandId>.<name>`, which is how they route home.
 * Built once from the frozen quest specs, so world and quests can never disagree.
 */
const QUEST_PLACEMENTS = (() => {
  const by = new Map();
  const rec = (island) => {
    let r = by.get(island);
    if (!r) { r = { items: new Map(), props: new Map() }; by.set(island, r); }
    return r;
  };
  for (const q of QUESTS) {
    for (const st of q.steps) {
      for (const o of st.objectives) {
        if (o.type === 'collect' && QUEST_ITEMS[o.itemId]) {
          const r = rec(o.itemId.split('.')[0]);
          r.items.set(o.itemId, Math.max(r.items.get(o.itemId) || 0, o.count || 1));
        } else if (o.type === 'destroy' && QUEST_PROPS[o.propId]) {
          const r = rec(o.propId.split('.')[0]);
          r.props.set(o.propId, Math.max(r.props.get(o.propId) || 0, o.count || 1));
        }
      }
    }
  }
  return by;
})();

/**
 * Character spec for an NPC kind (quest/dialogue.js vocabulary -> gen/charmodel.js specs).
 * The two villager builds alternate by npc id hash so a village is not a row of clones.
 */
function specForNpcKind(kind, npcId) {
  switch (kind) {
    case 'child': return 'villager_b';
    case 'merchant': case 'barkeep': case 'shipwright': return 'merchant';
    case 'elder': case 'scholar': case 'doctor': return 'elder';
    case 'marine': return 'marine_recruit';
    case 'marine_officer': return 'marine_officer';
    case 'pirate': case 'bandit': return 'pirate_thug';
    default: return (hashString(npcId || '') & 1) ? 'villager_b' : 'villager_a';
  }
}

/** Enemy kinds per island biome. Names come from ENEMY_KINDS in quest/quests.js. */
export const BIOME_ENEMIES = Object.freeze({
  coast: ['thug', 'thug_brute', 'marine_grunt'],
  jungle: ['jungle_stalker', 'thug', 'thug_brute'],
  industrial: ['marine_grunt', 'marine_officer', 'thug'],
  snow: ['frost_wolf', 'marine_grunt', 'thug_brute'],
  volcanic: ['ash_hound', 'forge_wraith', 'thug_brute'],
  desert: ['dune_bandit', 'mirage_shade', 'thug'],
  blossom: ['terrace_duelist', 'blossom_ronin', 'marine_officer'],
  fortress: ['marine_grunt', 'marine_officer', 'marine_elite'],
  ruins: ['dune_bandit', 'mirage_shade'],
  rock: ['thug', 'marine_grunt'],
  fungal: ['jungle_stalker', 'thug'],
});

/** Wildlife per biome. Ambient, never hostile unless struck. */
export const BIOME_WILDLIFE = Object.freeze({
  coast: ['gull', 'crab'], jungle: ['monkey', 'parrot'], industrial: ['gull', 'rat'],
  snow: ['snow_hare', 'gull'], volcanic: ['ash_moth'], desert: ['scarab', 'vulture'],
  blossom: ['crane', 'koi'], fortress: ['gull'], ruins: ['vulture'],
  rock: ['gull'], fungal: ['glow_moth'],
});

/** How close the player has to be for a camp to hand its enemies to the combat system. */
const ACTIVATE_M = 130;
const DEACTIVATE_M = 210;
/** Marine patrols live inside this radius of the player and are recycled outside it. */
const PATROL_RADIUS_M = 1500;

export class SpawnSystem {
  /**
   * @param {object} app
   * @param {{world?:object, seed?:number, headless?:boolean}} opts
   */
  constructor(app, opts = {}) {
    this.app = app || null;
    // The World may not be on the app yet. src/game.js constructs every system first and only
    // assigns `app.<name>` when it registers them in step order afterwards, so
    // `createSpawnSystem(app)` runs while `app.world` is still undefined. This used to throw,
    // game.js swallowed it as "systems not assembled: spawn", and the whole population layer —
    // chests, camp tents, marine patrols — silently never existed. Bind late instead: nothing
    // in this system needs the World before its first step.
    this.world = opts.world || (app && app.world) || null;
    this.seed = (opts.seed !== undefined
      ? opts.seed
      : (this.world ? this.world.seed : (app ? app.seed : 1))) >>> 0;
    this.headless = !!opts.headless;
    /** True once the island lifecycle hooks are installed. See _bindWorld(). */
    this._bound = false;

    /** islandId -> populated record set. */
    this.byIsland = new Map();
    /** Ids of camps, chests and named encounters that are done with. Saved. */
    this.cleared = new Set();
    /** Chest ids already opened. Saved separately: a chest is looted, not defeated. */
    this.openedChests = new Set();
    /** Quest pickup instance ids already taken, and quest props already destroyed. Saved. */
    this.collectedItems = new Set();
    this.destroyedProps = new Set();
    /** Requests other systems have not picked up yet. */
    this.pending = [];
    /** Live marine patrol ships. */
    this.patrols = [];
    this.patrolRng = Rng.fromName(this.seed, 'patrols');
    this.patrolTimer = 6;
    this.patrolSerial = 0;
    this.time = 0;

    this.geo = null;
    this.group = null;
    /** id -> THREE.Object3D for the things this system draws itself. */
    this.props = new Map();
    /** islandId -> live Npc actors handed to the npc system. */
    this._npcActors = new Map();

    if (this.world) this._bindWorld();
  }

  /**
   * Attach to the World's island lifecycle. Called from the constructor when the World was
   * already available, otherwise from the first step(). Idempotent, and it back-populates
   * whatever streamed in before we were listening — an island loaded during the bind gap
   * would otherwise be permanently empty.
   */
  _bindWorld() {
    if (!this.world || this._bound) return;
    this._bound = true;
    // Chain onto whatever the world already had, so more than one consumer can listen.
    const prevLoad = this.world.onIslandLoaded;
    this.world.onIslandLoaded = (inst) => {
      if (prevLoad) prevLoad(inst);
      this.populate(inst);
    };
    const prevUnload = this.world.onIslandUnloaded;
    this.world.onIslandUnloaded = (inst) => {
      if (prevUnload) prevUnload(inst);
      this.detach(inst.id);
    };
    if (this.world.loaded) for (const inst of this.world.loaded.values()) this.populate(inst);
  }

  // --- population ----------------------------------------------------------

  /**
   * Decide (once) everything that lives on an island.
   * @param {import('./chunk.js').IslandInstance} inst
   * @returns {object} the island's spawn set
   */
  populate(inst) {
    const existing = this.byIsland.get(inst.id);
    if (existing) { this._attachProps(inst, existing); return existing; }

    const rec = inst.record;
    const rng = new Rng((this.seed ^ hashString('spawn:' + inst.id)) >>> 0);
    const tier = rec.difficultyTier || 1;
    const biome = rec.biome || 'coast';
    const kinds = BIOME_ENEMIES[biome] || BIOME_ENEMIES.coast;
    const fauna = BIOME_WILDLIFE[biome] || BIOME_WILDLIFE.coast;
    const points = this.world.spawnPointsOf(inst) || {};

    const set = {
      island: inst.id, tier, biome,
      camps: [], patrols: [], wildlife: [], npcs: [], chests: [],
    };

    // Camps: placed on real ground, away from the dock so the first thing you meet is not
    // an ambush at the gangplank.
    const dock = points.dock || { x: inst.centerX, z: inst.centerZ + rec.radius };
    const campCount = rec.kind === 'landmark' ? 2 + (tier > 3 ? 1 : 0) : (rng.chance(0.55) ? 1 : 0);
    for (let i = 0; i < campCount; i++) {
      const p = this._findGround(inst, rng, 26, (x, z, y) =>
        y > 1.2 && Math.hypot(x - dock.x, z - dock.z) > rec.radius * 0.55);
      if (!p) continue;
      const kind = kinds[rng.u32() % kinds.length];
      set.camps.push({
        id: inst.id + '.camp' + (i + 1),
        kind, x: p.x, y: p.y, z: p.z,
        // Tier-1 islands are the tutorial's combat classroom: a 3-man camp is a winnable first
        // fight, 4-5 across two camps is a wall. Measured: a half-health player cycling into the
        // old 12-strong shellsCove pair landed 0 kills in 275 s. Higher tiers keep their teeth.
        // NOTE for future tuning: any change here reshuffles enemy identity downstream (each
        // spawn consumes the stream), and the scripted playtest's fight outcomes are sensitive
        // to the exact enemy set. Capping tier-1 camps at 3 was tried on 2026-08-15 and broke
        // the previously-passing win-a-fight step; if starter difficulty needs tuning, retune
        // the DRIVER'S combat competence (or enemy hp/damage globally) rather than the count.
        count: clamp(2 + tier + rng.int(0, 2), 3, 8),
        radius: 14 + rng.int(0, 8),
        elite: tier >= 4 && rng.chance(0.35),
        active: false,
      });
    }

    // Patrols: a walking route between two ground points. Two enemies, three at high tier.
    const patrolCount = rec.kind === 'landmark' ? 2 : (rng.chance(0.35) ? 1 : 0);
    for (let i = 0; i < patrolCount; i++) {
      const a = this._findGround(inst, rng, 22, (x, z, y) => y > 0.8);
      const b = this._findGround(inst, rng, 22, (x, z, y) => y > 0.8);
      if (!a || !b) continue;
      set.patrols.push({
        id: inst.id + '.patrol' + (i + 1),
        kind: kinds[rng.u32() % kinds.length],
        count: tier >= 4 ? 3 : 2,
        route: [[a.x, a.y, a.z], [b.x, b.y, b.z]],
        active: false,
      });
    }

    // Wildlife: cheap, always there, and the reason an island sounds inhabited.
    const wildCount = 3 + rng.int(0, 5);
    for (let i = 0; i < wildCount; i++) {
      const p = this._findGround(inst, rng, 18, () => true);
      if (!p) continue;
      set.wildlife.push({
        id: inst.id + '.wild' + i,
        species: fauna[rng.u32() % fauna.length],
        x: p.x, y: p.y, z: p.z,
      });
    }

    // NPCs: the named people from quest/dialogue.js, at their authored posts.
    for (const npc of NPCS) {
      if (npc.island !== inst.id) continue;
      const p = points[npc.spawn];
      if (!p) continue;
      set.npcs.push({
        id: npc.id, name: npc.name, kind: npc.kind, portrait: npc.portrait,
        x: p.x, y: p.y, z: p.z, yaw: p.yaw || 0, point: inst.id + '.' + npc.spawn,
      });
    }

    // Chests: the three authored ones, plus a couple the island hid for itself.
    for (const key of ['chest_1', 'chest_2', 'chest_3']) {
      const p = points[key];
      if (!p) continue;
      set.chests.push({ id: inst.id + '.' + key, x: p.x, y: p.y, z: p.z, authored: true, tier });
    }
    const extra = rng.int(1, 3);
    for (let i = 0; i < extra; i++) {
      const p = this._findGround(inst, rng, 20, (x, z, y) => y > 0.6);
      if (!p) continue;
      set.chests.push({ id: inst.id + '.cache' + (i + 1), x: p.x, y: p.y, z: p.z, authored: false, tier });
    }

    // Quest pickups and destructible props. Without these on the ground, every `collect` and
    // `destroy` objective in the island's chain is uncompletable — the events they progress on
    // (itemCollected / propDestroyed) had no emitter at all. One spare above the required
    // count, so a single bad placement roll can never soft-lock a quest.
    set.items = [];
    set.props = [];
    const qp = QUEST_PLACEMENTS.get(inst.id);
    if (qp) {
      for (const [itemId, count] of qp.items) {
        for (let i = 0; i < count + 1; i++) {
          const p = this._findGround(inst, rng, 24, (x, z, y) => y > 0.6);
          if (!p) continue;
          set.items.push({ id: itemId + '#' + (i + 1), itemId, x: p.x, y: p.y, z: p.z });
        }
      }
      for (const [propId, count] of qp.props) {
        for (let i = 0; i < count + 1; i++) {
          const p = this._findGround(inst, rng, 24, (x, z, y) => y > 0.6);
          if (!p) continue;
          set.props.push({ id: propId + '#' + (i + 1), propId, x: p.x, y: p.y, z: p.z });
        }
      }
    }

    this.byIsland.set(inst.id, set);
    this._attachProps(inst, set);
    return set;
  }

  /**
   * Rejection-sample a point on the island's real surface.
   * @returns {{x:number,y:number,z:number}|null}
   */
  _findGround(inst, rng, tries, accept) {
    const r = inst.radius * 0.86;
    for (let i = 0; i < tries; i++) {
      const a = rng.f() * TAU;
      const d = Math.sqrt(rng.f()) * r;
      const x = inst.centerX + Math.cos(a) * d;
      const z = inst.centerZ + Math.sin(a) * d;
      const y = inst.heightAt(x, z);
      if (y === -Infinity) continue;
      // Reject slopes: nothing should be pitched on a cliff face.
      const s1 = inst.heightAt(x + 1.5, z), s2 = inst.heightAt(x, z + 1.5);
      if (s1 === -Infinity || s2 === -Infinity) continue;
      if (Math.abs(s1 - y) > 1.4 || Math.abs(s2 - y) > 1.4) continue;
      if (!accept(x, z, y)) continue;
      return { x, y, z };
    }
    return null;
  }

  // --- geometry this system draws itself -----------------------------------

  _ensureGeometry() {
    if (this.geo || this.headless) return;
    const app = this.app;
    if (!app || !app.materials || !app.rootStatic) return;
    const B = this.world.B, reg = this.world.reg;
    const g = {};
    const mk = (c, origin) => ({
      solid: meshVolume(c.vol, reg, { scale: VOXEL_M, origin, cutoutOnly: false }),
      cutout: meshVolume(c.vol, reg, { scale: VOXEL_M, origin, cutoutOnly: true }),
    });

    {
      const c = new IslandCanvas({ sx: 10, sy: 10, sz: 8, seaLevel: 0, B, seed: 3 });
      c.box(1, 0, 1, 8, 3, 6, B.plank);
      c.box(2, 1, 2, 7, 3, 5, 0);
      c.box(1, 4, 1, 8, 4, 6, B.woodDark);
      c.box(1, 5, 2, 8, 5, 5, B.woodDark);
      c.box(0, 2, 3, 0, 2, 4, B.gold);
      c.box(9, 2, 3, 9, 2, 4, B.gold);
      c.box(4, 4, 0, 5, 4, 0, B.gold);
      g.chest = [mk(c, [-2.5, 0, -2])];
    }
    {
      const c = new IslandCanvas({ sx: 22, sy: 16, sz: 22, seaLevel: 0, B, seed: 5 });
      // Tent: two poles and a stretched sail, plus a stone fire ring and a leaning banner.
      c.colFill(6, 11, 0, 6, B.wood);
      c.colFill(14, 11, 0, 6, B.wood);
      for (let i = 0; i <= 8; i++) {
        const drop = Math.round(Math.abs(i - 4) * 0.9);
        for (let z = 7; z <= 15; z++) c.set(6 + i, 6 - drop, z, B.sail);
      }
      c.ring(16, 6, 0, 2.6, B.rock, 1);
      c.colFill(16, 6, 0, 1, B.woodDark);
      c.colFill(3, 16, 0, 9, B.wood);
      for (let k = 0; k < 4; k++) c.setAir(4 + k, 8, 16, B.flagRed);
      g.camp = [mk(c, [-5.5, 0, -5.5])];
    }
    {
      // Quest pickup: a small strapped bundle — low, gold-banded, reads as "take me".
      const c = new IslandCanvas({ sx: 4, sy: 4, sz: 4, seaLevel: 0, B, seed: 11 });
      c.box(0, 0, 0, 3, 1, 3, B.plank);
      c.box(1, 2, 1, 2, 2, 2, B.gold);
      g.item = [mk(c, [-1, 0, -1])];
    }
    {
      // Quest prop: a planted banner — tall enough to spot across a camp, obviously breakable.
      const c = new IslandCanvas({ sx: 6, sy: 14, sz: 3, seaLevel: 0, B, seed: 13 });
      c.colFill(1, 1, 0, 12, B.wood);
      for (let k = 0; k < 4; k++) {
        for (let y = 8; y <= 12; y++) c.setAir(2 + k, y, 1, B.flagRed);
      }
      g.prop = [mk(c, [-1, 0, -1])];
    }
    {
      const c = new IslandCanvas({ sx: 72, sy: 60, sz: 28, seaLevel: 12, B, seed: 9 });
      shipHull(c, 6, 14, 56, 16, 12, { hull: B.plank, rib: B.woodDark, deck: B.plank });
      c.colFill(32, 14, 18, 46, B.wood);
      for (let y = 24; y <= 42; y++) {
        for (let z = 8; z <= 20; z++) c.setAir(32, y, z, y > 38 ? B.sailShade : B.sail);
      }
      for (let z = 10; z <= 18; z++) c.set(31, 44, z, B.rogerMarine !== undefined ? B.rogerMarine : B.sail);
      c.box(44, 18, 12, 50, 20, 16, B.plankV !== undefined ? B.plankV : B.plank);
      g.patrol = [mk(c, [-18, -6, -7])];
    }
    this.geo = g;
    this.group = new THREE.Group();
    this.group.name = 'spawn';
    app.rootStatic.add(this.group);
  }

  _addProp(id, kind, x, y, z, yaw) {
    this._ensureGeometry();
    if (!this.geo || this.props.has(id)) return;
    const bank = this.geo[kind];
    if (!bank) return;
    const pick = bank[0];
    const node = new THREE.Group();
    node.name = 'spawnProp:' + id;
    if (pick.solid.userData.triangles > 0) {
      node.add(new THREE.Mesh(pick.solid, this.app.materials.prop || this.app.materials.terrain));
    }
    if (pick.cutout.userData.triangles > 0) {
      node.add(new THREE.Mesh(pick.cutout, this.app.materials.terrainCutout));
    }
    node.position.set(x, y, z);
    node.rotation.y = yaw || 0;
    this.group.add(node);
    this.props.set(id, node);
  }

  _removeProp(id) {
    const n = this.props.get(id);
    if (!n) return;
    if (n.parent) n.parent.remove(n);
    this.props.delete(id);
  }

  _attachProps(inst, set) {
    if (this.headless) return;
    this._ensureGeometry();
    if (!this.geo) return;
    for (const ch of set.chests) {
      if (this.openedChests.has(ch.id)) continue;
      this._addProp(ch.id, 'chest', ch.x, ch.y, ch.z, (hashString(ch.id) % 360) * (Math.PI / 180));
    }
    for (const camp of set.camps) {
      if (this.cleared.has(camp.id)) continue;
      this._addProp(camp.id, 'camp', camp.x, camp.y, camp.z, (hashString(camp.id) % 360) * (Math.PI / 180));
    }
    for (const it of set.items || []) {
      if (this.collectedItems.has(it.id)) continue;
      this._addProp(it.id, 'item', it.x, it.y, it.z, (hashString(it.id) % 360) * (Math.PI / 180));
    }
    for (const pr of set.props || []) {
      if (this.destroyedProps.has(pr.id)) continue;
      this._addProp(pr.id, 'prop', pr.x, pr.y, pr.z, (hashString(pr.id) % 360) * (Math.PI / 180));
    }
  }

  /** Drop the drawn props of an island that has just been unloaded. */
  detach(islandId) {
    const set = this.byIsland.get(islandId);
    if (!set) return;
    for (const ch of set.chests) this._removeProp(ch.id);
    for (const camp of set.camps) { this._removeProp(camp.id); camp.active = false; }
    for (const it of set.items || []) this._removeProp(it.id);
    for (const pr of set.props || []) this._removeProp(pr.id);
    for (const p of set.patrols) p.active = false;
    this._despawnNpcs(islandId);
    // Bound the table over a long voyage. The set is a pure function of (island, seed), and
    // `cleared` / `openedChests` are kept separately, so dropping it loses nothing.
    if (this.byIsland.size > 48 && !this.world.loaded.has(islandId)) this.byIsland.delete(islandId);
  }

  // --- queries other systems use -------------------------------------------

  /** @returns {object|undefined} the spawn set for an island */
  spawnsFor(islandId) { return this.byIsland.get(islandId); }

  /** Take everything queued for the enemy / npc / ship systems. */
  drain() {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /**
   * Hand an island's authored NPCs to the npc system as live actors. Called from step() so it
   * also covers islands that streamed in before app.npc existed (the start island loads during
   * game.js's spawn placement, before registration). Idempotent per island.
   */
  _spawnNpcs(islandId, set) {
    const npcSys = this.app && this.app.npc;
    if (!npcSys || typeof npcSys.spawn !== 'function') return;
    if (this._npcActors.has(islandId)) return;
    const live = [];
    for (const rec of set.npcs || []) {
      try {
        const n = npcSys.spawn(specForNpcKind(rec.kind, rec.id), {
          npcId: rec.id, kind: rec.kind,
          pos: [rec.x, rec.y, rec.z], yaw: rec.yaw || 0,
          home: [rec.x, rec.z],
        });
        live.push(n);
      } catch (e) {
        console.warn('[spawn] npc ' + rec.id + ': ' + e.message);
      }
    }
    this._npcActors.set(islandId, live);
  }

  _despawnNpcs(islandId) {
    const live = this._npcActors.get(islandId);
    if (!live) return;
    const npcSys = this.app && this.app.npc;
    for (const n of live) {
      try { if (npcSys && npcSys.despawn) npcSys.despawn(n); } catch {}
    }
    this._npcActors.delete(islandId);
  }

  /** Mark a camp or encounter defeated. Survives save/load. */
  markCleared(id) {
    this.cleared.add(id);
    this._removeProp(id);
  }

  /** @returns {object|null} the nearest unopened chest within `radius` */
  chestNear(x, z, radius = 3) {
    let best = null, bd = radius;
    for (const set of this.byIsland.values()) {
      for (const ch of set.chests) {
        if (this.openedChests.has(ch.id)) continue;
        const d = Math.hypot(ch.x - x, ch.z - z);
        if (d < bd) { bd = d; best = ch; }
      }
    }
    return best;
  }

  /**
   * Open a chest. Notifies QUEST, which owns what was inside.
   * @param {string} id @returns {boolean}
   */
  openChest(id) {
    if (this.openedChests.has(id)) return false;
    this.openedChests.add(id);
    this._removeProp(id);
    const q = this.app && (this.app.quests || this.app.quest);
    if (q && q.notify) q.notify('chestOpened', { id });
    if (this.app && this.app.audio && this.app.audio.play) this.app.audio.play('chest_open');
    return true;
  }

  /**
   * Take a quest pickup. Notifies QUEST with the itemId, which is what `collect` objectives
   * progress on. @param {string} id placement instance id @returns {boolean}
   */
  collectItem(id) {
    if (this.collectedItems.has(id)) return false;
    let found = null;
    for (const set of this.byIsland.values()) {
      for (const it of set.items || []) if (it.id === id) { found = it; break; }
      if (found) break;
    }
    if (!found) return false;
    this.collectedItems.add(id);
    this._removeProp(id);
    const q = this.app && (this.app.quests || this.app.quest);
    if (q && q.notify) q.notify('itemCollected', { itemId: found.itemId, count: 1 });
    if (this.app && this.app.audio && this.app.audio.play) this.app.audio.play('chest_open');
    if (this.app && this.app.ui && this.app.ui.toast) {
      this.app.ui.toast('Took the ' + (QUEST_ITEMS[found.itemId] || 'item'), 'good');
    }
    return true;
  }

  /**
   * Break a quest prop. Notifies QUEST with the propId, which is what `destroy` objectives
   * progress on; Navy property also raises the bounty (quest.js reads `marineProperty`).
   * @param {string} id placement instance id @returns {boolean}
   */
  destroyProp(id) {
    if (this.destroyedProps.has(id)) return false;
    let found = null;
    for (const set of this.byIsland.values()) {
      for (const pr of set.props || []) if (pr.id === id) { found = pr; break; }
      if (found) break;
    }
    if (!found) return false;
    this.destroyedProps.add(id);
    this._removeProp(id);
    const q = this.app && (this.app.quests || this.app.quest);
    if (q && q.notify) {
      q.notify('propDestroyed', {
        propId: found.propId,
        marineProperty: found.propId.indexOf('marine') >= 0 || found.propId.indexOf('cogHarbour') === 0,
      });
    }
    if (this.app && typeof this.app.impact === 'function') {
      this.app.impact({ pos: [found.x, found.y + 1.2, found.z], kind: 'blunt', strength: 1.2 });
    }
    return true;
  }

  /**
   * Everything the player could press E on right now: unopened chests, quest pickups and
   * quest props within `radius`. The Player's interact cone consults this through
   * `world.interactablesNear` (wired in src/game.js). Each entry carries pos/label/onInteract.
   * @returns {object[]}
   */
  interactablesNear(x, z, radius = 4) {
    const out = [];
    const r = radius + 1.5;   // props have real footprints; be a little generous
    for (const set of this.byIsland.values()) {
      for (const ch of set.chests) {
        if (this.openedChests.has(ch.id)) continue;
        if (Math.hypot(ch.x - x, ch.z - z) > r) continue;
        out.push({
          pos: { x: ch.x, y: ch.y, z: ch.z }, label: 'Open chest',
          onInteract: () => this.openChest(ch.id),
        });
      }
      for (const it of set.items || []) {
        if (this.collectedItems.has(it.id)) continue;
        if (Math.hypot(it.x - x, it.z - z) > r) continue;
        out.push({
          pos: { x: it.x, y: it.y, z: it.z },
          label: 'Take ' + (QUEST_ITEMS[it.itemId] || 'item'),
          // The machine-readable id rides along so consumers that need a SPECIFIC item (the
          // quest HUD marker, the playtest driver) do not have to parse the display label.
          itemId: it.itemId,
          onInteract: () => this.collectItem(it.id),
        });
      }
      for (const pr of set.props || []) {
        if (this.destroyedProps.has(pr.id)) continue;
        if (Math.hypot(pr.x - x, pr.z - z) > r) continue;
        out.push({
          pos: { x: pr.x, y: pr.y, z: pr.z },
          label: 'Destroy ' + (QUEST_PROPS[pr.propId] || 'prop'),
          onInteract: () => this.destroyProp(pr.id),
        });
      }
    }
    return out;
  }

  // --- system --------------------------------------------------------------

  step(dt, app) {
    const a = app || this.app;
    if (!this.world) {
      this.world = (a && a.world) || null;
      if (!this.world) return;                 // no World yet: nothing to populate, no error
      this._bindWorld();
    }
    this.time += dt;
    const f = this.world.focus;

    // Camps and patrols hand themselves to the combat system when you get close, and take
    // themselves back when you leave, so an island you are not on costs nothing.
    for (const [islandId, set] of this.byIsland) {
      // NPCs go live as soon as the npc system exists (it may register after the start island
      // streamed in). Only islands the streamer still holds get actors.
      if (this.world.loaded && this.world.loaded.has(islandId)) this._spawnNpcs(islandId, set);
      for (const camp of set.camps) {
        if (this.cleared.has(camp.id)) { camp.active = false; continue; }
        const d = Math.hypot(camp.x - f.x, camp.z - f.z);
        if (!camp.active && d < ACTIVATE_M) {
          camp.active = true;
          this._request({
            type: 'camp', id: camp.id, kind: camp.kind, count: camp.count,
            around: [camp.x, camp.z], radius: camp.radius, elite: camp.elite, tier: set.tier,
          }, a);
        } else if (camp.active && d > DEACTIVATE_M) {
          camp.active = false;
        }
      }
      for (const p of set.patrols) {
        if (this.cleared.has(p.id)) continue;
        const d = Math.hypot(p.route[0][0] - f.x, p.route[0][2] - f.z);
        if (!p.active && d < ACTIVATE_M) {
          p.active = true;
          this._request({
            type: 'patrol', id: p.id, kind: p.kind, count: p.count, route: p.route, tier: set.tier,
          }, a);
        } else if (p.active && d > DEACTIVATE_M) {
          p.active = false;
        }
      }
    }

    this._stepPatrolShips(dt, a);
  }

  _request(req, app) {
    this.pending.push(req);
    const e = app && app.enemies;
    if (!e) return;
    if (req.type === 'camp' && e.spawnWave) {
      e.spawnWave({ kind: req.kind, count: req.count, around: req.around, radius: req.radius });
    } else if (req.type === 'patrol' && e.spawnWave) {
      e.spawnWave({ kind: req.kind, count: req.count, around: [req.route[0][0], req.route[0][2]], radius: 10 });
    }
  }

  /**
   * Marine patrols at sea. Frequency is the bounty made physical: at a low bounty the sea is
   * empty, at Warlord tier you cannot cross a sector without meeting a Navy sail.
   */
  _stepPatrolShips(dt, app) {
    const q = app && (app.quests || app.quest);
    const bounty = q && q.bountyState ? q.bountyState() : null;
    const known = !!(bounty && bounty.marinePatrolChance !== undefined);
    const chance = known ? bounty.marinePatrolChance : 0.18;
    const tierBonus = bounty ? (bounty.spawnTierBonus || 0) : 0;
    // At a rookie bounty the Navy genuinely ignores you and the sea is empty — that is the
    // point of the scaling. The floor of one only applies while no quest system is present,
    // so the sea still has traffic before the bounty layer is wired in.
    const want = clamp(Math.round(chance * 6), known ? 0 : 1, 4);
    const f = this.world.focus;

    for (let i = this.patrols.length - 1; i >= 0; i--) {
      const p = this.patrols[i];
      p.t += dt;
      p.x += Math.sin(p.yaw) * p.speed * dt;
      p.z += Math.cos(p.yaw) * p.speed * dt;
      p.yaw += Math.sin(p.t * 0.07 + p.phase) * 0.02 * dt * 60;
      const d = Math.hypot(p.x - f.x, p.z - f.z);
      if (d > PATROL_RADIUS_M * 1.5 || this.cleared.has(p.id)) {
        this._removeProp(p.id);
        this.patrols.splice(i, 1);
      }
    }

    this.patrolTimer -= dt;
    if (this.patrolTimer > 0 || this.patrols.length >= want) return;
    // The gap between sails shortens as the bounty rises, so a high tier is felt as constant
    // pressure rather than as the same lonely patrol arriving slightly more often.
    this.patrolTimer = this.patrolRng.range(11, 30) / Math.max(1, want);
    if (this.world.islandAt(f.x, f.z)) return;         // never spawn a warship on a beach

    const ang = this.patrolRng.f() * TAU;
    const dist = this.patrolRng.range(PATROL_RADIUS_M * 0.75, PATROL_RADIUS_M);
    const x = f.x + Math.cos(ang) * dist;
    const z = f.z + Math.sin(ang) * dist;
    const p = {
      id: 'patrol_ship_' + (this.patrolSerial++),
      x, z, yaw: Math.atan2(f.x - x, f.z - z) + this.patrolRng.range(-0.5, 0.5),
      speed: this.patrolRng.range(4.5, 8.0),
      tier: clamp(1 + tierBonus, 1, 5),
      t: 0, phase: this.patrolRng.f() * TAU,
    };
    this.patrols.push(p);
    this.pending.push({ type: 'marineShip', id: p.id, x: p.x, z: p.z, yaw: p.yaw, tier: p.tier });
    if (app && app.ship && app.ship.spawnPatrol) app.ship.spawnPatrol(p);
    else this._addProp(p.id, 'patrol', p.x, 0, p.z, p.yaw);
  }

  /** Render-only: float the patrol hulls on the real wave surface. */
  preRender(alpha, app) {
    const a = app || this.app;
    const water = a && a.water;
    for (const p of this.patrols) {
      const node = this.props.get(p.id);
      if (!node) continue;
      node.position.x = p.x;
      node.position.z = p.z;
      node.rotation.y = p.yaw;
      if (!water || !water.heightAt) continue;
      const h = water.heightAt(p.x, p.z);
      node.position.y = h;
      const hf = water.heightAt(p.x + Math.sin(p.yaw) * 12, p.z + Math.cos(p.yaw) * 12);
      node.rotation.x = clamp((h - hf) * 0.05, -0.16, 0.16);
      node.rotation.z = clamp(Math.sin(this.time * 0.7 + p.phase) * 0.05, -0.12, 0.12);
    }
  }

  serialize() {
    return {
      cleared: [...this.cleared],
      chests: [...this.openedChests],
      items: [...this.collectedItems],
      props: [...this.destroyedProps],
      patrolRng: this.patrolRng.s,
    };
  }

  deserialize(o) {
    if (!o) return;
    this.cleared = new Set(o.cleared || []);
    this.openedChests = new Set(o.chests || []);
    this.collectedItems = new Set(o.items || []);
    this.destroyedProps = new Set(o.props || []);
    if (o.patrolRng) this.patrolRng.s = o.patrolRng >>> 0;
    // Anything already drawn that is now cleared or looted has to go.
    for (const id of this.cleared) this._removeProp(id);
    for (const id of this.openedChests) this._removeProp(id);
    for (const id of this.collectedItems) this._removeProp(id);
    for (const id of this.destroyedProps) this._removeProp(id);
  }

  report() {
    let camps = 0, chests = 0, npcs = 0, wildlife = 0, patrols = 0;
    for (const set of this.byIsland.values()) {
      camps += set.camps.length;
      chests += set.chests.length;
      npcs += set.npcs.length;
      wildlife += set.wildlife.length;
      patrols += set.patrols.length;
    }
    return {
      islands: this.byIsland.size, camps, chests, npcs, wildlife, patrols,
      marineShips: this.patrols.length,
      cleared: this.cleared.size, opened: this.openedChests.size,
      props: this.props.size,
    };
  }

  dispose() {
    for (const id of [...this.props.keys()]) this._removeProp(id);
    if (this.geo) {
      for (const key of Object.keys(this.geo)) {
        for (const bank of this.geo[key]) {
          if (bank.solid) bank.solid.dispose();
          if (bank.cutout) bank.cutout.dispose();
        }
      }
      this.geo = null;
    }
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
    this.group = null;
  }
}

/**
 * Factory used by src/game.js.
 * @param {object} app @param {object} opts must carry `world`
 * @returns {SpawnSystem}
 */
export function createSpawnSystem(app, opts = {}) {
  return new SpawnSystem(app, opts);
}

export default SpawnSystem;
