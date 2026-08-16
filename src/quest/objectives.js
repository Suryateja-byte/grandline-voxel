// Objective kinds — the atoms every quest step is built from.
//
// An objective is a plain data *spec* (authored in quests.js) plus a small mutable *state*
// created at runtime. Specs are frozen shared data: two saves on the same quest read the same
// spec object, so per-player progress must never be stored on it.
//
// Progress only ever moves through `applyEvent()` (driven by QuestSystem.notify) or, for the
// one genuinely time-based kind, `tickObjective()`. Nothing here reads the world directly:
// that keeps quest logic testable headlessly and keeps the sim step deterministic.

import { clamp01 } from '../core/math.js';

/** Canonical objective kind names. Saves store these strings, so treat them as public API. */
export const OBJ = {
  GOTO: 'goto',
  DEFEAT: 'defeat',
  DEFEAT_BOSS: 'defeatBoss',
  TALK: 'talk',
  COLLECT: 'collect',
  DELIVER: 'deliver',
  SURVIVE: 'survive',
  ESCORT: 'escort',
  USE_FRUIT: 'useFruit',
  SAIL_TO: 'sailTo',
  FIND_SECRET: 'findSecret',
  OPEN_CHEST: 'openChest',
  WIN_WITHOUT_DAMAGE: 'winWithoutDamage',
  DESTROY: 'destroy',
};

/** Human names for the spawn points every island exposes (ARCHITECTURE §9 vocabulary). */
const POINT_LABELS = {
  dock: 'the dock',
  plaza: 'the plaza',
  boss_arena: 'the arena',
  vista: 'the lookout',
  secret: 'the hidden place',
  npc_1: 'the first waypoint',
  npc_2: 'the second waypoint',
  npc_3: 'the third waypoint',
  npc_4: 'the fourth waypoint',
  chest_1: 'the first cache',
  chest_2: 'the second cache',
  chest_3: 'the third cache',
};

/** Turns a dotted point id into readable text. Falls back to the tail so nothing reads as debug. */
function pointLabel(point) {
  const tail = String(point).split('.').pop();
  return POINT_LABELS[tail] || tail.replace(/_/g, ' ');
}

/** Enemy kinds are snake_case by convention; pluralise for counted objectives. */
function enemyLabel(kind, n) {
  const base = String(kind).replace(/_/g, ' ');
  return n === 1 ? base : base + 's';
}

function itemLabel(itemId) {
  return String(itemId).split('.').pop().replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Kind table. Each entry: which notify events it listens to, how it folds them
// into state, and how it reads out. `tick` is optional and only survive uses it.
// ---------------------------------------------------------------------------

const KINDS = {};

function defKind(kind, def) {
  KINDS[kind] = Object.assign({ kind, events: [], tick: null }, def);
  return KINDS[kind];
}

defKind(OBJ.GOTO, {
  events: ['areaEntered'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    const where = data.point !== undefined ? data.point : data.area;
    if (where !== spec.point) return false;
    // The world may report a distance; if it does, honour the authored radius.
    if (typeof data.dist === 'number' && data.dist > spec.radius) return false;
    if (state.done) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Go to ' + pointLabel(spec.point),
});

defKind(OBJ.DEFEAT, {
  events: ['enemyDefeated'],
  init: () => ({ n: 0 }),
  target: (spec) => spec.count,
  current: (s) => s.n,
  on(spec, state, ev, data) {
    // Exact kind, or the family the kill reports ('thug' counts thug_brute). See notifyDefeat.
    const match = spec.enemyKind === 'any' || data.kind === spec.enemyKind || data.family === spec.enemyKind;
    if (!match) return false;
    if (spec.at && data.at !== spec.at) return false;
    if (state.n >= spec.count) return false;
    state.n = Math.min(spec.count, state.n + (data.count || 1));
    return true;
  },
  text: (spec) => 'Defeat ' + spec.count + ' ' + enemyLabel(spec.enemyKind, spec.count),
});

defKind(OBJ.DEFEAT_BOSS, {
  events: ['bossDefeated'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (data.id !== spec.bossId || state.done) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Defeat ' + (spec.bossName || itemLabel(spec.bossId)),
});

defKind(OBJ.TALK, {
  events: ['npcTalked'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (data.npcId !== spec.npcId || state.done) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Speak with ' + (spec.npcName || itemLabel(spec.npcId)),
});

defKind(OBJ.COLLECT, {
  events: ['itemCollected'],
  init: () => ({ n: 0 }),
  target: (spec) => spec.count,
  current: (s) => s.n,
  on(spec, state, ev, data) {
    if (data.itemId !== spec.itemId || state.n >= spec.count) return false;
    state.n = Math.min(spec.count, state.n + (data.count || 1));
    return true;
  },
  text: (spec) => 'Collect ' + spec.count + ' ' + itemLabel(spec.itemId),
});

defKind(OBJ.DELIVER, {
  events: ['npcTalked'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (data.npcId !== spec.npcId || state.done) return false;
    // Accept either an explicit hand-over or a carried-inventory snapshot.
    const explicit = data.deliver === spec.itemId;
    const carried = Array.isArray(data.carrying) && data.carrying.indexOf(spec.itemId) >= 0;
    if (!explicit && !carried) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Bring the ' + itemLabel(spec.itemId) + ' to ' + (spec.npcName || itemLabel(spec.npcId)),
});

defKind(OBJ.SURVIVE, {
  // The only time-driven kind. QuestSystem.step() advances it while its step is current.
  events: ['damageTaken'],
  init: () => ({ t: 0 }),
  target: (spec) => spec.seconds,
  current: (s) => s.t,
  tick(spec, state, dt) {
    if (state.t >= spec.seconds) return false;
    state.t = Math.min(spec.seconds, state.t + dt);
    return true;
  },
  on(spec, state, ev, data) {
    // Flawless variants restart the clock the moment the player is clipped.
    if (!spec.flawless || state.t <= 0) return false;
    if (spec.fightId && data.fightId !== spec.fightId) return false;
    state.t = 0;
    return true;
  },
  text: (spec) => 'Survive ' + Math.round(spec.seconds) + 's' + (spec.flawless ? ' without being hit' : ''),
  format: (v) => Math.floor(v) + 's',
});

defKind(OBJ.ESCORT, {
  events: ['areaEntered'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (state.done) return false;
    if (data.npcId !== spec.npcId || data.point !== spec.point) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Escort ' + (spec.npcName || itemLabel(spec.npcId)) + ' to ' + pointLabel(spec.point),
});

defKind(OBJ.USE_FRUIT, {
  events: ['fruitUsed'],
  init: () => ({ n: 0 }),
  target: (spec) => spec.times,
  current: (s) => s.n,
  on(spec, state, ev, data) {
    if (data.fruitId !== spec.fruitId || state.n >= spec.times) return false;
    if (spec.move && data.move !== spec.move) return false;
    state.n = Math.min(spec.times, state.n + 1);
    return true;
  },
  text: (spec) => 'Use the ' + spec.fruitId + ' power ' + spec.times + (spec.times === 1 ? ' time' : ' times'),
});

defKind(OBJ.SAIL_TO, {
  events: ['islandDocked'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (data.islandId !== spec.islandId || state.done) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Sail to ' + (spec.islandName || spec.islandId),
});

defKind(OBJ.FIND_SECRET, {
  events: ['areaEntered'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (state.done) return false;
    if (data.secret !== spec.secretId && data.point !== spec.secretId) return false;
    state.done = true;
    return true;
  },
  text: (spec) => spec.hint || 'Find what is hidden at ' + pointLabel(spec.secretId),
});

defKind(OBJ.OPEN_CHEST, {
  events: ['chestOpened'],
  init: () => ({ done: false }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    const id = data.id !== undefined ? data.id : data.chestId;
    if (id !== spec.chestId || state.done) return false;
    state.done = true;
    return true;
  },
  text: (spec) => 'Open the chest at ' + pointLabel(spec.chestId),
});

defKind(OBJ.WIN_WITHOUT_DAMAGE, {
  events: ['damageTaken', 'enemyDefeated', 'bossDefeated'],
  init: () => ({ done: false, clean: true }),
  target: () => 1,
  current: (s) => (s.done ? 1 : 0),
  on(spec, state, ev, data) {
    if (data.fightId !== spec.fightId || state.done) return false;
    if (ev === 'damageTaken') {
      if (!state.clean) return false;
      state.clean = false;
      return true;
    }
    // A restarted fight wipes the slate — otherwise one bad attempt soft-locks the quest.
    if (data.restart) { state.clean = true; return true; }
    if (!state.clean) return false;
    state.done = true;
    return true;
  },
  text: (spec) => (spec.hint || 'Win the fight') + ' without taking a hit',
});

defKind(OBJ.DESTROY, {
  events: ['propDestroyed'],
  init: () => ({ n: 0 }),
  target: (spec) => spec.count,
  current: (s) => s.n,
  on(spec, state, ev, data) {
    if (data.propId !== spec.propId || state.n >= spec.count) return false;
    state.n = Math.min(spec.count, state.n + (data.count || 1));
    return true;
  },
  text: (spec) => 'Destroy ' + spec.count + ' ' + itemLabel(spec.propId) + (spec.count === 1 ? '' : 's'),
});

// ---------------------------------------------------------------------------
// Spec factories. Authoring in quests.js reads as prose because of these.
// Every factory takes an optional trailing `label` that overrides the generated text.
// ---------------------------------------------------------------------------

const finish = (spec, label) => {
  if (label) spec.label = label;
  return Object.freeze(spec);
};

/** Stand within `radius` metres of a named spawn point. @returns {object} objective spec */
export const goto = (point, radius = 6, label) => finish({ type: OBJ.GOTO, point, radius }, label);
/** Defeat `count` enemies of `enemyKind` ('any' matches all). @returns {object} */
export const defeat = (enemyKind, count = 1, label) => finish({ type: OBJ.DEFEAT, enemyKind, count }, label);
/** Defeat a named boss encounter. @returns {object} */
export const defeatBoss = (bossId, bossName, label) => finish({ type: OBJ.DEFEAT_BOSS, bossId, bossName }, label);
/** Hold a conversation with an npc. @returns {object} */
export const talk = (npcId, npcName, label) => finish({ type: OBJ.TALK, npcId, npcName }, label);
/** Pick up `count` of an item. @returns {object} */
export const collect = (itemId, count = 1, label) => finish({ type: OBJ.COLLECT, itemId, count }, label);
/** Hand an item to an npc. @returns {object} */
export const deliver = (itemId, npcId, npcName, label) => finish({ type: OBJ.DELIVER, itemId, npcId, npcName }, label);
/** Stay alive for `seconds`; `opts.flawless` restarts the clock on any hit. @returns {object} */
export const survive = (seconds, opts = {}, label) =>
  finish({ type: OBJ.SURVIVE, seconds, flawless: !!opts.flawless, fightId: opts.fightId || null }, label);
/** Keep an npc alive until it reaches a point. @returns {object} */
export const escort = (npcId, point, npcName, label) => finish({ type: OBJ.ESCORT, npcId, point, npcName }, label);
/** Use a devil fruit power `times` (optionally one specific move). @returns {object} */
export const useFruit = (fruitId, times = 1, opts = {}, label) =>
  finish({ type: OBJ.USE_FRUIT, fruitId, times, move: opts.move || null }, label);
/** Dock at a named island. @returns {object} */
export const sailTo = (islandId, islandName, label) => finish({ type: OBJ.SAIL_TO, islandId, islandName }, label);
/** Discover a hidden location. @returns {object} */
export const findSecret = (secretId, hint, label) => finish({ type: OBJ.FIND_SECRET, secretId, hint }, label);
/** Open a specific chest. @returns {object} */
export const openChest = (chestId, label) => finish({ type: OBJ.OPEN_CHEST, chestId }, label);
/** Clear a named fight without taking a hit inside it. @returns {object} */
export const winWithoutDamage = (fightId, hint, label) => finish({ type: OBJ.WIN_WITHOUT_DAMAGE, fightId, hint }, label);
/** Break `count` world props of a given kind. @returns {object} */
export const destroy = (propId, count = 1, label) => finish({ type: OBJ.DESTROY, propId, count }, label);

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** All notify() event names any objective kind listens to. */
export const OBJECTIVE_EVENTS = (() => {
  const s = new Set();
  for (const k of Object.keys(KINDS)) for (const e of KINDS[k].events) s.add(e);
  return Object.freeze(Array.from(s).sort());
})();

/** Does this objective kind need a per-step tick? @returns {boolean} */
export function objectiveIsTimed(spec) {
  const k = KINDS[spec.type];
  return !!(k && k.tick);
}

/** Create a fresh mutable state for an objective spec. @returns {object} */
export function initObjectiveState(spec) {
  const k = KINDS[spec.type];
  if (!k) throw new Error('unknown objective type: ' + spec.type);
  return k.init(spec);
}

/**
 * Fold one notify event into an objective's state.
 * @returns {boolean} true if the state changed — callers use this to fire UI feedback.
 */
export function applyEvent(spec, state, event, data, ctx) {
  const k = KINDS[spec.type];
  if (!k || k.events.indexOf(event) < 0) return false;
  return !!k.on(spec, state, event, data || {}, ctx);
}

/** Advance a time-based objective. No-op for every other kind. @returns {boolean} changed */
export function tickObjective(spec, state, dt) {
  const k = KINDS[spec.type];
  if (!k || !k.tick) return false;
  return !!k.tick(spec, state, dt);
}

/** Is this objective satisfied? @returns {boolean} */
export function objectiveDone(spec, state) {
  const k = KINDS[spec.type];
  return k.current(state) >= k.target(spec);
}

/**
 * Readout for the HUD and the quest log.
 * @returns {{type:string,current:number,target:number,ratio:number,done:boolean,text:string,readout:string}}
 */
export function objectiveProgress(spec, state) {
  const k = KINDS[spec.type];
  const target = k.target(spec);
  const current = k.current(state);
  const done = current >= target;
  const fmt = k.format || ((v) => String(Math.floor(v)));
  const text = spec.label || k.text(spec, state);
  // Binary objectives read as a tick, counted ones as "3 / 5". Never "1 / 1".
  const readout = target <= 1 ? (done ? 'done' : '') : fmt(current) + ' / ' + fmt(target);
  return {
    type: spec.type, current, target, ratio: clamp01(target ? current / target : 1), done, text, readout,
    // Identity fields, passed through verbatim. Consumers that need to point AT the objective —
    // the HUD's compass marker and the scripted playtest's navigator — resolve these against
    // the world (spawn points, npc ids, item ids). Without them the view says "go to the dock"
    // but nothing downstream can know where the dock IS, which left the playtest driver pacing
    // in circles for its whole 300 s budget.
    point: spec.point, radius: spec.radius, enemyKind: spec.enemyKind, bossId: spec.bossId,
    npcId: spec.npcId, npcName: spec.npcName, itemId: spec.itemId, islandId: spec.islandId,
    secretId: spec.secretId, chestId: spec.chestId, fightId: spec.fightId,
    propId: spec.propId, fruitId: spec.fruitId,
  };
}

/** Serialise objective state compactly — only the fields that are not derivable. */
export function serializeObjective(spec, state) {
  const k = KINDS[spec.type];
  if (k.tick) return { t: Math.round(state.t * 100) / 100 };
  if (spec.type === OBJ.WIN_WITHOUT_DAMAGE) return { done: state.done, clean: state.clean };
  if (state.n !== undefined) return { n: state.n };
  return { done: !!state.done };
}

/** Restore objective state, tolerating specs that changed shape between builds. */
export function deserializeObjective(spec, raw) {
  const state = initObjectiveState(spec);
  if (!raw) return state;
  if (state.t !== undefined && typeof raw.t === 'number') state.t = raw.t;
  if (state.n !== undefined && typeof raw.n === 'number') state.n = raw.n;
  if (state.done !== undefined && typeof raw.done === 'boolean') state.done = raw.done;
  if (state.clean !== undefined && typeof raw.clean === 'boolean') state.clean = raw.clean;
  return state;
}

/** The notify events a given objective kind consumes. @returns {string[]} */
export function eventsForKind(type) {
  return KINDS[type] ? KINDS[type].events.slice() : [];
}
