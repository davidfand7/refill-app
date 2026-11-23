# Anthropic Feature Watch State

> Tracks Claude Code / Claude Agent SDK / Claude API capabilities.
> Stack context: TanStack Start + Cloudflare Workers + Supabase med-spa SaaS.

---

## Last checked: 2026-11-23

---

## Models

### Claude Fable 5.2 & Mythos 5.2 (2026-11-09)
- **What it is:** 1M-token context, 128k max output, always-on adaptive thinking. $8/$40 per MTok (down from $10/$50). Fast mode via `speed: "fast"` (no beta header) at up to 2.5x speed, $16/$80. Mythos 5.2 limited to verified orgs. Requires 30-day data retention.
- **How we'd use it:** Default model for all Cloudflare Worker AI handlers; fast mode is a drop-in speed boost for latency-sensitive appointment-booking flows where we don't need full deliberation. Fable 5.2 replaces Fable 5.1 immediately.
- **Supersedes:** Claude Fable 5.1 / Mythos 5.1 as the preferred frontier models.

### Claude Haiku 5.5 (2026-10-07)
- **What it is:** 1M context, 128k output. Sonnet 5.5 cache reads cut to $0.10/MTok.
- **How we'd use it:** Cost-effective model for high-volume classification tasks (e.g. categorising intake form responses, tagging notes). Cache-read price drop makes prompt-cached Supabase-context calls even cheaper.

### Claude Sonnet 5.5 (2026-09-28) & Opus 5.5 (2026-09-22)
- **What it is:** Sonnet 5.5 is a mid-tier option. Opus 5.5 at $4/$20, thinking always on, fast mode in research preview.
- **How we'd use it:** Sonnet 5.5 for multi-step form validation agents; Opus 5.5 for complex reasoning tasks like insurance coverage analysis.
- **Supersedes:** Sonnet 5 / Opus 5 as the preferred variants in those families.

### Claude Sonnet 5 / Opus 5 / Fable 5 / Mythos 5 (2026-06–07)
- **What it is:** Sonnet 5 at $2/$10 with adaptive thinking on by default; Opus 5 at $5/$25 with 1M context; Fable 5 & Mythos 5 at 1M context, 128k output.
- **How we'd use it:** Sonnet 5 as the standard workhorse model; Fable/Mythos for research-heavy agentic tasks on the backend.

---

## Claude API Features

### Message Threads / Server-Side Conversation State (2026-11-02, beta)
- **What it is:** `message-threads-2026-08-12` beta header. Conversation state lives on the API server; later requests send only new messages.
- **How we'd use it:** Stateful multi-turn appointment consultation flows in our Cloudflare Worker without manually forwarding full history each turn—saves bandwidth and reduces latency. Eliminates the custom conversation-history store we currently maintain in KV.
- **Supersedes:** Our manual conversation-history accumulation pattern in the Worker.

### Linked Billing (2026-11-17, beta)
- **What it is:** `billing_policy` on `/v1/messages`. Customers pay for Claude usage through their own Claude org.
- **How we'd use it:** Could allow enterprise med-spa clients to bring their own API keys and billing, lowering our direct API cost liability.

### Text Watermarking (2026-11-16)
- **What it is:** Text from Opus 4.6/4.5, Sonnet 4.5, Haiku 4.5 (and newer) carries Anthropic's watermark on supported platforms.
- **How we'd use it:** Mostly informational; no action needed unless we detect false-positive watermark claims from users.

### Self-Hosted Claude Managed Agents (2026-11-12)
- **What it is:** Run the entire Managed Agents service on your own infrastructure. Request access via account team.
- **How we'd use it:** If patient data residency regulations ever require it, we could self-host the agent harness instead of using Anthropic's cloud sandboxes.

### User Profiles (2026-10-20)
- **What it is:** `/v1/user_profiles` endpoint attributes API requests to end customers. `enforcement_status` and `enforcement_actions` fields added.
- **How we'd use it:** Per-patient usage attribution and rate-limiting; link Supabase user IDs to Claude API usage for per-tenant billing analysis.

### Organization Webhooks (2026-10-20, beta)
- **What it is:** Webhook events including `external_key.failed` and `external_key.recovered`.
- **How we'd use it:** Alert our ops channel when API keys fail or recover, automating incident response.

### OpenTelemetry Export (2026-10-14, beta)
- **What it is:** Export Claude API traces via OTEL.
- **How we'd use it:** Feed Claude latency and token data into our existing Cloudflare observability stack (Workers Analytics Engine) without custom logging middleware.

### Usage and Cost Analytics API (2026-10-29, beta)
- **What it is:** `analytics-usage-cost-2026-08-24` beta header. Replaces the legacy Usage and Cost API.
- **How we'd use it:** Pull per-tenant cost data into our admin dashboard to show med-spa owners their AI usage costs.

### New API Version `2026-10-21` + SDK Major Versions
- **What it is:** Python SDK 2.0, TypeScript SDK 1.0, C# 13.0, Go 2.0, Java 3.0, PHP 1.0, Ruby 2.0, `ant` CLI 2.0. Apache 2.0 licensed (was MIT). Breaking changes.
- **How we'd use it:** Plan an upgrade sprint; review breaking changes in the TypeScript SDK before bumping. Apache 2.0 may require updating our license notices.
- **Supersedes:** Older SDK major versions.

### Inline Tool Definitions (2026-09-22, beta)
- **What it is:** `inline-tools-2026-09-15` beta header. Tools defined inline in the message rather than in a separate top-level block.
- **How we'd use it:** Simplifies dynamic tool generation in Worker request handlers where tool sets vary per request.

### Compaction on Demand (2026-09-14, beta)
- **What it is:** `compact-2026-09-04` beta header. Explicitly trigger conversation compaction mid-session.
- **How we'd use it:** Long-running consultation sessions that approach context limits can be compacted without ending the session, keeping continuity for multi-visit patient interactions.

### Per-Message Effort & Turn-Scoped System Messages (2026-09-01, beta)
- **What it is:** Set thinking effort per message; override system prompt for a single turn.
- **How we'd use it:** Use high-effort for the final treatment-plan synthesis message and low-effort for routine acknowledgments in the same conversation, controlling cost precisely.

### Mid-Conversation System Messages (2026-05-28)
- **What it is:** Change the system prompt partway through a conversation.
- **How we'd use it:** Switch from an intake-gathering persona to a treatment-recommendation persona mid-session without restarting context.

### Browser Use Toolset (2026-08-19, out of beta)
- **What it is:** Browser use SDK classes for Python and TypeScript. Out of beta alongside computer use toolset.
- **How we'd use it:** Agent that scrapes supplier pricing pages or insurance portal data as part of treatment cost estimation flows.

### Files API & Skills API (2026-08-19, out of beta)
- **What it is:** Both APIs no longer require beta headers.
- **How we'd use it:** Use Files API to upload and reference large treatment protocol PDFs without re-sending them each request. Skills API lets our backend define reusable agent skill sets.

### Personal & Service Account API Keys (2026-08-27)
- **What it is:** Distinct key types for human users vs. service accounts.
- **How we'd use it:** Use service account keys for Worker deployments to prevent key leakage if a developer's personal key is rotated.

### Claude Platform on AWS (2026-05-11)
- **What it is:** Managed Agents and Claude models available on AWS infrastructure.
- **How we'd use it:** If a future enterprise client requires AWS-only data residency, we can run Claude on their AWS account via Claude Platform on AWS.

### Claude Models on Google Cloud – Anthropic Managed (2026-10-22)
- **What it is:** Claude models on Google Cloud, Anthropic-managed. Fast mode for Opus 5.5 available there.
- **How we'd use it:** Alternative deployment target if we ever move backend compute to GCP.

---

## Claude Code / Agent SDK Features

### Dynamic Workflows / Ultracode (GA, available on all paid plans)
- **What it is:** A JavaScript orchestration script that spawns dozens of subagents in the background. Trigger with the `ultracode` keyword or `use a workflow`. Bundled `/deep-research` workflow included. Runs resumable, with per-phase progress view in `/workflows`.
- **How we'd use it:** Codebase-wide audits (security, type coverage), large Supabase migrations, mass component refactors. `/deep-research` for competitor and regulatory research. Save custom workflows for recurring tasks like pre-release checklists.
- **Supersedes:** Manually chaining subagents or writing multi-step bash scripts for large parallel tasks.

### Agent SDK (Python + TypeScript)
- **What it is:** Library that embeds the Claude Code agent loop (file tools, MCP, permissions, sessions, hooks, skills, plugins) into your own Python or TypeScript application.
- **How we'd use it:** Build a background worker on Cloudflare (or a Node.js sidecar) that runs Claude Code's full agent loop for autonomous code-generation tasks triggered by GitHub webhooks—without needing an interactive terminal session.
- **Supersedes:** Direct Messages API calls for multi-step file-editing flows.

### Claude Managed Agents (beta, `managed-agents-2026-04-01`)
- **What it is:** Anthropic-hosted agent harness: creates agents with model + system prompt + tools + MCP, then runs sessions in managed cloud sandboxes with persistent filesystem, compaction, and streaming SSE. Available on API, AWS, and GCP. Supports scheduled deployments.
- **How we'd use it:** Delegate long-running autonomous tasks (e.g., generate monthly analytics report, nightly dependency audit) to a Managed Agent session triggered via API, eliminating the need to manage our own agent-runner infrastructure on Cloudflare.
- **Supersedes:** Custom agent-loop Worker code we'd otherwise have to build and maintain.

### Agent Teams (experimental, opt-in via env var)
- **What it is:** Multiple Claude Code sessions coordinated as a team: one lead + N teammates, shared task list, direct inter-agent messaging. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- **How we'd use it:** Parallel feature development (frontend teammate, backend teammate, test-writer teammate) for large feature sprints. Research + devil's-advocate pattern for architecture decisions.
- **Supersedes:** Sequential, single-session development for multi-layer changes.

### Channels (research preview)
- **What it is:** Push events from Telegram, Discord, iMessage, or custom webhooks into a running Claude Code session. Supports two-way replies. Install via plugin system.
- **How we'd use it:** Forward CI failure webhooks into a persistent Claude Code session so it can auto-diagnose and open a fix PR. Team members could DM the bot on Telegram to kick off ad-hoc tasks without opening a terminal.

### Cloud Scheduled Tasks / Routines
- **What it is:** Formerly "routines". Saved Claude Code sessions that run on a schedule, on API POST, or on GitHub events (PR, release). Runs on Anthropic infrastructure even when your machine is off.
- **How we'd use it:** Nightly dependency audit, weekly feature-watch scan (this very routine), automatic PR review on every opened PR, deploy-triggered changelog generation. Create via `/schedule` in CLI or at claude.ai/code/routines.
- **Supersedes:** Cron jobs or GitHub Actions workflows we'd have to build and host ourselves.

### Plugins
- **What it is:** Package skills, agents, hooks, and MCP servers into a distributable plugin. Install from a marketplace with `/plugin install`. Supports custom marketplaces.
- **How we'd use it:** Create a `refill-app` plugin that bundles our project-specific skills (deploy, migrate, review-pr), MCP server config, and hooks so new team members get the full setup with one `/plugin install` command.

### Auto Memory
- **What it is:** Claude builds persistent project memory automatically as it works, without requiring a manually maintained CLAUDE.md.
- **How we'd use it:** Let Claude accumulate patterns, conventions, and decisions for the refill-app codebase organically instead of maintaining a hand-written CLAUDE.md—though we can still add manual entries for critical constraints.

### AGENTS.md Support
- **What it is:** Claude Code reads `AGENTS.md` in place of `CLAUDE.md` when the former exists (for compatibility with other coding agents).
- **How we'd use it:** If we ever adopt additional coding agents alongside Claude Code, a shared `AGENTS.md` avoids duplicating instructions.

### Desktop App (macOS, Windows, Linux beta)
- **What it is:** Standalone app with visual diff review, multiple parallel sessions, session scheduling, and cloud session launch. Includes Dispatch for starting sessions from your phone.
- **How we'd use it:** Visual diff review during code reviews; running multiple parallel sessions (e.g., one for backend, one for frontend) side by side.

### Remote Control
- **What it is:** Drive a local Claude Code session from claude.ai or the Claude mobile app while away from desk.
- **How we'd use it:** Monitor and steer long-running refactor sessions from a phone without keeping a laptop open.

### `claude --teleport`
- **What it is:** Move a running task from web/mobile cloud session to local terminal.
- **How we'd use it:** Start a task from the web UI, then pull it into the local terminal when back at the desk to get full file-system access.

### Slack Integration (`@Claude`)
- **What it is:** Mention `@Claude` in a Slack channel or thread; it spawns a cloud session and returns a pull request.
- **How we'd use it:** Team members report bugs or request features in Slack and get a draft PR automatically, reducing context-switching from chat to terminal.

### GitHub Code Review (Automatic)
- **What it is:** Automatic code review triggered on every PR via GitHub App.
- **How we'd use it:** Add to our GitHub repo for automated correctness, security, and style feedback on every PR before human review.

### `/deep-research` Bundled Workflow
- **What it is:** Built-in workflow that fans out web searches, cross-checks sources, votes on claims, and returns a cited report.
- **How we'd use it:** Research regulatory requirements, competitor features, or library changelogs as part of sprint planning or architecture decisions.

### `ant` CLI (v2.0.0 as of 2026-10-21)
- **What it is:** CLI for managing Managed Agents resources (agents, sessions, environments). `ant apply` manages resources as code; `ant beta:sessions connect` streams live session output.
- **How we'd use it:** Treat Managed Agent configurations as infrastructure-as-code alongside our Terraform/Wrangler configs. Use `ant beta:sessions connect` for live debugging of running agent sessions.

### MCP Tunnels (research preview)
- **What it is:** Connect MCP servers through a secure tunnel without exposing a public endpoint.
- **How we'd use it:** Expose our internal Supabase MCP server to Managed Agent sessions without opening a firewall port, keeping patient data off the public internet.

### Dreams (research preview, Managed Agents)
- **What it is:** A Managed Agents sub-feature for extended background reasoning/research tasks. Supports Fable 5.2.
- **How we'd use it:** Delegate overnight deep-analysis tasks (e.g., full codebase security audit, long-horizon planning) to a dreaming agent session.

---

## Deprecation Watch
- **Sonnet 4.5** retires 2026-11-30
- **Opus 4.8 fast mode** removed 2026-11-30
- **Legacy Usage and Cost API** replaced by Analytics API (Oct 2026)
- **`computer_20251124`** computer-use toolset returns 400 error (except Bedrock); use `computer_toolset_20260801`
- **`teammateDefaultModel`** setting removed in Claude Code v2.1.234
- **MIT license** on SDKs replaced by Apache 2.0 as of `2026-10-21` API version
