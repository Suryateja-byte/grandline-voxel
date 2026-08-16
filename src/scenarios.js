// Profiling scenarios: scripted play sessions that put the engine under a named, repeatable
// load. One scenario per thing that can plausibly go wrong at runtime.
//
// A scenario is deterministic by construction: `input(t, api)` is called once per FIXED step
// with the scenario's elapsed simulation time, so the same scenario at the same seed produces
// the same button presses on a 30fps machine and a 300fps machine alike.
//
// Input is injected as REAL DOM events at the same targets a human's keyboard and mouse hit —
// never by calling game functions. If the scenario can drive the game, so can a player, and a
// perf number measured through a side door is not a perf number.
//
// The player/ship/combat systems are built in parallel with this file. Every scenario therefore
// (a) declares what it `requires`, (b) guards every setup hook, and (c) supplies a scripted
// `camera` fallback so the renderer is still profiled under motion while those systems are
// missing. When the systems land, the fallbacks stop being used with no edit here.

import { Rng } from './core/rng.js';
import { clamp, lerp } from './core/math.js';

// ---------------------------------------------------------------------------------------
// Bindings — the contract with src/core/input.js (see ARCHITECTURE §9).
// ---------------------------------------------------------------------------------------

/**
 * Action -> physical control. Scenarios and the playtest name actions, never key codes, so a
 * rebind is one edit here. On foot and aboard ship share the movement keys deliberately: a
 * player should never have to learn a second set of controls to sail.
 * @type {Record<string, {type:'key', code:string}|{type:'mouse', button:number}>}
 */
export const BINDINGS = {
  // Codes MUST match DEFAULT_BINDS in src/core/input.js — these synthesise the events a real
  // keyboard would send, so a drifted code here silently presses the wrong game action
  // (dodge used to send ShiftLeft, which the game reads as sprint).
  moveForward: { type: 'key', code: 'KeyW' },   // aboard ship: raise sail
  moveBack: { type: 'key', code: 'KeyS' },      // aboard ship: reef sail
  moveLeft: { type: 'key', code: 'KeyA' },      // aboard ship: steer to port
  moveRight: { type: 'key', code: 'KeyD' },     // aboard ship: steer to starboard
  jump: { type: 'key', code: 'Space' },
  sprint: { type: 'key', code: 'ShiftLeft' },
  dodge: { type: 'key', code: 'KeyC' },
  block: { type: 'key', code: 'KeyQ' },
  interact: { type: 'key', code: 'KeyE' },      // board, dock, talk, accept quest, open chest
  fruitPower: { type: 'key', code: 'Digit1' },
  fruitPower2: { type: 'key', code: 'Digit2' },
  fruitPower3: { type: 'key', code: 'Digit3' },
  fruitAlt: { type: 'key', code: 'KeyX' },      // swap fruit
  sailUp: { type: 'key', code: 'KeyR' },
  sailDown: { type: 'key', code: 'KeyF' },
  anchor: { type: 'key', code: 'KeyG' },
  lockOn: { type: 'key', code: 'KeyT' },
  questLog: { type: 'key', code: 'KeyJ' },
  map: { type: 'key', code: 'KeyM' },
  pause: { type: 'key', code: 'Escape' },
  confirm: { type: 'key', code: 'Enter' },
  lightAttack: { type: 'mouse', button: 0 },
  heavyAttack: { type: 'mouse', button: 2 },
};

/** Keyboard `key` values for the codes we bind, so synthesised events look real. */
const KEY_VALUE = {
  KeyW: 'w', KeyS: 's', KeyA: 'a', KeyD: 'd', KeyQ: 'q', KeyR: 'r', KeyE: 'e',
  KeyC: 'c', KeyF: 'f', KeyG: 'g', KeyT: 't', KeyX: 'x', KeyH: 'h',
  Digit1: '1', Digit2: '2', Digit3: '3',
  KeyJ: 'j', KeyM: 'm', Space: ' ', ShiftLeft: 'Shift', Escape: 'Escape', Enter: 'Enter',
};

/**
 * Synthesises real input events.
 *
 * Events are dispatched at the canvas and allowed to bubble, so a listener on the canvas, the
 * document or the window all see them — whichever the input layer chooses. Nothing here
 * touches game state directly.
 *
 * @param {HTMLElement} target the game canvas
 * @param {{pointerEvents?:boolean}} [opts] dispatch PointerEvents instead of MouseEvents
 * @returns {object} the api handed to `scenario.input(t, api)`
 */
export function createInputApi(target, opts = {}) {
  const pointer = !!opts.pointerEvents;
  const down = new Set();
  const timed = new Map(); // action -> seconds of hold remaining
  let cursorX = Math.floor((target && target.width ? target.width : 1920) / 2);
  let cursorY = Math.floor((target && target.height ? target.height : 1080) / 2);
  const log = [];

  const fire = (ev) => { (target || window).dispatchEvent(ev); };

  function keyEvent(type, code, repeat) {
    return new KeyboardEvent(type, {
      code, key: KEY_VALUE[code] || code, repeat: !!repeat,
      bubbles: true, cancelable: true, composed: true,
      shiftKey: down.has('sprint'), view: window,
    });
  }

  function mouseEvent(type, button, dx, dy) {
    const Ctor = pointer && type !== 'contextmenu' ? PointerEvent : MouseEvent;
    const init = {
      button, buttons: buttonMask(), clientX: cursorX, clientY: cursorY,
      movementX: dx || 0, movementY: dy || 0,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    if (Ctor === PointerEvent) { init.pointerId = 1; init.pointerType = 'mouse'; init.isPrimary = true; }
    return new Ctor(type, init);
  }

  function buttonMask() {
    let m = 0;
    if (down.has('lightAttack')) m |= 1;
    if (down.has('heavyAttack')) m |= 2;
    return m;
  }

  const api = {
    /** Actions currently held. Read-only to scenarios; useful for edge-triggered scripts. */
    down,
    /**
     * Recent input edges, capped. A 20-minute memory-stability run must not fail because the
     * harness's own diagnostic log grew — the instrument may not be the leak it measures.
     */
    log,
    target,

    /** Press an action if it is not already held. Idempotent — safe to call every step. */
    press(action) { api.set(action, true); },
    /** Release an action if it is held. Idempotent. */
    release(action) { api.set(action, false); },

    /**
     * Drive an action to a state. Only edges dispatch events, exactly like a real key.
     * @param {string} action a key of BINDINGS
     * @param {boolean} wanted
     */
    set(action, wanted) {
      const b = BINDINGS[action];
      if (!b) throw new Error('unknown action: ' + action);
      const has = down.has(action);
      if (wanted === has) return;
      if (wanted) down.add(action); else down.delete(action);
      if (b.type === 'key') {
        fire(keyEvent(wanted ? 'keydown' : 'keyup', b.code, false));
      } else {
        const t = pointer ? (wanted ? 'pointerdown' : 'pointerup') : (wanted ? 'mousedown' : 'mouseup');
        fire(mouseEvent(t, b.button, 0, 0));
        // A real right-click also raises contextmenu; the game must be able to swallow it.
        if (b.button === 2 && wanted) fire(mouseEvent('contextmenu', 2, 0, 0));
      }
      log.push({ action, down: wanted });
      if (log.length > 4096) log.splice(0, log.length - 4096);
    },

    /** Hold an action for `seconds`, released automatically by `tick`. */
    hold(action, seconds) {
      api.set(action, true);
      timed.set(action, Math.max(timed.get(action) || 0, seconds));
    },

    /** Press and release across a single step — the scripted equivalent of a tap. */
    tap(action) { api.hold(action, 1 / 30); },

    /** Relative look, in the same units a mouse reports under pointer lock. */
    look(dx, dy) {
      if (!dx && !dy) return;
      cursorX = clamp(cursorX + dx, 0, (target && target.width) || 1920);
      cursorY = clamp(cursorY + dy, 0, (target && target.height) || 1080);
      fire(mouseEvent(pointer ? 'pointermove' : 'mousemove', 0, dx, dy));
    },

    /** Wheel notch, for camera zoom / weapon cycling. */
    wheel(dy) {
      fire(new WheelEvent('wheel', {
        deltaY: dy, clientX: cursorX, clientY: cursorY,
        bubbles: true, cancelable: true, composed: true, view: window,
      }));
    },

    /** Advance auto-release timers. The driver calls this once per fixed step, after input(). */
    tick(dt) {
      for (const [action, left] of timed) {
        const n = left - dt;
        if (n <= 0) { timed.delete(action); api.set(action, false); }
        else timed.set(action, n);
      }
    },

    /** Release everything. Always called when a scenario ends so state cannot leak. */
    releaseAll() {
      timed.clear();
      for (const a of [...down]) api.set(a, false);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------
// Setup helpers — every one degrades to a no-op until its owner's system lands.
// ---------------------------------------------------------------------------------------

/** Which of `names` are not registered on the app yet. */
export function missingSystems(app, names) {
  return (names || []).filter(n => !app[n]);
}

/** Call `app[sys][fn](...args)` if it exists. Returns the result, or undefined. */
function tryCall(app, sys, fn, ...args) {
  const s = app[sys];
  if (s && typeof s[fn] === 'function') return s[fn](...args);
  return undefined;
}

/** Point the camera at a target from a position. Used by the scripted fallback flythroughs. */
function look(app, px, py, pz, tx, ty, tz) {
  app.camera.position.set(px, py, pz);
  app.camera.lookAt(tx, ty, tz);
}

/**
 * A slow orbit that keeps the frame moving when no player system owns the camera yet.
 * Motion matters: a static camera hides culling and streaming cost, which is exactly the cost
 * a profile is supposed to find.
 */
function orbit(app, t, cx, cz, radius, height, speed) {
  const a = t * speed;
  look(app, cx + Math.cos(a) * radius, height, cz + Math.sin(a) * radius, cx, height * 0.35, cz);
}

/** Where the world says the first island is, or a fixed fallback so scenarios still run. */
function firstIsland(app) {
  const w = app.world;
  if (w && typeof w.firstIsland === 'function') {
    const i = w.firstIsland();
    if (i) return i;
  }
  if (w && typeof w.nearestIsland === 'function') {
    const i = w.nearestIsland(0, 0);
    if (i) return i;
  }
  return { id: 'unknown', x: 520, z: -380, dockX: 496, dockZ: -356 };
}

// ---------------------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------------------

/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} desc         what this scenario is trying to break
 * @property {number} seconds      default run length
 * @property {string[]} requires   systems needed to run it for real
 * @property {(app:any)=>void} setup
 * @property {(t:number, api:object)=>void} input   called once per fixed step
 * @property {(t:number, app:any)=>void} [camera]   fallback only, while no player owns the camera
 */

/** @type {Scenario[]} */
export const SCENARIOS = [
  {
    id: 'sail-open-sea',
    desc: 'Full sail across empty ocean. The floor of the frame budget: water, sky and nothing '
      + 'to hide behind. If this is not comfortably under budget, nothing else can be.',
    seconds: 30,
    requires: ['ship', 'player'],
    setup(app) {
      app.dayT = 0.44;
      app.setWeather('breezy', true);
      tryCall(app, 'ship', 'teleport', 0, 0, 0, 0.6);
      tryCall(app, 'player', 'boardShip');
      app.simulate(2);
    },
    input(t, api) {
      api.set('moveForward', true);                    // sail pinned open
      api.set('moveLeft', Math.sin(t * 0.21) > 0.55);   // long, lazy course corrections
      api.set('moveRight', Math.sin(t * 0.21) < -0.55);
      api.look(Math.sin(t * 0.37) * 2.2, Math.sin(t * 0.11) * 0.5);
    },
    camera(t, app) {
      const speed = 7.5;
      const x = t * speed * 0.6, z = -t * speed;
      look(app, x, 8.5, z, x + 30, 3.5 + Math.sin(t * 0.4) * 1.5, z - 60);
    },
  },

  {
    id: 'sail-approach-island',
    desc: 'Sailing an island up over the horizon. The chunk streamer has to build terrain, props '
      + 'and foliage while the frame is already busy — the classic source of a one-second hitch.',
    seconds: 30,
    requires: ['ship', 'player', 'world'],
    setup(app) {
      app.dayT = 0.32;
      app.setWeather('clear', true);
      const isl = firstIsland(app);
      this._isl = isl;
      // Start far enough out that the island is entirely unstreamed at t=0.
      const d = 520;
      const ang = Math.atan2(isl.x, isl.z);
      tryCall(app, 'ship', 'teleport', isl.x - Math.sin(ang) * d, 0, isl.z - Math.cos(ang) * d, ang);
      tryCall(app, 'player', 'boardShip');
      app.simulate(1);
    },
    input(t, api) {
      api.set('moveForward', true);
      api.set('moveLeft', Math.sin(t * 0.5) > 0.8);
      api.set('moveRight', Math.sin(t * 0.5) < -0.8);
      api.look(Math.sin(t * 0.6) * 3.0, 0);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      const d = lerp(520, 90, clamp(t / 28, 0, 1));
      const ang = Math.atan2(isl.x, isl.z);
      const x = isl.x - Math.sin(ang) * d, z = isl.z - Math.cos(ang) * d;
      look(app, x, 9, z, isl.x, 6, isl.z);
    },
  },

  {
    id: 'dock-and-walk',
    desc: 'Dock, disembark and walk inland. Exercises the handover from ship physics to character '
      + 'physics and the near-field terrain mesh, where AO and shadow cost peak.',
    seconds: 25,
    requires: ['ship', 'player', 'world'],
    setup(app) {
      app.dayT = 0.28;
      app.setWeather('clear', true);
      const isl = firstIsland(app);
      this._isl = isl;
      const dx = isl.dockX !== undefined ? isl.dockX : isl.x;
      const dz = isl.dockZ !== undefined ? isl.dockZ : isl.z;
      tryCall(app, 'ship', 'teleport', dx, 0, dz + 26, 0);
      tryCall(app, 'player', 'boardShip');
      app.simulate(1);
    },
    input(t, api) {
      if (t < 6) { api.set('moveForward', true); return; }   // close the last few metres
      api.set('moveForward', false);
      if (t < 6.2) { api.tap('interact'); return; }           // dock / drop the gangplank
      if (t < 7.5) { api.tap('interact'); return; }           // step ashore
      api.set('moveForward', true);
      api.set('sprint', t > 14 && t < 20);                    // sprint inland
      api.look(Math.sin(t * 0.8) * 2.5, 0);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      const walk = clamp((t - 7) / 18, 0, 1);
      const dx = isl.dockX !== undefined ? isl.dockX : isl.x;
      const dz = isl.dockZ !== undefined ? isl.dockZ : isl.z;
      const x = lerp(dx, isl.x, walk), z = lerp(dz + 26, isl.z, walk);
      look(app, x, 4.5, z, isl.x, 5, isl.z);
    },
  },

  {
    id: 'combat-3v1',
    desc: 'Three enemies at once with telegraphs, hitstop, screen shake and impact FX firing '
      + 'together. The frame budget under Hades-grade feedback.',
    seconds: 30,
    requires: ['player', 'combat', 'enemies'],
    setup(app) {
      app.dayT = 0.36;
      app.setWeather('clear', true);
      const isl = firstIsland(app);
      this._isl = isl;
      tryCall(app, 'player', 'teleport', isl.x, 0, isl.z, 0);
      tryCall(app, 'enemies', 'spawnWave', { kind: 'bandit', count: 3, around: [isl.x, isl.z], radius: 7 });
      app.simulate(1);
    },
    input(t, api) {
      // A real fight rhythm: approach, three-hit string, dodge out, repeat.
      const beat = t % 4;
      api.set('moveForward', beat < 1.0);
      api.set('lightAttack', beat > 1.0 && beat < 1.15);
      api.set('heavyAttack', beat > 1.6 && beat < 1.8);
      api.set('dodge', beat > 2.6 && beat < 2.8);
      api.set('moveBack', beat > 2.8 && beat < 3.4);
      api.look(Math.sin(t * 1.7) * 6, Math.sin(t * 0.9) * 1.2);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      orbit(app, t, isl.x, isl.z, 11, 4.2, 0.45);
    },
  },

  {
    id: 'combat-boss',
    desc: 'A single large opponent with big telegraphs and area attacks. Long fight, so this is '
      + 'also where per-fight allocation leaks show up as heap growth.',
    seconds: 45,
    requires: ['player', 'combat', 'enemies'],
    setup(app) {
      app.dayT = 0.62;
      app.setWeather('breezy', true);
      const isl = firstIsland(app);
      this._isl = isl;
      tryCall(app, 'player', 'teleport', isl.x, 0, isl.z + 12, 0);
      tryCall(app, 'enemies', 'spawnBoss', { at: [isl.x, isl.z], tier: 2 });
      app.simulate(1);
    },
    input(t, api) {
      const beat = t % 6;
      api.set('moveLeft', beat < 1.4);                      // circle-strafe the telegraph
      api.set('lightAttack', (beat > 1.6 && beat < 1.75) || (beat > 2.0 && beat < 2.15));
      api.set('dodge', beat > 3.0 && beat < 3.2);
      api.set('heavyAttack', beat > 4.0 && beat < 4.25);
      api.set('fruitPower', beat > 5.2 && beat < 5.35);
      api.look(Math.sin(t * 0.8) * 5, 0);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      orbit(app, t, isl.x, isl.z, 15, 5.5, 0.3);
    },
  },

  {
    id: 'fruit-spam',
    desc: 'Devil-fruit power held down for the whole run. Particle, trail and distortion FX at '
      + 'their worst case, with nothing else competing — isolates FX cost from combat cost.',
    seconds: 20,
    requires: ['player', 'fruit'],
    setup(app) {
      app.dayT = 0.5;
      app.setWeather('clear', true);
      const isl = firstIsland(app);
      this._isl = isl;
      tryCall(app, 'player', 'teleport', isl.x, 0, isl.z, 0);
      tryCall(app, 'fruit', 'grant', 'gomu');
      tryCall(app, 'fruit', 'setCooldownScale', 0);   // worst case: no cooldown gating
      app.simulate(1);
    },
    input(t, api) {
      // Mash on every cooldown edge, alternating the two powers so both FX paths run.
      const beat = t % 1.2;
      api.set('fruitPower', beat < 0.12);
      api.set('fruitAlt', beat > 0.6 && beat < 0.72);
      api.set('moveForward', (t % 3) < 1.5);
      api.look(Math.sin(t * 2.1) * 8, 0);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      orbit(app, t, isl.x, isl.z, 9, 3.8, 0.7);
    },
  },

  {
    id: 'stress-everything',
    desc: 'Storm, boss, adds, fruit powers and the ship in frame at once, near the island so the '
      + 'streamer is also working. Nothing in the shipped game should ever exceed this.',
    seconds: 45,
    requires: ['player', 'ship', 'world', 'combat', 'enemies', 'fruit'],
    setup(app) {
      app.dayT = 0.4;
      app.setWeather('storm', true);
      const isl = firstIsland(app);
      this._isl = isl;
      const dx = isl.dockX !== undefined ? isl.dockX : isl.x;
      const dz = isl.dockZ !== undefined ? isl.dockZ : isl.z;
      tryCall(app, 'ship', 'teleport', dx, 0, dz + 18, 0);
      tryCall(app, 'player', 'teleport', isl.x, 0, isl.z + 10, 0);
      tryCall(app, 'fruit', 'grant', 'mera');
      tryCall(app, 'enemies', 'spawnBoss', { at: [isl.x, isl.z], tier: 3 });
      tryCall(app, 'enemies', 'spawnWave', { kind: 'marine', count: 6, around: [isl.x, isl.z], radius: 12 });
      app.simulate(1);
    },
    input(t, api) {
      const beat = t % 3;
      api.set('moveForward', beat < 1.0);
      api.set('moveLeft', beat > 1.0 && beat < 1.6);
      api.set('lightAttack', beat > 0.4 && beat < 0.55);
      api.set('heavyAttack', beat > 1.8 && beat < 2.0);
      api.set('fruitPower', beat > 2.2 && beat < 2.35);
      api.set('dodge', beat > 2.6 && beat < 2.8);
      api.look(Math.sin(t * 1.3) * 7, Math.sin(t * 0.7) * 2);
    },
    camera(t, app) {
      const isl = this._isl || firstIsland(app);
      orbit(app, t, isl.x, isl.z, 13 + Math.sin(t * 0.2) * 4, 5.0, 0.5);
    },
  },
];

/** @returns {Scenario|null} */
export function getScenario(id) {
  return SCENARIOS.find(s => s.id === id) || null;
}

export function scenarioIds() {
  return SCENARIOS.map(s => s.id);
}

/**
 * A deterministic stream for a scenario run. Scenarios are scripted rather than random, but
 * anything that does want jitter must take it from here so a rerun is identical.
 */
export function scenarioRng(seed, id) {
  return Rng.fromName(seed >>> 0, 'scenario:' + id);
}
