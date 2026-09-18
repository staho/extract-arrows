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

## GitHub secrets

Configure these repository secrets for deployment:

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | API token with **Edit Cloudflare Workers** (include the `staho.dev` zone in the token scope) |

`staho.dev` must be an active zone on the same Cloudflare account. On deploy, Wrangler attaches the custom domain and creates the DNS record.

## Arrow Out 2 live levels

arrow-out-2 still fetches `./arrows.json`. In production the Worker intercepts that path and returns the current D1 row; if D1 is empty or unreadable it falls back to the bundled `arrows.json` asset.

One-time Cloudflare setup (from `games/arrow-out-2`):

```bash
npx wrangler d1 create arrow-out-2
```

Paste the printed `database_id` into `wrangler.jsonc`, then:

```bash
npx wrangler d1 migrations apply arrow-out-2 --remote
npx wrangler secret put ADMIN_TOKEN
```

If `database_id` is still the local placeholder, deploy CI looks up (or creates) the `arrow-out-2` D1 database and patches the Worker config for that deploy only.

Publish a new live puzzle (generation stays on your machine):

```bash
# generate then POST
ARROW_ADMIN_TOKEN=... npm run publish -- --seed=42

# or publish an existing file
node games/arrow-out-2/tools/generate-arrows.mjs --seed=42 --out=/tmp/level.json
ARROW_ADMIN_TOKEN=... npm run publish -- --file=/tmp/level.json
```

Other admin commands:

```bash
ARROW_ADMIN_TOKEN=... npm run publish -- --list
ARROW_ADMIN_TOKEN=... npm run publish -- --current=3
```

`--url` defaults to `https://arrow-out-2.staho.dev`. Use `--url=http://127.0.0.1:8787` against `wrangler dev`.

The Worker secret `ADMIN_TOKEN` is separate from the GitHub deploy secrets. Redeploys keep it; GitHub Actions never needs the publish token.

You can also run the workflow manually via **Actions → Deploy Games → Run workflow** to redeploy every valid game.

## PR previews

Pull requests that change `games/**` (or the PR deploy workflow) deploy preview Workers without touching production:

- Worker name / custom domain: `<slug>-pr-<pr_number>` → `https://<slug>-pr-<pr_number>.staho.dev`
- Only games changed in the PR (vs the base branch) are deployed; changing the PR workflow redeploys every valid game
- A sticky PR comment lists the preview URLs
- When the PR is closed or merged, those preview Workers (and their DNS records) are deleted

Same-repo PRs only (forks cannot use the Cloudflare secrets).
