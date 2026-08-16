// Input. One layer, three producers: real devices, dispatched DOM events (playtest), and a
// scripted virtual source (profiler scenarios). Everything downstream reads the same snapshot,
// so a scripted run exercises exactly the code path a human does.

import { clamp } from './math.js';

export const ACTIONS = [
  'attack', 'heavy', 'block', 'dodge', 'jump', 'interact', 'sprint',
  'ability1', 'ability2', 'ability3', 'sailUp', 'sailDown', 'anchor',
  'map', 'pause', 'crew', 'quests', 'lockOn', 'swapFruit',
];

/** Default bindings. Settings may remap; save/load persists the map. */
export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  dodge: ['KeyC', 'ControlLeft'],
  block: ['KeyQ'],
  interact: ['KeyE'],
  ability1: ['Digit1'],
  ability2: ['Digit2'],
  ability3: ['Digit3'],
  sailUp: ['KeyR'],
  sailDown: ['KeyF'],
  anchor: ['KeyG'],
  map: ['KeyM'],
  quests: ['KeyJ'],
  crew: ['KeyK'],
  pause: ['Escape'],
  lockOn: ['KeyT'],
  swapFruit: ['KeyX'],
};

export class Input {
  constructor() {
    this.keys = new Set();
    this.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    this.mouse = { dx: 0, dy: 0, left: false, right: false, wheel: 0 };
    this.sensitivity = 0.0026;
    this.invertY = false;
    this.pointerLocked = false;
    /** Per-step snapshot everything else reads. */
    this.state = {
      moveX: 0, moveZ: 0, lookX: 0, lookY: 0,
      down: Object.create(null), pressed: Object.create(null), released: Object.create(null),
    };
    this._prevDown = Object.create(null);
    /** Scripted overrides, set by scenarios. null = use real input. */
    this.virtual = null;
    this._el = null;
    this._enabled = false;
    this._handlers = null;
    this.blocked = false;   // true while a text field or menu owns input
  }

  attach(el) {
    if (this._enabled) return;
    this._el = el || (typeof window !== 'undefined' ? window : null);
    if (!this._el || typeof window === 'undefined') return;
    const onKey = (down) => (e) => {
      if (e.repeat) return;
      if (down) this.keys.add(e.code); else this.keys.delete(e.code);
      // Space and arrows scroll the page otherwise, which fights the camera.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    };
    const onMouseMove = (e) => {
      // Real look input needs pointer lock. Scripted input (playtest, profiler scenarios)
      // dispatches UNTRUSTED events, which can never acquire the lock — their relative motion
      // is honoured directly so the same code path a human uses stays drivable by the harness.
      if (this.pointerLocked || (e.isTrusted === false && (e.movementX || e.movementY))) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
    };
    const onMouseDown = (e) => {
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
    };
    const onMouseUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    };
    const onWheel = (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); };
    const onBlur = () => { this.keys.clear(); this.mouse.left = false; this.mouse.right = false; };
    const onLockChange = () => {
      this.pointerLocked = typeof document !== 'undefined' && document.pointerLockElement !== null;
    };
    const onContext = (e) => e.preventDefault();

    this._handlers = { onKey, onMouseMove, onMouseDown, onMouseUp, onWheel, onBlur, onLockChange, onContext };
    window.addEventListener('keydown', onKey(true), { passive: false });
    window.addEventListener('keyup', onKey(false), { passive: false });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('contextmenu', onContext);
    this._enabled = true;
  }

  requestPointerLock(canvas) {
    if (canvas && canvas.requestPointerLock) canvas.requestPointerLock();
  }

  isKey(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /**
   * Build this step's snapshot. Called once per fixed step, before anything reads input.
   * Mouse deltas accumulate between steps and are consumed here — never read them elsewhere.
   */
  step() {
    const s = this.state;
    for (const k in s.down) this._prevDown[k] = s.down[k];
    for (const k in s.pressed) s.pressed[k] = false;
    for (const k in s.released) s.released[k] = false;

    if (this.virtual) {
      const v = this.virtual;
      s.moveX = clamp(v.moveX || 0, -1, 1);
      s.moveZ = clamp(v.moveZ || 0, -1, 1);
      s.lookX = v.lookX || 0;
      s.lookY = v.lookY || 0;
      for (const a of ACTIONS) {
        const d = !!(v.down && v.down[a]);
        s.pressed[a] = d && !this._prevDown[a];
        s.released[a] = !d && !!this._prevDown[a];
        s.down[a] = d;
      }
      if (v.consume) v.consume();
      return s;
    }

    if (this.blocked) {
      s.moveX = 0; s.moveZ = 0; s.lookX = 0; s.lookY = 0;
      for (const a of ACTIONS) { s.pressed[a] = false; s.released[a] = false; s.down[a] = false; }
      this.mouse.dx = 0; this.mouse.dy = 0;
      return s;
    }

    let mx = 0, mz = 0;
    if (this.isKey('left')) mx -= 1;
    if (this.isKey('right')) mx += 1;
    if (this.isKey('forward')) mz -= 1;
    if (this.isKey('back')) mz += 1;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    s.moveX = mx; s.moveZ = mz;

    s.lookX = this.mouse.dx * this.sensitivity;
    s.lookY = this.mouse.dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.mouse.dx = 0; this.mouse.dy = 0;

    const raw = {
      attack: this.mouse.left,
      heavy: this.mouse.right,
      block: this.isKey('block'),
      dodge: this.isKey('dodge'),
      jump: this.isKey('jump'),
      interact: this.isKey('interact'),
      sprint: this.isKey('sprint'),
      ability1: this.isKey('ability1'),
      ability2: this.isKey('ability2'),
      ability3: this.isKey('ability3'),
      sailUp: this.isKey('sailUp'),
      sailDown: this.isKey('sailDown'),
      anchor: this.isKey('anchor'),
      map: this.isKey('map'),
      pause: this.isKey('pause'),
      crew: this.isKey('crew'),
      quests: this.isKey('quests'),
      lockOn: this.isKey('lockOn'),
      swapFruit: this.isKey('swapFruit'),
    };
    for (const a of ACTIONS) {
      const d = !!raw[a];
      s.pressed[a] = d && !this._prevDown[a];
      s.released[a] = !d && !!this._prevDown[a];
      s.down[a] = d;
    }
    return s;
  }

  /** Scenario/profiler hook: drive input without a device. Pass null to release control. */
  setVirtual(v) { this.virtual = v; }

  detach() {
    if (!this._enabled || typeof window === 'undefined') return;
    const h = this._handlers;
    window.removeEventListener('mousemove', h.onMouseMove);
    window.removeEventListener('mousedown', h.onMouseDown);
    window.removeEventListener('mouseup', h.onMouseUp);
    window.removeEventListener('wheel', h.onWheel);
    window.removeEventListener('blur', h.onBlur);
    document.removeEventListener('pointerlockchange', h.onLockChange);
    window.removeEventListener('contextmenu', h.onContext);
    this._enabled = false;
  }

  serialize() { return { binds: this.binds, sensitivity: this.sensitivity, invertY: this.invertY }; }
  deserialize(o) {
    if (!o) return;
    if (o.binds) this.binds = o.binds;
    if (typeof o.sensitivity === 'number') this.sensitivity = o.sensitivity;
    if (typeof o.invertY === 'boolean') this.invertY = o.invertY;
  }
}

/**
 * A virtual input source for scripted runs. Scenarios build one of these and hand it to
 * `input.setVirtual()`. Deterministic: it never reads a device or a clock.
 */
export function makeVirtualInput() {
  const v = {
    moveX: 0, moveZ: 0, lookX: 0, lookY: 0, down: Object.create(null),
    press(a, on = true) { v.down[a] = on; return v; },
    tap(a) { v._taps.push(a); v.down[a] = true; return v; },
    move(x, z) { v.moveX = x; v.moveZ = z; return v; },
    look(x, y) { v.lookX = x; v.lookY = y; return v; },
    clear() { v.moveX = 0; v.moveZ = 0; v.lookX = 0; v.lookY = 0; for (const k in v.down) v.down[k] = false; return v; },
    _taps: [],
    consume() {
      // A tap lasts exactly one step, which is how a real click reads to the game.
      for (const a of v._taps) v.down[a] = false;
      v._taps.length = 0;
      v.lookX = 0; v.lookY = 0;
    },
  };
  return v;
}
