# Tool surface — how dynamic tools reach the model

This note records the tool-surface arbitration for the Package layer (`extend`, C1.5,
specified) and the measurement it opens. Status vocabulary: the frozen offering, the
discovery path and the funnel below are **specified, not implemented**; the evidence and
the probes are verified facts.

## The question

A node that builds its own tools needs the model to discover and invoke them at
runtime. Two costs dominate the design space:

1. **Cache economics.** The tools field serializes before the messages, and the prompt
   cache is a byte-stable prefix. Anthropic's caching documentation states it exactly:
   *"The cache follows a prefix hierarchy (tools → system → messages), so a change at one
   level invalidates that level and everything after it: modifying tool definitions →
   invalidates entire cache"* ([prompt caching +
   tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)).
2. **Reliable invocation.** An undeclared tool name is not natively callable: verified
   empirically against the canonical endpoint (deepseek-flash, `deepseek-chat`
   chat-completions), the model refuses a native call to an undeclared name even when
   told the tool exists ("it's not in my available tool list") — a trained boundary,
   not an API error; the same probes confirm native calls to declared tools work, and
   that the wire accepts tool calls to unknown names in *history* (loop continuation is
   safe). OpenAI's guidance is the same physics from the other side: *"changing the
   loaded tool set will break the model's cache from that point forward"*
   ([tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search)).

## The three architectures

**A — Redeclare per request.** The tools array is rebuilt from the live registry on
every request; a tool registered mid-session appears natively in the next request.
This is DeepSeek Harness's generic route (its own runtime reassembles the offering
per step, accepting full prefix invalidation where the provider does not cooperate,
and restarting its system-prompt series on a tools change). Simple, native, and the
cache is structurally busted by every capability event.

**B — Search-then-mount.** A small always-loaded offering plus a search tool; chosen
definitions are mounted on demand, injected at the end of the context window to
preserve the cache. This is the industry direction: Anthropic's tool search
(~500-token search tool, ~85% tooling-token reduction, accuracy 49%→74% on Opus 4,
default-on in Claude Code; [advanced tool
use](https://www.anthropic.com/research/advanced-tool-use)) and OpenAI's
`{"type":"tool_search"}`. It requires **provider-side deferral machinery**
(`defer_loading` + a mount mechanism). On the canonical wire this machinery is
unavailable: the wire's schema accepts the `defer_loading` field, but the
announcement blocks (a `developer` role carrying `tool_addition` references) are
rejected — verified by probe. Building on undocumented, wire-specific fields would
couple the kernel to one provider's internals.

**C — Frozen offering + discovery + funnel.** The offering is frozen for the process
lifetime (the five base tools, byte-identical); dynamic tools are discovered through
the catalogue verb (schemas rendered as text) and invoked through a single declared
funnel tool (`extend {verb:"call", tool, args}` routing to a live registry, readable
at dispatch time). This is the pattern the official MCP client guidance names
verbatim as the cache-preserving option: *"route every call through a single stable
`call_tool({name, args})` meta-tool so the [tools] array never changes"*
([client best
practices](https://modelcontextprotocol.io/docs/2025-11-25/develop/clients/client-best-practices.md)).
Provider-agnostic by construction: the funnel is itself a declared tool (native
everywhere function calling exists), and on a wire without function calling it
degrades to text with unchanged kernel semantics. Its discovery layer has a proven
analog in DeepSeek Harness's inspect provider, which renders dynamic tools' full JSON
schemas as text; the schema is what the model composes arguments against, which is
why the catalogue renders it. Usage examples are a separate lever — Anthropic's
`input_examples` measurement shows parameter accuracy improving from 72% to 90%
with examples, something plain schemas cannot express ([advanced tool
use](https://www.anthropic.com/research/advanced-tool-use)).

## The decision

**C.** It is the only pattern that is simultaneously cache-stable (the tools array
never changes) and natively invocable on the verified wire; it eliminates the
versioned-offering machinery from the kernel entirely; it keeps native tool-choice
for the base tools; and it enables same-turn agentic loops — a tool registered in a
turn is callable in that turn, because the registry is read at dispatch time, not at
request assembly. No major client does dynamic per-request mounting (Cursor caps at
40 static tools; Gemini CLI and Codex filter at configuration time), so C does not
diverge from practice — it extends the MCP-sanctioned practice to the case where the
*agent itself* creates the tools.

## The measurement gap (an instrument, at zero cost)

**No published study compares dispatcher-style invocation to native redeclaration on
model reliability** — argument accuracy, error rates, retry rates — verified
absence. The gap is open territory: the only empirical data points are the probes
above.

The society can measure it from its own records: every funneled call is a frontier
fact (the complete request and response are journaled), and so is every native
base-tool call of the same nodes. The comparison condition and the treatment live in
the same journals — same nodes, same models, same tasks. Until the measurement
exists, the design carries the gap honestly: funneled-call argument accuracy is
unverified, and the frozen-offering decision rests on cache economics and wire
availability, not on demonstrated dispatcher reliability.

## Sources

- Anthropic, *Equipping agents for the real world with advanced tool use* —
  <https://www.anthropic.com/research/advanced-tool-use> (tool search, accuracy
  figures, `input_examples` 72%→90%).
- Anthropic, *Tool use with prompt caching* —
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching>
  (the prefix hierarchy and the invalidation table).
- Claude Code Agent SDK, *Tool search* —
  <https://code.claude.com/docs/en/agent-sdk/tool-search.md> (default-on, 5 per
  search, degradation at 30–50 loaded tools, under ~10 upfront is faster).
- MCP, *Client best practices* —
  <https://modelcontextprotocol.io/docs/2025-11-25/develop/clients/client-best-practices.md>
  (progressive discovery; the `call_tool({name, args})` recommendation).
- OpenAI, *Tool search* —
  <https://developers.openai.com/api/docs/guides/tools-tool-search> (hosted and
  client-executed search; cache-preserving injection; the namespace <10 guidance).
- OpenAI, *Function calling* —
  <https://developers.openai.com/api/docs/guides/function-calling> (functions count
  against context and are billed).
- DeepSeek Harness, published packages — the per-step offering reassembly, the
  inspect provider rendering schemas as text, and the PTC presentation mode
  (verified against the built packages; the analysis is
  [harness-deep-dive.md](harness-deep-dive.md)).
- Wire probes against the canonical endpoint (deepseek-flash): undeclared-name
  refusal (native hot calls do not exist), declared-name native calls confirmed,
  history tolerance of unknown tool names confirmed, `defer_loading` accepted by the
  schema, `tool_addition` announcement blocks rejected (no `developer` role).
