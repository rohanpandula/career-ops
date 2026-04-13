# Career-ops local-LLM extension — handoff summary

Generated 2026-04-13 after implementing 5 Qwen-backed features on the
career-ops job-search pipeline. Each feature ran through a self-critique
loop (build → sample → grade → refine, max 3 iterations).

## Feature grades

| # | Feature | Grade | Script | Cache | UI integration |
|---|---------|------:|--------|-------|----------------|
| 1 | Role clustering | **4.2 / 5** | `cluster-roles.mjs` | `data/clusters.json` | Dashboard chips → filter Pipeline |
| 3 | JD gap analysis | **4.3 / 5** | `gap-analysis.mjs` | `data/gap-analysis.json` | Pipeline row expand with matches/gaps/must_explain |
| 4 | Near-duplicate collapse | **4.5 / 5** | `find-duplicates.mjs` | `data/dedupe.json` (+ `dedupe-cache.json`) | Dup chip on Pipeline rows |
| 6 | Weekly digest | **4.4 / 5** | `weekly-digest.mjs` | `data/digest/YYYY-MM-DD.md` | "Digest" nav link, latest-week render |
| 9 | Taste inference | **4.0 / 5** | `infer-taste.mjs` | `data/taste-proposal.md` | Settings page Accept / Reject |

Each feature has its critique file at `data/critique-task{N}.md` listing
specific issues, the validator logic, and what would push it to 5/5.

## User-visible entry points
- **Dashboard → Clusters panel** — click any cluster chip to filter the Pipeline page to that URL set.
- **Pipeline → row click** — rows with a ▾ glyph expand to show CV matches (green) and gaps (orange) plus a cover-letter bullet list.
- **Pipeline → dup chip** — canonical rows show `+N dup`; duplicate rows show `↗ canonical` linking to the preferred URL.
- **Digest nav link** — renders the latest weekly digest as markdown.
- **Settings page** — when `data/taste-proposal.md` exists, a panel with Accept / Reject appears at the top.

## What the user should review first
1. **`modes/_profile.md` after accepting the taste proposal** — the accept path APPENDS a clearly-marked block at the end of the file rather than merging inline. The user may want to prune duplicates or integrate the new rows into existing tables.
2. **`data/clusters.json`** — two Google clusters ("AI + Cloud Infrastructure" and "Generative AI + Cloud") have overlapping names; user may prefer to rerun with `--redo` when pipeline composition shifts.
3. **`data/dedupe.json`** — only confirmed-high-confidence dedup groups are surfaced (2 groups today). Intentionally conservative — the user is unlikely to see a false positive but may see true duplicates that were missed.
4. **`data/gap-analysis.json`** — OpenAI's custom careers page will not yield text through Browserless (one fetch failure per run); would need a dedicated OpenAI extractor to fix.
5. **`data/digest/YYYY-MM-DD.md`** — digest fills out useful once applications > 0 generating quiet + moving-forward sections. Today most signal is in Top-5 new-fit plus the recommended action.

## Known limitations carried over from upstream data
- Pipeline includes "search-result anchor" URLs (e.g. `google.com/.../jobs/results?...#...`) whose titles are sometimes JD bullet text instead of real role names. All five features now filter these out at their own layer, but the pipeline itself still contains them.
- `cv.md` is the canonical source of truth for gap-analysis and taste inference. If the user hasn't updated it recently, matches/gaps will understate their actual skills.
- Taste inference is thin by design today: 2 applications gives a single evidence pair. It will sharpen with more history.

## Idempotency + re-runs
Every script is idempotent:
- `cluster-roles.mjs` — 24h cache window; pass `--redo` to recluster.
- `gap-analysis.mjs` — per-URL cache in `data/gap-analysis.json`; pass `--redo` to re-ask Qwen.
- `find-duplicates.mjs` — per-pair cache in `data/dedupe-cache.json`; pass `--redo` to re-ask.
- `weekly-digest.mjs` — keyed by Monday of the target week; pass `--redo` to overwrite.
- `infer-taste.mjs` — no-op if `data/taste-proposal.md` exists; pass `--redo` to regenerate.

All Qwen calls parse JSON defensively (fenced or not, nested braces) and
never throw from bad output. Fallbacks vary by feature (see each script's
`main()`).

## Commits in this handoff
Eleven commits on `main`:
- 5 × `feat(taskN): ... v{version} (grade X.X/5)` — the core script + cache + critique
- 5 × `feat(taskN): API + UI wiring` — server route + dashboard/pipeline/settings hooks
- 1 × this summary file (same commit as `handoff-summary.md`)

Each pair is atomic so the user can revert either the backend or the UI
independently.
