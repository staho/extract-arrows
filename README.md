# extract-arrows

Static HTML games deployed as individual Cloudflare Workers on `staho.dev`.

## Game layout

Each game lives under `games/<slug>/` and must include:

- `index.html` — the game entrypoint
- `wrangler.jsonc` — Worker config (`name` should match the folder slug; custom domain `https://<slug>.staho.dev`)

Example:

```text
games/
  arrow-out-1/
    index.html
    wrangler.jsonc
  arrow-out-2/
    index.html
    arrows.json
    worker.js
    wrangler.jsonc
    migrations/
    tools/
```

Adding a new game: create `games/<slug>/` with `index.html` and `wrangler.jsonc`, set the route pattern to `<slug>.staho.dev` with `custom_domain: true`, then push to `main`. The Deploy Games workflow detects changed game folders and deploys each Worker. If the game folder has a `migrations/` directory, the workflow applies those D1 migrations before deploy.

Live URLs:

- https://arrow-out-1.staho.dev
- https://arrow-out-2.staho.dev

## Local serve

```bash
npm run serve
```

Then open `http://localhost:8000/games/arrow-out-1/` (or another game path). `npm run serve` is a static Python server, so arrow-out-2 loads the bundled `arrows.json`. To exercise the Worker + D1 path locally:

```bash
cd games/arrow-out-2
cp .dev.vars.example .dev.vars   # then set ADMIN_TOKEN
npx wrangler d1 migrations apply arrow-out-2 --local --persist-to=../../.wrangler/arrow-out-2
npx wrangler dev --persist-to=../../.wrangler/arrow-out-2
```

Keep `--persist-to` outside `games/arrow-out-2` so D1's local SQLite files do not trigger Wrangler's asset watcher. Do not commit `.dev.vars` (it holds the local admin token).

## Generating Arrow Out 2 puzzles

`npm run generate` runs [`games/arrow-out-2/tools/generate-arrows.mjs`](games/arrow-out-2/tools/generate-arrows.mjs) and writes [`games/arrow-out-2/arrows.json`](games/arrow-out-2/arrows.json), the bundled fallback the game loads.

Recommended:

```bash
npm run generate -- --seed=<s> --max-len=10 --min-corners=3
```

The same `--seed` always produces the same packing. If omitted, a random seed is drawn and printed so you can reproduce the run.

Pieces are chains of **3–10** cells (`--max-len=10`). Default grower is `walk` (hooks, staircases, spirals). `--grower=stamp` is the older 1–3 column peel (lengths summing to 3–6).

Other flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--max-len` | 10 | Max cells per piece. |
| `--min-corners` | 2 | Soft per-piece corner floor (85% rejection below it). Use **3**. |
| `--min-fill` | 0.9 | Void budget of `(1 - min-fill)` of the cube. Voids are spent only when a leftover blob cannot become a twisty snake. |
| `--best` | 1 | Generate this many valid packs; keep the one with most corners per cell. |
| `--grower` | `walk` | `walk` or `stamp`. |
| `--turn-bias` | 0.7 | Bias toward turning vs continuing straight (`walk` grower). |
| `--attempts` | 40 | Max packing attempts for the seed. |
| `--min-bent` | 0.55 | Minimum fraction of non-straight pieces. |

On the 10³ cube the void budget is a safety valve, not a hole punch: with `--min-fill=0.9 --min-corners=3` the backtracker still closes the cube (100% fill, `voids: []`). Extra twist comes from the corner floor and endgame reorder, not from empty cells.

### `arrows.json` contract

The generator (and the D1 `payload` blob, which stores the same JSON) looks like:

```json
{
  "grid": 10,
  "cell": 1.15,
  "seed": "local-walk",
  "attempt": 1,
  "grower": "walk",
  "stats": {
    "arrows": 129,
    "cells": 1000,
    "fill": 1,
    "bent": 126,
    "corners": 642,
    "meanLength": 7.75,
    "pulls": 129,
    "freeAtStart": 49,
    "voids": 0
  },
  "arrows": [{ "color": 0, "cells": [[x, y, z], "..."] }],
  "voids": []
}
```

- `grid`, `cell` — lattice; the renderer expects `grid === 10` and `cell === 1.15`.
- `seed` — string used for the run (the HUD already displays date-like seeds such as `YYYY-MM-DD`).
- `attempt` — which packing attempt succeeded.
- `grower` — `"walk"` or `"stamp"`.
- `arrows[]` — `{ color, cells }`. Cells are stored **head-first**; the facing direction is `cells[0] - cells[1]`. Each piece is **3–10** cells.
- `voids` — leftover empty cells `[[x, y, z], ...]`. Usually `[]` on the cube.
- `stats` — `{ arrows, cells, fill, bent, corners, meanLength, pulls, freeAtStart, voids }`.

The playable contract is occupancy from `arrows[].cells`. `voids` cells are unoccupied; extraction corridors through them are already treated as clear. Extra metadata fields are ignored by the renderer.

## GitHub secrets

Configure these repository secrets for deployment:

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | API token with **Edit Cloudflare Workers** (include the `staho.dev` zone in the token scope). Add **D1 edit** if deploy should create/migrate the live-level database. |
| `ARROW_ADMIN_TOKEN` | Same value as the arrow-out-2 Worker secret `ADMIN_TOKEN`. Used by **Publish Arrow Out 2 level** to POST a new puzzle. |

`staho.dev` must be an active zone on the same Cloudflare account. On deploy, Wrangler attaches the custom domain and creates the DNS record.

## Arrow Out 2 live levels

arrow-out-2 still fetches `./arrows.json`. In production the Worker intercepts that path and returns the current D1 row; if D1 is empty or unreadable it falls back to the bundled `arrows.json` asset. Past puzzles stay in D1; the HUD prev/next control loads them from `GET /api/archive` and `GET /arrows.json?id=<n>`. A shared URL can pin a past puzzle with `?id=<n>`. Each attempt has 3 lives (a blocked click costs one) and a timer that starts on the first arrow click. Wins can be posted to `POST /api/scores`; `GET /api/scores?id=<n>` returns the top 10 best times for that puzzle.

One-time Cloudflare setup (from `games/arrow-out-2`):

```bash
npx wrangler d1 create arrow-out-2
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler d1 migrations apply arrow-out-2 --remote
npx wrangler secret put ADMIN_TOKEN --name arrow-out-2
```

Then add that **same token value** as the GitHub secret `ARROW_ADMIN_TOKEN`. Production `arrow-out-2.staho.dev` must already be the D1 Worker (merge the live-levels PR first) or publish will 404.

Deploy CI also looks up or creates the `arrow-out-2` D1 database when the token has D1 edit. The current remote id is already in `wrangler.jsonc`.

### Automated publish

A new level is generated and POSTed to D1 every day at 00:00 UTC, using seed `YYYY-MM-DD`. You can also run it by hand: **Actions → Publish Arrow Out 2 level → Run workflow** (optional seed; empty uses today's UTC date).

Publish from your machine:

```bash
# generate then POST
ARROW_ADMIN_TOKEN=... npm run publish -- --seed=42

# or publish an existing file
node games/arrow-out-2/tools/generate-arrows.mjs --seed=42 --max-len=10 --min-corners=3 --out=/tmp/level.json
ARROW_ADMIN_TOKEN=... npm run publish -- --file=/tmp/level.json
```

Other admin commands:

```bash
ARROW_ADMIN_TOKEN=... npm run publish -- --list
ARROW_ADMIN_TOKEN=... npm run publish -- --current=3
```

`--url` defaults to `https://arrow-out-2.staho.dev`. Use `--url=http://127.0.0.1:8787` against `wrangler dev`.

The Worker secret `ADMIN_TOKEN` and the GitHub secret `ARROW_ADMIN_TOKEN` must match. Redeploys keep the Worker secret.

You can also run the workflow manually via **Actions → Deploy Games → Run workflow** to redeploy every valid game.

## PR previews

Pull requests that change `games/**` (or the PR deploy workflow) deploy preview Workers without touching production:

- Worker name / custom domain: `<slug>-pr-<pr_number>` → `https://<slug>-pr-<pr_number>.staho.dev`
- Only games changed in the PR (vs the base branch) are deployed; changing the PR workflow redeploys every valid game
- A sticky PR comment lists the preview URLs
- When the PR is closed or merged, those preview Workers (and their DNS records) are deleted

Same-repo PRs only (forks cannot use the Cloudflare secrets).
