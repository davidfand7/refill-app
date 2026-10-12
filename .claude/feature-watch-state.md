# Claude Code / Claude Agent SDK / Claude API Feature Watch

_Stack context: TanStack Start + Cloudflare Workers + Supabase med-spa SaaS_

---

## 2026-10-12 — Initial population

> Source: code.claude.com/docs + changelog through v2.1.296 (Oct 9, 2026)

---

### New Models

#### Claude Sonnet 5.5 (`claude-sonnet-5-5`) — v2.1.284 (Sep 28 2026)
- **What it is:** New default Sonnet model with 1 M context window at $2/$10 per Mtok input/output; cache reads $0.10/Mtok (halved from $0.20 in v2.1.296).
- **How WE'd use it:** Default model for all AI-assisted features in the app (appointment-booking chat, med-spa recommendation engine). Cache reads at $0.10/Mtok make heavy system-prompt reuse very cheap — pre-cache large Supabase-query context blocks.
- **Supersedes:** Manual model-ID pinning to `claude-sonnet-4-*`; update `model` fields in Workers AI calls.

#### Claude Haiku 5.5 (`claude-haiku-5-5`) — v2.1.293 (Oct 7 2026)
- **What it is:** New default Haiku model, 1 M context, $0.10/$0.50 per Mtok (or $0.50/$2.50 over 100 K tokens).
- **How WE'd use it:** Drive lightweight classification tasks on the Workers side (intent detection for chat widgets, form-field validation hints) at near-zero cost. Swap `claude-haiku-3-5` references.
- **Supersedes:** Haiku 3.5 usage — new IDs, better price/quality.

#### Opus 4.7+ & Fable — 1 M context window on all providers — v2.1.287
- **What it is:** Opus 4.7+ and Fable now default to 1 M context on Bedrock, Vertex, Foundry, and the Claude apps gateway. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` restores 200 K.
- **How WE'd use it:** Potential for full-codebase context when using Claude on our CI pipeline or gateway integrations; no action needed unless we hit cost surprises.

---

### Routines (Cloud Automation) — GA in research preview

- **What it is:** Saved Claude Code configurations that run automatically on a **schedule** (hourly/daily/weekly/one-off cron), via **API trigger** (HTTP POST with bearer token), or on **GitHub events** (PR opened/closed/labeled, release). Runs on Anthropic-managed cloud infra; no local machine required. Each run is a full autonomous Claude Code session.
- **How WE'd use it:**
  - **Nightly dependency audit:** Schedule a weekly run that reads `package.json`, checks for outdated deps, and opens a draft PR with the upgrade diff.
  - **PR review bot:** GitHub trigger on `pull_request.opened` → runs our `/code-review` checklist and posts inline comments.
  - **Post-deploy smoke check:** Wire Cloudflare deploy webhook to API trigger; routine hits our staging endpoints and posts a Slack "go/no-go".
  - **Docs drift:** Weekly schedule scans merged PRs, flags stale API docs, opens PRs against the docs repo.
- **Supersedes:** Manual PR review process; ad-hoc Slack notifications for deploy status; one-off `claude -p` scripts run locally.
- **Access:** `claude.ai/code/routines`, `/schedule` CLI command, Desktop app. Available on Pro, Max, Team, Enterprise.

---

### Dynamic Workflows (Multi-agent Orchestration) — All paid plans

- **What it is:** A JavaScript script that orchestrates dozens-to-hundreds of subagents in parallel. Claude writes the script from a natural-language description; a runtime executes it in the background. Key primitives: `agent()`, `pipeline()`, `parallel()`, `phase()`. Scripts are resumable, saveable as `/` commands, and distributable via plugins.
  - `ultracode` keyword in any prompt triggers Claude to write a workflow instead of working turn-by-turn.
  - `/effort ultracode` makes every substantive task a workflow for the session.
  - `/deep-research` is a built-in workflow for cross-checked web research.
  - Workflow size guideline (small/medium/large/unrestricted) controls agent count.
- **How WE'd use it:**
  - `ultracode: audit every Cloudflare Worker endpoint for missing auth middleware` — fans out one agent per route file, cross-checks findings.
  - `ultracode: migrate all Supabase queries from snake_case to camelCase across src/` — parallel per-file isolation.
  - Save a `/nightly-review` workflow that runs per-file code review then synthesizes a ranked summary.
  - `/deep-research` for spike research on new Supabase features or TanStack APIs.
- **Supersedes:** Manual file-by-file review loops; ad-hoc "run this on each file" one-liners.
- **env var:** `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` (v2.1.296) pins all workflow agents to one model for cost control.

---

### Agent SDK (Python & TypeScript) — New standalone library

- **What it is:** A standalone Python and TypeScript library (`claude-agent-sdk-python`, `claude-agent-sdk-typescript`) that embeds the Claude Code agent loop into your own application. Replaces the old Claude Code SDK packages. Provides: built-in tools, hooks, subagents, MCP, permissions, sessions, skills, plugins. Compare: Agent SDK (you operate the process) vs. Managed Agents (Anthropic hosts it).
- **How WE'd use it:**
  - Embed an AI coding assistant directly in our admin dashboard (Cloudflare Worker + TanStack Start) without shelling out to the CLI.
  - Build a Supabase-aware agent that automatically generates SQL migrations when schema changes are detected.
  - Managed Agents for on-demand sandboxed code execution without managing infra ourselves.
- **Supersedes:** Calling `claude -p` as a subprocess; the old `@anthropic-ai/claude-code` SDK package — follow the published migration guide.
- **Docs:** `code.claude.com/docs/en/agent-sdk/overview`

---

### Read Tool `allow_large` Option — v2.1.296 (Oct 9 2026)

- **What it is:** A new `allow_large: true` parameter on the built-in Read tool that reads an oversized text file in a single call (up to context limit) instead of forcing chunked reads.
- **How WE'd use it:** In routines or workflows that need to read a large generated file (e.g., a Supabase migration history dump or a bundled build artifact) without manual offset pagination.
- **Supersedes:** Workaround patterns using offset + limit loops for big files.

---

### Agent Tool `effort` Parameter — v2.1.292 (Oct 6 2026)

- **What it is:** The Agent tool now accepts an `effort` parameter (`low` | `medium` | `high` | `xhigh` | `max`) to set the reasoning effort of the spawned subagent independently of the parent session.
- **How WE'd use it:** In workflow scripts, use `effort: "low"` for cheap classification agents and `effort: "high"` for security-review agents, trimming cost without sacrificing quality where it matters.

---

### Hooks `onFailure: "block"` — v2.1.295 (Oct 8 2026)

- **What it is:** Command and HTTP hooks can now set `onFailure: "block"` to halt a tool call when the hook itself fails, instead of silently continuing.
- **How WE'd use it:** Make our pre-commit lint hook a hard blocker — if the formatter hook crashes, the file edit is blocked rather than committed with bad formatting.
- **Supersedes:** Workaround of having hooks `exit 1` and hoping Claude would interpret the output as a block signal.

---

### Mods: `$.ui.notify` — v2.1.295

- **What it is:** Plugins/mods can now push a desktop notification from the mod layer via `$.ui.notify()`.
- **How WE'd use it:** Build a mod that pings us when a long-running Supabase migration or a Cloudflare Worker deploy finishes inside a session.

---

### Mods: `$.tool.register` with `isDeferred` — v2.1.293

- **What it is:** Plugins can register tools lazily (`isDeferred: true`), so the tool schema is not loaded until explicitly searched for, keeping the tool list small.
- **How WE'd use it:** Register rarely-used admin tools (e.g., a "purge CDN cache" tool) in our plugin as deferred so they don't clutter autocomplete.

---

### `claude plugin install --marketplace` — v2.1.292

- **What it is:** Install a plugin directly from the Claude marketplace by source name, without manually specifying a path or URL.
- **How WE'd use it:** Standardize team plugin setup in a `startup-hook.sh` — one-liner `claude plugin install --marketplace <name>` to ensure everyone has the same plugins on cloud session start.

---

### `claude --desktop` handoff — v2.1.285

- **What it is:** New CLI flag `claude --desktop` that opens the current terminal session in the Desktop app for visual diff review.
- **How WE'd use it:** After a large refactor in the terminal, `claude --desktop` to visually scan all diffs before committing.

---

### Program Status Protocol (OSC 7501) — v2.1.295

- **What it is:** Terminal emulators that support OSC 7501 can now show whether Claude Code is working, waiting, or idle in a status bar/indicator.
- **How WE'd use it:** Teams using WezTerm or Ghostty get a native status indicator — useful on long Cloudflare Worker deploy-check routines.

---

### `/doctor prompt-audit` — v2.1.283

- **What it is:** New sub-command that scans CLAUDE.md, skills, agents, and commands for prompting patterns written for older models, and flags what needs updating.
- **How WE'd use it:** Run periodically after model upgrades to keep our `.claude/CLAUDE.md` and skills in sync with current model behaviour.

---

### `/code-review --max-findings <n>|all` — v2.1.288

- **What it is:** The code-review skill now accepts `--max-findings <n>` or `--max-findings all` to report exactly N findings or every finding, overriding the default cap.
- **How WE'd use it:** In CI pipeline calls, pass `--max-findings all` to get every finding for the security review gate; pass `--max-findings 5` for a quick developer feedback loop.

---

### Claude Tag (Slack) `!fast` Mode — v2.1.290

- **What it is:** Mention `@Claude !fast` in Slack to use Fast mode (Opus with faster output). Channel instruction limit also raised to 8 192 characters.
- **How WE'd use it:** When asking `@Claude` for quick clarifications or one-liner fixes in our `#dev` channel, `!fast` cuts latency noticeably.

---

### Channels — Webhooks from Telegram, Discord, iMessage

- **What it is:** Push events from Telegram, Discord, iMessage, or custom webhooks into a Claude Code session, which can then act on them programmatically.
- **How WE'd use it:** Wire a Telegram bot to a routine's Channel so staff can trigger "check appointment availability" lookups via Telegram message.

---

### Claude in Chrome — v2.1.296

- **What it is:** Claude Code's Chrome extension now asks before browser actions in every session (including VS Code sessions). Enables debugging live web applications with Claude.
- **How WE'd use it:** Debug our TanStack Start SSR renders in production Chrome with Claude acting on DOM state without manual screenshots.

---

### Remote Control — Continue sessions from phone/browser

- **What it is:** Start a session locally, then continue it from any browser or the Claude mobile iOS/Android app. `claude --teleport` pushes a local session to the cloud.
- **How WE'd use it:** Start a long refactor on a dev machine, `claude --teleport` it, and monitor/redirect from mobile while away from the desk.

---

### Managed Agents (Platform) — Anthropic-hosted agent harness

- **What it is:** `platform.claude.com/docs/en/managed-agents` — Anthropic hosts the agent loop in a managed cloud sandbox or a self-hosted sandbox on your infra. Accessible via SDK, `ant` CLI, or REST API.
- **How WE'd use it:** Offload sandboxed code execution for our AI-generated SQL migrations (Supabase) — Anthropic handles the runtime, we call via API and get results back, no Workers compute consumed.

---

### Workflow `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` — v2.1.296

- **What it is:** Env var that forces all agents in a workflow to run on one specified model, overriding per-agent selection.
- **How WE'd use it:** Set `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL=claude-haiku-5-5` in CI/routine environments to run large fan-out workflows cheaply, and override it only for critical security-review workflows.

---

### MCP Protocol Version 2026-07-28 Default — v2.1.292

- **What it is:** Local stdio MCP servers now default to protocol version `2026-07-28`; Claude.ai connectors also negotiate it by default (v2.1.295).
- **How WE'd use it:** If we ship any internal MCP servers (e.g., a Supabase MCP tool for the clinic), test against protocol `2026-07-28`; older server implementations may need an update.

---

### Built-in `gh api` for Cloud Sessions — v2.1.288

- **What it is:** Cloud sessions (routines) now have a built-in `gh api` REST tool available without needing the GitHub CLI installed.
- **How WE'd use it:** Routines that do PR review, issue triage, or release notes generation can call the GitHub API directly without any extra setup.

---

### Auto Mode Default — v2.1.284

- **What it is:** Interactive and VS Code sessions now start in auto mode by default on every plan. Auto mode uses a server-side classifier to decide when tool calls need human approval.
- **How WE'd use it:** Reduce friction in daily dev sessions; fewer approval prompts for routine read/edit/run actions. Review per-project `CLAUDE.md` to ensure we haven't set overly restrictive manual-mode defaults.

---

_Last checked: 2026-10-12 | Next: run this routine to detect additions since this date_
