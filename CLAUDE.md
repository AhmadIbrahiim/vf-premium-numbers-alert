# CLAUDE.md

Operating notes for this repo. README.md explains what the project *is*; this file
records what was **expensive to learn** — the things that cost hours and would be
re-learned the hard way otherwise.

## Two packages, deliberately separate

| | Poller | Dashboard |
|---|---|---|
| Where | `src/`, `test/` | `app/`, `components/`, `lib/` |
| Runs on | GitLab CI schedule, every 30 min | Vercel (repo root, no config) |
| Reads | carrier APIs → Postgres | Postgres, server-side |

One `package.json` at the root holds both, because Vercel auto-detects a Next app at the
repo root and nowhere else without a setting. `npm run poll` is the poller (Next needed
`start`).

**The poller's code still imports nothing outside `node:` builtins** — that is the
property worth defending, and `node --test` runs with no `npm install` at all. Don't add
a runtime dependency to `src/`.

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

`lib/queries.js` is the **only** place SQL is written. Route handlers pass request
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

## Scoring is calibrated to real inventory, not to 0-100

The scale is 0-100 but the best number in the catalogue scores **56**, and only ~170 of
202k clear 50. Anything keyed to the nominal range is wrong here:

- `ALERT_THRESHOLD` was 90 and could never fire (now 50).
- Score-tier words and the score ring both had bands wide enough that every row in a
  best-first list read "Exceptional". Bands are cut against the distribution instead.

**Ladders only score on steps a human perceives.** `pairLadder` used to reward any
arithmetic step between the four two-digit groups, so `01101173349` (01·17·33·49, step
16 — invisible) scored 59 and topped the list while `01555656789`, which contains a
plainly readable 656789, scored 28. Pairs now accept ±1, ±5, ±10, ±11 only; digit
ladders ±2 only; a 3-long step-2 run scores nothing. Weights put dictatability first: a
consecutive run beats a step-2 ladder of the same length, and a test pins that ordering.

**What the catalogue does not contain:** no numbers with 4+ repeated digits, 4+ trailing
zeros, or a repeated ABABAB block. Those sell through dealers, not public eSIM
catalogues. So the 56 ceiling is real inventory, and the scorer's only job is ranking
subtle differences well.

**best_grade is maintained with `greatest()`**, so recalibrating the scorer does not
lower it. After any scoring change, reset it or the old inflated values stay frozen in
and the fix is invisible in every best_grade-ordered view.

## The dashboard shows human language, never tags

Scorer tags are engineering identifiers (`ascending-run-x4`, `etisalat-platinum_plus`,
`ladder-step-2-x5`). They were rendered raw as pills, which read as debug output — a
buyer cannot tell whether `ladder-step-2-x5` is good. `patternLabel` in `lib/format.js`
maps them to plain phrases ("4 in a row up", "ends in 4 zeros") and returns null for
tags not worth surfacing. Add a mapping there whenever the scorer gains a tag.

The number is the hero: largest element, only monospace, one per row. Carrier is a 3px
edge stripe rather than a pill. There is no podium — it spent ~350px showing #1/#2/#3,
which are usually near-identical because carriers list numbers in blocks
(0110 123 2101 / 2102 / 2103, all 56).

## Change events: what arrived and what went

`/changes` groups `number_events` by poll. Two things that were wrong and are easy to
reintroduce:

- **Departed numbers are absent from the run's fetch**, so `scoreMap` and `carrierMap`
  have no entry and every departure logged as carrier `""` and score 0, which made the
  page unreadable. Score is a pure function of the digits and the carrier is fixed by
  the prefix (`carrierFromMsisdn`), so run.js recovers both before recording.
- **Retention is bounded in polls, not rows,** and keeps the highest-scoring events of
  each type per poll. A flat 2,000-row cap let one churny poll (1,916 gone at once)
  erase the whole timeline, and kept arbitrary numbers rather than notable ones.

## GitHub Models is dead — the LLM provider is now configuration

**GitHub retired GitHub Models on 2026-07-30.** The endpoint answers HTTP 410
`github_models_retirement_brownout`. It closed to new customers on 2026-06-16 and
browned out on 16 and 23 July. No token can revive it: the free ride came from the
`GITHUB_TOKEN` that GitHub Actions injected, and the service it authenticated is gone.

So grading now takes any **OpenAI-compatible** chat-completions API:

```
LLM_BASE_URL=https://api.openai.com/v1        # or openrouter.ai/api/v1, Azure AI Foundry, …
LLM_API_KEY=sk-…
MODEL=gpt-4o-mini
```

`LLM_API_KEY` is deliberately separate from `GITHUB_TOKEN` — conflating them is what tied
grading to GitHub in the first place. `GITHUB_TOKEN` is now only for the Issue-alert
channel. With `LLM_BASE_URL` empty, grading reports `heuristic:no-provider` and the
deterministic scorer runs, which is the designed behaviour.

## How grading works, and how it used to hide its own failure

`gradeCandidates` takes the top `CANDIDATE_COUNT` (150) numbers by heuristic score, asks
the configured model to rank the best `BEST_COUNT` (30) with reasons,
discards any msisdn it did not send (anti-hallucination), clamps grades to 0-100, and
caches the result in `meta.grades` keyed by a signature of the candidate set — so the
model is called only when the top 150 actually changes.

**Every failure path falls back to the heuristic**, which reuses the score as the grade.
That is correct behaviour, but the run summary used to print `llm=graded` for both, where
"graded" only meant *gradeCandidates was called*. The pipeline therefore reported
success while running entirely on heuristics, and the logs gave no hint.

It now reports `grading=model:<name>`, `grading=heuristic:<why>` (`no-provider`,
`no-token`, `http-503`, `bad-json`, …) or `grading=cached:<source>`. **Anything starting
`heuristic:` means the LLM is not running.** Two tells in the data:

- `best_grade` exactly equals `score` for every row
- `reason` is a comma-joined tag list (`"pair-ladder, etisalat-golden"`) rather than prose

Neither the model's grades nor its reasons can be recovered retroactively — the cache
holds whatever the last run produced, so clear `meta.grades` after fixing the token.

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

## The PWA — the service worker is the part that can hurt you

Installable via `app/manifest.js` (Next's metadata route, served at
`/manifest.webmanifest`), `public/sw.js`, and `components/install-prompt.jsx`.

**The service worker is the only component here that can break the site for a user who
then cannot fetch the fix**, because it keeps serving until something replaces it. That
is why `/sw.js` is sent `no-store` from `next.config.mjs` — a cached worker is close to
unfixable — and why the caching rules are narrow:

- **Navigations: network-first, never cached.** Every page renders live Postgres data. A
  cached page would later be served as if current, showing numbers that are gone. The
  fallback is `public/offline.html`, which deliberately shows no figures at all.
- **Cache-first only for `/_next/static/`.** Those URLs carry a content hash, so a hit is
  correct by construction. It once matched every same-origin png/svg/ico/webmanifest/woff
  — those URLs are *stable*, not hashed, so the icons and the manifest were pinned at
  their first-seen bytes and a manifest fix could never reach an installed user.
- **`/api` is not touched**, including a navigation to an API URL typed into the address
  bar — otherwise that navigation is answered with the offline HTML page.
- **Deletion is scoped by the `eg-numbers-` prefix.** `caches.keys()` is origin-wide.
- Precaching the offline page uses a bare `cache.add`, not `allSettled`: a version that
  installed without its own fallback would control every tab and answer outages with
  `Response.error()` forever. Failing install leaves the previous worker, which is safe.
- `cache.put` goes through `event.waitUntil` — the browser may kill the worker as soon as
  the response resolves and drop a pending write.

**The worker does not register in development.** Service workers do run on localhost, and
dev `/_next/static/` URLs are rebuilt without changing name, so cache-first serves stale
chunks and interferes with hot reload. `components/service-worker.jsx` unregisters in dev
instead, because a worker installed once keeps controlling localhost across every later
dev session. If localhost behaves impossibly, check for a leftover worker first.

Icon rules that fail *silently* — the browser just never offers to install, with no error
anywhere: a 192px **and** a 512px icon are both required, and maskable icons must be
separate entries from `purpose: "any"` ones (Android crops maskable icons to the device
silhouette, so one icon claiming both purposes is wrong in one of its two roles). iOS
uses `/apple-touch-icon.png` at 180x180 for the home screen regardless of the manifest.

Installation cannot be triggered from script. Chromium fires `beforeinstallprompt`, which
is stashed and replayed from a real button — a `prompt()` not tied to a user gesture is
ignored permanently. iOS fires nothing in *any* browser (they are all WebKit), so there
the prompt shows Share → Add to Home Screen steps; do not gate that on a Safari UA test
or Chrome/Firefox on iOS get no path at all.

Tests: `test/sw.test.js` runs the worker for real in a fake `ServiceWorkerGlobalScope`
(`test/helpers/sw-env.js`). Asserting on the worker's *source text* is close to
worthless — a grep for `"/api/"` passes whether or not API requests are bypassed. When
changing the worker, mutation-test it: revert a rule and confirm a test fails.

## Commands

```bash
node --test                            # poller + query tests, no deps needed

DATABASE_URL=postgres://... npm run poll             # live dry run
WE_GRADE_MIN=17 WE_GRADE_MAX=17 ...                  # scope WE while developing
REGRADE=1 ...                                        # bypass the LLM grade cache

npm install && npm run dev             # dashboard; needs .env.local
npm run build                          # must pass before pushing
npx vercel --prod                      # deploy
```

No `GITHUB_TOKEN` → grading falls back to the deterministic scorer, which is fine for a
dry run.

## Remotes and CI — GitLab is primary

- `origin` → GitLab `laila.alazap/vf-premium-numbers-alert`, over the `gitlab-alt` SSH
  alias. All branch upstreams point here. **GitLab runs the poller and Vercel deploys
  from it.**
- `github` → the old GitHub repo, kept only as a historical copy. Nothing runs there;
  its Actions workflow was deleted deliberately (see below).

Two SSH identities resolve differently on gitlab.com: the default key is
**@AhmadIbrahim**, `~/.ssh/gitlab_alt` is **@laila.alazap**. The `IdentitiesOnly yes`
line in `~/.ssh/config` is what keeps them apart — without it ssh offers `id_rsa` first
and GitLab authenticates as the wrong account, which presents as a permissions error.

### The schedule lives in project settings, not in the repo

`.gitlab-ci.yml` defines the `poll` job but **not** when it runs. GitLab keeps cron in
**Settings → CI/CD → Schedules**: cron `7,37 * * * *`, target branch `main`. Without that
schedule the poller simply never fires and nothing warns you.

`poll` uses `resource_group: poll` so two polls can never overlap — concurrent runs are
exactly how the WE IP throttle gets triggered.

### Never re-add a second scheduler

The GitHub Actions workflow was deleted, not disabled, on purpose. Two schedulers
polling the same carriers doubles the request volume against WE, which throttles by IP
and takes 2-20 minutes to recover. If GitHub Actions is ever restored, delete the GitLab
schedule first.

### What leaving GitHub Actions cost

Both are recoverable, and neither breaks a poll:

- **LLM grading.** Moot: GitHub Models was retired entirely (see above). Set
  `LLM_BASE_URL` and `LLM_API_KEY` to any OpenAI-compatible provider to restore it.
- **GitHub Issue alerts.** `src/notify.js` needs a token and `GITHUB_REPOSITORY`; off
  GitHub it returns `skipped-no-credentials` and does nothing. Email alerts via Resend
  are unaffected and remain the real alerting channel.

### Vercel: the app is at the repo root, deliberately

It used to live in `web/`, which needs **Root Directory = `web`** in project settings.
That setting was got wrong twice and each time produced a bare `404: NOT_FOUND` — the
tell being a build that finishes in milliseconds with
`Build Completed in /vercel/output [60ms]` and "no files were prepared". Nothing was
built; it is never a routing problem.

Moving the app to the root removed the setting from the equation entirely. **Don't move
it back into a subdirectory** unless you are prepared to own that setting.

`DATABASE_URL` must be set for Production, Preview **and** Development, or preview
deploys render the "couldn't reach the database" state.

## Secrets

None in the repo (`.env.example` holds placeholders only). Live values:

| Where | Holds |
|---|---|
| GitLab CI/CD variables | `DATABASE_URL`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `DASHBOARD_URL`, optionally `GITHUB_TOKEN` |
| Vercel env | `DATABASE_URL` only |
| Local | `.env.local` (gitignored) |

Mask every one of them, and leave "Protected" **off** unless `main` is a protected
branch — a protected variable is invisible to pipelines on unprotected branches, which
looks exactly like the variable not existing.

`DASHBOARD_URL` is the Vercel URL, used for the link in alert emails. It is explicit
because it is no longer derivable: the old code built a `<owner>.github.io/<repo>` link,
which now points at the retired Pages site.

## Shell gotcha

This machine runs **zsh**, where `"$var:refs/..."` applies the `:r` *remove-extension*
modifier and silently mangles the string. Always brace it: `"${var}:refs/..."`. It cost
a confusing round of "src refspec does not match any".
