# Task 3 critique — JD gap analysis

**Version:** v3 (extended SOFT_SKILLS + VAGUE_TAILS + TITLE_LIKE filters; 2-strategy browserless fetch)
**Grade:** 4.3 / 5
**Iterations:** 3

## Acceptance checklist
- [x] Matches/gaps are concrete (technologies, frameworks, products, domains)
- [x] No soft skills (filters reject "leadership", "execution", "mindset", "thinker", title-like words)
- [x] >=80% of rows have non-empty `must_explain` (sample: 9/9 = 100% of successful fetches)
- [x] No hallucinated CV skills observed in 9-row sample (Snowflake/NVIDIA/Databricks JDs all reference items present in cv.md)

## Sampled output (10 URLs)
- Fetch success: 9/10 (only OpenAI's careers page rejects browserless)
- Qwen success: 9/9 of fetched
- Average matches: 7-8 items per row, all concrete (RAG pipelines, Kubernetes, GCP, LLMs, multi-service pipelines)
- Average gaps: 4-5 items per row, all concrete (Nemo, NIM, LangChain, Snowflake, Databricks platform)
- `must_explain` framing: every entry uses the "no formal X, but did Y at company/scale" pattern

## Concrete issues
1. **OpenAI careers page does not yield text via Browserless** — it loads as a thin shell that requires real-user interaction. Could be patched with FlareSolverr or hardcoded ATS-API extraction, but added complexity not justified for a single source.
2. **Snowflake JDs produce repeated content** — 7 different Snowflake roles all return very similar matches/gaps. This is because the JDs are similar. Acceptable but a deduper at this layer would be a nice future addition.
3. **`must_explain` claims rest on CV evidence the user has to verify** — Qwen sometimes asserts "led AI product development at Meta" when CV says "AI platform work at Reality Labs". Drift is mild but present.
4. **Browserless render is slow** (~3s/URL) — full 100+ URL run takes 6-8 min. Idempotent cache mitigates.

## Known-good behaviours
- Two-strategy fetch (`networkidle2` then `networkidle0`) recovered the NVIDIA Workday URL that v1 failed on.
- TITLE_LIKE filter correctly removed "Senior Product Manager" from gaps lists in v2 output.
- VAGUE_TAILS filter eliminated "data-driven mindset", "ai-native thinker", "executive storytelling".
- Cache-by-URL means re-runs only fetch new URLs.

## What would push this to 5/5
- Per-source extractors (Greenhouse JSON, Workday JSON, Lever JSON) instead of universal HTML scrape — would fix OpenAI + faster on others.
- A second Qwen "auditor" pass that checks each must_explain claim against the CV with grep-like literalness, dropping any analogue not directly traceable.
- Embedding-based dedup so seven Snowflake variants collapse into one canonical analysis with per-job deltas.
