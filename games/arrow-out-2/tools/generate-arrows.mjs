#!/usr/bin/env node
// Arrow puzzle generator.
//
// Emits a static arrows.json describing a set of "arrows" that completely fill a
// 3D grid (every cell belongs to exactly one arrow). Each arrow is a chain of
// cells (it may bend) with a head at one end. Cells are stored head-first:
// cells[0] is the head, the rest is the body. The head's facing direction is
// cells[0] - cells[1].
//
// Extraction model: an arrow slides as a rigid piece in the direction its head
// points until it leaves the grid. The corridor ahead of every cell must be
// clear, so two arrows aimed at each other deadlock.
//
// Generation peels one "stamp" at a time off the remaining solid. A stamp is a
// small shadow-closed polycube on the current skyline (1–3 adjacent columns,
// depths summing to 3–6). Multi-column stamps become U / L / S snakes; they
// still extract in the peel direction because every occupied column is filled
// out to the exposed face. The peel axis is re-rolled every stamp so arrows
// do not form a parallel forest. Playing carve-order solves the packing.
//
// Usage: node games/arrow-out-2/tools/generate-arrows.mjs [outfile]
//   default outfile: ../arrows.json (games/arrow-out-2/arrows.json)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const GRID = 10;
const CELL = 1.15;
const PALETTE_SIZE = 6;
const MIN_LEN = 3;
const MAX_LEN = 6;

const N = GRID * GRID * GRID;
const MIN_BENT_RATIO = 0.55;

const idx = (x, y, z) => (x * GRID + y) * GRID + z;
const inBounds = (x, y, z) =>
  x >= 0 && x < GRID && y >= 0 && y < GRID && z >= 0 && z < GRID;

const randInt = (n) => Math.floor(Math.random() * n);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function key(c) {
  return idx(c[0], c[1], c[2]);
}

function neighborsOf([x, y, z]) {
  const out = [];
  if (x + 1 < GRID) out.push([x + 1, y, z]);
  if (x - 1 >= 0) out.push([x - 1, y, z]);
  if (y + 1 < GRID) out.push([x, y + 1, z]);
  if (y - 1 >= 0) out.push([x, y - 1, z]);
  if (z + 1 < GRID) out.push([x, y, z + 1]);
  if (z - 1 >= 0) out.push([x, y, z - 1]);
  return out;
}

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

// Remaining cells in one column, ordered from the exposed end inward, stopping
// at the first gap so the prefix is always shadow-closed in `dir`.
function exposedRun(remaining, dir, a, b) {
  const axis = axisOf(dir);
  const sign = dir[axis];
  const A = (axis + 1) % 3;
  const B = (axis + 2) % 3;
  const cells = [];
  const t0 = sign > 0 ? GRID - 1 : 0;
  const step = sign > 0 ? -1 : 1;
  for (let t = t0; t >= 0 && t < GRID; t += step) {
    const c = [0, 0, 0];
    c[axis] = t;
    c[A] = a;
    c[B] = b;
    if (remaining.has(key(c))) cells.push(c);
    else if (cells.length) break;
  }
  return cells;
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
    if (inBounds(fwd[0], fwd[1], fwd[2]) && remaining.has(key(fwd)) && !set.has(key(fwd))) {
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

function cellOf(i) {
  const z = i % GRID;
  const y = Math.floor(i / GRID) % GRID;
  const x = Math.floor(i / (GRID * GRID));
  return [x, y, z];
}

function canExtract(cells, dir, remaining) {
  const self = new Set(cells.map(key));
  const [dx, dy, dz] = dir;
  for (const [x, y, z] of cells) {
    let k = 1;
    while (true) {
      const nx = x + dx * k;
      const ny = y + dy * k;
      const nz = z + dz * k;
      if (!inBounds(nx, ny, nz)) break;
      const id = idx(nx, ny, nz);
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

function leftoverOk(remaining, path) {
  const next = new Set(remaining);
  for (const c of path) next.delete(key(c));
  if (next.size === 0) return true;
  const comps = remainingComponents(next);
  for (const cells of comps) {
    if (cells.length < MIN_LEN) return false;
    if (cells.length <= MAX_LEN && !hasHamPath(cells)) return false;
  }
  return true;
}

function remainingComponents(remaining) {
  const seen = new Set();
  const comps = [];
  for (const id of remaining) {
    if (seen.has(id)) continue;
    const cells = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const i = stack.pop();
      const z = i % GRID;
      const y = Math.floor(i / GRID) % GRID;
      const x = Math.floor(i / (GRID * GRID));
      const c = [x, y, z];
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

function tryConsumeSmall(remaining) {
  const comps = remainingComponents(remaining);
  comps.sort((a, b) => a.length - b.length);
  if (comps.some((c) => c.length < MIN_LEN)) return null;
  for (const cells of comps) {
    if (cells.length > MAX_LEN) continue;
    const dirs = shuffle(DIRS.map((d) => d.slice()));
    for (const dir of dirs) {
      const path = snakePath(cells, dir, remaining);
      if (
        path &&
        canExtract(path, dir, remaining) &&
        leftoverOk(remaining, path)
      ) {
        return path;
      }
    }
  }
  return null;
}

function finalizePiece(remaining, cells, preferredDir) {
  let piece = cells.map((c) => c.slice());
  for (let step = 0; step < 6; step++) {
    if (piece.length < MIN_LEN || piece.length > MAX_LEN) return null;
    const tinies = remainingComponents(
      (() => {
        const next = new Set(remaining);
        for (const c of piece) next.delete(key(c));
        return next;
      })()
    ).filter((c) => c.length < MIN_LEN);

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
      const path = snakePath(piece, dir, remaining);
      if (
        path &&
        canExtract(path, dir, remaining) &&
        leftoverOk(remaining, path)
      ) {
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

function tryStamp(remaining, preferBent) {
  const sizes = validLengths(remaining.size);
  if (!sizes.length) return null;
  const dir = DIRS[randInt(DIRS.length)];

  let start = null;
  for (let t = 0; t < 40; t++) {
    const a = randInt(GRID);
    const b = randInt(GRID);
    const run = exposedRun(remaining, dir, a, b);
    if (run.length) {
      start = { a, b, run };
      break;
    }
  }
  if (!start) return null;

  const runAt = (a, b) => {
    const run = exposedRun(remaining, dir, a, b);
    return run.length ? run : null;
  };

  const nColsWanted = preferBent
    ? [2, 2, 2, 3, 3, 3][randInt(6)]
    : [1, 1, 2][randInt(3)];

  const cols = [{ a: start.a, b: start.b, run: start.run }];
  const seen = new Set([`${start.a},${start.b}`]);
  while (cols.length < nColsWanted) {
    const nbs = [];
    for (const c of cols) {
      for (const [da, db] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const na = c.a + da;
        const nb = c.b + db;
        if (na < 0 || na >= GRID || nb < 0 || nb >= GRID) continue;
        const k = `${na},${nb}`;
        if (seen.has(k)) continue;
        const run = runAt(na, nb);
        if (run) nbs.push({ a: na, b: nb, run });
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
  if (preferBent && isStraight(cells) && remaining.size > 24) return null;

  const path = snakePath(cells, dir, remaining);
  if (!path) return null;
  return finalizePiece(remaining, path, dir);
}

function tryRod(remaining) {
  const sizes = validLengths(remaining.size);
  if (!sizes.length) return null;
  const ids = shuffle([...remaining]);
  const sample = ids.length > 120 ? ids.slice(0, 120) : ids;
  for (const id of sample) {
    const c = cellOf(id);
    for (const dir of shuffle(DIRS.map((d) => d.slice()))) {
      const fwd = [c[0] + dir[0], c[1] + dir[1], c[2] + dir[2]];
      if (inBounds(fwd[0], fwd[1], fwd[2]) && remaining.has(key(fwd))) continue;
      const run = [c];
      let p = [c[0] - dir[0], c[1] - dir[1], c[2] - dir[2]];
      while (
        run.length < MAX_LEN &&
        inBounds(p[0], p[1], p[2]) &&
        remaining.has(key(p))
      ) {
        run.push(p);
        p = [p[0] - dir[0], p[1] - dir[1], p[2] - dir[2]];
      }
      for (const len of shuffle(sizes.slice())) {
        if (len > run.length) continue;
        const path = finalizePiece(remaining, run.slice(0, len), dir);
        if (path) return path;
      }
    }
  }
  return null;
}

function tryCarveOne(remaining) {
  if (remaining.size <= 120) {
    const small = tryConsumeSmall(remaining);
    if (small) return small;
    const rod = tryRod(remaining);
    if (rod) return rod;
  }
  for (let i = 0; i < 80; i++) {
    const preferBent = remaining.size > 180 && i < 64;
    const path = tryStamp(remaining, preferBent);
    if (path) return path;
  }
  return tryRod(remaining) || tryConsumeSmall(remaining);
}

function carvePacking() {
  const remaining = new Set();
  for (let i = 0; i < N; i++) remaining.add(i);
  const arrows = [];
  let best = N;
  let sinceBest = 0;

  while (remaining.size > 0) {
    const path = tryCarveOne(remaining);
    if (path) {
      for (const c of path) remaining.delete(key(c));
      arrows.push({ id: arrows.length, path });
      if (remaining.size < best) {
        best = remaining.size;
        sinceBest = 0;
      } else if (++sinceBest > 40) {
        return null;
      }
      continue;
    }
    if (arrows.length === 0) return null;
    const last = arrows.pop();
    for (const c of last.path) remaining.add(key(c));
    if (++sinceBest > 40) return null;
  }
  return arrows;
}

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
        if (!inBounds(nx, ny, nz)) break;
        const o = occ[idx(nx, ny, nz)];
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
    if (!inBounds(nx, ny, nz)) continue;
    const other = headDirAt.get(idx(nx, ny, nz));
    if (!other) continue;
    if (other[0] === -dx && other[1] === -dy && other[2] === -dz) headOnHead++;
  }
  headOnHead = Math.floor(headOnHead / 2);

  const left = new Set(packed.map((a) => a.id));
  let pulls = 0;
  while (left.size) {
    let moved = false;
    for (const id of left) {
      if (canExtract(packed[id].path, packed[id].dir, remaining)) {
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
      return {
        ok: false,
        remaining: left.size,
        mutual,
        headOnHead,
        extractable,
        pulls,
      };
    }
  }
  return { ok: true, remaining: 0, mutual, headOnHead, extractable, pulls };
}

function packOnce() {
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
  if (ratio < MIN_BENT_RATIO) {
    process.stderr.write(
      `skip: bent ${(ratio * 100).toFixed(0)}% of ${outputArrows.length}\n`
    );
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

let packed = null;
let attempt = 0;
for (; attempt < 40; attempt++) {
  packed = packOnce();
  if (packed) break;
  if (!packed) process.stderr.write(`attempt ${attempt + 1} failed\n`);
}
if (!packed) {
  console.error("Could not carve a bent, solvable packing; aborting.");
  process.exit(1);
}

const { outputArrows, bent, check } = packed;
const data = { grid: GRID, cell: CELL, arrows: outputArrows };

const outArg = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const outPath = outArg
  ? resolve(process.cwd(), outArg)
  : resolve(here, "..", "arrows.json");

writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

const totalCells = outputArrows.reduce((n, a) => n + a.cells.length, 0);
const turns = outputArrows.reduce((n, a) => n + bendCount(a.cells), 0);
console.log(
  `Wrote ${outputArrows.length} arrows (${totalCells} cells, ` +
    `${((totalCells / N) * 100).toFixed(1)}% fill, ${bent} bent ` +
    `(${((bent / outputArrows.length) * 100).toFixed(0)}%), ${turns} corners; ` +
    `solvable in ${check.pulls} pulls, ${check.extractable} free at start, ` +
    `${check.mutual} mutual deadlocks, ${check.headOnHead} head-on-head; ` +
    `attempt ${attempt + 1}) to ${outPath}`
);
