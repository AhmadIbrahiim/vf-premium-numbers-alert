# Dashboard (Next.js on Vercel)

Reads Neon Postgres **server-side**, so `DATABASE_URL` is a private environment
variable and no database credential ever reaches the browser. That is the whole reason
this replaced the static GitHub Pages build: a static host has no server, which forced
either a publicly readable database or a published JSON snapshot.

The poller is separate and runs on a GitLab CI schedule (`src/`). It cannot run here: a
full poll takes 3-5 minutes, past Vercel's function ceiling.

## Deploy

The app is at the **repo root**, so Vercel auto-detects Next.js with no Root Directory
setting — that setting is what produced two `404: NOT_FOUND` deployments, so it was
removed from the equation on purpose.

```bash
npx vercel                                    # first run links the project
npx vercel env add DATABASE_URL production    # paste the Neon connection string
npx vercel --prod
```

Importing through the Vercel dashboard works the same way: leave Root Directory empty
and add `DATABASE_URL` (Production, Preview and Development). `regions` in `vercel.json`
is `iad1` to sit beside the `us-east-2` Neon project — further away adds a round trip to
every query.

## Local development

```bash
npm install
echo 'DATABASE_URL=postgresql://…' > .env.local   # never commit this
npm run dev
```

## Layout

Paths are relative to the repo root.

| Path | Role |
|---|---|
| `app/page.jsx` | Numbers list, server-rendered so the first paint has data |
| `app/status/page.jsx` | Provider health from `provider_runs` |
| `app/api/numbers`, `app/api/counts` | Route handlers the client calls for search/sort/paging |
| `lib/queries.js` | Every allowed query, parameterised. Pure — unit-tested from the repo root |
| `lib/db.js` | Server-only Neon client. `fetch` is the whole driver; no `pg` |
| `lib/format.js` | Shared pure formatters |

`lib/queries.js` is the only place SQL is written. Route handlers pass request params to
`buildQuery`, which validates them against a whitelist and binds them — request input
never reaches the SQL text. Row limits are clamped so no single request can drain the
table.
