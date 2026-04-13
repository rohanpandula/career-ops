# Task 9 critique — taste inference

**Version:** v1 (validator-gated; cites evidence; backups on accept)
**Grade:** 4.0 / 5
**Iterations:** 1 (validator passed first attempt; honest evidence-thin signal)

## Acceptance checklist
- [x] Proposed edits cite specific evidence from applications.md (Apple Agentic Commerce 2026-04-07, Microsoft Copilot AI 2026-04-11)
- [x] Does not override existing user-stated hard preferences (proposes ADDITIONS, never removals; respects existing target-roles table)
- [x] Self-flags weak evidence ("(weak evidence — only 1 datum)" tag in Cross-cutting Advantage section)
- [x] Not auto-applied — written to data/taste-proposal.md, requires explicit POST /api/taste/accept

## Sampled output (with current 2-application history)
Three sections proposed:
1. **Target Roles table** — add "Generative AI Product Manager" row. Evidence: both applications.
2. **Adaptive Framing table** — add Generative AI PM framing row. Same evidence.
3. **Cross-cutting Advantage** — add "with special emphasis on generative AI and agent-based systems". Self-flagged as weak evidence.

All three tie back to the same 2 datapoints — Qwen correctly correlates them but acknowledges the small-N limitation.

## Concrete issues
1. **Sample size is genuinely small** — with 2 applications, any "pattern" Qwen finds is fragile. Proposal acknowledges this. Real value of this feature emerges at 10+ applications.
2. **Proposals correlate** — all three sections trace to the same evidence pair. A single rejection or pivot could invalidate all three at once. By design, but worth re-running after any new application + update.
3. **No detection of high-fit-not-applied patterns yet** — the prompt feeds this list to Qwen but with only 11 high-fit unapplied (all Google), Qwen didn't extract a taste signal. With more diverse pipeline + more applications, the contrast would become useful.
4. **Apply path is APPEND, not merge** — accepted proposals go at the end of `_profile.md` in a clearly marked block. User must manually prune duplicates if they want true integration. Conservative on purpose: avoids destructive rewrites.

## Known-good behaviours
- Validator rejects proposals that lack Evidence lines or fail to cite an applied company name (forces specificity).
- Hard preferences in current `_profile.md` (xAI/Meta exclusions, seniority cap) are preserved — proposal only adds rows, never edits the comp/location/exclusion blocks.
- Backup of `_profile.md` is written to `data/_profile.<ts>.bak` before any append; the applied proposal is archived to `data/taste-proposal.<ts>.applied.md`.

## What would push this to 5/5
- Run only after applications cross a threshold (e.g. 8+) so output isn't dominated by 1-2 datapoints.
- Diff-style merge that locates the existing target-roles table and inserts a new row inline (true patch), with a UI that shows the side-by-side diff before commit.
- Cross-reference rejected applications to detect anti-patterns: "rejected by Cohere and HuggingFace, both EU AI startups → propose adding 'EU-only AI startup' to softer no-go list".
