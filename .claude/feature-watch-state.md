# Anthropic Feature Watch State

> Tracks Claude Code / Claude Agent SDK / Claude API capabilities surveyed per run.
> Stack context: TanStack Start + Cloudflare Workers + Supabase med-spa SaaS.

---

## Run: 2026-11-09

Sources consulted:
- https://code.claude.com/docs (overview, agent-sdk/overview, workflows, routines, channels, agent-teams)
- https://platform.claude.com/docs/en/managed-agents/overview

---

### 1. Claude 5 Model Family — New models available

**What it is:**
Full Claude 5 lineup: `claude-fable-5-1` (Fable 5.1), `claude-mythos-5-1` (Mythos 5.1 — not in system prompt at session start, so genuinely new discovery), `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. Mythos appears only in the Managed Agents supported-models list and is not in the standard Claude Code system-prompt docs.

**How we'd use it:**
- Replace any hardcoded `claude-sonnet-4-5` / `claude-opus-4-6` references in our Cloudflare Worker AI calls with `claude-sonnet-5-5` or `claude-haiku-5-5` for cost/speed wins.
- Evaluate `claude-fable-5-1` for structured extraction tasks (appointment parsing, Supabase row generation).
- Note `claude-mythos-5-1` for any long-context or reasoning-heavy background jobs.

**Supersedes:**
Manually pinning Claude 4.x model IDs in environment variables.

---

### 2. Dynamic Workflows + `ultracode`

**What it is:**
Claude writes a JavaScript orchestration script that fans out up to 1,000 subagents in parallel phases, with `agent()`, `pipeline()`, `parallel()`, `phase()` primitives. The `ultracode` keyword in a prompt (or `/effort ultracode`) triggers workflow mode. Includes `/deep-research` as a built-in workflow, `/workflows` live progress view, resume-after-pause, prompt-cache sharing across fan-out agents, and a configurable `workflowSizeGuideline` (small/medium/large/unrestricted).

**How we'd use it:**
- **Codebase audits:** `ultracode: audit every Cloudflare Worker route for missing Supabase RLS checks` fans out one agent per route file and adversarially verifies each finding before reporting.
- **Migration sweeps:** `use a workflow to migrate all legacy fetch() calls to our standard apiFetch wrapper` works file-by-file in isolated copies.
- **Test generation:** `use a workflow to write Vitest unit tests for every file in src/lib/ that lacks a .test.ts sibling`.
- Save reusable orchestrations to `.claude/workflows/` so the whole team can run `/audit-rls` or `/migrate-fetch`.

**Supersedes:**
Manually spawning multiple terminal sessions for parallel work. Our current ad-hoc "open 3 tabs and assign files" pattern.

---

### 3. Claude Managed Agents (API Beta)

**What it is:**
A hosted agent harness accessible via REST API (beta header: `managed-agents-2026-04-01`). You define an `Agent` (model + system prompt + tools + MCP), an `Environment` (Anthropic cloud sandbox or self-hosted), then start `Sessions` and exchange `Events` via SSE. Supports long-running tasks (minutes/hours), persistent filesystem, scheduled deployments (cron), and `dreaming` (research preview). Available on Claude API, AWS Claude Platform, GCP Anthropic-managed.

**How we'd use it:**
- Offload long-running background jobs (e.g., generating monthly appointment summaries, bulk patient record processing) to Managed Agent sessions triggered from a Cloudflare Worker via the API.
- Use `scheduled deployments` to run nightly Supabase data-quality audits without keeping a Cloudflare Durable Object alive.
- Avoids building our own agent loop for async tasks — just POST an event and stream back results.

**Supersedes:**
Rolling our own agentic loop in a Cloudflare Worker (currently a gap — we don't have one yet, but this removes the need to build it).

**Flag:**
Not eligible for Zero Data Retention or HIPAA BAA — relevant if we handle PHI.

---

### 4. Claude Agent SDK (Python + TypeScript)

**What it is:**
A library that runs the Claude Code binary as a programmable agent in your own application. Gives access to Claude Code's built-in tools (Read/Write/Edit/Bash/WebSearch), hooks, subagents, MCP, permissions, sessions, skills, and plugins. TypeScript and Python. Different from the Client SDK (which requires you to write the tool loop yourself) and from Managed Agents (which Anthropic hosts).

**How we'd use it:**
- Build an internal `refill-agent` TypeScript service that runs in a Cloudflare Worker (or a Node.js sidecar if Worker constraints are too tight) to handle complex multi-step tasks like "process this new intake form → create Supabase records → schedule follow-up".
- Use the SDK's `Permissions` API to tightly scope which tools the agent can call in production.
- Expose agent capabilities as a first-class feature in our med-spa admin dashboard.

**Supersedes:**
Direct Messages API calls for multi-step flows that require tool use loops.

---

### 5. Cloud Scheduled Tasks (formerly Routines)

**What it is:**
Saved Claude Code configurations (prompt + repos + connectors) that run on Anthropic infrastructure on a **schedule**, via **API trigger** (HTTP POST with bearer token), or on **GitHub events** (PR opened, release published, etc.). One task can combine all three trigger types. Available on Pro+. Managed at `claude.ai/code/routines` or via `/schedule` CLI command. This current run was itself fired by this mechanism.

**How we'd use it:**
- **Nightly dependency audit:** Trigger on schedule to run `npm audit` + `npx tsc --noEmit` and open a PR if issues found.
- **PR review bot:** GitHub trigger on `pull_request` events to run `/code-review` and post findings as inline comments.
- **Weekly changelog:** Schedule to summarize merged PRs into a `CHANGELOG.md` entry.
- **API trigger:** From our Cloudflare Worker, POST to a task endpoint when a critical error is detected to trigger an automated triage session.

**Supersedes:**
GitHub Actions workflows that shell out to `claude -p` (still useful but the native integration is cleaner and doesn't need a self-hosted runner).

---

### 6. Channels (Research Preview)

**What it is:**
MCP server plugins that push events into a running Claude Code session from outside. Currently supports Telegram, Discord, iMessage, and a localhost fakechat demo. Two-way: Claude can read events and reply back through the same channel. Also supports custom webhook receivers. Install via `/plugin install telegram@claude-plugins-official`. Requires `--channels plugin:telegram@...` at startup.

**How we'd use it:**
- Route CI failure webhooks from our Cloudflare build pipeline into a local Claude session so it can auto-diagnose and fix without us watching a dashboard.
- Send a Telegram message from the med-spa front desk ("appointment system is down") and get Claude to investigate and auto-triage.
- Wire up a Discord bot in our dev team server so anyone can ask `@claude what's the current Worker error rate?` and get a live answer.

**Supersedes:**
Manually copying error messages from logs into a Claude chat session.

---

### 7. Agent Teams (Experimental)

**What it is:**
Multiple Claude Code sessions that coordinate as a team with a shared task list, direct inter-agent messaging (via `SendMessage`), and a team lead that orchestrates. Supports in-process (single terminal, arrow-key navigation) and split-pane (tmux/iTerm2) display modes. Hooks: `TeammateIdle`, `TaskCreated`, `TaskCompleted`. Enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**How we'd use it:**
- For large features: spawn a backend teammate (Cloudflare Worker/Supabase), frontend teammate (TanStack Start components), and a QA teammate (Vitest + E2E) working in parallel.
- Run a parallel security audit: one teammate checks RLS policies, one checks API auth, one checks client-side secrets.
- Note: experimental with known limitations (no session resume, task status can lag) — use for dev productivity, not production automation.

**Supersedes:**
Manually managing multiple `claude` terminal tabs for parallel feature work.

---

### 8. Remote Control

**What it is:**
Drive a local Claude Code session from `claude.ai` or the Claude mobile app while away from desk. The local session stays alive; you send prompts and see output on your phone/browser.

**How we'd use it:**
- Start a long-running migration on the dev machine, step out, and check/steer progress from phone.
- Approve permission prompts while away without having to SSH in.

---

### 9. `claude --teleport` and `/desktop` Handoff

**What it is:**
- `claude --teleport`: start a cloud session from terminal, pull it back into local terminal (requires claude.ai subscription).
- `/desktop`: continue current terminal session in the Desktop app for visual diff review.

**How we'd use it:**
- Kick off a long refactor task on the web or mobile, then `--teleport` it into the local terminal when back at the desk to finish and commit.

---

### 10. Desktop App (macOS/Windows/Linux Beta)

**What it is:**
Standalone Claude Code app with visual diff review, side-by-side session management, scheduled tasks UI, Dispatch (send tasks from phone → Desktop session), and agent view. Now available on Linux via apt (beta). Includes `/desktop` handoff from terminal.

**How we'd use it:**
- Use the visual diff review for reviewing Claude-generated schema migrations before applying to Supabase.
- Use Dispatch to queue tasks remotely and have them run on the dev machine.

---

### 11. Plugins System

**What it is:**
A plugin packages skills, agents, hooks, workflows, and MCP servers into a distributable unit installable via `/plugin install <name>@<marketplace>`. Official marketplace: `claude-plugins-official`. Plugins can be scoped to user or project. Skills/commands are namespaced as `/<plugin>:<command>`. Workflow plugins namespace as `/<plugin>:<workflow>`.

**How we'd use it:**
- Create a `refill-tools` plugin that bundles our `/deploy-preview`, `/audit-rls`, and Supabase MCP server config so any team member gets the full dev setup with one install command.
- Distribute our internal slash commands (e.g., `/seed-db`, `/check-migrations`) as a plugin checked into the repo.

**Supersedes:**
Manually copying `.claude/skills/` and `mcp.json` between team members' machines.

---

### 12. Cross-Session Messaging

**What it is:**
Claude Code sessions (not just agent teams) can send messages to each other via `SendMessage` tool. A session can message another session running on the same machine or in the cloud.

**How we'd use it:**
- A scheduled review session can ping an open dev session with "PR #42 has a failing type check" so the developer is notified in-context.

---

### 13. GitHub Code Review Integration

**What it is:**
Automatic code review on every PR via a GitHub App integration (not just GitHub Actions). Runs on PR open/update, posts inline review comments. Separate from the GitHub Actions CI/CD integration.

**How we'd use it:**
- Enable for `davidfand7/refill-app` so every PR gets an automated review pass before human review, catching RLS gaps, type errors, and security issues automatically.

**Supersedes:**
Manually running `/code-review` on PRs.

---

### 14. GitLab CI/CD Integration

**What it is:**
Claude Code can be triggered in GitLab CI/CD pipelines for automated PR review and issue triage, mirroring the GitHub Actions integration.

**How we'd use it:**
- Not immediately relevant (we use GitHub), but useful to know if we ever mirror to GitLab.

---

### 15. Chrome Browser Debugging Tool

**What it is:**
Claude Code can debug live web applications in Chrome, with access to the browser's DevTools protocol.

**How we'd use it:**
- Debug TanStack Start hydration issues or Cloudflare Worker response problems in a live browser session by asking Claude to investigate while it's open.

---

### 16. Auto Memory + AGENTS.md Support

**What it is:**
- **Auto memory:** Claude builds persistent memory across sessions automatically (learnings saved without you writing anything).
- **AGENTS.md:** Claude Code reads `AGENTS.md` as an alternative to `CLAUDE.md` for compatibility with other coding agents (Codex, Cursor Agent, etc.).

**How we'd use it:**
- Create an `AGENTS.md` at repo root so both Claude Code and any other agents (Cursor, GitHub Copilot Agent) all read the same project context.
- Let auto memory accumulate knowledge about our Supabase schema, Worker patterns, and coding conventions across sessions.

---

### 17. Windows Native Support + WinGet Install

**What it is:**
Full Claude Code support on native Windows (PowerShell + CMD install scripts), WinGet package (`winget install Anthropic.ClaudeCode`), and ARM64 support for Windows. Git for Windows recommended for Bash tool.

**How we'd use it:**
- Relevant if any team members use Windows. Document the install path in onboarding docs.

---

### 18. Tool Runner (Client SDK Beta)

**What it is:**
`client.beta.messages.tool_runner` in the Anthropic Client SDK — drives an agentic loop over your own custom tools without you writing the loop. Part of the Client SDK (not Agent SDK), so no Claude Code binary required.

**How we'd use it:**
- For lightweight tool-use flows in a Cloudflare Worker (where spawning the Claude Code binary isn't practical), use the Tool Runner to run a compact agentic loop (e.g., "look up patient record → check appointment → return confirmation") without building the loop from scratch.

**Supersedes:**
Manually implementing the tool-use retry/loop pattern in our Worker fetch handlers.

---

### 19. Self-Hosted Sandboxes (Managed Agents)

**What it is:**
Run Managed Agent sessions in your own infrastructure rather than Anthropic's cloud sandbox. For compliance or data-residency requirements.

**How we'd use it:**
- Relevant if med-spa clients require PHI to stay in a specific region or on-prem infrastructure. Revisit when HIPAA compliance is required (Managed Agents is not HIPAA-eligible by default; self-hosted sandboxes may change that posture).

---

### 20. MCP Tunnels (Research Preview)

**What it is:**
Tunnels that expose locally-running MCP servers to Managed Agent cloud sessions without public internet exposure. Research preview; request access.

**How we'd use it:**
- Expose our local Supabase dev instance or internal tools to a Managed Agent cloud session for testing without deploying a public MCP server endpoint.

---

### 21. Claude Academy

**What it is:**
Free self-paced learning at `academy.claude.com`. Courses include "Claude Code 101" and "Claude Code in Action".

**How we'd use it:**
- Onboarding resource for new team members getting started with Claude Code.

---

### 22. `subagentPromptCacheTtl` Setting

**What it is:**
Setting to extend subagent/teammate/workflow-agent prompt cache TTL from 5 minutes (default) to 1 hour. Set in `settings.json` or per-session. The 1-hour cache write is billed at a higher rate on the API.

**How we'd use it:**
- For large workflow runs (codebase audit, migration sweep) that fan out many agents with the same system prompt prefix, set `subagentPromptCacheTtl: "1h"` to avoid each agent re-processing the same prefix. Net cost saving despite higher write rate if agents > ~10.

---

*Next run will diff against this file to surface only genuinely new items.*
