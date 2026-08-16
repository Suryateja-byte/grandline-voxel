// Crew — seven people, seven passive bonuses that other systems actually read.
//
// The design rule here: a crew member is not a portrait in a menu. Recruiting the navigator
// makes the ship measurably faster and pushes your map markers further out; recruiting the
// doctor changes your health bar length on the spot. `activeBonuses()` returns one flat object
// so ship/combat/player code can read a single value without knowing who is aboard.
//
// Portrait fields are palette references (P.*) so the character owner can build each crew
// member's voxel model without inventing colours.

import { P, mixHex, shadeDown } from '../gen/palette.js';

/** Default bonus set — the values that apply with an empty crew. */
export function baseBonuses() {
  return {
    sailSpeedMult: 1,
    turnRateMult: 1,
    stormDriftMult: 1,
    markerRange: 200,          // metres at which world markers resolve
    maxHpMult: 1,
    meleeDamageMult: 1,
    rangedDamageMult: 1,
    outOfCombatRegen: 0,       // hp per second once `regenDelay` has elapsed
    regenDelay: 4,
    hullRepairPerSec: 0,
    markNearestEnemy: false,
    markRange: 0,
    cookedMealSlots: 0,
    weatherWarningS: 0,        // seconds of advance warning before a squall
  };
}

/**
 * The roster. `bonus` is merged into the flat bonus object by `applyBonus`.
 * `recruitedBy` names the quest that hands them over — the self-check walks this.
 */
export const CREW = Object.freeze([
  Object.freeze({
    id: 'pell_marren',
    name: 'Pell Marren',
    role: 'Sniper',
    island: 'shellsCove',
    recruitedBy: 'shellsCove.q3',
    tagline: 'Slingshot, one good eye, and a habit of counting out loud.',
    joinLine: 'I have hit every gull on this island. Give me something that hits back.',
    barks: Object.freeze([
      'Wind is left to right. Lead him.',
      'Two on the ridge. I have the far one.',
      'Counting three. Three is mine.',
    ]),
    portrait: Object.freeze({
      skin: P.skinTan, hair: P.hairGinger, outfit: P.heroGold,
      accent: P.heroRed, eye: 'sly', mouth: 'grin', scar: 'cheek',
    }),
    bonus: Object.freeze({ markNearestEnemy: true, markRange: 46, rangedDamageMult: 1.08 }),
  }),
  Object.freeze({
    id: 'ferra_yune',
    name: 'Ferra Yune',
    role: 'Helmsman',
    island: 'palmReach',
    recruitedBy: 'palmReach.q3',
    tagline: 'Last of the Canopy Expedition. Sleeps with a hand on the wheel.',
    joinLine: 'Eleven of us went up. I came down. I would rather steer than climb.',
    barks: Object.freeze([
      'Hard over. Trust me and hold on.',
      'That squall has a shoulder to it. Come two points to port.',
      'I do not lose people twice.',
    ]),
    portrait: Object.freeze({
      skin: P.skinDark, hair: P.hairGreen, outfit: P.jungle,
      accent: P.rope, eye: 'open', mouth: 'flat', scar: 'eye',
    }),
    bonus: Object.freeze({ turnRateMult: 1.18, stormDriftMult: 0.75, weatherWarningS: 9 }),
  }),
  Object.freeze({
    id: 'odd_bracken',
    name: 'Odd Bracken',
    role: 'Shipwright',
    island: 'cogHarbour',
    recruitedBy: 'cogHarbour.q4',
    tagline: 'Built half the hulls in the harbour and refuses to be proud of any of them.',
    joinLine: 'They made me sign bad keels for six years. Let me build one honest boat.',
    barks: Object.freeze([
      'She is taking it. Not gracefully, but taking it.',
      'Two planks short of a problem. I will handle it.',
      'Do not scrape the coral. I am asking nicely.',
    ]),
    portrait: Object.freeze({
      skin: P.skinLo, hair: P.hairWhite, outfit: P.wood,
      accent: P.metal, eye: 'angry', mouth: 'flat', scar: 'none',
    }),
    bonus: Object.freeze({ hullRepairPerSec: 0.9 }),
  }),
  Object.freeze({
    id: 'sena_brill',
    name: 'Sena Brill',
    role: 'Doctor',
    island: 'drumPeaks',
    recruitedBy: 'drumPeaks.q3',
    tagline: 'Climbed a mountain for one child. Would do it again before breakfast.',
    joinLine: 'You carried her down. I will carry whatever you break next.',
    barks: Object.freeze([
      'Breathe out before you swing. You keep forgetting.',
      'That is going to bruise beautifully.',
      'Sit. I am not asking.',
    ]),
    portrait: Object.freeze({
      skin: P.skinPale, hair: P.hairBrown, outfit: P.uiWhite,
      accent: P.fruitHie, eye: 'open', mouth: 'smile', scar: 'none',
    }),
    bonus: Object.freeze({ maxHpMult: 1.25 }),
  }),
  Object.freeze({
    id: 'basil_ord',
    name: 'Basil Ord',
    role: 'Cook',
    island: 'emberfall',
    recruitedBy: 'emberfall.q4',
    tagline: 'Learned heat from a forge, not a kitchen. It shows in the crust.',
    joinLine: 'A forge and a stove are the same argument. I win both.',
    barks: Object.freeze([
      'Eat now. You will not want to later.',
      'Salt, ash, and patience. That is the whole recipe.',
      'If you die hungry I will take it personally.',
    ]),
    portrait: Object.freeze({
      skin: P.skinTan, hair: P.hair, outfit: P.sail,
      accent: P.lava, eye: 'happy', mouth: 'grin', scar: 'cheek',
    }),
    bonus: Object.freeze({ outOfCombatRegen: 1.8, regenDelay: 4, cookedMealSlots: 2 }),
  }),
  Object.freeze({
    id: 'nia_sarrow',
    name: 'Nia Sarrow',
    role: 'Navigator',
    island: 'whisperSands',
    recruitedBy: 'whisperSands.q4',
    tagline: 'Read a dead city like a chart and found the water under it.',
    joinLine: 'Your course is fine. Your reasons are terrible. I am coming.',
    barks: Object.freeze([
      'Current is with us. Do not waste it.',
      'Land in nine minutes, bearing north-north-east.',
      'That is not a cloud. That is a problem.',
    ]),
    portrait: Object.freeze({
      skin: P.skin, hair: P.hairBlonde, outfit: P.heroCyan,
      accent: P.fruitSuna, eye: 'sly', mouth: 'smile', scar: 'none',
    }),
    bonus: Object.freeze({ sailSpeedMult: 1.12, markerRange: 340, weatherWarningS: 6 }),
  }),
  Object.freeze({
    id: 'sen_ishiba',
    name: 'Sen Ishiba',
    role: 'Swordsman',
    island: 'blossomTerrace',
    recruitedBy: 'blossomTerrace.q4',
    tagline: 'Ninth rung for eleven years by choice. Came down when it stopped meaning anything.',
    joinLine: 'You beat the ladder. The ladder was never the point. Let us go find one.',
    barks: Object.freeze([
      'Left guard. He always opens left.',
      'Cut once. Cut properly.',
      'Petals fall. Nobody claps.',
    ]),
    portrait: Object.freeze({
      skin: P.skinPale, hair: P.hairSoft, outfit: P.pirateBlack,
      accent: P.cherryBlossom, eye: 'angry', mouth: 'flat', scar: 'cross',
    }),
    bonus: Object.freeze({ meleeDamageMult: 1.10 }),
  }),
]);

export const CREW_BY_ID = Object.freeze(new Map(CREW.map((c) => [c.id, c])));

/** Merge one member's bonus into the accumulator. Mults multiply, ranges take the max. */
function applyBonus(acc, bonus) {
  for (const k of Object.keys(bonus)) {
    const v = bonus[k];
    if (typeof v === 'boolean') acc[k] = acc[k] || v;
    else if (k.endsWith('Mult')) acc[k] *= v;
    else if (k === 'regenDelay') acc[k] = Math.min(acc[k], v);
    else if (k.endsWith('Range') || k.endsWith('S') || k.endsWith('Slots')) acc[k] = Math.max(acc[k], v);
    else acc[k] += v;
  }
  return acc;
}

/** Crew banner colour for a roster — used by the ship's pennant. Composed, never hardcoded. */
export function crewColour(ids) {
  if (!ids.length) return P.sail;
  let c = P.flagRed;
  for (let i = 0; i < ids.length; i++) {
    const m = CREW_BY_ID.get(ids[i]);
    if (m) c = mixHex(c, m.portrait.accent, 0.22);
  }
  return c;
}

/** The player's crew. Recruitment is one-way; nobody leaves in this arc. */
export class CrewRoster {
  constructor() {
    /** @type {Array<{id:string, recruitedAt:number}>} */
    this.members = [];
    this._ids = new Set();
    this._cache = null;
  }

  /** @returns {boolean} */
  has(id) { return this._ids.has(id); }

  /**
   * Add a crew member. Idempotent — a quest that pays out twice cannot duplicate a bonus.
   * @param {string} id CREW id
   * @param {number} simTime simulation seconds, for the save record
   * @returns {object|null} the roster entry, or null if unknown / already aboard
   */
  recruit(id, simTime = 0) {
    if (!CREW_BY_ID.has(id) || this._ids.has(id)) return null;
    const entry = { id, recruitedAt: simTime };
    this.members.push(entry);
    this._ids.add(id);
    this._cache = null;
    return entry;
  }

  /** Full records for everyone aboard, in join order. @returns {object[]} */
  roster() {
    return this.members.map((m) => {
      const def = CREW_BY_ID.get(m.id);
      return {
        id: def.id, name: def.name, role: def.role, island: def.island,
        tagline: def.tagline, portrait: def.portrait, barks: def.barks,
        recruitedAt: m.recruitedAt, bonus: def.bonus,
      };
    });
  }

  /** Everyone still out there, so the UI can show the empty seats honestly. @returns {object[]} */
  missing() {
    return CREW.filter((c) => !this._ids.has(c.id))
      .map((c) => ({ id: c.id, role: c.role, island: c.island }));
  }

  /**
   * The flat bonus object every other system reads. Cached until the roster changes.
   * @returns {object} see baseBonuses() for the full key list
   */
  activeBonuses() {
    if (this._cache) return this._cache;
    const acc = baseBonuses();
    for (const m of this.members) {
      const def = CREW_BY_ID.get(m.id);
      if (def) applyBonus(acc, def.bonus);
    }
    acc.count = this.members.length;
    acc.pennant = crewColour(this.members.map((m) => m.id));
    acc.pennantTrim = shadeDown(acc.pennant, 0.5);
    this._cache = acc;
    return acc;
  }

  serialize() { return this.members.map((m) => ({ id: m.id, recruitedAt: m.recruitedAt })); }

  deserialize(arr) {
    this.members = [];
    this._ids = new Set();
    this._cache = null;
    if (!Array.isArray(arr)) return this;
    for (const m of arr) if (m && CREW_BY_ID.has(m.id)) this.recruit(m.id, m.recruitedAt || 0);
    return this;
  }
}
