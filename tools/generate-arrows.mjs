#!/usr/bin/env node
// Arrow puzzle generator.
//
// Emits a static arrows.json describing a set of "arrows" laid out in a 3D grid.
// Each arrow is a self-avoiding chain of cells (it may bend) with a head at one
// end. Cells are stored head-first: cells[0] is the head, the rest is the body.
// The head's facing direction is cells[0] - cells[1].
//
// Basic solvability rule (only rule for now): an arrow's head must not point
// directly into another arrow, i.e. the cell immediately in front of the head
// must be out of bounds (points out of the grid) or empty. Arrows for which
// neither end yields a clear front cell are dropped. This avoids the
// nose-jammed deadlock while still allowing interlocking (blockers further
// along the exit path are permitted).
//
// Usage: node tools/generate-arrows.mjs [outfile]
//   default outfile: arrows.json (repo root)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const GRID = 10;
const CELL = 1.15;
const PALETTE_SIZE = 6;
const MIN_LEN = 3;
const MAX_LEN = 6;
const TARGET_FILL = 0.4; // fraction of the grid volume to fill with arrow cells
const MAX_ATTEMPTS = 20000;

const DIRS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const idx = (x, y, z) => (x * GRID + y) * GRID + z;
const inBounds = (x, y, z) =>
  x >= 0 && x < GRID && y >= 0 && y < GRID && z >= 0 && z < GRID;

const randInt = (n) => Math.floor(Math.random() * n);

// occ[cell] = arrow id occupying it, or -1 when empty.
const occ = new Int16Array(GRID * GRID * GRID).fill(-1);
const targetCells = Math.round(TARGET_FILL * GRID * GRID * GRID);

function randomEmptyCell() {
  for (let tries = 0; tries < 200; tries++) {
    const x = randInt(GRID);
    const y = randInt(GRID);
    const z = randInt(GRID);
    if (occ[idx(x, y, z)] === -1) return [x, y, z];
  }
  return null;
}

// Grow a self-avoiding walk of up to targetLen cells through empty space.
function growWalk(targetLen) {
  const start = randomEmptyCell();
  if (!start) return null;
  const path = [start];
  const used = new Set([start.join(",")]);
  let cur = start;
  while (path.length < targetLen) {
    const options = [];
    for (const [dx, dy, dz] of DIRS) {
      const nx = cur[0] + dx;
      const ny = cur[1] + dy;
      const nz = cur[2] + dz;
      if (!inBounds(nx, ny, nz)) continue;
      if (occ[idx(nx, ny, nz)] !== -1) continue;
      if (used.has(`${nx},${ny},${nz}`)) continue;
      options.push([nx, ny, nz]);
    }
    if (options.length === 0) break;
    const next = options[randInt(options.length)];
    path.push(next);
    used.add(next.join(","));
    cur = next;
  }
  return path.length >= MIN_LEN ? path : null;
}

// --- Placement pass: grow walks until the grid is filled to the target. ---
const arrows = []; // each: { id, path: [[x,y,z], ...] }
let filled = 0;
let attempts = 0;
while (filled < targetCells && attempts < MAX_ATTEMPTS) {
  attempts++;
  const targetLen = MIN_LEN + randInt(MAX_LEN - MIN_LEN + 1);
  const path = growWalk(targetLen);
  if (!path) continue;
  const id = arrows.length;
  for (const [x, y, z] of path) occ[idx(x, y, z)] = id;
  arrows.push({ id, path });
  filled += path.length;
}

// --- Orientation + basic-rule pass. ---
// For an endpoint, the "front" cell is one step beyond the head, away from the
// body. A front cell that is out of bounds (arrow points out of the grid) or
// empty is valid. We prefer pointing out of the grid, then an empty interior
// cell. Arrows with no valid orientation are dropped; dropping only frees
// cells, so we iterate to a fixed point (freed cells may rescue neighbours).
function frontCell(head, second) {
  return [
    head[0] + (head[0] - second[0]),
    head[1] + (head[1] - second[1]),
    head[2] + (head[2] - second[2]),
  ];
}

function classifyFront(front) {
  const [x, y, z] = front;
  if (!inBounds(x, y, z)) return "exit"; // points out of the grid
  if (occ[idx(x, y, z)] === -1) return "empty";
  return "blocked";
}

let alive = arrows.slice();
let changed = true;
while (changed) {
  changed = false;
  const survivors = [];
  for (const arrow of alive) {
    const p = arrow.path;
    const startFront = classifyFront(frontCell(p[0], p[1]));
    const endFront = classifyFront(frontCell(p[p.length - 1], p[p.length - 2]));

    // Rank: exit (2) > empty (1) > blocked (0).
    const rank = (c) => (c === "exit" ? 2 : c === "empty" ? 1 : 0);
    const startRank = rank(startFront);
    const endRank = rank(endFront);

    if (startRank === 0 && endRank === 0) {
      // No valid orientation: drop it and free its cells.
      for (const [x, y, z] of p) occ[idx(x, y, z)] = -1;
      changed = true;
      continue;
    }

    // Choose head endpoint with the better front; tie-break randomly.
    let headAtStart;
    if (startRank !== endRank) headAtStart = startRank > endRank;
    else headAtStart = Math.random() < 0.5;

    arrow.headAtStart = headAtStart;
    survivors.push(arrow);
  }
  alive = survivors;
}

// --- Serialize (cells head-first). ---
const outputArrows = alive.map((arrow) => {
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
    `${((totalCells / (GRID * GRID * GRID)) * 100).toFixed(1)}% fill) to ${outPath}`
);
