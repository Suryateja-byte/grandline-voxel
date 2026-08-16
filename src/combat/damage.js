// Damage resolution. The rules of the fight, in one file, with no rendering and no AI.
//
// Everything that can happen when a hit meets a body happens here, in a fixed order:
//   i-frames -> parry -> block (stamina, guard break) -> element reaction -> crit -> damage
//   -> poise/stagger -> death
//
// Two design commitments the rest of cluster C depends on:
//
// 1. THE DEFENSIVE PROMISE IS ENFORCED HERE. telegraph.js tells the player which option works;
//    this file is what makes that true. A 'parryable' attack really is negated by a parry, an
//    'unblockable' one really does ignore guard. If the two files ever disagree, the player
//    learns that telegraphs lie, and every wind-up in the game becomes noise.
//
// 2. NOTHING ELSE MUTATES HP. combat.applyHit is the only caller, and it is the only entry the
//    rest of the game has (ARCHITECTURE §5). Environmental damage, drowning, lava and fall damage
//    all build a Hit and come through here, so they all get i-frames, FX and quest events free.
//
// Numbers are tuned for a ~100 hp player against tier-1 enemies dealing 8–14: about eight
// mistakes before death, which is enough room to learn a telegraph and short enough to respect it.

import { clamp, clamp01, lerp } from '../core/math.js';
import { ELEMENT, TAG, hasTag } from './hitbox.js';

/** Status effects a body can carry. One slot each — statuses refresh, they never stack twice. */
export const STATUS = Object.freeze({
  BURNING: 'burning',   // damage over time; thaws frost
  FROZEN: 'frozen',     // cannot act; the next hit SHATTERS for bonus damage
  CHILLED: 'chilled',   // frost accumulating toward FROZEN
  SANDED: 'sanded',     // movement slowed
  QUAKED: 'quaked',     // standing on cracked ground; collapse deals a follow-up
  GRAVITY: 'gravity',   // pulled toward a well
});

/** The parry window, measured from the frame block was pressed. Hades-tight, deliberately. */
export const PARRY_WINDOW = 0.15;
/** Fraction of damage a held (non-parry) block absorbs against a fully blockable hit. */
export const BLOCK_ABSORB = 0.72;
/** Seconds of stagger a guard break costs. Long enough to be punished, short enough to recover. */
export const GUARD_BREAK_STAGGER = 1.15;
/** Seconds an attacker is staggered by a successful parry. This is the reward. */
export const PARRY_STAGGER = 1.25;
/** Seconds of i-frames granted by a dodge roll. */
export const DODGE_IFRAMES = 0.34;
/** Seconds after taking a hit before poise starts refilling. */
export const POISE_REGEN_DELAY = 1.6;
/** Poise refilled per second once regen starts. */
export const POISE_REGEN_RATE = 26;
/** Stamina refilled per second while not blocking and not attacking. */
export const STAMINA_REGEN_RATE = 22;
/** Delay before stamina regen resumes after spending. */
export const STAMINA_REGEN_DELAY = 0.75;
/** Frost stacks needed to freeze. Each frost hit adds one. */
export const FREEZE_STACKS = 3;
/** Damage multiplier when a hit lands on a FROZEN target. The shatter. */
export const SHATTER_MULT = 2.15;
/** Movement multiplier applied to a sand-covered target. */
export const SAND_SLOW = 0.55;
/** Fraction of a target's maxHp a nonLethal attacker can never take them below. */
export const SPAR_FLOOR = 0.30;
/** Stagger when an unkillable target is 'defeated' — spared, not killed. */
export const SPAR_BREAK_STAGGER = 1.1;

/**
 * Give an actor the combat fields every resolver here assumes. Called once, at spawn.
 *
 * @param {object} a the actor (must already have x/y/z and an id)
 * @param {object} [s] stat overrides
 * @returns {object} the same actor
 */
export function initCombatant(a, s = {}) {
  a.maxHp = s.maxHp !== undefined ? s.maxHp : 100;
  a.hp = s.hp !== undefined ? s.hp : a.maxHp;
  a.maxPoise = s.maxPoise !== undefined ? s.maxPoise : 40;
  a.poise = a.maxPoise;
  a.maxStamina = s.maxStamina !== undefined ? s.maxStamina : 100;
  a.stamina = a.maxStamina;
  a.defence = s.defence !== undefined ? s.defence : 0;      // flat reduction, applied after mults
  a.damageMult = s.damageMult !== undefined ? s.damageMult : 1;
  a.team = s.team !== undefined ? s.team : 1;
  a.dead = false;
  a.removed = false;

  // --- transient combat state (all seconds remaining) ---
  a.iframes = 0;
  a.hitstun = 0;
  a.stagger = 0;
  a.blocking = false;
  a.blockTime = -1;          // seconds since block began; -1 when not blocking
  a.guardBroken = 0;
  a.poiseDelay = 0;
  a.staminaDelay = 0;
  a.lastHitDir = 0;          // yaw the last hit came from; the flinch animation reads it
  a.lastHitTime = -999;
  a.hitFlash = 0;
  // Declared here, not created lazily in stepStatus: a field added mid-fight rebuilds the
  // object's hidden class on the frame the first burn lands.
  a._burnAcc = 0;

  // --- status ---
  a.status = {
    burnT: 0, burnDps: 0, burnSrc: null,
    frostStacks: 0, frostT: 0, frozenT: 0,
    sandT: 0,
    quakeT: 0,
    gravityT: 0, gravityX: 0, gravityZ: 0, gravityPull: 0,
  };
  /** Elemental resistances, 0 = none, 1 = immune. Fishmen resist frost, not flame. */
  a.resist = Object.assign({ flame: 0, frost: 0, sand: 0, quake: 0, gravity: 0 }, s.resist);
  return a;
}

/** Outcome of one resolution. Pooled — combat holds a single instance and reuses it. */
export function makeOutcome() {
  return {
    connected: false,     // did anything happen at all
    dodged: false,        // i-frames ate it
    blocked: false,
    parried: false,
    guardBroken: false,
    crit: false,
    shatter: false,
    staggered: false,
    killed: false,
    spared: false,        // an unkillable target was 'defeated' — beaten, never dead
    damage: 0,            // damage actually applied to hp
    absorbed: 0,          // damage removed by block
    poiseDamage: 0,
    element: ELEMENT.NONE,
    reaction: '',         // '', 'shatter', 'thaw', 'freeze', 'burn', 'slow', 'crack'
    target: null,
    source: null,
    dirX: 0, dirZ: 0,
    px: 0, py: 0, pz: 0,
    hitstop: 0,
    shake: 0,
  };
}

function resetOutcome(o) {
  o.connected = false; o.dodged = false; o.blocked = false; o.parried = false;
  o.guardBroken = false; o.crit = false; o.shatter = false; o.staggered = false;
  o.killed = false; o.spared = false; o.damage = 0; o.absorbed = 0; o.poiseDamage = 0;
  o.element = ELEMENT.NONE; o.reaction = ''; o.target = null; o.source = null;
  o.dirX = 0; o.dirZ = 0; o.px = 0; o.py = 0; o.pz = 0; o.hitstop = 0; o.shake = 0;
  return o;
}

/**
 * Is the attacker behind the target? Backstabs auto-crit — it is the knifer's whole identity and
 * the player's reward for circling.
 * @returns {boolean}
 */
export function isBackstab(target, dirX, dirZ) {
  const fx = Math.sin(target.yaw || 0), fz = Math.cos(target.yaw || 0);
  // dirX/dirZ points attacker -> target. Behind means it agrees with the target's own facing.
  return dirX * fx + dirZ * fz > 0.55;
}

/**
 * Resolve one hit against one target.
 *
 * @param {object} target
 * @param {import('./hitbox.js').Hit} hit
 * @param {object} ctx { rng, simTime, outcome, bonuses }
 *   rng      — a deterministic Rng stream owned by combat; the ONLY randomness in the fight
 *   simTime  — app.clock.simTime, for parry windows and hit records
 *   outcome  — a pooled outcome object to fill
 *   bonuses  — quest crew bonuses (meleeDamageMult / rangedDamageMult), optional
 * @returns {object} the filled outcome
 */
export function resolveDamage(target, hit, ctx) {
  const o = resetOutcome(ctx.outcome);
  o.target = target;
  o.source = hit.source;
  o.dirX = hit.dirX; o.dirZ = hit.dirZ;
  o.px = hit.px; o.py = hit.py; o.pz = hit.pz;
  o.element = hit.element;

  if (!target || target.dead || target.removed) return o;

  // --- 1. invulnerability -------------------------------------------------
  if (target.iframes > 0) {
    o.dodged = true;
    return o;
  }

  // Any actor can be hit — spawned enemies, NPCs caught in an AoE, a crew member on deck.
  // Rather than requiring every producer of actors to remember to initialise a combat
  // body, do it lazily on first contact. Missing this crashed the first assembled build.
  if (!target.status) {
    // Preserve anything the actor already configured. Seeding purely from `spec` reset a
    // player built with maxHp 120 back to the 100 default on its first hit.
    initCombatant(target, Object.assign({}, target.spec || {}, {
      maxHp: target.maxHp, hp: target.hp,
      maxStamina: target.maxStamina, team: target.team,
    }));
  }
  const st = target.status;
  const unblockable = hit.blockable <= 0 || hasTag(hit, TAG.UNBLOCKABLE);
  const facing = hit.dirX * Math.sin(target.yaw || 0) + hit.dirZ * Math.cos(target.yaw || 0);
  // A block only covers the front 240 degrees. Getting flanked while turtling must not be safe.
  const guardCovers = facing < 0.5;

  // --- 2. parry -----------------------------------------------------------
  // The window opens on the frame block is pressed and lasts PARRY_WINDOW. A parry beats
  // everything except an explicitly unblockable move: that is the deal the red colour makes.
  if (target.blocking && guardCovers && !unblockable
      && target.blockTime >= 0 && target.blockTime <= PARRY_WINDOW) {
    o.connected = true;
    o.parried = true;
    o.hitstop = Math.max(0.11, hit.hitstop * 2.2);
    o.shake = 0.30;
    target.stamina = Math.min(target.maxStamina, target.stamina + 12);
    // The attacker eats the stagger. Combat applies it — damage.js never reaches into the
    // attacker's state machine, it only reports what should happen.
    return o;
  }

  // --- 3. element reaction (before damage, because it scales it) -----------
  let mult = 1;
  const res = target.resist;
  switch (hit.element) {
    case ELEMENT.FROST: {
      const r = 1 - clamp01(res.frost);
      if (r > 0.05) {
        if (st.burnT > 0) { st.burnT = 0; o.reaction = 'thaw'; }
        else {
          st.frostStacks += 1;
          st.frostT = 4.5;
          if (st.frostStacks >= FREEZE_STACKS && st.frozenT <= 0) {
            st.frozenT = 2.0 * r;
            st.frostStacks = 0;
            o.reaction = 'freeze';
          }
        }
      }
      break;
    }
    case ELEMENT.FLAME: {
      const r = 1 - clamp01(res.flame);
      if (r > 0.05) {
        if (st.frozenT > 0 || st.frostStacks > 0) {
          // Fire on ice: the freeze breaks instead of burning. Reads instantly, and it stops
          // frost+flame from being a strictly-better combo than either alone.
          st.frozenT = 0; st.frostStacks = 0; st.frostT = 0;
          o.reaction = 'thaw';
          mult *= 1.25;
        } else {
          st.burnT = 4.0 * r;
          st.burnDps = 5.5 * r;
          st.burnSrc = hit.source;
          o.reaction = 'burn';
        }
      }
      break;
    }
    case ELEMENT.SAND: {
      const r = 1 - clamp01(res.sand);
      if (r > 0.05) { st.sandT = 3.2 * r; o.reaction = 'slow'; }
      break;
    }
    case ELEMENT.QUAKE: {
      const r = 1 - clamp01(res.quake);
      if (r > 0.05) { st.quakeT = 1.0; o.reaction = 'crack'; }
      break;
    }
    case ELEMENT.GRAVITY: {
      const r = 1 - clamp01(res.gravity);
      if (r > 0.05) {
        st.gravityT = 1.4 * r;
        st.gravityX = hit.px; st.gravityZ = hit.pz;
        st.gravityPull = 7.5 * r;
      }
      break;
    }
    default: break;
  }

  // Shatter: any hit on a frozen target. This is the pay-off that makes frost worth carrying.
  if (st.frozenT > 0) {
    mult *= SHATTER_MULT;
    st.frozenT = 0;
    o.shatter = true;
    o.reaction = 'shatter';
  }

  // --- 4. crit ------------------------------------------------------------
  const back = isBackstab(target, hit.dirX, hit.dirZ);
  let crit = back;
  if (!crit && hit.critChance > 0 && ctx.rng) crit = ctx.rng.f() < hit.critChance;
  if (crit) { mult *= hit.critMult; o.crit = true; }
  hit.crit = crit;

  // --- 5. attacker-side multipliers ---------------------------------------
  let raw = hit.damage * mult;
  const src = hit.source;
  if (src && src.damageMult) raw *= src.damageMult;
  if (ctx.bonuses) {
    if (hasTag(hit, TAG.RANGED) && ctx.bonuses.rangedDamageMult) raw *= ctx.bonuses.rangedDamageMult;
    else if (hasTag(hit, TAG.MELEE) && ctx.bonuses.meleeDamageMult) raw *= ctx.bonuses.meleeDamageMult;
  }

  // --- 6. block -----------------------------------------------------------
  let poiseDmg = hit.poise * (crit ? 1.4 : 1);
  if (target.blocking && guardCovers && target.guardBroken <= 0) {
    if (unblockable) {
      // The guard is simply not there. No stamina is spent — punishing the player twice for
      // holding block against a red attack would be gratuitous.
      o.blocked = false;
    } else {
      const absorb = BLOCK_ABSORB * clamp01(hit.blockable);
      const before = raw;
      raw *= (1 - absorb);
      o.absorbed = before - raw;
      o.blocked = true;
      poiseDmg *= 0.35;
      const cost = hit.guardCost * (1 + clamp01(hit.blockable) * 0.4);
      target.stamina -= cost;
      target.staminaDelay = STAMINA_REGEN_DELAY;
      if (target.stamina <= 0 || hasTag(hit, TAG.GUARD_BREAK)) {
        target.stamina = 0;
        target.guardBroken = GUARD_BREAK_STAGGER;
        target.blocking = false;
        target.blockTime = -1;
        o.guardBroken = true;
        // Guard break restores the damage the block was absorbing, plus a punish premium.
        raw = before * 1.15;
        o.absorbed = 0;
        poiseDmg = hit.poise * 2;
      }
    }
  }

  // --- 7. defence and application ------------------------------------------
  raw = Math.max(1, raw - (target.defence || 0));
  // A nonLethal attacker (the sparring partner) never takes anyone below the training floor.
  // Clamping the final number catches crits, backstabs and every multiplier above; at the
  // floor the hit still connects — feedback, hitstun and poise keep reading correctly.
  if (src && src.nonLethal) {
    raw = Math.max(0, Math.min(raw, target.hp - target.maxHp * SPAR_FLOOR));
  }
  const dmg = raw;
  target.hp -= dmg;
  o.damage = dmg;
  o.connected = true;
  target.lastHitDir = Math.atan2(-hit.dirX, -hit.dirZ);
  target.lastHitTime = ctx.simTime;
  target.poiseDelay = POISE_REGEN_DELAY;
  target.staminaDelay = Math.max(target.staminaDelay, 0.35);

  // --- 8. poise and stagger -------------------------------------------------
  o.poiseDamage = poiseDmg;
  target.poise -= poiseDmg;
  if (target.poise <= 0) {
    target.poise = target.maxPoise;
    // Stagger length scales with how badly the poise pool was overrun, so a big hit on a nearly
    // broken enemy reads as a bigger reaction than a chip hit that happens to tip it over.
    const over = clamp01(poiseDmg / Math.max(1, target.maxPoise));
    target.stagger = Math.max(target.stagger, lerp(0.42, 0.95, over));
    o.staggered = true;
  } else {
    // Even a non-staggering hit interrupts briefly. This is the difference between "I hit it"
    // and "I hit it and it did not care".
    target.hitstun = Math.max(target.hitstun, o.blocked ? 0.06 : 0.14);
  }

  // --- 9. feedback budget ---------------------------------------------------
  // Hitstop and shake are computed from the same numbers the damage is, so a big hit always
  // feels big and a chip hit never steals the screen.
  const weight = clamp01(dmg / 45);
  o.hitstop = hit.hitstop * (crit ? 1.75 : 1) * (o.shatter ? 1.6 : 1) * (o.blocked ? 0.55 : 1)
    + weight * 0.035;
  o.shake = (o.blocked ? 0.08 : 0.14) + weight * 0.30 + (crit ? 0.10 : 0) + (o.shatter ? 0.16 : 0);

  // --- 10. death ------------------------------------------------------------
  if (target.hp <= 0) {
    if (target.unkillable) {
      // Spared, never killed: pin at 1 hp, stagger hard, and report it so combat can break
      // the bout off. o.killed stays false — no death path, no kill credit, no rewards.
      target.hp = 1;
      target.stagger = Math.max(target.stagger, SPAR_BREAK_STAGGER);
      o.staggered = true;
      o.spared = true;
    } else {
      target.hp = 0;
      target.dead = true;
      o.killed = true;
      o.hitstop = Math.max(o.hitstop, 0.14);
      o.shake = Math.max(o.shake, 0.34);
    }
  }
  return o;
}

/**
 * Advance one actor's per-step combat state: timers, regen, and damage over time.
 *
 * Returns a follow-up hit descriptor when a status needs to deal damage this step (burn ticks,
 * quake-crack collapse), or null. Combat routes it back through applyHit so DoT damage gets the
 * same FX, quest events and death handling as a sword swing.
 *
 * @param {object} a
 * @param {number} dt
 * @param {object} scratchHit a pooled Hit reused for the returned tick
 * @returns {object|null}
 */
export function stepStatus(a, dt, scratchHit) {
  if (a.dead) return null;
  if (a.iframes > 0) a.iframes -= dt;
  if (a.hitstun > 0) a.hitstun -= dt;
  if (a.stagger > 0) a.stagger -= dt;
  if (a.guardBroken > 0) a.guardBroken -= dt;
  if (a.hitFlash > 0) a.hitFlash = Math.max(0, a.hitFlash - dt * 7);

  if (a.blocking) {
    a.blockTime = a.blockTime < 0 ? 0 : a.blockTime + dt;
  } else {
    a.blockTime = -1;
  }

  // Poise regen.
  if (a.poiseDelay > 0) a.poiseDelay -= dt;
  else if (a.poise < a.maxPoise) a.poise = Math.min(a.maxPoise, a.poise + POISE_REGEN_RATE * dt);

  // Stamina regen. Blocking holds it flat rather than draining it — the drain is per-hit, which
  // makes the cost legible ("that swing cost me a quarter of my guard") instead of ambient.
  if (a.staminaDelay > 0) a.staminaDelay -= dt;
  else if (!a.blocking && a.stamina < a.maxStamina) {
    a.stamina = Math.min(a.maxStamina, a.stamina + STAMINA_REGEN_RATE * dt);
  }

  const st = a.status;
  if (st.frozenT > 0) st.frozenT -= dt;
  if (st.frostT > 0) {
    st.frostT -= dt;
    if (st.frostT <= 0) st.frostStacks = 0;
  }
  if (st.sandT > 0) st.sandT -= dt;
  if (st.gravityT > 0) st.gravityT -= dt;

  let tick = null;
  if (st.burnT > 0) {
    st.burnT -= dt;
    a._burnAcc = (a._burnAcc || 0) + st.burnDps * dt;
    // Burn is billed in whole points, ~3 times a second, so the damage numbers stay readable
    // instead of spraying 0.09s across the screen.
    if (a._burnAcc >= 1) {
      const n = Math.floor(a._burnAcc);
      a._burnAcc -= n;
      tick = scratchHit;
      tick.damage = n;
      tick.poise = 0;
      tick.knockback = 0;
      tick.launch = 0;
      tick.hitstop = 0;
      tick.element = ELEMENT.FLAME;
      tick.critChance = 0;
      tick.critMult = 1;
      tick.crit = false;
      tick.blockable = 0;
      tick.guardCost = 0;
      tick.source = st.burnSrc;
      tick.tags.length = 0;
      tick.tags.push(TAG.DOT);
      tick.fxKind = 'flame';
      tick.dirX = 0; tick.dirZ = 0;
      tick.px = a.x; tick.py = a.y + (a.height || 1.8) * 0.6; tick.pz = a.z;
    }
  } else {
    a._burnAcc = 0;
  }

  if (st.quakeT > 0) {
    st.quakeT -= dt;
    if (st.quakeT <= 0 && !tick) {
      // The crack collapses. This is the delayed half of a quake hit and it is why the quake
      // decal stays on the ground: it is a countdown, not a scorch mark.
      tick = scratchHit;
      tick.damage = 9;
      tick.poise = 26;
      tick.knockback = 1.5;
      tick.launch = 5.5;
      tick.hitstop = 0.08;
      tick.element = ELEMENT.NONE;
      tick.critChance = 0;
      tick.critMult = 1;
      tick.crit = false;
      tick.blockable = 0;
      tick.guardCost = 0;
      tick.source = null;
      tick.tags.length = 0;
      tick.tags.push(TAG.ENVIRONMENT);
      tick.tags.push(TAG.AOE);
      tick.fxKind = 'quake';
      tick.dirX = 0; tick.dirZ = 0;
      tick.px = a.x; tick.py = a.y; tick.pz = a.z;
    }
  }
  return tick;
}

/** Movement multiplier from status. Read by the mover, never by the resolver. */
export function movementScale(a) {
  const st = a.status;
  if (st.frozenT > 0) return 0;
  let s = 1;
  if (st.sandT > 0) s *= SAND_SLOW;
  if (a.stagger > 0 || a.guardBroken > 0) s *= 0.15;
  else if (a.hitstun > 0) s *= 0.5;
  if (a.blocking) s *= 0.55;
  return s;
}

/** Can this actor act at all this step? */
export function canAct(a) {
  return !a.dead && a.stagger <= 0 && a.guardBroken <= 0 && a.status.frozenT <= 0 && a.hitstun <= 0;
}

/** Grant i-frames, e.g. from a dodge. Never shortens an existing window. */
export function grantIframes(a, seconds) {
  a.iframes = Math.max(a.iframes, seconds);
}

/**
 * Heal. Goes through a named function rather than `hp +=` so healing FX, overheal clamping and
 * the "no module mutates hp" rule all have exactly one place to live.
 * @returns {number} hp actually restored
 */
export function heal(a, amount) {
  if (a.dead) return 0;
  const before = a.hp;
  a.hp = Math.min(a.maxHp, a.hp + amount);
  return a.hp - before;
}

/**
 * Emit the quest-layer consequences of a defeat.
 *
 * The quest system consumes exactly two events (ARCHITECTURE §9): `enemyDefeated` with a kind
 * from ENEMY_KINDS, and `bossDefeated` with an id from BOSSES. `fightId` is required for the
 * win-without-damage objective, so it is always supplied.
 *
 * @param {object} app
 * @param {object} enemy
 * @param {string|null} fightId
 */
export function notifyDefeat(app, enemy, fightId) {
  const q = app && (app.quests || app.quest);
  if (!q || typeof q.notify !== 'function') return;
  if (enemy.bossId) {
    q.notify('bossDefeated', { id: enemy.bossId, name: enemy.name || enemy.bossId, fightId });
  }
  const kind = enemy.questKind || 'thug';
  q.notify('enemyDefeated', {
    kind,
    // The family prefix ('thug' for thug_brute, 'marine' for marine_grunt). Quests author
    // against the family when any member should count — without this, a "defeat 3 thugs"
    // objective was uncompletable on seeds whose camps happened to roll only thug_brutes.
    family: kind.indexOf('_') > 0 ? kind.slice(0, kind.indexOf('_')) : kind,
    named: !!enemy.named,
    elite: !!enemy.elite,
    fightId,
  });
}

/** Emit the quest-layer consequence of the player being hit. */
export function notifyDamageTaken(app, fightId) {
  const q = app && (app.quests || app.quest);
  if (!q || typeof q.notify !== 'function') return;
  q.notify('damageTaken', { fightId });
}

export { clamp, clamp01 };
