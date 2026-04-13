# Task 1 critique — role clustering

**Version:** v3 (hierarchical subSplit + Qwen re-naming pass)
**Grade:** 4.2 / 5
**Iterations:** 3

## Acceptance checklist
- [x] Each cluster name is specific (company + product/domain, not "AI Product")
- [x] No cluster has <3 or >25 items (range: 5–23)
- [x] No URL in two clusters (validated + deduped)
- [x] 6–10 clusters total (9 produced)

## Sampled output (10 clusters → 9 after merge)
- `Google AI + Cloud Infrastructure PM (23)` — Workspace AI, Agentic Search, Cloud Run, Service Networking
- `Google Generative AI + Cloud PM (16)` — Gemini/GenAI product lines
- `Google YouTube + AI product growth (15)` — YouTube partnerships + creator roles
- `Amazon AWS AI/ML Product Management (13)` — AWS Kernels, Annapurna Labs
- `AI partnerships and solutions architects (13)` — mixed-company tail (Databricks, NVIDIA, Palantir…)
- `Amazon Alexa AI + Creator products PM (12)` — Alexa Responsible AI, Kids+
- `Mistral AI Studio & Forge product management (8)` — slightly-off (BD + Marketing in there)
- `Snowflake AI applied ML PM (7)` — tightly matches contents
- `Anthropic Claude product management (5)` — tightly matches

## Concrete issues
1. **Two Google clusters overlap in naming.** "Google AI + Cloud Infrastructure" vs "Google Generative AI + Cloud" — a user skimming would guess wrong. Distinction is actually internal (Infra PM work vs. customer-facing GenAI product work) and the name doesn't convey it.
2. **Mistral cluster name is narrower than contents.** Cluster includes BD Manager + Product Marketing + DevRel roles, but name implies product management only.
3. **Tail cluster name is generic.** "AI partnerships and solutions architects" is okay but doesn't flag that this is mixed-company (Databricks + NVIDIA + Palantir). Would benefit from "Mid-tier AI platform PM/SA" framing.

## Known-good behaviours
- Auto-heal logic correctly reclaims indices Qwen drops (13 and 9 missing on Google/Amazon in v3 run).
- Merge logic prefers same-company merges to avoid ugly "Anthropic Claude + Snowflake" style cross-merges seen in v2.
- Re-naming pass after auto-heal produces more faithful cluster titles.

## Prompt engineering notes
- Qwen consistently produces 14–18 clusters when asked for 6–10 across 100+ items — hierarchical split works around the limitation.
- Qwen drops 10–25% of indices on large (50+) lists. Validator must auto-heal, not reject.
- Naming by handing Qwen the items inside the cluster produces better names than asking Qwen to name during the split.

## What would push this to 5/5
- Two-pass naming where a critic Qwen call compares cluster names for distinctiveness and regenerates the worst pair.
- Semantic embedding backend (not available locally) for true similarity clustering instead of company-first groups.
