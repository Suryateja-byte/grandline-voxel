// Menus: pause, save/load, settings, devil-fruit wheel, crew roster, quest log, bounty poster.
//
// Every entry is wired to a callback. There are no decorative rows, no "coming soon", and no
// disabled-looking buttons that a player can focus and press to no effect: an action that
// cannot apply (Load on an empty slot) is not drawn at all, so focus can never land on it.
//
// Navigation is a 2D grid. Items carry (row, col); Up/Down changes row, Left/Right moves
// between columns in a row OR adjusts the focused value when the row is a single control.
// The mouse hit-tests the same item list, so keyboard and mouse can never disagree about
// what is selectable.
//
// The item list is rebuilt by `_build()` from pure layout maths before anything is drawn, and
// invalidated whenever an action changes state. Input therefore never reads stale rectangles.

import { P, mixHex, shadeDown, shadeUp } from '../gen/palette.js';
import { clamp, clamp01, commify, TAU } from '../core/math.js';
import { hash2, hashFloat, hashString } from '../core/rng.js';
import { drawText, measure, BERRY, toCss } from './font.js';
import {
  panel, ribbon, bar, icon, waxSeal, roundRectPath, scrim, nail, inkStroke, keyCap,
  telegraphColor, telegraphGlyph,
} from './draw.js';

export const MENU = {
  PAUSE: 'pause', SAVE: 'save', SETTINGS: 'settings', FRUIT: 'fruit',
  CREW: 'crew', QUESTS: 'quests', BOUNTY: 'bounty',
};

const CREW_STATIONS = ['HELM', 'LOOKOUT', 'GUNNER', 'COOK', 'SURGEON', 'SHORE PARTY'];

const SETTINGS_SCHEMA = [
  { key: 'master', label: 'Master Volume', kind: 'slider', min: 0, max: 1, step: 0.05 },
  { key: 'sfx', label: 'Sound Effects', kind: 'slider', min: 0, max: 1, step: 0.05 },
  { key: 'music', label: 'Music', kind: 'slider', min: 0, max: 1, step: 0.05 },
  {
    key: 'shadowQuality', label: 'Shadow Quality', kind: 'choice',
    options: ['off', 'low', 'high', 'ultra'], labels: ['OFF', 'LOW', 'HIGH', 'ULTRA'],
  },
  {
    key: 'renderScale', label: 'Render Scale', kind: 'choice',
    options: [0.6, 0.75, 1, 1.25], labels: ['60%', '75%', '100%', '125%'],
  },
  { key: 'invertY', label: 'Invert Look Y', kind: 'toggle' },
  { key: 'sensitivity', label: 'Look Sensitivity', kind: 'slider', min: 0.2, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) + 'x' },
  {
    key: 'telegraphMode', label: 'Telegraph Colours', kind: 'choice',
    options: ['off', 'deuter', 'protan', 'tritan'],
    labels: ['STANDARD', 'DEUTERAN', 'PROTAN', 'TRITAN'], preview: 'telegraph',
  },
];

/**
 * The callbacks contract. Every function here is required by some menu entry; this factory
 * returns a self-consistent in-memory implementation so the menus are fully operable (and
 * testable) before the owning systems are wired in.
 *
 * ```
 * {
 *   resume(): void                       // close menus, unpause
 *   quitToTitle(): void
 *   getStatus(): { place, playtime, bounty, level, seed }
 *
 *   listSlots(): Array<{ index, empty, name, level, bounty, place, playtime, savedAt, seed }>
 *   saveToSlot(i): boolean               // true on success
 *   loadFromSlot(i): boolean
 *   eraseSlot(i): boolean
 *
 *   getSettings(): object                // keys of SETTINGS_SCHEMA
 *   setSetting(key, value): void
 *   resetSettings(): void
 *
 *   getFruits(): Array<{ id, name, color, icon, unlocked, equipped, desc,
 *                        abilities:[{ name, icon }] }>
 *   selectFruit(id): boolean
 *
 *   getCrew(): Array<{ id, name, role, station, bio, level, seed }>
 *   assignCrew(id, station): void
 *
 *   getQuests(): Array<{ id, title, giver, state, tracked, reward,
 *                        steps:[{ text, done }], canAbandon }>
 *   setTrackedQuest(id): void
 *   abandonQuest(id): void
 *
 *   getBountySubjects(): Array<{ id, name, epithet, amount, crew, seed, alive, tier }>
 *
 *   toast(text, kind): void              // menus report the result of every action
 * }
 * ```
 * @returns {object} a working default implementation
 */
export function defaultCallbacks() {
  const settings = {
    master: 0.8, sfx: 0.9, music: 0.6, shadowQuality: 'high',
    renderScale: 1, invertY: false, sensitivity: 1, telegraphMode: 'off',
  };
  const defaults = Object.assign({}, settings);
  const slots = [0, 1, 2].map((i) => ({ index: i, empty: true }));
  const out = {
    resume() {},
    quitToTitle() {},
    getStatus: () => ({ place: 'Open Sea', playtime: 0, bounty: 0, level: 1, seed: 0 }),
    listSlots: () => slots,
    saveToSlot(i) {
      const st = out.getStatus();
      slots[i] = {
        index: i, empty: false, name: 'Voyage ' + (i + 1), level: st.level, bounty: st.bounty,
        place: st.place, playtime: st.playtime, savedAt: 'just now', seed: st.seed,
      };
      return true;
    },
    loadFromSlot: (i) => !slots[i].empty,
    eraseSlot(i) { slots[i] = { index: i, empty: true }; return true; },
    getSettings: () => settings,
    setSetting(k, v) { settings[k] = v; },
    resetSettings() { Object.assign(settings, defaults); },
    getFruits: () => [],
    selectFruit: () => false,
    getCrew: () => [],
    assignCrew() {},
    getQuests: () => [],
    setTrackedQuest() {},
    abandonQuest() {},
    getBountySubjects: () => [],
    toast() {},
  };
  return out;
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export class Menus {
  /**
   * @param {{callbacks?:object, refW?:number, refH?:number}} [opts]
   */
  constructor(opts = {}) {
    this.cb = Object.assign(defaultCallbacks(), opts.callbacks || {});
    this.refW = opts.refW || 1920;
    this.refH = opts.refH || 1080;
    this.w = this.refW; this.h = this.refH;
    this.s = 1;
    this.name = null;
    this.stack = [];
    this.cursor = { row: 0, col: 0 };
    this.t = 0;
    this.anim = 0;             // 0..1 open transition
    this.sel = { crew: 0, quest: 0, fruit: 0, bounty: 0 };
    this._items = null;
    this._drag = null;
    this._pointer = { x: -1, y: -1, active: false };
    this._poster = null;       // { key, canvas }
  }

  /** True when any page is showing. */
  get isOpen() { return this.name !== null; }

  setCallbacks(cb) { this.cb = Object.assign(defaultCallbacks(), cb || {}); this._items = null; }

  resize(w, h) {
    this.w = w; this.h = h;
    this.s = clamp(Math.min(w / this.refW, h / this.refH), 0.5, 2.2);
    this._items = null;
    this._poster = null;
  }

  /** @param {string} name one of MENU.* */
  open(name) {
    if (!Object.values(MENU).includes(name)) return false;
    if (this.name && this.name !== name) this.stack.push(this.name);
    this.name = name;
    this.cursor = { row: 0, col: 0 };
    this._items = null;
    return true;
  }

  /** Pop one level; closes entirely when the stack is empty. */
  back() {
    if (this.stack.length) { this.name = this.stack.pop(); this.cursor = { row: 0, col: 0 }; this._items = null; return true; }
    return this.close();
  }

  close() {
    const was = this.name;
    this.name = null;
    this.stack.length = 0;
    this._items = null;
    if (was) this.cb.resume();
    return !!was;
  }

  step(dt) {
    this.t += dt;
    const target = this.isOpen ? 1 : 0;
    this.anim += clamp((target - this.anim) * dt * 12, -0.2, 0.2);
    if (Math.abs(target - this.anim) < 0.01) this.anim = target;
  }

  // ------------------------------------------------------------------ input

  /**
   * @param {string} code KeyboardEvent.code
   * @returns {boolean} true when the key was consumed by a menu
   */
  key(code) {
    if (!this.isOpen) return false;
    if (!this._items) this._build();
    switch (code) {
      case 'Escape': case 'Backspace': this.back(); return true;
      case 'ArrowUp': case 'KeyW': this._move(-1, 0); return true;
      case 'ArrowDown': case 'KeyS': this._move(1, 0); return true;
      case 'ArrowLeft': case 'KeyA': this._adjust(-1); return true;
      case 'ArrowRight': case 'KeyD': this._adjust(1); return true;
      case 'Enter': case 'NumpadEnter': case 'Space': this._activate(this._focused()); return true;
      case 'Tab': this._move(1, 0); return true;
      default: return true; // menus swallow everything else so play input never leaks through
    }
  }

  /**
   * @param {'move'|'down'|'up'|'wheel'} kind
   * @returns {boolean} true when the pointer event was consumed
   */
  pointer(x, y, kind, delta) {
    if (!this.isOpen) return false;
    if (!this._items) this._build();
    this._pointer.x = x; this._pointer.y = y; this._pointer.active = true;

    if (kind === 'wheel') {
      this._move(delta > 0 ? 1 : -1, 0);
      return true;
    }
    if (this._drag && kind === 'move') { this._dragTo(x); return true; }
    if (this._drag && kind === 'up') { this._drag = null; return true; }

    const hit = this._hit(x, y);
    if (hit) {
      this.cursor = { row: hit.row, col: hit.col };
      if (kind === 'down') {
        if (hit.kind === 'slider') { this._drag = hit; this._dragTo(x); }
        else this._activate(hit);
      }
    }
    return true;
  }

  /** Rebuild the item list if an action invalidated it. Input never reads stale rectangles. */
  _ensure() { if (!this._items) this._build(); return this._items; }

  _hit(x, y) {
    for (const it of this._ensure()) {
      const r = it.rect;
      if (it.focusable === false) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return it;
    }
    return null;
  }

  _focused() {
    const items = this._ensure();
    let best = null;
    for (const it of items) {
      if (it.focusable === false) continue;
      if (it.row === this.cursor.row && it.col === this.cursor.col) return it;
      if (it.row === this.cursor.row && !best) best = it;
    }
    return best || items.find((i) => i.focusable !== false) || null;
  }

  _rows() {
    const set = new Set();
    for (const it of this._ensure()) if (it.focusable !== false) set.add(it.row);
    return Array.from(set).sort((a, b) => a - b);
  }

  _move(dr, dc) {
    const rows = this._rows();
    if (!rows.length) return;
    let ri = rows.indexOf(this.cursor.row);
    if (ri < 0) ri = 0;
    ri = (ri + dr + rows.length) % rows.length;
    this.cursor.row = rows[ri];
    const cols = this._ensure().filter((i) => i.row === this.cursor.row && i.focusable !== false)
      .map((i) => i.col).sort((a, b) => a - b);
    if (!cols.length) return;
    this.cursor.col = cols[clamp(cols.indexOf(this.cursor.col) < 0 ? 0 : cols.indexOf(this.cursor.col) + dc, 0, cols.length - 1)];
  }

  /** Left/Right: change value if the focused item has one, otherwise move between columns. */
  _adjust(dir) {
    const it = this._focused();
    if (!it) return;
    if (it.kind === 'slider') {
      const sp = it.spec;
      const cur = Number(this.cb.getSettings()[sp.key]);
      const next = clamp(Math.round((cur + dir * sp.step) / sp.step) * sp.step, sp.min, sp.max);
      this.cb.setSetting(sp.key, Number(next.toFixed(4)));
      this._items = null;
      return;
    }
    if (it.kind === 'choice') {
      const sp = it.spec;
      const cur = this.cb.getSettings()[sp.key];
      let i = sp.options.findIndex((o) => o === cur);
      if (i < 0) i = 0;
      i = (i + dir + sp.options.length) % sp.options.length;
      this.cb.setSetting(sp.key, sp.options[i]);
      this._items = null;
      return;
    }
    if (it.kind === 'toggle') { this._activate(it); return; }
    if (it.horizontal) { this._activate(it, dir); return; }
    const cols = this._ensure().filter((i) => i.row === this.cursor.row && i.focusable !== false)
      .map((i) => i.col).sort((a, b) => a - b);
    if (cols.length > 1) {
      const ci = clamp(cols.indexOf(this.cursor.col) + dir, 0, cols.length - 1);
      this.cursor.col = cols[ci];
    }
  }

  _dragTo(x) {
    const it = this._drag;
    if (!it || it.kind !== 'slider') return;
    const sp = it.spec;
    const tr = it.track;
    const t = clamp01((x - tr.x) / Math.max(1, tr.w));
    const v = clamp(Math.round((sp.min + t * (sp.max - sp.min)) / sp.step) * sp.step, sp.min, sp.max);
    this.cb.setSetting(sp.key, Number(v.toFixed(4)));
    this._items = null;
  }

  _activate(it, dir) {
    if (!it || !it.action) return;
    it.action(dir === undefined ? 1 : dir);
    this._items = null;
  }

  // ------------------------------------------------------------------ layout

  _build() {
    this._items = [];
    const s = this.s;
    const bw = Math.min(this.w - 80 * s, 1180 * s);
    const bh = Math.min(this.h - 70 * s, 800 * s);
    this.board = {
      x: Math.round(this.w / 2 - bw / 2), y: Math.round(this.h / 2 - bh / 2),
      w: Math.round(bw), h: Math.round(bh),
    };
    switch (this.name) {
      case MENU.PAUSE: this._buildPause(); break;
      case MENU.SAVE: this._buildSave(); break;
      case MENU.SETTINGS: this._buildSettings(); break;
      case MENU.FRUIT: this._buildFruit(); break;
      case MENU.CREW: this._buildCrew(); break;
      case MENU.QUESTS: this._buildQuests(); break;
      case MENU.BOUNTY: this._buildBounty(); break;
      default: break;
    }
    const rows = this._rows();
    if (rows.length && rows.indexOf(this.cursor.row) < 0) this.cursor = { row: rows[0], col: 0 };
  }

  _add(it) { this._items.push(it); return it; }

  _content() {
    const s = this.s, b = this.board;
    return {
      x: b.x + Math.round(34 * s), y: b.y + Math.round(84 * s),
      w: b.w - Math.round(68 * s), h: b.h - Math.round(138 * s),
    };
  }

  _buildPause() {
    const s = this.s, c = this._content();
    const labels = [
      ['Resume Voyage', 'wheel', () => this.close()],
      ['Devil Fruit', 'flame', () => this.open(MENU.FRUIT)],
      ['Crew Roster', 'crew', () => this.open(MENU.CREW)],
      ['Quest Log', 'scroll', () => this.open(MENU.QUESTS)],
      ['Bounty Poster', 'skull', () => this.open(MENU.BOUNTY)],
      ['Save & Load', 'chest', () => this.open(MENU.SAVE)],
      ['Settings', 'compass', () => this.open(MENU.SETTINGS)],
      ['Quit to Title', 'anchor', () => { this.close(); this.cb.quitToTitle(); }],
    ];
    const rh = Math.round(58 * s);
    const gap = Math.round(10 * s);
    const w = Math.round(Math.min(c.w * 0.52, 460 * s));
    for (let i = 0; i < labels.length; i++) {
      this._add({
        kind: 'button', row: i, col: 0, label: labels[i][0], icon: labels[i][1],
        rect: { x: c.x, y: c.y + i * (rh + gap), w, h: rh },
        action: labels[i][2],
      });
    }
  }

  _buildSave() {
    const s = this.s, c = this._content();
    const slots = this.cb.listSlots() || [];
    const cardH = Math.round(Math.min(150 * s, (c.h - 100 * s) / 3));
    const gap = Math.round(14 * s);
    for (let i = 0; i < 3; i++) {
      const slot = slots[i] || { index: i, empty: true };
      const y = c.y + i * (cardH + gap);
      const rect = { x: c.x, y, w: c.w, h: cardH };
      this._add({ kind: 'card', row: i, col: 0, focusable: false, rect, slot });
      const bw = Math.round(132 * s), bh = Math.round(40 * s);
      const bx = c.x + c.w - Math.round(18 * s) - bw;
      const by = y + cardH - Math.round(18 * s) - bh;
      if (slot.empty) {
        this._add({
          kind: 'button', row: i, col: 0, label: 'Save Here', icon: 'chest', small: true,
          rect: { x: bx, y: by, w: bw, h: bh },
          action: () => {
            this.cb.saveToSlot(i) ? this.cb.toast('Voyage recorded in slot ' + (i + 1), 'good')
              : this.cb.toast('Could not write slot ' + (i + 1), 'bad');
          },
        });
      } else {
        this._add({
          kind: 'button', row: i, col: 0, label: 'Load', icon: 'wheel', small: true,
          rect: { x: bx - (bw + 10 * s) * 2, y: by, w: bw, h: bh },
          action: () => {
            this.cb.loadFromSlot(i) ? (this.close(), this.cb.toast('Slot ' + (i + 1) + ' loaded', 'good'))
              : this.cb.toast('Slot ' + (i + 1) + ' would not load', 'bad');
          },
        });
        this._add({
          kind: 'button', row: i, col: 1, label: 'Overwrite', icon: 'chest', small: true,
          rect: { x: bx - (bw + 10 * s), y: by, w: bw, h: bh },
          action: () => {
            this.cb.saveToSlot(i);
            this.cb.toast('Slot ' + (i + 1) + ' overwritten', 'good');
          },
        });
        this._add({
          kind: 'button', row: i, col: 2, label: 'Erase', icon: 'skull', small: true, danger: true,
          rect: { x: bx, y: by, w: bw, h: bh },
          action: () => { this.cb.eraseSlot(i); this.cb.toast('Slot ' + (i + 1) + ' erased', 'warn'); },
        });
      }
    }
    this._backButton(3);
  }

  _buildSettings() {
    const s = this.s, c = this._content();
    const st = this.cb.getSettings();
    const rh = Math.round(46 * s);
    const gap = Math.round(8 * s);
    const labelW = Math.round(c.w * 0.42);
    for (let i = 0; i < SETTINGS_SCHEMA.length; i++) {
      const sp = SETTINGS_SCHEMA[i];
      const y = c.y + i * (rh + gap);
      const rect = { x: c.x, y, w: c.w, h: rh };
      const track = {
        x: c.x + labelW, y: y + rh / 2 - Math.round(8 * s),
        w: c.w - labelW - Math.round(120 * s), h: Math.round(16 * s),
      };
      if (sp.kind === 'slider') {
        this._add({ kind: 'slider', row: i, col: 0, spec: sp, rect, track, value: st[sp.key], action: () => {} });
      } else if (sp.kind === 'choice') {
        this._add({
          kind: 'choice', row: i, col: 0, spec: sp, rect, track, value: st[sp.key], horizontal: true,
          action: (dir) => this._adjustChoice(sp, dir),
        });
      } else {
        this._add({
          kind: 'toggle', row: i, col: 0, spec: sp, rect, track, value: !!st[sp.key],
          action: () => { this.cb.setSetting(sp.key, !this.cb.getSettings()[sp.key]); },
        });
      }
    }
    const n = SETTINGS_SCHEMA.length;
    const by = c.y + n * (rh + gap) + Math.round(10 * s);
    this._add({
      kind: 'button', row: n, col: 0, label: 'Restore Defaults', icon: 'sandglass', small: true,
      rect: { x: c.x, y: by, w: Math.round(230 * s), h: Math.round(44 * s) },
      action: () => { this.cb.resetSettings(); this.cb.toast('Settings restored', 'info'); },
    });
    this._add({
      kind: 'button', row: n, col: 1, label: 'Back', icon: 'compass', small: true,
      rect: { x: c.x + Math.round(244 * s), y: by, w: Math.round(160 * s), h: Math.round(44 * s) },
      action: () => this.back(),
    });
  }

  _adjustChoice(sp, dir) {
    const cur = this.cb.getSettings()[sp.key];
    let i = sp.options.findIndex((o) => o === cur);
    if (i < 0) i = 0;
    i = (i + (dir || 1) + sp.options.length) % sp.options.length;
    this.cb.setSetting(sp.key, sp.options[i]);
  }

  _buildFruit() {
    const s = this.s, c = this._content();
    const fruits = this.cb.getFruits() || [];
    const known = fruits.filter((f) => f.unlocked !== false);
    this.sel.fruit = fruits.length ? clamp(this.sel.fruit, 0, fruits.length - 1) : 0;
    const cx = c.x + c.w * 0.30, cy = c.y + c.h * 0.5;
    const R = Math.min(c.h * 0.36, 200 * s);
    this.wheel = { cx, cy, R, count: fruits.length };
    for (let i = 0; i < fruits.length; i++) {
      const a = -Math.PI / 2 + (i / Math.max(1, fruits.length)) * TAU;
      const px = cx + Math.cos(a) * R, py = cy + Math.sin(a) * R;
      const r = Math.round(38 * s);
      this._add({
        kind: 'wheelslot', row: 0, col: i, index: i, fruit: fruits[i], horizontal: true,
        rect: { x: px - r, y: py - r, w: r * 2, h: r * 2 }, cx: px, cy: py, r,
        action: () => { this.sel.fruit = i; },
      });
    }
    const sel = fruits[this.sel.fruit];
    const py2 = c.y + c.h - Math.round(64 * s);
    if (sel && sel.unlocked !== false) {
      this._add({
        kind: 'button', row: 1, col: 0, label: sel.equipped ? 'Equipped' : 'Eat This Fruit',
        icon: 'flame', small: true,
        rect: { x: c.x + c.w * 0.56, y: py2, w: Math.round(250 * s), h: Math.round(46 * s) },
        action: () => {
          if (sel.equipped) { this.cb.toast(sel.name + ' already coursing through you', 'info'); return; }
          this.cb.selectFruit(sel.id)
            ? this.cb.toast(sel.name + ' devoured', 'good')
            : this.cb.toast('That fruit resists you', 'bad');
        },
      });
    }
    this._add({
      kind: 'button', row: 1, col: 1, label: 'Back', icon: 'compass', small: true,
      rect: { x: c.x + c.w - Math.round(160 * s), y: py2, w: Math.round(160 * s), h: Math.round(46 * s) },
      action: () => this.back(),
    });
    if (!known.length) this.sel.fruit = 0;
  }

  _buildCrew() {
    const s = this.s, c = this._content();
    const crew = this.cb.getCrew() || [];
    this.sel.crew = crew.length ? clamp(this.sel.crew, 0, crew.length - 1) : 0;
    const listW = Math.round(c.w * 0.38);
    const rh = Math.round(52 * s);
    for (let i = 0; i < crew.length && i < 9; i++) {
      this._add({
        kind: 'listrow', row: i, col: 0, index: i, item: crew[i], selected: i === this.sel.crew,
        rect: { x: c.x, y: c.y + i * (rh + 6 * s), w: listW, h: rh },
        action: () => { this.sel.crew = i; },
      });
    }
    const m = crew[this.sel.crew];
    const rows = Math.min(crew.length, 9);
    if (m) {
      this._add({
        kind: 'button', row: rows, col: 0, small: true, icon: 'wheel',
        label: 'Station: ' + (m.station || CREW_STATIONS[0]),
        rect: { x: c.x + listW + Math.round(24 * s), y: c.y + c.h - Math.round(58 * s), w: Math.round(300 * s), h: Math.round(46 * s) },
        action: (dir) => {
          const cur = CREW_STATIONS.indexOf(m.station || CREW_STATIONS[0]);
          const next = CREW_STATIONS[((cur < 0 ? 0 : cur) + (dir || 1) + CREW_STATIONS.length) % CREW_STATIONS.length];
          this.cb.assignCrew(m.id, next);
          this.cb.toast(m.name + ' takes the ' + next.toLowerCase(), 'crew');
        },
        horizontal: true,
      });
    }
    this._backButton(rows + (m ? 1 : 0));
  }

  _buildQuests() {
    const s = this.s, c = this._content();
    const quests = this.cb.getQuests() || [];
    this.sel.quest = quests.length ? clamp(this.sel.quest, 0, quests.length - 1) : 0;
    const listW = Math.round(c.w * 0.40);
    const rh = Math.round(50 * s);
    for (let i = 0; i < quests.length && i < 9; i++) {
      this._add({
        kind: 'listrow', row: i, col: 0, index: i, item: quests[i], selected: i === this.sel.quest,
        rect: { x: c.x, y: c.y + i * (rh + 6 * s), w: listW, h: rh },
        action: () => { this.sel.quest = i; },
      });
    }
    const q = quests[this.sel.quest];
    const rows = Math.min(quests.length, 9);
    const by = c.y + c.h - Math.round(58 * s);
    let col = 0;
    if (q) {
      this._add({
        kind: 'button', row: rows, col: col++, small: true, icon: 'compass',
        label: q.tracked ? 'Tracked' : 'Track Quest',
        rect: { x: c.x + listW + Math.round(24 * s), y: by, w: Math.round(220 * s), h: Math.round(46 * s) },
        action: () => {
          this.cb.setTrackedQuest(q.id);
          this.cb.toast('Tracking ' + q.title, 'quest');
        },
      });
      if (q.canAbandon) {
        this._add({
          kind: 'button', row: rows, col: col++, small: true, icon: 'skull', danger: true, label: 'Abandon',
          rect: { x: c.x + listW + Math.round(256 * s), y: by, w: Math.round(180 * s), h: Math.round(46 * s) },
          action: () => { this.cb.abandonQuest(q.id); this.cb.toast(q.title + ' abandoned', 'warn'); },
        });
      }
    }
    this._add({
      kind: 'button', row: rows, col, small: true, icon: 'compass', label: 'Back',
      rect: { x: c.x + c.w - Math.round(160 * s), y: by, w: Math.round(160 * s), h: Math.round(46 * s) },
      action: () => this.back(),
    });
  }

  _buildBounty() {
    const s = this.s;
    const subs = this.cb.getBountySubjects() || [];
    this.sel.bounty = subs.length ? clamp(this.sel.bounty, 0, subs.length - 1) : 0;
    const ph = Math.min(this.h - 120 * s, 880 * s);
    const pw = ph * 0.68;
    this.posterRect = {
      x: Math.round(this.w / 2 - pw / 2), y: Math.round(this.h / 2 - ph / 2 - 12 * s),
      w: Math.round(pw), h: Math.round(ph),
    };
    const by = this.posterRect.y + this.posterRect.h + Math.round(16 * s);
    const bw = Math.round(150 * s), bh = Math.round(44 * s);
    if (subs.length > 1) {
      this._add({
        kind: 'button', row: 0, col: 0, small: true, icon: 'compass', label: 'Previous',
        rect: { x: this.posterRect.x, y: by, w: bw, h: bh },
        action: () => { this.sel.bounty = (this.sel.bounty - 1 + subs.length) % subs.length; this._poster = null; },
      });
      this._add({
        kind: 'button', row: 0, col: 1, small: true, icon: 'compass', label: 'Next',
        rect: { x: this.posterRect.x + bw + Math.round(10 * s), y: by, w: bw, h: bh },
        action: () => { this.sel.bounty = (this.sel.bounty + 1) % subs.length; this._poster = null; },
      });
    }
    this._add({
      kind: 'button', row: 0, col: 2, small: true, icon: 'anchor', label: 'Back',
      rect: { x: this.posterRect.x + this.posterRect.w - bw, y: by, w: bw, h: bh },
      action: () => this.back(),
    });
  }

  _backButton(row) {
    const s = this.s, c = this._content();
    this._add({
      kind: 'button', row, col: 0, label: 'Back', icon: 'compass', small: true,
      rect: { x: c.x, y: c.y + c.h - Math.round(50 * s), w: Math.round(180 * s), h: Math.round(46 * s) },
      action: () => this.back(),
    });
  }

  // ------------------------------------------------------------------ drawing

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    if (!this.isOpen && this.anim <= 0.001) return;
    this._build();
    const s = this.s;
    const a = this.anim;
    scrim(ctx, this.w, this.h, 0.66 * a);
    ctx.save();
    ctx.globalAlpha = a;

    if (this.name === MENU.BOUNTY) {
      this._drawBountyPage(ctx);
    } else {
      const b = this.board;
      const lift = (1 - a) * 26 * s;
      ctx.translate(0, lift);
      panel(ctx, b.x, b.y, b.w, b.h, { rope: true, amp: 4, seed: 0xb0a2, accent: mixHex(P.uiPaper, P.uiInk, 0.2) });
      const title = {
        pause: 'PAUSED', save: 'SHIP\'S LOG', settings: 'SETTINGS',
        fruit: 'DEVIL FRUIT', crew: 'CREW ROSTER', quests: 'QUEST LOG',
      }[this.name] || '';
      ribbon(ctx, b.x + Math.round(24 * s), b.y - Math.round(16 * s), Math.round(Math.min(b.w * 0.52, 420 * s)), Math.round(48 * s), {
        color: P.uiRed, text: title, size: Math.round(24 * s),
      });
      this._drawStatusStrip(ctx);
      switch (this.name) {
        case MENU.PAUSE: this._drawItems(ctx); break;
        case MENU.SAVE: this._drawSave(ctx); break;
        case MENU.SETTINGS: this._drawSettings(ctx); break;
        case MENU.FRUIT: this._drawFruit(ctx); break;
        case MENU.CREW: this._drawCrew(ctx); break;
        case MENU.QUESTS: this._drawQuests(ctx); break;
        default: this._drawItems(ctx); break;
      }
      this._drawFooter(ctx);
    }
    ctx.restore();
  }

  _drawStatusStrip(ctx) {
    const s = this.s, b = this.board;
    const st = this.cb.getStatus() || {};
    const y = b.y + Math.round(46 * s);
    drawText(ctx, `${String(st.place || 'OPEN SEA').toUpperCase()}   ·   ${fmtTime(st.playtime)}   ·   LV ${st.level || 1}   ·   ${BERRY}${commify(st.bounty || 0)}`,
      b.x + b.w - Math.round(26 * s), y, {
        size: Math.round(12 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.35), align: 'right',
      });
  }

  _drawFooter(ctx) {
    const s = this.s, b = this.board;
    const y = b.y + b.h - Math.round(30 * s);
    const hints = [['Move', 'W/S'], ['Adjust', 'A/D'], ['Select', 'ENTER'], ['Back', 'ESC']];
    let x = b.x + Math.round(28 * s);
    for (const [label, k] of hints) {
      const cap = keyCap(ctx, x, y - Math.round(6 * s), k, { size: Math.round(10 * s) });
      drawText(ctx, label, x + cap.w + Math.round(6 * s), y + Math.round(4 * s), {
        size: Math.round(11 * s), color: mixHex(P.uiInk, P.uiPaper, 0.3),
      });
      x += cap.w + Math.round(12 * s) + measure(label, Math.round(11 * s), 'body').w + Math.round(18 * s);
    }
  }

  _isFocused(it) { return it.row === this.cursor.row && it.col === this.cursor.col && it.focusable !== false; }

  _drawButton(ctx, it) {
    const s = this.s;
    const r = it.rect;
    const foc = this._isFocused(it);
    const base = it.danger ? mixHex(P.uiPaper, P.uiRed, 0.28) : P.uiPaper;
    const fill = foc ? mixHex(base, P.uiGold, 0.45) : base;
    ctx.fillStyle = toCss(shadeDown(fill, 0.7));
    ctx.fill(roundRectPath(r.x, r.y + 4, r.w, r.h, 7));
    ctx.fillStyle = toCss(fill);
    ctx.fill(roundRectPath(r.x, r.y, r.w, r.h, 7));
    ctx.strokeStyle = toCss(foc ? P.uiInk : mixHex(P.uiInk, P.uiPaper, 0.35));
    ctx.lineWidth = foc ? 4 : 3;
    ctx.stroke(roundRectPath(r.x, r.y, r.w, r.h, 7));

    const size = Math.round((it.small ? 15 : 20) * s);
    let tx = r.x + Math.round(18 * s);
    if (it.icon) {
      const isz = Math.round(r.h * 0.5);
      icon(ctx, it.icon, r.x + Math.round(14 * s), r.y + r.h / 2 - isz / 2, isz,
        it.danger ? P.uiRed : shadeDown(P.uiGold, 0.5));
      tx = r.x + Math.round(20 * s) + isz;
    }
    drawText(ctx, it.label, tx, r.y + r.h / 2, {
      size, weight: it.small ? 'body' : 'display', color: P.uiInk, baseline: 'middle',
      maxWidth: r.w - (tx - r.x) - Math.round(14 * s),
    });
    if (foc) {
      waxSeal(ctx, r.x + r.w - Math.round(20 * s), r.y + r.h / 2, Math.round(11 * s),
        { color: it.danger ? P.uiRed : P.uiRed, seed: 0x33 });
    }
  }

  _drawItems(ctx) {
    for (const it of this._items) if (it.kind === 'button') this._drawButton(ctx, it);
  }

  _drawSave(ctx) {
    const s = this.s;
    for (const it of this._items) {
      if (it.kind !== 'card') continue;
      const r = it.rect, slot = it.slot;
      const foc = this._items.some((o) => o.row === it.row && this._isFocused(o));
      panel(ctx, r.x, r.y, r.w, r.h, {
        fill: foc ? mixHex(P.uiPaper, P.uiGold, 0.2) : mixHex(P.uiPaper, P.uiPaperDark, 0.3),
        seed: 0x4000 + it.row, amp: 2.6, accent: foc ? P.uiGold : undefined,
      });
      drawText(ctx, 'SLOT ' + (it.row + 1), r.x + Math.round(20 * s), r.y + Math.round(16 * s), {
        size: Math.round(18 * s), weight: 'display', color: mixHex(P.uiInk, P.uiPaper, 0.25),
      });
      if (slot.empty) {
        drawText(ctx, 'no voyage recorded', r.x + Math.round(20 * s), r.y + Math.round(48 * s), {
          size: Math.round(16 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.5),
        });
      } else {
        drawText(ctx, slot.name || 'Voyage', r.x + Math.round(20 * s), r.y + Math.round(44 * s), {
          size: Math.round(20 * s), weight: 'display', color: P.uiInk,
        });
        const line = `LV ${slot.level || 1}   ${BERRY}${commify(slot.bounty || 0)}   ${slot.place || 'Open Sea'}`;
        drawText(ctx, line, r.x + Math.round(20 * s), r.y + Math.round(72 * s), {
          size: Math.round(14 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.15),
        });
        drawText(ctx, `${fmtTime(slot.playtime)} sailed   ·   ${slot.savedAt || ''}`,
          r.x + Math.round(20 * s), r.y + Math.round(94 * s), {
            size: Math.round(12 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.4),
          });
        nail(ctx, r.x + r.w - Math.round(18 * s), r.y + Math.round(18 * s), Math.round(6 * s));
      }
    }
    this._drawItems(ctx);
  }

  _drawSettings(ctx) {
    const s = this.s;
    const st = this.cb.getSettings();
    for (const it of this._items) {
      if (it.kind === 'button') { this._drawButton(ctx, it); continue; }
      const r = it.rect, sp = it.spec, foc = this._isFocused(it);
      if (foc) {
        ctx.fillStyle = toCss(P.uiGold, 0.3);
        ctx.fill(roundRectPath(r.x - 8, r.y, r.w + 16, r.h, 6));
      }
      drawText(ctx, sp.label, r.x + Math.round(8 * s), r.y + r.h / 2, {
        size: Math.round(16 * s), weight: 'body', color: P.uiInk, baseline: 'middle',
      });
      const tr = it.track;
      if (sp.kind === 'slider') {
        const v = Number(st[sp.key]);
        const t = clamp01((v - sp.min) / (sp.max - sp.min));
        bar(ctx, tr.x, tr.y, tr.w, tr.h, {
          value: t, max: 1, color: foc ? P.uiGold : P.uiCyan, perSegment: 0,
        });
        const kx = tr.x + tr.w * t;
        waxSeal(ctx, kx, tr.y + tr.h / 2, Math.round(11 * s), { color: foc ? P.uiRed : P.uiInk, seed: 0x21 });
        drawText(ctx, sp.fmt ? sp.fmt(v) : Math.round(v * 100) + '%',
          r.x + r.w - Math.round(10 * s), r.y + r.h / 2, {
            size: Math.round(15 * s), weight: 'display', color: P.uiInk, align: 'right', baseline: 'middle',
          });
      } else if (sp.kind === 'choice') {
        const i = Math.max(0, sp.options.findIndex((o) => o === st[sp.key]));
        const cxm = tr.x + tr.w / 2;
        drawText(ctx, '<', tr.x, r.y + r.h / 2, { size: Math.round(18 * s), weight: 'display', color: foc ? P.uiRed : P.uiInk, baseline: 'middle' });
        drawText(ctx, '>', tr.x + tr.w, r.y + r.h / 2, { size: Math.round(18 * s), weight: 'display', color: foc ? P.uiRed : P.uiInk, align: 'right', baseline: 'middle' });
        drawText(ctx, sp.labels[i], cxm, r.y + r.h / 2, {
          size: Math.round(16 * s), weight: 'display', color: P.uiInk, align: 'center', baseline: 'middle',
        });
        if (sp.preview === 'telegraph') {
          // The setting demonstrates itself: three live telegraph marks in the chosen mode.
          const mode = sp.options[i];
          const kinds = ['warn', 'guard', 'danger'];
          for (let k = 0; k < 3; k++) {
            const px = r.x + r.w - Math.round((92 - k * 30) * s);
            telegraphGlyph(ctx, kinds[k], px, r.y + r.h / 2, Math.round(19 * s), telegraphColor(kinds[k], mode));
          }
        } else {
          drawText(ctx, String(sp.labels[i]), r.x + r.w - Math.round(10 * s), r.y + r.h / 2, {
            size: Math.round(13 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.45),
            align: 'right', baseline: 'middle',
          });
        }
      } else {
        const on = !!st[sp.key];
        const tw = Math.round(72 * s), th = Math.round(30 * s);
        const tx = tr.x, ty = r.y + r.h / 2 - th / 2;
        ctx.fillStyle = toCss(on ? P.uiGreen : mixHex(P.uiPaperDark, P.uiInk, 0.35));
        ctx.fill(roundRectPath(tx, ty, tw, th, th / 2));
        ctx.strokeStyle = toCss(P.uiInk); ctx.lineWidth = 3;
        ctx.stroke(roundRectPath(tx, ty, tw, th, th / 2));
        waxSeal(ctx, tx + (on ? tw - th / 2 : th / 2), ty + th / 2, th / 2 - 2, { color: foc ? P.uiRed : P.uiPaper, seed: 0x77 });
        drawText(ctx, on ? 'ON' : 'OFF', tx + tw + Math.round(12 * s), r.y + r.h / 2, {
          size: Math.round(14 * s), weight: 'display', color: P.uiInk, baseline: 'middle',
        });
      }
    }
  }

  _drawFruit(ctx) {
    const s = this.s, c = this._content();
    const fruits = this.cb.getFruits() || [];
    if (!fruits.length) {
      drawText(ctx, 'You have eaten no devil fruit.', c.x, c.y + c.h * 0.4, {
        size: Math.round(20 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.3),
      });
      this._drawItems(ctx);
      return;
    }
    const w = this.wheel;
    // Wheel spokes, drawn first so the tokens sit on top.
    ctx.strokeStyle = toCss(P.uiInk, 0.3);
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(w.cx, w.cy, w.R, 0, TAU); ctx.stroke();

    for (const it of this._items) {
      if (it.kind !== 'wheelslot') continue;
      const f = it.fruit;
      const locked = f.unlocked === false;
      const selected = it.index === this.sel.fruit;
      const foc = this._isFocused(it);
      const r = it.r * (selected ? 1.12 : 1);
      ctx.fillStyle = toCss(locked ? mixHex(P.uiPaperDark, P.uiInk, 0.4) : mixHex(P.uiPaper, f.color === undefined ? P.fruitGomu : f.color, 0.45));
      ctx.beginPath(); ctx.arc(it.cx, it.cy, r, 0, TAU); ctx.fill();
      icon(ctx, locked ? 'skull' : (f.icon || 'flame'), it.cx - r * 0.55, it.cy - r * 0.55, r * 1.1,
        locked ? mixHex(P.uiInk, P.uiPaper, 0.4) : shadeDown(f.color === undefined ? P.fruitGomu : f.color, 1));
      ctx.strokeStyle = toCss(foc || selected ? P.uiGold : P.uiInk);
      ctx.lineWidth = foc || selected ? 5 : 3;
      ctx.beginPath(); ctx.arc(it.cx, it.cy, r, 0, TAU); ctx.stroke();
      if (f.equipped) {
        drawText(ctx, 'EATEN', it.cx, it.cy + r + Math.round(6 * s), {
          size: Math.round(10 * s), weight: 'display', color: P.uiWhite, align: 'center',
          outline: P.uiInk, outlineWidth: 1,
        });
      }
    }

    const sel = fruits[this.sel.fruit];
    const dx = c.x + c.w * 0.56, dy = c.y + Math.round(10 * s);
    const dw = c.w * 0.44;
    const locked = sel.unlocked === false;
    ribbon(ctx, dx, dy, Math.round(dw), Math.round(40 * s), {
      color: locked ? P.uiInk : (sel.color === undefined ? P.fruitGomu : sel.color),
      text: locked ? 'UNDISCOVERED' : String(sel.name).toUpperCase(), size: Math.round(19 * s),
    });
    drawText(ctx, locked ? 'A rumour on the wind. Find it, and it is yours.' : (sel.desc || ''),
      dx + Math.round(6 * s), dy + Math.round(58 * s), {
        size: Math.round(15 * s), weight: 'body', color: P.uiInk, maxWidth: dw - Math.round(12 * s),
      });
    if (!locked && sel.abilities) {
      let ay = dy + Math.round(150 * s);
      for (let i = 0; i < sel.abilities.length; i++) {
        const ab = sel.abilities[i];
        icon(ctx, ab.icon || 'star', dx + Math.round(6 * s), ay, Math.round(24 * s),
          shadeDown(sel.color === undefined ? P.fruitGomu : sel.color, 0.8));
        drawText(ctx, String(ab.name).toUpperCase(), dx + Math.round(38 * s), ay + Math.round(4 * s), {
          size: Math.round(14 * s), weight: 'display', color: P.uiInk,
        });
        ay += Math.round(34 * s);
      }
    }
    this._drawItems(ctx);
  }

  _drawCrew(ctx) {
    const s = this.s, c = this._content();
    const crew = this.cb.getCrew() || [];
    const listW = Math.round(c.w * 0.38);
    for (const it of this._items) {
      if (it.kind === 'button') { this._drawButton(ctx, it); continue; }
      if (it.kind !== 'listrow') continue;
      const r = it.rect, foc = this._isFocused(it);
      ctx.fillStyle = toCss(it.selected ? mixHex(P.uiPaper, P.uiGold, 0.4) : mixHex(P.uiPaper, P.uiPaperDark, 0.45));
      ctx.fill(roundRectPath(r.x, r.y, r.w, r.h, 6));
      ctx.strokeStyle = toCss(foc ? P.uiInk : mixHex(P.uiInk, P.uiPaper, 0.5));
      ctx.lineWidth = foc ? 4 : 2.5;
      ctx.stroke(roundRectPath(r.x, r.y, r.w, r.h, 6));
      const m = it.item;
      this._drawPortrait(ctx, r.x + Math.round(6 * s), r.y + Math.round(5 * s), r.h - Math.round(10 * s), m.seed || hashString(m.id || m.name || 'x'));
      drawText(ctx, m.name || '', r.x + r.h + Math.round(4 * s), r.y + Math.round(10 * s), {
        size: Math.round(16 * s), weight: 'display', color: P.uiInk,
      });
      drawText(ctx, String(m.station || m.role || '').toUpperCase(), r.x + r.h + Math.round(4 * s), r.y + Math.round(30 * s), {
        size: Math.round(11 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.35),
      });
    }
    const m = crew[this.sel.crew];
    if (!m) {
      drawText(ctx, 'You sail alone. For now.', c.x, c.y + Math.round(10 * s), {
        size: Math.round(20 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.3),
      });
      return;
    }
    const dx = c.x + listW + Math.round(24 * s);
    const dw = c.w - listW - Math.round(24 * s);
    this._drawPortrait(ctx, dx, c.y, Math.round(150 * s), m.seed || hashString(m.id || m.name || 'x'), true);
    drawText(ctx, String(m.name).toUpperCase(), dx + Math.round(168 * s), c.y + Math.round(8 * s), {
      size: Math.round(26 * s), weight: 'display', color: P.uiInk,
    });
    drawText(ctx, String(m.role || '').toUpperCase() + '   ·   LV ' + (m.level || 1),
      dx + Math.round(168 * s), c.y + Math.round(44 * s), {
        size: Math.round(13 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.3),
      });
    drawText(ctx, m.bio || '', dx, c.y + Math.round(170 * s), {
      size: Math.round(15 * s), weight: 'body', color: P.uiInk, maxWidth: dw,
    });
  }

  _drawQuests(ctx) {
    const s = this.s, c = this._content();
    const quests = this.cb.getQuests() || [];
    const listW = Math.round(c.w * 0.40);
    for (const it of this._items) {
      if (it.kind === 'button') { this._drawButton(ctx, it); continue; }
      if (it.kind !== 'listrow') continue;
      const r = it.rect, foc = this._isFocused(it);
      const q = it.item;
      const done = q.state === 'done';
      ctx.fillStyle = toCss(it.selected ? mixHex(P.uiPaper, P.uiGold, 0.4) : mixHex(P.uiPaper, P.uiPaperDark, 0.45));
      ctx.fill(roundRectPath(r.x, r.y, r.w, r.h, 6));
      ctx.strokeStyle = toCss(foc ? P.uiInk : mixHex(P.uiInk, P.uiPaper, 0.5));
      ctx.lineWidth = foc ? 4 : 2.5;
      ctx.stroke(roundRectPath(r.x, r.y, r.w, r.h, 6));
      icon(ctx, done ? 'star' : 'scroll', r.x + Math.round(10 * s), r.y + r.h / 2 - Math.round(11 * s),
        Math.round(22 * s), done ? P.uiGreen : P.royalPurple);
      drawText(ctx, q.title || '', r.x + Math.round(42 * s), r.y + Math.round(8 * s), {
        size: Math.round(15 * s), weight: 'display', color: done ? mixHex(P.uiInk, P.uiPaper, 0.35) : P.uiInk,
        maxWidth: r.w - Math.round(56 * s),
      });
      drawText(ctx, (q.tracked ? 'TRACKED · ' : '') + String(q.state || 'active').toUpperCase(),
        r.x + Math.round(42 * s), r.y + Math.round(30 * s), {
          size: Math.round(10 * s), weight: 'body', color: q.tracked ? P.uiGold : mixHex(P.uiInk, P.uiPaper, 0.4),
        });
    }
    const q = quests[this.sel.quest];
    if (!q) {
      drawText(ctx, 'No quests yet. Talk to someone.', c.x, c.y + Math.round(10 * s), {
        size: Math.round(20 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.3),
      });
      return;
    }
    const dx = c.x + listW + Math.round(24 * s);
    const dw = c.w - listW - Math.round(24 * s);
    drawText(ctx, String(q.title).toUpperCase(), dx, c.y, {
      size: Math.round(24 * s), weight: 'display', color: P.uiInk, maxWidth: dw,
    });
    drawText(ctx, 'GIVEN BY ' + String(q.giver || 'UNKNOWN').toUpperCase(), dx, c.y + Math.round(34 * s), {
      size: Math.round(12 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.35),
    });
    let y = c.y + Math.round(64 * s);
    for (const step of q.steps || []) {
      // A ticked step gets a struck-through line drawn as a brush stroke, not a text effect.
      icon(ctx, step.done ? 'star' : 'compass', dx, y, Math.round(16 * s),
        step.done ? P.uiGreen : mixHex(P.uiInk, P.uiPaper, 0.35));
      const tm = drawText(ctx, step.text, dx + Math.round(26 * s), y, {
        size: Math.round(14 * s), weight: 'body',
        color: step.done ? mixHex(P.uiInk, P.uiPaper, 0.45) : P.uiInk,
        maxWidth: dw - Math.round(26 * s),
      });
      if (step.done) {
        inkStroke(ctx, [[dx + 24 * s, y + tm.h * 0.45], [dx + 26 * s + tm.w, y + tm.h * 0.4]], 3, P.uiInk, 0.5);
      }
      y += tm.h + Math.round(12 * s);
    }
    if (q.reward) {
      y += Math.round(10 * s);
      icon(ctx, 'coin', dx, y, Math.round(20 * s), P.gold);
      drawText(ctx, 'REWARD: ' + q.reward, dx + Math.round(28 * s), y + Math.round(2 * s), {
        size: Math.round(14 * s), weight: 'display', color: shadeDown(P.gold, 0.6), maxWidth: dw,
      });
    }
  }

  // ------------------------------------------------------------------ bounty poster

  _drawBountyPage(ctx) {
    const s = this.s;
    const subs = this.cb.getBountySubjects() || [];
    const r = this.posterRect;
    if (!subs.length) {
      panel(ctx, r.x, r.y, r.w, r.h, { amp: 6, seed: 0xbb });
      drawText(ctx, 'NO BOUNTY YET', r.x + r.w / 2, r.y + r.h / 2, {
        size: Math.round(34 * s), weight: 'display', color: P.uiInk, align: 'center', baseline: 'middle',
      });
      this._drawItems(ctx);
      return;
    }
    const sub = subs[clamp(this.sel.bounty, 0, subs.length - 1)];
    const key = `${sub.id || sub.name}|${sub.amount}|${r.w}x${r.h}|${sub.alive}`;
    if (!this._poster || this._poster.key !== key) {
      const cv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
      if (cv) {
        cv.width = r.w; cv.height = r.h;
        const c2 = cv.getContext('2d');
        this._paintPoster(c2, r.w, r.h, sub);
        this._poster = { key, canvas: cv };
      }
    }
    if (this._poster) ctx.drawImage(this._poster.canvas, r.x, r.y);
    else this._paintPosterInto(ctx, r, sub);
    // Nails go on the live canvas so they sit above the cached paper and cast onto the scrim.
    nail(ctx, r.x + Math.round(30 * s), r.y + Math.round(26 * s), Math.round(8 * s));
    nail(ctx, r.x + r.w - Math.round(30 * s), r.y + Math.round(26 * s), Math.round(8 * s));
    this._drawItems(ctx);
    if (subs.length > 1) {
      drawText(ctx, `${this.sel.bounty + 1} / ${subs.length}`, this.w / 2, r.y + r.h + Math.round(38 * s), {
        size: Math.round(14 * s), weight: 'display', color: P.uiPaper, align: 'center',
        outline: P.uiShadow, outlineWidth: 1,
      });
    }
  }

  _paintPosterInto(ctx, r, sub) {
    ctx.save();
    ctx.translate(r.x, r.y);
    this._paintPoster(ctx, r.w, r.h, sub);
    ctx.restore();
  }

  /** Paint a complete wanted poster into a w x h context origin. Deterministic per subject. */
  _paintPoster(ctx, w, h, sub) {
    const seed = (sub.seed !== undefined ? sub.seed : hashString(String(sub.id || sub.name))) >>> 0;
    const u = w / 620; // one design unit; the poster is authored at 620px wide
    ctx.save();
    ctx.lineJoin = 'round';
    panel(ctx, 6 * u, 6 * u, w - 12 * u, h - 12 * u, {
      fill: mixHex(P.paper, P.uiPaperDark, 0.28), amp: 7, seed, border: 0, shadow: false,
    });

    // Header
    drawText(ctx, 'WANTED', w / 2, 24 * u, {
      size: Math.round(78 * u), weight: 'display', color: P.ink, align: 'center',
    });
    inkStroke(ctx, [[52 * u, 120 * u], [w - 52 * u, 118 * u]], 5 * u, P.ink, 0.85);

    // Portrait window
    const px = 78 * u, py = 138 * u, pw = w - 156 * u, ph = pw * 0.92;
    ctx.fillStyle = toCss(mixHex(P.skyHorizon, P.paper, 0.35));
    ctx.fillRect(px, py, pw, ph);
    this._drawPortrait(ctx, px, py, Math.min(pw, ph), seed, true, pw, ph);
    ctx.strokeStyle = toCss(P.ink);
    ctx.lineWidth = 5 * u;
    ctx.strokeRect(px, py, pw, ph);

    // Dead or alive
    ribbon(ctx, 70 * u, py + ph + 10 * u, w - 140 * u, 44 * u, {
      color: sub.alive === false ? P.pirateBlack : P.uiRed,
      text: sub.alive === false ? 'DEAD' : 'DEAD OR ALIVE',
      size: Math.round(26 * u), notch: 16 * u, textColor: P.uiWhite,
    });

    // Name and epithet
    const ny = py + ph + 74 * u;
    drawText(ctx, String(sub.name || 'UNKNOWN').toUpperCase(), w / 2, ny, {
      size: Math.round(48 * u), weight: 'display', color: P.ink, align: 'center',
      maxWidth: w - 80 * u,
    });
    if (sub.epithet) {
      drawText(ctx, '"' + sub.epithet + '"', w / 2, ny + 58 * u, {
        size: Math.round(20 * u), weight: 'body', color: mixHex(P.ink, P.paper, 0.25), align: 'center',
        maxWidth: w - 100 * u,
      });
    }

    // Sum
    const sy = ny + 92 * u;
    drawText(ctx, BERRY + commify(sub.amount || 0) + '-', w / 2, sy, {
      size: Math.round(46 * u), weight: 'display', color: P.ink, align: 'center', maxWidth: w - 60 * u,
    });

    // Authority line + seal + signature
    drawText(ctx, 'MARINE HEADQUARTERS', w / 2, h - 92 * u, {
      size: Math.round(16 * u), weight: 'display', color: mixHex(P.ink, P.paper, 0.2), align: 'center',
    });
    if (sub.crew) {
      drawText(ctx, String(sub.crew).toUpperCase(), w / 2, h - 116 * u, {
        size: Math.round(13 * u), weight: 'body', color: mixHex(P.ink, P.paper, 0.4), align: 'center',
      });
    }
    waxSeal(ctx, w - 92 * u, h - 78 * u, 40 * u, { color: P.uiRed, icon: 'anchor', seed: seed ^ 0x99 });
    inkStroke(ctx, [
      [66 * u, h - 56 * u], [110 * u, h - 78 * u], [150 * u, h - 46 * u],
      [196 * u, h - 76 * u], [240 * u, h - 54 * u],
    ], 4 * u, P.ink, 0.8);

    // Age: coffee rings and a torn corner, hashed so the same poster is always the same.
    for (let i = 0; i < 3; i++) {
      const rx = hashFloat(hash2(i, seed, 31)) * w;
      const ry = hashFloat(hash2(i, seed, 32)) * h;
      const rr = (18 + hashFloat(hash2(i, seed, 33)) * 40) * u;
      ctx.strokeStyle = toCss(mixHex(P.paper, P.dirtDark, 0.5), 0.18);
      ctx.lineWidth = 4 * u;
      ctx.beginPath(); ctx.arc(rx, ry, rr, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = toCss(P.uiShadow, 0.0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(w, h - 66 * u);
    ctx.lineTo(w - 20 * u, h - 40 * u);
    ctx.lineTo(w - 46 * u, h);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  /**
   * A chunky voxel portrait, drawn as blocks. Follows ART_BAR §1/§2: large dark angular eyes,
   * a wide dark mouth aperture with a tooth band, headgear that breaks the head silhouette,
   * and one asymmetric identity mark.
   */
  _drawPortrait(ctx, x, y, size, seed, detailed = false, boxW, boxH) {
    const W = boxW || size, H = boxH || size;
    const g = size / 16;                       // one portrait voxel
    const cx = x + W / 2;
    const rnd = (t) => hashFloat(hash2(seed, t, 0x71));

    const skins = [P.skin, P.skinTan, P.skinPale, P.skinDark];
    const hairs = [P.hair, P.hairBrown, P.hairGinger, P.hairBlonde, P.hairGreen, P.hairWhite];
    const cloth = [P.heroRed, P.marineBlue, P.pirateMaroon, P.fishmanTeal, P.bruiserOrange, P.royalPurple];
    const skin = skins[Math.floor(rnd(1) * skins.length)];
    const hair = hairs[Math.floor(rnd(2) * hairs.length)];
    const vest = cloth[Math.floor(rnd(3) * cloth.length)];
    const hasHat = rnd(4) > 0.35;
    const hatCol = rnd(5) > 0.5 ? P.strawHat : P.pirateBlack;
    const scarSide = rnd(6) > 0.5 ? 1 : -1;

    const top = y + H * (detailed ? 0.14 : 0.10);
    const headW = g * 9, headH = g * 8;
    const hx = cx - headW / 2;

    // Shoulders first, so the head overlaps them.
    ctx.fillStyle = toCss(vest);
    ctx.fillRect(cx - g * 7, top + headH + g * 1.2, g * 14, H - (top - y) - headH - g * 1.2);
    ctx.fillStyle = toCss(shadeDown(vest, 0.55));
    ctx.fillRect(cx - g * 7, top + headH + g * 1.2, g * 14, g * 0.9);
    ctx.fillStyle = toCss(shadeUp(vest, 0.6));
    ctx.fillRect(cx - g * 7, top + headH + g * 2.1, g * 1.4, H - (top - y) - headH - g * 2.1);

    // Neck
    ctx.fillStyle = toCss(shadeDown(skin, 0.5));
    ctx.fillRect(cx - g * 1.6, top + headH - g * 0.4, g * 3.2, g * 2);

    // Head: three tonal steps within one surface (ART_BAR §4).
    ctx.fillStyle = toCss(skin);
    ctx.fillRect(hx, top, headW, headH);
    ctx.fillStyle = toCss(shadeUp(skin, 0.55));
    ctx.fillRect(hx, top, headW, g * 0.9);
    ctx.fillStyle = toCss(shadeDown(skin, 0.45));
    ctx.fillRect(hx + headW - g * 1.1, top + g * 0.9, g * 1.1, headH - g * 0.9);

    // Hair mass
    ctx.fillStyle = toCss(hair);
    ctx.fillRect(hx - g * 0.4, top - g * 1.2, headW + g * 0.8, g * 2.4);
    ctx.fillRect(hx - g * 0.4, top - g * 1.2, g * 1.2, g * 5);
    ctx.fillRect(hx + headW - g * 0.8, top - g * 1.2, g * 1.2, g * 5);

    // Eyes: 2x2-voxel dark angular blocks with a brow wedge above.
    const ey = top + g * 3.2;
    ctx.fillStyle = toCss(P.eyeDark);
    ctx.fillRect(hx + g * 1.6, ey, g * 2, g * 2.2);
    ctx.fillRect(hx + headW - g * 3.6, ey, g * 2, g * 2.2);
    ctx.fillStyle = toCss(P.eyeWhite);
    ctx.fillRect(hx + g * 1.6, ey, g * 0.8, g * 0.8);
    ctx.fillRect(hx + headW - g * 3.6, ey, g * 0.8, g * 0.8);
    ctx.fillStyle = toCss(shadeDown(hair, 0.3));
    ctx.fillRect(hx + g * 1.4, ey - g * 1.1, g * 2.4, g * 0.8);
    ctx.fillRect(hx + headW - g * 3.8, ey - g * 1.1, g * 2.4, g * 0.8);

    // Mouth: a wide aperture with a tooth band — reads as a grin at distance.
    const my = top + g * 6.1;
    ctx.fillStyle = toCss(P.mouth);
    ctx.fillRect(cx - g * 2.4, my, g * 4.8, g * 1.5);
    ctx.fillStyle = toCss(P.tooth);
    ctx.fillRect(cx - g * 2.4, my, g * 4.8, g * 0.5);

    // Identity mark: a scar under one eye. Always present, always asymmetric.
    ctx.fillStyle = toCss(shadeDown(skin, 1.05));
    for (let i = 0; i < 3; i++) {
      ctx.fillRect(cx + scarSide * (g * 2.2 + i * g * 0.35), ey + g * 2.4 + i * g * 0.6, g * 0.55, g * 0.6);
    }

    // Headgear breaks the silhouette — the single most important identity cue.
    if (hasHat) {
      ctx.fillStyle = toCss(hatCol);
      ctx.fillRect(cx - g * 6.2, top - g * 1.6, g * 12.4, g * 1.3);       // brim, 1.38x head width
      ctx.fillRect(hx + g * 0.6, top - g * 4.2, headW - g * 1.2, g * 2.8); // crown
      ctx.fillStyle = toCss(shadeUp(hatCol, 0.5));
      ctx.fillRect(cx - g * 6.2, top - g * 1.6, g * 12.4, g * 0.5);
      ctx.fillStyle = toCss(hatCol === P.strawHat ? P.hatBand : P.uiGold);
      ctx.fillRect(hx + g * 0.6, top - g * 2.1, headW - g * 1.2, g * 0.8);
    }

    if (detailed) {
      // Rim light on the upper-right edge, sky-coloured — the reference's signature (§5).
      ctx.fillStyle = toCss(P.skyHorizon, 0.55);
      ctx.fillRect(hx + headW - g * 0.5, top - (hasHat ? g * 4.2 : g * 1.2), g * 0.5, headH + (hasHat ? g * 4.2 : g * 1.2));
      ctx.fillRect(hx, top - (hasHat ? g * 4.4 : g * 1.4), headW, g * 0.45);
    }
  }
}
