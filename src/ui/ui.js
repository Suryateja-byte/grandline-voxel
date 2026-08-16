// The UI system: one 2D canvas layered over the WebGL canvas, drawing the HUD, the menus and
// the tutorial, and owning the two things the rest of the game fires at the interface without
// caring how they are drawn — toasts and damage numbers.
//
// WHY a second canvas rather than DOM: text and panels drawn in 2D canvas cost nothing in
// layout/reflow, cannot be restyled by the page, resize in one line, and — critically — are
// pixel-deterministic given the same inputs, which is what lets the capture harness diff a
// frame that includes the interface. DOM would also need a font, and there are no font files.
//
// Nothing here reads the wall clock. `dt` arrives from the caller's fixed step; ages advance
// by that dt, so a capture that runs 120 fixed steps produces exactly the same toast state
// every time.

import { Rng } from '../core/rng.js';

import { Hud, blankHudState } from './hud.js';
import { Menus, MENU, defaultCallbacks } from './menus.js';
import { Tutorial } from './tutorial.js';

const MAX_TOASTS = 6;
const MAX_DAMAGE_NUMBERS = 48;

export class UISystem {
  /**
   * @param {object} [opts]
   * @param {number} [opts.seed=1] deterministic stream seed for cosmetic jitter
   * @param {object} [opts.callbacks] menu callbacks — see menus.defaultCallbacks()
   * @param {boolean} [opts.captureInput=true] bind pointer/keyboard listeners in attach()
   * @param {boolean} [opts.tutorial=true] run the first-time flow
   * @param {number} [opts.refW=1920] @param {number} [opts.refH=1080]
   * @param {string} [opts.cbMode='off'] colourblind-safe telegraph mode
   */
  constructor(opts = {}) {
    this.opts = Object.assign({
      seed: 1, captureInput: true, tutorial: true, refW: 1920, refH: 1080, cbMode: 'off',
    }, opts);
    this.rng = Rng.fromName(this.opts.seed >>> 0, 'ui.cosmetic');
    this.hud = new Hud({ refW: this.opts.refW, refH: this.opts.refH, cbMode: this.opts.cbMode });
    this.menus = new Menus({ callbacks: this.opts.callbacks, refW: this.opts.refW, refH: this.opts.refH });
    this.tutorial = new Tutorial({ hud: this.hud, enabled: this.opts.tutorial !== false, refW: this.opts.refW, refH: this.opts.refH });
    // The menus report every action through the same toast channel the game uses.
    const cb = this.menus.cb;
    const prevToast = cb.toast;
    cb.toast = (text, kind) => { prevToast(text, kind); this.toast(text, kind); };

    this.state = blankHudState();
    this.toasts = [];
    this.damageNumbers = [];
    this.w = this.opts.refW;
    this.h = this.opts.refH;
    this.canvas = null;
    this.ctx = null;
    this.parent = null;
    this.visible = true;
    this._lastDt = 1 / 60;
    this._listeners = [];
    this._dnSeq = 0;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Create the overlay canvas and mount it. Nothing touches `document` before this call, so
   * the module imports cleanly under Node.
   * @param {HTMLElement} parentEl
   * @param {number} w @param {number} h in CSS pixels
   */
  attach(parentEl, w, h) {
    if (this.canvas) this.detach();
    const cv = document.createElement('canvas');
    cv.id = 'ui';
    cv.style.position = 'absolute';
    cv.style.left = '0';
    cv.style.top = '0';
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.display = 'block';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '10';
    this.canvas = cv;
    this.ctx = cv.getContext('2d', { alpha: true, desynchronized: false });
    this.parent = parentEl;
    parentEl.appendChild(cv);
    this.resize(w || parentEl.clientWidth || this.opts.refW, h || parentEl.clientHeight || this.opts.refH);
    if (this.opts.captureInput) this._bind();
    return this;
  }

  detach() {
    for (const [target, type, fn] of this._listeners) target.removeEventListener(type, fn);
    this._listeners.length = 0;
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    this.ctx = null;
    this.parent = null;
  }

  resize(w, h) {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    if (this.canvas) { this.canvas.width = this.w; this.canvas.height = this.h; }
    this.hud.layout(this.w, this.h);
    this.menus.resize(this.w, this.h);
  }

  _bind() {
    const cv = this.canvas;
    const add = (target, type, fn, opt) => { target.addEventListener(type, fn, opt); this._listeners.push([target, type, fn]); };
    const local = (e) => {
      const r = cv.getBoundingClientRect();
      return [(e.clientX - r.left) * (this.w / Math.max(1, r.width)), (e.clientY - r.top) * (this.h / Math.max(1, r.height))];
    };
    add(cv, 'pointermove', (e) => { const [x, y] = local(e); this.handlePointer(x, y, 'move'); });
    add(cv, 'pointerdown', (e) => { const [x, y] = local(e); if (this.handlePointer(x, y, 'down')) e.preventDefault(); });
    add(cv, 'pointerup', (e) => { const [x, y] = local(e); this.handlePointer(x, y, 'up'); });
    add(cv, 'wheel', (e) => { const [x, y] = local(e); if (this.handlePointer(x, y, 'wheel', e.deltaY)) e.preventDefault(); }, { passive: false });
    add(window, 'keydown', (e) => { if (this.handleKeyDown(e.code)) e.preventDefault(); }, { passive: false });
    add(window, 'keyup', (e) => { this.handleKeyUp(e.code); });
  }

  // ---------------------------------------------------------------- input

  /**
   * @param {string} code KeyboardEvent.code
   * @returns {boolean} true when the UI consumed the key and gameplay must ignore it
   */
  handleKeyDown(code) {
    if (code === 'KeyH' && !this.menus.isOpen && !this.tutorial.isDone()) {
      this.tutorial.setSkipHeld(true);
      return true;
    }
    if (code === 'Escape') {
      if (this.menus.isOpen) this.menus.back();
      else this.openMenu(MENU.PAUSE);
      this._syncPointerEvents();
      return true;
    }
    // M toggles the voyage log: game.js opens it from the map action while play input is
    // live; once a menu is open the play snapshot is blocked, so the close half of the
    // toggle has to live here, on the raw key.
    if (code === 'KeyM' && this.menus.isOpen && this.menus.name === MENU.QUESTS) {
      this.closeMenu();
      return true;
    }
    const used = this.menus.key(code);
    this._syncPointerEvents();
    return used;
  }

  /** @returns {boolean} */
  handleKeyUp(code) {
    if (code === 'KeyH') { this.tutorial.setSkipHeld(false); return true; }
    return false;
  }

  /**
   * @param {'move'|'down'|'up'|'wheel'} kind
   * @returns {boolean} true when the UI consumed the event
   */
  handlePointer(x, y, kind, delta) {
    const used = this.menus.pointer(x, y, kind, delta);
    this._syncPointerEvents();
    return used;
  }

  _syncPointerEvents() {
    if (this.canvas) this.canvas.style.pointerEvents = this.menus.isOpen ? 'auto' : 'none';
  }

  // ---------------------------------------------------------------- menus

  /** @param {string} name one of MENU.* @returns {boolean} */
  openMenu(name) {
    const ok = this.menus.open(name);
    this._syncPointerEvents();
    return ok;
  }

  closeMenu() {
    const ok = this.menus.close();
    this._syncPointerEvents();
    return ok;
  }

  /** @returns {string|null} the open page's name, or null. */
  get menuOpen() { return this.menus.name; }

  /** Replace the menu callback table (used once the owning systems finish booting). */
  setCallbacks(cb) {
    this.menus.setCallbacks(cb);
    const c = this.menus.cb;
    const prevToast = c.toast;
    c.toast = (text, kind) => { prevToast(text, kind); this.toast(text, kind); };
  }

  // ---------------------------------------------------------------- messages

  /**
   * Push a transient message into the top-right stack.
   * @param {string} text
   * @param {'info'|'good'|'bad'|'gold'|'quest'|'warn'|'crew'} [kind='info']
   * @param {number} [life] seconds on screen; defaults to 2.6 + reading time
   */
  toast(text, kind = 'info', life) {
    if (!text) return null;
    const t = {
      text: String(text), kind,
      age: 0, life: life === undefined ? 2.6 + Math.min(3, String(text).length * 0.035) : life,
    };
    this.toasts.push(t);
    // Newest wins: the oldest is aged out immediately rather than popped, so it slides away.
    while (this.toasts.length > MAX_TOASTS) {
      const old = this.toasts[0];
      if (old.life - old.age > 0.3) old.age = old.life - 0.3; else this.toasts.shift();
      if (this.toasts.length > MAX_TOASTS + 2) this.toasts.shift();
    }
    return t;
  }

  /**
   * Spawn a floating damage number anchored to a world position.
   * @param {{x:number,y:number,z:number}|number[]} worldPos
   * @param {number} value
   * @param {'hit'|'crit'|'heal'|'block'|'parry'|'miss'|'fruit'} [kind='hit']
   * @param {(pos:any)=>({x:number,y:number,visible?:boolean}|null)} projectFn
   *        projects a world position to canvas pixels; called every step so the number
   *        tracks the target while the camera moves
   */
  damageNumber(worldPos, value, kind = 'hit', projectFn) {
    const p = Array.isArray(worldPos)
      ? { x: worldPos[0], y: worldPos[1], z: worldPos[2] }
      : { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    const dn = {
      world: p, value, kind, age: 0,
      life: kind === 'crit' ? 1.35 : kind === 'miss' ? 0.7 : 1.0,
      project: typeof projectFn === 'function' ? projectFn : null,
      // Deterministic sideways scatter so several hits on one enemy never stack illegibly.
      drift: this.rng.range(-30, 30),
      x: this.w / 2, y: this.h / 2, visible: true,
      seq: this._dnSeq++,
    };
    this.damageNumbers.push(dn);
    if (this.damageNumbers.length > MAX_DAMAGE_NUMBERS) this.damageNumbers.shift();
    return dn;
  }

  // ---------------------------------------------------------------- frame

  /**
   * Advance interface animation and pull the frame's HUD state.
   * @param {number} dt seconds
   * @param {object} gameState the game's UI-facing state. Read as `gameState.uiState || gameState`;
   *   `hud` supplies the HUD shape (see hud.blankHudState) and the tutorial reads `signals`,
   *   `onShip` and `ship` off the same object.
   */
  step(dt, gameState) {
    const d = Math.min(0.1, Math.max(0, dt || 0));
    this._lastDt = d;
    const src = (gameState && (gameState.uiState || gameState)) || {};
    const incoming = src.hud || {};

    // Merge rather than replace, so a system that only knows about hp does not blank the rest.
    const st = this.state;
    for (const k of Object.keys(blankHudState())) {
      if (incoming[k] !== undefined) st[k] = incoming[k];
    }
    if (src.onShip !== undefined && incoming.onShip === undefined) st.onShip = !!src.onShip;

    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.age += d;
      if (t.age >= t.life) this.toasts.splice(i, 1);
    }
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i];
      dn.age += d;
      if (dn.age >= dn.life) { this.damageNumbers.splice(i, 1); continue; }
      if (dn.project) {
        const p = dn.project(dn.world);
        if (p && p.visible !== false) { dn.x = p.x; dn.y = p.y; dn.visible = true; }
        else dn.visible = false;
      }
    }
    // Game-supplied lists are merged in rather than overwritten, so a system that keeps its
    // own damage numbers (the combat cluster, replaying a capture) still shows up.
    st.toasts = incoming.toasts && incoming.toasts !== st.toasts
      ? incoming.toasts.concat(this.toasts) : this.toasts;
    st.damageNumbers = incoming.damageNumbers && incoming.damageNumbers !== st.damageNumbers
      ? incoming.damageNumbers.concat(this.damageNumbers) : this.damageNumbers;

    const cbMode = this.menus.cb.getSettings ? this.menus.cb.getSettings().telegraphMode : this.opts.cbMode;
    this.hud.setOption('cbMode', cbMode || 'off');

    this.menus.step(d);
    this.tutorial.paused = this.menus.isOpen;
    this.tutorial.step(d, src);
  }

  /** Render the whole interface. Must be called after the 3D frame is presented. */
  draw() {
    if (!this.ctx || !this.visible) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    this.hud.draw(ctx, this.state, this._lastDt);
    if (!this.menus.isOpen) this.tutorial.draw(ctx);
    this.menus.draw(ctx);
    ctx.restore();
  }

  /** ARCHITECTURE §5: every system implements serialize()/deserialize(). */
  serialize() {
    return { v: 1, tutorial: this.tutorial.serialize() };
  }

  deserialize(o) {
    if (!o) return;
    this.tutorial.deserialize(o.tutorial);
  }

  dispose() { this.detach(); }
}

export { MENU, defaultCallbacks, blankHudState };
export default UISystem;
