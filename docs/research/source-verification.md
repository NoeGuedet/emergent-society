# Verification of primary sources — September 11, 2026

A web-verification pass (arXiv full text, official pricing pages, Artificial Analysis index via technical press) on the project's load-bearing references. Verdicts: CONFIRMED / APPROXIMATE / FALSE / NOT VERIFIABLE.

## Overall verdict

**The 9 verified references do exist, with the correct arXiv identifiers.** The corpus is reliable as a whole. Three corrections to make, only one of which touches a figure used in the reasoning (Kim et al.).

## Scientific references

| Reference | Existence | Cited figures |
|---|---|---|
| Dochkina, *Drop the Hierarchy and Roles*, arXiv:2603.28990 | ✅ (single author: Victoria Dochkina, MIPT; submitted to IEEE Access) | ✅ All confirmed in the full text: 25,000 tasks, +14% vs centralized, +44% (d=1.86) vs autonomous, 5,006 roles, capacity threshold (+3.5% Sonnet 4.6 / −9.6% GLM-5), plateau beyond 64 agents (p=0.61, cost ×4.6) |
| Kim et al., *Towards a Science of Scaling Agent Systems*, arXiv:2512.08296 | ✅ (real affiliation: Google Research + Google DeepMind + MIT, 20 authors; v3 of 2026-04-08) | ⚠️ ×17.2 CI [14.3; 20.1] ✅ · ×4.4 centralized ✅ · threshold ~45% ✅ · success 0.370 vs 0.466 ✅ · **"180 configurations": FALSE → 260** · **β=-0.408 (p<0.001): FALSE → β=-0.236 (p=0.004)** — at least in v3, possibly figures from a v1/v2 |
| Arike et al., *Evaluating Goal Drift in Language Model Agents*, arXiv:2505.02709 | ✅ (AIES 2025 confirmed, doi:10.1609/aies.v8i1.36541; MATS/Apollo Research) | ✅ All confirmed in the full text: universal drift, best ~100k tokens (scaffolded Claude 3.5 Sonnet), drift by inaction dominant, GD_actions/GD_inaction metrics (section 3.3) |
| *Inherited Goal Drift*, arXiv:2603.03258 | ✅ (Menon, Saebo, Crosse, Gibson, Jang, Cruz) | ✅ Confirmed (abstract only read) — nuance: "consistent resilience **among tested models**" for GPT-5.1, not absolute resistance |
| *Governance Decay / ConstraintRot*, arXiv:2606.22528 | ✅ (Shiyang Chen) | ⚠️ Approximate: the mechanism is not time but **context compaction** — violation 0% visible policy → 30% after compaction (up to 59%), 1,323 episodes, 7 families; "Constraint Pinning" mitigation → 0% |
| MAST, arXiv:2503.13657 | ✅ | ✅ Failures 41.0% (AG2) to 86.7% (AppWorld), Fig. 5 |
| Vending-Bench, arXiv:2502.15840 | ✅ (Andon Labs) | ✅ Meltdown loops documented |
| Project Sid, arXiv:2411.00114 | ✅ (Altera.AL, PIANO) | ✅ 10–1000+ agents, roles, collective rules, cultural transmission |
| Darwin Gödel Machine, arXiv:2505.22954 | ✅ (ICLR 2026) | ✅ SWE-bench 20% → 50% |
| Dohare et al. 2024, Nature | ✅ (Nature 632:768–774, DOI 10.1038/s41586-024-07711-7, with Sutton) | ✅ |
| arXiv:2608.25512, *A Programming Paradigm for Spatiotemporal Composability* | ✅ (Shi, Zhang, Cui; 2026-08-26; Cordis implementation) | ⚠️ PKU/DeepSeek affiliations probable but not shown on the arXiv page (a single secondary source) |

## Model prices (up to date as of 2026-09-11)

| Claim | Verdict |
|---|---|
| DeepSeek V4.1 Flash: $0.15/$0.60 off-peak, cache $0.003, 1M ctx, MIT, v4-pro→Flash routing on 09/14, vendor benchmarks not replicated | ✅ All confirmed on api-docs.deepseek.com + press |
| GLM-5.3-Flash: $0.075/$0.25, cache $0.011 | ⚠️ **−50% promo price expired on 2026-09-09.** List price: $0.15 input / $0.50 output / cache $0.03 (promo: $0.015, not $0.011). Context 1M ✅. Agentic Index 58.2 not reconfirmed at the source (closest: 57 as of 08/30) |
| GLM-5.3: no. 1 of the 112 open weights, Intelligence Index 45 (v4.3) | ❌ **FALSE.** Actual score: **60**, **tied no. 1 open weights with Kimi K3** (Claude Opus 5 leads at 63); index v4.1.1, 181 models evaluated. Price $1.40/$4.40 ✅ |

## Impact on the project's reasoning

- **Kim et al.**: the correction (260 configs, β=-0.236 p=0.004) does not change the qualitative conclusion — the ×17.2 and the saturation threshold at ~45%, which are the two figures actually used in devils-advocate.md, are exact.
- **Governance Decay**: the "compaction" nuance actually strengthens the design — an immutable journal + pinned constraints (Constraint Pinning) is exactly the documented countermeasure. Cite it this way.
- **GLM-5.3-Flash**: the "volume workers" routing remains valid at list price ($0.15/$0.50), but the cache savings calculation in models-overview.md must be redone with cache at $0.03.
- **GLM-5.3**: "no. 1 independent open weights" becomes "tied with Kimi K3 at 60" — does not change the orchestrator choice but corrects the claim.

## Files to correct

- `docs/research/devils-advocate.md` §2.3: 180→260 configurations; β=-0.408 (p<0.001)→β=-0.236 (p=0.004); affiliation → Google Research/DeepMind/MIT
- `docs/research/devils-advocate.md` §2.6 and `../vision.md` line 124: Governance Decay → specify mechanism = context compaction
- `docs/research/models-overview.md`: GLM-5.3-Flash expired promo rates → list; cache 0.011→0.03 $; GLM-5.3 score 45→60, tied with K3; redo the cache savings calculation

*Method: reading arXiv HTML full text when available (Dochkina, Kim, Arike), abstracts otherwise (Inherited Goal Drift, Governance Decay) — flagged on a case-by-case basis. Working files: /Users/noe/projects/cell/tmp_verif/ (to be deleted after correction).*
