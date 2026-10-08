# Verification of primary sources — September 11, 2026

A web-verification pass (arXiv full text, official pricing pages, Artificial Analysis index via technical press) on the project's load-bearing references. Verdicts: CONFIRMED / APPROXIMATE / FALSE / NOT VERIFIABLE.

## Overall verdict

**The 9 verified references do exist, with the correct arXiv identifiers.** The corpus is reliable as a whole. Three corrections were to be made, only one of which touches a figure used in the reasoning (Kim et al.). *(Historical verdict of the September 11 pass: every "CONFIRMED"/"APPROXIMATE" verdict below is a reading made then — full text or abstract, as marked — and is reported here, not re-certified. The current reconciliation status is in "Corrections — status of the original list" at the end, and no figure here has been re-checked since.)*

## Scientific references

| Reference | Existence | Cited figures |
|---|---|---|
| Dochkina, *Drop the Hierarchy and Roles*, arXiv:2603.28990 | ✅ (single author: Victoria Dochkina, MIPT; submitted to IEEE Access) | ✅ All confirmed in the full text: 25,000 tasks, +14% vs centralized, +44% (d=1.86) vs autonomous, 5,006 roles, capacity threshold (+3.5% Sonnet 4.6 / −9.6% GLM-5), plateau beyond 64 agents (p=0.61, cost ×4.6) |
| Kim et al., *Towards a Science of Scaling Agent Systems*, arXiv:2512.08296 | ✅ (real affiliation: Google Research + Google DeepMind + MIT, 20 authors; v3 of 2026-04-08) | ⚠️ ×17.2 CI [14.3; 20.1] ✅ · ×4.4 centralized ✅ · threshold ~45% ✅ · success 0.370 vs 0.466 ✅ · **"180 configurations": FALSE → 260** · **β=-0.408 (p<0.001): FALSE → β=-0.236 (p=0.004)** — at least in v3, possibly figures from a v1/v2 |
| Arike et al., *Evaluating Goal Drift in Language Model Agents*, arXiv:2505.02709 | ✅ (AIES 2025 confirmed, doi:10.1609/aies.v8i1.36541; MATS/Apollo Research) | ✅ All confirmed in the full text: universal drift, best ~100k tokens (scaffolded Claude 3.5 Sonnet), drift by inaction dominant, GD_actions/GD_inaction metrics (section 3.3) |
| *Inherited Goal Drift*, arXiv:2603.03258 | ✅ (Menon, Saebo, Crosse, Gibson, Jang, Cruz) | ✅ Reported by this pass (abstract only read — a reading, not certified data; not re-checked since) — nuance: "consistent resilience **among tested models**" for GPT-5.1, not absolute resistance |
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

- **Kim et al.**: the disputed correction (260 configs, β=-0.236 p=0.004 in v3, against the 180/β=-0.408 originally quoted — see the status below; neither is relied on) does not change the qualitative conclusion — the ×17.2 and the saturation threshold at ~45%, which are the two figures actually used in devils-advocate.md, were read as exact by that historical pass (reported, not re-certified).
- **Governance Decay**: the "compaction" nuance actually strengthens the design — an immutable journal + pinned constraints (Constraint Pinning) is exactly the documented countermeasure. Cite it this way *(reported, single-source preprint; see `value-measurement-long-horizon.md` §2.4 status)*.
- **GLM-5.3-Flash**: the "volume workers" routing remains valid at list price ($0.15/$0.50), but its cache figure is **disputed** (0.011 vs 0.015 promo; 0.03 list — all reported, none re-checked), so no cache-economy figure is chosen *(list prices reported, not re-fetched)*.
- **GLM-5.3**: "no. 1 independent open weights" becomes "tied with Kimi K3 at 60" — does not change the orchestrator choice but corrects the claim *(the two index readings belong to different AA versions/scales and are now marked disputed in models-overview.md)*.

## Corrections — status of the original list

The list below is this note's original "files to correct", kept for the record and now annotated with its reconciliation status (Task 9b, 2026-10-08). The chronicle above is not deleted or rewritten; this section is a status layer on top of it. Two pointers in the original list were themselves stale and are corrected here.

| Original correction | Status |
|---|---|
| `docs/research/devils-advocate.md` §2.3: 180→260 configurations; β=-0.408 (p<0.001)→β=-0.236 (p=0.004); affiliation → Google Research/DeepMind/MIT | **Applied differently.** The disputed count and coefficient are removed from the argument rather than swapped for the alternative figure, since neither preprint version was re-checked here. The reconciled text keeps only what this pass confirmed as exact — ×17.2 [14.3; 20.1], ×4.4, saturation ~45%, success 0.370 vs 0.466 — and states the count/coefficient as *pending primary verification*. The affiliation is corrected in the text. |
| `docs/research/devils-advocate.md` §2.6 and `../vision.md` line 124: Governance Decay → mechanism = context compaction | **Applied, pointer corrected.** `devils-advocate.md` §2.6 is *Goal drift*, not Governance Decay; the Governance Decay section is `value-measurement-long-horizon.md` §2.4. `vision.md` has 108 lines, so "line 124" pointed at nothing; pointers are now by section/heading, not by line. The compaction mechanism is stated in the reconciled corpus (`direction.md`, `seed.md`, `value-measurement-long-horizon.md` §2.4). |
| `docs/research/models-overview.md`: GLM-5.3-Flash expired promo rates → list; cache 0.011→0.03 $; GLM-5.3 score 45→60, tied with K3; redo the cache savings calculation | **Partially applied, and the cache correction deliberately *not* applied.** Pricing cells are labelled as the dated promo (*reported*, expired 2026-09-09) with the list price noted beside them. The **cache figure is left explicitly disputed** (11/09 read 0.011; verification read 0.015 promo / 0.03 list — both reported, neither chosen) and is stated to be **not a current routing input**; no cache-economy number is derived. The GLM-5.3 index reading carries both readings with their scales, versions and dates and drops the absolute "no. 1"; the routing table no longer rests on a disputed crown or on expired promo prices. No new quantitative claim is derived from the corrected numbers — the list prices were not re-fetched here and stay *reported*. |

**Not corrected here, carried open.** This reconciliation edits documents, not external facts: no preprint, pricing page or benchmark archive was re-fetched in it. The Kim et al. count/coefficient reconciliation stays pending a preprint-version check; the Governance Decay figures remain the paper's own reported results (see `value-measurement-long-horizon.md` §2.4); the model prices remain reported as of the dated snapshot. The Dochkina capacity-threshold pair (+3.5% / −9.6%) is carried as *reported* in the reconciled corpus even though this note lists it among the full-text confirmations: the source version is not re-checked here, the primary text is not re-read, and the figures are not used as ground truth — only the qualitative capability-threshold finding is. Nothing below is re-certified as current.

*Method (as performed on September 11): reading arXiv HTML full text when available (Dochkina, Kim, Arike), abstracts otherwise (Inherited Goal Drift, Governance Decay) — flagged on a case-by-case basis. Working files: `/Users/noe/projects/cell/tmp_verif/` — a host path from the verification's own machine, not an artifact of this repository and no longer available; it is recorded as provenance for this note, not offered as reproducible evidence. Reconciliation (2026-10-08): no source was re-fetched; every figure above remains reported or pending primary verification.*
