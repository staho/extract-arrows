#!/usr/bin/env node
// Publish a generated puzzle as the live arrow-out-2 level.
//
// Usage:
//   ARROW_ADMIN_TOKEN=... node publish-level.mjs --file=level.json
//   ARROW_ADMIN_TOKEN=... node publish-level.mjs --seed=42
//   ARROW_ADMIN_TOKEN=... node publish-level.mjs --list
//   ARROW_ADMIN_TOKEN=... node publish-level.mjs --current=3
//
// --seed (and other generate-arrows flags) run the generator into a temp file
// and then POST it. --file publishes an existing JSON file instead.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generateScript = join(here, "generate-arrows.mjs");
const defaultUrl = "https://arrow-out-2.staho.dev";

function parseArgs(argv) {
  const opts = {
    file: null,
    url: defaultUrl,
    list: false,
    current: null,
    generateArgs: [],
  };
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      opts.file = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const val = eq === -1 ? "" : arg.slice(eq + 1);
    switch (name) {
      case "file":
        opts.file = val;
        break;
      case "url":
        opts.url = val.replace(/\/$/, "");
        break;
      case "list":
        opts.list = true;
        break;
      case "current":
        opts.current = val;
        break;
      case "out":
        console.error("publish-level uses --file=PATH; --out is a generator flag and is ignored here");
        process.exit(2);
        break;
      default:
        opts.generateArgs.push(arg);
        break;
    }
  }
  return opts;
}

function requireToken() {
  const token = process.env.ARROW_ADMIN_TOKEN;
  if (!token) {
    console.error("ARROW_ADMIN_TOKEN is required");
    process.exit(2);
  }
  return token;
}

async function adminFetch(url, token, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text for error reporting
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    console.error(`HTTP ${res.status} ${res.statusText}: ${detail}`);
    process.exit(1);
  }
  return body;
}

function generatePuzzle(generateArgs) {
  const dir = mkdtempSync(join(tmpdir(), "arrow-out-2-"));
  const out = join(dir, "level.json");
  const result = spawnSync(
    process.execPath,
    [generateScript, `--out=${out}`, ...generateArgs],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }
  const json = readFileSync(out, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return json;
}

const opts = parseArgs(process.argv.slice(2));
const token = requireToken();

if (opts.list) {
  const body = await adminFetch(`${opts.url}/api/admin/levels`, token);
  console.log(JSON.stringify(body, null, 2));
  process.exit(0);
}

if (opts.current != null && opts.current !== "") {
  const id = Number.parseInt(opts.current, 10);
  if (!Number.isInteger(id) || id < 1) {
    console.error("--current must be a positive integer id");
    process.exit(2);
  }
  const body = await adminFetch(`${opts.url}/api/admin/current`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  console.log(`Current level set to ${body.id}`);
  process.exit(0);
}

let raw;
if (opts.file) {
  raw = readFileSync(resolve(process.cwd(), opts.file), "utf8");
} else {
  raw = generatePuzzle(opts.generateArgs);
}

let puzzle;
try {
  puzzle = JSON.parse(raw);
} catch {
  console.error("level file is not valid JSON");
  process.exit(2);
}

const compact = JSON.stringify(puzzle);
const body = await adminFetch(`${opts.url}/api/admin/levels`, token, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: compact,
});

console.log(
  `Published level ${body.id}` +
    (body.seed != null ? ` (seed ${body.seed})` : "") +
    ` to ${opts.url}`
);
