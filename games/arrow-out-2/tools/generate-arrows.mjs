#!/usr/bin/env node
// Arrow puzzle generator.
//
// Emits a static arrows.json describing a set of "arrows" that completely fill a
// 3D grid (every cell belongs to exactly one arrow). Each arrow is a chain of
// cells (it may bend) with a head at one end. Cells are stored head-first:
// cells[0] is the head, the rest is the body. The head's facing direction is
// cells[0] - cells[1].
//
// How the full fill works: we build a random Hamiltonian path that wanders
// through every cell exactly once (randomized Warnsdorff DFS with backtracking),
// then chop it into consecutive segments of length MIN_LEN..MAX_LEN. That
// guarantees 100% coverage with no gaps or overlaps while keeping the arrows
// varied in direction (a serpentine fallback is used only if the randomized
// search fails to complete within its budget).
//
// Head orientation ("no head points directly at another arrow"): in a fully
// packed cube this rule can only hold for arrows whose head sits on the surface
// and points out of the grid, since every interior neighbour cell is occupied.
// So it is applied as a best-effort preference: for each arrow we prefer the
// endpoint whose front cell is out of bounds (points out of the grid); arrows
// are never dropped (dropping would leave holes). A fuller solvability model for
// the packed puzzle is future work.
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

const idx = (x, y, z) => (x * GRID + y) * GRID + z;
const inBounds = (x, y, z) =>
  x >= 0 && x < GRID && y >= 0 && y < GRID && z >= 0 && z < GRID;

const randInt = (n) => Math.floor(Math.random() * n);
const randBool = () => Math.random() < 0.5;

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

function neighborsOf([x, y, z]) {
  const out = [];
  for (const [dx, dy, dz] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    const nz = z + dz;
    if (inBounds(nx, ny, nz)) out.push([nx, ny, nz]);
  }
  return out;
}

// Ordered list of moves from `cell`, unvisited-first via Warnsdorff (fewest
// onward unvisited neighbours first) with random tie-breaks so each run differs.
function orderedCandidates(cell, visited) {
  const scored = [];
  for (const c of neighborsOf(cell)) {
    if (visited[idx(c[0], c[1], c[2])]) continue;
    let degree = 0;
    for (const n of neighborsOf(c)) {
      if (!visited[idx(n[0], n[1], n[2])]) degree++;
    }
    scored.push({ c, degree, r: Math.random() });
  }
  scored.sort((a, b) => a.degree - b.degree || a.r - b.r);
  return scored.map((s) => s.c);
}

// --- 1a. Random Hamiltonian path over every cell (iterative DFS + backtrack). ---
function randomHamiltonian(maxSteps) {
  const visited = new Uint8Array(N);
  const start = [randInt(GRID), randInt(GRID), randInt(GRID)];
  visited[idx(start[0], start[1], start[2])] = 1;
  const path = [start];
  const frames = [{ cands: orderedCandidates(start, visited), i: 0 }];

  let steps = 0;
  while (path.length < N) {
    if (++steps > maxSteps) return null;
    const frame = frames[frames.length - 1];
    let advanced = false;
    while (frame.i < frame.cands.length) {
      const c = frame.cands[frame.i++];
      if (visited[idx(c[0], c[1], c[2])]) continue;
      visited[idx(c[0], c[1], c[2])] = 1;
      path.push(c);
      frames.push({ cands: orderedCandidates(c, visited), i: 0 });
      advanced = true;
      break;
    }
    if (!advanced) {
      const dead = path.pop();
      visited[idx(dead[0], dead[1], dead[2])] = 0;
      frames.pop();
      if (frames.length === 0) return null;
    }
  }
  return path;
}

// --- 1b. Serpentine fallback (guaranteed) if the random search runs out of budget. ---
function serpentinePath() {
  const path = [];
  for (let a = 0; a < GRID; a++) {
    const bAsc = a % 2 === 0;
    for (let bi = 0; bi < GRID; bi++) {
      const b = bAsc ? bi : GRID - 1 - bi;
      const cAsc = (a + b) % 2 === 0;
      for (let ci = 0; ci < GRID; ci++) {
        const c = cAsc ? ci : GRID - 1 - ci;
        path.push([a, b, c]);
      }
    }
  }
  return path;
}

function buildHamiltonian() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const p = randomHamiltonian(60 * N);
    if (p) return p;
  }
  console.warn("Random Hamiltonian search exhausted; using serpentine fallback.");
  return serpentinePath();
}

// --- 2. Chop the path into arrow-length segments (each in [MIN_LEN, MAX_LEN]). ---
// The cut always leaves a remainder of 0 or >= MIN_LEN so no segment is too short.
function segmentLengths(total) {
  const lens = [];
  let n = total;
  while (n > 0) {
    const options = [];
    for (let t = MIN_LEN; t <= Math.min(MAX_LEN, n); t++) {
      const rem = n - t;
      if (rem === 0 || rem >= MIN_LEN) options.push(t);
    }
    const t = options[randInt(options.length)];
    lens.push(t);
    n -= t;
  }
  return lens;
}

const path = buildHamiltonian();

// occ[cell] = arrow id occupying it, or -1 when empty.
const occ = new Int16Array(GRID * GRID * GRID).fill(-1);
const arrows = []; // each: { id, path: [[x,y,z], ...] }
let cursor = 0;
for (const len of segmentLengths(path.length)) {
  const id = arrows.length;
  const seg = path.slice(cursor, cursor + len);
  cursor += len;
  for (const [x, y, z] of seg) occ[idx(x, y, z)] = id;
  arrows.push({ id, path: seg });
}

// --- 3. Head orientation (best-effort, prefer pointing out of the grid). ---
function frontCell(head, second) {
  return [
    head[0] + (head[0] - second[0]),
    head[1] + (head[1] - second[1]),
    head[2] + (head[2] - second[2]),
  ];
}

// Rank a front cell: 2 = points out of the grid, 1 = empty, 0 = blocked.
function frontRank(front) {
  const [x, y, z] = front;
  if (!inBounds(x, y, z)) return 2;
  return occ[idx(x, y, z)] === -1 ? 1 : 0;
}

let exitHeads = 0;
for (const arrow of arrows) {
  const p = arrow.path;
  const startRank = frontRank(frontCell(p[0], p[1]));
  const endRank = frontRank(frontCell(p[p.length - 1], p[p.length - 2]));
  let headAtStart;
  if (startRank !== endRank) headAtStart = startRank > endRank;
  else headAtStart = randBool();
  arrow.headAtStart = headAtStart;
  if (Math.max(startRank, endRank) === 2) exitHeads++;
}

// --- 4. Serialize (cells head-first). ---
const outputArrows = arrows.map((arrow) => {
  const cells = arrow.headAtStart ? arrow.path : arrow.path.slice().reverse();
  return {
    color: randInt(PALETTE_SIZE),
    cells: cells.map(([x, y, z]) => [x, y, z]),
  };
});

const data = { grid: GRID, cell: CELL, arrows: outputArrows };

const outArg = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const outPath = outArg
  ? resolve(process.cwd(), outArg)
  : resolve(here, "..", "arrows.json");

writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

const totalCells = outputArrows.reduce((n, a) => n + a.cells.length, 0);
console.log(
  `Wrote ${outputArrows.length} arrows (${totalCells} cells, ` +
    `${((totalCells / (GRID * GRID * GRID)) * 100).toFixed(1)}% fill; ` +
    `${exitHeads} heads point out of the grid) to ${outPath}`
);
