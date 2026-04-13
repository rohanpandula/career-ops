# Task 6 critique — weekly digest

**Version:** v2 (added hard-exclusion list to prompt, garbage-title filter for top-5)
**Grade:** 4.4 / 5
**Iterations:** 2

## Acceptance checklist
- [x] Narrative <400 words (sample: ~150 words for content-rich week, ~80 for sparse)
- [x] Cites specific roles by company + title (every TL;DR + recommended action references one specific role)
- [x] Recommended action is concrete (e.g. "Apply to Google Principal PM Innovation and AI Transformation before Friday — fit 4.8")
- [x] Numeric claims match underlying data exactly (414 new, 266 live, 107 fit≥4 — all match `aggregate()` output)

## Sampled outputs
- **Week of 2026-04-06** (414 new URLs, 5 top fits, all Google): TL;DR names "Google Principal PM Innovation and AI Transformation". Top-5 list correct. Action concrete with deadline.
- **Week of 2026-04-13** (6 new URLs, 0 top fits after garbage filter): Falls back to recommending triage of the 11 fit≥4.5 backlog. No invented roles.

## Concrete issues
1. **Top-5 dominated by single-source weeks** — when Google scan yields 80% of new URLs, top-5 is all Google. Acceptable (reflects reality) but loses diversity for the user.
2. **`Foundational Algorithms, Aligned AI` style Google research roles** — fit-score gave 4.5, narrative cites them as PM roles. May be research-PM (target) or research-engineer (off-target). Trusts upstream fit-score.
3. **Quiet-applications threshold (>7d)** — at the moment user has only 2 applications, both within 7 days, so this section is always "None". Will become useful with scale.
4. **Empty-week recommendation** — when no new fits, narrative still produces a sensible action by pivoting to the backlog. Tested.

## Known-good behaviours
- Numbers are computed deterministically from scan-history.tsv + applications.md + fit-scores.json + liveness — Qwen never sees raw numbers it could miscount.
- Hard exclusion of Meta / xAI / Director-VP recommendations baked into prompt.
- Filter strips amazon.jobs/search and google.com/results anchor URLs from top-5 candidates so JD-bullet "titles" don't appear.
- Cache write to `data/digest/YYYY-MM-DD.md` keyed by Monday — re-runs same week are no-ops without `--redo`.

## What would push this to 5/5
- Diversity guard for top-5 (cap 2 per company so user sees roles from multiple sources)
- Cross-reference applications.md to detect "applications you marked Applied but were never followed up" (currently uses Date column only)
- Per-week trend lines (URL volume vs prior week, fit-distribution shift) — would surface "Google posted 3× their normal volume" insight
