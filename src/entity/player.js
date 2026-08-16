// The player. Owner: Cluster B (character / rig / animation / camera).
//
// The player reads `app.input.state` — the same snapshot the playtest harness drives — turns it
// into camera-relative movement, and EMITS combat intents. It never applies damage, never opens
// a hitbox and never decides what an attack hits: that is Cluster C's job, and it reads
// `player.intents` plus `ATTACK_TIMINGS` from src/entity/anim.js.
//
// The three things that decide whether this feels good:
//   * input buffering. A press inside the last 0.18 s of a swing is remembered and fires the
//     moment the cancel window opens. Without it, a combo drops whenever the player is early,
//     and players are always early.
//   * cancel windows. Each attack becomes cancellable partway through its recovery, so the
//     chain flows; dodge cancels out of any attack from the moment its active frames end.
//   * i-frames on the dodge, and a parry window at the start of a block. Both are short, both
//     are exact, and both are readable in the animation before they are readable in the HUD.

import * as THREE from 'three';
import { clamp, clamp01, inArc } from '../core/math.js';
import { Actor, ACTOR_STATE, MOVE } from './actor.js';
import { ATTACK_TIMINGS, COMBO_CHAIN, STATE_META } from './anim.js';

/** Player tuning. Times are seconds; costs are stamina points out of 100. */
export const PLAYER = Object.freeze({
  maxStamina: 100,
  sprintDrain: 17,        // per second
  staminaRegen: 27,       // per second, after the delay
  staminaDelay: 0.65,
  dodgeCost: 20,
  /** Sprinting is refused below this, so the player cannot chain 0.1-second sprints. */
  sprintFloor: 12,

  inputBuffer: 0.18,
  jumpBuffer: 0.14,

  dodgeRollTime: 0.62,
  dodgeDashTime: 0.34,
  /** Invulnerability spans, as [start, end] seconds inside the dodge. */
  rollIFrames: [0.07, 0.42],
  dashIFrames: [0.04, 0.24],
  dodgeSpeed: 17.0,

  parryWindow: 0.20,
  blockDrain: 0,          // blocking costs nothing to hold; it costs you tempo

  /** Held heavy attacks pause at the top of the windup for up to this long. */
  maxCharge: 0.60,

  interactRange: 5.2,
  interactArc: 1.05,      // half-angle, radians

  lockRange: 34,
  airJumps: 0,            // raised by fruit powers
});

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

/**
 * Read a lockable target's position. Enemies store flat x/y/z (entity/enemy.js), actors and
 * NPCs carry a .pos vector — lock-on must accept both shapes.
 */
function targetPos(t) {
  if (!t) return null;
  if (t.pos && typeof t.pos.x === 'number') return t.pos;
  if (typeof t.x === 'number' && typeof t.z === 'number') return t;
  return null;
}

export class Player extends Actor {
  /**
   * @param {object} app
   * @param {object|string} [spec] defaults to the straw-hat captain
   * @param {object} [opts]
   */
  constructor(app, spec = 'hero_captain', opts = {}) {
    super(app, spec, Object.assign({ faction: 'crew', maxHp: 120 }, opts));

    this.isPlayer = true;
    this.maxStamina = PLAYER.maxStamina;
    this.stamina = this.maxStamina;
    this._staminaHold = 0;

    /** Per-step queue of combat intents. Combat drains it in the same step (ARCHITECTURE §4). */
    this.intents = [];

    this.comboIndex = -1;
    this._attackBuffer = 0;
    this._heavyBuffer = 0;
    this._jumpBuffer = 0;
    this.chargeT = 0;
    this._charging = false;

    this.dodgeT = 0;
    this.dodgeKind = null;

    this.blockT = -1;              // seconds the block has been held, or -1 when not blocking
    this.parryArmed = false;

    this.airJumpsLeft = 0;
    this.maxAirJumps = PLAYER.airJumps;

    this.lockTarget = null;
    this._lockList = [];
    this.interactTarget = null;
    /** Interactions the player confirmed this step; the world/quest layer drains it. */
    this.pendingInteract = null;

    this.sprinting = false;
    this.combatReady = false;
    this._combatTimer = 0;

    this.camera = opts.camera || null;
  }

  /** Bind the GameCamera this player steers with. */
  setCamera(cam) { this.camera = cam; return this; }

  /** The camera this player uses for movement basis, resolved lazily from the app. */
  _cam(app) {
    return this.camera || (app && (app.gameCamera || app.cam)) || null;
  }

  /** Drain the intent queue. Combat calls this once per step. @returns {object[]} */
  drainIntents() {
    if (this.intents.length === 0) return this.intents;
    const out = this.intents.slice();
    this.intents.length = 0;
    return out;
  }

  /** Push a combat intent. @param {object} intent { kind, index, dir, chargedT } */
  emitIntent(kind, extra) {
    const i = Object.assign({
      kind,
      index: 0,
      dir: { x: Math.sin(this.yaw), z: Math.cos(this.yaw) },
      chargedT: 0,
    }, extra);
    this.intents.push(i);
    return i;
  }

  step(dt, app) {
    // Intents live for exactly one step. Combat runs after the player in ARCHITECTURE §4's
    // order, so anything pushed here is consumed before it is cleared next step.
    this.intents.length = 0;
    this.pendingInteract = null;
    super.step(dt, app);
    this._postStep(dt, app);
  }

  /**
   * Read input and turn it into movement, attacks and camera-relative intent.
   *
   * Runs every step, including while committed to an attack: the buffer sections MUST see the
   * presses that land mid-swing or the combo drops every time the player is early. Only the
   * sections that would break a commitment are gated behind `committed`.
   */
  _control(dt, app) {
    const input = app && app.input ? app.input.state : null;
    if (!input) return;
    const cam = this._cam(app);
    const committed = this.lockT > 0;

    // --- buffers (always) ---------------------------------------------------
    if (input.pressed.attack) this._attackBuffer = PLAYER.inputBuffer;
    if (input.pressed.heavy) this._heavyBuffer = PLAYER.inputBuffer;
    if (input.pressed.jump) this._jumpBuffer = PLAYER.jumpBuffer;
    this._attackBuffer = Math.max(0, this._attackBuffer - dt);
    this._heavyBuffer = Math.max(0, this._heavyBuffer - dt);
    this._jumpBuffer = Math.max(0, this._jumpBuffer - dt);

    // --- lock-on (always) ---------------------------------------------------
    if (input.pressed.lockOn) this._cycleLock(app);
    if (this.lockTarget && !this._lockValid(this.lockTarget)) this._setLock(null, app);

    // --- block / parry (always: the guard has to survive hitstun) ------------
    const wantBlock = !!input.down.block && this.grounded && !this.inWater && !this.dodgeKind
      && !this.attack;
    if (wantBlock && this.blockT < 0) {
      this.blockT = 0;
      this.parryArmed = true;
      // A parry is a *press*, so the intent goes out immediately and combat decides whether
      // anything was in the window. The animation shows the deflection either way.
      this.emitIntent('parry');
      this.setState(ACTOR_STATE.PARRY, { force: true, lock: PLAYER.parryWindow, anim: 'parry' });
      this._playSfx('block', 0.5);
    } else if (wantBlock) {
      this.blockT += dt;
      if (this.blockT > PLAYER.parryWindow) this.parryArmed = false;
    } else if (this.blockT >= 0) {
      this.blockT = -1;
      this.parryArmed = false;
    }
    this.blocking = wantBlock && this.blockT >= PLAYER.parryWindow;
    if (this.blocking) this.emitIntent('block');

    // --- attacks (always: this is where the buffer is spent) -----------------
    this._updateAttacks(dt, input, app);

    // --- movement basis -----------------------------------------------------
    // Camera-relative, always. A third-person game where W is world-forward is a game people
    // fight rather than play.
    if (cam) {
      cam.getForwardFlat(_fwd);
      cam.getRightFlat(_right);
    } else {
      _fwd.set(0, 0, 1);
      _right.set(1, 0, 0);
    }
    // input.moveZ is -1 for "forward", matching the key layout in core/input.js.
    const mx = input.moveX || 0, mz = input.moveZ || 0;
    _dir.set(
      _right.x * mx - _fwd.x * mz,
      0,
      _right.z * mx - _fwd.z * mz,
    );
    const wish = Math.hypot(_dir.x, _dir.z);

    // --- dodge --------------------------------------------------------------
    // Dodge cancels out of an attack the moment its active frames close. That single rule is
    // what stops a whiffed heavy from being a death sentence.
    const a = this.attack;
    const dodgeCancel = a ? a.t >= a.timing.windup + a.timing.active : true;
    if (input.pressed.dodge && this.dodgeT <= 0 && this.stamina >= PLAYER.dodgeCost
      && !this.inWater && this.grounded && dodgeCancel
      && this.state !== ACTOR_STATE.HIT && this.state !== ACTOR_STATE.DOWN) {
      this._startDodge(wish > 0.2 ? _dir : null);
      return;
    }

    // --- interact prompt (always; confirming needs a free body) --------------
    this.interactTarget = this._findInteractable(app);
    if (!committed && input.pressed.interact && this.interactTarget) this._doInteract(app);

    if (committed || this.dodgeKind) return;

    // --- abilities ----------------------------------------------------------
    if (input.pressed.ability1) { this._castAbility(0, 'fruit_cast_a', 0.55); return; }
    if (input.pressed.ability2) { this._castAbility(1, 'fruit_cast_b', 0.72); return; }
    if (input.pressed.ability3) { this._castAbility(2, 'fruit_channel', 0.90); return; }

    // --- stamina and sprint --------------------------------------------------
    const wantSprint = !!input.down.sprint && wish > 0.2 && !this.blocking && !this.inWater;
    this.sprinting = wantSprint && this.stamina > (this.sprinting ? 0.5 : PLAYER.sprintFloor);
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - PLAYER.sprintDrain * dt);
      this._staminaHold = PLAYER.staminaDelay;
    }

    // --- resolve movement ----------------------------------------------------
    if (wish > 1e-4) {
      this.wishX = _dir.x / wish;
      this.wishZ = _dir.z / wish;
      const base = this.inWater ? MOVE.swim
        : this.sprinting ? MOVE.sprint
          : this.blocking ? MOVE.walk * 0.7
            : input.down.block ? MOVE.walk : MOVE.run;
      this.wishSpeed = base * this.hs * clamp01(wish);
    }

    // Strafing (facing decoupled from movement) whenever the player is committed to a target
    // or holding guard — that is when the directional cycles need to read.
    this.strafing = !!this.lockTarget || this.blocking;
    if (this.lockTarget) {
      const lp = targetPos(this.lockTarget);
      if (lp) this.facePoint(lp.x, lp.z);
    }

    // --- jump / double jump ---------------------------------------------------
    if (this._jumpBuffer > 0) {
      if (this.grounded || this.airT < MOVE.coyote || this.inWater) {
        this.wishJump = true;
        this._jumpBuffer = 0;
      } else if (this.airJumpsLeft > 0) {
        this.airJumpsLeft--;
        this._jumpBuffer = 0;
        this.vel.y = MOVE.jumpV * this.hs * 0.92;
        this.setState(ACTOR_STATE.JUMP, { force: true, anim: 'jump_launch' });
        this._playSfx('jump', 0.9);
      }
    }
    if (this.inWater) this.wishUp = input.down.jump ? 1 : (input.down.dodge ? -1 : 0);
  }

  /** Combo, heavy charge and air attack, including buffering and cancel windows. */
  _updateAttacks(dt, input, app) {
    const a = this.attack;

    // Heavy charge: the windup holds at the top of the swing while the button is down. The
    // animator's own clock is pinned, which is what makes the wind-up *shake* read as a hold.
    if (this._charging) {
      const t = ATTACK_TIMINGS.attack_heavy;
      const holdAt = t.windup * 0.92;
      if (a && a.kind === 'attack_heavy' && input.down.heavy && this.chargeT < PLAYER.maxCharge) {
        this.chargeT += dt;
        a.t = Math.min(a.t, holdAt);
        this.animator.time = Math.min(this.animator.time, holdAt);
        this.lockT = Math.max(this.lockT, t.duration - holdAt);
      } else {
        this._charging = false;
        this.emitIntent('heavy', { chargedT: clamp01(this.chargeT / PLAYER.maxCharge) });
      }
      return;
    }

    if (!a) {
      if (this._heavyBuffer > 0) {
        this._heavyBuffer = 0;
        this.comboIndex = -1;
        this.startAttack('attack_heavy');
        this.chargeT = 0;
        this._charging = true;
        return;
      }
      if (this._attackBuffer > 0) {
        this._attackBuffer = 0;
        if (!this.grounded) {
          this.comboIndex = -1;
          this.startAttack('attack_air');
          this.emitIntent('attack', { index: -1 });
        } else {
          this.comboIndex = 0;
          this.startAttack(COMBO_CHAIN[0]);
          this.emitIntent('attack', { index: 0 });
        }
      }
      return;
    }

    // Mid-attack: the buffered press fires as soon as the cancel window opens.
    const timing = a.timing;
    if (a.t >= timing.cancel) {
      if (this._heavyBuffer > 0) {
        this._heavyBuffer = 0;
        this.comboIndex = -1;
        this.startAttack('attack_heavy');
        this.chargeT = 0;
        this._charging = true;
      } else if (this._attackBuffer > 0 && this.comboIndex >= 0 && this.comboIndex < COMBO_CHAIN.length - 1) {
        this._attackBuffer = 0;
        this.comboIndex++;
        this.startAttack(COMBO_CHAIN[this.comboIndex]);
        this.emitIntent('attack', { index: this.comboIndex });
      }
    }
  }

  /** Fruit power. The fruit system owns cost and cooldown; this owns the pose and the intent. */
  _castAbility(index, anim, lock) {
    if (this.attack || this.dodgeKind) return;
    const fruit = this.app && this.app.fruit;
    if (fruit && typeof fruit.canUse === 'function' && !fruit.canUse(index)) return;
    this.emitIntent('ability', { index });
    this.setState(index === 2 ? ACTOR_STATE.CHANNEL : ACTOR_STATE.CAST,
      { force: true, lock, anim });
  }

  /** Begin a dodge. Rolls when moving, dashes when planted — different distance, different read. */
  _startDodge(dirVec) {
    const rolling = !!dirVec;
    this.dodgeKind = rolling ? 'dodge_roll' : 'dodge_dash';
    this.dodgeT = rolling ? PLAYER.dodgeRollTime : PLAYER.dodgeDashTime;
    this.stamina = Math.max(0, this.stamina - PLAYER.dodgeCost);
    this._staminaHold = PLAYER.staminaDelay;
    this.cancelAttack();
    this._charging = false;

    let dx, dz;
    if (rolling) {
      const l = Math.hypot(dirVec.x, dirVec.z) || 1;
      dx = dirVec.x / l; dz = dirVec.z / l;
      this.targetYaw = Math.atan2(dx, dz);
    } else {
      // A planted dodge goes backwards, away from whatever the player is facing.
      dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw);
    }
    const sp = PLAYER.dodgeSpeed * this.hs;
    this.vel.x = dx * sp;
    this.vel.z = dz * sp;
    this.setState(ACTOR_STATE.DODGE, { force: true, lock: this.dodgeT, anim: this.dodgeKind });
    this.emitIntent('dodge', { dir: { x: dx, z: dz } });
  }

  /** Timers that must tick even while the control lockout is active. */
  _postStep(dt, app) {
    // --- dodge, i-frames and the decelerating slide -------------------------
    if (this.dodgeT > 0) {
      const total = this.dodgeKind === 'dodge_roll' ? PLAYER.dodgeRollTime : PLAYER.dodgeDashTime;
      const elapsed = total - this.dodgeT;
      const frames = this.dodgeKind === 'dodge_roll' ? PLAYER.rollIFrames : PLAYER.dashIFrames;
      this.invulnT = (elapsed >= frames[0] && elapsed < frames[1]) ? Math.max(this.invulnT, 1 / 60) : this.invulnT;
      // Ease the dodge out rather than cutting it: a dodge that stops dead reads as a bug.
      const k = clamp01(1 - elapsed / total);
      const sp = PLAYER.dodgeSpeed * this.hs * (0.25 + 0.75 * k * k);
      const cur = Math.hypot(this.vel.x, this.vel.z);
      if (cur > 1e-4) {
        const scale = Math.min(1, sp / cur);
        this.vel.x *= scale; this.vel.z *= scale;
      }
      this.dodgeT -= dt;
      if (this.dodgeT <= 0) { this.dodgeT = 0; this.dodgeKind = null; }
    }

    // --- stamina ------------------------------------------------------------
    if (this._staminaHold > 0) this._staminaHold -= dt;
    else if (this.stamina < this.maxStamina) {
      this.stamina = Math.min(this.maxStamina, this.stamina + PLAYER.staminaRegen * dt);
    }

    // --- air jumps ----------------------------------------------------------
    const fruit = app && app.fruit;
    this.maxAirJumps = fruit && typeof fruit.airJumps === 'number' ? fruit.airJumps : PLAYER.airJumps;
    if (this.grounded || this.inWater) this.airJumpsLeft = this.maxAirJumps;

    // --- combat stance ------------------------------------------------------
    // The guard-up idle is a *memory* of recent combat, not a mode toggle. Three seconds after
    // the last swing or lock-on the character relaxes, which is a free storytelling beat.
    if (this.attack || this.lockTarget || this.blocking) this._combatTimer = 3.0;
    else if (this._combatTimer > 0) this._combatTimer -= dt;
    this.combatReady = this._combatTimer > 0;

    // --- camera feedback ----------------------------------------------------
    // Wheel zoom. core/input.js accumulates the wheel outside the per-step snapshot, so the
    // player is the one place that consumes it (see the ARCHITECTURE §9 request from Cluster B).
    const cam = this._cam(app);
    if (cam && app && app.input && app.input.mouse && app.input.mouse.wheel) {
      cam.addZoom(-app.input.mouse.wheel);
      app.input.mouse.wheel = 0;
    }
  }

  /**
   * Honour the animation state the fruit system asked for.
   *
   * FRUIT publishes `app.fruit.animState` during its own step, which runs *after* the player
   * (ARCHITECTURE §4), so the request the player reads is one step old — invisible at 60 Hz and
   * far cheaper than reordering the simulation. Damage, dodges and attacks still win, because a
   * power that overrides being knocked down reads as the hit not registering.
   */
  _chooseAnim(speed) {
    const fruit = this.app && this.app.fruit;
    const want = fruit ? fruit.animState : null;
    if (want && STATE_META[want] && this.alive && !this.attack && !this.dodgeKind
      && this.state !== ACTOR_STATE.HIT && this.state !== ACTOR_STATE.DOWN
      && this.state !== ACTOR_STATE.GETUP && this.state !== ACTOR_STATE.STAGGER) {
      return want;
    }
    return super._chooseAnim(speed);
  }

  /** Hard landings shake the camera. Cluster C owns impact shake; this one is locomotion. */
  _onLand(vy) {
    super._onLand(vy);
    const cam = this._cam(this.app);
    if (cam && vy < MOVE.hardLandVy * this.hs) {
      cam.shake(clamp(-vy * 0.006, 0.05, 0.22), 0.22, 21);
    }
  }

  // -- lock-on ---------------------------------------------------------------

  /** Candidate targets, nearest first. Feature-detects whichever systems exist. */
  _lockCandidates(app) {
    const out = this._lockList;
    out.length = 0;
    const push = (t) => {
      if (!t || t === this || t.alive === false || t.dead) return;
      const p = targetPos(t);
      if (!p) return;
      const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
      if (d <= PLAYER.lockRange) out.push({ t, d });
    };
    const enemies = app && app.enemies;
    if (enemies) {
      // The facade exposes `list` as a FUNCTION (createEnemiesFacade in combat.js); a plain
      // array is also accepted for older shapes.
      const raw = enemies.list !== undefined ? enemies.list : (enemies.actors || enemies.all);
      const list = typeof raw === 'function' ? raw.call(enemies) : raw;
      if (Array.isArray(list)) for (const e of list) push(e);
      else if (typeof enemies.nearest === 'function') push(enemies.nearest(this.pos));
    }
    if (out.length === 0 && app && app.combat && typeof app.combat.nearestThreat === 'function') {
      // nearestThreat() returns a HUD summary { name, hp, ..., actor } — the actor is the target.
      const t = app.combat.nearestThreat();
      if (t && t.actor) push(t.actor);
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Tap to lock the nearest, tap again to advance, tap past the end to release. */
  _cycleLock(app) {
    const cands = this._lockCandidates(app);
    if (cands.length === 0) { this._setLock(null, app); return; }
    if (!this.lockTarget) { this._setLock(cands[0].t, app); return; }
    const idx = cands.findIndex((c) => c.t === this.lockTarget);
    const next = idx + 1;
    this._setLock(next < cands.length ? cands[next].t : null, app);
  }

  _lockValid(t) {
    if (!t || t.alive === false || t.dead) return false;
    const p = targetPos(t);
    if (!p) return false;
    return Math.hypot(p.x - this.pos.x, p.z - this.pos.z) <= PLAYER.lockRange * 1.25;
  }

  _setLock(t, app) {
    this.lockTarget = t || null;
    const cam = this._cam(app);
    if (cam && cam.setLockTarget) cam.setLockTarget(this.lockTarget);
    this._playSfx(t ? 'ui_confirm' : 'ui_cancel', 0.4);
  }

  // -- interaction -----------------------------------------------------------

  /**
   * Find what the player would interact with: nearest thing inside a cone in front of them.
   * A cone, not a ray, because a ray demands pixel-accurate aim from a third-person camera.
   */
  _findInteractable(app) {
    if (!app) return null;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let best = null, bestD = Infinity;
    const consider = (obj) => {
      if (!obj) return;
      const p = obj.pos || obj;
      const x = p.x !== undefined ? p.x : p[0];
      const z = p.z !== undefined ? p.z : p[2];
      if (x === undefined || z === undefined) return;
      if (!inArc(x, z, this.pos.x, this.pos.z, fx, fz, PLAYER.interactRange, PLAYER.interactArc)) return;
      const d = Math.hypot(x - this.pos.x, z - this.pos.z);
      if (d < bestD) { bestD = d; best = obj; }
    };
    const npc = app.npc;
    if (npc) {
      const list = npc.list || npc.actors;
      if (Array.isArray(list)) for (const n of list) { if (n.interactable !== false) consider(n); }
    }
    const world = app.world;
    if (world && typeof world.interactablesNear === 'function') {
      const list = world.interactablesNear(this.pos.x, this.pos.z, PLAYER.interactRange);
      if (Array.isArray(list)) for (const o of list) consider(o);
    }
    // The ship's gangplank. Without this there is no code path from KeyE to boarding at all
    // (ship.step only reads interact while already aboard).
    const ship = app.ship;
    if (!this.onShip && ship && typeof ship.canBoard === 'function' && ship.canBoard(this.pos)) {
      const bp = ship.boardingPoint();
      consider({
        pos: { x: bp.x, y: bp.y, z: bp.z },
        label: 'Board ship',
        onInteract: (player) => ship.boardPlayer(player.pos),
      });
    }
    return best;
  }

  /** Confirm an interaction. The target decides what it means; the player only points at it. */
  _doInteract(app) {
    const t = this.interactTarget;
    this.pendingInteract = t;
    if (t && typeof t.onInteract === 'function') t.onInteract(this, app);
    else if (t && t.npcId && app.quest && typeof app.quest.converse === 'function') {
      app.quest.converse(t.npcId);
    }
    this.setState(ACTOR_STATE.TALK, { force: true, lock: 0.25 });
    this._playSfx('ui_confirm', 0.5);
  }

  // -- persistence -----------------------------------------------------------

  serialize() {
    const o = super.serialize();
    o.stam = this.stamina;
    o.combo = this.comboIndex;
    return o;
  }

  deserialize(o) {
    super.deserialize(o);
    if (o && typeof o.stam === 'number') this.stamina = o.stam;
    if (o && typeof o.combo === 'number') this.comboIndex = o.combo;
    this.intents.length = 0;
    return this;
  }
}

/**
 * Factory.
 * @param {object} app @param {object} [opts] { spec, pos, yaw, camera }
 * @returns {Player}
 */
export function createPlayer(app, opts = {}) {
  return new Player(app, opts.spec || 'hero_captain', opts);
}

export default Player;
