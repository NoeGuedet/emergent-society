# Reading notes — reference literature

*One entry = one paper/project. 5 lines: what it says, what we take from it, what we drop. Maintained as research progresses.*

## Theoretical foundations

### A Programming Paradigm for Spatiotemporal Composability (arXiv:2608.25512, PKU/DeepSeek, August 2026)
- **What it says:** dynamic composition (loading/unloading modules without restarting) requires two properties: reversible effects (temporal) and declared reactive dependencies (spatial). Implemented in Cordis (TypeScript), validated by the Koishi ecosystem (4000+ plugins).
- **We take:** reversibility as the physics of the kernel; the loader with reversible effects; the warning that "a faulty self-modification can disable the recovery mechanism".
- **We drop:** the formal apparatus (92 pages of type theory) — not needed to build; and their observation that dependency versioning remains an open problem.
- **Caveat:** no experiment with a real LLM agent — the agent connection is a motivation, not a result.

### DeepSeek Harness (github.com/deepseek-ai/deepseek-harness, August 2026)
- **What it is:** DeepSeek's first agent product, "everything is a plugin" on Cordis, the agent can write and mount its own plugins on the fly.
- **We take:** the proof that the all-plugin architecture holds; the 4 run modes; the append-only event journal with replay.
- **We drop:** generated plugins live in memory only (they disappear on restart) — our design must persist.
- **Caveat:** Cordis remains a non-optional kernel; "everything is a plugin" is slightly aspirational.

## Agent companies

### Drop the Hierarchy and Roles (arXiv:2603.28990, 2026)
- **What it says:** across 25,000 tasks, agents with minimal scaffolding spontaneously invent roles and hierarchies; self-organization beats imposed hierarchy by 14%. BUT: roles do not stabilize (Role Stability Index → 0; 54% of role names used once).
- **We take:** the validation of emergence vs imposed structure; RSI and hierarchical depth as convergence metrics.
- **We drop:** nothing — this is our closest experimental reference.

### Paperclip (github.com/paperclipai/paperclip, March 2026)
- **What it is:** a "management layer" on top of agent runtimes; the CEO proposes, the human board approves hires/budgets.
- **We take:** the validation of the "human = board" model; business tooling in the platform, not in the agent's context; the heartbeat checklist (amnesic agents reconstructing their context).
- **We drop:** *systematic* human approval of hires (ours: progressive graduation P4).

### OneManCompany / OMC (arXiv:2604.22446, Huawei/UCL, April 2026)
- **What it says:** a CEO recruits dynamically from a "talent market"; Explore-Execute-Review with safety valves (>3 review rejections → escalation, 3600s timeout, budget pause).
- **We take:** the quantified safety valves; recruiting as the primary organizational act.
- **We drop:** the pre-built Talent Market (ours: talents emerge, they are not fished out of a catalog).

### ChatDev / MetaGPT (2023)
- **What it is:** the ancestors — a simulated company with a fixed org chart coded by humans.
- **We take:** the proof that an agent "company" produces software.
- **We drop:** the frozen org chart — exactly what our project moves beyond.

### AOrchestra (arXiv:2602.03786, 2026)
- **What it says:** the most effective orchestrator has only 2 actions: Delegate and Finish.
- **We take:** the minimality of the manager's action space.
- **We drop:** nothing.

### Darwin Gödel Machine (arXiv:2505.22954, Sakana, 2025)
- **What it says:** an agent that rewrites its own code, validated empirically on every modification, with an archive of variants (SWE-bench 20%→50%).
- **We take:** the condition for the virtuous loop (empirical validation or nothing).
- **We drop:** the single lineage — we are aiming for an organization.

## Measuring social convergence

### OASIS (arXiv:2411.11581, CAMEL-AI)
- **What it is:** a social network simulator with LLM agents (up to 1M; published experiments at 10K).
- **We take:** the method "reproduce known phenomena, compare against real data"; control groups in the style of experimental sociology.
- **Major caveat:** agents show more herd effect than humans — an RLHF artifact (too much politeness). A "society that looks human" may be conformity theater.

### CRSEC — emergent social norms (arXiv:2403.08251)
- **What it says:** beliefs converge ~3× faster than behaviors.
- **We take:** tracking acceptance and compliance as two separate curves — a persistent gap = convergence theater.

### Trophic Incoherence (arXiv:2602.21404)
- **We take:** the best instrument for "is a hierarchy forming and persisting?" — a time series of structural order.

### Society scorecard (preprints.org/202511.1370)
- **We take:** division of labor (marginal contribution — detects the "hero agent"), deliberation quality (diversity before consensus — anti-sycophancy), institutional memory.

## Failure modes

### MAST — Why Do Multi-Agent LLM Systems Fail? (arXiv:2503.13657)
- **What it says:** 14 failure modes in 3 categories (specification ~42%, inter-agent misalignment ~37%, verification ~21%), failure rate in production 41-87%.
- **We take:** the catalog as a detection checklist; readable without math — recommended reading.

### Governed MAS failure taxonomy (arXiv:2508.05687)
- **What it says:** systemic failures specific to multi-agent systems: reliability cascades, unreliable peer evaluation, dynamic instability, path dependence (early errors locked in).
- **We take:** Trophic Incoherence spikes after stability = dynamic instability; monotonic error accumulation = path dependence.

## Multi-agents — practical lessons

### Anthropic multi-agent research system (June 2025)
- **The lesson:** the documented failure = vague delegation ("research the semiconductor shortage" → duplications and holes). The fix = learning to brief, not more tools. Multi-agent cost: ~15× the tokens.

### Cognition — "Don't Build Multi-Agents" (June 2025)
- **The counter-position:** share the full context rather than fragmenting it. Public debate unresolved — our context isolation is a choice, not a consensus.

### Tuning production multi-agents (Towards AI, March 2026)
- **The lesson:** the number of tools per agent is the biggest lever on accuracy — cap ~5 tools.

## Local model

### Qwen3.8-27B (huggingface.co/Qwen/Qwen3.8-27B, August 2026)
- Dense 27B hybrid (48 linear-attention + 16 full-attention), native context 262k. Best local agentic model (Sep. 2026) but below the flagships on long-horizon.
- **Caveats:** 131k on an RTX 3090 requires a quantized KV cache (Q4 comfortable); scores obtained at higher precision than Q4; overthinking by default burns context.
