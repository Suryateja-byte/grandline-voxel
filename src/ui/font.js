// The typeface. There are no font files in this project, so the letterforms live here as
// bitmaps and are rasterised as filled rectangles at integer scale.
//
// WHY bitmaps rather than Canvas2D `fillText`: the system font stack differs per machine, so
// text metrics (and therefore every panel that sizes itself to its label) would differ per
// machine, and capture would stop being bit-identical. A bitmap face is the same everywhere.
//
// WHY two weights: the bounty poster and headings need a heavy wood-type face with real
// presence; the HUD needs a compact face that stays legible at 14px over a bright sky. One
// face scaled up cannot do both — a thin face at poster size looks weedy, a fat face at HUD
// size closes its counters into blobs.
//
// Rasterisation rules that keep it crisp at 1080p:
//   * scale is an integer >= 1, chosen from the requested cap height
//   * pen positions are rounded to whole pixels before any rectangle is emitted
//   * runs of set pixels are merged horizontally then vertically, so a glyph is ~8 rects
//     rather than ~30, and the whole string fills as ONE Path2D
//
// Outline and drop shadow are not decoration: the HUD sits over #59B7EC sky and #F0DDB4 sand,
// and no single ink colour survives both. The outline ring is precomputed per glyph (a
// morphological dilation minus the glyph), so an outlined string costs two fills, not nine.

import { P } from '../gen/palette.js';

/** Low 24 bits of a palette integer — the RGB channels. Not a colour, a mask. */
const RGB_MASK = 0xffffff;

/** Rows are '#' (ink) and '.' (paper), joined by '/'. Trailing empty rows may be omitted. */

// --- compact body face: 5x7 cap box, 2 descender rows ------------------------------------
const BODY_GLYPHS = {
  'A': '.###./#...#/#...#/#####/#...#/#...#/#...#',
  'B': '####./#...#/#...#/####./#...#/#...#/####.',
  'C': '.####/#..../#..../#..../#..../#..../.####',
  'D': '####./#...#/#...#/#...#/#...#/#...#/####.',
  'E': '#####/#..../#..../####./#..../#..../#####',
  'F': '#####/#..../#..../####./#..../#..../#....',
  'G': '.####/#..../#..../#..##/#...#/#...#/.####',
  'H': '#...#/#...#/#...#/#####/#...#/#...#/#...#',
  'I': '#####/..#../..#../..#../..#../..#../#####',
  'J': '..###/...#./...#./...#./...#./#..#./.##..',
  'K': '#...#/#..#./#.#../##.../#.#../#..#./#...#',
  'L': '#..../#..../#..../#..../#..../#..../#####',
  'M': '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  'N': '#...#/##..#/#.#.#/#.#.#/#..##/#...#/#...#',
  'O': '.###./#...#/#...#/#...#/#...#/#...#/.###.',
  'P': '####./#...#/#...#/####./#..../#..../#....',
  'Q': '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  'R': '####./#...#/#...#/####./#.#../#..#./#...#',
  'S': '.####/#..../#..../.###./....#/....#/####.',
  'T': '#####/..#../..#../..#../..#../..#../..#..',
  'U': '#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  'V': '#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  'W': '#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  'X': '#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  'Y': '#...#/#...#/.#.#./..#../..#../..#../..#..',
  'Z': '#####/....#/...#./..#../.#.../#..../#####',

  'a': '...../...../.###./....#/.####/#...#/.####',
  'b': '#..../#..../####./#...#/#...#/#...#/####.',
  'c': '...../...../.####/#..../#..../#..../.####',
  'd': '....#/....#/.####/#...#/#...#/#...#/.####',
  'e': '...../...../.###./#...#/#####/#..../.###.',
  'f': '..##./.#.../####./.#.../.#.../.#.../.#...',
  'g': '...../...../.####/#...#/#...#/#...#/.####/....#/.###.',
  'h': '#..../#..../####./#...#/#...#/#...#/#...#',
  'i': '..#../...../.##../..#../..#../..#../.###.',
  'j': '...#./...../..##./...#./...#./...#./...#./#..#./.##..',
  'k': '#..../#..../#..#./#.#../##.../#.#../#..#.',
  'l': '.##../..#../..#../..#../..#../..#../.###.',
  'm': '...../...../##.#./#.#.#/#.#.#/#.#.#/#.#.#',
  'n': '...../...../####./#...#/#...#/#...#/#...#',
  'o': '...../...../.###./#...#/#...#/#...#/.###.',
  'p': '...../...../####./#...#/#...#/#...#/####./#..../#....',
  'q': '...../...../.####/#...#/#...#/#...#/.####/....#/....#',
  'r': '...../...../#.##./##.../#..../#..../#....',
  's': '...../...../.####/#..../.###./....#/####.',
  't': '.#.../.#.../####./.#.../.#.../.#.../..##.',
  'u': '...../...../#...#/#...#/#...#/#...#/.####',
  'v': '...../...../#...#/#...#/#...#/.#.#./..#..',
  'w': '...../...../#...#/#.#.#/#.#.#/#.#.#/.#.#.',
  'x': '...../...../#...#/.#.#./..#../.#.#./#...#',
  'y': '...../...../#...#/#...#/#...#/.####/....#/....#/.###.',
  'z': '...../...../#####/...#./..#../.#.../#####',

  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '..#../.##../..#../..#../..#../..#../.###.',
  '2': '.###./#...#/....#/...#./..#../.#.../#####',
  '3': '####./....#/....#/.###./....#/....#/####.',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '#####/#..../####./....#/....#/#...#/.###.',
  '6': '..##./.#.../#..../####./#...#/#...#/.###.',
  '7': '#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '.###./#...#/#...#/.####/....#/...#./.##..',

  '.': '...../...../...../...../...../.##../.##..',
  ',': '...../...../...../...../...../.##../.##../.#.../#....',
  '!': '..#../..#../..#../..#../..#../...../..#..',
  '?': '.###./#...#/....#/..##./..#../...../..#..',
  "'": '..#../..#../.#...',
  '"': '.#.#./.#.#./#.#..',
  ':': '...../...../.##../.##../...../.##../.##..',
  ';': '...../...../.##../.##../...../.##../.##../.#.../#....',
  '-': '...../...../...../#####/...../...../.....',
  '+': '...../..#../..#../#####/..#../..#../.....',
  '/': '....#/....#/...#./..#../.#.../#..../#....',
  '%': '##..#/##.#./...#./..#../.#.../#..##/...##',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '.#.../..#../...#./...#./...#./..#../.#...',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###.',
  ']': '.###./...#./...#./...#./...#./...#./.###.',
  '*': '...../..#../#.#.#/.###./#.#.#/..#../.....',
  '#': '.#.#./.#.#./#####/.#.#./#####/.#.#./.#.#.',
  '&': '.##../#..#./#..#./.##../#.#.#/#..#./.##.#',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###.',
  '$': '..#../.####/#.#../.###./..#.#/####./..#..',
  '=': '...../...../#####/...../#####/...../.....',
  '_': '...../...../...../...../...../...../#####',
  '<': '...#./..#../.#.../#..../.#.../..#../...#.',
  '>': '.#.../..#../...#./....#/...#./..#../.#...',
  // Berry. A B crossed by two bars — the currency mark of the Grand Line.
  'Ƀ': '####./#...#/#####/####./#####/#...#/####.',
};

// --- chunky display face: 7x9 cap box, 2 descender rows ----------------------------------
const DISPLAY_GLYPHS = {
  'A': '..###../.#####./##...##/##...##/##...##/#######/#######/##...##/##...##',
  'B': '######./#######/##...##/######./######./##...##/##...##/#######/######.',
  'C': '.#####./#######/##...##/##...../##...../##...../##...##/#######/.#####.',
  'D': '######./#######/##...##/##...##/##...##/##...##/##...##/#######/######.',
  'E': '#######/#######/##...../######./######./##...../##...../#######/#######',
  'F': '#######/#######/##...../##...../######./######./##...../##...../##.....',
  'G': '.#####./#######/##...##/##...../##.####/##...##/##...##/#######/.#####.',
  'H': '##...##/##...##/##...##/#######/#######/##...##/##...##/##...##/##...##',
  'I': '#######/#######/..###../..###../..###../..###../..###../#######/#######',
  'J': '..#####/..#####/....##./....##./....##./....##./##..##./#####../.###...',
  'K': '##...##/##..##./##.##../#####../####.../#####../##.##../##..##./##...##',
  'L': '##...../##...../##...../##...../##...../##...../##...../#######/#######',
  'M': '##...##/###.###/#######/##.#.##/##...##/##...##/##...##/##...##/##...##',
  'N': '##...##/###..##/####.##/##.####/##..###/##...##/##...##/##...##/##...##',
  'O': '.#####./#######/##...##/##...##/##...##/##...##/##...##/#######/.#####.',
  'P': '######./#######/##...##/##...##/#######/######./##...../##...../##.....',
  'Q': '.#####./#######/##...##/##...##/##...##/##.#.##/##..###/#######/.######',
  'R': '######./#######/##...##/##...##/#######/#####../##.##../##..##./##...##',
  'S': '.#####./#######/##...##/##...../.#####./.....##/##...##/#######/.#####.',
  'T': '#######/#######/..###../..###../..###../..###../..###../..###../..###..',
  'U': '##...##/##...##/##...##/##...##/##...##/##...##/##...##/#######/.#####.',
  'V': '##...##/##...##/##...##/##...##/##...##/.##.##./.##.##./..###../...#...',
  'W': '##...##/##...##/##...##/##...##/##.#.##/##.#.##/#######/###.###/##...##',
  'X': '##...##/##...##/.##.##./..###../..###../..###../.##.##./##...##/##...##',
  'Y': '##...##/##...##/.##.##./..###../..###../..###../..###../..###../..###..',
  'Z': '#######/#######/....##./...##../..##.../.##..../##...../#######/#######',

  'a': '......./......./......./.#####./##...##/....###/.######/##...##/.######',
  'b': '##...../##...../##...../######./#######/##...##/##...##/#######/######.',
  'c': '......./......./......./.######/#######/##...../##...../#######/.######',
  'd': '.....##/.....##/.....##/.######/#######/##...##/##...##/#######/.######',
  'e': '......./......./......./.#####./##...##/#######/##...../#######/.#####.',
  'f': '...####/..#####/..##.../######./######./..##.../..##.../..##.../..##...',
  'g': '......./......./......./.######/#######/##...##/##...##/.######/.....##/##..##./.####..',
  'h': '##...../##...../##...../######./#######/##...##/##...##/##...##/##...##',
  'i': '..##.../..##.../......./.###.../..##.../..##.../..##.../..##.../.#####.',
  'j': '....##./....##./......./..####./....##./....##./....##./....##./....##./##..##./.####..',
  'k': '##...../##...../##...../##..##./##.##../####.../#####../##.##../##..##.',
  'l': '.###.../..##.../..##.../..##.../..##.../..##.../..##.../..###../..####.',
  'm': '......./......./......./#######/#######/##.#.##/##.#.##/##.#.##/##.#.##',
  'n': '......./......./......./######./#######/##...##/##...##/##...##/##...##',
  'o': '......./......./......./.#####./#######/##...##/##...##/#######/.#####.',
  'p': '......./......./......./######./#######/##...##/##...##/#######/######./##...../##.....',
  'q': '......./......./......./.######/#######/##...##/##...##/#######/.######/.....##/.....##',
  'r': '......./......./......./##.####/#######/###..../##...../##...../##.....',
  's': '......./......./......./.######/#######/##...../.#####./.....##/######.',
  't': '......./..##.../..##.../######./######./..##.../..##.../..###../...###.',
  'u': '......./......./......./##...##/##...##/##...##/##...##/#######/.######',
  'v': '......./......./......./##...##/##...##/##...##/.##.##./.##.##./..###..',
  'w': '......./......./......./##...##/##...##/##.#.##/##.#.##/#######/.##.##.',
  'x': '......./......./......./##...##/.##.##./..###../..###../.##.##./##...##',
  'y': '......./......./......./##...##/##...##/##...##/##...##/#######/.######/.....##/.#####.',
  'z': '......./......./......./#######/#######/...###./.###.../#######/#######',

  '0': '.#####./#######/##...##/##..###/##.####/####.##/###..##/#######/.#####.',
  '1': '...##../..###../.####../...##../...##../...##../...##../#######/#######',
  '2': '.#####./#######/##...##/....###/..###../.###.../##...../#######/#######',
  '3': '######./#######/....##./.#####./.#####./....##./....##./#######/######.',
  '4': '....##./...###./..####./.##.##./##..##./#######/#######/....##./....##.',
  '5': '#######/#######/##...../######./#######/....##./##..##./#######/.#####.',
  '6': '..####./.#####./##...../######./#######/##...##/##...##/#######/.#####.',
  '7': '#######/#######/....##./...##../..##.../..##.../.##..../.##..../.##....',
  '8': '.#####./#######/##...##/.#####./.#####./##...##/##...##/#######/.#####.',
  '9': '.#####./#######/##...##/#######/.######/....##./....##./.#####./.####..',

  '.': '......./......./......./......./......./......./......./.###.../.###...',
  ',': '......./......./......./......./......./......./......./.###.../.###.../..##.../.##....',
  '!': '..###../..###../..###../..###../..###../..###../......./..###../..###..',
  '?': '.#####./#######/##...##/....###/..####./..##.../......./..###../..###..',
  "'": '..###../..###../..##...',
  '"': '.##.##./.##.##./.#..#..',
  ':': '......./......./..###../..###../......./..###../..###..',
  ';': '......./......./..###../..###../......./..###../..###../..##.../.##....',
  '-': '......./......./......./......./######./######./.......',
  '+': '......./......./..###../..###../#######/#######/..###../..###..',
  '/': '.....##/.....##/....##./...##../...##../..##.../.##..../##...../##.....',
  '%': '##...##/##..##./....##./...##../..##.../.##..../##...../##..###/....###',
  '(': '...##../..##.../.##..../.##..../.##..../.##..../.##..../..##.../...##..',
  ')': '..##.../...##../....##./....##./....##./....##./....##./...##../..##...',
  '[': '.#####./.#####./.##..../.##..../.##..../.##..../.##..../.#####./.#####.',
  ']': '.#####./.#####./....##./....##./....##./....##./....##./.#####./.#####.',
  '*': '......./..###../##.#.##/.#####./..###../.#####./##.#.##/..###..',
  '#': '......./.##.##./.##.##./#######/.##.##./.##.##./#######/.##.##./.##.##.',
  '&': '.####../##..##./##..##./.####../###..../##.#.##/##..###/###.##./.####.#',
  '@': '.#####./##...##/##.####/##.#.##/##.#.##/##.####/##...../##...##/.#####.',
  '$': '...##../.#####./##.##../.#####./..####./...####/..##.##/.#####./...##..',
  '=': '......./......./......./######./######./......./######./######.',
  '_': '......./......./......./......./......./......./......./......./#######',
  '<': '......./....##./...##../..##.../##...../..##.../...##../....##.',
  '>': '......./.##..../..##.../...##../.....##/...##../..##.../.##....',
  // Berry, poster weight: the bars run the full width so it reads at 90px.
  'Ƀ': '.#####./.######/#######/.##..##/.#####./#######/.##..##/.######/.#####.',
};

/** The berry currency mark. Concatenate it with a commified amount. */
export const BERRY = 'Ƀ';

const FACE_SPECS = {
  body: { glyphs: BODY_GLYPHS, cellW: 5, cellH: 9, baseline: 7, gap: 1, spaceAdv: 3 },
  display: { glyphs: DISPLAY_GLYPHS, cellW: 7, cellH: 11, baseline: 9, gap: 2, spaceAdv: 5 },
};

/** Merge horizontal runs, then merge vertically identical runs into taller rects. */
function buildRuns(grid, w, h, xOff, yOff) {
  const flat = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!grid[y][x]) { x++; continue; }
      let n = 0;
      while (x + n < w && grid[y][x + n]) n++;
      flat.push({ x: x + xOff, y: y + yOff, w: n, h: 1 });
      x += n;
    }
  }
  const out = [];
  const used = new Uint8Array(flat.length);
  for (let i = 0; i < flat.length; i++) {
    if (used[i]) continue;
    const r = flat[i];
    for (let j = i + 1; j < flat.length; j++) {
      if (used[j]) continue;
      const s = flat[j];
      if (s.y === r.y + r.h && s.x === r.x && s.w === r.w) { r.h++; used[j] = 1; }
      else if (s.y > r.y + r.h) break;
    }
    out.push(r);
  }
  return out;
}

/** Chebyshev dilation of `grid` by `rad`, minus the glyph itself. Used for the outline ring. */
function buildRing(grid, w, h, rad, xOff) {
  const ew = w + rad * 2, eh = h + rad * 2;
  const ring = [];
  for (let y = 0; y < eh; y++) {
    const row = new Uint8Array(ew);
    ring.push(row);
  }
  for (let y = 0; y < eh; y++) {
    for (let x = 0; x < ew; x++) {
      const gx = x - rad, gy = y - rad;
      if (gy >= 0 && gy < h && gx >= 0 && gx < w && grid[gy][gx]) continue;
      let hit = false;
      for (let dy = -rad; dy <= rad && !hit; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const sx = gx + dx, sy = gy + dy;
          if (sy >= 0 && sy < h && sx >= 0 && sx < w && grid[sy][sx]) { hit = true; break; }
        }
      }
      if (hit) ring[y][x] = 1;
    }
  }
  return buildRuns(ring, ew, eh, xOff - rad, -rad);
}

function compileGlyph(src, spec) {
  const rows = String(src).split('/');
  const grid = [];
  for (let y = 0; y < spec.cellH; y++) {
    const line = rows[y] || '';
    const row = new Uint8Array(spec.cellW);
    for (let x = 0; x < spec.cellW; x++) row[x] = line.charCodeAt(x) === 35 ? 1 : 0;
    grid.push(row);
  }
  let minX = spec.cellW, maxX = -1;
  for (let y = 0; y < spec.cellH; y++) {
    for (let x = 0; x < spec.cellW; x++) {
      if (grid[y][x]) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  if (maxX < 0) return { w: 0, adv: spec.spaceAdv, runs: [], ring: [null, null, null] };
  const w = maxX - minX + 1;
  const sub = grid.map((row) => row.slice(minX, maxX + 1));
  return {
    w,
    adv: w + spec.gap,
    runs: buildRuns(sub, w, spec.cellH, 0, 0),
    // ring[1] and ring[2] are 1px and 2px outlines, built once and reused every frame.
    ring: [null, buildRing(sub, w, spec.cellH, 1, 0), buildRing(sub, w, spec.cellH, 2, 0)],
  };
}

function compileFace(name) {
  const spec = FACE_SPECS[name];
  const glyphs = new Map();
  for (const ch of Object.keys(spec.glyphs)) glyphs.set(ch, compileGlyph(spec.glyphs[ch], spec));
  glyphs.set(' ', { w: 0, adv: spec.spaceAdv, runs: [], ring: [null, null, null] });
  return {
    name, glyphs, cellH: spec.cellH, baseline: spec.baseline, gap: spec.gap,
    // Cap height in design units is exactly the baseline row index.
    cap: spec.baseline, descent: spec.cellH - spec.baseline,
    fallback: glyphs.get('?'),
  };
}

const FACES = { body: compileFace('body'), display: compileFace('display') };

/** @returns {{glyphs:Map,cap:number,cellH:number,baseline:number,descent:number}} */
export function face(weight) {
  return weight === 'display' || weight === 'bold' ? FACES.display : FACES.body;
}

/** Integer raster scale for a requested cap height in CSS pixels. Never below 1. */
export function scaleFor(size, weight) {
  const f = face(weight);
  return Math.max(1, Math.round(size / f.cap));
}

/** '#rrggbb' from a palette integer, with optional alpha -> rgba(). */
export function toCss(color, alpha) {
  if (typeof color === 'string') return color;
  const n = color >>> 0;
  if (alpha === undefined || alpha >= 1) {
    return '#' + (n & RGB_MASK).toString(16).padStart(6, '0');
  }
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, alpha)})`;
}

function glyphOf(f, ch) {
  return f.glyphs.get(ch) || f.fallback;
}

/** Width in pixels of a single line at a given integer scale. */
function lineWidth(f, text, s) {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += glyphOf(f, text[i]).adv * s;
  return w > 0 ? w - f.gap * s : 0;
}

/** Greedy word wrap. Words longer than maxWidth are hard-broken rather than overflowing. */
function wrap(f, text, s, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    if (!maxWidth || maxWidth <= 0) { lines.push(para); continue; }
    const words = para.split(' ');
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const cand = cur ? cur + ' ' + words[i] : words[i];
      if (lineWidth(f, cand, s) <= maxWidth || !cur) {
        if (lineWidth(f, cand, s) > maxWidth && !cur) {
          // single word too long: hard-break it
          let chunk = '';
          for (const ch of words[i]) {
            if (lineWidth(f, chunk + ch, s) > maxWidth && chunk) { lines.push(chunk); chunk = ch; }
            else chunk += ch;
          }
          cur = chunk;
        } else cur = cand;
      } else { lines.push(cur); cur = words[i]; }
    }
    lines.push(cur);
  }
  return lines;
}

/**
 * Measure a string without drawing it.
 * @param {string} text
 * @param {number} size cap height in CSS pixels (snapped to an integer glyph scale)
 * @param {'body'|'display'} [weight]
 * @param {{maxWidth?:number, lineHeight?:number}} [opts]
 * @returns {{w:number,h:number,scale:number,lines:string[],lineH:number,ascent:number,descent:number}}
 */
export function measure(text, size, weight = 'body', opts = {}) {
  const f = face(weight);
  const s = scaleFor(size, weight);
  const lines = wrap(f, text, s, opts.maxWidth);
  const lineH = Math.round(opts.lineHeight ? opts.lineHeight : f.cap * s * 1.5);
  let w = 0;
  for (const ln of lines) w = Math.max(w, lineWidth(f, ln, s));
  return {
    w, h: lines.length > 1 ? lineH * (lines.length - 1) + f.cellH * s : f.cellH * s,
    scale: s, lines, lineH, ascent: f.cap * s, descent: f.descent * s,
  };
}

function emitLine(path, f, text, px, py, s) {
  let x = px;
  for (let i = 0; i < text.length; i++) {
    const g = glyphOf(f, text[i]);
    for (let r = 0; r < g.runs.length; r++) {
      const run = g.runs[r];
      path.rect(x + run.x * s, py + run.y * s, run.w * s, run.h * s);
    }
    x += g.adv * s;
  }
}

function emitRing(path, f, text, px, py, s, rad) {
  let x = px;
  for (let i = 0; i < text.length; i++) {
    const g = glyphOf(f, text[i]);
    const ring = g.ring[rad];
    if (ring) {
      for (let r = 0; r < ring.length; r++) {
        const run = ring[r];
        path.rect(x + run.x * s, py + run.y * s, run.w * s, run.h * s);
      }
    }
    x += g.adv * s;
  }
}

/**
 * Draw text as filled rectangles.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x anchor x (meaning set by `align`)
 * @param {number} y anchor y (meaning set by `baseline`)
 * @param {object} [o]
 * @param {number} [o.size=16] cap height in px
 * @param {'body'|'display'} [o.weight='body']
 * @param {number|string} [o.color] fill colour (palette int)
 * @param {'left'|'center'|'right'} [o.align='left']
 * @param {'top'|'middle'|'alphabetic'|'bottom'} [o.baseline='top']
 * @param {number|string|false} [o.shadow] drop-shadow colour, offset by `shadowOffset` units
 * @param {number} [o.shadowOffset=1] shadow offset in design units
 * @param {number|string|false} [o.outline] outline colour
 * @param {1|2} [o.outlineWidth=1] outline thickness in design units
 * @param {number} [o.maxWidth] wrap width in px
 * @param {number} [o.lineHeight] line advance in px
 * @param {number} [o.alpha=1]
 * @returns {{w:number,h:number,scale:number,lines:string[],lineH:number}} the measured block
 */
export function drawText(ctx, text, x, y, o = {}) {
  const size = o.size || 16;
  const weight = o.weight || 'body';
  const f = face(weight);
  const m = measure(text, size, weight, o);
  const s = m.scale;
  const alpha = o.alpha === undefined ? 1 : o.alpha;
  if (alpha <= 0) return m;

  let py = Math.round(y);
  if (o.baseline === 'middle') py = Math.round(y - (f.cap * s) / 2);
  else if (o.baseline === 'alphabetic') py = Math.round(y - f.cap * s);
  else if (o.baseline === 'bottom') py = Math.round(y - m.h);

  const body = new Path2D();
  const ringPath = o.outline ? new Path2D() : null;
  const shadowPath = o.shadow ? new Path2D() : null;
  const so = (o.shadowOffset === undefined ? 1 : o.shadowOffset) * s;
  const rad = o.outlineWidth === 2 ? 2 : 1;

  for (let i = 0; i < m.lines.length; i++) {
    const ln = m.lines[i];
    const lw = lineWidth(f, ln, s);
    let px = Math.round(x);
    if (o.align === 'center') px = Math.round(x - lw / 2);
    else if (o.align === 'right') px = Math.round(x - lw);
    const ly = py + i * m.lineH;
    if (shadowPath) emitLine(shadowPath, f, ln, px + so, ly + so, s);
    if (ringPath) emitRing(ringPath, f, ln, px, ly, s, rad);
    emitLine(body, f, ln, px, ly, s);
  }

  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
  if (shadowPath) { ctx.fillStyle = toCss(o.shadow, o.shadowAlpha); ctx.fill(shadowPath); }
  if (ringPath) { ctx.fillStyle = toCss(o.outline); ctx.fill(ringPath); }
  ctx.fillStyle = toCss(o.color === undefined ? P.uiInk : o.color);
  ctx.fill(body);
  ctx.globalAlpha = prevAlpha;
  return m;
}

/**
 * Draw text scaled to fit a width, dropping the requested size until it fits (integer scales
 * only, so it snaps rather than squashes). Returns the size actually used.
 */
export function drawTextFit(ctx, text, x, y, maxW, o = {}) {
  let size = o.size || 16;
  const weight = o.weight || 'body';
  while (size > 6 && measure(text, size, weight).w > maxW) size -= Math.max(1, face(weight).cap);
  drawText(ctx, text, x, y, Object.assign({}, o, { size }));
  return size;
}

/** Every character the typeface can draw. Used by the self-check. */
export function charset(weight) {
  return Array.from(face(weight).glyphs.keys()).sort().join('');
}
