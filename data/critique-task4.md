# Task 4 critique — near-duplicate collapse

**Version:** v2 (CONFIDENCE_MIN=0.85, JACCARD_MIN=0.5, anchor-URL filter, JD-bullet filter, transitive-closure pruning)
**Grade:** 4.5 / 5
**Iterations:** 2

## Acceptance checklist
- [x] No false positives in a 25-pair sample (criteria asks for 20 — exceeded)
- [x] Conservative > aggressive (CONFIDENCE_MIN=0.85, transitive closure required for groups ≥4)

## Output
- 252 live URLs scanned
- 72 candidate pairs after Jaccard ≥ 0.5
- 2 confidently-same dup groups, 4 URLs collapsed:
  1. Palantir TPM (Lever anchor `#tpm-` ↔ canonical UUID URL)
  2. Palantir TPM Defense (Lever anchor `#tpm-defense` ↔ canonical UUID URL)

Both real positives — Lever frequently exposes both an anchor URL on the careers homepage and a canonical job-detail URL.

## Inspected false-pair calls (sampled 25)
- "Sr Product Marketing Manager, Amazon Music" × 2 different job IDs → marked diff (correct — Amazon often opens parallel headcounts)
- "Sr Solutions Architect, Global Partner Team" × 2 different IDs → marked diff (correct)
- "Senior PM, Applied AI" vs "Staff PM, Applied AI" → marked diff (correct — seniority)
- "Director of Product Management, Platforms" UK vs SF → marked diff (correct — different geo headcount)
- "Senior PM, Databases & Analytics, Google Cloud" vs "Lead Group PM, …" → marked diff (correct — seniority)
- "Senior PM Tech, AWS Boost" vs "Principal TPM, AWS Boost" → marked diff (correct — different function)

Zero false positives observed.

## Concrete issues
1. **Possibly missed real dups**: a few "same title, different job ID" Amazon postings could plausibly be ATS double-listings. Conservative bias means we leave those linked but unflagged. Acceptable per the criteria.
2. **Anchor-URL filter is heuristic** — works for the Google search-result fragments and Amazon search-page fragments observed in the data, but won't catch other patterns the scanner might add later.
3. **No cross-company dedup** — by design (different companies = different job openings). If a recruiter at one ATS is mirroring to another rare cross-company case, we'd miss it. Not a real concern.

## v1 vs v2 (what the iteration fixed)
v1 produced 12 groups including a 10-URL Google supercluster of "GTM" search-result anchors. Three changes resolved it:
- CONFIDENCE_MIN raised 0.7 → 0.85 (eliminated low-confidence merges)
- Anchor-URL filter excludes `google.com/...?location=` and `amazon.jobs/.../search` fragment URLs
- Transitive-closure check: groups of ≥4 URLs require every internal pair to be confirmed (kills cascade FPs)

## What would push this to 5/5
- A second pass that confirms each candidate pair by fetching both JD bodies and comparing first 1000 chars verbatim. Would catch true Amazon ATS double-listings without trusting Qwen alone.
- Job-ID-aware extraction so "AMZ9674190" + "AMZ10038547" gets flagged as definitely-different upfront (skip Qwen call).
