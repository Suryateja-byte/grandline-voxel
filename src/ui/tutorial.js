// The first-time flow. It teaches by doing: each lesson names one action in eight words or
// fewer, points at the part of the screen that matters, and completes only when the player
// actually performs the action. There is no modal wall of text and nothing to dismiss.
//
// WHY a trigger table instead of a queue: the old linear order put the whole sea voyage in
// front of every lesson about being ashore, so a player who walked into the village was told
// to board a ship and taught nothing about the villagers, quests and enemies around them.
// Now every lesson carries an arming precondition — "is this player in a position to learn
// this right now?" — and the most relevant armed lesson is the one displayed. Ashore lessons
// and sea lessons are independent acts; neither blocks the other.
//
// WHY it watches state instead of scripting the camera: a tutorial that takes control teaches
// the player that the game plays itself. Watching means a player who already knows how to
// sail blows through the whole sequence in seconds without noticing it existed.
//
// WHY keycaps are derived from the keymap: the old table hardcoded label strings and four of
// them were wrong (sail F-for-R, dock F-for-G, block RMB-for-Q, dodge SPACE-for-C) — each a
// dead end, because the lesson waits on a signal only the real binding can produce. Labels
// now come from capForAction() at activation time and cannot drift from the binds.
//
// The state it reads (all optional — a missing field simply means "not yet satisfied"):
//
//   gs.signals.lookAmount    total radians of look input, monotonic
//   gs.signals.moveDistance  total metres travelled on foot, monotonic
//   gs.signals.attack        monotonic count of attack starts
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
//   gs.hud.target            nearest aware enemy {telegraph:{kind}} — arms block/dodge
//   gs.app                   the live system tree, read defensively for arming only
//
// Monotonic counters are diffed against a baseline captured when the lesson activates, so a
// player who happened to swing a sword during the "walk" lesson does not skip the combat one.

import { P, mixHex } from '../gen/palette.js';
import { clamp, clamp01, TAU } from '../core/math.js';
import { capForAction } from '../core/input.js';
import { logTutorialEvent } from '../core/telemetry.js';
import { drawText, measure, toCss } from './font.js';
import { panel, keyCap, highlight } from './draw.js';

const SKIP_HOLD = 0.85;
// Hint ladder: quiet while the player tries, a tag once they might want one, motion once
// they are probably stuck, and a fuller goal-naming line once they definitely are. Playtest
// evidence (>80% of players click through static instructions) is why stage 2 animates and
// keeps animating until the action lands.
const HINT_TAG_AT = 6;
const HINT_PULSE_AT = 14;
const HINT_LONG_AT = 25;
// A displayed lesson holds the stage this long before a merely higher-priority (non-urgent)
// lesson may replace it — switching is the point (teach what is in front of the player), but
// not so fast the tag flickers between two contexts.
const MIN_SHOWN = 3;
// A lesson whose precondition has been false this long releases the display.
const UNARMED_RELEASE = 2;

/** Read a dotted numeric path off a possibly-absent object tree. */
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

/** Read a dotted path and return whatever is there (for method-bearing system objects). */
function raw(gs, path) {
  let o = gs;
  for (const k of path.split('.')) {
    if (o === null || o === undefined) return null;
    o = o[k];
  }
  return o === undefined ? null : o;
}

/** A counter lesson: satisfied once the monotonic signal has advanced by `amount`. */
function counter(path, amount) {
  return {
    enter: (gs, mem) => { mem.base = num(gs, path) || 0; },
    check: (gs, mem) => (num(gs, path) || 0) - mem.base >= amount,
    progress: (gs, mem) => clamp01(((num(gs, path) || 0) - mem.base) / amount),
  };
}

/** The telegraph class of the nearest aware enemy, or null. 'guard'|'warn'|'danger'. */
function telegraphKind(gs) {
  const t = raw(gs, 'hud.target.telegraph');
  return t && typeof t.kind === 'string' ? t.kind : null;
}

const ashore = (gs) => !bool(gs, 'onShip');
const basicsDone = (T) => T.has('look') && T.has('move');

/**
 * The lesson table. Array order is the LEGACY queue order — serialization of old saves maps
 * an index into this prefix, and the progress pips iterate it — while `priority` (and
 * `urgentPriority` when the urgent trigger fires) decides what is taught first. `directive`
 * marks standing send-the-player-somewhere goals that any contextual lesson may replace.
 * `region` names a Hud region so the highlight lands on the live element; null tags sit
 * low-centre.
 */
export const TUTORIAL_STEPS = [
  {
    id: 'look', priority: 12, action: 'look', region: null, place: 'centre',
    text: 'Move the mouse to look',
    longText: 'Sweep the view around — the mouse steers your eyes',
    arm: () => true,
    ...counter('signals.lookAmount', 3.0),
  },
  {
    id: 'move', priority: 11, action: 'move', region: null, place: 'centre',
    text: 'Walk with W A S D',
    longText: 'Cross the ground on foot — W A S D to walk',
    arm: (gs, T) => T.has('look'),
    ...counter('signals.moveDistance', 9),
  },
  {
    id: 'board', priority: 15, directive: true, action: 'interact', region: 'compass', place: 'below',
    text: 'Climb aboard your ship',
    longText: 'Follow the compass to the dock and press E at the gangplank',
    arm: (gs, T) => basicsDone(T) && ashore(gs) && !!gs.ship,
    enter: () => {},
    check: (gs) => bool(gs, 'onShip'),
    progress: (gs) => (bool(gs, 'onShip') ? 1 : 0),
  },
  {
    id: 'sail', priority: 43, action: 'sailUp', region: null, place: 'centre',
    text: 'Raise the sail',
    longText: 'Tap R to sheet home — the ship moves under sail',
    arm: (gs) => bool(gs, 'onShip'),
    enter: () => {},
    check: (gs) => (num(gs, 'ship.sail') || 0) >= 0.5,
    progress: (gs) => clamp01((num(gs, 'ship.sail') || 0) / 0.5),
  },
  {
    id: 'steer', priority: 42, action: 'move', capOverride: 'A', region: 'compass', place: 'below',
    text: 'Steer toward the compass marker',
    longText: 'A and D turn the helm — chase a marker on the compass',
    arm: (gs) => bool(gs, 'onShip') && (num(gs, 'ship.sail') || 0) >= 0.35,
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
    // The harbour lesson is a round trip: cast off from the berth, then moor again at an
    // island. flags.undocked is the boot-berth guard — the ship starts DOCKED, and without
    // it this lesson would credit itself on frame one.
    id: 'dock', priority: 41, action: 'anchor', region: null, place: 'centre',
    text: (gs, T) => (T.flags.undocked ? 'Drop anchor at the island' : 'Cast off with G'),
    longText: (gs, T) => (T.flags.undocked
      ? 'Reef the sail with F to slow down near a pier, then press G to moor'
      : 'Press G at the berth to cast off'),
    arm: (gs, T) => bool(gs, 'onShip')
      && (T.flags.undocked || (bool(gs, 'ship.docked') && (num(gs, 'ship.sail') || 0) >= 0.35)),
    enter: () => {},
    check: (gs, mem, T) => T.flags.undocked && bool(gs, 'ship.docked'),
    progress: (gs, mem, T) => (T.flags.undocked ? (bool(gs, 'ship.docked') ? 1 : 0.5) : 0),
  },
  {
    id: 'attack', priority: 25, urgentPriority: 90, action: 'attack', region: 'target', place: 'below',
    text: 'Strike with left click',
    longText: 'Land three swings — left mouse attacks, right mouse hits heavy',
    arm: (gs, T) => basicsDone(T) && ashore(gs),
    urgent: (gs) => ashore(gs) && !!raw(gs, 'hud.target'),
    ...counter('signals.attack', 3),
  },
  {
    id: 'block', priority: 32, urgentPriority: 92, action: 'block', region: 'health', place: 'below',
    text: 'Hold Q to block',
    longText: 'Hold Q as the blow lands to turn it aside — timed exactly, it parries',
    arm: (gs, T) => T.has('attack') && ashore(gs) && !!raw(gs, 'hud.target'),
    urgent: (gs) => {
      const k = telegraphKind(gs);
      return ashore(gs) && k !== null && k !== 'danger';
    },
    ...counter('signals.block', 1),
  },
  {
    id: 'dodge', priority: 31, urgentPriority: 91, action: 'dodge', region: 'health', place: 'below',
    text: 'Dodge with C',
    longText: 'Tap C to roll clear — red wind-ups cannot be blocked',
    arm: (gs, T) => T.has('attack') && ashore(gs) && !!raw(gs, 'hud.target'),
    urgent: (gs) => ashore(gs) && telegraphKind(gs) === 'danger',
    ...counter('signals.dodge', 2),
  },
  {
    id: 'fruit', priority: 30, action: 'ability1', region: 'abilities', place: 'above',
    text: 'Unleash your devil fruit power',
    longText: 'Press 1 to cast — devil fruit powers are on 1, 2 and 3',
    arm: (gs, T) => T.has('attack') && ashore(gs) && !!raw(gs, 'hud.fruit'),
    ...counter('signals.fruitPower', 1),
  },
  {
    id: 'talk', priority: 70, action: 'interact', region: 'prompt', place: 'above',
    text: 'Speak to the villager',
    longText: 'Stand close and press E to talk — anyone with something to say will flag it',
    arm: (gs) => {
      if (!ashore(gs)) return false;
      const npc = raw(gs, 'app.npc');
      const pos = raw(gs, 'app.player.pos');
      if (!npc || typeof npc.nearest !== 'function' || !pos) return false;
      try { return !!npc.nearest({ x: pos.x, z: pos.z }, 10); } catch { return false; }
    },
    ...counter('signals.npcTalk', 1),
  },
  {
    id: 'quest', priority: 60, action: 'interact', region: 'prompt', place: 'above',
    text: 'Accept the quest',
    longText: 'Talk to a quest giver and take the job — quests raise your bounty',
    arm: (gs, T) => {
      if (!T.has('talk') || !ashore(gs)) return false;
      const q = raw(gs, 'app.quests');
      if (!q || typeof q.availableQuests !== 'function') return false;
      try { return q.availableQuests().length > 0; } catch { return false; }
    },
    ...counter('signals.questAccept', 1),
  },
  {
    id: 'map', priority: 20, directive: true, action: 'map', region: 'compass', place: 'below',
    text: 'Open the map',
    longText: 'Press M for the voyage log — quests, islands and your wanted poster',
    arm: (gs, T) => T.has('quest'),
    ...counter('signals.mapOpen', 1),
  },
];

const STEP_BY_ID = new Map(TUTORIAL_STEPS.map((s) => [s.id, s]));
const STEP_INDEX = new Map(TUTORIAL_STEPS.map((s, i) => [s.id, i]));

export class Tutorial {
  /**
   * @param {{hud?:object, enabled?:boolean, refW?:number, refH?:number}} [opts]
   */
  constructor(opts = {}) {
    this.hud = opts.hud || null;
    this.enabled = opts.enabled !== false;
    this.refW = opts.refW || 1920;
    this.refH = opts.refH || 1080;
    this.learned = new Set();       // lesson ids the player has demonstrated
    this.skipped = false;
    this.done = false;
    this.currentId = null;          // the lesson being displayed, or null
    this.t = 0;                     // seconds the current lesson has been active
    this.total = 0;
    this.celebrate = 0;             // seconds of "well done" flash remaining
    this.mem = {};
    this.progress = 0;
    this.paused = false;            // set true while a menu is open
    this.suppress = false;          // set true while the click-to-play scrim is up
    this.flags = { undocked: false };
    this.capLabel = null;           // resolved from the live binds at activation
    this._text = '';                // resolved text for draw (text may be a function)
    this._longText = null;
    this._urgentNow = false;        // current lesson was activated by its urgent trigger
    this._lapse = 0;                // seconds the current lesson's arm() has been false
    this._hintReset = 0;            // progress high-water mark, backs the ladder off
    this._skipHeld = 0;
    this._skipDown = false;
    this._simTime = undefined;      // sim seconds from the last snapshot (telemetry stamps)
    this._armedAt = {};             // id -> simTime of first arming (telemetry only)
    this._shownIds = new Set();     // ids that already emitted lesson_shown
  }

  /** @returns {boolean} */
  isDone() { return this.done || this.skipped || this.learned.size >= TUTORIAL_STEPS.length; }

  /** @param {string} id */
  has(id) { return this.learned.has(id); }

  /** The lesson currently being taught, or null. */
  get current() { return this.currentId ? STEP_BY_ID.get(this.currentId) || null : null; }

  /** Abandon the whole flow. Idempotent. */
  skip() {
    if (!this.skipped) {
      const unlearned = TUTORIAL_STEPS.map((s) => s.id).filter((id) => !this.learned.has(id));
      logTutorialEvent('lesson_skipped', { lessons: unlearned, simTime: this._simTime });
    }
    this.skipped = true;
    this.done = true;
    this.currentId = null;
    this.celebrate = 0;
    return true;
  }

  /** Wire the skip key: the UI system calls this with the key's held state. */
  setSkipHeld(down) { this._skipDown = !!down; if (!down) this._skipHeld = 0; }

  /** Effective priority of a lesson given how it is armed right now. */
  _effPriority(s, urgentNow) {
    return urgentNow && s.urgentPriority !== undefined ? s.urgentPriority : s.priority;
  }

  /**
   * @param {number} dt seconds
   * @param {object} gameState see the contract at the top of this file
   */
  step(dt, gameState) {
    if (!this.enabled || this.isDone()) return;
    const gs = gameState || {};
    const d = Math.min(0.1, dt || 0);
    this.total += d;
    this._simTime = num(gs, 'app.clock.simTime');
    if (this.celebrate > 0) {
      this.celebrate = Math.max(0, this.celebrate - d);
      if (this.celebrate === 0) this.currentId = null;   // reselect next step
      return;
    }
    if (this.paused) return;

    if (this._skipDown) {
      this._skipHeld += d;
      if (this._skipHeld >= SKIP_HOLD) { this.skip(); return; }
    }

    // Cross-lesson flags: the harbour round-trip guard.
    const dockState = raw(gs, 'app.ship.dock.state');
    if (dockState === 'undocking' || dockState === 'sailing') this.flags.undocked = true;

    // Arm scan: every unlearned lesson, once per step. Feeds selection, preemption and the
    // first-arm telemetry event. Arm functions read only the snapshot and are cheap.
    let best = null, bestPri = -Infinity, bestUrgent = false;
    for (const s of TUTORIAL_STEPS) {
      if (this.learned.has(s.id)) continue;
      let urgentNow = false;
      let armed = false;
      try {
        urgentNow = !!(s.urgent && s.urgent(gs, this));
        armed = urgentNow || !!(s.arm && s.arm(gs, this));
      } catch { armed = false; urgentNow = false; }
      if (!armed) continue;
      if (this._armedAt[s.id] === undefined) {
        this._armedAt[s.id] = this._simTime;
        logTutorialEvent('lesson_armed', { lesson: s.id, simTime: this._simTime });
      }
      const pri = this._effPriority(s, urgentNow);
      if (pri > bestPri) { best = s; bestPri = pri; bestUrgent = urgentNow; }
    }

    let cur = this.current;
    if (cur) {
      // Hysteresis: hold the display until the lesson is learned, its precondition has been
      // false for a while, or something more relevant is armed. Urgent lessons preempt at
      // once; merely higher-priority ones wait until this one has had its moment on screen.
      let stillArmed = false, stillUrgent = false;
      try {
        stillUrgent = !!(cur.urgent && cur.urgent(gs, this));
        stillArmed = stillUrgent || !!(cur.arm && cur.arm(gs, this));
      } catch { stillArmed = false; }
      this._lapse = stillArmed ? 0 : this._lapse + d;
      const curPri = this._effPriority(cur, this._urgentNow && stillUrgent);
      // Fresh reads for the decision below — the frame a lesson's precondition flips can be
      // the frame it completes (boarding satisfies 'board'), and a preempt racing that
      // completion would eat the lesson.
      let freshProgress = 0, doneNow = false;
      try {
        freshProgress = cur.progress ? clamp01(cur.progress(gs, this.mem, this)) : 0;
        doneNow = !!cur.check(gs, this.mem, this);
      } catch { /* a missing field means not yet */ }
      // A more relevant lesson may replace this one when: it is urgent (a telegraph is
      // already mid-swing); this one has not been shown AND the player has not started it
      // (switching dead air is free — hijacking a half-walked walk lesson is not); or this
      // one has been on screen long enough to have had its moment. Never while it is about
      // to complete — the celebrate flash is owed first.
      const mayPreempt = best && best.id !== cur.id && bestPri > curPri && !doneNow
        && (bestUrgent
          || (this.t < HINT_TAG_AT && freshProgress === 0)
          || this.t >= HINT_TAG_AT + MIN_SHOWN);
      if ((this._lapse > UNARMED_RELEASE && !doneNow) || mayPreempt) {
        this.currentId = null;
        cur = null;
      }
    }
    if (!cur && best) {
      this._activate(best, gs, bestUrgent);
      cur = best;
    }
    if (!cur) { this.progress = 0; return; }

    this.t += d;
    this.progress = cur.progress ? clamp01(cur.progress(gs, this.mem, this)) : 0;
    // The player is visibly advancing: back the hint ladder off rather than escalating at
    // someone who is mid-way through doing the thing.
    if (this.progress > this._hintReset + 1e-6) {
      this.t = Math.min(this.t, HINT_TAG_AT * 0.5);
      this._hintReset = this.progress;
    }
    // Resolve display text here (draw has no game state); text may depend on lesson phase.
    this._text = typeof cur.text === 'function' ? cur.text(gs, this) : cur.text;
    this._longText = typeof cur.longText === 'function' ? cur.longText(gs, this) : (cur.longText || null);
    // A minimum dwell keeps a prompt from flashing past before the eye can land on it.
    if (this.t > 0.45 && cur.check(gs, this.mem, this)) this._learn(cur.id);
  }

  _activate(s, gs, urgentNow) {
    this.currentId = s.id;
    this.mem = {};
    this.t = 0;
    this.progress = 0;
    this._lapse = 0;
    this._hintReset = 0;
    this._urgentNow = !!urgentNow;
    if (s.enter) s.enter(gs, this.mem);
    this.capLabel = s.capOverride || capForAction(s.action, raw(gs, 'app.input')) || null;
    this._text = typeof s.text === 'function' ? s.text(gs, this) : s.text;
    this._longText = typeof s.longText === 'function' ? s.longText(gs, this) : (s.longText || null);
    if (!this._shownIds.has(s.id)) {
      this._shownIds.add(s.id);
      const armedAt = this._armedAt[s.id];
      logTutorialEvent('lesson_shown', {
        lesson: s.id, simTime: this._simTime,
        sinceArmed: this._simTime !== undefined && armedAt !== undefined
          ? Math.round((this._simTime - armedAt) * 100) / 100 : undefined,
      });
    }
  }

  _learn(id) {
    this.learned.add(id);
    const armedAt = this._armedAt[id];
    logTutorialEvent('lesson_learned', {
      lesson: id, simTime: this._simTime,
      sinceArmed: this._simTime !== undefined && armedAt !== undefined
        ? Math.round((this._simTime - armedAt) * 100) / 100 : undefined,
    });
    this.celebrate = 0.7;
    if (this.learned.size >= TUTORIAL_STEPS.length) this.done = true;
  }

  /** Where the tag for a lesson should sit, in canvas pixels. */
  _anchor(ctx, s) {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const r = this.hud && s.region ? this.hud.regions[s.region] : null;
    if (r && r.w > 4 && r.h > 4) return r;
    return { x: w / 2 - w * 0.11, y: h * 0.78, w: w * 0.22, h: h * 0.05 };
  }

  /** @param {CanvasRenderingContext2D} ctx */
  draw(ctx) {
    if (!this.enabled || this.isDone() || this.suppress) return;
    const s = this.current;
    if (!s) return;
    const cel = this.celebrate > 0 ? clamp01(this.celebrate / 0.7) : 0;
    // Hint ladder. Urgent lessons skip the quiet stage — a telegraph is already mid-swing.
    const tEff = this._urgentNow ? Math.max(this.t, HINT_TAG_AT) : this.t;
    if (cel === 0 && tEff < HINT_TAG_AT) return;   // stage 0: let them try in peace

    const w = ctx.canvas.width, h = ctx.canvas.height;
    const sc = clamp(Math.min(w / this.refW, h / this.refH), 0.5, 2.2);
    const region = this._anchor(ctx, s);
    const animate = cel > 0 || tEff >= HINT_PULSE_AT;
    const phase = animate ? (this.total * 0.55) % 1 : 0;

    highlight(ctx, region.x, region.y, region.w, region.h,
      cel > 0 ? P.uiGreen : P.uiGold, phase);

    const text = cel > 0 ? 'GOOD'
      : tEff >= HINT_LONG_AT && this._longText ? this._longText : (this._text || '');
    const capText = this.capLabel;

    // Tag geometry: measured first so the pointer can attach to the correct edge.
    const size = Math.round(19 * sc);
    const tm = measure(text, size, 'display', { maxWidth: Math.round(360 * sc) });
    const capSize = animate
      ? Math.round(12 * sc * (1 + 0.08 * Math.sin(this.total * TAU * 1.2)))
      : Math.round(12 * sc);
    const keyW = capText ? Math.round(measure(capText, Math.round(12 * sc), 'display').w + 26 * sc) : 0;
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
      seed: 0xf00d + (STEP_INDEX.get(s.id) || 0),
      amp: 2.6, accent: cel > 0 ? P.uiGreen : P.uiGold,
    });

    let textX = tx + Math.round(18 * sc);
    if (capText) {
      keyCap(ctx, tx + Math.round(14 * sc), ty + th / 2 - Math.round(13 * sc), capText, { size: capSize });
      textX = tx + Math.round(14 * sc) + keyW;
    }
    drawText(ctx, text, textX, ty + th / 2, {
      size, weight: 'display', color: P.uiInk, baseline: 'middle',
      maxWidth: Math.round(360 * sc),
    });

    // Lesson pips: learned lessons in gold, the current one enlarged, partial progress as a
    // ring. The player can see the flow is finite even though it is no longer a queue.
    const dotY = ty + th + Math.round(9 * sc);
    const dr = Math.round(4 * sc);
    const dgap = Math.round(11 * sc);
    const startX = tx + tw / 2 - ((TUTORIAL_STEPS.length - 1) * dgap) / 2;
    for (let k = 0; k < TUTORIAL_STEPS.length; k++) {
      const stepK = TUTORIAL_STEPS[k];
      const isCur = stepK.id === this.currentId;
      ctx.fillStyle = toCss(this.learned.has(stepK.id) ? P.uiGold : isCur ? P.uiWhite : P.uiShadow,
        this.learned.has(stepK.id) || isCur ? 0.95 : 0.5);
      ctx.beginPath();
      ctx.arc(startX + k * dgap, dotY, isCur ? dr * 1.5 : dr, 0, TAU);
      ctx.fill();
      if (isCur && this.progress > 0 && this.progress < 1) {
        ctx.strokeStyle = toCss(P.uiGold);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(startX + k * dgap, dotY, dr * 2.6, -Math.PI / 2, -Math.PI / 2 + TAU * this.progress);
        ctx.stroke();
      }
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

  /** @returns {{learned:string[],skipped:boolean,done:boolean,undocked:boolean,total:number}} */
  serialize() {
    return {
      learned: TUTORIAL_STEPS.map((s) => s.id).filter((id) => this.learned.has(id)),
      skipped: this.skipped,
      done: this.isDone(),
      undocked: this.flags.undocked,
      total: Math.round(this.total * 100) / 100,
    };
  }

  /**
   * Accepts the v2 shape ({learned:[...]}) and the legacy v1 shape ({i, done, total}): the
   * old linear index maps onto the first `i` lessons in table order, which IS the old queue
   * order. A v1 save marked done before the end was a skip.
   * @param {object} o
   */
  deserialize(o) {
    if (!o) return;
    this.learned = new Set();
    this.skipped = false;
    if (Array.isArray(o.learned)) {
      for (const id of o.learned) if (STEP_BY_ID.has(id)) this.learned.add(id);
      this.skipped = !!o.skipped;
    } else if (typeof o.i === 'number') {
      const n = clamp(o.i | 0, 0, TUTORIAL_STEPS.length);
      for (let k = 0; k < n; k++) this.learned.add(TUTORIAL_STEPS[k].id);
      this.skipped = !!o.done && n < TUTORIAL_STEPS.length;
    }
    this.done = !!o.done || this.skipped || this.learned.size >= TUTORIAL_STEPS.length;
    this.flags.undocked = !!o.undocked;
    this.total = o.total || 0;
    this.currentId = null;
    this.mem = {};
    this.celebrate = 0;
    this.t = 0;
    this.progress = 0;
    this._armedAt = {};
    this._shownIds = new Set();
  }
}
