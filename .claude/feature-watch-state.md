# Anthropic Feature Watch State

Last updated: 2026-10-19
Stack: TanStack Start + Cloudflare Workers + Supabase (med-spa SaaS)

---

## Claude 5 Model Family

### Claude Haiku 5.5 — 2026-10-07
- **What it is:** Fastest/cheapest Claude 5-series model. 1M context window, 128k max output tokens. Breaking change vs. Haiku 4.5: see migration guide.
- **How we'd use it:** Default model for low-stakes background jobs — patient reminder drafts, form-field extraction, light classification tasks in Workers. Check migration guide before swapping from 4.5 since there are breaking changes.
- **Supersedes:** Claude Haiku 4.5 in our API calls.

### Claude Sonnet 5.5 — 2026-09-28
- **What it is:** Mid-tier Claude 5 model. Breaking change: `tool_choice: {type: "any"}` or `tool_choice: {type: "tool"}` now returns a 400 error instead of silently falling back.
- **How we'd use it:** Primary coding model for Claude Code sessions; replace Opus 4.x in most prod API calls where we need good quality at $X/MTok. Audit all places we use forced tool choice before migrating — our form-parsing pipeline likely uses `type: "any"`.
- **Supersedes:** Claude Sonnet 4.x as our go-to mid-tier.

### Claude Opus 5.5 — 2026-09-22
- **What it is:** Top-tier Claude 5, $4/$20 per MTok input/output. 1M context window. Always-on adaptive thinking — thinking cannot be disabled.
- **How we'd use it:** Complex multi-step tasks (e.g. analyzing a patient's full treatment history, generating detailed treatment plans). 1M context means we can feed an entire patient record. Adaptive thinking is always on — budget for higher latency on these calls.
- **Supersedes:** Claude Opus 4.x for high-quality tasks.

### Claude Fable 5.1 / Mythos 5.1 — 2026-09-01
- **What it is:** Creative/narrative-optimized models, $10/$50 per MTok, 1M context. Cache reads at $0.25/MTok.
- **How we'd use it:** Low priority for our stack (we're not a creative writing app). Cache-read pricing is attractive if we ever build a large-context patient-history summarization pipeline.

### Claude Opus 5 — 2026-07-24
- **What it is:** $5/$25 per MTok, thinking on by default.
- **How we'd use it:** Predecessor to Opus 5.5; prefer 5.5 for new work but keep in mind if 5.5 proves too expensive.

### Claude Sonnet 5 — 2026-06-30
- **What it is:** $2/$10 per MTok. Manual `budget_tokens` (extended thinking) now returns 400 — adaptive thinking only.
- **How we'd use it:** Predecessor to Sonnet 5.5; auditing note: remove any explicit `budget_tokens` parameters from our codebase before using Sonnet 5+.

### Claude Opus 4.8 — 2026-05-28
- **What it is:** Mid-cycle release with mid-conversation system messages and `high` default effort.
- **How we'd use it:** Mid-conversation system messages are useful for dynamic instruction injection in our agentic flows (e.g. injecting patient context mid-session). Not yet superseded but Opus 5 family is preferred.

---

## Claude API / SDK Features

### Fast Mode GA for Claude Opus 5.5 — 2026-10-15
- **What it is:** Fast mode (faster output generation) is now stable for Opus 5.5. The `fast-mode-2026-02-01` beta header is no longer required.
- **How we'd use it:** Enable fast mode on any Opus 5.5 calls where latency matters (e.g. real-time chat in our med-spa booking flow). Remove the beta header from existing code.

### OpenTelemetry Export (beta) — 2026-10-14
- **What it is:** Official OTel span emission from Claude SDKs in 7 languages. Enables tracing Claude API calls in your own observability stack.
- **How we'd use it:** Wire into our Cloudflare Workers OTel pipeline (we likely already emit spans for DB/fetch). Add Claude spans to understand latency, token usage, and error rates per feature without manual logging. High priority for prod visibility.

### Dynamic Workflows for Managed Agents (beta) — 2026-10-09
- **What it is:** Managed Agents (API-hosted) can now run multi-agent dynamic workflow scripts. Enable via `"multiagent": {"type": "multiagent_20261001", "workflows": {"type": "enabled"}}` in the agent config. Beta header: `managed-agents-2026-04-01`.
- **How we'd use it:** Run codebase-wide audits or large migrations through the Managed Agents API without standing up our own orchestration. Potential use: nightly HIPAA compliance scan across all patient-data-touching endpoints via API call, not interactive CLI.
- **Supersedes:** Manually orchestrated multi-step API calls.

### On-Demand Conversation Compaction (beta) — 2026-09-14
- **What it is:** Top-level `compaction` parameter in Messages API requests (beta header: `compact-2026-09-04`). Compresses long conversation history on-demand to stay within context limits.
- **How we'd use it:** Long-running patient intake sessions or complex booking flows that accumulate many turns. Trigger compaction programmatically instead of truncating history or re-summarizing manually. Supersedes our current manual context-trimming logic.

### Admin API out of Beta — 2026-09-30
- **What it is:** `client.organization.*` methods are now stable (no beta header needed). Python SDK 1.10.0 / TypeScript SDK 0.130.0.
- **How we'd use it:** Automate org-level management — usage monitoring, member provisioning, spend limits — without pinning beta headers. Update any org-management scripts to use stable SDK methods.

### `ant` CLI 1.30.0 — `ant apply` — 2026-09-03
- **What it is:** `ant apply` creates and updates Managed Agents, environments, skills, and memory stores from YAML/config files in your repo.
- **How we'd use it:** Codify our Managed Agent definitions as repo files alongside the app code, enabling GitOps-style agent versioning and PR-based agent updates. High value for our CI/CD workflow.

### Python SDK v1.0 Breaking Changes — 2026-08-20
- **What it is:** HTTP layer migrated to `httpx2`. Requires Python 3.10+. Legacy Text Completions API and `temperature`/`top_p`/`top_k` on Messages removed. Bedrock raises on missing region.
- **How we'd use it:** If we run any Python scripts using the Anthropic SDK (e.g. data-migration scripts), audit for removed params before upgrading. Our main stack is TypeScript so impact is low, but check any Python utility scripts.

### Computer Use & Browser Use Toolsets — 2026-08-19
- **What it is:** `computer_toolset_20260801` and `browser_toolset_20260801` — official stable toolsets for UI automation and browser control from Claude.
- **How we'd use it:** Potential for automated UI testing of our TanStack Start app and Cloudflare Workers-powered booking flows. Also useful for automating vendor portal interactions (e.g. scraping insurance reimbursement portals that have no API).

### Files API & Agent Skills out of Beta — 2026-08-19
- **What it is:** Files API (upload, reference, manage files for Claude) and Agent Skills (packaged reusable behaviors) are now stable features, no beta header needed.
- **How we'd use it:** Use Files API to pass large documents (consent forms, treatment protocols) to Claude without re-uploading. Use Agent Skills to codify our med-spa domain logic (e.g. a "verify patient eligibility" skill) that Claude always has available in agent sessions.

### Managed Agents: Session Budgets, Advisors, `inference_geo`, GitHub Skills — 2026-08-07
- **What it is:** Managed Agent sessions now support: (a) spend/token budgets, (b) advisor tools (Claude can ask a second model for guidance), (c) `inference_geo` to pin inference region (HIPAA/data residency), (d) skills loaded from GitHub repos.
- **How we'd use it:** `inference_geo` is critical for our HIPAA compliance stance — pin patient-data sessions to US regions. Session budgets protect against runaway token spend in agentic flows. Load skills from our GitHub repo to keep agent behavior in sync with our codebase.

### REPL State Persistence / `code_execution_20260120` — 2026-06-18
- **What it is:** Code execution tool now persists REPL state across turns (variables, imports survive). This is the minimum version for programmatic tool calling. No beta header needed.
- **How we'd use it:** Multi-step data analysis jobs (e.g. analyzing Supabase exports for reporting) where we need intermediate results to carry over. Supersedes workarounds that re-imported context each turn.

---

## Claude Code Features

### Dynamic Workflows (GA) — 2026-05-28 (research preview) → current
- **What it is:** JavaScript orchestration scripts that Claude writes and executes in the background, spawning up to 1,000 subagents. Built-in `/deep-research` workflow. Scripts are saveable, resumable, and distributable via plugins. Triggered with the `ultracode` keyword or "use a workflow." Pauses automatically at usage limits.
- **How we'd use it:**
  - Security audit: `ultracode: audit every API route under src/routes/ for missing auth + RLS checks` — fans out one agent per file, verifies findings adversarially.
  - Large migrations: migrate components from JS → TS or API v1 → v2 across the whole codebase in parallel.
  - Save common patterns as `.claude/workflows/` scripts checked into the repo (e.g. `/pre-release-check` that audits types, tests, and security in parallel).
- **Supersedes:** Manual sequential file-by-file editing for large cross-cutting changes.

### Routines (research preview) — 2026-05 onwards
- **What it is:** Cloud-hosted Claude Code sessions that run on a schedule, via API call, or in response to GitHub events. Configured with a prompt + repos + environment. Persists when laptop is closed. API trigger accepts `text` payload. GitHub trigger supports PR/release events with filter rules.
- **How we'd use it:**
  - **Nightly:** "Review all PRs merged today, check for missing Supabase RLS policies, and post a summary comment on any that look unsafe."
  - **On deploy (API trigger):** Post-deploy smoke check — fires after Cloudflare deployment, checks prod error logs, opens a fix PR if regressions detected.
  - **On PR open (GitHub trigger):** Run our custom code review checklist (HIPAA data handling, Cloudflare edge compatibility, Supabase query patterns).
  - **Weekly:** Dependency audit and upgrade PR generation.
- **Supersedes:** GitHub Actions for code-review automation; manual post-deploy checks.

### Agent SDK (GA) — current
- **What it is:** Python and TypeScript library that embeds Claude Code's full agent loop (tools, hooks, subagents, MCP, sessions, skills, plugins) in your own application process.
- **How we'd use it:** Build internal tooling (e.g. a patient data migration tool, a "refill-app diagnostic" CLI) that uses Claude Code's read/edit/bash tools under programmatic control rather than interactive CLI. Useful for CI scripts that need more than `claude -p`.
- **Supersedes:** `claude -p` subprocess calls for complex programmatic automation.

### Remote Control — current
- **What it is:** Continue a local Claude Code CLI session from your phone or any browser, over a secure tunnel.
- **How we'd use it:** Keep a long-running refactoring session going from a phone while away from desk. Also enables pair debugging — share the session URL with a teammate to see live progress.

### Channels — current
- **What it is:** Push external events (webhooks, Telegram, Discord, iMessage, custom HTTP) into a Claude Code session as context.
- **How we'd use it:** Wire Sentry/Cloudflare error alerts into a standing Claude session that monitors production. When an error alert fires, Claude gets the payload and can immediately investigate the codebase. Replaces manually copying error messages into Claude.

### Goals — current
- **What it is:** `/goal` keeps Claude working autonomously until a stated condition is met (e.g. "all TypeScript errors are resolved").
- **How we'd use it:** "Fix all `tsc --noEmit` errors" or "get the test suite green" — Claude iterates automatically until the condition is met rather than requiring manual re-prompts.

### Projects — current
- **What it is:** Coordinate a body of related work as parallel cloud sessions with shared task tracking. Creates related sessions that Claude can fan out work across.
- **How we'd use it:** Large features (e.g. "implement patient treatment history module") that span DB schema, API endpoints, UI components, and tests — create a project and let Claude coordinate parallel sessions per layer.

### Auto Mode (default permission mode) — current
- **What it is:** Classifier-based permission mode that automatically approves safe actions without prompting. Now the default for Claude Code sessions.
- **How we'd use it:** Reduces friction in unattended Routine runs and Agent SDK sessions. Review our `.claude/settings.json` to confirm desired permission rules are set rather than relying on manual approvals.

### `claude --teleport` / `claude --cloud` — current
- **What it is:** `claude --cloud` starts a local task and moves it to a cloud session accessible from the Claude mobile app. `claude --teleport` pulls a running web/mobile session back into the local terminal. Requires claude.ai subscription.
- **How we'd use it:** Start a long refactor on the web, then pull it into the local terminal for the final steps where IDE integration matters. Useful for async work across devices.

### Slack Integration (@Claude) — current
- **What it is:** Mention `@Claude` in a Slack channel with a bug report or task description. Claude creates a pull request and posts results back.
- **How we'd use it:** Team members can file bugs directly from Slack ("@Claude the appointment booking endpoint returns 500 when timezone is missing") and get a fix PR without opening a terminal.

### Desktop App (macOS, Windows, Linux beta) — current
- **What it is:** Standalone app with visual diff review, multiple parallel sessions side-by-side, scheduled tasks, and cloud session launch. Linux in beta via apt.
- **How we'd use it:** Run multiple sessions for different features simultaneously (e.g. frontend + backend changes in parallel) with visual diff review before committing. Desktop scheduled tasks run on the local machine with access to local files/tools.

### Worktrees for Parallel Sessions — current
- **What it is:** Claude can create isolated git worktrees for each parallel session, preventing file conflicts when multiple agents work the same repo simultaneously.
- **How we'd use it:** Essential when running parallel feature development — each Claude session gets its own worktree. Also good for running tests in isolation from active edits.

### Auto Memory — current
- **What it is:** Claude automatically builds and updates a memory file across sessions without manual CLAUDE.md maintenance.
- **How we'd use it:** Let Claude accumulate institutional knowledge about our codebase quirks (e.g. "Cloudflare Workers don't support Node fs module," "Supabase RLS must be enabled on all patient tables") across sessions without manually writing them down.

### Plugin System (Mods, Marketplace) — current
- **What it is:** Plugins package skills, agents, hooks, and MCP servers. Mods add custom panes, commands, and tool rules to the Claude Code UI. Marketplace for sharing plugins across teams/orgs.
- **How we'd use it:** Create an internal "refill-app" plugin with our custom slash commands (`/review-pr`, `/check-rls`, `/deploy-staging`) and distribute it to the whole team via the org marketplace.

### Checkpointing — current
- **What it is:** Claude tracks every file edit and can rewind to any previous state.
- **How we'd use it:** Safety net for large automated refactors — if a workflow goes sideways (e.g. breaks imports across 50 files), rewind to the pre-refactor state without `git checkout`.

### `AGENTS.md` Support — current
- **What it is:** Claude Code reads `AGENTS.md` in place of `CLAUDE.md` if no `CLAUDE.md` exists, for compatibility with other coding agents (e.g. OpenAI Codex, Devin).
- **How we'd use it:** If we ever adopt multi-agent tooling that uses `AGENTS.md`, our Claude Code sessions will automatically pick up those instructions. No immediate action needed but good to know.

### Subagent Prompt Cache TTL Setting — current
- **What it is:** `subagentPromptCacheTtl` setting (1h option) caches workflow agent prompts for an hour instead of 5 minutes. 1-hour writes are billed at a higher rate.
- **How we'd use it:** For large workflow runs with many agents that share the same prefix (e.g. our security audit workflow), enabling 1h TTL significantly reduces redundant prompt processing costs. Worth the higher write cost when running 50+ agents.

---

## Known Items (Not New — for future diff reference)

*(This section will be populated on subsequent runs as new items are found)*

---

*Generated by claude/feature-watch-2026-10-19 routine run on 2026-10-19.*
