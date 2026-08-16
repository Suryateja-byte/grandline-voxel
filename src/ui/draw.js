// The visual language of the interface: aged parchment, rough deckled edges, rope, wax seals,
// ink. One vocabulary, used by the HUD, the menus and the tutorial, so the whole interface
// reads as objects pinned to a navigator's table rather than as browser chrome.
//
// WHY parchment and not a translucent dark slab: the game frame is a bright, high-key,
// saturated sky (ART_BAR §3/§7). A dark glass panel reads as a hole punched in the picture and
// kills the high-key grade. Warm paper sits inside the palette, and its ink is the same
// blue-black used for character features, so the UI belongs to the same painted world.
//
// WHY every wobble is hashed, not random: `hash2` is pure, so a panel at the same rectangle
// has the same deckle every frame — no shimmering edges — and capture stays bit-identical.
// Math.random() is banned repo-wide.
//
// Rule followed throughout: no hairlines. The thinnest stroke here is 2 device px at 1080p,
// because a 1px ink line over a bright sky disappears the moment the image is scaled.

import { P, mixHex, shadeDown, shadeUp, shift } from '../gen/palette.js';
import { hash2, hashFloat } from '../core/rng.js';
import { clamp01, lerp, TAU } from '../core/math.js';
import { drawText, measure, toCss } from './font.js';

export { toCss };

/** Deterministic signed wobble in [-1,1] for sample `i` of feature `seed`. */
function wob(i, seed) {
  return hashFloat(hash2(i, seed, 0x5eed)) * 2 - 1;
}

/** Stable integer identity for a rectangle, so a panel's deckle never changes between frames. */
export function seedOf(x, y, w, h, salt = 0) {
  return hash2((x | 0) * 73856093 ^ (w | 0) * 19349663, (y | 0) * 83492791 ^ (h | 0) * 2971215073, salt) >>> 0;
}

/**
 * A torn-paper outline. Perimeter is walked in `step` px increments and pushed outward by a
 * hashed amount, so the edge is ragged but stable.
 * @returns {Path2D}
 */
export function deckledPath(x, y, w, h, amp = 3, seed = 1, step = 11) {
  const p = new Path2D();
  const pts = [];
  const push = (px, py, i, nx, ny) => {
    const d = wob(i, seed) * amp;
    pts.push([px + nx * d, py + ny * d]);
  };
  let i = 0;
  const nx = Math.max(2, Math.round(w / step));
  const ny = Math.max(2, Math.round(h / step));
  for (let k = 0; k < nx; k++) push(x + (w * k) / nx, y, i++, 0, -1);
  for (let k = 0; k < ny; k++) push(x + w, y + (h * k) / ny, i++, 1, 0);
  for (let k = nx; k > 0; k--) push(x + (w * k) / nx, y + h, i++, 0, 1);
  for (let k = ny; k > 0; k--) push(x, y + (h * k) / ny, i++, -1, 0);
  p.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) p.lineTo(pts[k][0], pts[k][1]);
  p.closePath();
  return p;
}

/** Rounded rectangle as a Path2D (no ctx state touched). */
export function roundRectPath(x, y, w, h, r) {
  const p = new Path2D();
  const rr = Math.min(r, w / 2, h / 2);
  p.moveTo(x + rr, y);
  p.lineTo(x + w - rr, y); p.quadraticCurveTo(x + w, y, x + w, y + rr);
  p.lineTo(x + w, y + h - rr); p.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  p.lineTo(x + rr, y + h); p.quadraticCurveTo(x, y + h, x, y + h - rr);
  p.lineTo(x, y + rr); p.quadraticCurveTo(x, y, x + rr, y);
  p.closePath();
  return p;
}

/**
 * An aged parchment panel.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} [o]
 * @param {number} [o.fill=P.uiPaper] paper colour
 * @param {number} [o.ink=P.uiInk] border ink
 * @param {number} [o.accent] optional accent colour for the inner rule
 * @param {number} [o.alpha=1]
 * @param {boolean} [o.rope=false] draw a twisted rope border
 * @param {boolean} [o.deckle=true] ragged edge (false = clean cut card)
 * @param {number} [o.amp=3] deckle amplitude in px
 * @param {number} [o.border=3] ink border width
 * @param {boolean} [o.shadow=true] cast a soft drop shadow onto the world
 * @param {number} [o.seed]
 * @returns {Path2D} the paper silhouette, useful as a clip region
 */
export function panel(ctx, x, y, w, h, o = {}) {
  const seed = o.seed === undefined ? seedOf(x, y, w, h) : o.seed;
  const fill = o.fill === undefined ? P.uiPaper : o.fill;
  const ink = o.ink === undefined ? P.uiInk : o.ink;
  const alpha = o.alpha === undefined ? 1 : o.alpha;
  const border = o.border === undefined ? 3 : o.border;
  const deckle = o.deckle !== false;
  const path = deckle
    ? deckledPath(x, y, w, h, o.amp === undefined ? 3 : o.amp, seed)
    : roundRectPath(x, y, w, h, o.radius === undefined ? 5 : o.radius);

  const pa = ctx.globalAlpha;
  ctx.globalAlpha = pa * alpha;

  if (o.shadow !== false) {
    ctx.save();
    ctx.translate(4, 5);
    ctx.globalAlpha = pa * alpha * 0.3;
    ctx.fillStyle = toCss(P.uiShadow);
    ctx.fill(path);
    ctx.restore();
  }

  ctx.fillStyle = toCss(fill);
  ctx.fill(path);

  // Age: hashed blotches of a warmer, dirtier paper. Flat paper looks like a CSS div.
  ctx.save();
  ctx.clip(path);
  const stain = mixHex(fill, P.uiPaperDark, 0.75);
  const n = Math.max(4, Math.min(16, Math.round((w * h) / 5200)));
  for (let i = 0; i < n; i++) {
    const bx = x + hashFloat(hash2(i, seed, 11)) * w;
    const by = y + hashFloat(hash2(i, seed, 12)) * h;
    const br = 6 + hashFloat(hash2(i, seed, 13)) * Math.min(w, h) * 0.28;
    ctx.globalAlpha = pa * alpha * (0.05 + hashFloat(hash2(i, seed, 14)) * 0.09);
    ctx.fillStyle = toCss(stain);
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * 0.66, hashFloat(hash2(i, seed, 15)) * TAU, 0, TAU);
    ctx.fill();
  }
  // Edge burn: paper darkens toward its torn rim.
  ctx.globalAlpha = pa * alpha * 0.5;
  ctx.strokeStyle = toCss(mixHex(fill, P.dirtDark, 0.45));
  ctx.lineWidth = 10;
  ctx.stroke(path);
  ctx.restore();
  ctx.globalAlpha = pa * alpha;

  if (border > 0) {
    ctx.strokeStyle = toCss(ink);
    ctx.lineWidth = border;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  }
  if (o.accent !== undefined) {
    const inner = deckle
      ? deckledPath(x + 7, y + 7, w - 14, h - 14, 1.6, seed ^ 0x9e37, 13)
      : roundRectPath(x + 7, y + 7, w - 14, h - 14, 3);
    ctx.strokeStyle = toCss(o.accent);
    ctx.lineWidth = 2;
    ctx.stroke(inner);
  }
  if (o.rope) ropeBorder(ctx, x, y, w, h, o.ropeColor === undefined ? P.rope : o.ropeColor, seed);

  ctx.globalAlpha = pa;
  return path;
}

/** A twisted-rope border: alternating light/dark diagonal strands around a rectangle. */
export function ropeBorder(ctx, x, y, w, h, color = P.rope, seed = 1, thick = 7) {
  const lit = shadeUp(color, 0.7);
  const dark = shadeDown(color, 0.7);
  const half = thick / 2;
  const seg = 9;
  ctx.save();
  ctx.lineCap = 'butt';
  const run = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(len / seg));
    const dx = (x1 - x0) / n, dy = (y1 - y0) / n;
    const px = -dy / Math.hypot(dx, dy) * half, py = dx / Math.hypot(dx, dy) * half;
    for (let i = 0; i < n; i++) {
      const ax = x0 + dx * i, ay = y0 + dy * i;
      ctx.strokeStyle = toCss(i % 2 ? dark : lit);
      ctx.lineWidth = thick;
      ctx.beginPath();
      ctx.moveTo(ax - px * 0.9, ay - py * 0.9);
      ctx.lineTo(ax + dx * 0.9 + px * 0.9, ay + dy * 0.9 + py * 0.9);
      ctx.stroke();
    }
  };
  run(x - half, y - half, x + w + half, y - half);
  run(x + w + half, y - half, x + w + half, y + h + half);
  run(x + w + half, y + h + half, x - half, y + h + half);
  run(x - half, y + h + half, x - half, y - half);
  ctx.restore();
}

/**
 * A cloth banner with forked tails, used for headings and section titles.
 * @param {object} [o] { color, ink, text, textColor, size, weight, notch, alpha }
 */
export function ribbon(ctx, x, y, w, h, o = {}) {
  const color = o.color === undefined ? P.uiRed : o.color;
  const notch = o.notch === undefined ? Math.min(20, h * 0.55) : o.notch;
  const pa = ctx.globalAlpha;
  if (o.alpha !== undefined) ctx.globalAlpha = pa * o.alpha;

  const body = new Path2D();
  body.moveTo(x, y);
  body.lineTo(x + w, y);
  body.lineTo(x + w - notch, y + h / 2);
  body.lineTo(x + w, y + h);
  body.lineTo(x, y + h);
  body.lineTo(x + notch, y + h / 2);
  body.closePath();

  ctx.save();
  ctx.translate(3, 4);
  ctx.globalAlpha = ctx.globalAlpha * 0.28;
  ctx.fillStyle = toCss(P.uiShadow);
  ctx.fill(body);
  ctx.restore();

  ctx.fillStyle = toCss(color);
  ctx.fill(body);
  // Two tonal steps inside one surface — ART_BAR §4 forbids flat single-colour regions.
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = toCss(shadeDown(color, 0.5));
  ctx.fillRect(x, y + h * 0.62, w, h * 0.38);
  ctx.fillStyle = toCss(shadeUp(color, 0.45));
  ctx.fillRect(x, y, w, Math.max(2, h * 0.16));
  ctx.restore();
  ctx.strokeStyle = toCss(o.ink === undefined ? shadeDown(color, 1.3) : o.ink);
  ctx.lineWidth = o.border === undefined ? 3 : o.border;
  ctx.lineJoin = 'round';
  ctx.stroke(body);

  if (o.text) {
    drawText(ctx, o.text, x + w / 2, y + h / 2, {
      size: o.size || Math.round(h * 0.5),
      weight: o.weight || 'display',
      color: o.textColor === undefined ? P.uiWhite : o.textColor,
      align: 'center', baseline: 'middle',
      outline: shadeDown(color, 1.5), outlineWidth: 1,
    });
  }
  ctx.globalAlpha = pa;
  return body;
}

/**
 * A segmented resource bar. Segments are what make a hit legible: "I lost two ticks" reads
 * instantly where a continuous slider does not.
 * @param {object} o
 * @param {number} o.value current
 * @param {number} o.max maximum
 * @param {number} [o.ghost] a lagging value drawn behind the fill (recent damage)
 * @param {number} [o.color] fill colour
 * @param {number} [o.back] trough colour
 * @param {number} [o.perSegment=25] units per tick mark
 * @param {string} [o.label]
 * @param {number} [o.flash=0] 0..1 white flash on the fill
 * @param {boolean} [o.rightToLeft=false] drain from the right (used for enemy bars)
 */
export function bar(ctx, x, y, w, h, o) {
  const max = Math.max(1e-6, o.max);
  const t = clamp01(o.value / max);
  const color = o.color === undefined ? P.uiRed : o.color;
  const back = o.back === undefined ? shadeDown(P.uiPaperDark, 1.35) : o.back;
  const rtl = !!o.rightToLeft;
  const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);

  ctx.fillStyle = toCss(back);
  ctx.fillRect(rx, ry, rw, rh);

  if (o.ghost !== undefined && o.ghost > o.value) {
    const gt = clamp01(o.ghost / max);
    const gw = Math.round(rw * gt);
    ctx.fillStyle = toCss(mixHex(color, P.uiWhite, 0.55));
    ctx.fillRect(rtl ? rx + rw - gw : rx, ry, gw, rh);
  }

  const fw = Math.round(rw * t);
  if (fw > 0) {
    const fx = rtl ? rx + rw - fw : rx;
    ctx.fillStyle = toCss(color);
    ctx.fillRect(fx, ry, fw, rh);
    // top light band / bottom shadow band: the two tonal steps
    ctx.fillStyle = toCss(shadeUp(color, 0.85));
    ctx.fillRect(fx, ry, fw, Math.max(2, Math.round(rh * 0.3)));
    ctx.fillStyle = toCss(shadeDown(color, 0.7));
    ctx.fillRect(fx, ry + rh - Math.max(2, Math.round(rh * 0.22)), fw, Math.max(2, Math.round(rh * 0.22)));
    if (o.flash) {
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * clamp01(o.flash);
      ctx.fillStyle = toCss(P.hitFlash);
      ctx.fillRect(fx, ry, fw, rh);
      ctx.restore();
    }
  }

  // Tick notches cut through everything so the count is readable at any fill level.
  const per = o.perSegment === undefined ? 25 : o.perSegment;
  if (per > 0 && max / per <= 40) {
    ctx.fillStyle = toCss(P.uiInk, 0.55);
    for (let v = per; v < max - 1e-6; v += per) {
      const px = rx + Math.round((rw * v) / max);
      ctx.fillRect(px - 1, ry, 2, rh);
    }
  }

  ctx.strokeStyle = toCss(o.ink === undefined ? P.uiInk : o.ink);
  ctx.lineWidth = 3;
  ctx.strokeRect(rx - 1.5, ry - 1.5, rw + 3, rh + 3);

  if (o.label) {
    drawText(ctx, o.label, rx + 7, ry + rh / 2, {
      size: Math.max(7, Math.round(rh * 0.62)), weight: 'body',
      color: P.uiWhite, baseline: 'middle',
      outline: P.uiInk, shadow: false,
    });
  }
  return { x: rx, y: ry, w: rw, h: rh };
}

/**
 * A cooldown disc: parchment token, icon, and a dark sweep that unwinds clockwise.
 * @param {object} o
 * @param {number} o.t 0 = ready, 1 = just spent
 * @param {number} [o.color] ability signature colour
 * @param {string} [o.icon]
 * @param {string} [o.key] key-cap label under the disc
 * @param {number} [o.cost] stamina cost, drawn as pips
 * @param {boolean} [o.ready]
 * @param {number} [o.pulse=0] 0..1 ready-pulse phase
 * @param {boolean} [o.locked]
 */
export function radialCooldown(ctx, cx, cy, r, o) {
  const color = o.color === undefined ? P.uiCyan : o.color;
  const t = clamp01(o.t || 0);
  const ready = o.ready !== false && t <= 0.0001 && !o.locked;

  if (ready && o.pulse) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * 0.35 * (1 - o.pulse);
    ctx.fillStyle = toCss(color);
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4 + o.pulse * 10, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = toCss(P.uiPaper);
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.fillStyle = toCss(mixHex(P.uiPaper, color, 0.28));
  ctx.beginPath(); ctx.arc(cx, cy, r - 3, 0, TAU); ctx.fill();

  icon(ctx, o.icon || 'star', cx - r * 0.62, cy - r * 0.62, r * 1.24,
    o.locked ? mixHex(P.uiInk, P.uiPaper, 0.55) : shadeDown(color, 0.9));

  if (t > 0.0001 || o.locked) {
    const frac = o.locked ? 1 : t;
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * 0.74;
    ctx.fillStyle = toCss(P.uiShadow);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r - 2, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = toCss(ready ? P.uiGold : shadeDown(P.uiInk, 0.2));
  ctx.lineWidth = ready ? 4 : 3;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();

  if (o.key) {
    keyCap(ctx, cx, cy + r + 4, String(o.key), { size: 10, centered: true });
  }
  if (o.cost) {
    const pips = Math.min(5, Math.max(1, Math.round(o.cost / 10)));
    for (let i = 0; i < pips; i++) {
      ctx.fillStyle = toCss(P.uiGreen);
      ctx.beginPath();
      ctx.arc(cx - (pips - 1) * 4 + i * 8, cy - r - 7, 3, 0, TAU);
      ctx.fill();
    }
  }
  if (!ready && !o.locked && o.seconds !== undefined && o.seconds > 0.05) {
    drawText(ctx, o.seconds >= 10 ? String(Math.ceil(o.seconds)) : o.seconds.toFixed(1),
      cx, cy + r * 0.1, {
        size: Math.round(r * 0.52), weight: 'display', color: P.uiWhite,
        align: 'center', baseline: 'middle', outline: P.uiInk, outlineWidth: 1,
      });
  }
}

/** A pressed wax seal. Doubles as the interface's primary button. */
export function waxSeal(ctx, cx, cy, r, o = {}) {
  const color = o.color === undefined ? P.uiRed : o.color;
  const seed = o.seed === undefined ? seedOf(cx, cy, r, 1) : o.seed;
  const lobes = 11;
  const p = new Path2D();
  for (let i = 0; i <= lobes; i++) {
    const a = (i / lobes) * TAU;
    const rr = r * (1 + wob(i % lobes, seed) * 0.09);
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    if (i === 0) p.moveTo(px, py); else p.lineTo(px, py);
  }
  p.closePath();
  ctx.save();
  ctx.translate(2, 3);
  ctx.globalAlpha = ctx.globalAlpha * 0.3;
  ctx.fillStyle = toCss(P.uiShadow);
  ctx.fill(p);
  ctx.restore();
  ctx.fillStyle = toCss(o.pressed ? shadeDown(color, 0.35) : color);
  ctx.fill(p);
  ctx.save();
  ctx.clip(p);
  ctx.fillStyle = toCss(shadeUp(color, 0.6), 0.55);
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.25, cy - r * 0.3, r * 0.7, r * 0.5, -0.5, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = toCss(shadeDown(color, 1.2));
  ctx.lineWidth = 3;
  ctx.stroke(p);
  if (o.icon) icon(ctx, o.icon, cx - r * 0.5, cy - r * 0.5, r, shadeDown(color, 1.35));
  else if (o.text) {
    drawText(ctx, o.text, cx, cy, {
      size: o.size || Math.round(r * 0.8), weight: 'display',
      color: o.textColor === undefined ? shadeUp(color, 1.1) : o.textColor,
      align: 'center', baseline: 'middle', outline: shadeDown(color, 1.4), outlineWidth: 1,
    });
  }
  return p;
}

/** A brushed ink stroke through a point list — used for underlines, ticks and signatures. */
export function inkStroke(ctx, pts, width = 4, color = P.uiInk, alpha = 1) {
  if (pts.length < 2) return;
  const pa = ctx.globalAlpha;
  ctx.globalAlpha = pa * alpha;
  ctx.strokeStyle = toCss(color);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Two passes with a slight offset gives the loaded-brush thickening a single stroke lacks.
  for (let pass = 0; pass < 2; pass++) {
    ctx.lineWidth = pass === 0 ? width : width * 0.55;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1] + pass * 0.8);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      ctx.quadraticCurveTo(a[0], a[1] + pass * 0.8, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + pass * 0.8);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1] + pass * 0.8);
    ctx.stroke();
  }
  ctx.globalAlpha = pa;
}

/**
 * A keyboard cap. Prompts are useless if the player cannot tell which key to press, and a
 * label that just says "E" gets lost against sand.
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function keyCap(ctx, x, y, label, o = {}) {
  const size = o.size || 13;
  const m = measure(label, size, 'display');
  const padX = Math.max(7, Math.round(size * 0.55));
  const w = Math.max(m.w + padX * 2, size + padX * 2);
  const h = m.h + Math.round(size * 0.5);
  const rx = Math.round(o.centered ? x - w / 2 : x);
  const ry = Math.round(y);
  const face = o.color === undefined ? P.uiPaper : o.color;
  ctx.fillStyle = toCss(shadeDown(face, 0.8));
  ctx.fill(roundRectPath(rx, ry + 3, w, h, 4));
  ctx.fillStyle = toCss(face);
  ctx.fill(roundRectPath(rx, ry, w, h, 4));
  ctx.strokeStyle = toCss(P.uiInk);
  ctx.lineWidth = 2.5;
  ctx.stroke(roundRectPath(rx, ry, w, h, 4));
  drawText(ctx, label, rx + w / 2, ry + h / 2, {
    size, weight: 'display', color: P.uiInk, align: 'center', baseline: 'middle',
  });
  return { x: rx, y: ry, w, h: h + 3 };
}

/** Small nail head — pins posters and notes to the board. */
export function nail(ctx, x, y, r = 6) {
  ctx.fillStyle = toCss(P.metalDark);
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  ctx.fillStyle = toCss(P.metal);
  ctx.beginPath(); ctx.arc(x - r * 0.22, y - r * 0.26, r * 0.6, 0, TAU); ctx.fill();
  ctx.fillStyle = toCss(P.uiShadow, 0.35);
  ctx.beginPath(); ctx.arc(x, y + r * 0.5, r * 0.5, 0, TAU); ctx.fill();
}

/** Full-screen scrim behind a menu. Warm, not neutral — a grey scrim greys the whole frame. */
export function scrim(ctx, w, h, alpha = 0.62) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, toCss(shadeDown(P.uiShadow, 0.5), alpha * 0.85));
  g.addColorStop(0.5, toCss(P.uiShadow, alpha));
  g.addColorStop(1, toCss(shadeDown(P.uiShadow, 0.9), alpha));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** A soft glow used by the tutorial to point at a live HUD element. */
export function highlight(ctx, x, y, w, h, color = P.uiGold, phase = 0) {
  const pad = 10 + Math.sin(phase * TAU) * 3;
  const pa = ctx.globalAlpha;
  const cx = x + w / 2, cy = y + h / 2;
  const rad = Math.max(w, h) * 0.75 + pad * 2;
  const g = ctx.createRadialGradient(cx, cy, Math.max(2, Math.min(w, h) * 0.3), cx, cy, rad);
  g.addColorStop(0, toCss(color, 0.34));
  g.addColorStop(1, toCss(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  ctx.globalAlpha = pa * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(phase * TAU)));
  ctx.strokeStyle = toCss(color);
  ctx.lineWidth = 3;
  ctx.setLineDash([9, 7]);
  ctx.lineDashOffset = -phase * 32;
  ctx.stroke(roundRectPath(x - pad, y - pad, w + pad * 2, h + pad * 2, 8));
  ctx.setLineDash([]);
  ctx.globalAlpha = pa;
}

// --------------------------------------------------------------------------------------
// Icons. Vector paths in unit space, drawn into a size x size box. No images, no emoji.
// Each is designed to survive being filled flat: a recognisable silhouette at 22px.
// --------------------------------------------------------------------------------------

const ICONS = {
  sword(c) {
    c.beginPath();
    c.moveTo(0.86, 0.06); c.lineTo(0.96, 0.16); c.lineTo(0.44, 0.72);
    c.lineTo(0.30, 0.62); c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(0.10, 0.64); c.lineTo(0.40, 0.86); c.lineTo(0.32, 0.95); c.lineTo(0.03, 0.74);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(0.24, 0.56); c.lineTo(0.46, 0.78); c.lineTo(0.36, 0.88); c.lineTo(0.14, 0.66);
    c.closePath(); c.fill();
    c.fillRect(0.02, 0.86, 0.14, 0.12);
  },
  shield(c) {
    c.beginPath();
    c.moveTo(0.5, 0.03); c.lineTo(0.93, 0.18); c.lineTo(0.88, 0.60);
    c.quadraticCurveTo(0.80, 0.88, 0.5, 0.98);
    c.quadraticCurveTo(0.20, 0.88, 0.12, 0.60);
    c.lineTo(0.07, 0.18); c.closePath(); c.fill();
  },
  boot(c) {
    c.beginPath();
    c.moveTo(0.22, 0.04); c.lineTo(0.55, 0.04); c.lineTo(0.58, 0.55);
    c.lineTo(0.94, 0.68); c.lineTo(0.96, 0.92); c.lineTo(0.14, 0.92);
    c.lineTo(0.14, 0.30); c.closePath(); c.fill();
  },
  heart(c) {
    c.beginPath();
    c.moveTo(0.5, 0.96);
    c.bezierCurveTo(-0.10, 0.55, 0.10, 0.05, 0.5, 0.30);
    c.bezierCurveTo(0.90, 0.05, 1.10, 0.55, 0.5, 0.96);
    c.closePath(); c.fill();
  },
  droplet(c) {
    c.beginPath();
    c.moveTo(0.5, 0.02);
    c.bezierCurveTo(0.86, 0.42, 0.94, 0.62, 0.86, 0.78);
    c.bezierCurveTo(0.74, 1.02, 0.26, 1.02, 0.14, 0.78);
    c.bezierCurveTo(0.06, 0.62, 0.14, 0.42, 0.5, 0.02);
    c.closePath(); c.fill();
  },
  flame(c) {
    c.beginPath();
    c.moveTo(0.5, 0.0);
    c.bezierCurveTo(0.78, 0.24, 0.66, 0.40, 0.72, 0.52);
    c.bezierCurveTo(0.80, 0.36, 0.92, 0.44, 0.90, 0.62);
    c.bezierCurveTo(0.90, 0.86, 0.72, 1.0, 0.5, 1.0);
    c.bezierCurveTo(0.26, 1.0, 0.10, 0.86, 0.10, 0.62);
    c.bezierCurveTo(0.10, 0.36, 0.36, 0.28, 0.5, 0.0);
    c.closePath(); c.fill();
  },
  snowflake(c) {
    c.lineWidth = 0.13; c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI;
      const dx = Math.cos(a) * 0.46, dy = Math.sin(a) * 0.46;
      c.beginPath(); c.moveTo(0.5 - dx, 0.5 - dy); c.lineTo(0.5 + dx, 0.5 + dy); c.stroke();
      for (const s of [1, -1]) {
        const bx = 0.5 + dx * s * 0.62, by = 0.5 + dy * s * 0.62;
        const pa2 = a + 0.9, pb = a - 0.9;
        c.beginPath(); c.moveTo(bx, by);
        c.lineTo(bx + Math.cos(pa2) * 0.2 * s, by + Math.sin(pa2) * 0.2 * s); c.stroke();
        c.beginPath(); c.moveTo(bx, by);
        c.lineTo(bx + Math.cos(pb) * 0.2 * s, by + Math.sin(pb) * 0.2 * s); c.stroke();
      }
    }
  },
  sandglass(c) {
    c.beginPath();
    c.moveTo(0.14, 0.04); c.lineTo(0.86, 0.04); c.lineTo(0.56, 0.5);
    c.lineTo(0.86, 0.96); c.lineTo(0.14, 0.96); c.lineTo(0.44, 0.5);
    c.closePath(); c.fill();
    c.fillRect(0.06, 0.0, 0.88, 0.1);
    c.fillRect(0.06, 0.9, 0.88, 0.1);
  },
  shockwave(c) {
    c.lineWidth = 0.11;
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.arc(0.5, 0.5, 0.16 + i * 0.16, -Math.PI * 0.78, Math.PI * 0.28);
      c.stroke();
    }
    c.beginPath(); c.arc(0.5, 0.5, 0.1, 0, TAU); c.fill();
  },
  gravity(c) {
    c.beginPath(); c.arc(0.5, 0.5, 0.19, 0, TAU); c.fill();
    c.lineWidth = 0.085;
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.ellipse(0.5, 0.5, 0.46 - i * 0.09, 0.20 - i * 0.05, (i * Math.PI) / 3, 0, TAU);
      c.stroke();
    }
  },
  anchor(c) {
    c.lineWidth = 0.12; c.lineCap = 'round';
    c.beginPath(); c.arc(0.5, 0.15, 0.12, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(0.5, 0.27); c.lineTo(0.5, 0.9); c.stroke();
    c.beginPath(); c.moveTo(0.22, 0.38); c.lineTo(0.78, 0.38); c.stroke();
    c.beginPath();
    c.moveTo(0.10, 0.62);
    c.quadraticCurveTo(0.14, 0.94, 0.5, 0.94);
    c.quadraticCurveTo(0.86, 0.94, 0.90, 0.62);
    c.stroke();
  },
  wheel(c) {
    c.lineWidth = 0.11;
    c.beginPath(); c.arc(0.5, 0.5, 0.31, 0, TAU); c.stroke();
    c.beginPath(); c.arc(0.5, 0.5, 0.1, 0, TAU); c.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + 0.2;
      const dx = Math.cos(a), dy = Math.sin(a);
      c.beginPath();
      c.moveTo(0.5 + dx * 0.1, 0.5 + dy * 0.1);
      c.lineTo(0.5 + dx * 0.47, 0.5 + dy * 0.47);
      c.stroke();
      c.beginPath(); c.arc(0.5 + dx * 0.47, 0.5 + dy * 0.47, 0.055, 0, TAU); c.fill();
    }
  },
  scroll(c) {
    c.beginPath();
    c.moveTo(0.16, 0.12); c.lineTo(0.84, 0.12); c.lineTo(0.84, 0.88); c.lineTo(0.16, 0.88);
    c.closePath(); c.fill();
    c.lineWidth = 0.1;
    c.beginPath(); c.moveTo(0.16, 0.12); c.quadraticCurveTo(0.02, 0.24, 0.16, 0.34); c.stroke();
    c.beginPath(); c.moveTo(0.84, 0.66); c.quadraticCurveTo(0.98, 0.78, 0.84, 0.88); c.stroke();
  },
  coin(c) {
    c.beginPath(); c.arc(0.5, 0.5, 0.44, 0, TAU); c.fill();
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.lineWidth = 0.07;
    c.beginPath(); c.arc(0.5, 0.5, 0.3, 0, TAU); c.stroke();
    c.fillRect(0.3, 0.44, 0.4, 0.07);
    c.fillRect(0.3, 0.6, 0.4, 0.07);
    c.restore();
  },
  skull(c) {
    c.beginPath();
    c.moveTo(0.5, 0.02);
    c.bezierCurveTo(0.92, 0.02, 0.96, 0.42, 0.86, 0.6);
    c.lineTo(0.72, 0.66); c.lineTo(0.72, 0.84); c.lineTo(0.28, 0.84); c.lineTo(0.28, 0.66);
    c.lineTo(0.14, 0.6);
    c.bezierCurveTo(0.04, 0.42, 0.08, 0.02, 0.5, 0.02);
    c.closePath(); c.fill();
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath(); c.ellipse(0.32, 0.40, 0.13, 0.15, 0, 0, TAU); c.fill();
    c.beginPath(); c.ellipse(0.68, 0.40, 0.13, 0.15, 0, 0, TAU); c.fill();
    c.beginPath(); c.moveTo(0.5, 0.55); c.lineTo(0.60, 0.70); c.lineTo(0.40, 0.70); c.closePath(); c.fill();
    c.fillRect(0.36, 0.76, 0.06, 0.1);
    c.fillRect(0.47, 0.76, 0.06, 0.1);
    c.fillRect(0.58, 0.76, 0.06, 0.1);
    c.restore();
  },
  compass(c) {
    c.lineWidth = 0.07;
    c.beginPath(); c.arc(0.5, 0.5, 0.46, 0, TAU); c.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + TAU / 8;
      c.beginPath();
      c.moveTo(0.5 + Math.cos(a) * 0.30, 0.5 + Math.sin(a) * 0.30);
      c.lineTo(0.5, 0.5);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(0.5, 0.02); c.lineTo(0.60, 0.44); c.lineTo(0.5, 0.98); c.lineTo(0.40, 0.44);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(0.02, 0.5); c.lineTo(0.44, 0.40); c.lineTo(0.98, 0.5); c.lineTo(0.44, 0.60);
    c.closePath(); c.fill();
  },
  crew(c) {
    const head = (x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); };
    const body = (x, y, w, h) => {
      c.beginPath();
      c.moveTo(x - w, y + h); c.quadraticCurveTo(x, y - h * 0.5, x + w, y + h); c.closePath(); c.fill();
    };
    head(0.22, 0.34, 0.15); body(0.22, 0.62, 0.21, 0.28);
    head(0.78, 0.34, 0.15); body(0.78, 0.62, 0.21, 0.28);
    head(0.5, 0.26, 0.18); body(0.5, 0.58, 0.26, 0.34);
  },
  chest(c) {
    c.beginPath();
    c.moveTo(0.06, 0.42);
    c.quadraticCurveTo(0.5, 0.02, 0.94, 0.42);
    c.lineTo(0.94, 0.52); c.lineTo(0.06, 0.52);
    c.closePath(); c.fill();
    c.fillRect(0.06, 0.56, 0.88, 0.38);
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillRect(0.42, 0.36, 0.16, 0.34);
    c.restore();
    c.fillRect(0.44, 0.44, 0.12, 0.2);
  },
  star(c) {
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * TAU;
      const r = i % 2 ? 0.20 : 0.48;
      const x = 0.5 + Math.cos(a) * r, y = 0.5 + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath(); c.fill();
  },
};
ICONS['gravity-well'] = ICONS.gravity;
ICONS['compass-rose'] = ICONS.compass;
ICONS['hourglass'] = ICONS.sandglass;
ICONS['helm'] = ICONS.wheel;
ICONS['quest'] = ICONS.scroll;
ICONS['berry'] = ICONS.coin;

/** Every icon name this module can draw. */
export const ICON_NAMES = Object.keys(ICONS);

/**
 * Draw a named vector icon into a size x size box with its top-left at (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name see ICON_NAMES
 * @param {number} [size=20]
 * @param {number|string} [color]
 * @param {{alpha?:number, stroke?:number, outline?:number}} [o]
 */
export function icon(ctx, name, x, y, size = 20, color = P.uiInk, o = {}) {
  const fn = ICONS[name] || ICONS.star;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  ctx.scale(size, size);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 0.1;
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
  if (o.outline !== undefined) {
    // Cheap silhouette halo: redraw the icon fattened behind itself.
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = toCss(o.outline);
    ctx.lineWidth = 0.26;
    ctx.translate(0.5, 0.5); ctx.scale(1.16, 1.16); ctx.translate(-0.5, -0.5);
    fn(ctx, o);
    ctx.restore();
  }
  ctx.fillStyle = toCss(color);
  ctx.strokeStyle = toCss(o.stroke === undefined ? color : o.stroke);
  fn(ctx, o);
  ctx.restore();
}

/** Colour for a telegraph class, respecting the colourblind-safe mode. */
export function telegraphColor(kind, cbMode = 'off') {
  const base = kind === 'danger' ? P.telegraphDanger : kind === 'guard' ? P.telegraphGuard : P.telegraphWarn;
  if (!cbMode || cbMode === 'off') return base;
  // Deuteranopia/protanopia cannot separate the red/orange pair, so push danger toward
  // magenta and guard toward blue; tritanopia loses blue/cyan, so push guard toward green.
  if (cbMode === 'tritan') {
    if (kind === 'guard') return shift(P.telegraphGuard, -0.16, 0.05, 0);
    if (kind === 'danger') return shift(P.telegraphDanger, 0.02, 0.05, -0.04);
    return shift(P.telegraphWarn, 0.03, 0, 0.08);
  }
  if (kind === 'danger') return shift(P.telegraphDanger, -0.075, 0.1, 0.02);
  if (kind === 'guard') return shift(P.telegraphGuard, 0.06, 0.1, -0.06);
  return shift(P.telegraphWarn, 0.02, 0, 0.1);
}

/** Shape hint that survives total colour loss: a distinct glyph per telegraph class. */
export function telegraphGlyph(ctx, kind, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = toCss(color);
  ctx.strokeStyle = toCss(color);
  ctx.lineWidth = Math.max(3, size * 0.16);
  ctx.lineJoin = 'round';
  if (kind === 'danger') {
    // triangle = unblockable
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.5); ctx.lineTo(size * 0.5, size * 0.42); ctx.lineTo(-size * 0.5, size * 0.42);
    ctx.closePath(); ctx.fill();
  } else if (kind === 'guard') {
    // square = parryable
    ctx.strokeRect(-size * 0.4, -size * 0.4, size * 0.8, size * 0.8);
  } else {
    // circle = dodgeable wind-up
    ctx.beginPath(); ctx.arc(0, 0, size * 0.42, 0, TAU); ctx.stroke();
  }
  ctx.restore();
}

/** Linear interpolation between two palette colours, exposed for callers that lack palette. */
export function mix(a, b, t) { return mixHex(a, b, clamp01(t)); }

/** Sub-shade helpers re-exported so UI modules never compose colours by hand. */
export { shadeUp, shadeDown, mixHex, lerp };
