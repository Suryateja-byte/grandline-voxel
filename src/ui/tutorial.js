// The first-time flow. It teaches by doing: each step names one action in eight words or
// fewer, points at the part of the screen that matters, and advances only when the player
// actually performs the action. There is no modal wall of text and nothing to dismiss.
//
// WHY it watches state instead of scripting the camera: a tutorial that takes control teaches
// the player that the game plays itself. Watching means a player who already knows how to
// sail blows through the whole sequence in twenty seconds without noticing it existed.
//
// The state it reads (all optional — a missing field simply means "not yet satisfied"):
//
//   gs.signals.lookAmount    total radians of look input, monotonic
//   gs.signals.moveDistance  total metres travelled on foot, monotonic
//   gs.signals.attack        monotonic count of landed attacks
//   gs.signals.block         monotonic count of successful blocks
//   gs.signals.dodge         monotonic count of dodges
//   gs.signals.fruitPower    monotonic count of devil-fruit abilities used
//   gs.signals.npcTalk       monotonic count of NPC conversations opened
//   gs.signals.questAccept   monotonic count of quests accepted
//   gs.signals.mapOpen       monotonic count of map openings
//   gs.onShip                boolean, player is standing on their ship
//   gs.ship.sail             0..1 sail extension
//   gs.ship.distToMarker     metres to the current compass marker
//   gs.ship.docked           boolean, ship is moored
//
// Monotonic counters are diffed against a baseline captured when the step begins, so a player
// who happened to swing a sword during the "walk" step does not skip the combat lesson.

import { P, mixHex } from '../gen/palette.js';
import { clamp, clamp01, TAU } from '../core/math.js';
import { drawText, measure, toCss } from './font.js';
import { panel, keyCap, highlight } from './draw.js';

const SKIP_HOLD = 0.85;

/** Read a dotted path off a possibly-absent object tree. */
function num(gs, path) {
  let o = gs;
  for (const k of path.split('.')) {
    if (o === null || o === undefined) return undefined;
    o = o[k];
  }
  return typeof o === 'number' ? o : undefined;
}

function bool(gs, path) {
  let o = gs;
  for (const k of path.split('.')) {
    if (o === null || o === undefined) return false;
    o = o[k];
  }
  return !!o;
}

/** A counter step: satisfied once the monotonic signal has advanced by `amount`. */
function counter(path, amount) {
  return {
    enter: (gs, mem) => { mem.base = num(gs, path) || 0; },
    check: (gs, mem) => (num(gs, path) || 0) - mem.base >= amount,
    progress: (gs, mem) => clamp01(((num(gs, path) || 0) - mem.base) / amount),
  };
}

/**
 * The script. `region` names a Hud region so the highlight lands on the live element; when a
 * step is about the world rather than the HUD, `region` is null and the tag sits low-centre.
 */
export const TUTORIAL_STEPS = [
  {
    id: 'look', text: 'Move the mouse to look', key: 'MOUSE', region: null, place: 'centre',
    ...counter('signals.lookAmount', 3.0),
  },
  {
    id: 'move', text: 'Walk with W A S D', key: 'W', region: null, place: 'centre',
    ...counter('signals.moveDistance', 9),
  },
  {
    id: 'board', text: 'Climb aboard your ship', key: null, region: 'compass', place: 'below',
    enter: () => {}, check: (gs) => bool(gs, 'onShip'), progress: (gs) => (bool(gs, 'onShip') ? 1 : 0),
  },
  {
    id: 'sail', text: 'Raise the sail', key: 'F', region: 'ship', place: 'left',
    enter: () => {},
    check: (gs) => (num(gs, 'ship.sail') || 0) >= 0.5,
    progress: (gs) => clamp01((num(gs, 'ship.sail') || 0) / 0.5),
  },
  {
    id: 'steer', text: 'Steer toward the compass marker', key: 'A', region: 'compass', place: 'below',
    enter: (gs, mem) => { mem.base = num(gs, 'ship.distToMarker'); },
    check: (gs, mem) => {
      const d = num(gs, 'ship.distToMarker');
      if (d === undefined) return false;
      if (mem.base === undefined) { mem.base = d; return false; }
      return d < 150 || mem.base - d > 90;
    },
    progress: (gs, mem) => {
      const d = num(gs, 'ship.distToMarker');
      if (d === undefined || mem.base === undefined) return 0;
      return clamp01((mem.base - d) / 90);
    },
  },
  {
    id: 'dock', text: 'Drop anchor at the island', key: 'F', region: 'ship', place: 'left',
    enter: () => {}, check: (gs) => bool(gs, 'ship.docked'), progress: (gs) => (bool(gs, 'ship.docked') ? 1 : 0),
  },
  {
    id: 'attack', text: 'Strike with left click', key: 'LMB', region: 'target', place: 'below',
    ...counter('signals.attack', 3),
  },
  {
    id: 'block', text: 'Hold right click to block', key: 'RMB', region: 'health', place: 'below',
    ...counter('signals.block', 1),
  },
  {
    id: 'dodge', text: 'Dodge with the space bar', key: 'SPACE', region: 'health', place: 'below',
    ...counter('signals.dodge', 2),
  },
  {
    id: 'fruit', text: 'Unleash your devil fruit power', key: '1', region: 'abilities', place: 'above',
    ...counter('signals.fruitPower', 1),
  },
  {
    id: 'talk', text: 'Speak to the villager', key: 'E', region: 'prompt', place: 'above',
    ...counter('signals.npcTalk', 1),
  },
  {
    id: 'quest', text: 'Accept the quest', key: 'E', region: 'quest', place: 'left',
    ...counter('signals.questAccept', 1),
  },
  {
    id: 'map', text: 'Open the map', key: 'M', region: 'compass', place: 'below',
    ...counter('signals.mapOpen', 1),
  },
];

export class Tutorial {
  /**
   * @param {{hud?:object, enabled?:boolean, refW?:number, refH?:number}} [opts]
   */
  constructor(opts = {}) {
    this.hud = opts.hud || null;
    this.enabled = opts.enabled !== false;
    this.refW = opts.refW || 1920;
    this.refH = opts.refH || 1080;
    this.i = 0;
    this.done = false;
    this.t = 0;             // time on the current step
    this.total = 0;
    this.celebrate = 0;     // seconds of "well done" flash remaining
    this.mem = {};
    this._entered = -1;
    this._skipHeld = 0;
    this._skipDown = false;
    this.paused = false;    // set true while a menu is open
    this.progress = 0;
  }

  /** @returns {boolean} */
  isDone() { return this.done || this.i >= TUTORIAL_STEPS.length; }

  /** The step currently being taught, or null. */
  get current() { return this.isDone() ? null : TUTORIAL_STEPS[this.i]; }

  /** Abandon the whole flow. Idempotent. */
  skip() {
    this.done = true;
    this.i = TUTORIAL_STEPS.length;
    this.celebrate = 0;
    return true;
  }

  /** Wire the skip key: the UI system calls this with the key's held state. */
  setSkipHeld(down) { this._skipDown = !!down; if (!down) this._skipHeld = 0; }

  /**
   * @param {number} dt seconds
   * @param {object} gameState see the contract at the top of this file
   */
  step(dt, gameState) {
    if (!this.enabled || this.isDone()) return;
    const d = Math.min(0.1, dt || 0);
    this.total += d;
    if (this.celebrate > 0) {
      this.celebrate = Math.max(0, this.celebrate - d);
      if (this.celebrate === 0) this._advance();
      return;
    }
    if (this.paused) return;

    if (this._skipDown) {
      this._skipHeld += d;
      if (this._skipHeld >= SKIP_HOLD) { this.skip(); return; }
    }

    const s = this.current;
    if (!s) return;
    if (this._entered !== this.i) {
      this.mem = {};
      this.t = 0;
      if (s.enter) s.enter(gameState || {}, this.mem);
      this._entered = this.i;
    }
    this.t += d;
    this.progress = s.progress ? clamp01(s.progress(gameState || {}, this.mem)) : 0;
    // A minimum dwell keeps a prompt from flashing past before the eye can land on it.
    if (this.t > 0.45 && s.check(gameState || {}, this.mem)) this.celebrate = 0.7;
  }

  _advance() {
    this.i++;
    this._entered = -1;
    this.progress = 0;
    if (this.i >= TUTORIAL_STEPS.length) this.done = true;
  }

  /** Where the tag for a step should sit, in canvas pixels. */
  _anchor(ctx, s) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const r = this.hud && s.region ? this.hud.regions[s.region] : null;
    if (r && r.w > 4 && r.h > 4) return r;
    return { x: w / 2 - w * 0.11, y: h * 0.78, w: w * 0.22, h: h * 0.05 };
  }

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    if (!this.enabled || this.isDone()) return;
    const s = this.current;
    if (!s) return;
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const sc = clamp(Math.min(w / this.refW, h / this.refH), 0.5, 2.2);
    const region = this._anchor(ctx, s);
    const phase = (this.total * 0.55) % 1;
    const cel = this.celebrate > 0 ? clamp01(this.celebrate / 0.7) : 0;

    highlight(ctx, region.x, region.y, region.w, region.h,
      cel > 0 ? P.uiGreen : P.uiGold, phase);

    // Tag geometry: measured first so the pointer can attach to the correct edge.
    const size = Math.round(19 * sc);
    const tm = measure(s.text, size, 'display', { maxWidth: Math.round(360 * sc) });
    const keyW = s.key ? Math.round(measure(s.key, Math.round(12 * sc), 'display').w + 26 * sc) : 0;
    const tw = tm.w + keyW + Math.round(44 * sc);
    const th = Math.max(tm.h + Math.round(30 * sc), Math.round(58 * sc));
    const gap = Math.round(26 * sc);

    let tx, ty, dir;
    const place = s.place || 'below';
    if (place === 'left' || (place === 'auto' && region.x > w * 0.5)) {
      tx = region.x - gap - tw; ty = region.y + region.h / 2 - th / 2; dir = 'right';
    } else if (place === 'above') {
      tx = region.x + region.w / 2 - tw / 2; ty = region.y - gap - th; dir = 'down';
    } else if (place === 'centre') {
      tx = w / 2 - tw / 2; ty = Math.round(h * 0.78); dir = null;
    } else {
      tx = region.x + region.w / 2 - tw / 2; ty = region.y + region.h + gap; dir = 'up';
    }
    tx = clamp(tx, Math.round(14 * sc), w - tw - Math.round(14 * sc));
    ty = clamp(ty, Math.round(14 * sc), h - th - Math.round(14 * sc));

    // Pointer triangle toward the highlighted element.
    if (dir) {
      const px = clamp(region.x + region.w / 2, tx + Math.round(24 * sc), tx + tw - Math.round(24 * sc));
      const py = dir === 'up' ? ty : dir === 'down' ? ty + th : ty + th / 2;
      const k = Math.round(13 * sc);
      ctx.fillStyle = toCss(mixHex(P.uiPaper, P.uiGold, 0.3));
      ctx.strokeStyle = toCss(P.uiInk);
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (dir === 'up') { ctx.moveTo(px, py - k); ctx.lineTo(px - k, py + 2); ctx.lineTo(px + k, py + 2); }
      else if (dir === 'down') { ctx.moveTo(px, py + k); ctx.lineTo(px - k, py - 2); ctx.lineTo(px + k, py - 2); }
      else { ctx.moveTo(tx + tw + k, ty + th / 2); ctx.lineTo(tx + tw - 2, ty + th / 2 - k); ctx.lineTo(tx + tw - 2, ty + th / 2 + k); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    panel(ctx, tx, ty, tw, th, {
      fill: mixHex(P.uiPaper, cel > 0 ? P.uiGreen : P.uiGold, 0.22),
      seed: 0xf00d + this.i, amp: 2.6, accent: cel > 0 ? P.uiGreen : P.uiGold,
    });

    let textX = tx + Math.round(18 * sc);
    if (s.key) {
      keyCap(ctx, tx + Math.round(14 * sc), ty + th / 2 - Math.round(13 * sc), s.key, { size: Math.round(12 * sc) });
      textX = tx + Math.round(14 * sc) + keyW;
    }
    drawText(ctx, cel > 0 ? 'GOOD' : s.text, textX, ty + th / 2, {
      size, weight: 'display', color: P.uiInk, baseline: 'middle',
      maxWidth: Math.round(360 * sc),
    });

    // Step counter + partial-progress pips: the player can see the lesson is finite.
    const dotY = ty + th + Math.round(9 * sc);
    const dr = Math.round(4 * sc);
    const dgap = Math.round(11 * sc);
    const startX = tx + tw / 2 - ((TUTORIAL_STEPS.length - 1) * dgap) / 2;
    for (let k = 0; k < TUTORIAL_STEPS.length; k++) {
      ctx.fillStyle = toCss(k < this.i ? P.uiGold : k === this.i ? P.uiWhite : P.uiShadow,
        k <= this.i ? 0.95 : 0.5);
      ctx.beginPath();
      ctx.arc(startX + k * dgap, dotY, k === this.i ? dr * 1.5 : dr, 0, TAU);
      ctx.fill();
    }
    if (this.progress > 0 && this.progress < 1) {
      ctx.strokeStyle = toCss(P.uiGold);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(startX + this.i * dgap, dotY, dr * 2.6, -Math.PI / 2, -Math.PI / 2 + TAU * this.progress);
      ctx.stroke();
    }

    // Skip affordance. Holding, not tapping, so it is never triggered by accident.
    const skY = h - Math.round(26 * sc);
    const cap = keyCap(ctx, w - Math.round(24 * sc) - Math.round(34 * sc), skY - Math.round(18 * sc), 'H',
      { size: Math.round(11 * sc) });
    drawText(ctx, 'hold to skip', cap.x - Math.round(8 * sc), skY - Math.round(6 * sc), {
      size: Math.round(11 * sc), weight: 'body', color: P.uiWhite, align: 'right',
      outline: P.uiInk, outlineWidth: 1,
    });
    if (this._skipHeld > 0) {
      ctx.strokeStyle = toCss(P.uiGold);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cap.x + cap.w / 2, cap.y + cap.h / 2, cap.w * 0.85, -Math.PI / 2,
        -Math.PI / 2 + TAU * clamp01(this._skipHeld / SKIP_HOLD));
      ctx.stroke();
    }
  }

  /** @returns {{i:number,done:boolean,total:number}} */
  serialize() {
    return { i: this.i, done: this.done, total: Math.round(this.total * 100) / 100 };
  }

  /** @param {{i?:number,done?:boolean,total?:number}} o */
  deserialize(o) {
    if (!o) return;
    this.i = clamp(o.i | 0, 0, TUTORIAL_STEPS.length);
    this.done = !!o.done || this.i >= TUTORIAL_STEPS.length;
    this.total = o.total || 0;
    this._entered = -1;
    this.mem = {};
    this.celebrate = 0;
  }
}
