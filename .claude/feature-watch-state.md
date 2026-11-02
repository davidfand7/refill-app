# Anthropic Feature Watch State

Last updated: 2026-11-02

This file tracks Claude Code / Claude Agent SDK / Claude API features that have been reviewed.
New entries are appended at the bottom when the feature-watch routine runs.

---

## Batch 2026-11-02 — Initial population (Feb 2026 – Nov 2026)

> Sources: https://platform.claude.com/docs/en/release-notes/overview, https://code.claude.com/docs, Agent SDK overview, skills docs, workflows docs.

---

### NEW MODELS

#### Claude Sonnet 4.6 *(Feb 17, 2026)*
- **What it is:** New Sonnet-tier model; launched with 1M context GA.
- **How we'd use it:** Our default workhorse for code generation, PR review, and the feature-watch routine itself. Already in use as this session's model (`claude-sonnet-4-6`).
- **Supersedes:** Manual context window management — 1M context means we can pass the full repo diff + Supabase schema to a single call without chunking.

#### Claude Opus 4.7 *(Apr 16, 2026)*
- **What it is:** Opus-tier model with new `xhigh` effort level, high-resolution image support, and task budgets (beta).
- **How we'd use it:** Use `xhigh` effort for complex refactors, architecture analysis, and security reviews on the Cloudflare Workers edge layer. High-res image support useful for reading Figma exports or error screenshots from Supabase dashboards.
- **Supersedes:** Nothing we currently do manually, but enables a "deeper review" mode that didn't exist before.

#### Claude Opus 4.8 *(May 28, 2026)*
- **What it is:** Next Opus iteration; added mid-conversation system messages (inject context mid-chat), `stop_details`, task budgets, and computer use support.
- **How we'd use it:** Mid-conversation system messages let an Agent SDK orchestrator inject per-step context (e.g., inject the relevant Supabase table schema only when an agent reaches a data-layer task) without rebuilding the full system prompt each time.
- **Supersedes:** Re-initializing agent sessions or passing large upfront context blobs.

#### Claude Fable 5 & Mythos 5 *(Jun 9, 2026)*
- **What it is:** Two new model families. Fable 5 includes refusal classifiers, `fallbacks` (automatic model fallback), and adaptive-only thinking. Mythos 5 is a companion model (unclear public details beyond pricing in later entries).
- **How we'd use it:** `fallbacks` config is useful for our Cloudflare Worker AI proxy — if Opus 5 is unavailable, auto-fall back to Sonnet 5 without client-side retry logic.
- **Supersedes:** Manual retry/fallback code in our AI proxy layer.

#### Claude Sonnet 5 *(Jun 30, 2026)*
- **What it is:** Sonnet 5 — strong mid-tier model. Standard price $2/$10 per MTok.
- **How we'd use it:** Primary model for the med-spa AI features (appointment suggestions, client intake form parsing, cancellation reason classification). Good cost/quality balance for high-volume inference from Cloudflare Workers.
- **Supersedes:** Using Sonnet 4 for production inference; Sonnet 5 at same price is strictly better.

#### Claude Opus 5 *(Jul 24, 2026)*
- **What it is:** Flagship model at $5/$25 per MTok. Mid-conversation tool changes (beta).
- **How we'd use it:** Heavy development tasks — large-scale refactors, complex migrations, security audits. Mid-conversation tool changes enable dynamic agent workflows where tools get swapped per-phase.
- **Supersedes:** Nothing we do manually, but mid-conversation tool changes supersede rebuilding a session when tool scope changes.

#### Claude Fable 5.1 & Mythos 5.1 *(Sep 1, 2026)*
- **What it is:** Updated Fable/Mythos at $10/$50 per MTok. Added turn-scoped system messages, `thinking.display: "updates"`, and per-message effort (beta).
- **How we'd use it:** Per-message effort lets us run `low` effort on routing/classification messages and `xhigh` on the actual reasoning step — reduce cost in the Cloudflare Worker inference pipeline without changing the model.
- **Supersedes:** Calling different models for different effort levels.

#### Claude Opus 5.5 *(Sep 22, 2026)*
- **What it is:** Opus 5.5 at $4/$20 per MTok (cheaper than Opus 5). Fast mode out of research preview.
- **How we'd use it:** Use Fast mode for latency-sensitive paths (e.g., real-time appointment conflict detection) without dropping to a smaller model.
- **Supersedes:** Opus 5 for quality-critical tasks; Fast mode supersedes the latency/quality trade-off we currently manage by picking between Sonnet and Opus.

#### Claude Sonnet 5.5 *(Sep 28, 2026)*
- **What it is:** Sonnet 5.5 — cache read price cut to $0.10/MTok.
- **How we'd use it:** Our default production inference model for all med-spa AI features. At $0.10 cache read, heavily cacheable prompts (system prompt + schema) become very cheap.
- **Supersedes:** Manual cache cost management — cache reads are now cheap enough that we should aggressively cache all large prompts.

#### Claude Haiku 5.5 *(Oct 7, 2026)*
- **What it is:** Haiku 5.5 — 1M context window, 128k max output, lowest-cost model in the 5.x family.
- **How we'd use it:** High-volume, low-cost tasks: form field validation, short-form classification (service category, client sentiment), and the feature-watch routine's summarisation pass. 128k max output enables generating entire test suites in one call.
- **Supersedes:** Haiku 3.5 (retired Feb 2026) and Haiku 3 (retired Apr 2026). Also supersedes chunking long generations into multiple calls.

---

### CLAUDE CODE — DEVELOPMENT WORKFLOW FEATURES

#### Dynamic Workflows (`ultracode`) *(Available on all paid plans, documented ~Oct 2026)*
- **What it is:** A JS-script orchestration layer that runs dozens of subagents in background phases. Claude writes the script (`export const meta = {...}; agent(); pipeline(); parallel()`). Bundled `/deep-research` workflow included. Scripts saved to `.claude/workflows/` become slash commands.
- **How we'd use it:**
  - `ultracode: audit every Cloudflare Worker route for missing auth + RLS bypass risks` — fans out one agent per route, adversarially verifies each finding.
  - `ultracode: migrate all Supabase query builders from raw SQL to typed client` — parallel file-level migration with per-file verification.
  - Save common sweeps (e.g., `/security-audit`, `/rls-check`) to `.claude/workflows/` and share via repo.
- **Supersedes:** Manual multi-step review sessions, running the same check on dozens of files one at a time.

#### Agent SDK (TypeScript & Python) *(Launched ~Aug 2026)*
- **What it is:** A library that embeds the full Claude Code agent loop in your own app. Capabilities: built-in tools (read/write/edit/run/web search), hooks, subagents, MCP, permissions, sessions (fork/resume), skills/commands/memory, plugins. Python SDK v1.0 released Aug 20, TypeScript v1.0 Oct 21 (Apache 2.0 license).
- **How we'd use it:**
  - Build a Cloudflare Worker (via Node.js compat) or a separate Node.js service that exposes a `/run-ai-task` endpoint — lets our Supabase Edge Functions trigger long-running agent tasks without timing out.
  - Use sessions + fork for parallel agents that each handle a different appointment slot optimization scenario.
  - `canUseTool` callback lets us gate destructive DB writes behind a confirmation step.
- **Supersedes:** Rolling our own agent loop over the raw Anthropic API. TypeScript SDK 1.0 is a breaking change — migrate from `@anthropic-ai/claude-agent-sdk` if used.

#### Cloud Scheduled Tasks (formerly Routines) *(Research preview, CLI `/schedule`)*
- **What it is:** Saved Claude Code configurations (prompt + repos + connectors) that run on Anthropic-managed infra. Triggers: cron schedule, API endpoint (POST with bearer token), or GitHub events (PR open, release, etc.). No local machine required. Available on Pro+.
- **How we'd use it:**
  - This feature-watch routine itself is already using this.
  - Nightly: `run tsc --noEmit on refill-app, open a PR if there are type errors`.
  - On every PR: `review changed Supabase migrations for backward-compatibility risks`.
  - Weekly: `summarise all merged PRs and post a changelog draft to GitHub Discussions`.
- **Supersedes:** GitHub Actions-based AI review workflows that require maintaining YAML + secrets. API trigger supersedes polling for "run on deploy" patterns.

#### Skills Overhaul *(Documented ~Aug 2026)*
- **What it is:** Skills are now the unified system for both CLAUDE.md instructions and custom slash commands. Key new features: `context: fork` runs skill in isolated subagent; `disable-model-invocation: true` requires human invocation; `$ARGUMENTS` / named args; bundled skills (`/code-review`, `/loop`, `/run`, `/deep-research`); commit hook (auto-runs `verify` skill before commits); claude.ai sync (personal skills available in cloud sessions); evaluation via `skill-creator` plugin.
- **How we'd use it:**
  - Create `.claude/skills/rls-check/SKILL.md` with `context: fork` — runs RLS policy audit as an isolated subagent on every PR.
  - Create `.claude/skills/deploy-worker/SKILL.md` with `disable-model-invocation: true` — prevents accidental Cloudflare deploys without explicit `/deploy-worker` invocation.
  - Add a `verify` skill that runs `wrangler deploy --dry-run` + `vitest run` — it'll auto-trigger before every commit.
- **Supersedes:** Ad-hoc CLAUDE.md instructions for repeatable workflows; manually remembering to run pre-commit checks.

#### `/deep-research` Bundled Workflow *(Launched with workflows)*
- **What it is:** Built-in workflow that fans out web searches across multiple angles, fetches & cross-checks sources, votes on each claim, returns a cited report with unverified claims flagged.
- **How we'd use it:** Research competitor med-spa SaaS pricing/features; investigate a library before adopting it (`/deep-research what are the security implications of X`); investigate Supabase changelog before a version upgrade.
- **Supersedes:** Manually tabbing between documentation pages and cross-referencing sources.

#### Remote Control / `--teleport` / `--cloud` *(Available on claude.ai subscription)*
- **What it is:** Continue a local session from phone/browser. `claude --cloud` moves a local session to cloud infra. `claude --teleport` pulls a cloud session into terminal. `/desktop` hands off to Desktop app for visual diff review.
- **How we'd use it:** Start a long migration task from the office terminal, `--cloud` it, review progress and reply to Claude from phone while commuting, `--teleport` back to terminal to commit.
- **Supersedes:** Leaving the laptop lid open / screen sessions for long-running tasks.

#### Channels *(Documented ~Oct 2026)*
- **What it is:** Push events from Telegram, Discord, iMessage, or custom webhooks into a Claude Code session.
- **How we'd use it:** Wire a Telegram bot to our staging Cloudflare Worker error webhook → Claude Code session automatically diagnoses and opens a fix PR when a new error pattern appears.
- **Supersedes:** Manually monitoring error dashboards and triaging issues.

#### GitHub Code Review *(Automatic review on every PR)*
- **What it is:** Claude reviews every PR automatically as a GitHub App check. Separate from manually triggering Claude in GitHub Actions.
- **How we'd use it:** Enable on refill-app to catch RLS/auth regressions, missing Zod validation on new API routes, and Supabase migration issues before human review.
- **Supersedes:** Remembering to run `/code-review` manually.

---

### API / PLATFORM FEATURES

#### Automatic Caching *(Feb 19, 2026)*
- **What it is:** Prompt cache is managed automatically by Anthropic — no need to add `cache_control` breakpoints manually. Previous explicit cache control still works but is no longer required.
- **How we'd use it:** Remove all manual `cache_control` markers from our Cloudflare Worker inference calls. Anthropic now decides cache boundaries, reducing our maintenance burden and likely improving cache hit rates.
- **Supersedes:** Manual `cache_control` markers in prompt construction.

#### Browser Use Toolset GA (`browser_toolset_20260801`) *(Aug 19, 2026)*
- **What it is:** GA toolset giving Claude a full browser (navigate, click, type, screenshot) via a structured tool API. Python/TypeScript SDK classes available (Oct 7).
- **How we'd use it:** Automated E2E testing of the med-spa booking flow — let Claude drive the browser, verify appointment creation, test payment integration. Also useful for scraping competitor pricing or extracting supplier catalogues for inventory management.
- **Supersedes:** Writing Playwright/Puppeteer scripts manually for smoke tests; we can describe the test in natural language instead.

#### Computer Use Toolset GA (`computer_toolset_20260801`) *(Aug 19, 2026)*
- **What it is:** GA toolset for full desktop computer control (mouse, keyboard, screenshot). Python/TypeScript SDK classes available (Oct 7).
- **How we'd use it:** Automate desktop-only integrations (e.g., legacy POS software used by some med-spa clients that has no API) by having Claude operate it directly.
- **Supersedes:** Manual data entry for desktop-only workflows.

#### Files API out of beta *(Aug 19, 2026)*
- **What it is:** Upload files to Anthropic once, reference by ID in any API call. Now stable (previously beta header required).
- **How we'd use it:** Upload the Supabase schema, CLAUDE.md, and common reference docs once per day; reference by file ID in all agent calls to reduce token transmission cost and latency from Cloudflare Workers.
- **Supersedes:** Re-sending large context blobs with every API call.

#### Agent Skills out of beta *(Aug 19, 2026)*
- **What it is:** Skills that can be enabled per Managed Agent deployment, uploaded to claude.ai, and referenced from the `ant` CLI. Now stable.
- **How we'd use it:** Package our project's skills for use in Managed Agent deployments (see below).
- **Supersedes:** Beta header requirement.

#### Managed Agents + `ant` CLI *(Beta Apr 8, 2026; expanding throughout 2026)*
- **What it is:** Anthropic-hosted agent harness — configure sessions via API/SDK/CLI, Anthropic runs the infra. Features: session budgets, webhooks, memory, GitHub-sourced skills, scheduled deployments (AWS), dynamic workflows, self-hosted sandboxes, `auto` permission policy (Oct), multiagent orchestration.
- **How we'd use it:** Deploy a "refill-app AI assistant" Managed Agent accessible to our internal team — no self-hosted infra needed. Use GitHub-sourced skills to keep it updated automatically. Wire to our Supabase webhook to trigger agents on DB events (e.g., new appointment → send confirmation).
- **Supersedes:** Running our own agent server on a VPS; manually managing agent sessions.

#### Inference Hooks out of beta (Enterprise) *(Oct 20, 2026)*
- **What it is:** Server-side hooks that fire before/after inference — intercept, modify, or log requests/responses at the organization level without touching client code.
- **How we'd use it:** On Enterprise plan: add a PHI (Protected Health Information) redaction hook that strips patient names/DOBs from prompts before they reach the model, and from responses before they're logged. Critical for med-spa HIPAA compliance.
- **Supersedes:** Client-side PII scrubbing code in every Cloudflare Worker that calls the API.

#### User Profiles *(Oct 20, 2026)*
- **What it is:** Persistent user identity profiles attached to API calls — enforcement status fields, user-level context across sessions.
- **How we'd use it:** Associate med-spa staff profiles with their Claude Code / AI feature usage for audit logging and per-user usage limits.
- **Supersedes:** Manually tagging requests with user IDs in metadata.

#### Organization Webhooks (beta) *(Oct 20, 2026)*
- **What it is:** Webhooks fired on organization-level events (sessions, agents, usage, etc.).
- **How we'd use it:** Stream usage events to our internal analytics dashboard to track AI cost per feature/team member.
- **Supersedes:** Polling the Usage API for cost tracking.

#### OpenTelemetry Export (beta) *(Oct 14, 2026)*
- **What it is:** Export traces, metrics, and logs from Claude API calls to any OTel-compatible backend.
- **How we'd use it:** Route OTel traces to our existing Cloudflare Workers observability stack (e.g., Grafana or Baselime) — gives end-to-end tracing from HTTP request → Cloudflare Worker → Anthropic API call → response.
- **Supersedes:** Custom logging middleware and manual latency tracking around API calls.

#### Usage and Cost Analytics API (beta) *(Oct 29, 2026)*
- **What it is:** New API for querying usage and cost data, replacing the legacy Usage and Cost API and Enterprise usage reports.
- **How we'd use it:** Build a cost dashboard in our admin panel showing spend by feature (appointment AI, document parsing, code review) with daily/weekly breakdowns.
- **Supersedes:** Legacy Usage and Cost API (still supported but now legacy).

#### API Version `2026-10-21` + SDK Major Versions *(Oct 21, 2026)*
- **What it is:** New API version. Python SDK 2.0.0 (moves to httpx2), TypeScript SDK 1.0.0 (Apache 2.0 license), Go 2.0.0, and others. All have breaking changes. `anthropic-api-version: 2026-10-21` header required for new features.
- **How we'd use it:** Migrate TypeScript SDK to 1.0.0 (pin in `package.json`). Apache 2.0 license simplifies redistribution if we ever open-source parts of our AI layer.
- **Supersedes:** Older SDK versions — plan a migration sprint. Check breaking change docs before upgrading.
- **⚠ Action required:** Pin `@anthropic-ai/sdk@1.0.0` and test before upgrading in production.

#### Compaction on Demand (beta) *(Sep 14, 2026)*
- **What it is:** Manually trigger context compaction mid-session (`compact-2026-09-04` beta header). Normally compaction happens automatically; this gives explicit control.
- **How we'd use it:** In long Agent SDK sessions (e.g., a multi-hour migration run), trigger compaction before entering the verification phase to free up context for the final summary without starting a new session.
- **Supersedes:** Splitting long tasks into separate sessions to avoid context overflow.

#### Claude Platform on AWS *(May 11, 2026)*
- **What it is:** Anthropic-managed API endpoint on AWS infrastructure. Self-hosted sandboxes for Managed Agents. Scheduled deployments. VPC/networking flexibility.
- **How we'd use it:** If the med-spa client base requires US-region data residency, route Managed Agent traffic through Claude Platform on AWS rather than the default Anthropic endpoints.
- **Supersedes:** AWS Bedrock for customers needing Anthropic-managed infra on AWS.

#### Workload Identity Federation *(May 4, 2026)*
- **What it is:** Use cloud provider identity (AWS IAM, GCP SA, Azure MI) to authenticate to the Anthropic API without long-lived API keys.
- **How we'd use it:** In our Cloudflare Worker or a companion AWS Lambda, use IAM roles to authenticate — eliminates the need to rotate `ANTHROPIC_API_KEY` secrets.
- **Supersedes:** Long-lived API keys stored in Cloudflare secrets / `.env` files.

#### MCP Tunnels (research preview) *(May 19, 2026)*
- **What it is:** Expose local MCP servers through Anthropic-managed tunnels, accessible from cloud sessions and Managed Agents without self-hosting.
- **How we'd use it:** Run our Supabase MCP server locally during development, expose via MCP tunnel, and connect it to cloud scheduled tasks and Managed Agents without setting up public infrastructure.
- **Supersedes:** Deploying a public MCP proxy server or using ngrok manually.

#### Claude Models on Google Cloud (Anthropic-managed) *(Oct 22, 2026)*
- **What it is:** Claude API served from Google Cloud infrastructure, Anthropic-managed (distinct from Vertex AI). Fast mode available for Opus 5.5.
- **How we'd use it:** If we need GCP region affinity for compliance, route through here. Otherwise no immediate change needed.
- **Flag:** Lower priority for our Cloudflare-primary stack.

#### Rate Limits API *(Apr 24, 2026)*
- **What it is:** Programmatically query your current rate limits and remaining capacity.
- **How we'd use it:** In our Cloudflare Worker AI gateway, check remaining rate limits before dispatching a high-volume batch job (e.g., bulk appointment reminder generation) and back off gracefully.
- **Supersedes:** Reacting to 429 errors after the fact.

#### Claude Tag API (beta, Enterprise) *(Oct 23, 2026)*
- **What it is:** Slack-like `@Claude` mention experience embedded in enterprise tools via API.
- **How we'd use it:** Could embed in an internal ops chat tool — staff mention `@Claude` to query appointment stats or get a Supabase query result in plain English. Enterprise plan required.
- **Flag:** Lower priority until we're on Enterprise plan.

#### Advisor Tool (beta) *(Apr 9, 2026)*
- **What it is:** A model-side tool that returns strategic advice/recommendations during an agentic task (not a user-facing tool — Claude calls it internally to check its approach).
- **How we'd use it:** Useful in Managed Agent deployments — ensures the agent double-checks its plan before executing a destructive DB migration.
- **Flag:** Used automatically when deploying Managed Agents with task budgets; no direct integration required.

#### Automatic Caching (Feb 19, 2026) — see above.

#### `ant` CLI *(Apr 8, 2026)*
- **What it is:** CLI for managing Managed Agents, deployments, and organization resources-as-code (`ant apply` since Sep 3). Complements the Anthropic Platform SDK.
- **How we'd use it:** IaC-style management of our agent deployments — check `ant apply` manifests into the repo, deploy on CI.
- **Supersedes:** Manual agent configuration via the Console UI.

---

## Deprecations / Retirements to Action

| Model | Status | Action |
|---|---|---|
| Sonnet 4.5 | Deprecated Sep 30; retires Nov 30, 2026 | Migrate to Sonnet 5.5 |
| Opus 4.1 | Retired Aug 5, 2026 | Already retired |
| Sonnet 4 / Opus 4 | Retired Jun 15, 2026 | Already retired |
| Haiku 3 | Retired Apr 20, 2026 | Already retired |
| Haiku 3.5 / Sonnet 3.7 | Retired Feb 19, 2026 | Already retired |
| Fast mode for Opus 4.8 | Deprecated Oct 30; removes Nov 30, 2026 | Migrate to Opus 5.5 |
| Workbench / Prompt Tools APIs | Retired Aug 17, 2026 | Migrate to Playground API |
| Python SDK v1.x (httpx1) | Python SDK 2.0.0 is new major | Test before upgrading |
| TypeScript SDK pre-1.0 | TS SDK 1.0.0 is breaking change | Test before upgrading |
