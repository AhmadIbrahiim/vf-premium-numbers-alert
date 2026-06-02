# VF Premium Numbers Alert

Monitors Vodafone Egypt's public "Red" eSIM phone-number catalog on a schedule,
scores every number for how **premium** its digit pattern is, surfaces the best 30
currently-available numbers (refined by an LLM), tracks new arrivals and how long
each has been available, and shows it all on a static dashboard. Runs entirely
inside GitHub — no servers, no external secrets.

## How it works

A scheduled GitHub Actions workflow (`.github/workflows/poll.yml`, best-effort every
~10 min) runs `src/run.js`, which:

1. **fetch** — pulls the full catalog with the static `x-context-request` header (no
   cookie/token needed), retrying with backoff on 5xx.
2. **score** — `src/score.js` rates every number 0–100 on digit-pattern heuristics
   (repeats, runs, palindromes, repeating blocks, round endings, low digit variety…).
3. **diff** — `src/diff.js` compares the available set against `history.json`: NEW,
   DISAPPEARED, first-seen age. Guards against bad fetches (silent first-run baseline,
   skips when the count drops >50%).
4. **grade** — `src/grade.js` sends the top ~80 candidates to **GitHub Models**
   (free, authed by the built-in `GITHUB_TOKEN`) for a best-30 ranking with reasons.
   On any failure it falls back to the deterministic ranking.
5. **store** — updates `history.json` + writes `latest.json` for the dashboard.
6. **notify** — opens/comments a GitHub Issue when a NEW number grades ≥ threshold.
7. **publish** — commits data + dashboard to the `gh-pages` branch **only when the
   meaningful state changed** (no timestamp-only commits).

The dashboard (`web/`) is served from `gh-pages` and fetches `latest.json` /
`history.json` same-origin.

## One-time setup

1. Push this repo to GitHub (public).
2. **Settings → Actions → General → Workflow permissions:** "Read and write
   permissions" (lets the workflow push to `gh-pages` and open issues).
3. Run the workflow once: **Actions → poll-vf-numbers → Run workflow**. This seeds the
   baseline (no alerts on the first run) and creates the `gh-pages` branch.
4. **Settings → Pages:** source = branch `gh-pages`, folder `/ (root)`.
5. Visit `https://<you>.github.io/<repo>/`.

No secrets are required — `GITHUB_TOKEN` is provided automatically.

## Configuration

Set as workflow `env:` or repo variables (all optional):

| Var | Default | Purpose |
|---|---|---|
| `MODEL` | `openai/gpt-4o-mini` | GitHub Models model (keep a low tier for daily caps) |
| `ALERT_THRESHOLD` | `85` | Min grade for a NEW number to open an Issue |
| `CANDIDATE_COUNT` | `80` | How many top-scored numbers the LLM ranks |
| `BEST_COUNT` | `30` | How many to surface |

## Local development

```bash
node --test                       # run all unit tests (zero dependencies, Node 20+)
DATA_DIR=/tmp/vf node src/run.js  # live dry run (no token -> deterministic grading)
cd web && python3 -m http.server  # preview dashboard (cp a latest.json/history.json in)
```

## Notes

- GitHub scheduled cron is best-effort; effective cadence is ~10–20 min.
- The numbers are already publicly listed on Vodafone Egypt's shop; the dashboard just
  organizes that public data.
- If Vodafone rotates the `x-context-request` context and fetches start failing, the
  run skips safely without corrupting data.
