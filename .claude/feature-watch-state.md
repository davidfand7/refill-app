# Anthropic Feature Watch State

> Tracks Claude Code / Claude Agent SDK / Claude API capabilities surfaced by the automated feature-watch routine.
> Stack context: **TanStack Start + Cloudflare Workers + Supabase** — med-spa SaaS.
> Last scanned: **2026-09-28**

---

## Entry format

Each entry contains:
- **What it is** — capability summary
- **How we'd use it** — concrete application to our stack / dev process
- **Supersedes** — any current manual step this replaces (if applicable)

---

## 2026-09-28 — Initial scan

### Models

#### Claude Opus 5.5 (`claude-opus-5-5`) — Sept 22, 2026
**What it is:** New flagship model. 1M context, always-on adaptive thinking, 128k max output. Priced at $4/$20 per MTok (input/output) — cheaper than Opus 5 ($5/$25). Cache reads $0.20/MTok. Fast mode available (research preview). Breaking: `thinking: {type: "disabled"}` returns 400; `tool_choice: "any"/"tool"` returns 400 (use `"auto"` with strict tool use); computer use now requires `computer_toolset_20260801`.

**How we'd use it:** Default model for any AI-assisted server-side logic in our Cloudflare Workers (appointment suggestions, chart summarization, patient intake Q&A). The 1M context window lets us pass entire Supabase table schemas or full conversation histories in a single prompt without chunking. Cost savings vs. Opus 5 mean we can afford more agentic steps per user action. Update any hard-coded model IDs in server routes.

**Supersedes:** Manual token-budget management to stay within smaller context windows.

---

#### Claude Fable 5.1 / Mythos 5.1 (`claude-fable-5-1`, `claude-mythos-5-1`) — Sept 1, 2026
**What it is:** 1M context, always-on adaptive thinking, $10/$50 per MTok. Cache reads reduced to $0.25/MTok (0.025× base). `tool_choice: "any"/"tool"` unsupported. Thinking prefix enforcement: replaying thinking after context changes returns 400 for accounts created after Aug 31, 2026.

**How we'd use it:** Use Fable for long-form content generation tasks (care plan summaries, patient education documents). The dramatically cheaper cache reads ($0.25 vs. prior rates) benefit our prompt-heavy workflows where we repeatedly inject the same system prompt context (product/service catalog, med-spa protocols) across many user turns.

**Supersedes:** Nothing directly; additive option for content-heavy workloads.

---

#### Claude Opus 5 (`claude-opus-5`) — July 24, 2026
**What it is:** 1M context (default and maximum), thinking on by default, 128k max output, $5/$25 per MTok. Disabling thinking only allowed at effort `high` or below; `xhigh`/`max` return 400.

**How we'd use it:** Baseline for complex reasoning tasks until Opus 5.5 is validated. Slot into our `lib/ai.ts` model configuration layer.

---

#### Claude Sonnet 5 (`claude-sonnet-5`) — June 30, 2025 (pricing standard Aug 10, 2026)
**What it is:** 1M context, adaptive thinking by default, $2/$10 per MTok. Manual extended thinking removed (returns 400). Setting `temperature`/`top_p`/`top_k` to non-defaults returns 400. New tokenizer produces ~30% more tokens than previous models.

**How we'd use it:** Default model for everyday tasks: form validation feedback, appointment scheduling suggestions, inline help text. Budget-friendly for high-frequency Worker calls. **Important:** audit any code that sets `temperature` or `top_p` — those calls will now hard-fail. Recalculate cost estimates since token counts are ~30% higher.

**Supersedes:** Sonnet 4.6 as our everyday model.

---

#### Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) — Oct 15, 2025
**What it is:** Fastest Haiku with near-frontier performance.

**How we'd use it:** Latency-sensitive in-UI suggestions (typeahead, micro-copy generation). Replace any remaining Haiku 3.5 usages.

---

#### Retired/Deprecated Models
| Model | Retired | Use instead |
|-------|---------|-------------|
| Claude Opus 3 | Jan 5, 2026 | Opus 4.5+ |
| Claude Haiku 3 | Apr 20, 2026 | Haiku 4.5 |
| Claude Haiku 3.5 | Feb 19, 2026 | Haiku 4.5 |
| Claude Sonnet 3.7 | Feb 19, 2026 | Sonnet 4.6+ |
| Claude Sonnet 4 | Jun 15, 2026 | Sonnet 4.6+ |
| Claude Opus 4 | Jun 15, 2026 | Opus 4.8+ |
| Claude Opus 4.1 | Aug 5, 2026 | Opus 5+ |

**How we'd use it:** Run a grep for deprecated model IDs across all Worker routes and update before those models stop returning responses.

**Supersedes:** Manual model-ID tracking.

---

### API Capabilities

#### Claude Managed Agents (public beta) — April 2026
**What it is:** Fully managed agent harness hosted by Anthropic. Runs the agent loop with sessions in an Anthropic-managed cloud sandbox or a self-hosted sandbox on your own infra. Accessible via Python/TypeScript SDK, `ant` CLI, or REST API. Includes lifecycle webhooks, session budgets (hard spend caps), and memory stores.

**How we'd use it:** Offload long-running med-spa workflows (e.g., "generate this month's patient outreach plan, pull CRM data, draft email sequences") to Managed Agents rather than trying to orchestrate them inside a Cloudflare Worker's 30-second CPU limit. Session budgets let us cap per-job spend. Use the lifecycle webhooks to update Supabase job status rows in real time so the front-end can poll or subscribe.

**Supersedes:** Current manual approach of chaining multiple Worker calls or relying on Durable Objects to hold long-running agent state.

---

#### Browser Use Tool (`browser_toolset_20260801`) — Aug 2026 (out of beta)
**What it is:** New tool for client-side browser automation within the agent toolset. Separate from computer use; focuses on web browsing actions.

**How we'd use it:** Automate competitor price scraping or supplier catalog imports without spinning up a headless-browser Worker. Useful for one-off data ingestion routines triggered via the Routines API.

---

#### Mid-Conversation Tools (beta) — Sept 2026
**What it is:** Define tools inside mid-conversation system messages using the `inline-tools-2026-09-15` beta header. Tools can be injected partway through a conversation, not just at session start.

**How we'd use it:** In multi-step appointment booking flows, inject booking-confirmation or payment tools only after the patient has confirmed their desired slot — prevents the model from calling payment APIs prematurely on earlier turns.

---

#### Compaction On-Demand (beta) — Sept 2026
**What it is:** `compact-2026-09-04` header triggers summarization of the conversation mid-stream, letting you control when context is compressed rather than waiting for automatic compaction.

**How we'd use it:** In our long-running agentic sessions (e.g., processing a full day's appointment log), trigger compaction after each "phase" of the task to keep context lean and avoid hitting limits mid-workflow.

---

#### Per-Message Effort (beta) — July 2026
**What it is:** `mid-conversation-output-config-2026-07-01` header allows changing the thinking effort level per message within the same conversation (e.g., use `high` for a complex reasoning step, drop to `low` for a simple formatting step).

**How we'd use it:** In structured intake flows, apply `xhigh` effort to the "assess patient history" step and `low` effort to the "format as JSON" step — reducing cost without sacrificing accuracy on the hard part.

---

#### Turn-Scoped System Messages (beta) — July 2026
**What it is:** System messages with `clear_at: "next_user_message"` are injected only for the current assistant turn and automatically cleared, acting as per-turn context without persisting.

**How we'd use it:** Inject live data (today's appointment schedule, current inventory levels) as a per-turn system message rather than re-sending it on every turn. Cleaner than manually managing a growing context.

---

#### Cache Diagnostics (out of beta) — Sept 2026
**What it is:** Include a `diagnostics` object in Messages API requests to get cache hit/miss details. No longer requires the `cache-diagnosis-2026-04-07` beta header.

**How we'd use it:** Add to our Worker middleware to log cache hit rates on our system prompts. Identify prompt sections that aren't being cached and adjust breakpoints. Reduces guesswork on why per-call costs are higher than expected.

**Supersedes:** Manual cost estimation; no-op beta header removal required in existing code.

---

#### Structured Outputs (out of beta)
**What it is:** JSON schema conformance via `output_config.format` — guaranteed schema-matching output. No beta header required.

**How we'd use it:** All our extraction tasks (parsing appointment notes into structured fields, extracting billing codes from treatment descriptions) can now reliably use structured outputs without fragile prompt engineering around JSON formatting. Update all `output_config` calls to drop the beta header.

**Supersedes:** Prompt-engineering workarounds for reliable JSON extraction.

---

#### Files API (out of beta) — Aug 2026
**What it is:** Upload and reference files in API calls. Now GA: file expiration supported, pagination with `ids[]` filter. Python/TypeScript SDK: `client.beta.files` no longer needs beta header.

**How we'd use it:** Upload patient intake PDFs or treatment images once and reference them by file ID across multiple API calls, rather than base64-encoding on every request. Significantly reduces payload sizes in our Workers.

**Supersedes:** Base64-encoding files per-request; drop the beta SDK import flag.

---

#### Agent Skills (out of beta) — Aug 2026
**What it is:** Skills API is now GA. No `skills-2025-10-02` header needed. Python/TypeScript SDK: `client.beta.skills` no longer needs beta header.

**How we'd use it:** Ship reusable skill packages (e.g., `/generate-care-plan`, `/summarize-chart`) via the SDK without any beta headers. Simplify our SDK initialization code.

**Supersedes:** Beta header on skill-loading API calls.

---

#### Web Search / Fetch Domain Restrictions — Aug 2026
**What it is:** `allowed_domains` and `blocked_domains` parameters in `agent_toolset_20260401` configs to restrict which domains the model can fetch or search.

**How we'd use it:** Lock down agent web search to approved med-spa supplier domains and medical reference sites only. Prevents agents from fetching irrelevant or potentially harmful external content.

---

#### Inference Geo Control — June 2026
**What it is:** `inference_geo` parameter pins which geographic region processes the inference request. Data residency pricing applies (1.1× for US-only on models released after Feb 1, 2026).

**How we'd use it:** If we onboard clients with HIPAA data residency requirements, pin to US inference. Set in our Worker environment config; the 1.1× premium is acceptable for compliance.

---

#### Memory Store — June 2026
**What it is:** Cross-conversation memory storage attachable to agents and self-hosted sandboxes. Agents can read/write persistent facts across separate sessions.

**How we'd use it:** Store patient preferences, past appointment outcomes, and product affinities in a memory store per patient ID. Eliminates the need to re-fetch and re-inject patient history from Supabase on every new conversation turn.

**Supersedes:** Manually injecting Supabase patient profile data on every session start.

---

#### Multiagent Advisor Tool (public beta) — April 2026
**What it is:** Pair a fast executor model with a high-capability advisor model. The advisor is consulted mid-turn when the executor needs deeper reasoning, without switching the whole session to the expensive model.

**How we'd use it:** Use Haiku as executor for routine scheduling actions, but have Opus as advisor when the booking involves complex clinical constraints or insurance questions. Cuts cost while preserving accuracy on hard decisions.

---

#### Workload Identity Federation — May 2026
**What it is:** Short-lived OIDC token authentication for the Claude API. No long-lived API keys needed.

**How we'd use it:** Issue scoped tokens from Cloudflare Workers using our Supabase JWT as the OIDC identity — eliminates the need to store a long-lived `ANTHROPIC_API_KEY` in Worker secrets. Especially valuable for HIPAA posture.

**Supersedes:** Long-lived `ANTHROPIC_API_KEY` in Worker secrets.

---

#### Personal / Service Account API Keys — Aug 2026
**What it is:** Create scoped API keys in the Anthropic Console for better attribution and tracking.

**How we'd use it:** Create one key per Worker service (booking-agent, chart-summarizer, intake-processor) for per-service cost attribution in our monthly usage reports.

**Supersedes:** Single shared API key across all Workers.

---

### Claude Code / Dev Process

#### Routines — (research preview, available on Pro/Max/Team/Enterprise)
**What it is:** Saved Claude Code configs that run autonomously on a schedule (hourly/daily/weekly), via API POST, or triggered by GitHub events (PR opened, release published). Run on Anthropic-managed cloud infra with MCP connectors. Configured at `claude.ai/code/routines` or via `/schedule` in CLI.

**How we'd use it:**
- **Nightly dependency audit:** Schedule a daily routine against our repo to check `package.json` drift, outdated Cloudflare Workers bindings, and Supabase client version mismatches. Posts a Slack summary.
- **PR auto-review:** GitHub trigger on `pull_request.opened` → runs our custom review checklist (HIPAA data handling, SQL injection checks in Supabase queries, Cloudflare rate-limit headers).
- **Deploy verification:** API trigger from our CD pipeline after each Workers deploy → runs smoke checks against the staging URL, posts go/no-go to Slack.
- **Docs drift detection:** Weekly schedule → scan merged PRs for API route changes and open update PRs against our `docs/` directory.

**Supersedes:** Manual PR review checklist; ad-hoc deploy smoke-test scripts; cron jobs in Cloudflare Workers for maintenance tasks.

---

#### Agent SDK (GA) — Python + TypeScript
**What it is:** Library that embeds Claude Code's agent loop in your own Python or TypeScript application. Built-in tools (Read/Write/Edit/Bash/Grep/WebFetch/WebSearch), hooks, subagents, MCP, permissions, sessions, skills, and plugins. Different from Managed Agents: you run the process yourself.

**How we'd use it:** Build a local dev tool that can read our entire TanStack Start + Workers codebase, understand our Supabase schema, and autonomously generate new route handlers or RLS policies when asked. Wire it into our internal tooling rather than using Claude Code interactively. Use subagents to parallelize schema migration generation and test generation.

**Supersedes:** Ad-hoc `claude -p` shell scripting; manually coordinating multi-step code generation tasks.

---

#### AGENTS.md Support (Claude Code v2.1.277+) — Sept 2026
**What it is:** Claude Code now reads `AGENTS.md` instead of `CLAUDE.md` when the latter is absent, for cross-agent-tool compatibility.

**How we'd use it:** If we also use Cursor, Copilot, or other agents, we can maintain a single `AGENTS.md` as the canonical instructions file shared across tools. No change needed if we keep using `CLAUDE.md`.

---

#### `/doctor prompt-audit` (Claude Code v2.1.283) — Sept 2026
**What it is:** New diagnostic command that audits `CLAUDE.md` files for outdated prompting patterns.

**How we'd use it:** Run periodically as part of our routine to keep our `CLAUDE.md` in sync with best practices as the model evolves. Add as a step in our weekly maintenance Routine.

---

#### MCP Tunnels (research preview) — May 2026
**What it is:** Connect Claude Code to private-network MCP servers without exposing them to the internet. Tunnels route through Anthropic's infra.

**How we'd use it:** Expose our local Supabase instance or internal admin API as an MCP server during development without adding it to a public URL. Enables Claude to read live DB schema or query test data in dev sessions without a public endpoint.

---

#### Self-Hosted Sandboxes — May 2026
**What it is:** Alternative to Anthropic-managed cloud sandboxes for Managed Agents. Run the tool execution environment on your own infrastructure (e.g., Cloudflare Workers, a VPC).

**How we'd use it:** Route agentic tool calls through our own Cloudflare Workers rather than Anthropic's infra, keeping all tool I/O (Supabase queries, file reads) within our network boundary. Required for strict data residency compliance.

---

#### GitHub Code Review (claude.ai integration)
**What it is:** Automatic inline code review on every PR via the Claude GitHub App. Applies repo-specific `REVIEW.md` checklist.

**How we'd use it:** Create a `REVIEW.md` in our repo covering: HIPAA data handling, Supabase RLS policy correctness, Cloudflare KV access patterns, TanStack Start loader/action patterns. Every PR gets automated inline comments before human review.

**Supersedes:** Manual review checklists; ad-hoc "can you review this" Claude prompts.

---

#### `ant` CLI — April 2026
**What it is:** Command-line client for the Claude API with YAML resource versioning. Manage agents, sessions, and API resources from the terminal.

**How we'd use it:** Script routine agent invocations in our Makefile/task runner without shelling out to `curl`. Use YAML resource files checked into the repo to version-control our agent configurations.

---

### SDK / Breaking Changes to Address

#### Python SDK v1.0 — Aug 20, 2026
**What it is:** Move from `httpx` to `httpx2`. Python 3.10+ required. Legacy APIs removed. `client.beta.files` and `client.beta.skills` no longer need beta headers.

**How we'd use it:** If any of our tooling uses the Python SDK, audit for breaking changes before upgrading. Update `requirements.txt` to `anthropic>=1.0.0` and Python 3.10+.

---

#### Sonnet 5 Temperature/Top-P Removal
**What it is:** Sonnet 5 and newer models return 400 if `temperature`, `top_p`, or `top_k` are set to non-default values.

**How we'd use it:** Search all API call sites for these parameters and remove them before migrating to Sonnet 5. Also note: Sonnet 5's tokenizer produces ~30% more tokens — recalculate cost projections.

**Supersedes:** Temperature tuning (now unsupported — use effort levels instead).

---

#### Manual Extended Thinking Removed
**What it is:** Sonnet 5+ no longer supports `thinking: {type: "enabled", budget_tokens: N}` style manual extended thinking. Returns 400. Use `effort` levels instead.

**How we'd use it:** Replace any manual thinking budget calls with `effort: "high"` or `effort: "xhigh"` in our API calls.

**Supersedes:** Manual `budget_tokens` configuration.

---
