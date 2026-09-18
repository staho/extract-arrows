#!/usr/bin/env node
// Arrow puzzle generator.
//
// Emits a static arrows.json describing a set of "arrows" that completely fill a
// 3D shape (every cell belongs to exactly one arrow). Each arrow is a chain of
// cells (it may bend) with a head at one end. Cells are stored head-first:
// cells[0] is the head, the rest is the body. The head's facing direction is
// cells[0] - cells[1].
//
// Extraction model: an arrow slides as a rigid piece in the direction its head
// points until it leaves the shape. The corridor ahead of every cell must be
// clear, so two arrows aimed at each other deadlock.
//
// Generation peels one "stamp" at a time off the remaining solid. A stamp is a
// small shadow-closed polycube on the current skyline (1–3 adjacent columns,
// depths summing to 3–6). Multi-column stamps become U / L / S snakes; they
// still extract in the peel direction because every occupied column is filled
// out to the exposed face. The peel axis is re-rolled every stamp so arrows
// do not form a parallel forest. Playing carve-order solves the packing.
//
// Usage:
//   node generate-arrows.mjs [outfile] [--seed=S] [--out=FILE]
//                            [--attempts=N] [--min-bent=0.55]
//
// The same --seed always produces the same arrows.json. If no seed is given a
// random one is drawn and printed, so any run can be reproduced afterwards.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { out: null, seed: null, attempts: 40, minBent: 0.55 };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      opts.out = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq === -1 ? "" : arg.slice(eq + 1);
    switch (name) {
      case "seed":
        opts.seed = val;
        break;
      case "out":
        opts.out = val;
        break;
      case "attempts":
        opts.attempts = Math.max(1, parseInt(val, 10) || 40);
        break;
      case "min-bent":
        opts.minBent = Math.min(1, Math.max(0, parseFloat(val) || 0));
        break;
      default:
        console.error(`unknown option --${name}`);
        process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

// FNV-1a over a string; also folds an extra integer (used for per-attempt
// sub-seeds so that "seed X, attempt 3" is stable across runs).
function hashSeed(str, extra = 0) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= extra;
  h = Math.imul(h, 0x01000193);
  return h >>> 0;
}

// xoshiro128** seeded via splitmix32.
function makeRng(seed32) {
  let sm = seed32 >>> 0;
  const splitmix = () => {
    sm = (sm + 0x9e3779b9) >>> 0;
    let z = sm;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = splitmix();
  let b = splitmix();
  let c = splitmix();
  let d = splitmix();
  if ((a | b | c | d) === 0) d = 1;

  const nextU32 = () => {
    const r = Math.imul(b, 5);
    const result = Math.imul((r << 7) | (r >>> 25), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return result;
  };

  return {
    // float in [0, 1)
    next: () => nextU32() / 4294967296,
    // integer in [0, n)
    int: (n) => Math.floor((nextU32() / 4294967296) * n),
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

// Module-level handle, rebound per attempt. All randomness goes through it;
// Math.random must never be used in this file.
let rng = makeRng(0);
const randInt = (n) => rng.int(n);
const shuffle = (arr) => rng.shuffle(arr);

// ---------------------------------------------------------------------------
// Shape: the solid being packed. Everything spatial goes through this so a
// non-cubic shape can be dropped in later without touching the carver.
// ---------------------------------------------------------------------------

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function axisOf(dir) {
  if (dir[0]) return 0;
  if (dir[1]) return 1;
  return 2;
}

class CubeShape {
  constructor(grid, cell) {
    this.grid = grid;
    this.cell = cell;
    this.N = grid * grid * grid;
  }
  idx(x, y, z) {
    const g = this.grid;
    return (x * g + y) * g + z;
  }
  cellOf(i) {
    const g = this.grid;
    return [Math.floor(i / (g * g)), Math.floor(i / g) % g, i % g];
  }
  // Inside the bounding lattice. Coordinates outside are "free space" a piece
  // can slide into.
  inBounds(x, y, z) {
    const g = this.grid;
    return x >= 0 && x < g && y >= 0 && y < g && z >= 0 && z < g;
  }
  // Part of the solid. For a cube every bounded cell is solid; other shapes
  // override this.
  has(x, y, z) {
    return this.inBounds(x, y, z);
  }
  *cells() {
    const g = this.grid;
    for (let x = 0; x < g; x++)
      for (let y = 0; y < g; y++)
        for (let z = 0; z < g; z++) yield [x, y, z];
  }
  neighborsOf([x, y, z]) {
    const out = [];
    if (this.has(x + 1, y, z)) out.push([x + 1, y, z]);
    if (this.has(x - 1, y, z)) out.push([x - 1, y, z]);
    if (this.has(x, y + 1, z)) out.push([x, y + 1, z]);
    if (this.has(x, y - 1, z)) out.push([x, y - 1, z]);
    if (this.has(x, y, z + 1)) out.push([x, y, z + 1]);
    if (this.has(x, y, z - 1)) out.push([x, y, z - 1]);
    return out;
  }
  // Metadata the renderer needs.
  header() {
    return { grid: this.grid, cell: this.cell };
  }
}

// ---------------------------------------------------------------------------
// Frontier: the set of still-unassigned cells, plus one bitmask per lattice
// column on each axis so ray / exposed-face queries are O(1) instead of a
// walk. Requires grid <= 32.
// ---------------------------------------------------------------------------

class Frontier {
  constructor(shape) {
    this.shape = shape;
    this.remaining = new Set();
    const g = shape.grid;
    if (g > 32) throw new Error("Frontier bitmasks need grid <= 32");
    // masks[axis][a * g + b] : bit t set  <=>  cell with coord[axis] = t remains
    this.masks = [new Uint32Array(g * g), new Uint32Array(g * g), new Uint32Array(g * g)];
    for (const c of shape.cells()) this.add(shape.idx(c[0], c[1], c[2]));
  }
  get size() {
    return this.remaining.size;
  }
  has(id) {
    return this.remaining.has(id);
  }
  [Symbol.iterator]() {
    return this.remaining[Symbol.iterator]();
  }
  _touch(id, on) {
    const g = this.shape.grid;
    const c = this.shape.cellOf(id);
    for (let axis = 0; axis < 3; axis++) {
      const a = c[(axis + 1) % 3];
      const b = c[(axis + 2) % 3];
      const bit = 1 << c[axis];
      const k = a * g + b;
      if (on) this.masks[axis][k] |= bit;
      else this.masks[axis][k] &= ~bit;
    }
  }
  add(id) {
    if (this.remaining.has(id)) return;
    this.remaining.add(id);
    this._touch(id, true);
  }
  delete(id) {
    if (!this.remaining.has(id)) return;
    this.remaining.delete(id);
    this._touch(id, false);
  }
  colMask(axis, a, b) {
    return this.masks[axis][a * this.shape.grid + b];
  }
  // Remaining cells in one column, ordered from the exposed end inward,
  // stopping at the first gap so the prefix is always shadow-closed in `dir`.
  exposedRun(dir, a, b) {
    const axis = axisOf(dir);
    const sign = dir[axis];
    const A = (axis + 1) % 3;
    const B = (axis + 2) % 3;
    const g = this.shape.grid;
    const mask = this.colMask(axis, a, b);
    const cells = [];
    const t0 = sign > 0 ? g - 1 : 0;
    const step = sign > 0 ? -1 : 1;
    for (let t = t0; t >= 0 && t < g; t += step) {
      if (mask & (1 << t)) {
        const c = [0, 0, 0];
        c[axis] = t;
        c[A] = a;
        c[B] = b;
        cells.push(c);
      } else if (cells.length) break;
    }
    return cells;
  }
  // Rigid slide test: every cell of `cells` must see only itself or empty
  // space along `dir` until it leaves the lattice. Because piece ⊆ remaining,
  // "everything remaining beyond c is in the piece" is exactly
  //   (colMask & beyond(c)) & ~pieceMask === 0.
  canExtract(cells, dir) {
    const axis = axisOf(dir);
    const sign = dir[axis];
    const A = (axis + 1) % 3;
    const B = (axis + 2) % 3;
    const g = this.shape.grid;
    const self = new Map();
    for (const c of cells) {
      const k = c[A] * g + c[B];
      self.set(k, (self.get(k) || 0) | (1 << c[axis]));
    }
    for (const c of cells) {
      const k = c[A] * g + c[B];
      const t = c[axis];
      const beyond = sign > 0 ? ~((1 << (t + 1)) - 1) >>> 0 : (1 << t) - 1;
      const other = (this.masks[axis][k] & beyond & ~self.get(k)) >>> 0;
      if (other !== 0) return false;
    }
    return true;
  }
  // Materialize as a plain Set (for hypothetical "what remains after this
  // piece" checks).
  toSet() {
    return new Set(this.remaining);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRID = 10;
const CELL = 1.15;
const PALETTE_SIZE = 6;
const MIN_LEN = 3;
const MAX_LEN = 6;

const shape = new CubeShape(GRID, CELL);
const N = shape.N;

const key = (c) => shape.idx(c[0], c[1], c[2]);
const neighborsOf = (c) => shape.neighborsOf(c);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function isStraight(cells) {
  if (cells.length < 2) return true;
  const dx = cells[1][0] - cells[0][0];
  const dy = cells[1][1] - cells[0][1];
  const dz = cells[1][2] - cells[0][2];
  for (let i = 1; i < cells.length; i++) {
    if (
      cells[i][0] - cells[i - 1][0] !== dx ||
      cells[i][1] - cells[i - 1][1] !== dy ||
      cells[i][2] - cells[i - 1][2] !== dz
    ) {
      return false;
    }
  }
  return true;
}

function bendCount(cells) {
  let n = 0;
  for (let i = 1; i < cells.length - 1; i++) {
    const ax = cells[i][0] - cells[i - 1][0];
    const ay = cells[i][1] - cells[i - 1][1];
    const az = cells[i][2] - cells[i - 1][2];
    const bx = cells[i + 1][0] - cells[i][0];
    const by = cells[i + 1][1] - cells[i][1];
    const bz = cells[i + 1][2] - cells[i][2];
    if (ax !== bx || ay !== by || az !== bz) n++;
  }
  return n;
}

function validLengths(n) {
  const options = [];
  for (let t = MIN_LEN; t <= Math.min(MAX_LEN, n); t++) {
    const rem = n - t;
    if (rem === 0 || rem >= MIN_LEN) options.push(t);
  }
  return options;
}

function connected3d(cells) {
  if (cells.length === 0) return true;
  const set = new Set(cells.map(key));
  const seen = new Set();
  const stack = [cells[0]];
  seen.add(key(cells[0]));
  while (stack.length) {
    const c = stack.pop();
    for (const n of neighborsOf(c)) {
      const id = key(n);
      if (set.has(id) && !seen.has(id)) {
        seen.add(id);
        stack.push(n);
      }
    }
  }
  return seen.size === cells.length;
}

// Hamiltonian path through `cells` whose first step is along `dir` (head out).
function snakePath(cells, dir, remaining) {
  const set = new Set(cells.map(key));
  const n = cells.length;

  const starts = [];
  for (const h of cells) {
    const snd = [h[0] - dir[0], h[1] - dir[1], h[2] - dir[2]];
    if (!set.has(key(snd))) continue;
    const fwd = [h[0] + dir[0], h[1] + dir[1], h[2] + dir[2]];
    if (set.has(key(fwd))) continue; // buried head
    if (shape.has(fwd[0], fwd[1], fwd[2]) && remaining.has(key(fwd)) && !set.has(key(fwd))) {
      continue; // someone else sits in front of the head
    }
    starts.push([h, snd]);
  }
  shuffle(starts);

  for (const [h, snd] of starts) {
    const used = new Set([key(h), key(snd)]);
    const path = [h, snd];
    const dfs = () => {
      if (path.length === n) return true;
      const tail = path[path.length - 1];
      const nbs = shuffle(neighborsOf(tail));
      for (const nb of nbs) {
        const id = key(nb);
        if (!set.has(id) || used.has(id)) continue;
        used.add(id);
        path.push(nb);
        if (dfs()) return true;
        path.pop();
        used.delete(id);
      }
      return false;
    };
    if (dfs()) return path;
  }
  return null;
}

// Slow, mask-free ray walk. Used by the independent verifier only, so the
// verifier does not share code paths with the carver's fast test.
function canExtractSlow(cells, dir, remaining) {
  const self = new Set(cells.map(key));
  const [dx, dy, dz] = dir;
  for (const [x, y, z] of cells) {
    let k = 1;
    while (true) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      const nz = z + dz * k;
      if (!shape.inBounds(nx, ny, nz)) break;
      const id = shape.idx(nx, ny, nz);
      if (!self.has(id) && remaining.has(id)) return false;
      k++;
    }
  }
  return true;
}

function hasHamPath(cells) {
  const set = new Set(cells.map(key));
  const n = cells.length;
  const dfs = (path, used) => {
    if (path.length === n) return true;
    for (const nb of neighborsOf(path[path.length - 1])) {
      const id = key(nb);
      if (!set.has(id) || used.has(id)) continue;
      used.add(id);
      path.push(nb);
      if (dfs(path, used)) return true;
      path.pop();
      used.delete(id);
    }
    return false;
  };
  for (const s of cells) {
    if (dfs([s], new Set([key(s)]))) return true;
  }
  return false;
}

// `remaining` may be a Frontier or a plain Set of ids.
function remainingComponents(remaining) {
  const seen = new Set();
  const comps = [];
  for (const id of remaining) {
    if (seen.has(id)) continue;
    const cells = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const c = shape.cellOf(stack.pop());
      cells.push(c);
      for (const n of neighborsOf(c)) {
        const ni = key(n);
        if (remaining.has(ni) && !seen.has(ni)) {
          seen.add(ni);
          stack.push(ni);
        }
      }
    }
    comps.push(cells);
  }
  return comps;
}

function leftoverOk(frontier, path) {
  const next = frontier.toSet();
  for (const c of path) next.delete(key(c));
  if (next.size === 0) return true;
  const comps = remainingComponents(next);
  for (const cells of comps) {
    if (cells.length < MIN_LEN) return false;
    if (cells.length <= MAX_LEN && !hasHamPath(cells)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Carving
// ---------------------------------------------------------------------------

function tryConsumeSmall(frontier) {
  const comps = remainingComponents(frontier);
  comps.sort((a, b) => a.length - b.length);
  if (comps.some((c) => c.length < MIN_LEN)) return null;
  for (const cells of comps) {
    if (cells.length > MAX_LEN) continue;
    const dirs = shuffle(DIRS.map((d) => d.slice()));
    for (const dir of dirs) {
      const path = snakePath(cells, dir, frontier);
      if (path && frontier.canExtract(path, dir) && leftoverOk(frontier, path)) {
        return path;
      }
    }
  }
  return null;
}

function finalizePiece(frontier, cells, preferredDir) {
  let piece = cells.map((c) => c.slice());
  for (let step = 0; step < 6; step++) {
    if (piece.length < MIN_LEN || piece.length > MAX_LEN) return null;
    const next = frontier.toSet();
    for (const c of piece) next.delete(key(c));
    const tinies = remainingComponents(next).filter((c) => c.length < MIN_LEN);

    if (tinies.length) {
      const extra = tinies[0];
      if (piece.length + extra.length > MAX_LEN) return null;
      const inPiece = new Set(piece.map(key));
      const adjacent = extra.some((c) =>
        neighborsOf(c).some((n) => inPiece.has(key(n)))
      );
      if (!adjacent) return null;
      piece = piece.concat(extra);
      continue;
    }

    if (!connected3d(piece)) return null;
    const dirs = [preferredDir, ...shuffle(DIRS.map((d) => d.slice()))];
    for (const dir of dirs) {
      if (!dir) continue;
      const path = snakePath(piece, dir, frontier);
      if (path && frontier.canExtract(path, dir) && leftoverOk(frontier, path)) {
        return path;
      }
    }
    return null;
  }
  return null;
}

function randomDepths(maxes, target) {
  const cap = maxes.reduce((s, m) => s + m, 0);
  if (cap < target) return null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const d = maxes.map(() => 0);
    let s = 0;
    let guard = 0;
    while (s < target && guard++ < 200) {
      const i = randInt(d.length);
      if (d[i] < maxes[i]) {
        d[i]++;
        s++;
      }
    }
    if (s !== target) continue;
    if (d.some((x) => x >= 2)) return d;
  }
  return null;
}

function tryStamp(frontier, preferBent) {
  const sizes = validLengths(frontier.size);
  if (!sizes.length) return null;
  const dir = DIRS[randInt(DIRS.length)];

  let start = null;
  for (let t = 0; t < 40; t++) {
    const a = randInt(GRID);
    const b = randInt(GRID);
    const run = frontier.exposedRun(dir, a, b);
    if (run.length) {
      start = { a, b, run };
      break;
    }
  }
  if (!start) return null;

  const nColsWanted = preferBent
    ? [2, 2, 2, 3, 3, 3][randInt(6)]
    : [1, 1, 2][randInt(3)];

  const cols = [start];
  const seen = new Set([`${start.a},${start.b}`]);
  while (cols.length < nColsWanted) {
    const nbs = [];
    for (const c of cols) {
      for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const na = c.a + da;
        const nb = c.b + db;
        if (na < 0 || na >= GRID || nb < 0 || nb >= GRID) continue;
        const k = `${na},${nb}`;
        if (seen.has(k)) continue;
        const run = frontier.exposedRun(dir, na, nb);
        if (run.length) nbs.push({ a: na, b: nb, run });
      }
    }
    if (!nbs.length) break;
    const pick = nbs[randInt(nbs.length)];
    cols.push(pick);
    seen.add(`${pick.a},${pick.b}`);
  }

  const runList = cols.map((c) => c.run);
  const maxes = runList.map((r) => r.length);
  const cap = maxes.reduce((s, m) => s + m, 0);
  const options = sizes.filter((t) => t <= cap);
  if (!options.length) return null;

  let target;
  if (preferBent && cols.length >= 2) {
    const bentLens = options.filter((t) => t >= cols.length + 1);
    const pool = bentLens.length ? bentLens : options;
    target = pool[randInt(pool.length)];
  } else {
    target = options[randInt(options.length)];
  }

  const depths = randomDepths(maxes, target);
  if (!depths) return null;

  const cells = [];
  for (let i = 0; i < cols.length; i++) {
    if (depths[i] === 0) continue;
    cells.push(...runList[i].slice(0, depths[i]));
  }
  if (cells.length !== target) return null;
  if (!connected3d(cells)) return null;
  if (preferBent && isStraight(cells) && frontier.size > 24) return null;

  const path = snakePath(cells, dir, frontier);
  if (!path) return null;
  return finalizePiece(frontier, path, dir);
}

function tryRod(frontier) {
  const sizes = validLengths(frontier.size);
  if (!sizes.length) return null;
  const ids = shuffle([...frontier]);
  const sample = ids.length > 120 ? ids.slice(0, 120) : ids;
  for (const id of sample) {
    const c = shape.cellOf(id);
    for (const dir of shuffle(DIRS.map((d) => d.slice()))) {
      const fwd = [c[0] + dir[0], c[1] + dir[1], c[2] + dir[2]];
      if (shape.has(fwd[0], fwd[1], fwd[2]) && frontier.has(key(fwd))) continue;
      const run = [c];
      let p = [c[0] - dir[0], c[1] - dir[1], c[2] - dir[2]];
      while (run.length < MAX_LEN && shape.has(p[0], p[1], p[2]) && frontier.has(key(p))) {
        run.push(p);
        p = [p[0] - dir[0], p[1] - dir[1], p[2] - dir[2]];
      }
      for (const len of shuffle(sizes.slice())) {
        if (len > run.length) continue;
        const path = finalizePiece(frontier, run.slice(0, len), dir);
        if (path) return path;
      }
    }
  }
  return null;
}

function tryCarveOne(frontier) {
  if (frontier.size <= 120) {
    const small = tryConsumeSmall(frontier);
    if (small) return small;
    const rod = tryRod(frontier);
    if (rod) return rod;
  }
  for (let i = 0; i < 80; i++) {
    const preferBent = frontier.size > 180 && i < 64;
    const path = tryStamp(frontier, preferBent);
    if (path) return path;
  }
  return tryRod(frontier) || tryConsumeSmall(frontier);
}

function carvePacking() {
  const frontier = new Frontier(shape);
  const arrows = [];
  let best = N;
  let sinceBest = 0;

  while (frontier.size > 0) {
    const path = tryCarveOne(frontier);
    if (path) {
      for (const c of path) frontier.delete(key(c));
      arrows.push({ id: arrows.length, path });
      if (frontier.size < best) {
        best = frontier.size;
        sinceBest = 0;
      } else if (++sinceBest > 40) {
        return null;
      }
      continue;
    }
    if (arrows.length === 0) return null;
    const last = arrows.pop();
    for (const c of last.path) frontier.add(key(c));
    if (++sinceBest > 40) return null;
  }
  return arrows;
}

// ---------------------------------------------------------------------------
// Independent verifier: replays extraction with fixed heads on the emitted
// JSON. Deliberately uses the slow ray walk, not the Frontier masks.
// ---------------------------------------------------------------------------

function verifyFixed(outputArrows) {
  const packed = outputArrows.map((a, id) => ({
    id,
    path: a.cells,
    dir: [
      a.cells[0][0] - a.cells[1][0],
      a.cells[0][1] - a.cells[1][1],
      a.cells[0][2] - a.cells[1][2],
    ],
  }));
  const remaining = new Set();
  for (const a of packed) for (const c of a.path) remaining.add(key(c));

  const occ = new Int16Array(N).fill(-1);
  for (const a of packed) for (const c of a.path) occ[key(c)] = a.id;

  const blockersOf = (a) => {
    const blockers = new Set();
    const [dx, dy, dz] = a.dir;
    for (const [x, y, z] of a.path) {
      let k = 1;
      while (true) {
        const nx = x + dx * k;
        const ny = y + dy * k;
        const nz = z + dz * k;
        if (!shape.inBounds(nx, ny, nz)) break;
        const o = occ[shape.idx(nx, ny, nz)];
        if (o !== -1 && o !== a.id) blockers.add(o);
        k++;
      }
    }
    return blockers;
  };

  const blockers = packed.map(blockersOf);
  let mutual = 0;
  let extractable = 0;
  let headOnHead = 0;
  const headDirAt = new Map();
  for (const a of packed) headDirAt.set(key(a.path[0]), a.dir);
  for (let i = 0; i < packed.length; i++) {
    if (blockers[i].size === 0) extractable++;
    for (const j of blockers[i]) {
      if (j > i && blockers[j].has(i)) mutual++;
    }
    const h = packed[i].path[0];
    const [dx, dy, dz] = packed[i].dir;
    const nx = h[0] + dx;
    const ny = h[1] + dy;
    const nz = h[2] + dz;
    if (!shape.inBounds(nx, ny, nz)) continue;
    const other = headDirAt.get(shape.idx(nx, ny, nz));
    if (!other) continue;
    if (other[0] === -dx && other[1] === -dy && other[2] === -dz) headOnHead++;
  }
  headOnHead = Math.floor(headOnHead / 2);

  const left = new Set(packed.map((a) => a.id));
  let pulls = 0;
  while (left.size) {
    let moved = false;
    for (const id of left) {
      if (canExtractSlow(packed[id].path, packed[id].dir, remaining)) {
        for (const c of packed[id].path) {
          remaining.delete(key(c));
          occ[key(c)] = -1;
        }
        left.delete(id);
        pulls++;
        moved = true;
        break;
      }
    }
    if (!moved) {
      return { ok: false, remaining: left.size, mutual, headOnHead, extractable, pulls };
    }
  }
  return { ok: true, remaining: 0, mutual, headOnHead, extractable, pulls };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function packOnce(minBent) {
  const arrows = carvePacking();
  if (!arrows) {
    process.stderr.write("skip: carve stuck\n");
    return null;
  }
  const outputArrows = arrows.map((arrow) => ({
    color: randInt(PALETTE_SIZE),
    cells: arrow.path.map(([x, y, z]) => [x, y, z]),
  }));
  const bent = outputArrows.filter((a) => !isStraight(a.cells)).length;
  const ratio = bent / outputArrows.length;
  if (ratio < minBent) {
    process.stderr.write(`skip: bent ${(ratio * 100).toFixed(0)}% of ${outputArrows.length}\n`);
    return null;
  }
  const check = verifyFixed(outputArrows);
  if (!check.ok || check.mutual !== 0 || check.headOnHead !== 0) {
    process.stderr.write(
      `skip: verify ok=${check.ok} mutual=${check.mutual} hoh=${check.headOnHead}\n`
    );
    return null;
  }
  return { outputArrows, bent, check };
}

const opts = parseArgs(process.argv.slice(2));
const seed =
  opts.seed !== null && opts.seed !== ""
    ? String(opts.seed)
    : String(Date.now() ^ Math.floor(Math.random() * 0xffffffff)); // only place Math.random is allowed

let packed = null;
let attempt = 0;
for (; attempt < opts.attempts; attempt++) {
  rng = makeRng(hashSeed(seed, attempt));
  packed = packOnce(opts.minBent);
  if (packed) break;
  process.stderr.write(`attempt ${attempt + 1} failed\n`);
}
if (!packed) {
  console.error(`Could not carve a bent, solvable packing for seed "${seed}"; aborting.`);
  process.exit(1);
}

const { outputArrows, bent, check } = packed;
const totalCells = outputArrows.reduce((n, a) => n + a.cells.length, 0);
const turns = outputArrows.reduce((n, a) => n + bendCount(a.cells), 0);

const data = {
  ...shape.header(),
  seed,
  attempt: attempt + 1,
  stats: {
    arrows: outputArrows.length,
    cells: totalCells,
    fill: +(totalCells / N).toFixed(4),
    bent,
    corners: turns,
    pulls: check.pulls,
    freeAtStart: check.extractable,
  },
  arrows: outputArrows,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = opts.out
  ? resolve(process.cwd(), opts.out)
  : resolve(here, "..", "arrows.json");

writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

console.log(
  `Wrote ${outputArrows.length} arrows (${totalCells} cells, ` +
    `${((totalCells / N) * 100).toFixed(1)}% fill, ${bent} bent ` +
    `(${((bent / outputArrows.length) * 100).toFixed(0)}%), ${turns} corners; ` +
    `solvable in ${check.pulls} pulls, ${check.extractable} free at start, ` +
    `${check.mutual} mutual deadlocks, ${check.headOnHead} head-on-head; ` +
    `seed ${seed}, attempt ${attempt + 1}) to ${outPath}`
);
