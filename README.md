# extract-arrows

Static HTML games deployed as individual Cloudflare Workers on `staho.dev`.

## Game layout

Each game lives under `games/<slug>/` and must include:

- `index.html` — the game entrypoint
- `wrangler.jsonc` — assets-only Worker config (`name` should match the folder slug; custom domain `https://<slug>.staho.dev`)

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

Adding a new game: create `games/<slug>/` with those two files, set the route pattern to `<slug>.staho.dev` with `custom_domain: true`, then push to `main`. The Deploy Games workflow detects changed game folders and deploys each Worker.

Live URLs:

- https://arrow-out-1.staho.dev
- https://arrow-out-2.staho.dev

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
| `CLOUDFLARE_API_TOKEN` | API token with **Edit Cloudflare Workers** (include the `staho.dev` zone in the token scope) |

`staho.dev` must be an active zone on the same Cloudflare account. On deploy, Wrangler attaches the custom domain and creates the DNS record.

You can also run the workflow manually via **Actions → Deploy Games → Run workflow** to redeploy every valid game.
