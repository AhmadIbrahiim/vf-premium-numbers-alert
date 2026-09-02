# Dashboard (Next.js on Vercel)

Reads Neon Postgres **server-side**, so `DATABASE_URL` is a private environment
variable and no database credential ever reaches the browser. That is the whole reason
this replaced the static GitHub Pages build: a static host has no server, which forced
either a publicly readable database or a published JSON snapshot.

The poller is separate and stays in GitHub Actions (`../src`). It cannot run here: a
full poll takes 3-5 minutes, past Vercel's function ceiling.

## Deploy

```bash
cd web
npx vercel            # first run links the project
npx vercel env add DATABASE_URL production   # paste the Neon connection string
npx vercel --prod
```

If you import the repo through the Vercel dashboard instead, set **Root Directory** to
`web` and add `DATABASE_URL` as an environment variable. `regions` in `vercel.json` is
`iad1` to sit next to the `us-east-2` Neon project — moving it further away adds a round
trip to every query.

## Local development

```bash
cd web
npm install
echo 'DATABASE_URL=postgresql://…' > .env.local   # never commit this
npm run dev
```

## Layout

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
