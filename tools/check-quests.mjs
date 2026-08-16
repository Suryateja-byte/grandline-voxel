// Headless play-through of every authored quest.
//
// This is the gate for src/quest/*: it accepts every quest in every chain, fires the exact
// notify() events a real player's actions would produce, and asserts the arc actually
// completes — no dead ends, no reward paid twice, every fruit and every crew member
// reachable, every bounty tier crossed, and a save that round-trips byte-for-byte.
//
// Run: node tools/check-quests.mjs

import { QuestSystem, QUEST_STATE } from '../src/quest/quest.js';
import {
  QUESTS, QUEST_BY_ID, CHAINS, ISLANDS, FRUITS, ENEMY_KINDS, BOSSES,
  ITEMS, PROPS, SHIP_UPGRADES, MAP_FRAGMENTS, TOTAL_QUEST_BOUNTY,
} from '../src/quest/quests.js';
import { CREW } from '../src/quest/crew.js';
import { BOUNTY_TIERS } from '../src/quest/bounty.js';
import { NPC_BY_ID, makeQuestDialogue, walkTree } from '../src/quest/dialogue.js';

const FIXED_DT = 1 / 60;
const SEED = 20260814;

let failures = 0;
let checks = 0;

function ok(cond, msg, detail) {
  checks++;
  if (!cond) {
    failures++;
    console.error('  FAIL  ' + msg + (detail !== undefined ? '  <' + detail + '>' : ''));
  }
  return !!cond;
}

function eq(a, b, msg) {
  return ok(a === b, msg, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

function section(name) {
  console.log('\n== ' + name);
}

// ---------------------------------------------------------------------------
// 1. Static content integrity
// ---------------------------------------------------------------------------

section('content integrity');

// Built at runtime so this file never itself contains the words it forbids.
const PLACEHOLDER = new RegExp(['TO' + 'DO', 'TB' + 'D', 'place' + 'holder', 'lorem'].join('|'), 'i');

const SPAWN_POINTS = new Set([
  'dock', 'plaza', 'boss_arena', 'vista', 'secret',
  'npc_1', 'npc_2', 'npc_3', 'npc_4', 'chest_1', 'chest_2', 'chest_3',
]);

function checkPoint(id, where) {
  const parts = String(id).split('.');
  ok(parts.length === 2 && ISLANDS.indexOf(parts[0]) >= 0 && SPAWN_POINTS.has(parts[1]),
    'point id is a real island spawn point (' + where + ')', id);
}

for (const q of QUESTS) {
  ok(!!q.title && !PLACEHOLDER.test(q.title) && !PLACEHOLDER.test(q.summary), 'quest has real prose', q.id);
  ok(!!q.summary && q.summary.length > 20, 'quest has a real summary', q.id);
  ok(NPC_BY_ID.has(q.giver), 'quest giver is a registered npc', q.id + ' -> ' + q.giver);
  ok(q.steps.length >= 2 && q.steps.length <= 4, 'quest has 2-4 steps', q.id + ' ' + q.steps.length);
  for (const need of q.requires) ok(QUEST_BY_ID.has(need), 'prerequisite exists', q.id + ' -> ' + need);
  const d = q.dialogue;
  for (const key of ['offer', 'accept', 'active', 'turnIn', 'reward']) {
    ok(Array.isArray(d[key]) && d[key].length >= 1 && d[key].every((l) => l.length > 8),
      'dialogue.' + key + ' is written', q.id);
  }
  for (const s of q.steps) {
    ok(!!s.text && s.text.length > 4, 'step has a tracker headline', q.id + '/' + s.id);
    ok(s.objectives.length >= 1 && s.objectives.length <= 3, 'step has 1-3 objectives', q.id + '/' + s.id);
    for (const o of s.objectives) {
      switch (o.type) {
        case 'goto': checkPoint(o.point, q.id); break;
        case 'escort': checkPoint(o.point, q.id); break;
        case 'openChest': checkPoint(o.chestId, q.id); break;
        case 'findSecret': checkPoint(o.secretId, q.id); break;
        case 'defeat': ok(ENEMY_KINDS.indexOf(o.enemyKind) >= 0, 'enemy kind is in the vocabulary', o.enemyKind); break;
        case 'defeatBoss': ok(!!BOSSES[o.bossId], 'boss is registered', o.bossId); break;
        case 'talk': ok(NPC_BY_ID.has(o.npcId), 'talk target is a registered npc', o.npcId); break;
        case 'deliver':
          ok(!!ITEMS[o.itemId], 'delivered item is registered', o.itemId);
          ok(NPC_BY_ID.has(o.npcId), 'delivery target is a registered npc', o.npcId);
          break;
        case 'collect': ok(!!ITEMS[o.itemId], 'collected item is registered', o.itemId); break;
        case 'destroy': ok(!!PROPS[o.propId], 'prop is registered', o.propId); break;
        case 'sailTo': ok(ISLANDS.indexOf(o.islandId) >= 0, 'sail target is a landmark island', o.islandId); break;
        case 'useFruit': ok(FRUITS.indexOf(o.fruitId) >= 0, 'fruit is one of the six', o.fruitId); break;
        default: break;
      }
    }
  }
  // Every dialogue phase must build into a walkable tree.
  for (const phase of ['offer', 'active', 'turnIn']) {
    const tree = makeQuestDialogue(q, phase);
    const walk = walkTree(tree, { bountyTier: 0, crew: [], fruits: [], questsDone: [], questsActive: [], flags: {} });
    ok(walk.lines.length >= 1, 'dialogue tree ' + phase + ' walks', q.id);
  }
}

eq(QUESTS.length, 33, 'quest count');
for (const island of ISLANDS) {
  const n = CHAINS[island].length;
  ok(n >= 3 && n <= 5, 'chain ' + island + ' has 3-5 quests', n);
}

// ---------------------------------------------------------------------------
// 2. The walker: turn an objective into the events that satisfy it
// ---------------------------------------------------------------------------

/** Fire one unit of progress toward `spec`. Returns false if the kind is unknown. */
function pushObjective(qs, spec, fightHint) {
  switch (spec.type) {
    case 'goto':
      qs.notify('areaEntered', { point: spec.point, dist: 0 });
      return true;
    case 'defeat':
      qs.notify('enemyDefeated', { kind: spec.enemyKind, fightId: fightHint, named: false });
      return true;
    case 'defeatBoss':
      qs.notify('bossDefeated', { id: spec.bossId, name: spec.bossName, fightId: fightHint });
      return true;
    case 'talk':
      qs.notify('npcTalked', { npcId: spec.npcId });
      return true;
    case 'collect':
      qs.notify('itemCollected', { itemId: spec.itemId, count: 1 });
      return true;
    case 'deliver':
      qs.notify('npcTalked', { npcId: spec.npcId, deliver: spec.itemId });
      return true;
    case 'survive':
      for (let i = 0; i < 8; i++) qs.step(FIXED_DT, null);
      return true;
    case 'escort':
      qs.notify('areaEntered', { npcId: spec.npcId, point: spec.point });
      return true;
    case 'useFruit':
      qs.notify('fruitUsed', { fruitId: spec.fruitId, move: spec.move || undefined });
      return true;
    case 'sailTo':
      qs.notify('islandDocked', { islandId: spec.islandId });
      return true;
    case 'findSecret':
      qs.notify('areaEntered', { secret: spec.secretId });
      return true;
    case 'openChest':
      qs.notify('chestOpened', { id: spec.chestId });
      return true;
    case 'winWithoutDamage':
      qs.notify('enemyDefeated', { kind: 'terrace_duelist', fightId: spec.fightId });
      return true;
    case 'destroy':
      qs.notify('propDestroyed', { propId: spec.propId });
      return true;
    default:
      return false;
  }
}

/** Play one quest from accept to done. Returns the number of events it took. */
function playQuest(qs, id) {
  ok(qs.accept(id), 'accept ' + id);
  const q = QUEST_BY_ID.get(id);
  let guard = 0;
  while (qs.records.get(id).state === QUEST_STATE.ACTIVE && guard++ < 4000) {
    const rec = qs.records.get(id);
    const objs = q.steps[rec.step].objectives;
    let advanced = false;
    for (let i = 0; i < objs.length; i++) {
      const spec = objs[i];
      // Skip already-satisfied objectives; push the first that still needs work.
      if (objectiveSatisfied(spec, rec.obj[i])) continue;
      if (!pushObjective(qs, spec, spec.fightId)) {
        ok(false, 'walker knows how to satisfy ' + spec.type, id);
        return guard;
      }
      advanced = true;
      break;
    }
    if (!advanced) break;
  }
  return guard;
}

/** Mirror of objectives.js completion, without importing internals. */
function objectiveSatisfied(spec, state) {
  if (state.n !== undefined) {
    return state.n >= (spec.count !== undefined ? spec.count : spec.times);
  }
  if (state.t !== undefined) return state.t >= spec.seconds;
  return !!state.done;
}

// ---------------------------------------------------------------------------
// 3. Full play-through
// ---------------------------------------------------------------------------

section('full play-through');

const qs = new QuestSystem(SEED);
const tiersSeen = new Set([qs.bountyState().tierIndex]);
const completeEvents = new Map();     // questId -> times questComplete fired
const rewardEvents = [];              // every reward-ish event, for the once-only check
const checkpoints = [];

function drain() {
  for (const e of qs.drainEvents()) {
    if (e.kind === 'questComplete') completeEvents.set(e.id, (completeEvents.get(e.id) || 0) + 1);
    if (e.kind === 'reward' || e.kind === 'crewJoined' || e.kind === 'fruitUnlocked'
      || e.kind === 'shipUpgrade' || e.kind === 'mapFragment') rewardEvents.push(e);
  }
  tiersSeen.add(qs.bountyState().tierIndex);
}

function snapshot(label) {
  const a = JSON.stringify(qs.serialize());
  const restored = new QuestSystem(SEED).deserialize(JSON.parse(a));
  const b = JSON.stringify(restored.serialize());
  ok(a === b, 'serialize/deserialize round-trips exactly at: ' + label);
  if (a !== b) {
    const la = JSON.parse(a), lb = JSON.parse(b);
    for (const k of Object.keys(la)) {
      if (JSON.stringify(la[k]) !== JSON.stringify(lb[k])) console.error('    diff in "' + k + '"');
    }
  }
  checkpoints.push({ label, bytes: a.length, restored });
  return restored;
}

// Checkpoint 1 — a brand-new game.
snapshot('a brand-new game');

// Shells Cove, with a mid-quest checkpoint inside q2.
playQuest(qs, 'shellsCove.q1'); drain();
qs.accept('shellsCove.q2');
qs.notify('areaEntered', { point: 'shellsCove.vista', dist: 0 });
qs.notify('propDestroyed', { propId: 'shellsCove.thug_banner' });
drain();
// Checkpoint 2 — halfway through a quest, with partial counters live.
const mid = snapshot('mid-quest, counters in flight');
{
  // The restored save must be able to finish the quest it was saved during.
  const rec = mid.records.get('shellsCove.q2');
  eq(rec.state, QUEST_STATE.ACTIVE, 'restored save keeps the quest active');
  eq(rec.step, 1, 'restored save keeps the step index');
  eq(rec.obj[0].n, 1, 'restored save keeps the partial counter');
  playQuestRemainder(mid, 'shellsCove.q2');
  eq(mid.records.get('shellsCove.q2').state, QUEST_STATE.DONE, 'restored save can finish its quest');
}

function playQuestRemainder(sys, id) {
  const q = QUEST_BY_ID.get(id);
  let guard = 0;
  while (sys.records.get(id).state === QUEST_STATE.ACTIVE && guard++ < 4000) {
    const rec = sys.records.get(id);
    const objs = q.steps[rec.step].objectives;
    let advanced = false;
    for (let i = 0; i < objs.length; i++) {
      if (objectiveSatisfied(objs[i], rec.obj[i])) continue;
      pushObjective(sys, objs[i], objs[i].fightId);
      advanced = true;
      break;
    }
    if (!advanced) break;
  }
}

playQuestRemainder(qs, 'shellsCove.q2'); drain();
playQuest(qs, 'shellsCove.q3'); drain();
playQuest(qs, 'shellsCove.q4'); drain();

// Every remaining chain, in arc order.
for (const island of ISLANDS) {
  for (const id of CHAINS[island]) {
    if (qs.records.get(id).state === QUEST_STATE.DONE) continue;
    ok(qs.records.get(id).state === QUEST_STATE.AVAILABLE,
      'quest unlocked when its chain reached it: ' + id, qs.records.get(id).state);
    playQuest(qs, id);
    drain();
  }
  if (island === 'cogHarbour') snapshot('after the Cog Harbour chain');
  if (island === 'whisperSands') snapshot('after the Whisper Sands chain');
}

// Checkpoint 5 — the finished arc.
snapshot('the finished arc');

// ---------------------------------------------------------------------------
// 4. Assertions
// ---------------------------------------------------------------------------

section('completion');

let notDone = [];
for (const q of QUESTS) {
  const rec = qs.records.get(q.id);
  if (rec.state !== QUEST_STATE.DONE) notDone.push(q.id + '(' + rec.state + ')');
}
ok(notDone.length === 0, 'every quest is completable — no dead ends', notDone.join(', '));
eq(completeEvents.size, QUESTS.length, 'questComplete fired for every quest');
const doubled = [...completeEvents.entries()].filter(([, n]) => n !== 1).map(([id, n]) => id + ' x' + n);
ok(doubled.length === 0, 'questComplete fired exactly once per quest', doubled.join(', '));

section('rewards granted exactly once');

const expected = { berries: 0, xp: 0, bounty: 0 };
const expectedCrew = new Set(), expectedFruit = new Set(), expectedUpgrade = new Set(), expectedFrag = new Set();
for (const q of QUESTS) {
  expected.berries += q.rewards.berries || 0;
  expected.xp += q.rewards.xp || 0;
  expected.bounty += q.rewards.bounty || 0;
  if (q.rewards.crew) expectedCrew.add(q.rewards.crew);
  if (q.rewards.fruit) expectedFruit.add(q.rewards.fruit);
  if (q.rewards.shipUpgrade) expectedUpgrade.add(q.rewards.shipUpgrade);
  if (q.rewards.mapFragment) expectedFrag.add(q.rewards.mapFragment);
}
eq(qs.berries, expected.berries, 'berries paid exactly once (sum of every quest)');
eq(qs.xp, expected.xp, 'xp paid exactly once');
eq(expected.bounty, TOTAL_QUEST_BOUNTY, 'authored bounty total matches the module constant');

const countBy = (pred) => rewardEvents.filter(pred).length;
eq(countBy((e) => e.kind === 'crewJoined'), expectedCrew.size, 'crewJoined fired once per crew member');
eq(countBy((e) => e.kind === 'fruitUnlocked'), expectedFruit.size, 'fruitUnlocked fired once per fruit');
eq(countBy((e) => e.kind === 'shipUpgrade'), expectedUpgrade.size, 'shipUpgrade fired once per upgrade');
eq(countBy((e) => e.kind === 'mapFragment'), expectedFrag.size, 'mapFragment fired once per fragment');

// Re-firing a completed quest's final events must not pay out again.
const berriesBefore = qs.berries, xpBefore = qs.xp, bountyBefore = qs.bounty.total;
for (const q of QUESTS) {
  const last = q.steps[q.steps.length - 1];
  for (const o of last.objectives) pushObjective(qs, o, o.fightId);
}
qs.drainEvents();
eq(qs.berries, berriesBefore, 'replaying finished objectives pays no berries');
eq(qs.xp, xpBefore, 'replaying finished objectives pays no xp');
ok(qs.bounty.total >= bountyBefore, 'bounty only ever rises', qs.bounty.total - bountyBefore);
eq(qs.crew().length, CREW.length, 'replay did not duplicate crew');
eq(qs.unlockedFruits().length, FRUITS.length, 'replay did not duplicate fruits');

section('fruits, crew, upgrades, fragments');

for (const f of FRUITS) ok(qs.isUnlocked(f), 'fruit obtainable: ' + f);
eq(qs.unlockedFruits().length, 6, 'all six devil fruits obtained');
for (const c of CREW) ok(qs.crewRoster.has(c.id), 'crew recruitable: ' + c.id + ' (' + c.role + ')');
eq(qs.crew().length, 7, 'all seven crew recruited');
eq(qs.crewRoster.missing().length, 0, 'no empty crew seats');
eq(qs.shipUpgrades().ids.length, Object.keys(SHIP_UPGRADES).length, 'every ship upgrade obtainable');
eq(qs.mapFragments().have.length, Object.keys(MAP_FRAGMENTS).length, 'every map fragment obtainable');

const bonuses = qs.activeBonuses();
ok(bonuses.sailSpeedMult > 1, 'navigator bonus applies', bonuses.sailSpeedMult);
ok(bonuses.maxHpMult > 1, 'doctor bonus applies', bonuses.maxHpMult);
ok(bonuses.meleeDamageMult > 1, 'swordsman bonus applies', bonuses.meleeDamageMult);
ok(bonuses.hullRepairPerSec > 0, 'shipwright bonus applies', bonuses.hullRepairPerSec);
ok(bonuses.outOfCombatRegen > 0, 'cook bonus applies', bonuses.outOfCombatRegen);
ok(bonuses.markNearestEnemy === true, 'sniper bonus applies');
ok(bonuses.turnRateMult > 1, 'helmsman bonus applies', bonuses.turnRateMult);

section('bounty');

const finalState = qs.bountyState();
for (const t of BOUNTY_TIERS) ok(tiersSeen.has(t.index), 'bounty crossed tier ' + t.index + ' (' + t.name + ')');
eq(tiersSeen.size, BOUNTY_TIERS.length, 'every bounty tier was occupied at some point');
eq(finalState.tierIndex, BOUNTY_TIERS.length - 1, 'arc ends at the top tier');
ok(finalState.total >= TOTAL_QUEST_BOUNTY, 'final bounty includes every authored award', finalState.total);
eq(qs.reactionTo('marine'), 'hostile', 'marines are hostile at the top tier');
eq(qs.reactionTo('child'), 'starstruck', 'children are starstruck at the top tier');
eq(qs.reactionTo('crew'), 'friendly', 'crew stay friendly regardless');
ok(finalState.shopPriceMult > 1, 'shops charge more at the top tier', finalState.shopPriceMult);
ok(finalState.marinePatrolChance > 0.5, 'patrols are dense at the top tier', finalState.marinePatrolChance);
ok(finalState.musicTension >= 1, 'music tension is maxed at the top tier', finalState.musicTension);
ok(!!finalState.posterArt && finalState.posterArt.stars === 5, 'poster art escalates to five stars');

section('save round-trips');
eq(checkpoints.length, 5, 'five distinct save/load checkpoints exercised');
for (const c of checkpoints) console.log('  ' + c.label + ' — ' + c.bytes + ' bytes');

// ---------------------------------------------------------------------------

section('result');
console.log('  ' + (checks - failures) + ' / ' + checks + ' checks passed');
console.log('  quests: ' + QUESTS.length + '   crew: ' + qs.crew().length + '   fruits: ' + qs.unlockedFruits().length);
console.log('  final bounty: ' + qs.bountyState().display + '  (' + qs.bountyState().tierName + ')');
console.log('  berries: ' + qs.berries + '   xp: ' + qs.xp + '   level: ' + qs.progression().level);
if (failures) {
  console.error('\nCHECK-QUESTS FAILED: ' + failures + ' assertion(s).');
  process.exit(1);
}
console.log('\nCHECK-QUESTS OK');
