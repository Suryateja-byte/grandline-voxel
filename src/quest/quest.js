// QuestSystem — the facade the rest of the game talks to.
//
// The contract is deliberately narrow: the world *tells* this system what happened via
// notify(), and asks it questions via the read methods. Nothing in here reaches into the
// world, reads the clock, or rolls dice outside its own seeded stream. That is what makes
// a save deterministic and what makes tools/check-quests.mjs able to play the whole game
// headlessly in a few milliseconds.
//
// Registered in app.js as a system; stepped in the `quest` slot of ARCHITECTURE §4.

import { Rng } from '../core/rng.js';
import {
  applyEvent, tickObjective, objectiveDone, objectiveProgress,
  initObjectiveState, serializeObjective, deserializeObjective, objectiveIsTimed,
} from './objectives.js';
import {
  QUESTS, QUEST_BY_ID, CHAINS, ISLANDS, ISLAND_NAMES, FRUITS,
  SHIP_UPGRADES, MAP_FRAGMENTS, ITEMS, levelForXp, levelProgress, rewardLabel,
} from './quests.js';
import { Bounty, BOUNTY_AWARDS } from './bounty.js';
import { CrewRoster, CREW_BY_ID } from './crew.js';
import { makeQuestDialogue, makeTree, DialogueRunner, NPC_BY_ID, barkFor } from './dialogue.js';

/** Quest lifecycle states. Stored in saves. */
export const QUEST_STATE = Object.freeze({
  LOCKED: 'locked',
  AVAILABLE: 'available',
  ACTIVE: 'active',
  DONE: 'done',
  ABANDONED: 'abandoned',
});

/** Events QuestSystem.notify accepts. Anything else is ignored, loudly in dev builds. */
export const NOTIFY_EVENTS = Object.freeze([
  'enemyDefeated', 'itemCollected', 'npcTalked', 'areaEntered', 'chestOpened',
  'fruitUsed', 'islandDocked', 'bossDefeated', 'propDestroyed', 'damageTaken',
]);

export class QuestSystem {
  /** @param {number} seed world seed; all quest randomness derives from it */
  constructor(seed = 0) {
    /**
     * Monotonic counter, bumped whenever quest progress changes shape (accept, abandon, step
     * advance, completion). The world's area-trigger dedup set keys off it: area triggers are
     * edge-triggered ("you ENTERED the dock area"), but a newly accepted goto objective needs
     * level-triggered semantics ("you ARE at the dock") — the player who accepts a quest while
     * already standing on its target must complete it without walking a 12 m lap first.
     */
    this.progressRevision = 0;
    this.seed = seed >>> 0;
    this.rng = Rng.fromName(this.seed, 'quest');
    this.barkRng = Rng.fromName(this.seed, 'quest:barks');

    this.bounty = new Bounty(this.seed);
    this.crewRoster = new CrewRoster();

    /** @type {Map<string, object>} runtime record per quest id */
    this.records = new Map();
    for (const q of QUESTS) this.records.set(q.id, this._blankRecord(q));

    // --- progression -------------------------------------------------------
    this.berries = 0;
    this.xp = 0;
    this.level = 1;
    /** @type {Set<string>} devil fruits the player may equip */
    this.fruits = new Set();
    /** @type {Set<string>} */
    this.shipUpgradeSet = new Set();
    /** @type {Set<string>} */
    this.mapFragmentSet = new Set();
    /** @type {Map<string, number>} quest items currently carried */
    this.items = new Map();
    /** @type {Set<string>} island ids the player has docked at */
    this.visited = new Set();
    /** @type {Object<string, boolean>} arbitrary story flags */
    this.flags = {};

    this.trackedId = null;
    this.time = 0;
    /** Outbound feed for UI/audio. Drained with drainEvents(). */
    this._out = [];
    this._dirty = true;
    this._refreshAvailability();
  }

  _blankRecord(q) {
    return {
      id: q.id,
      state: q.requires.length ? QUEST_STATE.LOCKED : QUEST_STATE.AVAILABLE,
      step: 0,
      obj: q.steps[0].objectives.map((o) => initObjectiveState(o)),
      rewarded: false,
      offered: false,
      startedAt: -1,
      completedAt: -1,
    };
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * One fixed step. Advances timed objectives, bleeds bounty heat, and unlocks quests whose
   * prerequisites completed since the last step.
   * @param {number} dt fixed timestep in seconds
   * @param {object} [ctx] the App; only `ctx.clock.simTime` is read, and only for save stamps
   */
  step(dt, ctx) {
    this.time += dt;
    if (ctx && ctx.clock) this.time = ctx.clock.simTime;
    this.bounty.step(dt);

    for (const rec of this.records.values()) {
      if (rec.state !== QUEST_STATE.ACTIVE) continue;
      const q = QUEST_BY_ID.get(rec.id);
      const objs = q.steps[rec.step].objectives;
      let changed = false;
      for (let i = 0; i < objs.length; i++) {
        if (!objectiveIsTimed(objs[i])) continue;
        if (tickObjective(objs[i], rec.obj[i], dt)) changed = true;
      }
      if (changed) this._settleStep(q, rec);
    }

    if (this._dirty) this._refreshAvailability();
  }

  /**
   * Recompute which locked quests have had their prerequisites satisfied.
   * @param {boolean} [silent] suppress the announcement — used when loading a save
   */
  _refreshAvailability(silent) {
    this._dirty = false;
    for (const q of QUESTS) {
      const rec = this.records.get(q.id);
      if (rec.state !== QUEST_STATE.LOCKED) continue;
      let ok = true;
      for (const need of q.requires) {
        const r = this.records.get(need);
        if (!r || r.state !== QUEST_STATE.DONE) { ok = false; break; }
      }
      if (ok) {
        rec.state = QUEST_STATE.AVAILABLE;
        if (!silent) this._emit('questAvailable', { id: q.id, title: q.title, island: q.island, giver: q.giver });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Offer / accept / abandon
  // -------------------------------------------------------------------------

  /**
   * Present a quest. Returns the offer conversation, or null if it is not offerable.
   * @param {string} id
   * @returns {{quest:object, tree:object, runner:DialogueRunner}|null}
   */
  offer(id) {
    const q = QUEST_BY_ID.get(id);
    const rec = this.records.get(id);
    if (!q || !rec || rec.state !== QUEST_STATE.AVAILABLE) return null;
    rec.offered = true;
    const tree = makeQuestDialogue(q, 'offer');
    return { quest: q, tree, runner: new DialogueRunner(tree, this.dialogueContext()) };
  }

  /**
   * Accept a quest, moving it into the active log.
   * @param {string} id
   * @returns {boolean} true if it became active
   */
  accept(id) {
    const q = QUEST_BY_ID.get(id);
    const rec = this.records.get(id);
    if (!q || !rec) return false;
    if (rec.state !== QUEST_STATE.AVAILABLE && rec.state !== QUEST_STATE.ABANDONED) return false;
    rec.state = QUEST_STATE.ACTIVE;
    rec.step = 0;
    this.progressRevision++;
    rec.obj = q.steps[0].objectives.map((o) => initObjectiveState(o));
    rec.startedAt = this.time;
    if (!this.trackedId) this.trackedId = id;
    this._emit('questAccepted', { id, title: q.title, island: q.island, step: this._stepView(q, rec) });
    return true;
  }

  /**
   * Drop a quest. It returns to the available pool with progress cleared — no dead ends.
   * @param {string} id
   * @returns {boolean}
   */
  abandon(id) {
    const q = QUEST_BY_ID.get(id);
    const rec = this.records.get(id);
    if (!q || !rec || rec.state !== QUEST_STATE.ACTIVE) return false;
    rec.state = QUEST_STATE.AVAILABLE;
    rec.step = 0;
    rec.obj = q.steps[0].objectives.map((o) => initObjectiveState(o));
    rec.startedAt = -1;
    if (this.trackedId === id) this.trackedId = null;
    this._emit('questAbandoned', { id, title: q.title });
    return true;
  }

  /** Apply an effect drained from a DialogueRunner. @returns {boolean} handled */
  applyDialogueEffect(effect) {
    if (!effect) return false;
    if (effect.accept) return this.accept(effect.accept);
    if (effect.decline) return true;      // declining is a valid, lossless answer
    if (effect.complete) {
      const rec = this.records.get(effect.complete);
      return !!rec && rec.state === QUEST_STATE.DONE;
    }
    if (effect.flag) { this.flags[effect.flag] = true; return true; }
    return false;
  }

  // -------------------------------------------------------------------------
  // The one way progress happens
  // -------------------------------------------------------------------------

  /**
   * Report something that happened in the world.
   * @param {string} event one of NOTIFY_EVENTS
   * @param {object} data event payload; see objectives.js for the fields each kind reads
   * @returns {{changed:string[], completed:string[], bounty:object|null}}
   */
  notify(event, data = {}) {
    const out = { changed: [], completed: [], bounty: null };
    if (NOTIFY_EVENTS.indexOf(event) < 0) return out;

    // --- world bookkeeping the quest layer owns -----------------------------
    if (event === 'islandDocked' && data.islandId) this.visited.add(data.islandId);
    if (event === 'itemCollected' && data.itemId) {
      this.items.set(data.itemId, (this.items.get(data.itemId) || 0) + (data.count || 1));
    }
    if (event === 'npcTalked' && data.deliver && this.items.has(data.deliver)) {
      const left = this.items.get(data.deliver) - 1;
      if (left > 0) this.items.set(data.deliver, left); else this.items.delete(data.deliver);
    }

    // --- reputation ---------------------------------------------------------
    const b = this._bountyForEvent(event, data);
    if (b) out.bounty = b;

    // --- objectives ---------------------------------------------------------
    for (const rec of this.records.values()) {
      if (rec.state !== QUEST_STATE.ACTIVE) continue;
      const q = QUEST_BY_ID.get(rec.id);
      const objs = q.steps[rec.step].objectives;
      let changed = false;
      for (let i = 0; i < objs.length; i++) {
        if (applyEvent(objs[i], rec.obj[i], event, data, this)) changed = true;
      }
      if (!changed) continue;
      out.changed.push(rec.id);
      this._emit('objectiveProgress', { id: rec.id, step: this._stepView(q, rec) });
      if (this._settleStep(q, rec)) out.completed.push(rec.id);
    }
    return out;
  }

  /** Award bounty for the world consequences of an event. @returns {object|null} */
  _bountyForEvent(event, data) {
    if (typeof data.bounty === 'number' && data.bounty > 0) {
      return this.bounty.addBounty(data.bounty, data.reason || event);
    }
    if (event === 'enemyDefeated') {
      if (data.kind === 'marine_officer' || data.kind === 'marine_elite') {
        return this.bounty.addBounty(BOUNTY_AWARDS.marineOfficerDefeated, 'defeated a Navy officer');
      }
      if (data.elite) return this.bounty.addBounty(BOUNTY_AWARDS.eliteEnemy, 'defeated ' + (data.name || 'an elite'));
      if (data.named) return this.bounty.addBounty(BOUNTY_AWARDS.namedEnemy, 'defeated ' + (data.name || data.kind));
      return null;
    }
    if (event === 'bossDefeated') {
      return this.bounty.addBounty(BOUNTY_AWARDS.boss, 'defeated ' + (data.name || data.id));
    }
    if (event === 'propDestroyed' && data.marineProperty) {
      return this.bounty.addBounty(BOUNTY_AWARDS.marineProperty, 'destroyed Navy property');
    }
    if (event === 'chestOpened' && data.navyGold) {
      return this.bounty.addBounty(BOUNTY_AWARDS.chestOfNavyGold, 'robbed a Navy strongbox');
    }
    if (event === 'fruitUsed' && data.seen && data.town) {
      return this.bounty.witnessedFruitUse(data.fruitId || 'devil', data.town);
    }
    return null;
  }

  /**
   * If every objective in the current step is satisfied, advance — completing the quest if
   * that was the last step. @returns {boolean} true if the quest completed
   */
  _settleStep(q, rec) {
    this.progressRevision++;
    const objs = q.steps[rec.step].objectives;
    for (let i = 0; i < objs.length; i++) if (!objectiveDone(objs[i], rec.obj[i])) return false;

    this._emit('stepComplete', { id: q.id, step: rec.step, text: q.steps[rec.step].text });
    if (rec.step < q.steps.length - 1) {
      rec.step++;
      rec.obj = q.steps[rec.step].objectives.map((o) => initObjectiveState(o));
      this._emit('stepStarted', { id: q.id, step: this._stepView(q, rec) });
      return false;
    }
    this._complete(q, rec);
    return true;
  }

  /** Finish a quest and pay it out. Guarded so a reward can never be granted twice. */
  _complete(q, rec) {
    rec.state = QUEST_STATE.DONE;
    rec.completedAt = this.time;
    if (this.trackedId === q.id) this.trackedId = null;
    this._grant(q);
    // Unlock dependants immediately: the next quest in a chain should light up as the
    // reward toast lands, not one simulation step later.
    this._refreshAvailability();
    this._emit('questComplete', {
      id: q.id, title: q.title, island: q.island,
      rewards: this.rewardSummary(q.id),
    });
  }

  /** Pay a quest's rewards exactly once. The guard lives on the record, never on the frozen spec. */
  _grant(q) {
    const rec = this.records.get(q.id);
    if (rec.rewarded) return;
    rec.rewarded = true;
    const r = q.rewards;

    if (r.berries) { this.berries += r.berries; this._emit('reward', { kind: 'berries', value: r.berries }); }
    if (r.xp) {
      this.xp += r.xp;
      const lv = levelForXp(this.xp);
      this._emit('reward', { kind: 'xp', value: r.xp });
      if (lv > this.level) { this.level = lv; this._emit('levelUp', { level: lv }); }
    }
    if (r.bounty) {
      const res = this.bounty.addBounty(r.bounty, 'the ' + q.title + ' affair');
      this._emit('reward', { kind: 'bounty', value: r.bounty });
      if (res.tierChanged) this._emit('bountyTier', { tier: res.tier.id, name: res.tier.name, total: res.newTotal });
    }
    if (r.item) {
      this.items.set(r.item, (this.items.get(r.item) || 0) + 1);
      this._emit('reward', { kind: 'item', value: r.item, name: ITEMS[r.item] || r.item });
    }
    if (r.crew && !this.crewRoster.has(r.crew)) {
      this.crewRoster.recruit(r.crew, this.time);
      const m = CREW_BY_ID.get(r.crew);
      this._emit('crewJoined', { id: r.crew, name: m.name, role: m.role, line: m.joinLine });
    }
    if (r.fruit && !this.fruits.has(r.fruit)) {
      this.fruits.add(r.fruit);
      this._emit('fruitUnlocked', { id: r.fruit });
    }
    if (r.shipUpgrade && !this.shipUpgradeSet.has(r.shipUpgrade)) {
      this.shipUpgradeSet.add(r.shipUpgrade);
      const u = SHIP_UPGRADES[r.shipUpgrade];
      this._emit('shipUpgrade', { id: r.shipUpgrade, name: u ? u.name : r.shipUpgrade, effect: u ? u.effect : {} });
    }
    if (r.mapFragment && !this.mapFragmentSet.has(r.mapFragment)) {
      this.mapFragmentSet.add(r.mapFragment);
      this._emit('mapFragment', { id: r.mapFragment, name: MAP_FRAGMENTS[r.mapFragment] || r.mapFragment });
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  _stepView(q, rec) {
    const s = q.steps[rec.step];
    return {
      index: rec.step,
      count: q.steps.length,
      text: s.text,
      objectives: s.objectives.map((o, i) => objectiveProgress(o, rec.obj[i])),
    };
  }

  /** Quests currently in the log. @returns {object[]} */
  activeQuests() {
    const out = [];
    for (const q of QUESTS) {
      const rec = this.records.get(q.id);
      if (rec.state !== QUEST_STATE.ACTIVE) continue;
      out.push({
        id: q.id, title: q.title, island: q.island, islandName: ISLAND_NAMES[q.island],
        giver: q.giver, giverName: NPC_BY_ID.has(q.giver) ? NPC_BY_ID.get(q.giver).name : q.giver,
        summary: q.summary, tracked: this.trackedId === q.id, step: this._stepView(q, rec),
      });
    }
    return out;
  }

  /** Quests that can be accepted right now. @returns {object[]} */
  availableQuests() {
    const out = [];
    for (const q of QUESTS) {
      const rec = this.records.get(q.id);
      if (rec.state !== QUEST_STATE.AVAILABLE) continue;
      const npc = NPC_BY_ID.get(q.giver);
      out.push({
        id: q.id, title: q.title, island: q.island, islandName: ISLAND_NAMES[q.island],
        giver: q.giver, giverName: npc ? npc.name : q.giver,
        giverSpawn: npc ? npc.spawn : null, summary: q.summary,
      });
    }
    return out;
  }

  /**
   * The full journal: every quest, grouped by island, with state and progress.
   * Locked quests are listed by island only — never by title, so nothing spoils.
   * @returns {object[]} one entry per island
   */
  questLog() {
    return ISLANDS.map((island) => {
      const entries = CHAINS[island].map((id) => {
        const q = QUEST_BY_ID.get(id);
        const rec = this.records.get(id);
        const known = rec.state !== QUEST_STATE.LOCKED;
        return {
          id,
          state: rec.state,
          title: known ? q.title : 'Not yet known',
          summary: known ? q.summary : '',
          giverName: known && NPC_BY_ID.has(q.giver) ? NPC_BY_ID.get(q.giver).name : '',
          step: rec.state === QUEST_STATE.ACTIVE ? this._stepView(q, rec) : null,
          rewards: known ? this.rewardSummary(id) : [],
          completedAt: rec.completedAt,
        };
      });
      const done = entries.filter((e) => e.state === QUEST_STATE.DONE).length;
      return {
        island, name: ISLAND_NAMES[island], visited: this.visited.has(island),
        done, total: entries.length, complete: done === entries.length, quests: entries,
      };
    });
  }

  /** The quest the HUD points at, or null. @returns {object|null} */
  trackedQuest() {
    if (this.trackedId) {
      const rec = this.records.get(this.trackedId);
      if (rec && rec.state === QUEST_STATE.ACTIVE) {
        const q = QUEST_BY_ID.get(this.trackedId);
        return {
          id: q.id, title: q.title, island: q.island, summary: q.summary, step: this._stepView(q, rec),
        };
      }
      this.trackedId = null;
    }
    const active = this.activeQuests();
    if (!active.length) return null;
    this.trackedId = active[0].id;
    return active[0];
  }

  /** Point the HUD at a specific active quest. @returns {boolean} */
  track(id) {
    const rec = this.records.get(id);
    if (!rec || rec.state !== QUEST_STATE.ACTIVE) return false;
    this.trackedId = id;
    return true;
  }

  /** Human-readable reward list for a quest. @returns {string[]} */
  rewardSummary(id) {
    const q = QUEST_BY_ID.get(id);
    if (!q) return [];
    const out = [];
    for (const k of Object.keys(q.rewards)) {
      const v = q.rewards[k];
      if (!v) continue;
      out.push(rewardLabel(k, v));
    }
    return out;
  }

  /** Has this devil fruit been earned? @returns {boolean} */
  isUnlocked(fruitId) { return this.fruits.has(fruitId); }

  /** Every fruit earned so far, in the canonical order. @returns {string[]} */
  unlockedFruits() { return FRUITS.filter((f) => this.fruits.has(f)); }

  /** Full crew records. @returns {object[]} */
  crew() { return this.crewRoster.roster(); }

  /** The flat passive-bonus object every other system reads. @returns {object} */
  activeBonuses() { return this.crewRoster.activeBonuses(); }

  /** Flat bounty snapshot for spawners, shops, npcs and the mixer. @returns {object} */
  bountyState() { return this.bounty.state(); }

  /** How an npc kind behaves toward the player right now. @returns {string} */
  reactionTo(npcKind) { return this.bounty.reactionTo(npcKind); }

  /** An ambient line for an npc, using the dedicated bark stream. @returns {string} */
  barkFor(npcId) {
    const npc = NPC_BY_ID.get(npcId);
    return barkFor(npcId, this.bounty.reactionTo(npc ? npc.kind : 'villager'), this.barkRng);
  }

  /** Ship upgrades earned, with their numeric effects merged. @returns {object} */
  shipUpgrades() {
    const ids = Array.from(this.shipUpgradeSet);
    const effect = {};
    for (const id of ids) {
      const u = SHIP_UPGRADES[id];
      if (!u) continue;
      for (const k of Object.keys(u.effect)) {
        const v = u.effect[k];
        effect[k] = k.endsWith('Mult') ? (effect[k] || 1) * v : (effect[k] || 0) + v;
      }
    }
    return { ids, effect };
  }

  /** Map fragments collected, out of the full set. @returns {{have:string[], total:number}} */
  mapFragments() {
    return { have: Array.from(this.mapFragmentSet), total: Object.keys(MAP_FRAGMENTS).length };
  }

  /** Player progression readout. @returns {object} */
  progression() {
    const lp = levelProgress(this.xp);
    return { berries: this.berries, xp: this.xp, level: lp.level, xpInto: lp.into, xpNeed: lp.need, xpRatio: lp.ratio };
  }

  /** Snapshot used by dialogue `when` gates. @returns {object} */
  dialogueContext() {
    return {
      bountyTier: this.bounty.tierIndex(),
      crew: this.crewRoster.members.map((m) => m.id),
      fruits: this.unlockedFruits(),
      questsDone: QUESTS.filter((q) => this.records.get(q.id).state === QUEST_STATE.DONE).map((q) => q.id),
      questsActive: QUESTS.filter((q) => this.records.get(q.id).state === QUEST_STATE.ACTIVE).map((q) => q.id),
      flags: this.flags,
    };
  }

  /**
   * Build a conversation with an npc: quest business first, otherwise a bounty-flavoured
   * ambient line. Always returns something for a registered npc, so the UI has one entry point.
   * @param {string} npcId
   * @returns {{quest:object|null, tree:object, runner:DialogueRunner}|null}
   */
  converse(npcId) {
    for (const q of QUESTS) {
      if (q.giver !== npcId) continue;
      const rec = this.records.get(q.id);
      if (rec.state === QUEST_STATE.AVAILABLE) return this.offer(q.id);
      if (rec.state === QUEST_STATE.ACTIVE) {
        const tree = makeQuestDialogue(q, 'active');
        return { quest: q, tree, runner: new DialogueRunner(tree, this.dialogueContext()) };
      }
      if (rec.state === QUEST_STATE.DONE && !rec.thanked) {
        rec.thanked = true;
        const tree = makeQuestDialogue(q, 'turnIn');
        return { quest: q, tree, runner: new DialogueRunner(tree, this.dialogueContext()) };
      }
    }
    // No quest business: they still say something, and what they say depends on your bounty.
    const person = NPC_BY_ID.get(npcId);
    if (!person) return null;
    const tree = makeTree(npcId + ':ambient', 'a', {
      a: { name: person.name, kind: person.kind, portraitOf: npcId, lines: [this.barkFor(npcId)] },
    });
    return { quest: null, tree, runner: new DialogueRunner(tree, this.dialogueContext()) };
  }

  _emit(kind, data) {
    this._out.push(Object.assign({ kind }, data));
    if (this._out.length > 96) this._out.shift();
  }

  /** Drain queued UI/audio events. @returns {object[]} */
  drainEvents() {
    const e = this._out;
    this._out = [];
    return e;
  }

  // -------------------------------------------------------------------------
  // Save / load  (ARCHITECTURE §7)
  // -------------------------------------------------------------------------

  /** @returns {object} a plain JSON-safe object; round-trips exactly through deserialize */
  serialize() {
    const quests = {};
    for (const q of QUESTS) {
      const rec = this.records.get(q.id);
      // A never-started quest is fully reconstructible from the spec — do not store it.
      if (rec.state === QUEST_STATE.LOCKED || (rec.state === QUEST_STATE.AVAILABLE && !rec.offered)) continue;
      quests[q.id] = {
        state: rec.state,
        step: rec.step,
        obj: q.steps[rec.step].objectives.map((o, i) => serializeObjective(o, rec.obj[i])),
        rewarded: rec.rewarded,
        offered: rec.offered,
        thanked: !!rec.thanked,
        startedAt: rec.startedAt,
        completedAt: rec.completedAt,
      };
    }
    return {
      v: 1,
      seed: this.seed,
      time: Math.round(this.time * 100) / 100,
      quests,
      crew: this.crewRoster.serialize(),
      bounty: this.bounty.serialize(),
      berries: this.berries,
      xp: this.xp,
      fruits: this.unlockedFruits(),
      shipUpgrades: Array.from(this.shipUpgradeSet),
      mapFragments: Array.from(this.mapFragmentSet),
      items: Array.from(this.items.entries()).map(([k, n]) => [k, n]),
      visited: Array.from(this.visited),
      tracked: this.trackedId,
      flags: Object.assign({}, this.flags),
    };
  }

  /** Restore from serialize(). Unknown quest ids are dropped, not fatal. @returns {this} */
  deserialize(o) {
    if (!o) return this;
    this.time = o.time || 0;
    this.berries = o.berries | 0;
    this.xp = o.xp | 0;
    this.level = levelForXp(this.xp);

    for (const q of QUESTS) this.records.set(q.id, this._blankRecord(q));
    const src = o.quests || {};
    for (const id of Object.keys(src)) {
      const q = QUEST_BY_ID.get(id);
      if (!q) continue;
      const raw = src[id];
      const stepIdx = Math.min(q.steps.length - 1, Math.max(0, raw.step | 0));
      const objs = q.steps[stepIdx].objectives;
      this.records.set(id, {
        id,
        state: raw.state || QUEST_STATE.AVAILABLE,
        step: stepIdx,
        obj: objs.map((spec, i) => deserializeObjective(spec, raw.obj && raw.obj[i])),
        rewarded: !!raw.rewarded,
        offered: !!raw.offered,
        thanked: !!raw.thanked,
        startedAt: raw.startedAt === undefined ? -1 : raw.startedAt,
        completedAt: raw.completedAt === undefined ? -1 : raw.completedAt,
      });
    }

    this.crewRoster.deserialize(o.crew);
    this.bounty.deserialize(o.bounty);

    this.fruits = new Set(Array.isArray(o.fruits) ? o.fruits : []);
    this.shipUpgradeSet = new Set(Array.isArray(o.shipUpgrades) ? o.shipUpgrades : []);
    this.mapFragmentSet = new Set(Array.isArray(o.mapFragments) ? o.mapFragments : []);
    this.items = new Map(Array.isArray(o.items) ? o.items : []);
    this.visited = new Set(Array.isArray(o.visited) ? o.visited : []);
    this.flags = Object.assign({}, o.flags || {});
    this.trackedId = o.tracked || null;

    // Availability is derived from prerequisites, so it is never stored — recompute it,
    // silently, or every quest the player had already unlocked would re-announce itself.
    this._refreshAvailability(true);
    this._out = [];
    return this;
  }
}

export default QuestSystem;
