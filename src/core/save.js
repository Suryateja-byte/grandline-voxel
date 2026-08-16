// Save / load. Format is documented in ARCHITECTURE §7 and that document is the contract.
//
// Design rules:
//  - Never store anything reconstructible from the seed. The world is a pure function of the
//    seed, so a save is "the seed plus what the player changed".
//  - Forward compatible: unknown keys from a newer build survive a round trip untouched.
//  - Every system owns its own slice via serialize()/deserialize(). This file only orchestrates.

export const SAVE_VERSION = 1;
export const SLOT_COUNT = 3;
const KEY_PREFIX = 'glv.save.v1.slot';
const SETTINGS_KEY = 'glv.settings.v1';

/** Systems are saved in this order; unknown systems are skipped, missing ones ignored. */
const SLICES = [
  'player', 'ship', 'world', 'quests', 'fruit', 'combat', 'ui', 'audio', 'input',
];

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    // Probe: Safari private mode throws on setItem rather than on access.
    localStorage.setItem('glv.probe', '1');
    localStorage.removeItem('glv.probe');
    return localStorage;
  } catch {
    return null;
  }
}

/** In-memory fallback so headless runs and locked-down browsers still work. */
const memory = new Map();

function read(key) {
  const s = storage();
  if (s) { const v = s.getItem(key); return v === null ? undefined : v; }
  return memory.get(key);
}

function write(key, value) {
  const s = storage();
  if (s) { s.setItem(key, value); return true; }
  memory.set(key, value);
  return true;
}

function remove(key) {
  const s = storage();
  if (s) s.removeItem(key); else memory.delete(key);
}

export class SaveSystem {
  constructor(app) {
    this.app = app;
    this.lastSavedStep = -1;
    this.autosaveEverySteps = 60 * 90;   // ~90s of simulated time
    this.autosaveSlot = 0;
    this.enabled = true;
    /** Set by the UI so a manual save can report success. */
    this.onSaved = null;
  }

  slotKey(slot) { return `${KEY_PREFIX}${slot}`; }

  /** Build the save object. Pure — safe to call at any point in a step. */
  capture(app) {
    const a = app || this.app;
    const data = {
      v: SAVE_VERSION,
      seed: a.seed,
      simTime: +a.clock.simTime.toFixed(3),
      step: a.clock.step,
      dayT: +a.dayT.toFixed(6),
      weather: { key: a.weatherKey, next: a.weatherNext, blend: +a.weatherBlend.toFixed(4) },
      systems: {},
      meta: {
        // Everything here is for the load menu only. Never read back into the simulation.
        island: a.world && a.world.nearestIsland ? nameOfNearest(a) : 'Open sea',
        bounty: a.quests && a.quests.bountyState ? a.quests.bountyState().total : 0,
        level: a.player ? a.player.level || 1 : 1,
        crew: a.quests && a.quests.crew ? a.quests.crew().length : 0,
        playSteps: a.clock.step,
      },
    };
    for (const name of SLICES) {
      const sys = a[name];
      if (sys && typeof sys.serialize === 'function') {
        const slice = sys.serialize();
        if (slice !== undefined) data.systems[name] = slice;
      }
    }
    // Preserve anything a newer build wrote that this build does not know about.
    if (this._unknown) data.__unknown = this._unknown;
    return data;
  }

  /** Apply a save object to the live app. Order matters: world before things that stand on it. */
  apply(data, app) {
    const a = app || this.app;
    if (!data || typeof data !== 'object') throw new Error('save: not an object');
    if (data.v !== SAVE_VERSION) throw new Error(`save: version ${data.v}, expected ${SAVE_VERSION}`);
    if (data.seed !== a.seed) {
      // The world IS the seed. Loading a different seed means rebuilding the world, which the
      // caller must do by booting with that seed; refusing here prevents a silently wrong world.
      throw new Error(`save: seed mismatch (save ${data.seed}, running ${a.seed})`);
    }
    a.clock.simTime = data.simTime || 0;
    a.clock.step = data.step || 0;
    a.dayT = data.dayT !== undefined ? data.dayT : a.dayT;
    if (data.weather) {
      a.weatherKey = data.weather.key || 'clear';
      a.weatherNext = data.weather.next || a.weatherKey;
      a.weatherBlend = data.weather.blend !== undefined ? data.weather.blend : 1;
      a.sky.setWeatherBlend(a.weatherKey, a.weatherNext, a.weatherBlend);
    }
    // Water time is derived from sim time so waves resume in the same phase — otherwise the ship
    // teleports vertically on load.
    if (a.water) a.water.time = a.clock.simTime;

    const sys = data.systems || {};
    const order = ['world', 'quests', 'fruit', 'player', 'ship', 'combat', 'ui', 'audio', 'input'];
    for (const name of order) {
      const s = a[name];
      if (s && typeof s.deserialize === 'function' && sys[name] !== undefined) {
        s.deserialize(sys[name]);
      }
    }
    this._unknown = data.__unknown;
    this.lastSavedStep = a.clock.step;
    return true;
  }

  save(slot = 0, app) {
    const data = this.capture(app);
    const json = JSON.stringify(data);
    write(this.slotKey(slot), json);
    this.lastSavedStep = (app || this.app).clock.step;
    if (this.onSaved) this.onSaved(slot, json.length);
    return { slot, bytes: json.length };
  }

  load(slot = 0, app) {
    const raw = read(this.slotKey(slot));
    if (raw === undefined) return false;
    const data = JSON.parse(raw);
    this.apply(data, app);
    return true;
  }

  has(slot) { return read(this.slotKey(slot)) !== undefined; }

  /** Metadata for the load menu, without applying anything. */
  slotInfo(slot) {
    const raw = read(this.slotKey(slot));
    if (raw === undefined) return null;
    try {
      const d = JSON.parse(raw);
      return {
        slot,
        seed: d.seed,
        simTime: d.simTime,
        bytes: raw.length,
        island: d.meta ? d.meta.island : 'Unknown',
        bounty: d.meta ? d.meta.bounty : 0,
        level: d.meta ? d.meta.level : 1,
        crew: d.meta ? d.meta.crew : 0,
      };
    } catch {
      return { slot, corrupt: true };
    }
  }

  allSlots() {
    const out = [];
    for (let i = 0; i < SLOT_COUNT; i++) out.push(this.slotInfo(i));
    return out;
  }

  erase(slot) { remove(this.slotKey(slot)); }

  /** Settings live outside the save slots so they survive a new game. */
  saveSettings(obj) { write(SETTINGS_KEY, JSON.stringify(obj)); }
  loadSettings() {
    const raw = read(SETTINGS_KEY);
    if (raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** Autosave is driven from the fixed step, so it is deterministic and never uses wall time. */
  step(dt, app) {
    if (!this.enabled) return;
    const a = app || this.app;
    if (a.clock.step - this.lastSavedStep >= this.autosaveEverySteps) {
      // Never autosave mid-combat or mid-cutscene-ish state: reloading into a swing feels broken.
      if (a.combat && a.combat.encounterState && a.combat.encounterState().active) return;
      this.save(this.autosaveSlot, a);
    }
  }

  /** Round-trip check used by tools/check-save.mjs and the playtest. */
  verifyRoundTrip(app) {
    const a = app || this.app;
    const before = JSON.stringify(this.capture(a));
    this.apply(JSON.parse(before), a);
    const after = JSON.stringify(this.capture(a));
    return { ok: before === after, beforeBytes: before.length, afterBytes: after.length };
  }
}

function nameOfNearest(a) {
  try {
    const p = a.player ? a.player.pos : a.camera.position;
    const isl = a.world.nearestIsland(p.x, p.z);
    if (!isl) return 'Open sea';
    const d = Math.hypot(p.x - isl.x, p.z - isl.z);
    return d < (isl.radius || 200) * 1.4 ? (isl.name || isl.id) : 'Open sea';
  } catch {
    return 'Open sea';
  }
}

export function createSaveSystem(app) {
  return new SaveSystem(app);
}
