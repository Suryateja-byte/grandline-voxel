// Enemy archetypes. GENUINELY different behaviour, not stat variants.
//
// The test each archetype has to pass: if you deleted its health bar and its model and left only
// its movement rhythm and telegraph vocabulary, could a player still name it? A thug that winds up
// wide and slow, a knifer that never stops circling, a brute that commits to one unanswerable
// swing, a rifleman whose reload is the invitation — these are different verbs, and the counter to
// each is different.
//
//   thug         slow 2-hit combo, wide telegraphs        -> dodge INTO it, punish the second swing
//   knifer       fast, circles, backstabs, brittle         -> parry it or interrupt it
//   brute        unblockable overhead + charge, breaks guard -> punish the recovery, never block
//   marine_rifle kites, takes cover, RELOADS               -> close during the reload
//   fishman      leaps, water jet, stronger when wet       -> fight it away from water
//   bomber       suicide charge with a visible fuse        -> kill it at range or dodge the blast
//   captain      mini-boss, 4 moves, phase at 50%, summons -> manage the adds, punish the phase gap
//   admiral      3 phases, arena-wide, one parry-only move -> the parry is the fight
//
// THE AGGRESSION BUDGET is the single biggest readability win in group fights: a token system
// lets only N enemies attack at once while the rest circle. Six enemies all swinging is noise; two
// swinging while four visibly wait is a fight you can read. Hades does this and so does every good
// brawler; it is not an optimisation, it is the design.
//
// No three.js here, no rendering, no clock reads. Everything is stepped at the fixed timestep and
// every random choice comes from a seeded stream, so a fight replays exactly.

import { Rng } from '../core/rng.js';
import { clamp, clamp01, lerp, angleDelta, TAU } from '../core/math.js';
import { makeBody, GRAVITY, TERMINAL_V } from '../core/physics.js';
import {
  defineTelegraph, TELEGRAPH_KIND, DANGER, GROWTH, ANCHOR,
} from '../combat/telegraph.js';
import { ELEMENT, TAG } from '../combat/hitbox.js';
import { initCombatant, canAct, movementScale } from '../combat/damage.js';

/** AI states. The machine is small on purpose — a big one is a machine nobody can debug. */
export const STATE = Object.freeze({
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',            // saw you, has not committed yet
  APPROACH: 'approach',
  STRAFE: 'strafe',          // in range, waiting for a token
  ATTACK: 'attack',          // telegraph running
  RECOVER: 'recover',        // THE punish window
  REPOSITION: 'reposition',  // deliberately backing off / repositioning / reloading
  FLEE: 'flee',
  STAGGERED: 'staggered',
  DEAD: 'dead',
});

/** Shape families a move can spawn. Combat turns these into hitboxes. */
export const MOVE_SHAPE = Object.freeze({
  ARC: 'arc', SWEEP: 'sweep', SPHERE: 'sphere', LINE: 'line', PROJECTILE: 'projectile',
});

const T = TELEGRAPH_KIND;

/** Shorthand for authoring a move. Keeps the archetype tables readable. */
function move(o) {
  return {
    id: o.id,
    telegraph: o.telegraph,
    shape: o.shape || MOVE_SHAPE.ARC,
    /** Distance band in which the AI will choose this move. */
    range: o.range !== undefined ? o.range : 3,
    minRange: o.minRange !== undefined ? o.minRange : 0,
    /** Per-move cooldown, seconds. */
    cooldown: o.cooldown !== undefined ? o.cooldown : 2.5,
    /** Seconds the hitbox stays live. */
    active: o.active !== undefined ? o.active : 0.12,
    /** Seconds of vulnerable recovery AFTER the strike. This is the player's reward. */
    recovery: o.recovery !== undefined ? o.recovery : 0.55,
    /** Metres the attacker lunges forward on the strike. */
    advance: o.advance !== undefined ? o.advance : 0,
    /** Selection weight inside the legal set. */
    weight: o.weight !== undefined ? o.weight : 1,
    /** Aggression tokens this move costs. A brute costs the whole budget. */
    tokens: o.tokens !== undefined ? o.tokens : 1,
    /** Chain into this move id immediately, without releasing the token. */
    chain: o.chain || null,
    /** Hit payload parameters. */
    damage: o.damage !== undefined ? o.damage : 10,
    poise: o.poise !== undefined ? o.poise : 14,
    knockback: o.knockback !== undefined ? o.knockback : 3.5,
    launch: o.launch !== undefined ? o.launch : 0,
    hitstop: o.hitstop !== undefined ? o.hitstop : 0.055,
    element: o.element || ELEMENT.NONE,
    blockable: o.blockable !== undefined ? o.blockable : 1,
    guardCost: o.guardCost !== undefined ? o.guardCost : 12,
    tags: o.tags || [TAG.MELEE],
    fxKind: o.fxKind || 'slash',
    /** Geometry. */
    reach: o.reach !== undefined ? o.reach : 2.4,
    halfAngle: o.halfAngle !== undefined ? o.halfAngle : 0.85,
    width: o.width !== undefined ? o.width : 1.2,
    /** PROJECTILE only. */
    speed: o.speed !== undefined ? o.speed : 40,
    gravity: o.gravity !== undefined ? o.gravity : 0,
    projRadius: o.projRadius !== undefined ? o.projRadius : 0.2,
    /** Non-damage side effect resolved by combat: 'summon' | 'detonate' | 'leap' | 'charge'. */
    effect: o.effect || null,
    /** Phase gate: only legal at or above this phase index. */
    phase: o.phase !== undefined ? o.phase : 0,
    /** Sound the wind-up plays. AUDIO owns the bank; we only name entries that exist. */
    sfx: o.sfx || null,
  };
}

// ---------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------

/**
 * Every archetype. `charSpec` names an entry in src/gen/charmodel.js CHARACTER_SPECS (as a string,
 * so this file stays free of the render-side import chain). `questKind` is one of quests.js
 * ENEMY_KINDS, which is what the quest layer counts.
 */
export const ENEMY_ARCHETYPES = Object.freeze({

  // -------------------------------------------------------------------- thug
  // The teaching enemy. Everything is slow and wide. Its second swing is where the player
  // learns that dodging INTO an attacker is safer than backing away from one.
  thug: {
    id: 'thug',
    name: 'Dock Thug',
    charSpec: 'pirate_thug',
    questKind: 'thug',
    tier: 1,
    stats: { maxHp: 62, maxPoise: 34, defence: 0, mass: 78, radius: 0.44, height: 1.85 },
    speed: 3.0,
    turnRate: 7.0,
    xp: 12, berries: 40,
    ai: {
      aggro: 16, deaggro: 30,
      reaction: 0.42,             // seconds staring at you before it commits
      preferredMin: 1.6, preferredMax: 3.4,
      strafeSpeed: 1.5, strafeHold: [0.7, 1.5],
      repositionChance: 0.25, repositionTime: [0.5, 0.9],
      fleeHp: 0,
      blockAware: 0.45,           // 0..1 how strongly it avoids attacking into a raised guard
      punishRecovery: 0.5,        // 0..1 how aggressively it exploits your attack recovery
      tokens: 1,
    },
    moves: [
      move({
        id: 'combo1', shape: MOVE_SHAPE.SWEEP, range: 3.6, cooldown: 2.6, weight: 3,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.DODGEABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.62, sustain: 0.20, radius: 3.1, halfAngle: 1.0, label: 'INCOMING',
        }),
        damage: 11, poise: 16, knockback: 4.0, recovery: 0.34, advance: 0.9,
        reach: 3.1, halfAngle: 1.0, active: 0.14, chain: 'combo2', sfx: 'enemy_windup',
      }),
      move({
        id: 'combo2', shape: MOVE_SHAPE.SWEEP, range: 4.2, cooldown: 0, weight: 0,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.DODGEABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.44, sustain: 0.24, radius: 3.3, halfAngle: 1.25, label: 'INCOMING',
        }),
        // The pay-off swing: bigger, wider, and followed by a long recovery. Dodge through it and
        // you get a free hit; back away and it walks you into the second one.
        damage: 15, poise: 22, knockback: 6.0, recovery: 0.86, advance: 1.5,
        reach: 3.3, halfAngle: 1.25, active: 0.16, sfx: 'enemy_windup',
      }),
      move({
        id: 'shove', shape: MOVE_SHAPE.ARC, range: 2.4, cooldown: 5.5, weight: 1,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.BLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.38, sustain: 0.14, radius: 2.0, halfAngle: 0.7, label: 'BLOCK',
        }),
        damage: 5, poise: 30, knockback: 9.0, recovery: 0.5, guardCost: 22,
        reach: 2.0, halfAngle: 0.7, fxKind: 'blunt', sfx: 'enemy_windup',
      }),
    ],
  },

  // ------------------------------------------------------------------ knifer
  // Never stands still, never commits for long, and will walk around behind you while you deal
  // with someone else. Low health so that one clean parry or one interrupt ends it.
  knifer: {
    id: 'knifer',
    name: 'Cutthroat',
    charSpec: 'pirate_knifer',
    questKind: 'thug',
    tier: 1,
    stats: { maxHp: 38, maxPoise: 18, defence: 0, mass: 62, radius: 0.36, height: 1.72 },
    speed: 4.6,
    turnRate: 12.0,
    xp: 15, berries: 55,
    ai: {
      aggro: 20, deaggro: 34,
      reaction: 0.22,
      preferredMin: 2.2, preferredMax: 4.2,
      strafeSpeed: 3.4, strafeHold: [0.45, 0.9],
      repositionChance: 0.55, repositionTime: [0.35, 0.7],
      fleeHp: 0.18,               // bleeds off at low health, then comes back
      blockAware: 0.8,
      punishRecovery: 0.95,
      tokens: 1,
      /** Circles toward your back rather than orbiting neutrally. The identity behaviour. */
      flank: 1,
    },
    moves: [
      move({
        id: 'jab', shape: MOVE_SHAPE.SWEEP, range: 3.6, cooldown: 1.5, weight: 3,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.PARRYABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.30, sustain: 0.12, radius: 2.4, width: 0.7, label: 'PARRY',
        }),
        damage: 8, poise: 8, knockback: 2.2, recovery: 0.30, advance: 1.6,
        reach: 2.4, width: 0.7, active: 0.08, fxKind: 'stab', sfx: 'enemy_windup',
      }),
      move({
        id: 'flurry', shape: MOVE_SHAPE.SWEEP, range: 3.4, cooldown: 4.2, weight: 2,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.PARRYABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 0.34, sustain: 0.16, radius: 2.6, width: 0.9, label: 'PARRY',
        }),
        damage: 7, poise: 7, knockback: 1.4, recovery: 0.22, advance: 1.1,
        reach: 2.6, width: 0.9, active: 0.07, chain: 'flurry2', fxKind: 'stab',
      }),
      move({
        id: 'flurry2', shape: MOVE_SHAPE.SWEEP, range: 3.6, cooldown: 0, weight: 0,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.PARRYABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 0.28, sustain: 0.18, radius: 2.8, width: 0.9, label: 'PARRY',
        }),
        damage: 9, poise: 9, knockback: 2.6, recovery: 0.72, advance: 1.3,
        reach: 2.8, width: 0.9, active: 0.08, fxKind: 'stab',
      }),
      move({
        // Only legal from behind. The knifer is the reason you keep your back to a wall.
        id: 'backstab', shape: MOVE_SHAPE.SWEEP, range: 3.2, cooldown: 6.0, weight: 4,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.DODGEABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 0.40, sustain: 0.22, radius: 2.2, width: 0.8, label: 'BEHIND YOU',
        }),
        damage: 17, poise: 26, knockback: 4.0, recovery: 0.78, advance: 1.4,
        reach: 2.2, width: 0.8, active: 0.09, fxKind: 'stab', sfx: 'enemy_windup',
      }),
    ],
  },

  // ------------------------------------------------------------------- brute
  // One idea, executed enormously: it will break your guard, and it will not be interrupted. The
  // only answer is spacing. Its recovery is the longest in the game and that is the whole deal.
  brute: {
    id: 'brute',
    name: 'Iron-Fist Brute',
    charSpec: 'pirate_brute',
    questKind: 'thug_brute',
    tier: 2,
    stats: { maxHp: 165, maxPoise: 96, defence: 3, mass: 190, radius: 0.72, height: 2.6 },
    speed: 2.6,
    turnRate: 3.4,
    xp: 48, berries: 180,
    ai: {
      aggro: 20, deaggro: 40,
      reaction: 0.55,
      preferredMin: 2.4, preferredMax: 5.5,
      strafeSpeed: 0.9, strafeHold: [0.9, 1.6],
      repositionChance: 0.15, repositionTime: [0.6, 1.0],
      fleeHp: 0,
      blockAware: 0,              // it does not care whether you are blocking. That is the point.
      punishRecovery: 0.35,
      tokens: 2,                  // eats most of a group's budget: a brute fight is ITS fight
    },
    moves: [
      move({
        id: 'overhead', shape: MOVE_SHAPE.SPHERE, range: 3.8, cooldown: 4.5, weight: 3,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.GROUND,
          windup: 0.92, sustain: 0.34, radius: 3.2, tell: 1.3, label: 'UNBLOCKABLE',
        }),
        // Anchored to the GROUND, so the circle stops moving the moment it appears: the player is
        // told exactly which paving stones to not be standing on, a full second in advance.
        damage: 30, poise: 70, knockback: 8.0, launch: 4.5, recovery: 1.35, advance: 0.6,
        reach: 3.2, blockable: 0, hitstop: 0.09, active: 0.16,
        tags: [TAG.MELEE, TAG.UNBLOCKABLE, TAG.AOE], fxKind: 'slam',
        sfx: 'enemy_windup_unblockable',
      }),
      move({
        id: 'charge', shape: MOVE_SHAPE.LINE, range: 14, minRange: 4.5, cooldown: 7.0, weight: 3,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.85, sustain: 0.30, radius: 13, width: 2.4, tell: 1.3, label: 'UNBLOCKABLE',
        }),
        damage: 24, poise: 60, knockback: 11.0, launch: 3.0, recovery: 1.5,
        reach: 13, width: 2.4, blockable: 0, hitstop: 0.10, active: 0.5, effect: 'charge',
        tags: [TAG.MELEE, TAG.UNBLOCKABLE], fxKind: 'slam', sfx: 'enemy_windup_unblockable',
      }),
      move({
        id: 'guardbreak', shape: MOVE_SHAPE.ARC, range: 3.2, cooldown: 6.5, weight: 2,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.DODGEABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 0.58, sustain: 0.20, radius: 2.9, halfAngle: 0.9, label: 'GUARD BREAK',
        }),
        damage: 12, poise: 50, knockback: 5.0, recovery: 0.9, guardCost: 60,
        reach: 2.9, halfAngle: 0.9, tags: [TAG.MELEE, TAG.GUARD_BREAK], fxKind: 'blunt',
        sfx: 'enemy_windup',
      }),
    ],
  },

  // ------------------------------------------------------- marine_rifle
  // The only enemy whose weakness is a timer rather than a hitbox. It kites, it uses cover, and
  // every few shots it reloads — and the reload is a two-second, unmistakable invitation.
  marine_rifle: {
    id: 'marine_rifle',
    name: 'Marine Rifleman',
    charSpec: 'marine_recruit',
    questKind: 'marine_grunt',
    tier: 1,
    stats: { maxHp: 52, maxPoise: 24, defence: 1, mass: 74, radius: 0.40, height: 1.82 },
    speed: 3.4,
    turnRate: 8.0,
    xp: 20, berries: 70,
    ai: {
      aggro: 30, deaggro: 46,
      reaction: 0.34,
      preferredMin: 9, preferredMax: 18,   // it wants to be FAR. Closing distance is the game.
      strafeSpeed: 2.6, strafeHold: [0.6, 1.2],
      repositionChance: 0.7, repositionTime: [0.8, 1.4],
      fleeHp: 0,
      blockAware: 0.1,
      punishRecovery: 0.3,
      tokens: 1,
      /** Backs away when you get inside this. */
      panicRange: 5.0,
      /** Shots before a reload. */
      magazine: 3,
      reloadTime: 2.1,
      /** Prefers positions with geometry between it and you at the end of a reposition. */
      seeksCover: 1,
    },
    moves: [
      move({
        id: 'shot', shape: MOVE_SHAPE.PROJECTILE, range: 26, minRange: 3.5, cooldown: 1.35, weight: 4,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.DODGEABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.55, sustain: 0.14, radius: 26, width: 0.55, label: 'INCOMING',
        }),
        damage: 13, poise: 12, knockback: 2.0, recovery: 0.28,
        speed: 58, gravity: 0.04, projRadius: 0.16, active: 0.05,
        tags: [TAG.RANGED], fxKind: 'bullet', sfx: 'enemy_windup',
      }),
      move({
        id: 'buttstroke', shape: MOVE_SHAPE.ARC, range: 2.8, cooldown: 3.0, weight: 3,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.PARRYABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.36, sustain: 0.14, radius: 2.2, halfAngle: 0.8, label: 'PARRY',
        }),
        damage: 9, poise: 24, knockback: 6.5, recovery: 0.62, advance: 0.7,
        reach: 2.2, halfAngle: 0.8, fxKind: 'blunt', sfx: 'enemy_windup',
      }),
    ],
  },

  // ----------------------------------------------------------------- fishman
  // Fights in three dimensions: it leaps over your guard instead of walking around it. Rain and
  // shallow water are its buff, which turns weather and terrain into combat information.
  fishman: {
    id: 'fishman',
    name: 'Fishman Raider',
    charSpec: 'fishman_raider',
    questKind: 'jungle_stalker',
    tier: 2,
    stats: { maxHp: 96, maxPoise: 52, defence: 2, mass: 118, radius: 0.52, height: 2.15 },
    speed: 3.8,
    turnRate: 6.5,
    xp: 34, berries: 130,
    resist: { frost: 0.35, flame: -0.2 },
    ai: {
      aggro: 22, deaggro: 38,
      reaction: 0.38,
      preferredMin: 3.0, preferredMax: 8.0,
      strafeSpeed: 2.0, strafeHold: [0.6, 1.1],
      repositionChance: 0.35, repositionTime: [0.5, 0.9],
      fleeHp: 0,
      blockAware: 0.3,
      punishRecovery: 0.6,
      tokens: 1,
      /** Damage and speed multiplier while wet or in rain. */
      wetBonus: 1.35,
    },
    moves: [
      move({
        id: 'leap', shape: MOVE_SHAPE.SPHERE, range: 11, minRange: 3.5, cooldown: 5.5, weight: 3,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.DODGEABLE, growth: GROWTH.FILL, anchor: ANCHOR.TARGET,
          windup: 0.70, sustain: 0.26, radius: 2.8, label: 'INCOMING',
        }),
        // Anchored to the TARGET: the circle follows you for the first half of the wind-up, then
        // locks. You learn to keep moving until it commits, then step out. That is the fight.
        damage: 18, poise: 40, knockback: 5.5, launch: 2.0, recovery: 0.85,
        reach: 2.8, active: 0.14, effect: 'leap', fxKind: 'slam', sfx: 'enemy_windup',
      }),
      move({
        id: 'waterjet', shape: MOVE_SHAPE.PROJECTILE, range: 18, minRange: 4, cooldown: 4.0, weight: 2,
        telegraph: defineTelegraph({
          kind: T.CONE, danger: DANGER.BLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.66, sustain: 0.20, radius: 16, halfAngle: 0.16, label: 'BLOCK',
        }),
        damage: 14, poise: 20, knockback: 5.0, recovery: 0.55,
        speed: 34, gravity: 0.18, projRadius: 0.34, active: 0.06,
        tags: [TAG.RANGED], fxKind: 'water', sfx: 'enemy_windup',
      }),
      move({
        id: 'karate', shape: MOVE_SHAPE.SWEEP, range: 3.9, cooldown: 2.4, weight: 3,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.PARRYABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.40, sustain: 0.16, radius: 3.0, halfAngle: 0.95, label: 'PARRY',
        }),
        damage: 13, poise: 26, knockback: 5.5, recovery: 0.48, advance: 1.0,
        reach: 3.0, halfAngle: 0.95, fxKind: 'blunt',
      }),
    ],
  },

  // ------------------------------------------------------------------ bomber
  // It has no attack. It has a fuse. The telegraph is the enemy: a pulsing circle that grows as it
  // closes, so the decision "kill it or leave" is made on distance, not on reflex.
  bomber: {
    id: 'bomber',
    name: 'Powder Runner',
    charSpec: 'bandit_boss',
    questKind: 'dune_bandit',
    tier: 1,
    stats: { maxHp: 30, maxPoise: 12, defence: 0, mass: 66, radius: 0.40, height: 1.78 },
    speed: 5.2,
    turnRate: 9.0,
    xp: 22, berries: 60,
    ai: {
      aggro: 26, deaggro: 60,      // it will follow you across the island
      reaction: 0.18,
      preferredMin: 0, preferredMax: 1.6,
      strafeSpeed: 0, strafeHold: [0.2, 0.3],
      repositionChance: 0, repositionTime: [0.2, 0.3],
      fleeHp: 0,
      blockAware: 0,
      punishRecovery: 1,
      tokens: 0,                   // never waits for a token: the fuse is already the limiter
      /** Seconds of fuse once lit. Long enough to sprint out of, short enough to be scary. */
      fuse: 1.6,
    },
    moves: [
      move({
        id: 'detonate', shape: MOVE_SHAPE.SPHERE, range: 3.2, cooldown: 99, weight: 1,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 1.6, sustain: 0.4, radius: 4.6, tell: 1.4, label: 'UNBLOCKABLE',
        }),
        damage: 34, poise: 80, knockback: 12.0, launch: 6.0, recovery: 0.1,
        reach: 4.6, blockable: 0, hitstop: 0.12, active: 0.2, effect: 'detonate',
        tags: [TAG.UNBLOCKABLE, TAG.AOE], element: ELEMENT.FLAME, fxKind: 'explode',
        sfx: 'enemy_windup_unblockable',
      }),
    ],
  },

  // ----------------------------------------------------------------- captain
  // A mini-boss with a real move set and a real phase change. At 50% it stops being a thug with
  // more health: it gains a spin, summons two thugs, and shortens every wind-up.
  captain: {
    id: 'captain',
    name: 'Marine Captain',
    charSpec: 'marine_captain',
    questKind: 'marine_officer',
    tier: 3,
    elite: true,
    stats: { maxHp: 420, maxPoise: 130, defence: 4, mass: 130, radius: 0.52, height: 2.2 },
    speed: 4.0,
    turnRate: 8.0,
    xp: 220, berries: 900,
    phases: [{ at: 1.0 }, { at: 0.5, summon: 'thug', summonCount: 2, speedMult: 1.15, windupMult: 0.85 }],
    ai: {
      aggro: 26, deaggro: 999,
      reaction: 0.28,
      preferredMin: 2.4, preferredMax: 6.0,
      strafeSpeed: 2.8, strafeHold: [0.5, 1.0],
      repositionChance: 0.4, repositionTime: [0.5, 0.9],
      fleeHp: 0,
      blockAware: 0.6,
      punishRecovery: 0.85,
      tokens: 2,
      isBoss: true,
    },
    moves: [
      move({
        id: 'slash', shape: MOVE_SHAPE.SWEEP, range: 4.4, cooldown: 2.0, weight: 3,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.PARRYABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.42, sustain: 0.16, radius: 3.4, halfAngle: 1.05, label: 'PARRY',
        }),
        damage: 16, poise: 26, knockback: 4.5, recovery: 0.42, advance: 1.3,
        reach: 3.4, halfAngle: 1.05, active: 0.12, fxKind: 'slash', sfx: 'enemy_windup',
      }),
      move({
        id: 'lunge', shape: MOVE_SHAPE.SWEEP, range: 7.5, minRange: 3.0, cooldown: 4.5, weight: 3,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.DODGEABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.58, sustain: 0.20, radius: 7.5, width: 1.3, label: 'INCOMING',
        }),
        damage: 20, poise: 40, knockback: 7.0, recovery: 0.78, advance: 6.0,
        reach: 7.5, width: 1.3, active: 0.16, fxKind: 'stab', sfx: 'enemy_windup',
      }),
      move({
        id: 'crush', shape: MOVE_SHAPE.SPHERE, range: 4.0, cooldown: 7.5, weight: 2,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.GROUND,
          windup: 0.86, sustain: 0.30, radius: 3.6, tell: 1.2, label: 'UNBLOCKABLE',
        }),
        damage: 28, poise: 70, knockback: 8.0, launch: 4.0, recovery: 1.1,
        reach: 3.6, blockable: 0, hitstop: 0.09, active: 0.16,
        tags: [TAG.MELEE, TAG.UNBLOCKABLE, TAG.AOE], fxKind: 'slam',
        sfx: 'enemy_windup_unblockable',
      }),
      move({
        // Phase 2 only. A full circle you cannot walk out of from close range — you dodge THROUGH
        // it or you eat it, and the tell is a spinning cyan ring rather than a red one because it
        // is parryable on the first tick.
        id: 'spin', shape: MOVE_SHAPE.ARC, range: 4.6, cooldown: 6.0, weight: 3, phase: 1,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.PARRYABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 0.52, sustain: 0.26, radius: 4.2, tell: 1.2, label: 'PARRY',
        }),
        damage: 18, poise: 46, knockback: 8.5, launch: 1.5, recovery: 0.95,
        reach: 4.2, halfAngle: Math.PI, active: 0.22, fxKind: 'slash', sfx: 'enemy_windup',
      }),
    ],
  },

  // ----------------------------------------------------------------- admiral
  // The finale. Three phases, arena-wide telegraphs so positioning stops being an answer, and one
  // move that can ONLY be parried — a cyan cross that fills the whole arena. By the time a player
  // reaches him, the parry has been taught by every knifer and marine in the game.
  admiral: {
    id: 'admiral',
    name: 'Admiral',
    charSpec: 'marine_officer',
    questKind: 'marine_elite',
    tier: 4,
    elite: true,
    named: true,
    stats: { maxHp: 1150, maxPoise: 240, defence: 8, mass: 150, radius: 0.56, height: 2.35 },
    speed: 4.2,
    turnRate: 7.0,
    xp: 1400, berries: 6000,
    phases: [
      { at: 1.0 },
      { at: 0.66, speedMult: 1.1, windupMult: 0.92 },
      { at: 0.33, speedMult: 1.2, windupMult: 0.82, summon: null },
    ],
    ai: {
      aggro: 40, deaggro: 999,
      reaction: 0.26,
      preferredMin: 3.0, preferredMax: 9.0,
      strafeSpeed: 3.0, strafeHold: [0.4, 0.9],
      repositionChance: 0.45, repositionTime: [0.4, 0.8],
      fleeHp: 0,
      blockAware: 0.4,
      punishRecovery: 1,
      tokens: 3,
      isBoss: true,
      arenaRadius: 22,
    },
    moves: [
      move({
        id: 'cleave', shape: MOVE_SHAPE.SWEEP, range: 5.4, cooldown: 2.2, weight: 3,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.PARRYABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 0.44, sustain: 0.18, radius: 4.2, halfAngle: 1.1, label: 'PARRY',
        }),
        damage: 22, poise: 34, knockback: 6.0, recovery: 0.44, advance: 1.6,
        reach: 4.2, halfAngle: 1.1, active: 0.13, fxKind: 'slash', sfx: 'enemy_windup',
      }),
      move({
        id: 'quake_slam', shape: MOVE_SHAPE.SPHERE, range: 6.6, cooldown: 6.0, weight: 3,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.GROUND,
          windup: 0.90, sustain: 0.34, radius: 6.0, tell: 1.4, label: 'UNBLOCKABLE',
        }),
        damage: 30, poise: 80, knockback: 9.0, launch: 5.0, recovery: 1.05,
        reach: 6.0, blockable: 0, hitstop: 0.10, active: 0.18, element: ELEMENT.QUAKE,
        tags: [TAG.MELEE, TAG.UNBLOCKABLE, TAG.AOE], fxKind: 'quake',
        sfx: 'enemy_windup_unblockable',
      }),
      move({
        id: 'ice_lance', shape: MOVE_SHAPE.PROJECTILE, range: 24, minRange: 4, cooldown: 4.0,
        weight: 2, phase: 1,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.BLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 0.62, sustain: 0.18, radius: 24, width: 0.9, label: 'BLOCK',
        }),
        damage: 20, poise: 26, knockback: 4.0, recovery: 0.5,
        speed: 46, gravity: 0.02, projRadius: 0.28, element: ELEMENT.FROST,
        tags: [TAG.RANGED], fxKind: 'frost', sfx: 'enemy_windup',
      }),
      move({
        // THE PARRY-ONLY MOVE. Arena-wide, so there is nowhere to dodge to; it breaks any held
        // guard, so turtling fails; it is cyan and parryable, so the one answer is the one the
        // colour has been promising since the first knifer.
        id: 'sanction', shape: MOVE_SHAPE.SPHERE, range: 999, cooldown: 14.0, weight: 4, phase: 1,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.PARRYABLE, growth: GROWTH.PULSE, anchor: ANCHOR.SELF,
          windup: 1.25, sustain: 0.45, radius: 22, tell: 1.5, label: 'PARRY OR DIE',
        }),
        damage: 55, poise: 200, knockback: 10.0, launch: 3.0, recovery: 1.9,
        reach: 22, guardCost: 999, hitstop: 0.14, active: 0.22,
        tags: [TAG.MELEE, TAG.GUARD_BREAK, TAG.PARRYABLE, TAG.AOE, TAG.FINISHER],
        fxKind: 'sanction',
        sfx: 'enemy_windup_unblockable',
      }),
      move({
        // Phase 3: the arena itself. A wide ring you must be either inside or well outside of.
        id: 'ring', shape: MOVE_SHAPE.SPHERE, range: 999, cooldown: 11.0, weight: 3, phase: 2,
        telegraph: defineTelegraph({
          kind: T.CIRCLE, danger: DANGER.UNBLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 1.05, sustain: 0.40, radius: 16, tell: 1.5, label: 'UNBLOCKABLE',
        }),
        damage: 38, poise: 120, knockback: 13.0, launch: 6.5, recovery: 1.6,
        reach: 16, blockable: 0, hitstop: 0.12, active: 0.2, element: ELEMENT.QUAKE,
        tags: [TAG.UNBLOCKABLE, TAG.AOE], fxKind: 'quake',
        sfx: 'enemy_windup_unblockable',
      }),
    ],
  },

  // ---------------------------------------------------------------- sparring
  // The safe trainer at the start island's dock. Telegraphs slowly, cannot kill (nonLethal:
  // damage floors at 30% of the target's maxHp — damage.js SPAR_FLOOR), cannot die
  // (unkillable: hp pins at 1 and it concedes the round). questKind 'sparring' is not in
  // quests.js ENEMY_KINDS, so no objective ever counts it; xp/berries flow only on death,
  // which never comes. ai.solo keeps it out of group alerts in both directions, ai.leash
  // keeps it at its post, and blockAware 0 means it will swing into a raised guard — which
  // is the whole block lesson.
  sparring: {
    id: 'sparring',
    name: 'Sparring Mate',
    charSpec: 'sparring_mate',
    questKind: 'sparring',
    tier: 1,
    nonLethal: true,
    unkillable: true,
    stats: { maxHp: 60, maxPoise: 60, defence: 0, mass: 115, radius: 0.5, height: 2.0 },
    speed: 2.4,
    turnRate: 5.0,
    xp: 0, berries: 0,
    ai: {
      aggro: 6, deaggro: 14,
      reaction: 0.9,
      preferredMin: 1.8, preferredMax: 3.2,
      strafeSpeed: 1.0, strafeHold: [1.0, 1.8],
      repositionChance: 0.1, repositionTime: [0.6, 1.0],
      fleeHp: 0,
      blockAware: 0,
      punishRecovery: 0,
      tokens: 1,
      solo: 1,
      leash: 16,
      patrolRadius: 1.2,
    },
    moves: [
      move({
        id: 'jab', shape: MOVE_SHAPE.ARC, range: 2.9, cooldown: 4.0, weight: 3, tokens: 0,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.BLOCKABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 1.30, sustain: 0.22, radius: 2.4, halfAngle: 0.7, label: 'BLOCK',
        }),
        damage: 4, poise: 6, knockback: 1.5, recovery: 1.1, guardCost: 6,
        reach: 2.4, halfAngle: 0.7, active: 0.12, fxKind: 'blunt', sfx: 'enemy_windup',
      }),
      move({
        id: 'straight', shape: MOVE_SHAPE.LINE, range: 3.1, cooldown: 5.5, weight: 2, tokens: 0,
        telegraph: defineTelegraph({
          kind: T.LINE, danger: DANGER.PARRYABLE, growth: GROWTH.FILL, anchor: ANCHOR.SELF,
          windup: 1.20, sustain: 0.20, radius: 2.6, width: 0.8, label: 'PARRY',
        }),
        damage: 5, poise: 8, knockback: 2.0, recovery: 1.0, advance: 0.6,
        reach: 2.6, width: 0.8, active: 0.10, fxKind: 'blunt', sfx: 'enemy_windup',
      }),
      move({
        id: 'sweep', shape: MOVE_SHAPE.SWEEP, range: 3.4, cooldown: 7.0, weight: 2, tokens: 0,
        telegraph: defineTelegraph({
          kind: T.ARC, danger: DANGER.DODGEABLE, growth: GROWTH.SWEEP, anchor: ANCHOR.SELF,
          windup: 1.40, sustain: 0.24, radius: 3.0, halfAngle: 1.1, label: 'INCOMING',
        }),
        damage: 6, poise: 10, knockback: 3.0, recovery: 1.2, advance: 0.6,
        reach: 3.0, halfAngle: 1.1, active: 0.16, fxKind: 'blunt', sfx: 'enemy_windup',
      }),
    ],
  },
});

/** Every archetype id, in a fixed order. */
export const ENEMY_KIND_IDS = Object.freeze(Object.keys(ENEMY_ARCHETYPES));

/**
 * Look up an archetype. An unknown kind warns loudly and falls back to 'thug' rather than
 * throwing: spawners speak the quest vocabulary (see KIND_ALIASES in combat/combat.js), and a
 * missed alias mid-step must degrade to a visible, fightable enemy — not crash the simulation.
 */
export function archetype(kind) {
  const a = ENEMY_ARCHETYPES[kind];
  if (!a) {
    console.warn(`[enemy] unknown enemy archetype: ${kind} — using 'thug'`);
    return ENEMY_ARCHETYPES.thug;
  }
  return a;
}

/** Find a move by id inside an archetype. */
export function findMove(arch, id) {
  for (let i = 0; i < arch.moves.length; i++) if (arch.moves[i].id === id) return arch.moves[i];
  return null;
}

// ---------------------------------------------------------------------------
// Aggression budget
// ---------------------------------------------------------------------------

/**
 * The token bank. Only `capacity` tokens exist; an enemy must hold one (or two, or three) to
 * commit to an attack. Everyone else circles.
 *
 * Two rules that matter more than the number:
 *   - a token is held from the START of the wind-up to the END of the recovery, so a punished
 *     enemy's slot is not freed early and the crowd does not immediately refill the gap;
 *   - the bank ages requests, so the same enemy cannot monopolise the slot in a long fight.
 */
export class AggressionBank {
  /** @param {number} [capacity] simultaneous attackers */
  constructor(capacity = 2) {
    this.capacity = capacity;
    /** @type {object[]} current holders. THE authoritative record — see `used`. */
    this.holders = [];
    /** Seconds since each enemy last held a token, keyed by id. Reused map. */
    this.lastHeld = new Map();
  }

  /**
   * Tokens in use, DERIVED from the holder list rather than tracked as a counter.
   *
   * This was a real bug, and an instructive one: a separate `used` counter leaked whenever an
   * enemy's token bookkeeping was touched between take and release (a chained combo re-entering
   * beginMove was enough). The counter drifted upward, the budget silently reached zero, and the
   * symptom was "enemies stopped attacking after about thirty seconds" — nothing that looks like
   * an accounting bug. A derived value cannot drift.
   */
  get used() {
    let n = 0;
    for (let i = 0; i < this.holders.length; i++) n += this.holders[i]._tokens || 0;
    return n;
  }

  setCapacity(n) { this.capacity = Math.max(1, n | 0); }

  /** Can `cost` tokens be taken right now? */
  canTake(cost) { return this.used + cost <= this.capacity; }

  /**
   * Take tokens for an enemy. Returns false if the budget is full.
   * @param {object} enemy
   * @param {number} cost
   */
  take(enemy, cost) {
    if (cost <= 0) return true;                 // bombers and scripted moves bypass the budget
    if (this.holders.indexOf(enemy) >= 0) return true;   // already holding: a chain, not a new claim
    if (this.used + cost > this.capacity) return false;
    this.holders.push(enemy);
    enemy._tokens = cost;
    return true;
  }

  /** Give tokens back. Safe to call on an enemy that holds none, and safe to call twice. */
  release(enemy) {
    if (!enemy) return;
    const i = this.holders.indexOf(enemy);
    if (i >= 0) this.holders.splice(i, 1);
    enemy._tokens = 0;
    this.lastHeld.set(enemy.id, 0);
  }

  /** Age the fairness records. */
  step(dt) {
    for (const k of this.lastHeld.keys()) this.lastHeld.set(k, this.lastHeld.get(k) + dt);
  }

  /**
   * Priority for a waiting enemy: longer-waiting and closer enemies go first. Deterministic —
   * ties break on id, never on iteration order.
   */
  priority(enemy, distToTarget) {
    const wait = this.lastHeld.has(enemy.id) ? this.lastHeld.get(enemy.id) : 99;
    return wait * 2 - distToTarget * 0.35 + (enemy.id % 7) * 0.001;
  }

  reset() {
    for (let i = 0; i < this.holders.length; i++) this.holders[i]._tokens = 0;
    this.holders.length = 0;
    this.lastHeld.clear();
  }
}

// ---------------------------------------------------------------------------
// Enemy
// ---------------------------------------------------------------------------

/**
 * Fallback id counter for enemies constructed outside a CombatSystem (tools, tests).
 *
 * DETERMINISM NOTE: an enemy's RNG stream is derived from its id, so a module-global counter
 * would make the SECOND fight in a process behave differently from the first — which is exactly
 * how a determinism test fails while every individual run looks fine. CombatSystem therefore
 * owns its own monotone id space and always passes `id` explicitly; this counter only exists so
 * a bare `new Enemy(...)` still works.
 */
let _enemySeq = 0;

/**
 * A live enemy. It IS the physics body (the spatial hash indexes it directly) and it IS the
 * combatant (damage.js writes hp/poise onto it), because the alternative — three objects that
 * must be kept in sync — is where crowd bugs come from.
 */
export class Enemy {
  /**
   * @param {string} kind archetype id
   * @param {number} x
   * @param {number} y feet
   * @param {number} z
   * @param {number} [tier] 1..4 scaling; also feeds the HUD skull count
   * @param {number} [seed] world seed, for this enemy's deterministic stream
   * @param {number} [id] explicit actor id; CombatSystem always supplies one so that two fights
   *   in the same process are byte-identical. See the note on _enemySeq.
   */
  constructor(kind, x, y, z, tier = 1, seed = 1, id = 0) {
    const arch = archetype(kind);
    this.id = id > 0 ? id : ++_enemySeq;
    this.kind = kind;
    this.arch = arch;
    this.name = arch.name;
    this.questKind = arch.questKind;
    this.elite = !!arch.elite;
    this.named = !!arch.named;
    this.bossId = null;             // set by combat.startEncounter for a real boss fight
    this.tier = tier;

    // --- body ---
    const b = makeBody({
      x, y, z,
      radius: arch.stats.radius, height: arch.stats.height, mass: arch.stats.mass,
    });
    Object.assign(this, b);

    // --- combat stats, scaled by tier ---
    // Tier is a difficulty dial, not a new enemy: +35% hp and +12% damage per step keeps the
    // archetype's rhythm intact while making a late-game thug worth respecting.
    const hpScale = Math.pow(1.35, tier - 1);
    const dmgScale = Math.pow(1.12, tier - 1);
    initCombatant(this, {
      maxHp: Math.round(arch.stats.maxHp * hpScale),
      maxPoise: Math.round(arch.stats.maxPoise * Math.pow(1.18, tier - 1)),
      defence: arch.stats.defence,
      damageMult: dmgScale,
      team: 2,
      resist: arch.resist,
    });

    this.rng = Rng.fromName((seed >>> 0) ^ (this.id * 2654435761), 'enemy:' + kind);
    this.speed = arch.speed;
    this.turnRate = arch.turnRate;

    // --- AI state ---
    this.state = STATE.IDLE;
    this.stateT = 0;
    /** @type {object|null} */
    this.target = null;
    this.alertT = 0;
    this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
    this.strafeT = 0;
    this.repositionX = x; this.repositionZ = z;
    this.homeX = x; this.homeZ = z;
    this.patrolAngle = this.rng.f() * TAU;
    this.patrolT = 0;

    /** @type {object|null} the move being executed */
    this.move = null;
    /** @type {object|null} the live telegraph */
    this.telegraph = null;
    this.recoverT = 0;
    /** Per-move cooldown timers, indexed the same as arch.moves. */
    this.cooldowns = new Float64Array(arch.moves.length);
    this._tokens = 0;
    this.phase = 0;
    this.phaseChanged = false;
    /** Set on the step a phase transition fires, so combat can run the summon and the FX. */
    this.pendingPhase = -1;

    // --- archetype-specific runtime ---
    this.ammo = arch.ai.magazine || 0;
    this.reloadT = 0;
    this.fuseLit = false;
    this.chargeT = 0;
    this.chargeX = 0; this.chargeZ = 0;
    this.wet = 0;

    /** Advance applied by the current strike, metres/sec, decayed over the active window. */
    this.lungeX = 0; this.lungeZ = 0; this.lungeT = 0;

    // Every runtime field is declared HERE, even the ones only combat writes. A field added to
    // an object after construction forces V8 to rebuild the hidden class, and in a crowd fight
    // that happens on the exact frame the crowd appears — a hitch precisely where you least
    // want one. Declaring them costs nothing and keeps every enemy one shape.
    this.moveIndex = -1;
    this._pendingChain = -1;
    this._pendingChainT = 0;
    this._urge = 0;
    this._burnAcc = 0;
    this.deathT = 0;
    this.dissolve = 0;
    this.aura = 0;
    this.auraColor = 0;
    this.hitFlashColor = 0;
    this.armoured = false;
    /** @type {object|null} set by Cluster B when a visual rig is attached. */
    this.rig = null;

    /** Reported to the HUD. Never a placeholder — if it is on screen, it is true. */
    this.aggroRadius = arch.ai.aggro;

    // Sparring-partner fields, declared for every enemy (hidden-class rule above). All
    // falsy/zero for ordinary archetypes, so nothing downstream changes for them.
    this.nonLethal = !!arch.nonLethal;
    this.unkillable = !!arch.unkillable;
    this.passive = false;      // set by the game when its lessons are learned: stops aggroing
    this.sparRestT = 0;        // resting after conceding a round; barred from aggro
    this.sparHealT = 0;        // seconds idle below max hp before snapping back to full
  }

  /** Fraction of health remaining. */
  get hpFrac() { return this.maxHp > 0 ? this.hp / this.maxHp : 0; }

  /** Multiplier applied to every wind-up, from the phase table. */
  get windupMult() {
    const ph = this.arch.phases;
    if (!ph) return 1;
    const p = ph[Math.min(this.phase, ph.length - 1)];
    return p && p.windupMult !== undefined ? p.windupMult : 1;
  }

  /** Multiplier applied to movement speed, from the phase table and status. */
  get speedMult() {
    const ph = this.arch.phases;
    let m = 1;
    if (ph) {
      const p = ph[Math.min(this.phase, ph.length - 1)];
      if (p && p.speedMult !== undefined) m = p.speedMult;
    }
    if (this.arch.ai.wetBonus && this.wet > 0.5) m *= 1.12;
    return m * movementScale(this);
  }

  /** Damage multiplier from phase and environment. */
  get powerMult() {
    let m = this.damageMult;
    if (this.arch.ai.wetBonus && this.wet > 0.5) m *= this.arch.ai.wetBonus;
    return m;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
  }

  /** Distance to a point, horizontally. */
  distTo(x, z) { return Math.hypot(this.x - x, this.z - z); }

  /** Turn toward a yaw at the archetype's turn rate. */
  faceToward(x, z, dt, rateMult = 1) {
    const want = Math.atan2(x - this.x, z - this.z);
    this.yaw += angleDelta(this.yaw, want) * clamp01(this.turnRate * rateMult * dt);
  }

  /**
   * Which moves are legal right now? Fills `out` with indices into arch.moves.
   * A move is legal when: off cooldown, inside its range band, at or above its phase gate, and
   * not vetoed by the archetype's read of the player's stance.
   */
  legalMoves(dist, out) {
    out.length = 0;
    const arch = this.arch;
    const t = this.target;
    const blockAware = arch.ai.blockAware || 0;
    for (let i = 0; i < arch.moves.length; i++) {
      const m = arch.moves[i];
      if (m.weight <= 0) continue;              // chain-only moves are never chosen directly
      if (this.cooldowns[i] > 0) continue;
      if (m.phase > this.phase) continue;
      if (dist > m.range || dist < m.minRange) continue;
      if (m.id === 'backstab') {
        // Only from behind — the whole point of the move.
        if (!t) continue;
        const fx = Math.sin(t.yaw || 0), fz = Math.cos(t.yaw || 0);
        let dx = t.x - this.x, dz = t.z - this.z;
        const d = Math.hypot(dx, dz) || 1;
        dx /= d; dz /= d;
        if (dx * fx + dz * fz < 0.45) continue;
      }
      if (m.shape === MOVE_SHAPE.PROJECTILE && this.ammo === 0 && arch.ai.magazine) continue;
      // Reading the guard: an enemy that "knows" you are blocking prefers a guard-breaker.
      if (t && t.blocking && blockAware > 0) {
        const breaks = m.blockable <= 0 || m.tags.indexOf(TAG.GUARD_BREAK) >= 0;
        if (!breaks && this.rng.f() < blockAware) continue;
      }
      out.push(i);
    }
    return out;
  }

  /**
   * The distance this enemy can currently threaten from: the longest range among the moves that
   * are off cooldown and unlocked by its phase.
   *
   * The strafe band is derived from this rather than authored independently, because authoring
   * them separately is how you get an enemy that circles patiently at 3.9 m holding a 2.4 m
   * attack and never swings. That failure is invisible in a 1v1 poke test — the enemy looks like
   * it is "sizing you up" — and it silently removes the archetype from every group fight.
   * @returns {number} metres
   */
  attackReach() {
    let r = 0;
    for (let i = 0; i < this.arch.moves.length; i++) {
      const m = this.arch.moves[i];
      if (m.weight <= 0 || m.phase > this.phase) continue;
      if (this.cooldowns[i] > 0) continue;
      if (m.range > r) r = m.range;
    }
    if (r === 0) {
      // Everything is on cooldown: hold the spacing of the widest move it will eventually use,
      // so an enemy waiting out a cooldown does not drift out of the fight.
      for (let i = 0; i < this.arch.moves.length; i++) {
        const m = this.arch.moves[i];
        if (m.weight > 0 && m.phase <= this.phase && m.range > r) r = m.range;
      }
    }
    return r;
  }

  /** Weighted deterministic pick from `indices`. */
  pickMove(indices) {
    if (indices.length === 0) return -1;
    let total = 0;
    for (let i = 0; i < indices.length; i++) total += this.arch.moves[indices[i]].weight;
    if (total <= 0) return indices[0];
    let r = this.rng.f() * total;
    for (let i = 0; i < indices.length; i++) {
      r -= this.arch.moves[indices[i]].weight;
      if (r <= 0) return indices[i];
    }
    return indices[indices.length - 1];
  }

  /** Tick every cooldown. */
  stepCooldowns(dt) {
    for (let i = 0; i < this.cooldowns.length; i++) {
      if (this.cooldowns[i] > 0) this.cooldowns[i] -= dt;
    }
  }

  /** Check the phase table and flag a transition for combat to run. */
  checkPhase() {
    const ph = this.arch.phases;
    if (!ph) return;
    const f = this.hpFrac;
    for (let i = ph.length - 1; i > this.phase; i--) {
      if (f <= ph[i].at) {
        this.phase = i;
        this.pendingPhase = i;
        this.phaseChanged = true;
        return;
      }
    }
  }
}

/**
 * Movement for one enemy, one step. Returns the desired velocity in XZ; the caller sweeps it
 * through the world so terrain, step-up and crowd separation stay in physics where they belong.
 *
 * This function is where each archetype's RHYTHM lives — the thing you recognise before you can
 * see the health bar.
 *
 * @param {Enemy} e
 * @param {number} dt
 * @param {object} out { x, z } reused
 * @returns {{x:number, z:number}}
 */
export function desiredVelocity(e, dt, out) {
  out.x = 0; out.z = 0;
  const t = e.target;
  const ai = e.arch.ai;
  const spd = e.speed * e.speedMult;

  switch (e.state) {
    case STATE.IDLE:
      return out;

    case STATE.PATROL: {
      // A slow loop around the spawn point. Deliberately lazy: a patrolling enemy that moves like
      // a fighting one destroys the moment when it notices you.
      e.patrolT -= dt;
      if (e.patrolT <= 0) {
        e.patrolT = e.rng.range(2.5, 5.5);
        e.patrolAngle += e.rng.range(-1.4, 1.4);
      }
      const pr = ai.patrolRadius !== undefined ? ai.patrolRadius : 5.5;
      const tx = e.homeX + Math.sin(e.patrolAngle) * pr;
      const tz = e.homeZ + Math.cos(e.patrolAngle) * pr;
      const dx = tx - e.x, dz = tz - e.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.6) { out.x = (dx / d) * spd * 0.35; out.z = (dz / d) * spd * 0.35; }
      return out;
    }

    case STATE.ALERT: {
      // Squares up and shuffles, but does not close. The pause before the fight.
      if (!t) return out;
      const dx = e.x - t.x, dz = e.z - t.z;
      const d = Math.hypot(dx, dz) || 1;
      out.x = (-dz / d) * e.strafeDir * spd * 0.25;
      out.z = (dx / d) * e.strafeDir * spd * 0.25;
      return out;
    }

    case STATE.APPROACH: {
      if (!t) return out;
      let dx = t.x - e.x, dz = t.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d; dz /= d;
      // Riflemen close only until they are inside their preferred band, then stop.
      if (d <= ai.preferredMax && ai.preferredMin > 5) return out;
      out.x = dx * spd; out.z = dz * spd;
      // The knifer's flank bias: it does not walk at you, it walks past you.
      if (ai.flank) {
        const px = -dz, pz = dx;
        out.x += px * e.strafeDir * spd * 0.55;
        out.z += pz * e.strafeDir * spd * 0.55;
      }
      return out;
    }

    case STATE.STRAFE: {
      if (!t) return out;
      let dx = t.x - e.x, dz = t.z - e.z;
      const d = Math.hypot(dx, dz) || 1;
      dx /= d; dz /= d;
      // The band is the authored preference INTERSECTED with what the enemy can actually reach,
      // so circling always happens inside its own threat range.
      const reach = e.attackReach();
      const lo = Math.min(ai.preferredMin, reach * 0.55);
      const hi = Math.min(ai.preferredMax, reach * 0.88);
      // Push out if too close, drift in if too far.
      let radial = 0;
      if (d < lo) radial = -1;
      else if (d > hi) radial = 1;
      const px = -dz, pz = dx;
      const s = ai.strafeSpeed;
      out.x = px * e.strafeDir * s + dx * radial * spd * 0.6;
      out.z = pz * e.strafeDir * s + dz * radial * spd * 0.6;
      return out;
    }

    case STATE.ATTACK: {
      if (!t) return out;
      // Most archetypes plant during a wind-up — that is what makes the telegraph a commitment
      // rather than a suggestion. The brute's charge is the exception and is driven by lunge.
      const d = e.distTo(t.x, t.z);
      if (e.move && e.move.advance > 0 && d > 2.0) {
        let dx = t.x - e.x, dz = t.z - e.z;
        const dd = Math.hypot(dx, dz) || 1;
        out.x = (dx / dd) * spd * 0.30;
        out.z = (dz / dd) * spd * 0.30;
      }
      return out;
    }

    case STATE.RECOVER:
      // Rooted. This is the punish window and it must LOOK like one.
      return out;

    case STATE.REPOSITION: {
      const dx = e.repositionX - e.x, dz = e.repositionZ - e.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.5) { out.x = (dx / d) * spd; out.z = (dz / d) * spd; }
      return out;
    }

    case STATE.FLEE: {
      if (!t) return out;
      let dx = e.x - t.x, dz = e.z - t.z;
      const d = Math.hypot(dx, dz) || 1;
      out.x = (dx / d) * spd * 1.1;
      out.z = (dz / d) * spd * 1.1;
      return out;
    }

    default:
      return out;
  }
}

/**
 * Pick a reposition destination.
 *
 * A rifleman "takes cover" by preferring a spot where the world blocks line of sight to you; it
 * samples a fixed ring of candidate angles (never a random walk, so the choice is deterministic
 * and, more importantly, so the player can predict where it will pop up).
 *
 * @param {Enemy} e
 * @param {object} physics PhysicsSystem, for line-of-sight
 */
export function chooseReposition(e, physics) {
  const t = e.target;
  const ai = e.arch.ai;
  if (!t) { e.repositionX = e.homeX; e.repositionZ = e.homeZ; return; }
  const want = lerp(ai.preferredMin, ai.preferredMax, 0.6);
  const baseAngle = Math.atan2(e.x - t.x, e.z - t.z);
  const SAMPLES = 8;
  let bestX = e.x, bestZ = e.z, bestScore = -1e9;
  const start = e.rng.int(0, SAMPLES - 1);      // rotate the ring so 8 riflemen do not stack
  for (let k = 0; k < SAMPLES; k++) {
    const i = (start + k) % SAMPLES;
    const a = baseAngle + (i / SAMPLES) * TAU;
    const cx = t.x + Math.sin(a) * want;
    const cz = t.z + Math.cos(a) * want;
    let score = 0;
    // Prefer staying roughly where we are — teleport-feeling repositions read as bugs.
    score -= Math.hypot(cx - e.x, cz - e.z) * 0.12;
    if (ai.seeksCover && physics) {
      const eyeY = e.y + e.height * 0.8;
      const tgtY = t.y + (t.height || 1.8) * 0.7;
      const clear = physics.lineOfSight(cx, eyeY, cz, t.x, tgtY, t.z);
      // Cover means: broken sight line NOW, so it must lean out to shoot. That is the rhythm.
      score += clear ? 0.4 : 2.2;
    }
    if (score > bestScore) { bestScore = score; bestX = cx; bestZ = cz; }
  }
  e.repositionX = bestX;
  e.repositionZ = bestZ;
}

/** Re-export so combat does not need a second physics import for the same constants. */
export { GRAVITY, TERMINAL_V, canAct, clamp, clamp01 };
