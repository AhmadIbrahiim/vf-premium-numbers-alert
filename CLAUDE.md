# CLAUDE.md

Operating notes for this repo. README.md explains what the project *is*; this file
records what was **expensive to learn** — the things that cost hours and would be
re-learned the hard way otherwise.

## Two packages, deliberately separate

| | Poller | Dashboard |
|---|---|---|
| Where | root `package.json`, `src/`, `test/` | `web/` |
| Deps | **zero** — defend this | Next.js + React |
| Runs on | GitHub Actions, every 30 min | Vercel (Root Directory `web`) |
| Reads | carrier APIs → Postgres | Postgres, server-side |

Installing one never touches the other. Don't add a dependency to the root package.

**The poller cannot move to Vercel.** A full poll takes 174–207s, past the function
ceiling (60s Hobby / 300s Pro), and WE throttling stretches it further. Vercel Cron
doesn't change this — it just triggers a function with the same limit.

## The carrier caps — the core of this project

All three APIs return HTTP 200 with a plausible-looking result set while silently
withholding most of the data. Queried naively they report ~14k numbers total; the real
figure is ~206k. Every cap below was verified against the live API.

| Carrier | Cap | Workaround | Real count |
|---|---|---|---|
| Vodafone | a separate catalog path per line type | page `red` **and** `flex`, and drop the `simFamilyType==OWNER` filter | ~5.2k |
| Etisalat | ~1000 numbers per response, whatever you ask for | `searchPattern` takes a fixed-width mask (`011******52`), so partition each pool by its last 2 digits → 100 disjoint buckets under the cap | ~96k |
| WE | 51/page, **20,000/query**, **and short pages under load** | `fitmod` is a digit mask; split a capped query by fixing one more leading digit. Re-check any short page before believing it | ~105k |

Three things to internalise:

- **A round number is a cap, not a total.** Two WE grades reporting exactly 20,000 was
  the tell. GRADE_006 actually holds ~66k.
- **The short-page bug was the nastiest.** Under load WE returns a short or empty page
  spuriously; trusting it silently abandoned the rest of a branch. The same grade
  returned 61,401 → 56,271 → 53,541 across consecutive runs. It only appears under load
  and *looks exactly like inventory churn*.
- **Verify by cross-measuring, never by assertion.** Fetch the same slice twice and diff
  (that is how the short-page bug surfaced), or count the same pool two unrelated ways
  (Etisalat pool 135: 69,141 via suffix buckets in 100 requests vs 69,142 via an
  exhaustive prefix tree-walk in ~10,000).

I once wrongly concluded Etisalat was under-collecting by comparing one pool's 69k
against the deduped 96k total. Compare like with like.

## WE throttles by IP, and it doesn't say so

`numbers.te.eg` rate-limits by IP. It returns no 429 — connects just slow to 19s+, and
undici's connect timeout is 10s and can't be raised without a custom dispatcher, so
**every retry fails regardless of backoff**. Recovery takes ~2–20 minutes of quiet.

- Triggered by running full enumerations back to back (a poll is ~3,500 WE requests).
- Check with one real API request, **not** `curl https://numbers.te.eg/` — the host stays
  reachable while the API path is throttled.
- Keep `WE_CONCURRENCY` at 4 with `WE_MIN_REQUEST_MS` pacing. 8 got us throttled twice.
- Don't run repeated full polls while developing. Scope with `WE_GRADE_MIN/MAX`.

## Partial failure is normal and handled

A carrier that fails, or returns less than `CARRIER_SHRINK_TOLERANCE` (90%) of what the
DB holds, is **carried over**: its numbers are refreshed but none of its rows are
retired, and the other carriers still update. Only an all-carrier failure skips the run.
This is only safe because state is per-row in Postgres. `markGone` with an empty carrier
list is a deliberate no-op, never a mass retirement.

## Score ceiling is 59, not 100

The scorer's range is 0–100, but across all ~206k numbers the highest observed score is
**59**. Distribution: ~134k under 10, ~8.3k over 20, ~215 over 50, ~20 over 60.

`ALERT_THRESHOLD` defaulted to 90, so **the alert had never once fired** since the
project began. It is now 50. Set any threshold against the measured distribution, not
the nominal range — a threshold no data can reach looks like a working feature that is
simply quiet. Score ring arcs are drawn against 60 for the same reason.

Alerts come from the run's new-number diff, not the LLM's best-30, so a strong arrival
the LLM didn't happen to rank still alerts.

## Database is the only state

No data files anywhere. Schema created on first run by `db.migrate()`.

| Table | Holds |
|---|---|
| `numbers` | one row per number ever seen; `first_seen` set once, `best_grade` only climbs, `run_seq` marks the run that last saw it (how disappearances are found) |
| `provider_runs` | one row per carrier per poll — the status page's source |
| `number_events` | recent NEW/GONE events for the change timeline |
| `meta` | LLM grade cache + run signature. **Never exposed to the dashboard** |

Neon speaks SQL over HTTPS, so `fetch` is the entire driver — no `pg`, no pooling to
reason about in serverless. Two gotchas:

- **An empty `text[]` decodes as `[""]`** over Neon's HTTP API, not `[]`. Normalise on
  read or blank tag pills appear.
- **`unnest` takes one array per column**, so per-row tag arrays can't be passed as
  `text[][]`. They travel as one comma-joined string per row and are split in SQL.

## Dashboard reads Postgres server-side

`web/lib/queries.js` is the **only** place SQL is written. Route handlers pass request
params to `buildQuery`, which whitelists them, binds them and clamps row limits —
request input never reaches SQL text. It is pure, so the repo-root `node --test` covers
it without booting Next.

`DATABASE_URL` is a private server env var. **Never** rename it to
`NEXT_PUBLIC_DATABASE_URL`; that publishes the credential to every visitor.

### Dead ends, so nobody retries them

The dashboard used to be static on GitHub Pages, which has no server. That forced a
choice between exposing the database publicly or publishing a JSON snapshot. Both were
built; both were worse than the problem. Server-side rendering deleted the whole
category — along with `src/publish.js`, `worker/api.js`, `db/grants.sql` and every
gh-pages step. **Going to a server-rendered app first would have skipped both detours.**

- **Neon Data API** is *not* enabled on this project. Probing
  `*.apirest.<region>.aws.neon.tech` proves nothing — a nonexistent endpoint returns the
  same "requires JWT" message. Check for an `anonymous` role in `pg_roles` instead.
  Enabling it is a console action that also creates that role; it can't be done over SQL
  with the owner credential.
- **Cloudflare**: the credential available here is **read-only**. Listing scripts and
  reading settings succeed; a Worker upload and any setting write fail with
  `10000: Authentication error`, and `/user/tokens/verify` says `Invalid API Token`. No
  `wrangler`, no `CLOUDFLARE_API_TOKEN`. Test writeability with a cheap write before
  building on it.

## Email alerts

Resend, from the **poller** — the web app has nothing email-related in it.

The Resend account is registered to **laila.alazap@gmail.com** with **no verified
domain**, so the shared `onboarding@resend.dev` sender only delivers to that address. A
send anywhere else returns 403 naming the owner. Ahmed asked for
`ahmed.ibrrahhim@gmail.com` and chose the owner address as the interim. To change it:
verify a domain at resend.com/domains, then set the `ALERT_EMAIL_FROM` repo variable and
the `ALERT_EMAIL_TO` secret — both are read at call time, no code change.

## Configuration is read at call time, not import time

`src/config.js` captures most values at import, which makes them untestable and
surprising. Anything env-dependent that must reflect the current environment reads
`process.env` at call time instead: `DATABASE_URL` (in `src/db.js`), the Resend settings
(in `src/email.js`), and `ALERT_THRESHOLD` (in `src/run.js`). This bit twice — a
cache-busted `import()` in tests still gets the *same* `config.js` instance.

## Commands

```bash
node --test                            # poller + query tests, no deps needed

DATABASE_URL=postgres://... node src/run.js          # live dry run
WE_GRADE_MIN=17 WE_GRADE_MAX=17 ...                  # scope WE while developing
REGRADE=1 ...                                        # bypass the LLM grade cache

cd web && npm install && npm run dev   # dashboard; needs web/.env.local
cd web && npm run build                # must pass before pushing
cd web && npx vercel --prod            # deploy
```

No `GITHUB_TOKEN` → grading falls back to the deterministic scorer, which is fine for a
dry run.

## Remotes

- `origin` → GitHub `AhmadIbrahiim/vf-premium-numbers-alert` — **primary**. The Actions
  workflow lives here; all branch upstreams point here.
- `gitlab` → GitLab `laila.alazap/vf-premium-numbers-alert` — private **mirror**, pushed
  over the `gitlab-alt` SSH alias. No CI there.

Two SSH identities resolve differently on gitlab.com: the default key is
**@AhmadIbrahim**, `~/.ssh/gitlab_alt` is **@laila.alazap**. The `IdentitiesOnly yes`
line in `~/.ssh/config` is what keeps them apart — without it ssh offers `id_rsa` first
and GitLab authenticates as the wrong account, which presents as a permissions error.

Never `git push -u gitlab` — that retargets the branch's upstream and later pushes go to
the mirror instead of GitHub.

## Secrets

None in the repo (`web/.env.example` holds placeholders only). Live values:

| Where | Holds |
|---|---|
| GitHub Actions secrets | `DATABASE_URL`, `RESEND_API_KEY`, `ALERT_EMAIL_TO` |
| Vercel env | `DATABASE_URL` only |
| Local | `web/.env.local` (gitignored) |

## Shell gotcha

This machine runs **zsh**, where `"$var:refs/..."` applies the `:r` *remove-extension*
modifier and silently mangles the string. Always brace it: `"${var}:refs/..."`. It cost
a confusing round of "src refspec does not match any".
