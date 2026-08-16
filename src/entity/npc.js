// Non-combat inhabitants: villagers, merchants, elders, crew ashore.
// Owner: Cluster B (character / rig / animation / camera).
//
// An Npc is an Actor with a small, readable behaviour set and a *reaction* channel that the
// bounty system drives. The reaction is the point of this file. A wanted level that only
// changes a number in the HUD is decoration; a wanted level that makes the fisherman stop
// mending his net, back away, and then run when you get close is a world reacting to you.
// ARCHITECTURE §9 already names the hook: `questSystem.reactionTo(npcKind)`.
//
// Every behaviour is deterministic: all timing and target choice comes from a per-NPC Rng
// stream seeded from (world seed, npc id), so the same seed replays the same village.

import { TAU } from '../core/math.js';
import { Rng, hashString } from '../core/rng.js';
import { Actor, ACTOR_STATE, MOVE } from './actor.js';

/** Crowd reactions, in order of how much the player has scared them. */
export const REACTIONS = Object.freeze(['friendly', 'wary', 'afraid', 'hostile', 'starstruck']);

/** Behaviours an NPC can be placed with. */
export const NPC_BEHAVIOUR = Object.freeze({
  IDLE: 'idle', WANDER: 'wander', SIT: 'sit', WORK: 'work', CHAT: 'chat', FLEE: 'flee', TALK: 'talk',
});

/**
 * Per-reaction behaviour parameters.
 *   look      metres within which the NPC turns to look at the player
 *   keep      preferred distance; below it the NPC backs off (0 = does not care)
 *   flee      distance within which the NPC runs; 0 = never flees
 *   approach  distance the NPC will close to on its own; 0 = stays put
 *   idle      which animation state the standing idle uses
 *   gesture   occasional one-shot gesture, or null
 */
const REACTION_CFG = Object.freeze({
  friendly: Object.freeze({
    look: 13, keep: 0, flee: 0, approach: 0, idle: 'idle', gesture: 'cheer', gestureP: 0.30,
  }),
  wary: Object.freeze({
    look: 20, keep: 6.5, flee: 0, approach: 0, idle: 'idle', gesture: null, gestureP: 0,
  }),
  afraid: Object.freeze({
    look: 26, keep: 12, flee: 13, approach: 0, idle: 'idle', gesture: null, gestureP: 0,
  }),
  hostile: Object.freeze({
    look: 24, keep: 0, flee: 0, approach: 11, idle: 'idle_combat', gesture: 'point', gestureP: 0.45,
  }),
  starstruck: Object.freeze({
    look: 30, keep: 0, flee: 0, approach: 8, idle: 'idle', gesture: 'point', gestureP: 0.75,
  }),
});

export class Npc extends Actor {
  /**
   * @param {object} app
   * @param {object|string} spec entry from CHARACTER_SPECS, or its id
   * @param {object} [opts] { npcId, kind, home:[x,z], leash, behaviour, partner, questMarker }
   */
  constructor(app, spec, opts = {}) {
    super(app, spec, Object.assign({ faction: 'town', maxHp: 40 }, opts));

    this.isNpc = true;
    /** Stable id used by the quest layer's dialogue table. */
    this.npcId = opts.npcId || this.id;
    /** Coarse kind the bounty system reacts by: villager, marine, pirate, merchant, child... */
    this.kind = opts.kind || this.spec.faction || 'villager';
    this.interactable = opts.interactable !== false;

    this.home = opts.home ? { x: opts.home[0], z: opts.home[1] } : { x: this.pos.x, z: this.pos.z };
    this.leash = opts.leash !== undefined ? opts.leash : 9;
    this.behaviour = opts.behaviour || NPC_BEHAVIOUR.IDLE;
    this.baseBehaviour = this.behaviour;
    /** The other half of a chat pair, if any. */
    this.partner = opts.partner || null;
    /** Shown by the HUD above this NPC. UI owns the marker art; this owns the flag. */
    this.questMarker = !!opts.questMarker;

    this.reaction = 'friendly';
    this.cfg = REACTION_CFG.friendly;

    // A stream per NPC so adding one villager never shifts another villager's schedule.
    this.brain = Rng.fromName((this.seed ^ hashString(this.npcId)) >>> 0, 'npc');
    this._timer = this.brain.range(0.4, 3.2);
    this._gestureT = this.brain.range(4, 14);
    this._talkTarget = null;
    this._fleeT = 0;
    this._chatTurn = this.brain.chance(0.5);
    this._chatT = this.brain.range(1.5, 4.0);
    this.footSfx = 'step_wood';
    this.combatReady = false;
  }

  /**
   * Crowd reaction API, driven by the bounty system.
   * Changes the idle animation, whether the NPC turns to face the player, whether it keeps its
   * distance, and whether it flees on approach.
   * @param {'friendly'|'wary'|'afraid'|'hostile'|'starstruck'} r
   */
  setReaction(r) {
    if (!REACTION_CFG[r] || r === this.reaction) return this;
    this.reaction = r;
    this.cfg = REACTION_CFG[r];
    this.combatReady = r === 'hostile';
    // A reaction change is a beat: the NPC breaks whatever it was doing and re-reads the room.
    if (this.behaviour === NPC_BEHAVIOUR.SIT && (r === 'afraid' || r === 'hostile')) {
      this.behaviour = NPC_BEHAVIOUR.IDLE;
    }
    this._timer = Math.min(this._timer, 0.35);
    this._gestureT = Math.min(this._gestureT, 1.2);
    return this;
  }

  /** Show or hide this NPC's quest marker. @param {boolean} v */
  setQuestMarker(v) { this.questMarker = !!v; return this; }

  /** Pair two NPCs into a conversation. Both get the CHAT behaviour and face each other. */
  chatWith(other) {
    this.partner = other;
    this.behaviour = NPC_BEHAVIOUR.CHAT;
    if (other) {
      other.partner = this;
      other.behaviour = NPC_BEHAVIOUR.CHAT;
      // One leads, one listens. Without this both mime the same beats and it reads as a bug.
      other._chatTurn = !this._chatTurn;
    }
    return this;
  }

  /** Enter the talk state, facing `who`. Held until endTalk(). */
  talkTo(who) {
    this._talkTarget = who || null;
    this.behaviour = NPC_BEHAVIOUR.TALK;
    this.stopMoving();
    this.setState(ACTOR_STATE.TALK, { force: true });
    return this;
  }

  /** Leave the talk state and go back to whatever this NPC was doing. */
  endTalk() {
    this._talkTarget = null;
    this.behaviour = this.baseBehaviour;
    this.setState(ACTOR_STATE.IDLE, { force: true });
    this._timer = this.brain.range(0.5, 2.0);
    return this;
  }

  /** Player interaction entry point; the Player's interact cone calls this. */
  onInteract(player, app) {
    this.talkTo(player);
    // The quest system registers as app.quests (game.js); app.quest is a compatibility alias.
    const quest = app && (app.quests || app.quest);
    if (quest && typeof quest.converse === 'function') {
      const conv = quest.converse(this.npcId);
      if (conv && conv.runner) this._runConversation(conv, app, quest);
      // Talk objectives progress only on this event, and nobody else emits it. The carried
      // quest items ride along so `deliver` objectives can complete on the hand-over.
      if (typeof quest.notify === 'function') {
        const carrying = quest.items && typeof quest.items.keys === 'function'
          ? Array.from(quest.items.keys()) : [];
        quest.notify('npcTalked', { npcId: this.npcId, kind: this.kind, carrying });
      }
    }
    if (app && app.signals) app.signals.npcTalk++;
    return this;
  }

  /**
   * Play a conversation returned by QuestSystem.converse. There is no dialogue panel yet, so
   * the lines surface as toasts and the FIRST choice of every branch is taken — which is the
   * accept branch on quest offers (see makeQuestDialogue), so quests are actually acceptable
   * through gameplay. Effects are applied through the quest system's own entry point.
   */
  _runConversation(conv, app, quest) {
    const r = conv.runner;
    const ui = app && app.ui;
    let cur = r.current();
    let guard = 0;
    let shown = 0;
    while (cur && guard++ < 48) {
      if (cur.text && ui && typeof ui.toast === 'function' && shown < 4) {
        ui.toast((cur.name ? cur.name + ': ' : '') + cur.text, 'info', 3.2 + shown * 1.1);
        shown++;
      }
      if (cur.choices && cur.choices.length) cur = r.choose(0);
      else if (cur.canAdvance) cur = r.advance();
      else break;
    }
    const effects = typeof r.takeEffects === 'function' ? r.takeEffects() : r.effects.splice(0);
    for (const e of effects) {
      if (quest && typeof quest.applyDialogueEffect === 'function') quest.applyDialogueEffect(e);
    }
    if (conv.quest && ui && typeof ui.toast === 'function') {
      const rec = effects.find((e) => e && e.accept);
      if (rec) ui.toast('Quest accepted: ' + conv.quest.title, 'quest');
    }
  }

  /** Refresh this NPC's reaction from the quest/bounty layer. Cheap; safe to call every step. */
  syncReaction(app) {
    const quest = app && (app.quests || app.quest);
    if (quest && typeof quest.reactionTo === 'function') {
      const r = quest.reactionTo(this.kind);
      if (r && REACTION_CFG[r]) this.setReaction(r);
    }
    return this;
  }

  /** Behaviour tick. Runs every step; the base class gates movement on the control lockout. */
  _control(dt, app) {
    if (this.lockT > 0) return;
    const player = app && app.player;
    let pd = Infinity, px = 0, pz = 0;
    if (player && player.pos) {
      px = player.pos.x; pz = player.pos.z;
      pd = Math.hypot(px - this.pos.x, pz - this.pos.z);
    }

    this._timer -= dt;
    this._gestureT -= dt;

    // --- reaction overrides ------------------------------------------------
    // Fleeing beats every other behaviour, and it persists for a moment after the player backs
    // off so the villager does not turn around the instant they are safe.
    if (this.cfg.flee > 0 && pd < this.cfg.flee) this._fleeT = 2.4;
    if (this._fleeT > 0) {
      this._fleeT -= dt;
      this._flee(px, pz);
      return;
    }

    // --- leash recovery -----------------------------------------------------
    // A villager who bolted 25 m up the beach and then stood there forever is worse than one
    // who never fled. Once the fright wears off, walk home.
    const homeD = Math.hypot(this.pos.x - this.home.x, this.pos.z - this.home.z);
    if (homeD > this.leash * 1.4 && this.behaviour !== NPC_BEHAVIOUR.TALK) {
      if (!this.navTarget) this.moveTo(this.home.x, this.home.z, MOVE.walk * this.hs, 1.2);
      this.strafing = false;
      this.setState(ACTOR_STATE.MOVE);
      super._control(dt, app);
      return;
    }

    switch (this.behaviour) {
      case NPC_BEHAVIOUR.TALK: this._doTalk(player); return;
      case NPC_BEHAVIOUR.SIT: this._doSit(pd, px, pz); return;
      case NPC_BEHAVIOUR.CHAT: this._doChat(dt, pd, px, pz); return;
      case NPC_BEHAVIOUR.WORK: this._doWork(dt, pd, px, pz); return;
      case NPC_BEHAVIOUR.WANDER: this._doWander(dt, pd, px, pz); return;
      case NPC_BEHAVIOUR.FLEE: this._flee(px, pz); return;
      default: this._doIdle(pd, px, pz);
    }
  }

  /** Run away from a point, staying on the leash's far side and re-picking a bolt-hole. */
  _flee(px, pz) {
    this.setState(ACTOR_STATE.MOVE);
    let dx = this.pos.x - px, dz = this.pos.z - pz;
    const l = Math.hypot(dx, dz);
    if (l < 1e-3) {
      const a = this.brain.f() * TAU;
      dx = Math.cos(a); dz = Math.sin(a);
    } else { dx /= l; dz /= l; }
    this.wishX = dx; this.wishZ = dz;
    this.wishSpeed = MOVE.run * this.hs * 0.95;
    this.strafing = false;
    this.navTarget = null;
  }

  /** Stand still, look at the player when they are close, gesture occasionally. */
  _doIdle(pd, px, pz) {
    this.strafing = true;
    if (pd < this.cfg.look) this.facePoint(px, pz);
    else if (this._timer <= 0) {
      // A villager that never turns reads as furniture. Pick a new heading now and then.
      this.targetYaw = this.brain.range(-Math.PI, Math.PI);
      this._timer = this.brain.range(3.0, 8.0);
    }

    // Wary NPCs back away rather than fleeing: they keep working, just not near you.
    if (this.cfg.keep > 0 && pd < this.cfg.keep) {
      const dx = this.pos.x - px, dz = this.pos.z - pz;
      const l = Math.hypot(dx, dz) || 1;
      this.wishX = dx / l; this.wishZ = dz / l;
      this.wishSpeed = MOVE.walk * this.hs * 0.8;
      return;
    }
    // Hostile and starstruck close the distance instead — one to threaten, one to gawk.
    if (this.cfg.approach > 0 && pd > this.cfg.approach * 0.5 && pd < this.cfg.approach * 2.2) {
      const dx = px - this.pos.x, dz = pz - this.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      this.wishX = dx / l; this.wishZ = dz / l;
      this.wishSpeed = MOVE.walk * this.hs * (this.reaction === 'hostile' ? 1.0 : 0.75);
      return;
    }

    if (this._gestureT <= 0) {
      this._gestureT = this.brain.range(5, 15);
      if (this.cfg.gesture && this.brain.chance(this.cfg.gestureP) && pd < this.cfg.look) {
        const anim = this.cfg.gesture;
        this.setState(anim === 'cheer' ? ACTOR_STATE.CHEER : ACTOR_STATE.POINT,
          { force: true, lock: anim === 'cheer' ? 1.15 : 1.4, anim });
      }
    }
    if (this.state !== ACTOR_STATE.IDLE && this.lockT <= 0
      && this.state !== ACTOR_STATE.MOVE) this.setState(ACTOR_STATE.IDLE);
  }

  /** Pick a point inside the leash, walk to it, pause, repeat. */
  _doWander(dt, pd, px, pz) {
    this.strafing = false;
    if (this.cfg.keep > 0 && pd < this.cfg.keep) { this._doIdle(pd, px, pz); return; }
    if (!this.navTarget && this._timer <= 0) {
      const a = this.brain.f() * TAU;
      const r = this.leash * Math.sqrt(this.brain.f());   // sqrt keeps the points area-uniform
      this.moveTo(this.home.x + Math.cos(a) * r, this.home.z + Math.sin(a) * r,
        MOVE.walk * this.hs * this.brain.range(0.6, 1.0));
      this._timer = this.brain.range(4.0, 11.0);
      this.setState(ACTOR_STATE.MOVE);
    }
    if (!this.navTarget && this.state !== ACTOR_STATE.IDLE) this.setState(ACTOR_STATE.IDLE);
    super._control(dt, this.app);   // reuse the base moveTo steering
  }

  /** Sitting: no movement, look at the player, stand up if the reaction turns sour. */
  _doSit(pd, px, pz) {
    this.strafing = true;
    this.navTarget = null;
    if (pd < this.cfg.look) this.facePoint(px, pz);
    if (this.state !== ACTOR_STATE.SIT) this.setState(ACTOR_STATE.SIT, { force: true });
  }

  /** Working: small steps around a work spot with periodic gestures, so a market looks busy. */
  _doWork(dt, pd, px, pz) {
    this.strafing = true;
    if (this._timer <= 0) {
      this._timer = this.brain.range(2.4, 6.0);
      if (this.brain.chance(0.45)) {
        // Shuffle to the next spot on the bench.
        const a = this.brain.f() * TAU;
        const r = this.brain.range(0.6, 2.0);
        this.moveTo(this.home.x + Math.cos(a) * r, this.home.z + Math.sin(a) * r, MOVE.walk * this.hs * 0.55);
      } else {
        this.targetYaw = this.brain.range(-Math.PI, Math.PI);
        this.setState(ACTOR_STATE.POINT, { force: true, lock: this.brain.range(0.8, 1.6), anim: 'point' });
      }
    }
    if (pd < 6.5 && this.reaction !== 'wary') this.facePoint(px, pz);
    super._control(dt, this.app);
  }

  /** Chat pair: face the partner, take turns talking. */
  _doChat(dt, pd, px, pz) {
    this.strafing = true;
    this.navTarget = null;
    const p = this.partner;
    if (!p || p.alive === false) { this.behaviour = this.baseBehaviour; return; }
    this.facePoint(p.pos.x, p.pos.z);
    this._chatT -= dt;
    if (this._chatT <= 0) {
      this._chatTurn = !this._chatTurn;
      this._chatT = this.brain.range(1.6, 4.2);
    }
    // The listener idles, the speaker talks. The pair alternates, so it reads as a conversation
    // rather than as two people miming at each other.
    const want = this._chatTurn ? ACTOR_STATE.TALK : ACTOR_STATE.IDLE;
    if (this.state !== want && this.lockT <= 0) this.setState(want);
    if (pd < 4.5) this.facePoint(px, pz);
  }

  /** Talking to the player: hold still and face them. */
  _doTalk(player) {
    this.strafing = true;
    this.navTarget = null;
    const t = this._talkTarget || player;
    if (t && t.pos) this.facePoint(t.pos.x, t.pos.z);
    if (this.state !== ACTOR_STATE.TALK) this.setState(ACTOR_STATE.TALK, { force: true });
  }

  step(dt, app) {
    this.syncReaction(app);
    super.step(dt, app);
  }

  serialize() {
    const o = super.serialize();
    o.npcId = this.npcId;
    o.kind = this.kind;
    o.behaviour = this.behaviour;
    o.reaction = this.reaction;
    o.marker = this.questMarker;
    o.home = [this.home.x, this.home.z];
    return o;
  }

  deserialize(o) {
    super.deserialize(o);
    if (!o) return this;
    if (o.home) { this.home.x = o.home[0]; this.home.z = o.home[1]; }
    if (o.behaviour) { this.behaviour = o.behaviour; this.baseBehaviour = o.behaviour; }
    if (o.reaction) this.setReaction(o.reaction);
    if (o.marker !== undefined) this.questMarker = !!o.marker;
    return this;
  }
}

/**
 * Factory.
 * @param {object} app @param {object|string} spec @param {object} [opts]
 * @returns {Npc}
 */
export function createNpc(app, spec, opts) {
  return new Npc(app, spec, opts);
}

/**
 * A small system wrapper so the orchestrator can register a crowd with
 * `app.addSystem('npc', createNpcSystem(app))` and have it stepped in ARCHITECTURE §4 order.
 */
export class NpcSystem {
  constructor(app) {
    this.app = app;
    /** @type {Npc[]} */
    this.list = [];
  }

  /** Spawn and track an NPC. @returns {Npc} */
  spawn(spec, opts) {
    const n = new Npc(this.app, spec, opts);
    this.list.push(n);
    return n;
  }

  /** Remove and dispose one NPC. */
  despawn(n) {
    const i = this.list.indexOf(n);
    if (i >= 0) this.list.splice(i, 1);
    n.dispose();
    return this;
  }

  /** Nearest NPC to a point, or null. @param {{x:number,z:number}} p */
  nearest(p, maxDist = Infinity) {
    let best = null, bd = maxDist;
    for (const n of this.list) {
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /** Push one reaction onto every NPC — used when the bounty tier changes. */
  setReactionAll(r) {
    for (const n of this.list) n.setReaction(r);
    return this;
  }

  step(dt, app) {
    for (let i = 0; i < this.list.length; i++) this.list[i].step(dt, app);
  }

  preRender(alpha) {
    for (let i = 0; i < this.list.length; i++) this.list[i].preRender(alpha);
  }

  serialize() { return { npcs: this.list.map((n) => n.serialize()) }; }

  deserialize(o) {
    if (!o || !Array.isArray(o.npcs)) return this;
    for (const rec of o.npcs) {
      const n = this.list.find((x) => x.npcId === rec.npcId);
      if (n) n.deserialize(rec);
    }
    return this;
  }

  dispose() {
    for (const n of this.list) n.dispose();
    this.list.length = 0;
  }
}

/** @param {object} app @returns {NpcSystem} */
export function createNpcSystem(app) {
  return new NpcSystem(app);
}

export default Npc;
