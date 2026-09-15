# State of the art — "smart and cheap" LLMs for long-horizon autonomous agents

**Research date: 11 September 2026**
**Context:** self-evolving agentic harness (emergent agent organization, continuously running, directed by a human chat). Main criterion: **intelligence/price ratio**, because token cost is the primary budget (several agents running continuously). A local Qwen model on an RTX 3090 is available but not a constraint.

> ⚠️ **Method and limits.** All the data below comes from web research on 11/09/2026 (Artificial Analysis, pricing aggregators, dated technical articles). Prices and benchmarks change **every week** in this segment: re-check the official pages before committing any budget. "Vendor" scores are reported by the lab itself, with no independent replication — they are marked **[vendor]**. Scores marked **[AA]** come from Artificial Analysis (independent). Inconsistencies between sources are flagged explicitly. Models released less than ~2 weeks ago (DeepSeek V4.1 Flash: **yesterday**) have **no independent evaluation**.

---

## 1. Summary comparison table

Prices in USD per million tokens. "Cache" = cached input on a cache hit. Ctx = max context window.

| Model | Release | Input | Cache | Output | Ctx | License | SWE-bench Verified | Notable agentic | AA Intelligence Index |
|---|---|---|---|---|---|---|---|---|---|
| **DeepSeek V4.1 Flash** (`deepseek-flash`) | 10/09/2026 | $0.15 (off-peak) / $0.30 (peak) | $0.003 / $0.006 | $0.60 / $1.20 | 1M | MIT | n/a (no independent figure) | DeepSWE v1.1 74.2 · Terminal-Bench 2.1 90.6 **[vendor, 0 replication]** | n/a |
| **DeepSeek V4 Pro** | 24/04/2026 (GA 07/2026) | $0.66 / $1.32 (peak) | $0.022 / $0.044 | $1.98 / $3.96 | 1M | MIT | 80.6% (Pro-Max config, preview era, **[vendor/aggregated]**) | DeepSWE 62.7 · TB 2.1 87.9 **[vendor]** | 36–44 (v4.3/v4.1, max configs) **[AA]** |
| **DeepSeek V4 Flash** (0731) — *retired on 10/09* | 04/2026 | $0.22 / $0.44 | $0.007 / $0.014 | $0.66 / $1.32 | 1M | MIT | 79.0% (Flash-Max, llm-stats board); 73.7% tech report **[vendor]** | TB 2.1 82.7 **[vendor, not replicated]** | 35 (v4.3) **[AA]** |
| **DeepSeek V3.2** (older, via OpenRouter) | 2025 | $0.27–0.28 | $0.028 | $0.40–0.42 | 128–164K | MIT | ~65–70%; 73.1% SWE-Verified **[vendor apidog]** | Terminal-Bench 2.0 80.3% **[vendor]** | n/a |
| **GLM-5.3** (Z.ai) | 14/08/2026 | $1.40 | $0.26 | $4.40 | 1M | GLM-5.3 License ($10B revenue clause) | n/a (not published) | Terminal-Bench 3.0 28.3 · DeepSWE 66.9 · CyberGym 84.5% **[vendor]** | **45 — no. 1 among the 112 open weights (v4.3)** **[AA]**; Agentic Index 59.1 **[AA, 27/08 snapshot]** |
| **GLM-5.3-Flash** (Z.ai) | 26/08/2026 | **$0.075** | **$0.011** | **$0.250** | 1M | (to be verified) | n/a | Agentic Index 58.2 **[AA]** | 41.9 (98th percentile) **[AA/aggregated]** |
| **GLM-5.2** | 13/06/2026 | $1.40 | $0.26 | $4.40 | 1M | MIT | ~80.9% (est.) | TB 2.1 81.0 | 39 (v4.3) **[AA]** |
| **GLM-4.6 / 4.7** | late 2025 | $0.50 | n/a | $2.00 | 200K | MIT | 73.8% (4.7) | τ²-Bench 87.4% (4.7) | n/a |
| **Kimi K3** (Moonshot) | 16/07/2026 | $3.00 ($2.40 at some providers) | $0.30 | $15.00 | 1M | Kimi K3 License (weights published 27/07) | n/a independent | FrontierSWE 81.2 · TB 2.0 88.3 **[vendor]**; 12 h+ sessions documented | 44 (v4.3) / 57.1 (v4.1) **[AA]** — *different scales, see §7* |
| **Kimi K2.7 Code** | 12/06/2026 | $0.95 | $0.19 | $4.00 | 256K | Modified MIT | **no independent score** | MCP Mark Verified 81.1 · MCP Atlas 76.0 **[vendor]**; ~30% fewer reasoning tokens than K2.6 | n/a |
| **Kimi K2.6** | 20/04/2026 | $0.95 | ~$0.16 | $4.00 | 256K | Modified MIT | 80.2% (onyx table, source to verify) | SWE-bench Pro 58.6 · TB 2.0 66.7 · Agent Swarm 300 sub-agents **[vendor]** | 43 (v4.1) / 54 (reasoning) **[AA]** |
| **MiniMax M3** | 01/06/2026 | $0.60 (promo $0.30; min provider $0.24) | $0.048 (best provider) | $2.40 (promo $1.20; min $0.96) | 1M (>512K billed ×2) | MiniMax Community License (commercial = separate agreement) | 80.5% **[vendor, not confirmed by Scale AI]** | TB 2.1 66.0% · τ²-Bench 88.9% · OSWorld 70.1% · MCP Atlas 74.2% **[vendor]** | ~30 (v4.3) **[AA]** |
| **Qwen3.8-Max-0902** (Alibaba, proprietary) | 03/08, updated 01/09/2026 | $2.00 | $0.25 | $6.00 | 1M | API only | n/a | TerminalBench 3.0 29.0 · JobBench 64.0 **[vendor, doubled on 01/09]** | Agentic Index 58.4 **[AA]** |
| **Qwen3.8-2.4T-A95B** (open weights) | 12/08/2026 | ~$2.00 (providers) | n/a | ~$6.00 | 262K (open) / 1M (hosted) | Open (first downloadable Max-class) | n/a | Agentic Index 57.1 **[AA]** | 57.7 **[AA, 27/08 snapshot]** |
| **Qwen3.6-27B** (dense, local 24 GB) | 22/04/2026 | 0 (self-host) | — | 0 | 262K | Apache 2.0 | 77.2% | AA Agentic 27.5 — clearly below the big MoEs | 37.7 **[AA]** |
| **Qwen3 235B A22B** (via OpenRouter) | 2025 | $0.09 | n/a | $0.10–0.55 | 262K | Apache 2.0 | n/a recent | good agentic per community votes (not benchmarked) | n/a |
| **Mistral Medium 3.5** | 05/2026 | $1.50 | n/a | $7.50 | 256K | Modified MIT (open weights) | 77.6% **[vendor]** | Tau2 94.2 · Devstral 2 for agentic coding | 29.9 **[AA]** |
| **Llama 4 Scout / Maverick** (Meta) | 2025 | variable | — | variable | 10M (Scout) / 1M | Llama Community | weak | TerminalBench 6.8 (Maverick) — **not recommended for agentic use** | 14.3 (Maverick) **[AA]** |

**Frontier reference points (for calibration):** Claude Fable 5: 95% SWE-bench, $10/$50. Claude Opus 4.8: 88.6%, $5/$25. GPT-5.5: 88.7%, $5/$30. METR TH1.1: 50% horizon ≈ 12–14.5 h (Opus 4.6, 02/2026). The models above cost **5× to 60× less** than the frontier for 80–90% of the agentic capability.

---

## 2. DeepSeek

### V4.1 Flash — released 10 September 2026 (the day before this research)
- 552B MoE (8B active in prefill / 16B in decode), new encoder-decoder architecture, 1M ctx, 384K max output, **native image input**, MIT, FP8 checkpoint ~510 GB on Hugging Face.
- API: `deepseek-flash`. **$0.15 / $0.60** off-peak; **$0.30 / $1.20** peak (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri; weekends always off-peak). Cache hit: **$0.003 / $0.006**.
- **From 14/09/2026 12:00 (Beijing), all `deepseek-v4-pro` requests are routed to V4.1 Flash at the Flash rate.** No V4.1 Pro announced.
- Benchmarks **[vendor only, zero independent replication to date]**: beats V4 Pro on agentic work (DeepSWE v1.1 74.2 vs 62.7; Terminal-Bench 2.1 90.6 vs 87.9), loses on pure knowledge (HLE 36.8 vs 42.7; GPQA 90.9 vs 92.4).
- Source: [yottalabs.ai, 10/09/2026](https://www.yottalabs.ai/post/deepseek-v4-1-flash-pricing-specs-v4-pro-routing-2026).

### V4 Pro / V4 Flash (April–July 2026)
- V4-Pro: 1.6T / 49B active; V4-Flash: 284B / 13B. 1M ctx, 384K max output, MIT. OpenAI **and** Anthropic compatible API (drop-in Claude Code / OpenCode).
- Official pricing since 16/08/2026 (peak ×2, off-peak = weekends + nights):
  - Pro: $0.66 in / $0.022 cache / $1.98 out
  - Flash: $0.22 in / $0.007 cache / $0.66 out
- OpenRouter (01/09/2026): Pro from $0.87/$1.74, Flash from $0.068/$0.168.
- **Cache economics are decisive**: in an agentic loop, ~99% of input tokens should be cache hits. Worked example (OpenCode trace: 750 fresh input, 290 output, 82,000 cached): **$0.000875/request vs ~$0.052 for Opus** → the real "60× cheaper".
- ⚠️ **Verbosity**: V4-Flash-0731 emits 240M output tokens on the Intelligence Index vs a 120M median **[AA]** → cheap tokens ≠ cheap tasks. Cap `reasoning_effort`.
- Known bugs (Flash): DSML parser that breaks on arguments named `arguments`/`input`, fragile FP8+parallelism on vLLM/SGLang.
- Sources: [morphllm.com/deepseek-v4, verified 07/09/2026](https://www.morphllm.com/deepseek-v4); [morphllm.com/deepseek-v4-flash, 21/08/2026](https://www.morphllm.com/deepseek-v4-flash); [cloudzero.com, updated 04/09/2026](https://www.cloudzero.com/blog/deepseek-pricing/).

### V3.2 (older generation, still served)
- ~$0.27/$0.40 via OpenRouter, cache hit $0.028, 128K ctx. ~65–70% SWE-bench (73.1% SWE-Verified **[vendor]**), Aider Polyglot 71.6%. Still a reliable, battle-tested value model in agent stacks.
- Sources: [standardcompute.com, 02/08/2026](https://standardcompute.com/best-ai-model/deepseek-v3-2); [apidog.com, 17/06/2026](https://apidog.com/blog/deepseek-v3-2-and-deepseek-v3-2-speciale/).

---

## 3. GLM (Zhipu / Z.ai)

### GLM-5.3 — 14 August 2026 (independent open-weights no. 1)
- Same 753B MoE base as GLM-5.2; **all the gains come from post-training**: Terminal-Bench 3.0 4.6 → 28.3; DeepSWE v1.1 46.2 → 66.9; CyberGym 77.2 → 84.5% **[vendor]**.
- **[AA] Intelligence Index v4.3 = 45, no. 1 among the 112 open-weights models**, ahead of Kimi K3 (44), at ~1/5 the price. Agentic Index 59.1 (AA snapshot of 27/08, nearly tied with Opus 5 max at 59.2).
- Price unchanged vs 5.2: **$1.40 / $4.40**, cache $0.26, 1M ctx, 128K max output. Reasoning always-on (effort low/high/max, default max).
- Weights public since 25/08/2026 under the **custom GLM-5.3 License** (security review clause above $10B in revenue — not MIT).
- ⚠️ Verbose: 210M tokens on the index vs a 120M median **[AA]**. No vision. No published SWE-bench Verified score.
- **GLM Coding Plan from $18/month** (subscription, includes Claude Code / Cline / OpenCode) — potentially very cost-effective for a harness running continuously.
- Sources: [morphllm.com/glm-5-3, 28/08/2026](https://www.morphllm.com/glm-5-3); [morphllm.com/glm-5-3-vs-claude, 21/08/2026](https://www.morphllm.com/glm-5-3-vs-claude).

### GLM-5.3-Flash — 26 August 2026 (the cheapest of the "smart" models)
- **$0.075 input / $0.250 output / $0.011 cache**, 1M ctx, 58 tok/s, vision, 20 providers.
- **[AA] Agentic Index 58.2** — on par with Qwen3.8 Max (58.4) and GPT-5.6 Sol (57.8) — and Intelligence 41.9 (98th percentile) for an order of magnitude less in price.
- Source: [pricepertoken.com, 10/09/2026](https://pricepertoken.com/pricing-page/model/z-ai-glm-5.3-flash); [everylocalai.com (AA data, 27/08/2026)](https://everylocalai.com/model/qwen3-6-27b).

### Older generations
- GLM-5.2 (13/06/2026, MIT): same price as 5.3, MIT weights → preferable if the license matters. GLM-4.7 (12/2025): 73.8% SWE-bench Verified, τ²-Bench 87.4%, $0.50/$2.00, 200K ctx.
- Sources: [layer3labs.io, 28/07/2026](https://www.layer3labs.io/comparisons/glm-5-2-vs-glm-4-6); [hussain-nazary.github.io, 11/02/2026](https://hussain-nazary.github.io/latest-ai-model-updates-gpt6-claude45-llama5-grok5-gemini3-chatgpt5-agent.html).

---

## 4. Qwen (Alibaba)

- **Qwen3.8-Max** (03/08/2026, proprietary): 2.4T MoE ~95B active, 1M ctx, multimodal, **$2.00 / $6.00**, cache $0.25. Updated in place on **01/09/2026** (`Qwen3.8-Max-0902`): TerminalBench 3.0 11.3 → 29.0, ProgramBench 10.5 → 28.0, JobBench 53.4 → 64.0 **[vendor]**.
- **Qwen3.8-2.4T-A95B** (12/08/2026): the **first downloadable Max-class checkpoint** in Qwen's history — but text only, 262K ctx. [AA] Intelligence 57.7 / Agentic 57.1 (27/08 snapshot).
- **Qwen3.6-27B** (22/04/2026, dense, Apache 2.0): 77.2% SWE-bench Verified, **fits on a 24 GB GPU (Q5_K_M ≈ 20 GB)** → the natural candidate for the RTX 3090. [AA] Intelligence 37.7 / Agentic 27.5: good at short-horizon coding, weak at long-horizon agentic work.
- **Qwen3.6-35B-A3B** (15/04/2026, Apache 2.0): 73.4% SWE-bench, lightweight self-hostable MoE.
- **Qwen3 235B A22B** via OpenRouter: ~$0.09/$0.10 — ultra-cheap, but a 2025 generation.
- Sources: [cellcog.ai, 16/08 + updated 02/09/2026](https://cellcog.ai/blog/glm-5-3-vs-qwen3-8-max/); [sesamedisk.com, 16/08/2026](https://sesamedisk.com/top-ai-model-agentic-index/); [aitoolsrecap.com, 05/05/2026](https://aitoolsrecap.com/Blog/meet-qwen36-alibaba-cloud-2026); [everylocalai.com, 27/08/2026](https://everylocalai.com/model/qwen3-6-27b).

---

## 5. Kimi (Moonshot AI)

### K3 — 16 July 2026 (flagship, NOT a budget model)
- 2.8T MoE (16 active experts / 896), 1M ctx, native vision, weights published on 27/07 (1.56 TB, Kimi K3 License).
- **$3.00 / $15.00** (cache $0.30) — Claude Sonnet pricing, 3–4× the price of K2.6. [AA]: 44 (v4.3); 81.2 FrontierSWE / 88.3 Terminal-Bench 2.0 **[vendor]**. Best open model at agentic coding according to several trackers, but **out of budget for a continuously running fleet** — reserve it for the "lead/orchestrator" role if needed.
- ⚠️ Constraint: K3 depends on preserved thinking history — **do not switch models mid-session**.
- Sources: [techjacksolutions.com, 18/08/2026](https://techjacksolutions.com/ai-tools/kimi/kimi-k3-pricing/); [morphllm.com/kimi-k3-api, 21/08/2026](https://www.morphllm.com/kimi-k3-api); [pricepertoken.com, 10/09/2026](https://pricepertoken.com/pricing-page/model/moonshotai-kimi-k3).

### K2.7 Code — 12 June 2026 (long-horizon specialist, good price)
- 1T / 32B active, 256K ctx, Modified MIT. **$0.95 / $4.00**, cache $0.19.
- **~30% fewer reasoning tokens than K2.6** per agentic loop → directly lower cost per task. More reliable MCP tool calls (CI, tickets, multi-file edits in a single pass). Autonomous sessions documented at **12 h+ and 4,000+ tool calls** **[vendor]**.
- ⚠️ **No independent benchmark** (SWE-bench, Terminal-Bench) to date — all the figures are Moonshot proprietary suites.
- Sources: [buildfastwithai.com, 15/06/2026](https://www.buildfastwithai.com/blogs/kimi-k2-7-code-review-2026); [vm0.ai](https://www.vm0.ai/en/models/kimi-k2-7-code); [viblo.asia, 01/09/2026](https://viblo.asia/p/kimi-k27-code-benchmarks-architecture-pricing-access-2026-guide-kNLr3EOEVgA).

### K2.6 — 20 April 2026
- $0.95/$4.00, 256K. SWE-bench Pro 58.6 · TB 2.0 66.7 **[vendor]**; [AA] among the best open weights of its time (43–54 depending on config/index). Agent Swarm up to 300 sub-agents.

---

## 6. MiniMax M3 — 1 June 2026

- 1M ctx MoE, **native multimodal (image + video)**, computer-use. ⚠️ **Contradictory sources on size**: 428B/23B active [morphllm] vs 229.9B/9.8B [localaimaster] — unresolved.
- Pricing: official $0.60/$2.40 (launch promo $0.30/$1.20); best provider $0.24/$0.96, cache $0.048 (10/09/2026). **>512K input = billed ×2**.
- Benchmarks **[vendor, not confirmed by Scale AI for SWE-bench Pro]**: SWE-bench Verified 80.5% · SWE-bench Pro 59.0% · TB 2.1 66.0% · τ²-Bench 88.9% · OSWorld-Verified 70.1% · MCP Atlas 74.2% · BrowseComp 83.5.
- **[AA] Intelligence v4.3 ≈ 30** — mid-pack on pure text; its edge is multimodal + computer-use. Independent verdict: for text coding, GLM-5.2/5.3 is better, DeepSeek V4 Flash cheaper.
- **MiniMax Community License**: commercial use requires a separate agreement. Self-host ≈ 11× H100 in bf16 → unrealistic locally.
- Sources: [morphllm.com/minimax-m3, verified 07/09/2026](https://www.morphllm.com/minimax-m3); [pricepertoken.com, 10/09/2026](https://pricepertoken.com/pricing-page/model/minimax-minimax-m3); [localaimaster.com, 20/06/2026](https://localaimaster.com/models/minimax-m3).

---

## 7. Mistral, Llama — limited relevance for this use case

- **Mistral Medium 3.5** (05/2026): $1.50/$7.50, 77.6% SWE-bench Verified **[vendor]**, Tau2 94.2, open weights (modified MIT), ~4 GPUs self-hosted, EU data residency. Decent but neither the strongest nor the cheapest; **Devstral 2** is their agentic specialist. Main appeal: European compliance.
- **Llama 4** (Scout 10M ctx / Maverick): weak agentic performance ([AA] TerminalBench 6.8, Intelligence 14.3 for Maverick) — **not recommended** for tool-using agents. Llama 5 mentioned but unconfirmed as of this date.
- Sources: [pricepertoken.com, 21/07/2026](https://pricepertoken.com/compare/llama-vs-mistral); [qwe.edu.pl, 05/06/2026](https://www.qwe.edu.pl/tutorial/mistral-ai-now-summit-vibe-tutorial/); [theairankings.com, 09/09/2026](https://theairankings.com/mistral/).

---

## 8. Long-horizon: what independent measurement says (METR)

- METR Time Horizon 1.1 (29/01/2026): the frontier (Claude Opus 4.6) reaches a **50% horizon ≈ 12–14.5 h** of expert human work; 80% horizon ≈ 1 h 10. Doubling every **4–7 months**. Beyond ~16 h, the current task suite no longer measures reliably.
- Short benchmarks (SWE-bench 82%+, Terminal-Bench 82%) are **saturated at the frontier**; long benchmarks are not (SWE-EVO: 25% for the best model; SWE-Lancer: majority of tasks unresolved).
- **None of the budget models in this document has a per-model METR measurement published** — the "12 h sessions" claims (Kimi K2.7, GLM-5.1 "8 h per task") are vendor communications, not METR measurements. Treat them as unverified.
- Sources: [METR via ai2027-tracker.com, 06/06/2026](https://ai2027-tracker.com/predictions/long-horizon-struggle/); [apiardata.com, 01/04/2026](https://apiardata.com/statistics/ai-autonomous-task-horizon/); [arXiv 2605.02244, 04/05/2026](https://arxiv.org/html/2605.02244v1).

---

## 9. Recommendations for the harness (multi-agent org running continuously, tight budget)

### Suggested cost architecture (routing by role)

| Role in the org | Model | Why |
|---|---|---|
| **Worker agents (volume)** | **GLM-5.3-Flash** ($0.075/$0.25) or **DeepSeek V4.1 Flash** ($0.15/$0.60 off-peak) | Best measured intelligence/price ratio; 1M ctx; near-free cache |
| **Orchestrator / planning** | **GLM-5.3** ($1.40/$4.40) | independent open-weights no. 1 [AA 45]; Anthropic-format endpoint (drop-in) |
| **Long-horizon coding** | **Kimi K2.7 Code** ($0.95/$4.00) | −30% reasoning tokens, 12 h+ sessions [vendor], reliable MCP |
| **Multimodal / GUI tasks** | **MiniMax M3** ($0.24–0.60 / $0.96–2.40) | the only one in the set with native vision+video and OSWorld 70% |
| **Trivial / routing / summaries** | **Qwen3.6-27B local (RTX 3090)** | zero marginal cost, 77% SWE-bench, Apache 2.0 |

### Cost levers specific to "always on"
1. **Mandatory cache hits**: a harness that sends the same system prompt + history at every turn should target >90% cache hits (DeepSeek: $0.003–0.022/M; GLM: $0.011–0.26/M; Kimi: $0.19–0.30/M). This is lever no. 1 — a 30× gap between miss and hit at DeepSeek.
2. **Schedule large runs during DeepSeek off-peak** (UTC nights and weekends = half price).
3. **Cap reasoning effort**: V4-Flash and GLM-5.3 are ~2× more verbose than the median [AA] — cost per task can double despite cheap tokens.
4. **GLM Coding Plan subscription (from $18/month)** to be evaluated as an alternative to pay-per-token for high-volume coding agents.
5. **Do not switch models mid-session on Kimi K3** (preserved thinking history required).

### Unverified points / to re-check before adoption
- [ ] **DeepSeek V4.1 Flash: no independent evaluation** (released 10/09/2026). Test it on your own traces before making it the default.
- [ ] V4 Pro → V4.1 Flash routing effective on 14/09/2026 — confirm API behavior that day.
- [ ] Kimi K2.7 Code: no independent SWE-bench/Terminal-Bench score published.
- [ ] MiniMax M3: exact size (428B vs 229.9B) and scores unconfirmed by third parties (Scale AI has not validated SWE-bench Pro).
- [ ] GLM-5.3 license ($10B clause) and MiniMax Community License (separate commercial agreement) — have them validated if used commercially.
- [ ] Scale inconsistencies between Artificial Analysis snapshots (v4.1: scores ~44–60; v4.3: ~36–45 for the same families; everylocalai 27/08 snapshot: 57–60) — compare only within a single snapshot.
- [ ] "Min provider" prices (pricepertoken) ≠ first-party prices; verify SLAs and per-provider rate limits.

---

## Main sources

- Artificial Analysis — Intelligence Index v4.3 and v4.1 article: https://artificialanalysis.ai/ and https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-1 (15/06/2026); https://artificialanalysis.ai/articles/recent-open-weights-model-launches (30/04/2026, updated 04/09/2026)
- DeepSeek V4.1 Flash: https://www.yottalabs.ai/post/deepseek-v4-1-flash-pricing-specs-v4-pro-routing-2026 (10/09/2026)
- DeepSeek V4: https://www.morphllm.com/deepseek-v4 (verified 07/09/2026); https://www.cloudzero.com/blog/deepseek-pricing/ (updated 04/09/2026)
- GLM-5.3: https://www.morphllm.com/glm-5-3 (28/08/2026); https://www.morphllm.com/glm-5-3-vs-claude (21/08/2026)
- GLM-5.3-Flash: https://pricepertoken.com/pricing-page/model/z-ai-glm-5.3-flash (10/09/2026)
- Qwen3.8: https://cellcog.ai/blog/glm-5-3-vs-qwen3-8-max/ (16/08/2026, updated 02/09/2026); https://sesamedisk.com/top-ai-model-agentic-index/ (16/08/2026)
- Kimi K3: https://techjacksolutions.com/ai-tools/kimi/kimi-k3-pricing/ (18/08/2026); https://www.morphllm.com/kimi-k3-api (21/08/2026)
- Kimi K2.7: https://www.buildfastwithai.com/blogs/kimi-k2-7-code-review-2026 (15/06/2026); https://viblo.asia/p/kimi-k27-code-benchmarks-architecture-pricing-access-2026-guide-kNLr3EOEVgA (01/09/2026)
- MiniMax M3: https://www.morphllm.com/minimax-m3 (07/09/2026); https://pricepertoken.com/pricing-page/model/minimax-minimax-m3 (10/09/2026)
- METR: https://ai2027-tracker.com/predictions/long-horizon-struggle/ (06/06/2026); https://apiardata.com/statistics/ai-autonomous-task-horizon/ (01/04/2026)
- Coding panorama: https://onyx.app/insights/best-llms-for-coding-2026 (20/07/2026)
- China panorama: https://www.turingpost.com/p/llms-in-china (30/08/2026)
