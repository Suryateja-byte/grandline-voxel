// The heads-up display.
//
// Layout law, in priority order:
//   1. The centre stays clear. A 620x420 (at 1080p) rectangle around the crosshair carries
//      nothing but a four-tick reticle, because that is where the fight happens and where the
//      player's eyes already are. Everything else is pushed to the rim.
//   2. Anchored, not stretched. Elements attach to corners and to the horizontal centre, so
//      21:9 spreads them apart instead of smearing them. One uniform scale keeps proportions.
//   3. Nothing overlaps. Each element owns a rectangle recorded in `regions`, and the
//      tutorial points at those same rectangles — if a rectangle were wrong the tutorial
//      would visibly point at nothing, which is a cheap, permanent self-test.
//   4. Nothing thinner than 2px, everything outlined. The HUD sits over #59B7EC sky and
//      #F0DDB4 sand in the same frame; only a dark outline survives both.
//
// The bars carry a lagging "ghost" fill. That is not decoration: a health bar that snaps
// gives no sense of how big the hit was, and Hades-grade feedback needs the size of the hit
// to be legible after it lands.

import { P, mixHex, shadeDown } from '../gen/palette.js';
import { clamp, clamp01, damp, angleDelta, commify, TAU } from '../core/math.js';
import { drawText, measure, BERRY, toCss } from './font.js';
import {
  panel, ribbon, bar, radialCooldown, icon, keyCap, waxSeal,
  telegraphColor, telegraphGlyph, highlight,
} from './draw.js';

/** Marker kind -> icon + colour, used by the compass. */
const MARKER_STYLE = {
  island: { icon: 'compass', color: P.grass },
  port: { icon: 'anchor', color: P.uiCyan },
  ship: { icon: 'wheel', color: P.plank },
  quest: { icon: 'scroll', color: P.uiGold },
  enemy: { icon: 'skull', color: P.uiRed },
  boss: { icon: 'skull', color: P.pirateMaroon },
  chest: { icon: 'chest', color: P.gold },
  crew: { icon: 'crew', color: P.heroCyan },
  home: { icon: 'star', color: P.heroGold },
};

const TOAST_STYLE = {
  info: { color: P.uiPaper, ink: P.uiInk, icon: null },
  good: { color: P.uiGreen, ink: P.uiWhite, icon: 'star' },
  bad: { color: P.uiRed, ink: P.uiWhite, icon: 'skull' },
  gold: { color: P.uiGold, ink: P.uiInk, icon: 'coin' },
  quest: { color: P.royalPurple, ink: P.uiWhite, icon: 'scroll' },
  warn: { color: P.telegraphWarn, ink: P.uiInk, icon: 'shockwave' },
  crew: { color: P.heroCyan, ink: P.uiInk, icon: 'crew' },
};

const WEATHER_STYLE = {
  clear: { icon: 'star', color: P.sunDisc, label: 'CLEAR' },
  cloudy: { icon: 'shockwave', color: P.cloudShade, label: 'CLOUD' },
  rain: { icon: 'droplet', color: P.seaShallow, label: 'RAIN' },
  storm: { icon: 'shockwave', color: P.telegraphWarn, label: 'STORM' },
  fog: { icon: 'droplet', color: P.cloudShade, label: 'FOG' },
  snow: { icon: 'snowflake', color: P.snow, label: 'SNOW' },
};

const DMG_STYLE = {
  hit: { color: P.damageNumber, size: 26, weight: 'display' },
  crit: { color: P.damageNumberCrit, size: 40, weight: 'display' },
  heal: { color: P.healNumber, size: 24, weight: 'display' },
  block: { color: P.parrySpark, size: 20, weight: 'body' },
  parry: { color: P.parrySpark, size: 30, weight: 'display' },
  miss: { color: P.uiPaperDark, size: 18, weight: 'body' },
  fruit: { color: P.fruitGomu, size: 30, weight: 'display' },
};

/** A safe, fully-populated HUD state. Every field the HUD reads has a defined default. */
export function blankHudState() {
  return {
    hp: 100, maxHp: 100, stamina: 100, maxStamina: 100,
    bounty: 0, berries: 0, level: 1, xp: 0, xpToNext: 100,
    fruit: null, combo: 0, comboTimer: 0, target: null, quest: null,
    compass: { yaw: 0, markers: [] },
    prompt: null, toasts: [], damageNumbers: [], crew: [],
    onShip: false, weather: 'clear', timeOfDay: 0.35, wanted: 0,
  };
}

export class Hud {
  /**
   * @param {object} [opts]
   * @param {number} [opts.refW=1920] design width
   * @param {number} [opts.refH=1080] design height
   * @param {string} [opts.cbMode='off'] colourblind-safe telegraph mode
   * @param {number} [opts.scaleMin=0.55] @param {number} [opts.scaleMax=2.2]
   */
  constructor(opts = {}) {
    this.opts = Object.assign({ refW: 1920, refH: 1080, cbMode: 'off', scaleMin: 0.55, scaleMax: 2.2 }, opts);
    this.regions = {};
    this.t = 0;
    // Smoothed mirrors of the game values. Drawing straight from the sim makes every bar
    // twitch on the frame a hit lands, which reads as noise rather than as impact.
    this.a = { hp: 1, hpGhost: 1, stam: 1, xp: 0, tHp: 1, tGhost: 1, combo: 0, xpPop: 0 };
    this.flash = { hp: 0, stam: 0, target: 0, bounty: 0 };
    this._prev = { hp: -1, bounty: -1, xp: -1, targetHp: -1 };
    this.w = opts.refW || 1920;
    this.h = opts.refH || 1080;
    this.s = 1;
  }

  setOption(key, value) { this.opts[key] = value; }

  /** Recompute the uniform scale and the safe margins for a viewport. */
  layout(w, h) {
    this.w = w; this.h = h;
    this.s = clamp(Math.min(w / this.opts.refW, h / this.opts.refH), this.opts.scaleMin, this.opts.scaleMax);
    this.m = Math.round(26 * this.s);
    const cw = Math.min(w * 0.34, 640 * this.s);
    const chh = Math.min(h * 0.42, 440 * this.s);
    this.regions.centre = { x: w / 2 - cw / 2, y: h / 2 - chh / 2, w: cw, h: chh };
    return this.s;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state see blankHudState() for the full shape
   * @param {number} dt seconds since the previous draw (animation only, never simulation)
   */
  draw(ctx, state, dt) {
    const st = state || blankHudState();
    const d = Math.min(0.1, dt || 0);
    this.t += d;
    this.layout(ctx.canvas.width, ctx.canvas.height);
    this._animate(st, d);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this._drawVitals(ctx, st);
    this._drawPurse(ctx, st);
    this._drawCompass(ctx, st);
    this._drawTarget(ctx, st);
    this._drawQuest(ctx, st);
    this._drawToasts(ctx, st);
    this._drawAbilities(ctx, st);
    this._drawCrew(ctx, st);
    this._drawCombo(ctx, st);
    this._drawReticle(ctx, st);
    this._drawPrompt(ctx, st);
    this._drawDamageNumbers(ctx, st);
    ctx.restore();
  }

  // ---------------------------------------------------------------- animation

  _animate(st, d) {
    const a = this.a;
    const hpT = clamp01(st.hp / Math.max(1e-6, st.maxHp));
    if (this._prev.hp >= 0 && st.hp < this._prev.hp) this.flash.hp = 1;
    if (this._prev.bounty >= 0 && st.bounty > this._prev.bounty) this.flash.bounty = 1;
    if (this._prev.xp >= 0 && st.xp > this._prev.xp) a.xpPop = 1;
    a.hp = damp(a.hp, hpT, 0.0008, d);
    // The ghost catches up slowly and only downward, so the size of the hit stays on screen.
    a.hpGhost = a.hpGhost < a.hp ? a.hp : damp(a.hpGhost, hpT, 0.25, d);
    a.stam = damp(a.stam, clamp01(st.stamina / Math.max(1e-6, st.maxStamina)), 0.0002, d);
    a.xp = damp(a.xp, clamp01(st.xp / Math.max(1e-6, st.xpToNext)), 0.002, d);
    a.combo = damp(a.combo, st.combo || 0, 0.0001, d);
    a.xpPop = Math.max(0, a.xpPop - d * 2.4);

    const tHp = st.target ? clamp01(st.target.hp / Math.max(1e-6, st.target.maxHp)) : 1;
    if (st.target && this._prev.targetHp >= 0 && tHp < this._prev.targetHp) this.flash.target = 1;
    a.tHp = st.target ? damp(a.tHp, tHp, 0.0004, d) : tHp;
    a.tGhost = a.tGhost < a.tHp ? a.tHp : damp(a.tGhost, tHp, 0.3, d);

    for (const k of Object.keys(this.flash)) this.flash[k] = Math.max(0, this.flash[k] - d * 4);
    this._prev.hp = st.hp;
    this._prev.bounty = st.bounty;
    this._prev.xp = st.xp;
    this._prev.targetHp = st.target ? tHp : -1;
  }

  // ---------------------------------------------------------------- top-left

  _drawVitals(ctx, st) {
    const s = this.s, m = this.m;
    const pw = Math.round(424 * s), ph = Math.round(118 * s);
    const x = m, y = m;
    this.regions.health = { x, y, w: pw, h: ph };
    panel(ctx, x, y, pw, ph, { rope: true, accent: mixHex(P.uiPaper, P.uiInk, 0.22), seed: 0x4a17 });

    // Level medallion. A wax seal, so the level reads as a rank stamped on the papers.
    const bx = x + Math.round(52 * s), by = y + ph / 2;
    const br = Math.round(33 * s);
    waxSeal(ctx, bx, by, br, { color: P.uiGold, text: String(st.level | 0), size: Math.round(30 * s), seed: 0x91 });
    drawText(ctx, 'LV', bx, by - br - Math.round(4 * s), {
      size: Math.round(10 * s), weight: 'display', color: P.uiInk, align: 'center', baseline: 'bottom',
    });

    const barX = x + Math.round(98 * s);
    const barW = pw - Math.round(118 * s);

    icon(ctx, 'heart', barX - Math.round(22 * s), y + Math.round(20 * s), Math.round(18 * s), P.uiRed, { outline: P.uiInk });
    bar(ctx, barX, y + Math.round(19 * s), barW, Math.round(23 * s), {
      value: this.a.hp * st.maxHp, max: st.maxHp, ghost: this.a.hpGhost * st.maxHp,
      color: st.hp / Math.max(1, st.maxHp) < 0.28 ? P.telegraphDanger : P.uiRed,
      perSegment: st.maxHp > 400 ? 100 : 25,
      flash: this.flash.hp * 0.7,
      label: `${Math.max(0, Math.round(st.hp))}/${Math.round(st.maxHp)}`,
    });

    icon(ctx, 'boot', barX - Math.round(22 * s), y + Math.round(50 * s), Math.round(18 * s), P.uiGreen, { outline: P.uiInk });
    bar(ctx, barX, y + Math.round(50 * s), barW, Math.round(15 * s), {
      value: this.a.stam * st.maxStamina, max: st.maxStamina,
      color: st.stamina < st.maxStamina * 0.2 ? P.telegraphWarn : P.uiGreen,
      perSegment: 25,
    });

    const xpY = y + Math.round(74 * s);
    bar(ctx, barX, xpY, barW, Math.round(10 * s), {
      value: this.a.xp * st.xpToNext, max: st.xpToNext,
      color: mixHex(P.uiCyan, P.uiWhite, this.a.xpPop * 0.6), perSegment: 0,
    });
    drawText(ctx, `${Math.round(st.xp)} / ${Math.round(st.xpToNext)} XP`, barX, xpY + Math.round(15 * s), {
      size: Math.round(11 * s), color: mixHex(P.uiInk, P.uiPaper, 0.15), weight: 'body',
    });

    // Wanted level: skulls, filled to the current heat. Empty skulls stay visible so the
    // player can see the ceiling, not just the current value.
    const wn = 5, ws = Math.round(15 * s);
    const wx = x + pw - Math.round(18 * s) - wn * (ws + 3 * s);
    for (let i = 0; i < wn; i++) {
      const on = i < (st.wanted || 0);
      icon(ctx, 'skull', wx + i * (ws + 3 * s), y + ph - Math.round(24 * s), ws,
        on ? P.uiRed : mixHex(P.uiPaper, P.uiInk, 0.24), { outline: on ? P.uiInk : undefined });
    }
  }

  _drawPurse(ctx, st) {
    const s = this.s, m = this.m;
    const r = this.regions.health;
    const pw = r.w, ph = Math.round(58 * s);
    const x = m, y = r.y + r.h + Math.round(10 * s);
    this.regions.bounty = { x, y, w: pw, h: ph };
    panel(ctx, x, y, pw, ph, { seed: 0x77c1, amp: 2.4 });

    const pulse = 1 + this.flash.bounty * 0.12;
    drawText(ctx, BERRY + commify(st.bounty || 0), x + Math.round(14 * s), y + ph * 0.5, {
      size: Math.round(24 * s * pulse), weight: 'display',
      color: this.flash.bounty > 0.02 ? P.critFlash : P.uiInk,
      baseline: 'middle', outline: P.uiPaper, outlineWidth: 1,
    });
    drawText(ctx, 'BOUNTY', x + Math.round(14 * s), y + Math.round(6 * s), {
      size: Math.round(9 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.35),
    });

    const cw = Math.round(120 * s);
    const cx = x + pw - cw;
    icon(ctx, 'coin', cx, y + ph * 0.5 - Math.round(11 * s), Math.round(22 * s), P.gold, { outline: P.uiInk });
    drawText(ctx, commify(st.berries || 0), cx + Math.round(28 * s), y + ph * 0.5, {
      size: Math.round(15 * s), weight: 'body', color: P.uiInk, baseline: 'middle',
    });
  }

  // ---------------------------------------------------------------- top-centre

  _drawCompass(ctx, st) {
    const s = this.s, m = this.m;
    const cw = Math.round(Math.min(this.w * 0.42, 660 * s));
    const ch = Math.round(46 * s);
    const x = Math.round(this.w / 2 - cw / 2), y = m;
    this.regions.compass = { x, y, w: cw, h: ch };
    const span = 2.4; // radians of heading visible across the strip
    const c = st.compass || { yaw: 0, markers: [] };

    panel(ctx, x, y, cw, ch, { deckle: false, radius: 6, seed: 0x3311, amp: 0, border: 3 });
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 3, y + 3, cw - 6, ch - 6);
    ctx.clip();

    const toX = (yaw) => x + cw / 2 + (angleDelta(c.yaw || 0, yaw) / span) * cw;
    // Degree ticks every 15deg, cardinal letters every 90deg.
    for (let deg = 0; deg < 360; deg += 15) {
      const a = deg * (Math.PI / 180);
      const px = toX(a);
      if (px < x - 20 || px > x + cw + 20) continue;
      const major = deg % 45 === 0;
      ctx.fillStyle = toCss(P.uiInk, major ? 0.85 : 0.4);
      ctx.fillRect(Math.round(px) - 1, y + ch - Math.round(major ? 15 * s : 9 * s), 2.5, Math.round(major ? 15 * s : 9 * s));
      if (deg % 90 === 0) {
        const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : 'W';
        drawText(ctx, label, px, y + Math.round(6 * s), {
          size: Math.round(15 * s), weight: 'display', align: 'center',
          color: deg === 0 ? P.uiRed : P.uiInk,
        });
      }
    }

    for (const mk of c.markers || []) {
      const style = MARKER_STYLE[mk.kind] || MARKER_STYLE.island;
      const delta = angleDelta(c.yaw || 0, mk.yaw);
      const off = Math.abs(delta) > span / 2;
      const px = clamp(toX(mk.yaw), x + Math.round(12 * s), x + cw - Math.round(12 * s));
      const isz = Math.round(19 * s);
      icon(ctx, style.icon, px - isz / 2, y + Math.round(9 * s), isz, style.color, { outline: P.uiInk });
      if (off) {
        // Edge arrow: the marker is behind you, and which way to turn matters.
        ctx.fillStyle = toCss(P.uiInk);
        ctx.beginPath();
        const dir = delta > 0 ? 1 : -1;
        const ax = px + dir * Math.round(11 * s);
        ctx.moveTo(ax + dir * Math.round(7 * s), y + ch / 2);
        ctx.lineTo(ax, y + ch / 2 - Math.round(6 * s));
        ctx.lineTo(ax, y + ch / 2 + Math.round(6 * s));
        ctx.closePath(); ctx.fill();
      } else if (mk.dist !== undefined) {
        const dtxt = mk.dist >= 1000 ? `${(mk.dist / 1000).toFixed(1)}k` : `${Math.round(mk.dist)}m`;
        drawText(ctx, dtxt, px, y + ch - Math.round(13 * s), {
          size: Math.round(10 * s), align: 'center', color: P.uiInk,
          outline: P.uiPaper, outlineWidth: 1,
        });
      }
    }
    ctx.restore();

    // Heading needle at dead centre.
    ctx.fillStyle = toCss(P.uiRed);
    ctx.beginPath();
    ctx.moveTo(x + cw / 2, y - Math.round(2 * s));
    ctx.lineTo(x + cw / 2 - Math.round(7 * s), y - Math.round(13 * s));
    ctx.lineTo(x + cw / 2 + Math.round(7 * s), y - Math.round(13 * s));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = toCss(P.uiInk); ctx.lineWidth = 2.5; ctx.stroke();
  }

  _drawTarget(ctx, st) {
    const t = st.target;
    const s = this.s;
    const cr = this.regions.compass;
    const tw = Math.round(Math.min(this.w * 0.36, 580 * s));
    const th = Math.round(30 * s);
    const x = Math.round(this.w / 2 - tw / 2);
    const y = cr.y + cr.h + Math.round(30 * s);
    this.regions.target = { x, y: y - Math.round(24 * s), w: tw, h: th + Math.round(46 * s) };
    if (!t) return;

    const tier = t.tier || 1;
    const tierColor = tier >= 3 ? P.pirateMaroon : tier === 2 ? P.bruiserOrange : P.uiRed;

    drawText(ctx, String(t.name || 'ENEMY').toUpperCase(), this.w / 2, y - Math.round(24 * s), {
      size: Math.round(19 * s), weight: 'display', color: P.uiWhite, align: 'center',
      outline: P.uiInk, outlineWidth: 2, shadow: P.uiShadow, shadowOffset: 1,
    });
    for (let i = 0; i < Math.min(4, tier); i++) {
      icon(ctx, 'skull', x + tw + Math.round((4 + i * 15) * s), y - Math.round(6 * s), Math.round(14 * s),
        tierColor, { outline: P.uiInk });
    }

    bar(ctx, x, y, tw, th, {
      value: this.a.tHp * t.maxHp, max: t.maxHp, ghost: this.a.tGhost * t.maxHp,
      color: tierColor, perSegment: t.maxHp > 600 ? 200 : 100,
      flash: this.flash.target,
      label: `${Math.max(0, Math.round(t.hp))}`,
    });

    // Telegraph band. Shape AND colour carry the meaning, so the colourblind-safe mode
    // never has to invent a hue that reads the same as another class.
    const tel = t.telegraph;
    if (tel) {
      const kind = typeof tel === 'string' ? tel : (tel.kind || 'warn');
      const prog = typeof tel === 'object' && tel.t !== undefined ? clamp01(tel.t) : (0.5 + 0.5 * Math.sin(this.t * 9));
      const col = telegraphColor(kind, this.opts.cbMode);
      const by = y + th + Math.round(8 * s);
      const bh = Math.round(13 * s);
      ctx.fillStyle = toCss(P.uiInk, 0.55);
      ctx.fillRect(x, by, tw, bh);
      ctx.fillStyle = toCss(col);
      ctx.fillRect(x, by, tw * prog, bh);
      ctx.strokeStyle = toCss(P.uiInk); ctx.lineWidth = 2.5;
      ctx.strokeRect(x - 1.25, by - 1.25, tw + 2.5, bh + 2.5);
      telegraphGlyph(ctx, kind, x - Math.round(16 * s), by + bh / 2, Math.round(18 * s), col);
      const word = kind === 'danger' ? 'UNBLOCKABLE' : kind === 'guard' ? 'PARRY' : 'INCOMING';
      drawText(ctx, word, this.w / 2, by + bh + Math.round(5 * s), {
        size: Math.round(12 * s), weight: 'display', align: 'center', color: col,
        outline: P.uiInk, outlineWidth: 1,
      });
    }
  }

  // ---------------------------------------------------------------- top-right

  _drawQuest(ctx, st) {
    const s = this.s, m = this.m;
    const qw = Math.round(340 * s);
    const x = this.w - m - qw;
    const y = m;
    const q = st.quest;
    if (!q) { this.regions.quest = { x, y, w: qw, h: 0 }; return; }

    const objM = measure(q.objective || '', Math.round(13 * s), 'body', { maxWidth: qw - Math.round(30 * s) });
    const showBar = q.total > 1;
    const qh = Math.round(40 * s) + objM.h + (showBar ? Math.round(24 * s) : 0) + Math.round(14 * s);
    this.regions.quest = { x, y, w: qw, h: qh };
    panel(ctx, x, y, qw, qh, { seed: 0x2b41, accent: mixHex(P.uiPaper, P.royalPurple, 0.3) });

    icon(ctx, 'scroll', x + Math.round(13 * s), y + Math.round(12 * s), Math.round(18 * s), P.royalPurple);
    drawText(ctx, String(q.title || 'QUEST').toUpperCase(), x + Math.round(38 * s), y + Math.round(12 * s), {
      size: Math.round(15 * s), weight: 'display', color: P.uiInk, maxWidth: qw - Math.round(52 * s),
    });
    drawText(ctx, q.objective || '', x + Math.round(15 * s), y + Math.round(36 * s), {
      size: Math.round(13 * s), weight: 'body', color: mixHex(P.uiInk, P.uiPaper, 0.12),
      maxWidth: qw - Math.round(30 * s),
    });
    if (showBar) {
      const by = y + Math.round(40 * s) + objM.h;
      bar(ctx, x + Math.round(15 * s), by, qw - Math.round(76 * s), Math.round(12 * s), {
        value: q.progress || 0, max: q.total, color: P.uiGold, perSegment: q.total <= 12 ? 1 : 0,
      });
      drawText(ctx, `${q.progress || 0}/${q.total}`, x + qw - Math.round(15 * s), by + Math.round(6 * s), {
        size: Math.round(13 * s), weight: 'display', color: P.uiInk, align: 'right', baseline: 'middle',
      });
    }
  }

  _drawToasts(ctx, st) {
    const s = this.s, m = this.m;
    const tw = Math.round(330 * s);
    const qr = this.regions.quest || { y: m, h: 0 };
    let y = qr.y + qr.h + Math.round(qr.h ? 12 * s : 0);
    const x0 = this.w - m - tw;
    this.regions.toasts = { x: x0, y, w: tw, h: 0 };

    const list = st.toasts || [];
    for (let i = 0; i < list.length && i < 6; i++) {
      const t = list[i];
      const life = t.life || 3;
      const age = t.age || 0;
      const inT = clamp01(age / 0.22);
      const outT = clamp01((life - age) / 0.35);
      const alpha = Math.min(inT, outT);
      if (alpha <= 0) continue;
      const style = TOAST_STYLE[t.kind] || TOAST_STYLE.info;
      const tm = measure(t.text, Math.round(14 * s), 'body', { maxWidth: tw - Math.round(58 * s) });
      const th = Math.max(Math.round(40 * s), tm.h + Math.round(20 * s));
      const slide = (1 - inT) * 60 * s + (1 - outT) * 18 * s;
      const x = x0 + slide;

      panel(ctx, x, y, tw, th, {
        fill: mixHex(P.uiPaper, style.color, 0.45), alpha, seed: 0x500 + i, amp: 2.2,
      });
      if (style.icon) icon(ctx, style.icon, x + Math.round(12 * s), y + th / 2 - Math.round(10 * s), Math.round(20 * s), shadeDown(style.color, 0.7), { alpha });
      drawText(ctx, t.text, x + Math.round(style.icon ? 42 * s : 16 * s), y + th / 2, {
        size: Math.round(14 * s), weight: 'body', color: P.uiInk, baseline: 'middle',
        maxWidth: tw - Math.round(58 * s), alpha,
      });
      y += th + Math.round(8 * s);
    }
    this.regions.toasts.h = y - this.regions.toasts.y;
  }

  // ---------------------------------------------------------------- bottom-left

  _drawAbilities(ctx, st) {
    const s = this.s, m = this.m;
    const f = st.fruit;
    const r = Math.round(34 * s);
    const gap = Math.round(20 * s);
    const cy = this.h - m - r - Math.round(18 * s);
    const x0 = m + r;
    const abilities = (f && f.abilities) || [];
    const width = abilities.length ? abilities.length * (r * 2 + gap) - gap : 0;
    this.regions.abilities = { x: m, y: cy - r - Math.round(34 * s), w: Math.max(width, Math.round(180 * s)), h: r * 2 + Math.round(60 * s) };

    if (f) {
      const nameW = Math.max(Math.round(150 * s), measure(f.name || '', Math.round(15 * s), 'display').w + Math.round(52 * s));
      ribbon(ctx, m, cy - r - Math.round(34 * s), nameW, Math.round(26 * s), {
        color: f.color === undefined ? P.fruitGomu : f.color,
        text: String(f.name || '').toUpperCase(), size: Math.round(14 * s), notch: Math.round(11 * s),
      });
    }

    for (let i = 0; i < abilities.length; i++) {
      const ab = abilities[i];
      const cx = x0 + i * (r * 2 + gap);
      const cdMax = ab.cooldownMax || 0;
      const t = cdMax > 0 ? clamp01((ab.cooldown || 0) / cdMax) : 0;
      radialCooldown(ctx, cx, cy, r, {
        t, color: ab.color === undefined ? (f && f.color !== undefined ? f.color : P.uiCyan) : ab.color,
        icon: ab.icon, key: ab.key || String(i + 1), cost: ab.cost,
        ready: ab.ready !== false, seconds: ab.cooldown,
        pulse: ab.ready !== false && t <= 0.0001 ? (this.t * 0.8) % 1 : 0,
        locked: ab.locked,
      });
      drawText(ctx, String(ab.name || '').toUpperCase(), cx, cy + r + Math.round(24 * s), {
        size: Math.round(10 * s), weight: 'body', align: 'center',
        color: P.uiWhite, outline: P.uiInk, outlineWidth: 1, maxWidth: r * 2 + gap,
      });
    }
  }

  // ---------------------------------------------------------------- bottom-right

  _drawCrew(ctx, st) {
    const s = this.s, m = this.m;
    const cw = Math.round(268 * s);
    const x = this.w - m - cw;

    // Weather + clock chip sits lowest; the crew list stacks above it.
    const chH = Math.round(50 * s);
    const chY = this.h - m - chH;
    this.regions.ship = { x, y: chY, w: cw, h: chH };
    panel(ctx, x, chY, cw, chH, { deckle: false, radius: 6, seed: 0x9a2 });

    const wk = WEATHER_STYLE[st.weather] || WEATHER_STYLE.clear;
    icon(ctx, wk.icon, x + Math.round(12 * s), chY + chH / 2 - Math.round(11 * s), Math.round(22 * s), wk.color, { outline: P.uiInk });
    drawText(ctx, wk.label, x + Math.round(40 * s), chY + chH / 2, {
      size: Math.round(12 * s), weight: 'display', color: P.uiInk, baseline: 'middle',
    });

    // Day dial: a half-circle with the sun/moon riding it. Time of day matters for sailing.
    const dx = x + cw - Math.round(58 * s), dy = chY + chH - Math.round(12 * s), dr = Math.round(24 * s);
    ctx.strokeStyle = toCss(mixHex(P.uiInk, P.uiPaper, 0.5));
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(dx, dy, dr, Math.PI, TAU); ctx.stroke();
    const td = clamp01(st.timeOfDay === undefined ? 0.35 : st.timeOfDay);
    const night = td < 0.25 || td > 0.75;
    const ang = Math.PI + TAU * ((td % 0.5) / 0.5) * 0.5;
    ctx.fillStyle = toCss(night ? P.moonDisc : P.sunDisc);
    ctx.beginPath(); ctx.arc(dx + Math.cos(ang) * dr, dy + Math.sin(ang) * dr, Math.round(6 * s), 0, TAU); ctx.fill();
    ctx.strokeStyle = toCss(P.uiInk); ctx.lineWidth = 2; ctx.stroke();

    if (st.onShip) {
      icon(ctx, 'wheel', x + cw - Math.round(24 * s), chY + Math.round(6 * s), Math.round(18 * s), P.plank, { outline: P.uiInk });
    }

    const crew = st.crew || [];
    if (!crew.length) { this.regions.crew = { x, y: chY, w: cw, h: 0 }; return; }
    const rowH = Math.round(26 * s);
    const ph = Math.round(26 * s) + Math.min(crew.length, 5) * rowH + Math.round(10 * s);
    const py = chY - Math.round(10 * s) - ph;
    this.regions.crew = { x, y: py, w: cw, h: ph };
    panel(ctx, x, py, cw, ph, { seed: 0x1f7, amp: 2.4 });
    icon(ctx, 'crew', x + Math.round(12 * s), py + Math.round(6 * s), Math.round(16 * s), P.uiInk);
    drawText(ctx, 'CREW', x + Math.round(34 * s), py + Math.round(7 * s), {
      size: Math.round(12 * s), weight: 'display', color: mixHex(P.uiInk, P.uiPaper, 0.2),
    });
    for (let i = 0; i < Math.min(crew.length, 5); i++) {
      const cy2 = py + Math.round(30 * s) + i * rowH;
      ctx.fillStyle = toCss(P.uiInk, 0.16);
      ctx.fillRect(x + Math.round(12 * s), cy2 + rowH - Math.round(3 * s), cw - Math.round(24 * s), 2);
      drawText(ctx, crew[i].name || '', x + Math.round(14 * s), cy2 + rowH / 2 - Math.round(2 * s), {
        size: Math.round(13 * s), weight: 'body', color: P.uiInk, baseline: 'middle',
      });
      drawText(ctx, String(crew[i].role || '').toUpperCase(), x + cw - Math.round(14 * s), cy2 + rowH / 2 - Math.round(2 * s), {
        size: Math.round(10 * s), weight: 'display', color: mixHex(P.uiInk, P.uiPaper, 0.4),
        align: 'right', baseline: 'middle',
      });
    }
  }

  // ---------------------------------------------------------------- centre-adjacent

  _drawCombo(ctx, st) {
    const s = this.s;
    const combo = st.combo || 0;
    const cx = this.w / 2 + Math.round(Math.min(this.w * 0.22, 400 * s));
    const cy = this.h / 2 - Math.round(30 * s);
    this.regions.combo = { x: cx - Math.round(60 * s), y: cy - Math.round(50 * s), w: Math.round(120 * s), h: Math.round(110 * s) };
    if (combo < 2) return;

    const pop = clamp01(1 - (this.a.combo === combo ? 1 : Math.abs(combo - this.a.combo) / 2));
    const size = Math.round((46 + pop * 12) * s);
    const hot = clamp01(combo / 20);
    const col = mixHex(P.uiGold, P.telegraphDanger, hot);
    drawText(ctx, String(combo), cx, cy, {
      size, weight: 'display', color: col, align: 'center', baseline: 'middle',
      outline: P.uiInk, outlineWidth: 2, shadow: P.uiShadow, shadowOffset: 2,
    });
    drawText(ctx, 'HITS', cx, cy + Math.round(30 * s), {
      size: Math.round(14 * s), weight: 'display', color: P.uiWhite, align: 'center',
      outline: P.uiInk, outlineWidth: 1,
    });
    // Combo timer as a draining ring — the player needs to know how long they have.
    const tmax = st.comboTimerMax || 3;
    const tt = clamp01((st.comboTimer || 0) / tmax);
    if (tt > 0) {
      ctx.strokeStyle = toCss(P.uiInk, 0.5);
      ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(cx, cy, Math.round(42 * s), 0, TAU); ctx.stroke();
      ctx.strokeStyle = toCss(col);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.round(42 * s), -Math.PI / 2, -Math.PI / 2 + TAU * tt);
      ctx.stroke();
    }
  }

  _drawReticle(ctx, st) {
    const s = this.s;
    const cx = Math.round(this.w / 2), cy = Math.round(this.h / 2);
    const has = !!st.target;
    const gap = Math.round((has ? 13 : 9) * s);
    const len = Math.round((has ? 9 : 6) * s);
    ctx.strokeStyle = toCss(P.uiInk, 0.75);
    ctx.lineWidth = 4;
    const ticks = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? toCss(has ? P.telegraphGuard : P.uiWhite) : toCss(P.uiInk, 0.8);
      ctx.lineWidth = pass ? 2 : 4;
      for (const [dx, dy] of ticks) {
        ctx.beginPath();
        ctx.moveTo(cx + dx * gap, cy + dy * gap);
        ctx.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
        ctx.stroke();
      }
    }
  }

  _drawPrompt(ctx, st) {
    const s = this.s;
    const p = st.prompt;
    const y = Math.round(this.h * 0.74);
    if (!p) { this.regions.prompt = { x: this.w / 2 - 80 * s, y, w: 160 * s, h: 40 * s }; return; }
    const lm = measure(p.label, Math.round(15 * s), 'body');
    const kw = Math.round(38 * s);
    const pw = kw + lm.w + Math.round(40 * s);
    const ph = Math.round(42 * s);
    const x = Math.round(this.w / 2 - pw / 2);
    this.regions.prompt = { x, y, w: pw, h: ph };
    panel(ctx, x, y, pw, ph, { deckle: false, radius: 8, seed: 0x6d2, fill: mixHex(P.uiPaper, P.uiGold, 0.18) });
    keyCap(ctx, x + Math.round(12 * s), y + Math.round(10 * s), String(p.key).toUpperCase(), { size: Math.round(13 * s) });
    drawText(ctx, p.label, x + kw + Math.round(20 * s), y + ph / 2, {
      size: Math.round(15 * s), weight: 'body', color: P.uiInk, baseline: 'middle',
    });
  }

  _drawDamageNumbers(ctx, st) {
    const s = this.s;
    for (const dn of st.damageNumbers || []) {
      const life = dn.life || 1;
      const t = clamp01((dn.age || 0) / life);
      if (dn.visible === false) continue;
      if (t >= 1) continue;
      const style = DMG_STYLE[dn.kind] || DMG_STYLE.hit;
      // Rises fast then eases out; drifts sideways by a per-number offset so stacked hits
      // on one enemy never overlap into an unreadable pile.
      const rise = (1 - Math.pow(1 - t, 2.2)) * 62 * s;
      const alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      const pop = t < 0.14 ? 1 + (1 - t / 0.14) * 0.5 : 1;
      const txt = dn.kind === 'miss' ? 'MISS' : dn.kind === 'block' ? 'BLOCK'
        : (dn.kind === 'heal' ? '+' : '') + commify(Math.abs(Math.round(dn.value)));
      drawText(ctx, txt, dn.x + (dn.drift || 0), dn.y - rise, {
        size: Math.round(style.size * s * pop), weight: style.weight, color: style.color,
        align: 'center', baseline: 'middle', alpha,
        outline: P.uiInk, outlineWidth: dn.kind === 'crit' ? 2 : 1,
        shadow: P.uiShadow, shadowOffset: 1,
      });
      if (dn.kind === 'crit' && t < 0.4) {
        const k = 1 - t / 0.4;
        drawText(ctx, 'CRIT', dn.x + (dn.drift || 0), dn.y - rise - Math.round(26 * s), {
          size: Math.round(15 * s), weight: 'display', color: P.critFlash, align: 'center',
          baseline: 'middle', alpha: alpha * k, outline: P.uiInk, outlineWidth: 1,
        });
      }
    }
  }

  /** Draw a soft highlight over a named region. Used by the tutorial. */
  spotlight(ctx, regionName, color, phase) {
    const r = this.regions[regionName];
    if (!r || r.w <= 0 || r.h <= 0) return null;
    highlight(ctx, r.x, r.y, r.w, r.h, color, phase);
    return r;
  }
}

export { MARKER_STYLE, TOAST_STYLE, DMG_STYLE };
