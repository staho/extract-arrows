#!/usr/bin/env node
// Arrow puzzle generator.
//
// Emits a static arrows.json describing a set of "arrows" that completely fill a
// 3D grid (every cell belongs to exactly one arrow). Each arrow is a chain of
// cells (it may bend) with a head at one end. Cells are stored head-first:
// cells[0] is the head, the rest is the body. The head's facing direction is
// cells[0] - cells[1].
//
// How the full fill works: we build a serpentine Hamiltonian path that visits
// every cell exactly once (with a random axis permutation / reflections for
// variety), then chop it into consecutive segments of length MIN_LEN..MAX_LEN.
// That guarantees 100% coverage with no gaps and no overlaps.
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

const idx = (x, y, z) => (x * GRID + y) * GRID + z;
const inBounds = (x, y, z) =>
  x >= 0 && x < GRID && y >= 0 && y < GRID && z >= 0 && z < GRID;

const randInt = (n) => Math.floor(Math.random() * n);
const randBool = () => Math.random() < 0.5;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- 1. Serpentine Hamiltonian path over every cell. ---
// Canonical order visits axis roles (a=outer, b=middle, c=inner). The middle
// axis reverses each outer step and the inner axis reverses each middle step so
// that consecutive cells always differ by 1 on exactly one axis. A random axis
// permutation and per-axis reflections (both grid automorphisms that preserve
// adjacency) vary the layout between runs.
function serpentinePath() {
  const axisOf = shuffle([0, 1, 2]); // axisOf[roleIndex] = world axis
  const flip = [randBool(), randBool(), randBool()];
  const path = [];
  for (let a = 0; a < GRID; a++) {
    const bAsc = a % 2 === 0;
    for (let bi = 0; bi < GRID; bi++) {
      const b = bAsc ? bi : GRID - 1 - bi;
      const cAsc = (a + b) % 2 === 0;
      for (let ci = 0; ci < GRID; ci++) {
        const c = cAsc ? ci : GRID - 1 - ci;
        const v = [0, 0, 0];
        v[axisOf[0]] = a;
        v[axisOf[1]] = b;
        v[axisOf[2]] = c;
        for (let d = 0; d < 3; d++) if (flip[d]) v[d] = GRID - 1 - v[d];
        path.push(v);
      }
    }
  }
  return path;
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

const path = serpentinePath();

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
