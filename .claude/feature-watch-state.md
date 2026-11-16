# Anthropic Feature Watch State

> Tracks Claude Code / Claude Agent SDK / Claude API capabilities surveyed by the feature-watch routine.
> Stack context: TanStack Start + Cloudflare Workers + Supabase med-spa SaaS.

---

## Last surveyed: 2026-11-16

Sources checked:
- https://code.claude.com/docs
- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/routines.md
- https://code.claude.com/docs/en/agent-teams.md
- https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md (up to v2.1.325)

---

## Known features (do not re-report)

### Models

#### Claude Fable 5.2 (`claude-fable-5-2`) — added v2.1.321
- **What it is:** New Fable model, now the default Fable, with a 1 million token context window.
- **How we'd use it:** Use for large-codebase tasks — indexing all Supabase migrations + TanStack routes in one context. Ideal for the feature-watch routine itself (huge changelog ingestion), and for end-to-end RLS policy audits across all tables.
- **Supersedes:** manually chunking large files or running multiple smaller sessions to fit context.

---

### Dynamic Workflows (Ultracode)

#### Dynamic Workflows — GA on paid plans
- **What it is:** A JavaScript orchestration layer that Claude writes and the runtime executes. `agent()`, `pipeline()`, `parallel()` primitives fan out dozens–hundreds of subagents. Scripts are saveable as `/commands`. Resumable mid-run. `workflowSizeGuideline` setting (small/medium/large/unrestricted). Bundled `/deep-research` workflow included.
- **How we'd use it:**
  - `ultracode: audit every Cloudflare Worker route for missing auth middleware` — fans out one reviewer per route file, adversarially verifies findings.
  - `ultracode: migrate all Supabase SQL migrations from snake_case to camelCase column aliases` — parallel per-file transformation.
  - Save a `/med-spa-pr-review` workflow that runs security + performance + test-coverage reviewers in parallel on every PR.
  - Use `/deep-research` to investigate a new Supabase or TanStack feature before adopting it.
- **Supersedes:** manually running multiple Claude sessions for parallel code review; custom shell scripts that fan out review tasks.

#### `ultracode` keyword and `/effort ultracode` mode
- **What it is:** Typing `ultracode` in a prompt (or `/effort ultracode`) triggers workflow generation for that task. Session-wide ultracode mode makes Claude auto-plan workflows for every substantive request.
- **How we'd use it:** Use session ultracode for large-scale refactors (e.g., migrating from one auth library to another); use per-prompt keyword for one-off large sweeps.

#### `workflowSizeGuideline` setting
- **What it is:** Configures how many agents Claude targets per workflow run (small <5, medium <10, large <50, unrestricted). Default is `medium` (or `small` on Pro).
- **How we'd use it:** Set to `small` for routine PR review workflows to control cost; `large` for quarterly dependency audits.

---

### Cloud Scheduled Tasks (formerly Routines)

#### Cloud Scheduled Tasks — research preview
- **What it is:** Saved Claude Code configurations that run autonomously on Anthropic cloud infra (or self-hosted environments). Three trigger types: **Schedule** (cron), **API** (HTTP POST with bearer token), **GitHub** (repo events like PR opened/merged). Tasks can combine all three triggers. Created via `claude.ai/code/routines` or `/schedule` CLI command.
- **How we'd use it:**
  - **GitHub trigger on `pull_request.opened`** → run our custom review checklist (RLS policy check, Cloudflare Worker auth audit, TanStack route type safety).
  - **Schedule trigger nightly** → scan Supabase for stale/orphaned rows, generate a cleanup PR.
  - **API trigger from our CD pipeline** → post-deploy smoke check on the Cloudflare Worker edge, post go/no-go to Slack.
  - **Schedule weekly** → dependency audit, open upgrade PR if safe.
- **Supersedes:** manually kicking off Claude Code sessions for recurring chores; GitHub Action bots for PR review.

---

### Agent SDK

#### Agent SDK (Python + TypeScript)
- **What it is:** A library that runs the Claude Code binary from your own Python or TypeScript code, with full access to built-in tools, permissions, sessions, hooks, MCP, and plugins. Distinct from the Client SDK (which calls the Claude API directly) and Managed Agents (which Anthropic hosts).
- **How we'd use it:** Build a custom CI agent that runs in our Cloudflare Workers deploy pipeline — checks migrations are safe, runs type checks, leaves PR comments. Keeps orchestration logic in our codebase rather than a prompt.
- **Supersedes:** custom shell scripts calling `claude -p`; ad-hoc subagent orchestration.

#### Managed Agents — hosted by Anthropic
- **What it is:** Anthropic hosts the agent loop in a managed cloud sandbox (or your self-hosted sandbox). Accessed via SDK, `ant` CLI, or REST API. No local binary required.
- **How we'd use it:** Useful if we ever want to offer clients a Claude-powered portal feature without bundling the Claude Code binary — Anthropic manages the sandbox, we call the REST API from a Cloudflare Worker.

---

### Agent Teams (experimental)

#### Agent Teams — `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
- **What it is:** Multiple full Claude Code sessions coordinated as a team, with a shared task list, inter-agent messaging (mailbox files), and a lead/teammate model. Display modes: in-process (agent panel) or split panes (tmux/iTerm2). Hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted`.
- **How we'd use it:** Spawn 3 teammates for a large feature: one owns the TanStack Start UI, one owns the Cloudflare Worker API, one owns Supabase migrations + RLS policies. Lead synthesizes and resolves conflicts.
- **Supersedes:** manually opening 3 terminal windows and copying context between them.
- **Note:** Experimental — no session resumption with in-process teammates yet. Use workflows for more reliable parallelism.

---

### Surface & Integration Features

#### Remote Control
- **What it is:** Continue a local Claude Code session from a phone or any browser without losing context.
- **How we'd use it:** Start a long refactor on a laptop, monitor or redirect from a phone while away from desk.

#### Channels
- **What it is:** Push events from Telegram, Discord, iMessage, or custom webhooks into a live Claude Code session.
- **How we'd use it:** Wire a Telegram bot to our monitoring alerts so Claude Code gets Supabase/Cloudflare error events and auto-opens investigation sessions.

#### `claude --teleport` / `claude --cloud`
- **What it is:** Start a session locally, push to cloud (`--cloud`) so it keeps running when the laptop closes; `--teleport` pulls a web/mobile session back into the terminal. Requires claude.ai subscription.
- **How we'd use it:** Kick off a large overnight migration via `--cloud`, check progress on mobile, then `--teleport` to terminal in the morning to review diffs.

#### `/desktop` command
- **What it is:** Handoffs a live terminal session to the Desktop app for visual diff review. macOS + x64 Windows.
- **How we'd use it:** After Claude generates a large migration, switch to Desktop to review diffs visually before approving.

#### Dispatch
- **What it is:** Send a task to Claude Code from your phone; it creates a Desktop session you can open when you're back at your desk.
- **How we'd use it:** Queue a "refactor auth module" task from the phone during commute, find the session ready to review on arriving at the desk.

#### Slack Integration
- **What it is:** `@Claude` in a Slack channel with a bug report or task → Claude Code opens a PR.
- **How we'd use it:** Team members can open PRs for routine med-spa content updates (e.g., "add new service to the booking form") without leaving Slack.

#### GitHub Code Review (Auto)
- **What it is:** Automatic inline code review on every PR, beyond the manual GitHub Actions integration.
- **How we'd use it:** Get instant security + style feedback on every Supabase migration PR and Cloudflare Worker change.
- **Supersedes:** relying solely on team human review for catching RLS policy gaps.

#### GitLab CI/CD Support
- **What it is:** Claude Code integrates with GitLab CI/CD (in addition to GitHub Actions).
- **How we'd use it:** Not immediately relevant (we use GitHub), but useful to note if client infra requires GitLab.

#### Chrome Browser Debugging
- **What it is:** Claude Code can debug live web applications through Chrome.
- **How we'd use it:** Debug TanStack Start hydration issues or Supabase Realtime subscription problems in a live browser session.

---

### Developer Experience Features

#### Auto Memory
- **What it is:** Claude builds memory automatically as it works, saving learnings across sessions without requiring manual CLAUDE.md edits.
- **How we'd use it:** Let Claude accumulate knowledge about our Supabase schema conventions, Cloudflare Worker patterns, and TanStack query key structures without us writing them all out.

#### `AGENTS.md` Support
- **What it is:** Claude Code can read `AGENTS.md` (the standard used by other coding agents) in place of `CLAUDE.md`.
- **How we'd use it:** If we ever adopt a multi-agent setup mixing Claude with other agents, one shared `AGENTS.md` works for all of them.

#### Plugins System
- **What it is:** Package skills, agents, hooks, and MCP servers into a distributable plugin. Plugin workflows namespaced as `/<plugin>:<workflow>`.
- **How we'd use it:** Build an internal `med-spa-tools` plugin containing our review checklist skill, booking-system MCP connector, and standard deployment hook. Share across team members via path or registry.

#### Mods (UI Customization)
- **What it is:** Modify Claude's own interface or behavior: themes, panels, bands, status lines, toast notifications, slash commands, hook-triggered actions.
- **How we'd use it:** Add a status line showing current Supabase migration count or last deploy SHA. Add a panel showing open GitHub issues.

#### Skills System (`/skills`)
- **What it is:** Package repeatable workflows as shareable `/commands` (e.g., `/review-pr`, `/deploy-staging`). Stored in `.claude/` and loaded automatically.
- **How we'd use it:** Create `/med-spa-review` (security + RLS + types), `/deploy-worker` (build + deploy Cloudflare Worker + smoke test), `/new-service` (scaffold new booking service endpoint + migration + UI).
- **Supersedes:** copy-pasting long prompts for recurring workflows.

#### Claude Academy
- **What it is:** Free self-paced courses — "Claude Code 101" and "Claude Code in Action" — at academy.claude.com.
- **How we'd use it:** Onboard new team members or contractors to our Claude Code-augmented dev process.

#### Cross-Session Messaging
- **What it is:** Claude Code sessions can pass findings to each other by name without being a full agent team.
- **How we'd use it:** Lightweight coordination: a session analyzing a PR can send a summary to another session handling the merge checklist.

---

### New CLI Features & Settings

#### `permissions.denyInsteadOfPrompting` setting — v2.1.319
- **What it is:** Denies a tool call that would otherwise block waiting for a permission prompt. For non-interactive/CI runs.
- **How we'd use it:** Use in our GitHub Actions Claude Code runs to fail fast rather than hanging on an unexpected tool call.

#### MCP Task Support in Terminal — v2.1.319
- **What it is:** Long-running MCP tool calls move to the background, keeping the terminal responsive.
- **How we'd use it:** Run slow Supabase schema introspection or large file indexing via MCP without blocking the session.

#### `/claude-api latency-optimize` — v2.1.319
- **What it is:** Slash command that analyzes your Claude API code and identifies where users are waiting unnecessarily.
- **How we'd use it:** Run on our Cloudflare Worker Claude integration code to find streaming or batching improvements.

#### Code Mode — v2.1.323 (experimental opt-in)
- **What it is:** Claude writes JavaScript to call its tools rather than calling them directly — an agentic scripting layer within a session.
- **How we'd use it:** Watch this space; could complement or partially replace workflow scripting for smaller tasks.

#### VS Code Prompt Suggestions — v2.1.325
- **What it is:** Tab accepts the suggested next prompt in VS Code, reducing repetitive typing.
- **How we'd use it:** Speed up iterative debugging cycles in the VS Code extension.

#### `--settings <file>` on `claude remote-control` — v2.1.321
- **What it is:** Pass a settings file to a remote control session at startup.
- **How we'd use it:** Give our Remote Control sessions the same project-level permissions and MCP config as local sessions.

---

## Changelog

| Date       | Items added |
|------------|-------------|
| 2026-11-16 | Initial population — all entries above (first run, no prior state file). |
