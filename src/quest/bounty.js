// Bounty — the one number that changes the world.
//
// Everything else in the game asks this module a question and gets a hard answer: how many
// marines patrol, whether the shopkeeper doubles his prices, whether a child runs toward you
// or away, how tense the music is, what your poster looks like. That is what makes the number
// mean something. A bounty that only shows in the HUD is a score, not a reputation.
//
// Tiers are data, not code, so world/audio/ui can read them without importing behaviour.

import { P, mixHex, shadeDown, shadeUp, shift } from '../gen/palette.js';
import { clamp, clamp01, commify } from '../core/math.js';

/** Reaction vocabulary. Other systems switch on exactly these five strings. */
export const REACTIONS = Object.freeze(['friendly', 'wary', 'afraid', 'hostile', 'starstruck']);

/**
 * Poster art descriptor. Colours are composed from P.* so the whole game regrades from
 * palette.js. `stars` is the rank pip count, `wear` drives paper distress in the painter.
 */
function poster(tierIndex, stars, frame) {
  const t = tierIndex / 6;
  return Object.freeze({
    paper: mixHex(P.uiPaper, P.uiPaperDark, t * 0.55),
    paperEdge: mixHex(P.uiPaperDark, P.dirtDark, t * 0.4),
    ink: P.ink,
    accent: mixHex(P.uiPaperDark, P.uiGold, clamp01(t * 1.35)),
    stamp: tierIndex >= 4 ? shadeDown(P.uiRed, 0.35) : P.uiRed,
    ribbon: mixHex(P.flagRed, P.pirateMaroon, t),
    frame,                 // 'plain' | 'rope' | 'gilded'
    stars,                 // 0..5 rank pips beside the beli figure
    wear: clamp01(0.1 + t * 0.7),
    headline: tierIndex >= 5 ? 'DEAD OR ALIVE' : tierIndex >= 2 ? 'WANTED' : 'WANTED — ALIVE',
    glow: tierIndex >= 6 ? shadeUp(P.uiGold, 0.6) : 0,
  });
}

/**
 * The tier table. `min` is inclusive. Read via `tierFor(total)` rather than indexing —
 * inserting a tier later must not break callers.
 */
export const BOUNTY_TIERS = Object.freeze([
  Object.freeze({
    index: 0, id: 'unknown', name: 'Unknown',
    min: 0,
    spawnTierBonus: 0, marinePatrolChance: 0.04, npcReaction: 'friendly',
    shopPriceMult: 1.00, ambushChance: 0.00, musicTension: 0.00,
    posterArt: poster(0, 0, 'plain'),
    blurb: 'Nobody has written your name down yet.',
  }),
  Object.freeze({
    index: 1, id: 'rookie', name: 'Rookie',
    min: 3000000,
    spawnTierBonus: 1, marinePatrolChance: 0.12, npcReaction: 'friendly',
    shopPriceMult: 1.00, ambushChance: 0.04, musicTension: 0.15,
    posterArt: poster(1, 1, 'plain'),
    blurb: 'A first poster, badly drawn, already peeling off the noticeboard.',
  }),
  Object.freeze({
    index: 2, id: 'wanted', name: 'Wanted',
    min: 30000000,
    spawnTierBonus: 1, marinePatrolChance: 0.22, npcReaction: 'wary',
    shopPriceMult: 1.05, ambushChance: 0.10, musicTension: 0.32,
    posterArt: poster(2, 2, 'rope'),
    blurb: 'Shopkeepers count your change twice and watch the door.',
  }),
  Object.freeze({
    index: 3, id: 'rising', name: 'Rising Star',
    min: 100000000,
    spawnTierBonus: 2, marinePatrolChance: 0.34, npcReaction: 'wary',
    shopPriceMult: 1.10, ambushChance: 0.18, musicTension: 0.48,
    posterArt: poster(3, 3, 'rope'),
    blurb: 'Bounty hunters have started sailing toward you instead of away.',
  }),
  Object.freeze({
    index: 4, id: 'supernova', name: 'Supernova',
    min: 300000000,
    spawnTierBonus: 3, marinePatrolChance: 0.48, npcReaction: 'afraid',
    shopPriceMult: 1.18, ambushChance: 0.28, musicTension: 0.64,
    posterArt: poster(4, 4, 'gilded'),
    blurb: 'Whole towns close their shutters at the sound of your anchor.',
  }),
  Object.freeze({
    index: 5, id: 'warlord', name: 'Warlord Class',
    min: 800000000,
    spawnTierBonus: 4, marinePatrolChance: 0.62, npcReaction: 'afraid',
    shopPriceMult: 1.28, ambushChance: 0.40, musicTension: 0.82,
    posterArt: poster(5, 5, 'gilded'),
    blurb: 'The Navy sends officers, not patrols.',
  }),
  Object.freeze({
    index: 6, id: 'emperor', name: 'Emperor Class',
    min: 1500000000,
    spawnTierBonus: 5, marinePatrolChance: 0.80, npcReaction: 'afraid',
    shopPriceMult: 1.40, ambushChance: 0.55, musicTension: 1.00,
    posterArt: poster(6, 5, 'gilded'),
    blurb: 'Your flag alone empties a harbour.',
  }),
]);

/**
 * Per-npc-kind reaction ladder, one entry per tier. Explicit data beats a clever formula:
 * a child should get *more* excited as you get scarier, and a marine was never friendly.
 */
const REACTION_BY_KIND = Object.freeze({
  villager:   ['friendly', 'friendly', 'wary', 'wary', 'afraid', 'afraid', 'afraid'],
  child:      ['friendly', 'friendly', 'starstruck', 'starstruck', 'starstruck', 'starstruck', 'starstruck'],
  merchant:   ['friendly', 'friendly', 'friendly', 'wary', 'wary', 'afraid', 'afraid'],
  fisher:     ['friendly', 'friendly', 'friendly', 'wary', 'wary', 'afraid', 'afraid'],
  shipwright: ['friendly', 'friendly', 'friendly', 'friendly', 'wary', 'wary', 'afraid'],
  doctor:     ['friendly', 'friendly', 'friendly', 'wary', 'wary', 'wary', 'afraid'],
  barkeep:    ['friendly', 'friendly', 'friendly', 'friendly', 'wary', 'wary', 'wary'],
  scholar:    ['friendly', 'friendly', 'wary', 'wary', 'starstruck', 'starstruck', 'starstruck'],
  noble:      ['wary', 'wary', 'afraid', 'afraid', 'afraid', 'afraid', 'afraid'],
  marine:     ['wary', 'hostile', 'hostile', 'hostile', 'hostile', 'hostile', 'hostile'],
  marine_officer: ['wary', 'wary', 'hostile', 'hostile', 'hostile', 'hostile', 'hostile'],
  bandit:     ['hostile', 'hostile', 'hostile', 'wary', 'wary', 'afraid', 'afraid'],
  pirate:     ['wary', 'wary', 'friendly', 'friendly', 'starstruck', 'starstruck', 'starstruck'],
  bountyHunter: ['friendly', 'wary', 'hostile', 'hostile', 'hostile', 'hostile', 'hostile'],
  crew:       ['friendly', 'friendly', 'friendly', 'friendly', 'friendly', 'friendly', 'friendly'],
});

/** Standard bounty awards. Quests override with their own figure; these cover the world. */
export const BOUNTY_AWARDS = Object.freeze({
  namedEnemy: 900000,
  eliteEnemy: 2400000,
  boss: 18000000,
  marineProperty: 350000,
  marineOfficerDefeated: 4500000,
  fruitSeenInTown: 1100000,
  chestOfNavyGold: 600000,
});

/** Epithets earned by reputation. The poster nickname is the cheapest identity beat we own. */
const EPITHETS = Object.freeze([
  'the Shellbreaker', 'the Canopy Ghost', 'the Cog-Wrecker', 'the Snowline Devil',
  'the Ashwalker', 'the Glass Storm', 'the Petal Duelist', 'the Gate-Splitter',
]);

/** Find the tier containing `total`. @returns {object} a frozen BOUNTY_TIERS entry */
export function tierFor(total) {
  let t = BOUNTY_TIERS[0];
  for (let i = 0; i < BOUNTY_TIERS.length; i++) if (total >= BOUNTY_TIERS[i].min) t = BOUNTY_TIERS[i];
  return t;
}

/**
 * The bounty ledger.
 *
 * `heat` is short-term notoriety: it spikes when you are *seen* doing something (fruit powers
 * in a town square, smashing Navy property) and bleeds off over a few minutes. Bounty is
 * permanent, heat is not — together they give "the marines are looking for you right now"
 * without needing a separate wanted-level system.
 */
export class Bounty {
  constructor(seed = 0) {
    this.seed = seed >>> 0;
    this.total = 0;
    this.heat = 0;              // 0..1
    this.peakTierIndex = 0;
    this.history = [];          // last 24 { amount, reason, total, tier }
    this.epithet = '';
    this.postersSeen = 0;       // how many times the world has re-issued the poster
  }

  /** Current tier record. @returns {object} */
  tier() { return tierFor(this.total); }

  /** Current tier index 0..6. @returns {number} */
  tierIndex() { return this.tier().index; }

  /**
   * Raise the bounty. The only mutator — everything that changes reputation goes through here
   * so the history is a complete, auditable record of why the world turned on you.
   * @param {number} amount beli to add (clamped to >= 0; bounties never fall in this world)
   * @param {string} reason short human-readable cause, shown in the log
   * @returns {{newTotal:number, tierChanged:boolean, tier:object, delta:number, reason:string}}
   */
  addBounty(amount, reason = 'unknown') {
    const delta = Math.max(0, Math.round(amount || 0));
    const before = this.tier();
    this.total += delta;
    const after = this.tier();
    const tierChanged = after.index !== before.index;
    if (tierChanged) {
      this.peakTierIndex = Math.max(this.peakTierIndex, after.index);
      this.postersSeen++;
      // The epithet is chosen from the tier you just reached, so it escalates with you.
      this.epithet = EPITHETS[Math.min(EPITHETS.length - 1, after.index + (this.postersSeen % 2))];
    }
    // Any newsworthy act also raises short-term heat, scaled by how big the act was.
    if (delta > 0) this.heat = clamp01(this.heat + Math.min(0.5, delta / 12000000));
    this.history.push({ amount: delta, reason, total: this.total, tier: after.id });
    if (this.history.length > 24) this.history.shift();
    return { newTotal: this.total, tierChanged, tier: after, delta, reason };
  }

  /** Heat decays over ~3 minutes of not being newsworthy. Called from QuestSystem.step. */
  step(dt) {
    if (this.heat > 0) this.heat = Math.max(0, this.heat - dt / 180);
  }

  /** Called when the player is seen using a devil fruit somewhere populated. */
  witnessedFruitUse(fruitId, townId) {
    return this.addBounty(BOUNTY_AWARDS.fruitSeenInTown, 'seen using the ' + fruitId + ' power in ' + townId);
  }

  /**
   * How an npc of a given kind behaves toward the player right now.
   * @param {string} npcKind 'villager' | 'marine' | 'child' | ... (see REACTION_BY_KIND)
   * @returns {'friendly'|'wary'|'afraid'|'hostile'|'starstruck'}
   */
  reactionTo(npcKind) {
    const idx = this.tierIndex();
    const ladder = REACTION_BY_KIND[npcKind];
    if (!ladder) return this.tier().npcReaction;
    let r = ladder[clamp(idx, 0, ladder.length - 1)];
    // Hot on the heels of something loud, the wary get frightened and the calm get wary.
    if (this.heat > 0.6) {
      if (r === 'wary') r = 'afraid';
      else if (r === 'friendly' && npcKind !== 'crew' && npcKind !== 'child') r = 'wary';
    }
    return r;
  }

  /** Marine patrol density right now, including heat. @returns {number} 0..1 */
  patrolChance() { return clamp01(this.tier().marinePatrolChance + this.heat * 0.25); }

  /** Chance a travel leg is interrupted by a bounty-hunter ambush. @returns {number} 0..1 */
  ambushChance() { return clamp01(this.tier().ambushChance + this.heat * 0.15); }

  /** Deterministic patrol roll. Pass an Rng stream from core/rng.js. @returns {boolean} */
  rollPatrol(rng) { return rng.f() < this.patrolChance(); }

  /** Deterministic ambush roll. @returns {boolean} */
  rollAmbush(rng) { return rng.f() < this.ambushChance(); }

  /**
   * Flat snapshot for other systems. Everything a shop, spawner, npc or mixer needs,
   * in one object, with no need to understand tiers.
   * @returns {object}
   */
  state() {
    const t = this.tier();
    const next = BOUNTY_TIERS[Math.min(BOUNTY_TIERS.length - 1, t.index + 1)];
    const span = next.min - t.min;
    return {
      total: this.total,
      display: commify(this.total),
      tierId: t.id,
      tierIndex: t.index,
      tierName: t.name,
      blurb: t.blurb,
      epithet: this.epithet,
      spawnTierBonus: t.spawnTierBonus,
      marinePatrolChance: this.patrolChance(),
      npcReaction: t.npcReaction,
      shopPriceMult: t.shopPriceMult,
      ambushChance: this.ambushChance(),
      musicTension: clamp01(t.musicTension + this.heat * 0.18),
      posterArt: t.posterArt,
      heat: this.heat,
      nextTierName: next === t ? null : next.name,
      nextTierAt: next === t ? null : next.min,
      toNextTier: next === t ? 0 : Math.max(0, next.min - this.total),
      tierRatio: span > 0 ? clamp01((this.total - t.min) / span) : 1,
      history: this.history.slice(-8),
    };
  }

  serialize() {
    return {
      total: this.total,
      heat: Math.round(this.heat * 1000) / 1000,
      peak: this.peakTierIndex,
      epithet: this.epithet,
      posters: this.postersSeen,
      history: this.history.slice(-24),
    };
  }

  deserialize(o) {
    if (!o) return this;
    this.total = Math.max(0, o.total | 0);
    this.heat = clamp01(o.heat || 0);
    this.peakTierIndex = o.peak | 0;
    this.epithet = o.epithet || '';
    this.postersSeen = o.posters | 0;
    this.history = Array.isArray(o.history) ? o.history.slice(-24) : [];
    return this;
  }
}

/** Poster ink for a tier without instantiating a Bounty — used by the texture painters. */
export function posterInkFor(tierIndex) {
  const t = BOUNTY_TIERS[clamp(tierIndex, 0, BOUNTY_TIERS.length - 1)];
  return shift(t.posterArt.ink, 0, 0, tierIndex >= 5 ? -0.04 : 0);
}
