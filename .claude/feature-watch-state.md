# Anthropic Feature Watch State

Last updated: 2026-10-26
Coverage: Claude Code / Claude Agent SDK / Claude API, Feb 2026 → Oct 2026

Stack context: TanStack Start + Cloudflare Workers + Supabase med-spa SaaS

---

## Models

### Claude Haiku 5.5 (Oct 7, 2026)
- **What it is:** Fastest/cheapest model in the 5.5 family. 1M context, 128k max output. Sonnet 5.5 cache-read price cut to $0.10/MTok simultaneously.
- **How we'd use it:** Route low-stakes API calls (form classification, label generation, appointment reminders) to Haiku 5.5 to cut costs while keeping Sonnet/Opus for complex reasoning. Use for Supabase Edge Function inference where latency matters.
- **Supersedes:** Manual model selection based on gut feel — now we have a clear cost/quality ladder: Haiku 5.5 → Sonnet 5.5 → Opus 5.5.

### Claude Sonnet 5.5 (Sep 28, 2026)
- **What it is:** Latest mid-tier model. Replaces Sonnet 5. Five breaking changes from Sonnet 5 per migration notes.
- **How we'd use it:** Default model for agentic Claude Code sessions and most API calls. Review migration notes before switching any Sonnet 5 prompt.
- **Supersedes:** Claude Sonnet 5 (Jun 2026).

### Claude Opus 5.5 (Sep 22, 2026)
- **What it is:** $4/$20 per MTok. Thinking cannot be disabled. Fast mode out of research preview (no beta header needed as of Oct 15).
- **How we'd use it:** Complex multi-step reasoning tasks (insurance auth workflows, treatment plan logic). Fast mode gives Opus-quality reasoning at Sonnet speed — good fit for our scheduled overnight jobs.
- **Note:** Thinking is always on; if our prompts rely on deterministic non-thinking output, test carefully.

### Claude Opus 5 (Jul 24, 2026)
- **What it is:** $5/$25 per MTok, 1M context by default, "default" fallback mode. Previously the flagship.
- **How we'd use it:** Large-codebase analysis tasks where we need the full repo in context (e.g., auditing all Cloudflare Worker routes for auth issues in one pass). Now superseded by Opus 5.5 for most uses.

### Claude Fable 5.1 / Mythos 5.1 (Sep 1, 2026)
- **What it is:** $10/$50 per MTok. Highest-capability models. Turn-scoped system messages, per-message effort, `thinking.display: "updates"` introduced.
- **How we'd use it:** High-stakes one-off tasks only (architecture reviews, security audits). Too expensive for routine dev work.

### Sonnet 4.5 Deprecation (Sep 30, 2026)
- **What it is:** Sonnet 4.5 deprecated, retirement scheduled Nov 30, 2026.
- **Action required:** Audit any hard-coded `claude-sonnet-4-5` model IDs in our Supabase Edge Functions or Cloudflare Workers; migrate to `claude-sonnet-5-5` before Nov 30.

---

## Claude Code Features

### Dynamic Workflows (GA — multiple surfaces, Oct 2026)
- **What it is:** JavaScript scripts that orchestrate dozens–hundreds of subagents. Author with `ultracode` keyword or "use a workflow". Runs in background; pause/resume; save to `.claude/workflows/` for reuse. Built-in `/deep-research` workflow. Phase-based progress view in `/workflows`.
- **How we'd use it:**
  - `ultracode: audit every Cloudflare Worker route under src/worker/ for missing JWT auth checks` — fan out one agent per route, adversarially verify findings.
  - `use a workflow to migrate all components under src/components/ from JS to TypeScript` — parallel isolated-copy transforms.
  - Save a `/review-pr` workflow to `.claude/workflows/` so every dev runs the same review checklist.
  - Overnight codebase sweep for Supabase RLS policy gaps across all table definitions.
- **Supersedes:** Manual multi-step orchestration via repeated prompts; ad-hoc subagent spinning.

### Cloud Scheduled Tasks / GitHub Triggers (Research preview, 2026)
- **What it is:** Saved Claude Code configs with Schedule, API, or GitHub event triggers. Runs in Anthropic cloud on a cadence. Replaces "routines". API fire endpoint accepts `text` payload for alert context.
- **How we'd use it:**
  - **PR review bot:** GitHub trigger on `pull_request.opened` → runs our review checklist, leaves inline comments.
  - **Nightly dependency audit:** Schedule trigger → scans `package.json` for known-vulnerable packages, opens a PR with updates.
  - **Deploy verification:** CD pipeline POSTs to the API trigger after each Cloudflare Worker deploy; task runs smoke tests against the new worker and posts go/no-go to Slack.
  - **Supabase schema drift check:** Weekly schedule → compares live DB schema against our migration files, flags drift.
- **Supersedes:** Manual post-deploy checks; ad-hoc PR review; we do these manually today.

### Chrome Integration (`claude --chrome`, 2026)
- **What it is:** Connects Claude Code to the Chrome extension. Browser automation: click, type, screenshot, read console errors, record GIF, upload files. Shares your logged-in browser state.
- **How we'd use it:**
  - Test the med-spa booking UI end-to-end against `localhost:3000` — fill forms, verify validation, check console for React errors.
  - Verify Cloudflare Pages preview builds match Figma mocks after deploying.
  - Smoke test the patient portal on staging after each deploy without writing Playwright scripts.
  - Record a GIF of the checkout/consent flow for QA docs.
- **Supersedes:** Manually clicking through UI after code changes; some Playwright E2E test authoring.

### Agent SDK (GA, 2026)
- **What it is:** Python/TypeScript library embedding the Claude Code agent loop in your own application. Includes built-in tools, hooks, subagents, MCP, permissions, sessions, skills, plugins.
- **How we'd use it:**
  - Build a custom "intake agent" for our Supabase Edge Functions: receives patient intake form, reasons about missing fields, asks clarifying questions, writes structured record.
  - Embed an agent loop in our Cloudflare Worker for an async task queue (long-running patient chart summarization).
  - Package our dev workflow tools as a plugin so all team members get the same skills/hooks on `claude mcp install`.
- **Supersedes:** Rolling our own prompt + tool loop on top of the Messages API.

### Managed Agents (Beta → GA path, Apr 2026+)
- **What it is:** Anthropic-hosted agents configured via Claude API. No infra to manage. `ant` CLI for management. Self-hosted sandbox option for HIPAA-sensitive workloads. Supports scheduled deployments, webhooks, multiagent orchestration, memory stores.
- **How we'd use it:**
  - A persistent "chart review agent" we deploy once and call via API on demand — reads a patient visit record, produces a structured summary for the provider.
  - Offload any agent that must run on Anthropic infra (avoids Cloudflare Worker timeout limits for long-running tasks).
  - Self-hosted sandbox for PHI processing if we need data residency guarantees.
- **Supersedes:** Hosting our own agent server; Lambda/Worker-based agentic endpoints.

### `ant` CLI (Apr 8, 2026; v2.0 Oct 21)
- **What it is:** CLI for Managed Agents. `ant apply` (v1.30), `sessions connect` (v1.32), Admin API (v2.0). Apache 2.0 licensed.
- **How we'd use it:** Script agent deployments in CI; `ant apply` to roll out prompt changes to our chart review agent without manual API calls.
- **Supersedes:** Manual `curl` to Managed Agents API.

### 1M Context GA (Mar 13, 2026)
- **What it is:** 1M token context window GA for Opus 4.6 and Sonnet 4.6 (dedicated rate limits removed). Opus 5 ships with 1M by default.
- **How we'd use it:** Pass the entire Supabase schema + all Worker source files in one context for a codebase-wide audit without chunking. Useful for onboarding new team members: `explain how our entire auth flow works`.
- **Supersedes:** Manual chunking of large codebase analysis tasks.

### Automatic Caching (Feb 19, 2026)
- **What it is:** Prompt caching happens automatically; no explicit cache breakpoints needed.
- **How we'd use it:** All our API calls with repeated system prompts (patient intake agent, chart summarizer) now get cache savings without code changes. Monitor cache hit rate on our Anthropic Console.
- **Supersedes:** Manual prompt caching with explicit cache control headers.

### Browser Use Tool (Aug 19, 2026 — out of beta)
- **What it is:** Headless browser tool available in the Claude API (`browser_use_20260119`), separate from the Chrome extension. Lets API-called Claude browse the web autonomously.
- **How we'd use it:** Have our Managed Agent scrape public insurer prior-auth requirements pages and update our internal database; no Playwright infra needed.
- **Supersedes:** Custom Playwright scripts for web data collection.

### Computer Use (GA via `computer_toolset_20260801`, Aug 19, 2026)
- **What it is:** Control native macOS apps via screenshots + UI actions. Available on Google Cloud and Bedrock.
- **How we'd use it:** Automate EHR data entry for legacy systems that have no API (med-spa niche). Less relevant if all our integrations are API-based.

### GitHub Code Review (2026)
- **What it is:** Automatic code review on every PR via GitHub integration. Leaves inline comments for security, performance, style.
- **How we'd use it:** Enable on the `refill-app` repo so every PR gets a first-pass review before human review — catches common issues (missing RLS policies, unhandled Cloudflare Worker errors, TypeScript `any` escapes).
- **Supersedes:** Relying solely on human reviewers for first-pass checks.

### GitHub Actions / GitLab CI Integration (2026)
- **What it is:** Run Claude Code in CI pipelines to automate code review and issue triage.
- **How we'd use it:** Add a CI step that runs Claude to verify migration files are backward-compatible before merge; auto-triage bug reports filed as GitHub issues.

### MCP Tunnels (Research preview → `/v1/tunnels`, Jun 22, 2026)
- **What it is:** Expose a local MCP server through Anthropic's infra so cloud sessions and scheduled tasks can reach it without a public server.
- **How we'd use it:** Our local Supabase MCP server can be tunneled so cloud scheduled tasks can read/write our DB schema directly without us deploying a separate MCP host.

### Per-Message Effort (Sep 1 beta, Oct 15 GA)
- **What it is:** Set `effort` per message (not just per session): `low`, `medium`, `high`, `xhigh`. Available on Fable 5.1 and newer.
- **How we'd use it:** In our intake agent, use `low` effort for straightforward field extraction and `high` for ambiguous insurance coverage reasoning — pay only for what each step needs.

### On-Demand Compaction (Sep 14, beta)
- **What it is:** Trigger context compaction manually mid-session rather than waiting for the automatic limit.
- **How we'd use it:** During a long migration session, compact after each phase to stay in budget without starting a new session.

### Fast Mode for Opus 5.5 (Oct 15, 2026 — no beta header)
- **What it is:** Opus 5.5 reasoning at significantly faster inference speed. No beta header required.
- **How we'd use it:** Use Fast mode Opus 5.5 for our overnight scheduled tasks where quality matters but we don't need to wait — chart reviews, audit jobs.

### Remote Control (2026)
- **What it is:** Continue local CLI sessions from a phone or any browser. Push notifications to phone.
- **How we'd use it:** Monitor a long-running migration or overnight workflow from phone; unblock permission prompts while away from desk.

### Claude in Slack (2026)
- **What it is:** Mention `@Claude` in Slack with a bug report or task; Claude opens a PR and replies in thread.
- **How we'd use it:** Product team files Slack bug reports → `@Claude investigate and open a fix PR`. Reduces ticket-to-PR cycle for known bug patterns.
- **Supersedes:** Manually triaging Slack bug reports into GitHub issues.

### `claude --teleport` / `claude --cloud` (2026)
- **What it is:** `--teleport` pulls a running cloud session into your terminal. `--cloud` starts locally then continues on mobile.
- **How we'd use it:** Start a large refactor in the cloud, pull it into local terminal to run our Cloudflare dev server and verify. Or kick off a task from phone and finish it at desk.

### Channels (2026)
- **What it is:** Push events from Telegram, Discord, iMessage, or webhooks into a Claude Code session.
- **How we'd use it:** Wire Cloudflare Worker error alerts from our monitoring service into a Claude session via webhook — Claude investigates and proposes a fix in real time.

---

## API / SDK Updates

### New SDK Majors + Apache 2.0 License (Oct 21, 2026)
- **What it is:** Python 2.0.0, TypeScript 1.0.0, C# 13.0.0, Go 2.0.0, Java 3.0.0, PHP 1.0.0, Ruby 2.0.0. API version `2026-10-21`. SDKs now Apache 2.0 licensed.
- **Action required:** Review breaking changes before upgrading. Python SDK 2.0 dropped httpx1 (migrated to httpx2, requires Python 3.10+). TypeScript 1.0 likely has breaking type changes.

### Python SDK v1.0 (Aug 20, 2026)
- **What it is:** httpx2 migration, drops Python 3.9. Now superseded by 2.0.
- **Action required:** Already noted above — upgrade path is v0.x → v1.0 → v2.0; check our Supabase Edge Functions runtime Python version.

### Rate Limits API (Apr 24, 2026)
- **What it is:** Programmatically query your current rate limit state.
- **How we'd use it:** Add a pre-flight check in our agent dispatch layer to avoid 429s during high-volume appointment scheduling periods (e.g., Monday morning rush).

### `xhigh` Effort (Apr 16, 2026)
- **What it is:** New effort level above `high`. Available on Opus 4.7+.
- **How we'd use it:** Use for our most demanding reasoning tasks (complex benefit verification chains, multi-step treatment protocol lookups). Reserve high token budget for genuine complexity.

### OpenTelemetry Export (Oct 14, beta)
- **What it is:** Export API traces and metrics via OpenTelemetry.
- **How we'd use it:** Pipe Claude API latency + token usage into our existing Cloudflare observability stack (if we add OTel). Useful for spotting expensive prompt paths.

### User Profiles (Oct 20, 2026)
- **What it is:** Per-user profiles in the API, including enforcement status/actions.
- **How we'd use it:** Relevant if we build a multi-tenant feature where different users get different model behavior or usage limits.

### Personal and Service Account API Keys (Aug 27, 2026)
- **What it is:** Separate personal and service account API key types.
- **How we'd use it:** Use service account keys in our Cloudflare Workers and CI pipelines; personal keys stay in developer local configs. Cleaner rotation and audit trail.

### Workload Identity Federation (May 4, 2026)
- **What it is:** Authenticate to Anthropic API via cloud provider identity (no long-lived keys).
- **How we'd use it:** Authenticate our Cloudflare Workers to Claude API via federation instead of storing `ANTHROPIC_API_KEY` as a secret — reduces secret sprawl and rotation burden.

### Code Execution Toolset (Out of beta, Aug 19, 2026)
- **What it is:** `computer_toolset_20260801` and `code_execution_20260521` out of beta.
- **How we'd use it:** Give Claude a sandboxed Python interpreter for data analysis tasks (e.g., parse a CSV of patient appointments, compute statistics, produce a chart).

---

## Retirements to Track

| Model | Status | Deadline |
|---|---|---|
| Sonnet 4.5 | Deprecated | Retire Nov 30, 2026 |
| Opus 4.1 | Retired | Aug 5, 2026 |
| Sonnet 4 / Opus 4 | Retired | Jun 15, 2026 |
| Haiku 3 | Retired | Apr 20, 2026 |
| Sonnet 3.7 / Haiku 3.5 | Retired | Feb 19, 2026 |

---

*Next run should diff against this file and append only genuinely new entries.*
