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
// points until it leaves the grid. That only works if the corridor ahead of
// every one of its cells is clear of other arrows, so two arrows aimed at each
// other deadlock (the "conflicts" from assigning heads after packing).
//
// Generation is solvable by construction. We peel rectangular slabs off an
// exposed face of the remaining box, fill each slab with arrows that point
// toward that face, then recurse on the leftover box (which may peel a
// different axis next). Optional U-bends merge two adjacent length-3 rods in a
// slab; they still extract in the peel direction. Playing peel-order from first
// slab to last therefore solves the packed puzzle with no mutual deadlocks.
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

// Thicknesses that leave a remainder of 0 or at least MIN_LEN.
function validLengths(n) {
  const options = [];
  for (let t = MIN_LEN; t <= Math.min(MAX_LEN, n); t++) {
    const rem = n - t;
    if (rem === 0 || rem >= MIN_LEN) options.push(t);
  }
  return options;
}

function fillSlab(lo, hi, axis, sign, arrows) {
  const t = hi[axis] - lo[axis];
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  const rods = [];
  for (let ua = lo[a]; ua < hi[a]; ua++) {
    for (let ub = lo[b]; ub < hi[b]; ub++) {
      const cells = [];
      for (let k = 0; k < t; k++) {
        const c = [0, 0, 0];
        c[a] = ua;
        c[b] = ub;
        c[axis] = sign > 0 ? hi[axis] - 1 - k : lo[axis] + k;
        cells.push(c);
      }
      rods.push({ ua, ub, cells });
    }
  }

  const used = new Set();
  shuffle(rods);
  for (const rod of rods) {
    const id = `${rod.ua},${rod.ub}`;
    if (used.has(id)) continue;

    // Thickness 3: optionally join an adjacent rod at the tail into a U-bend
    // of length 6. Both columns stay exposed in the peel direction.
    if (t === 3 && Math.random() < 0.5) {
      const nbs = shuffle([
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]);
      let merged = false;
      for (const [da, db] of nbs) {
        const ua2 = rod.ua + da;
        const ub2 = rod.ub + db;
        if (ua2 < lo[a] || ua2 >= hi[a] || ub2 < lo[b] || ub2 >= hi[b]) continue;
        const id2 = `${ua2},${ub2}`;
        if (used.has(id2)) continue;
        const other = rods.find((r) => r.ua === ua2 && r.ub === ub2);
        if (!other) continue;
        arrows.push({
          id: arrows.length,
          path: rod.cells.concat(other.cells.slice().reverse()),
        });
        used.add(id);
        used.add(id2);
        merged = true;
        break;
      }
      if (merged) continue;
    }

    used.add(id);
    arrows.push({ id: arrows.length, path: rod.cells });
  }
}

function fillBox(lo, hi, arrows) {
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (size[0] * size[1] * size[2] === 0) return;

  const faces = [];
  for (let axis = 0; axis < 3; axis++) {
    if (size[axis] >= MIN_LEN) {
      faces.push({ axis, sign: 1 });
      faces.push({ axis, sign: -1 });
    }
  }
  const { axis, sign } = faces[randInt(faces.length)];
  const t = validLengths(size[axis])[randInt(validLengths(size[axis]).length)];

  const slabLo = lo.slice();
  const slabHi = hi.slice();
  const restLo = lo.slice();
  const restHi = hi.slice();
  if (sign > 0) {
    slabLo[axis] = hi[axis] - t;
    restHi[axis] = hi[axis] - t;
  } else {
    slabHi[axis] = lo[axis] + t;
    restLo[axis] = lo[axis] + t;
  }

  fillSlab(slabLo, slabHi, axis, sign, arrows);
  fillBox(restLo, restHi, arrows);
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

const arrows = [];
fillBox([0, 0, 0], [GRID, GRID, GRID], arrows);

const outputArrows = arrows.map((arrow) => ({
  color: randInt(PALETTE_SIZE),
  cells: arrow.path.map(([x, y, z]) => [x, y, z]),
}));

const data = { grid: GRID, cell: CELL, arrows: outputArrows };

const outArg = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const outPath = outArg
  ? resolve(process.cwd(), outArg)
  : resolve(here, "..", "arrows.json");

writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");

const totalCells = outputArrows.reduce((n, a) => n + a.cells.length, 0);
const bent = outputArrows.filter((a) => !isStraight(a.cells)).length;
const check = verifyFixed(outputArrows);
if (!check.ok || check.mutual !== 0 || check.headOnHead !== 0) {
  console.error(
    `Internal error: written puzzle failed verification ` +
      `(ok=${check.ok}, remaining=${check.remaining}, mutual=${check.mutual}, ` +
      `headOnHead=${check.headOnHead}).`
  );
  process.exit(1);
}

console.log(
  `Wrote ${outputArrows.length} arrows (${totalCells} cells, ` +
    `${((totalCells / N) * 100).toFixed(1)}% fill, ${bent} bent; ` +
    `solvable in ${check.pulls} pulls, ${check.extractable} free at start, ` +
    `${check.mutual} mutual deadlocks, ${check.headOnHead} head-on-head) to ${outPath}`
);
