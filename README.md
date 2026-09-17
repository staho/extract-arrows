# extract-arrows

Static HTML games deployed as individual Cloudflare Workers.

## Game layout

Each game lives under `games/<slug>/` and must include:

- `index.html` — the game entrypoint
- `wrangler.jsonc` — assets-only Worker config (`name` should match the folder slug)

Example:

```text
games/
  arrow-out-1/
    index.html
    wrangler.jsonc
  arrow-out-2/
    index.html
    arrows.json
    wrangler.jsonc
```

Adding a new game: create `games/<slug>/` with those two files. On push to `main`, the Deploy Games workflow detects changed game folders and deploys each as its own Worker (`https://<slug>.<subdomain>.workers.dev`).

## Local serve

```bash
npm run serve
```

Then open `http://localhost:8000/games/arrow-out-1/` (or another game path).

## GitHub secrets

Configure these repository secrets for deployment:

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | API token with Edit Cloudflare Workers permission |

You can also run the workflow manually via **Actions → Deploy Games → Run workflow** to redeploy every valid game.
