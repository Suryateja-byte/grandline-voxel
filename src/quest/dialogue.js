// Dialogue — named people, what they say, and how a conversation runs.
//
// This is deliberately *not* a cutscene system. A conversation is: a face, one to three lines,
// and at most one choice that changes what you are about to go do. Story happens in the doing.
//
// The npc registry lives here rather than in quests.js because the world needs to place these
// people (each one owns a spawn point) whether or not their quest is active, and the character
// owner needs their portrait spec. Portrait fields are P.* palette references only.

import { P } from '../gen/palette.js';
import { Rng } from '../core/rng.js';

/**
 * @typedef {object} Npc
 * @property {string} id           dotted id, `${island}.${shortName}`
 * @property {string} name         display name
 * @property {string} kind         reaction class, see bounty.js REACTION_BY_KIND
 * @property {string} island       island id
 * @property {string} spawn        spawn point name on that island
 * @property {object} portrait     paintFace-compatible spec, colours from P.*
 * @property {string[]} idle       ambient lines used when they have nothing quest-related to say
 */

const npc = (id, name, kind, island, spawn, portrait, idle) =>
  Object.freeze({ id, name, kind, island, spawn, portrait: Object.freeze(portrait), idle: Object.freeze(idle) });

/** Every named npc in the game, keyed by id. One per island spawn point npc_1..npc_4. */
export const NPCS = Object.freeze([
  // --- Shells Cove: a fishing village that has stopped fishing -------------------
  npc('shellsCove.mira', 'Mira Coquina', 'villager', 'shellsCove', 'npc_1',
    { skin: P.skinTan, hair: P.hairBrown, outfit: P.heroCyan, accent: P.rope, eye: 'open', mouth: 'flat', scar: 'none' },
    ['The nets keep coming up cut. Not torn. Cut.',
     'My father built this dock. I would rather not watch it burn.']),
  npc('shellsCove.tobin', 'Tobin Reef', 'child', 'shellsCove', 'npc_2',
    { skin: P.skin, hair: P.hairBlonde, outfit: P.heroGold, accent: P.heroRed, eye: 'happy', mouth: 'grin', scar: 'none', blush: true },
    ['Are you a pirate? A real one? With a flag?',
     'I can hold my breath for a whole minute. Nearly.']),
  npc('shellsCove.pell', 'Pell Marren', 'villager', 'shellsCove', 'npc_3',
    { skin: P.skinTan, hair: P.hairGinger, outfit: P.heroGold, accent: P.heroRed, eye: 'sly', mouth: 'grin', scar: 'cheek' },
    ['Sixty paces to that post. I could put a stone through the knot.',
     'Nothing worth shooting on this island. That is the whole problem.']),
  npc('shellsCove.harl', 'Harl Dunnage', 'merchant', 'shellsCove', 'npc_4',
    { skin: P.skinLo, hair: P.hairWhite, outfit: P.wood, accent: P.gold, eye: 'sly', mouth: 'flat', scar: 'none' },
    ['Prices are what they are. Blame the men on the headland.',
     'Rope, salt, bandages. In that order, usually.']),

  // --- Palm Reach: a canopy that swallowed an expedition -------------------------
  npc('palmReach.ines', 'Ines Quill', 'scholar', 'palmReach', 'npc_1',
    { skin: P.skinPale, hair: P.hair, outfit: P.uiWhite, accent: P.jungle, eye: 'open', mouth: 'flat', scar: 'none' },
    ['Eleven went up the canopy road. The chart says nothing came down.',
     'I am not brave. I am thorough. They are different.']),
  npc('palmReach.ferra', 'Ferra Yune', 'villager', 'palmReach', 'npc_2',
    { skin: P.skinDark, hair: P.hairGreen, outfit: P.jungle, accent: P.rope, eye: 'open', mouth: 'flat', scar: 'eye' },
    ['Do not look up when it goes quiet. Look behind.',
     'I have been down here four months. The trees have not forgotten me.']),
  npc('palmReach.moss', 'Moss Tanaba', 'barkeep', 'palmReach', 'npc_3',
    { skin: P.skinTan, hair: P.hairBrown, outfit: P.plank, accent: P.thatch, eye: 'happy', mouth: 'smile', scar: 'none' },
    ['Drink is free for anyone going up. Nobody comes back to pay.',
     'The heat up there is not weather. Bear that in mind.']),
  npc('palmReach.wren', 'Wren Alo', 'child', 'palmReach', 'npc_4',
    { skin: P.skinDark, hair: P.hairSoft, outfit: P.fruitZushi, accent: P.heroGold, eye: 'shock', mouth: 'open', scar: 'none', blush: true },
    ['There is a light in the canopy at night. Orange. It moves.',
     'Mum says the trees eat people. Mum says a lot of things.']),

  // --- Cog Harbour: a shipyard with a lie in its keels ---------------------------
  npc('cogHarbour.odd', 'Odd Bracken', 'shipwright', 'cogHarbour', 'npc_1',
    { skin: P.skinLo, hair: P.hairWhite, outfit: P.wood, accent: P.metal, eye: 'angry', mouth: 'flat', scar: 'none' },
    ['Every keel in slip three is two bolts short. I signed for all of them.',
     'A ship that sinks on schedule is not an accident. It is a business.']),
  npc('cogHarbour.voss', 'Inspector Voss Callar', 'marine_officer', 'cogHarbour', 'npc_2',
    { skin: P.skin, hair: P.hairSoft, outfit: P.marineWhite, accent: P.marineBlue, eye: 'sly', mouth: 'smile', scar: 'none' },
    ['The Navy thanks Cog Harbour for its cooperation. As always.',
     'Paperwork is the quietest kind of weapon.']),
  npc('cogHarbour.lys', 'Lys Auger', 'merchant', 'cogHarbour', 'npc_3',
    { skin: P.skinDark, hair: P.hairGinger, outfit: P.heroCyan, accent: P.gold, eye: 'open', mouth: 'smile', scar: 'none' },
    ['Chandlery, top of the ramp. I stock what the yard will not admit it needs.',
     'Buy the good rope. You will only learn this once.']),
  npc('cogHarbour.gil', 'Gil Tumm', 'child', 'cogHarbour', 'npc_4',
    { skin: P.skinTan, hair: P.hairBrown, outfit: P.barrel, accent: P.metalDark, eye: 'happy', mouth: 'grin', scar: 'none' },
    ['I count the crates. Nobody asked me to. I just count them.',
     'Slip three gets a night delivery. Every eighth day.']),

  // --- Drum Peaks: a snowline, a fever, and a climb ------------------------------
  npc('drumPeaks.sena', 'Sena Brill', 'doctor', 'drumPeaks', 'npc_1',
    { skin: P.skinPale, hair: P.hairBrown, outfit: P.uiWhite, accent: P.fruitHie, eye: 'open', mouth: 'smile', scar: 'none' },
    ['I have three remedies and none of them are the one she needs.',
     'The flower grows above the treeline. So does everything that eats climbers.']),
  npc('drumPeaks.nel', 'Nel Hess', 'villager', 'drumPeaks', 'npc_2',
    { skin: P.skinPale, hair: P.hairGinger, outfit: P.grassCold, accent: P.wood, eye: 'open', mouth: 'flat', scar: 'none' },
    ['She was running up that path a week ago. A week.',
     'I cannot make the climb. I have tried twice. I will try a third time.']),
  npc('drumPeaks.ivo', 'Ivo Hess', 'child', 'drumPeaks', 'npc_3',
    { skin: P.skinPale, hair: P.hairGinger, outfit: P.uiWhite, accent: P.ice, eye: 'happy', mouth: 'smile', scar: 'none', blush: true },
    ['I am not scared. I am cold. There is a difference.',
     'When I am better I am going to the top. All the way.']),
  npc('drumPeaks.kessel', 'Kessel Roan', 'villager', 'drumPeaks', 'npc_4',
    { skin: P.skinDark, hair: P.hair, outfit: P.rockCold, accent: P.rope, eye: 'angry', mouth: 'flat', scar: 'cheek' },
    ['Above the second ridge the wind takes your voice. Use the rope line.',
     'The Warden is not a story. I have seen its tracks twice.']),

  // --- Emberfall: a forge above a living caldera ---------------------------------
  npc('emberfall.vulca', 'Vulca Ord', 'villager', 'emberfall', 'npc_1',
    { skin: P.skinDark, hair: P.hairWhite, outfit: P.volcanicRock, accent: P.lava, eye: 'angry', mouth: 'flat', scar: 'cross' },
    ['The mountain gives me heat and takes my apprentices. Fair trade, it thinks.',
     'Steel does not lie. That is why I stopped talking to people.']),
  npc('emberfall.basil', 'Basil Ord', 'villager', 'emberfall', 'npc_2',
    { skin: P.skinTan, hair: P.hair, outfit: P.sail, accent: P.lava, eye: 'happy', mouth: 'grin', scar: 'cheek' },
    ['My brother forges. I feed the people who survive him.',
     'Ash in the bread. Traditional. Do not make a face.']),
  npc('emberfall.tamm', 'Tamm Cinder', 'villager', 'emberfall', 'npc_3',
    { skin: P.skinLo, hair: P.hairSoft, outfit: P.ash, accent: P.lavaHot, eye: 'open', mouth: 'flat', scar: 'none' },
    ['The valves keep the caldera breathing. Three are stuck.',
     'When the ground hums, you have four breaths to be somewhere else.']),
  npc('emberfall.rekka', 'Rekka Sool', 'merchant', 'emberfall', 'npc_4',
    { skin: P.skin, hair: P.hairGinger, outfit: P.heroRed, accent: P.gold, eye: 'sly', mouth: 'smile', scar: 'none' },
    ['Fireproof rope. Twice the price, half the funerals.',
     'I sell to whoever walks back out. Statistically, that is a small market.']),

  // --- Whisper Sands: a city under the dunes, and the lie above it ---------------
  npc('whisperSands.nia', 'Nia Sarrow', 'villager', 'whisperSands', 'npc_1',
    { skin: P.skin, hair: P.hairBlonde, outfit: P.heroCyan, accent: P.fruitSuna, eye: 'sly', mouth: 'smile', scar: 'none' },
    ['Every chart of this coast is wrong. I know because I drew four of them.',
     'The dunes move at night. So does the city under them.']),
  npc('whisperSands.sabek', 'Sabek Turr', 'scholar', 'whisperSands', 'npc_2',
    { skin: P.skinDark, hair: P.hairWhite, outfit: P.paper, accent: P.fruitSunaDark, eye: 'open', mouth: 'flat', scar: 'none' },
    ['My family guarded a door for nine generations. I would like to see behind it.',
     'The mirages are not tricks of heat. They are instructions.']),
  npc('whisperSands.hara', 'Hara Dune', 'bandit', 'whisperSands', 'npc_3',
    { skin: P.skinTan, hair: P.hair, outfit: P.bandit, accent: P.heroRed, eye: 'angry', mouth: 'snarl', scar: 'eye' },
    ['I robbed six caravans and never found the road they came from.',
     'You want the buried city? Bring water and a short memory.']),
  npc('whisperSands.pip', 'Pip Sarrow', 'child', 'whisperSands', 'npc_4',
    { skin: P.skin, hair: P.hairBlonde, outfit: P.sand, accent: P.heroCyan, eye: 'shock', mouth: 'open', scar: 'none', blush: true },
    ['My sister says the sand sings. I only ever hear it humming.',
     'If you find a well down there, tell me. We are down to one.']),

  // --- Blossom Terrace: nine rungs of a duelling ladder --------------------------
  npc('blossomTerrace.ohana', 'Ohana Beki', 'villager', 'blossomTerrace', 'npc_1',
    { skin: P.skinPale, hair: P.hair, outfit: P.cherryBlossom, accent: P.ink, eye: 'open', mouth: 'smile', scar: 'none' },
    ['I keep the ledger. Nine rungs, nine names, and one that has not moved in eleven years.',
     'Challenge in order. Skip a rung and the terrace closes to you.']),
  npc('blossomTerrace.goro', 'Goro Tsai', 'pirate', 'blossomTerrace', 'npc_2',
    { skin: P.skinTan, hair: P.hairGreen, outfit: P.pirateMaroon, accent: P.gold, eye: 'angry', mouth: 'snarl', scar: 'cheek' },
    ['Third rung. Held it two years. I intend to hold it two more.',
     'They say you hit hard. They said that about the last one too.']),
  npc('blossomTerrace.sen', 'Sen Ishiba', 'villager', 'blossomTerrace', 'npc_3',
    { skin: P.skinPale, hair: P.hairSoft, outfit: P.pirateBlack, accent: P.cherryBlossom, eye: 'angry', mouth: 'flat', scar: 'cross' },
    ['Ninth rung. Nobody has climbed past me. Nobody has tried properly either.',
     'Winning here means nothing. That is the part they never write down.']),
  npc('blossomTerrace.mei', 'Mei Roku', 'child', 'blossomTerrace', 'npc_4',
    { skin: P.skinTan, hair: P.hairBrown, outfit: P.grass, accent: P.cherryBlossom, eye: 'happy', mouth: 'grin', scar: 'none', blush: true },
    ['Tea before a duel, tea after. I sell more after.',
     'Nobody ever beats Sen. I have watched forty-one people not beat Sen.']),

  // --- Marineford Reach: the wall at the end of the arc --------------------------
  npc('marinefordReach.ansel', 'Cadet Ansel Rook', 'marine', 'marinefordReach', 'npc_1',
    { skin: P.skin, hair: P.hairBlonde, outfit: P.marineWhite, accent: P.marineBlue, eye: 'shock', mouth: 'flat', scar: 'none' },
    ['I signed up to stop pirates. Nobody mentioned the cells under the parade ground.',
     'Shift change is on the seventh bell. That is all I can give you.']),
  npc('marinefordReach.yoro', 'Captain Yoro Bell', 'pirate', 'marinefordReach', 'npc_2',
    { skin: P.skinDark, hair: P.hairWhite, outfit: P.pirateMaroon, accent: P.gold, eye: 'sly', mouth: 'grin', scar: 'eye' },
    ['Eight years in this box. I have counted every rivet twice.',
     'The Admiral fights like paperwork. Slow, total, and it never forgets.']),
  npc('marinefordReach.hobb', 'Petty Officer Dane Hobb', 'marine', 'marinefordReach', 'npc_3',
    { skin: P.skinLo, hair: P.hair, outfit: P.marineNavy, accent: P.metal, eye: 'angry', mouth: 'flat', scar: 'cheek' },
    ['Quartermaster. Everything on this rock passes my hands eventually.',
     'You are not on my manifest. I do not like things off the manifest.']),
  npc('marinefordReach.vale', 'Vice Admiral Corrin Vale', 'marine_officer', 'marinefordReach', 'npc_4',
    { skin: P.skinPale, hair: P.hairSoft, outfit: P.marineWhite, accent: P.marineNavy, eye: 'angry', mouth: 'flat', scar: 'cross' },
    ['The Admiral will see you. That is not the good news you think it is.',
     'Every pirate arrives certain. They leave in a different mood.']),
]);

export const NPC_BY_ID = Object.freeze(new Map(NPCS.map((n) => [n.id, n])));

/** All npcs stationed on an island, in spawn-point order. @returns {Npc[]} */
export function npcsOn(islandId) {
  return NPCS.filter((n) => n.island === islandId);
}

// ---------------------------------------------------------------------------
// Ambient barks, keyed by the reaction bounty.js hands back.
// ---------------------------------------------------------------------------

export const AMBIENT_BARKS = Object.freeze({
  friendly: Object.freeze([
    'Fair winds to you.',
    'You are the one who helped out on the point. Word gets around.',
    'Take the left path. The right one floods.',
    'Come by later. There will be food.',
  ]),
  wary: Object.freeze([
    'I saw your poster. Smaller in person.',
    'No trouble here. Understood?',
    'Keep walking and we will both have a good day.',
    'I am not going to ask what you are doing.',
  ]),
  afraid: Object.freeze([
    'Please. I have children.',
    'Take it. Take whatever it is. Just go.',
    'I never saw you. I never saw anyone.',
    'Do not look at me. Do not look at me.',
  ]),
  hostile: Object.freeze([
    'Halt. In the name of the Navy.',
    'That is a wanted face. Sound the bell.',
    'You picked the wrong harbour, pirate.',
    'Hands where I can see them.',
  ]),
  starstruck: Object.freeze([
    'That is really you. That is really actually you.',
    'My brother owes me twenty beli. He said you were made up.',
    'Say something I can repeat. Please.',
    'I am going to be you when I am bigger.',
  ]),
});

/** Kind-specific overrides, used before the generic pool. */
const KIND_BARKS = Object.freeze({
  marine: Object.freeze({
    wary: ['Move along. This is a Navy dock.', 'Name and manifest, if you please.'],
    hostile: ['Bounty confirmed. Take him.', 'All units, wanted man on the quay.'],
  }),
  child: Object.freeze({
    starstruck: ['Do the thing! Do the arm thing!', 'Is it true you fought a mountain?'],
    friendly: ['Are those real scars or drawn on?', 'Can I hold your hat? Just for a bit.'],
  }),
  merchant: Object.freeze({
    wary: ['Cash up front today, I am afraid.', 'Prices went up. You know why.'],
    afraid: ['Everything is free. Everything. Please leave.'],
  }),
  crew: Object.freeze({
    friendly: ['Orders, captain?', 'Ship is ready when you are.', 'Say the word.'],
  }),
});

/**
 * Pick an ambient line for an npc. Deterministic: same rng state, same line.
 * @param {string} npcId
 * @param {string} reaction one of REACTIONS
 * @param {Rng} rng a stream owned by the caller
 * @returns {string}
 */
export function barkFor(npcId, reaction, rng) {
  const person = NPC_BY_ID.get(npcId);
  const kind = person ? person.kind : 'villager';
  const kindPool = KIND_BARKS[kind] && KIND_BARKS[kind][reaction];
  if (kindPool && rng.chance(0.6)) return rng.pick(kindPool);
  // Friendly npcs with nothing to fear fall back to their own written idle lines.
  if (reaction === 'friendly' && person && person.idle.length && rng.chance(0.5)) return rng.pick(person.idle);
  return rng.pick(AMBIENT_BARKS[reaction] || AMBIENT_BARKS.friendly);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Evaluate a declarative gate. Keeping conditions as data (not closures) means dialogue
 * trees stay serialisable and inspectable by the harness.
 * @param {object|null} when { minTier, maxTier, hasCrew, hasFruit, questDone, questActive, flag }
 * @param {object} ctx { bountyTier, crew:string[], fruits:string[], questsDone:string[], questsActive:string[], flags:object }
 * @returns {boolean}
 */
export function evalWhen(when, ctx) {
  if (!when) return true;
  if (when.minTier !== undefined && (ctx.bountyTier || 0) < when.minTier) return false;
  if (when.maxTier !== undefined && (ctx.bountyTier || 0) > when.maxTier) return false;
  if (when.hasCrew && (ctx.crew || []).indexOf(when.hasCrew) < 0) return false;
  if (when.hasFruit && (ctx.fruits || []).indexOf(when.hasFruit) < 0) return false;
  if (when.questDone && (ctx.questsDone || []).indexOf(when.questDone) < 0) return false;
  if (when.questActive && (ctx.questsActive || []).indexOf(when.questActive) < 0) return false;
  if (when.flag && !(ctx.flags && ctx.flags[when.flag])) return false;
  if (when.notFlag && ctx.flags && ctx.flags[when.notFlag]) return false;
  return true;
}

/**
 * A dialogue tree. Nodes hold 1–3 lines and either a `next` or a set of `choices`.
 * @typedef {object} DialogueTree
 * @property {string} id
 * @property {string} start
 * @property {Object<string, object>} nodes
 */

/** Build a tree from plain data, validating that every edge lands somewhere. */
export function makeTree(id, start, nodes) {
  for (const key of Object.keys(nodes)) {
    const n = nodes[key];
    if (n.next && !nodes[n.next]) throw new Error(id + ': node ' + key + ' -> missing ' + n.next);
    if (n.choices) for (const c of n.choices) {
      if (c.next && !nodes[c.next]) throw new Error(id + ': choice in ' + key + ' -> missing ' + c.next);
    }
  }
  return Object.freeze({ id, start, nodes: Object.freeze(nodes) });
}

/**
 * Runs one conversation. The UI drives it with advance()/choose() and reads current();
 * QuestSystem drains `effects` afterwards. Holds no reference to the world.
 */
export class DialogueRunner {
  /**
   * @param {DialogueTree} tree
   * @param {object} ctx snapshot used by `when` gates (see evalWhen)
   */
  constructor(tree, ctx = {}) {
    this.tree = tree;
    this.ctx = ctx;
    this.nodeId = tree.start;
    this.line = 0;
    this.finished = false;
    /** @type {object[]} effects the caller must apply, e.g. { accept:'shellsCove.q1' } */
    this.effects = [];
    this._skipGated();
  }

  /** Skip past any node whose `when` gate fails, following its `else` or `next`. */
  _skipGated() {
    let guard = 0;
    while (!this.finished && guard++ < 32) {
      const n = this.tree.nodes[this.nodeId];
      if (!n) { this.finished = true; return; }
      if (evalWhen(n.when, this.ctx)) return;
      const to = n.else || n.next;
      if (!to) { this.finished = true; return; }
      this.nodeId = to;
      this.line = 0;
    }
  }

  /** @returns {object|null} the current line + choices, or null once finished */
  current() {
    if (this.finished) return null;
    const n = this.tree.nodes[this.nodeId];
    if (!n) return null;
    const last = this.line >= n.lines.length - 1;
    return {
      node: this.nodeId,
      name: n.name,
      kind: n.kind || 'villager',
      portraitOf: n.portraitOf || null,
      text: n.lines[this.line],
      lineIndex: this.line,
      lineCount: n.lines.length,
      // Choices only surface on the final line of a node — mid-speech menus read as a bug.
      choices: last && n.choices ? n.choices.filter((c) => evalWhen(c.when, this.ctx)).map((c, i) => ({ i, text: c.text })) : null,
      canAdvance: !last || !n.choices,
      done: false,
    };
  }

  /** Advance one line, or leave the node if this was its last. @returns {object|null} */
  advance() {
    if (this.finished) return null;
    const n = this.tree.nodes[this.nodeId];
    if (this.line < n.lines.length - 1) { this.line++; return this.current(); }
    if (n.choices) return this.current();   // waiting on a choice
    if (n.effect) this.effects.push(n.effect);
    if (!n.next) { this.finished = true; return null; }
    this.nodeId = n.next;
    this.line = 0;
    this._skipGated();
    return this.current();
  }

  /** Take choice `i` from the visible choice list. @returns {object|null} */
  choose(i) {
    if (this.finished) return null;
    const n = this.tree.nodes[this.nodeId];
    if (!n.choices) return this.current();
    const visible = n.choices.filter((c) => evalWhen(c.when, this.ctx));
    const c = visible[i];
    if (!c) return this.current();
    if (n.effect) this.effects.push(n.effect);
    if (c.effect) this.effects.push(c.effect);
    if (!c.next) { this.finished = true; return null; }
    this.nodeId = c.next;
    this.line = 0;
    this._skipGated();
    return this.current();
  }

  /** Drain accumulated effects. @returns {object[]} */
  takeEffects() {
    const e = this.effects;
    this.effects = [];
    return e;
  }

  get done() { return this.finished; }
}

/**
 * Build the standard offer / in-progress / hand-in conversation for a quest.
 * Every quest gets one for free; authored `quest.dialogue` supplies the words.
 * @param {object} quest a record from quests.js
 * @param {'offer'|'active'|'turnIn'} phase
 * @returns {DialogueTree}
 */
export function makeQuestDialogue(quest, phase) {
  const giver = NPC_BY_ID.get(quest.giver);
  const name = giver ? giver.name : quest.giverName || 'Stranger';
  const kind = giver ? giver.kind : 'villager';
  const d = quest.dialogue || {};
  const base = { name, kind, portraitOf: quest.giver };

  if (phase === 'active') {
    return makeTree(quest.id + ':active', 'a', {
      a: Object.assign({ lines: d.active && d.active.length ? d.active : ['Still time. Go on.'] }, base),
    });
  }
  if (phase === 'turnIn') {
    return makeTree(quest.id + ':turnIn', 'a', {
      a: Object.assign({ lines: d.turnIn, next: 'b' }, base),
      b: Object.assign({ lines: d.reward || ['Take this. You earned it twice over.'], effect: { complete: quest.id } }, base),
    });
  }
  return makeTree(quest.id + ':offer', 'a', {
    a: Object.assign({
      lines: d.offer,
      choices: [
        { text: d.acceptChoice || 'I will do it.', next: 'accept', effect: { accept: quest.id } },
        { text: d.declineChoice || 'Not right now.', next: 'decline', effect: { decline: quest.id } },
      ],
    }, base),
    accept: Object.assign({ lines: d.accept }, base),
    decline: Object.assign({ lines: d.decline || ['Then I will keep waiting. I am good at it.'] }, base),
  });
}

/** Convenience for headless tests and the harness: run a tree to the end, taking choice 0. */
export function walkTree(tree, ctx = {}, choiceIndex = 0) {
  const r = new DialogueRunner(tree, ctx);
  const lines = [];
  let guard = 0;
  while (!r.done && guard++ < 256) {
    const c = r.current();
    if (!c) break;
    lines.push(c.name + ': ' + c.text);
    if (c.choices && c.choices.length) r.choose(choiceIndex);
    else r.advance();
  }
  return { lines, effects: r.takeEffects() };
}

/** A dedicated rng stream for barks so dialogue never perturbs gameplay randomness. */
export function barkStream(seed) {
  return Rng.fromName(seed >>> 0, 'quest:barks');
}
