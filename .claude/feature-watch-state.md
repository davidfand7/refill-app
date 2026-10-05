# Claude Code / Claude API Feature Watch

Tracks features, models, and tooling changes for the Claude Code ecosystem.
Stack: **TanStack Start + Cloudflare Workers + Supabase** (med-spa SaaS).

---

## Snapshot: 2026-10-05

> First run — all items below are newly recorded. Source: code.claude.com/docs + changelog (up to v2.1.289, Oct 3 2026).

---

### Models

#### Claude Sonnet 5.5 — `claude-sonnet-5-5`
- **What**: New default Sonnet model with 1M token context window. Pricing: $2 input / $10 output per Mtok, $0.20/Mtok cache reads. Ships as default in Claude Code v2.1.284 (Sept 28 2026).
- **How we'd use it**: Switch `claude-sonnet-5-5` as the model ID in any Agent SDK calls or API clients in our Cloudflare Workers. The 1M context window means we can pass our entire schema + multi-file diffs in one shot without chunking.
- **Supersedes**: Manual chunking of large Supabase schema context when calling the Claude API.

#### Claude Fable 5.1 — `claude-fable-5-1`
- **What**: New model added as default in Week 36 (Aug 31 2026). Fast output mode variant.
- **How we'd use it**: Evaluate for latency-sensitive paths (e.g., real-time chat in the med-spa booking flow) where Fable's speed advantage may outweigh capability gap.
- **Supersedes**: Nothing directly — adds a new speed tier.

#### Claude Opus 5.5 — `claude-opus-5-5`
- **What**: Flagship Opus model with 1M context. Previously Opus 5 became the default model in Week 30 (July 20 2026).
- **How we'd use it**: Complex multi-step agentic tasks — e.g., end-to-end "generate + review + deploy" pipelines. Reserve for scheduled overnight jobs (dependency audits, security scans) where cost is acceptable.
- **Supersedes**: Using Sonnet for jobs that benefit from stronger reasoning.

---

### Agentic Orchestration

#### Dynamic Workflows
- **What**: Orchestrate dozens of subagents deterministically via a JavaScript `Workflow` script. Phases, parallel/pipeline helpers, structured schemas, resume. Available from Week 22 (May 25 2026); stable for production.
- **How we'd use it**: Fan out parallel code-review, lint, and type-check agents across changed packages on PRs. A lead agent merges results and posts a single summary comment. Replace our sequential CI steps with a parallel fan-out that completes 3–5× faster.
- **Supersedes**: Sequential bash CI scripts that run lint → typecheck → tests one at a time.

#### Agent View (multi-session dashboard)
- **What**: Single screen showing all running Claude Code sessions with live status, filtering (`n:<text>`), and controls. Launched Week 20 (May 11 2026), filters added v2.1.287.
- **How we'd use it**: During sprint work, launch parallel sessions for frontend (TanStack routes), backend (Worker routes), and DB migrations simultaneously — monitor all from Agent View without terminal juggling.
- **Supersedes**: Multiple terminal tabs with no unified status.

#### Session-to-Session Messaging
- **What**: A running agent can send messages to another named agent in the same session, enabling coordination without a shared memory file. Week 32 (Aug 3 2026).
- **How we'd use it**: `scheduler-agent` posts to `db-migration-agent` when schema prep finishes, so the migration only starts when safe. Currently we coordinate via files or manual sequencing.
- **Supersedes**: Polling a shared temp file to coordinate agent handoffs.

#### Subagents Run in Background by Default
- **What**: Sub-agents spawned via the `Agent` tool now run in the background; the parent continues without blocking. Week 27 (June 29 2026).
- **How we'd use it**: Our PR-review workflow agent can fire off parallel sub-agents for security scan, coverage check, and style review without waiting for each to finish in sequence.
- **Supersedes**: Sequential subagent calls that blocked the parent turn.

#### Nested Subagents
- **What**: Agents can spawn their own sub-agents (multi-level hierarchy). Week 24 (June 8 2026).
- **How we'd use it**: A top-level "release" agent spawns a "changelog" agent which itself spawns per-package summary agents, then rolls up to a single release note PR.

#### Worktrees (git-isolated parallel sessions)
- **What**: Each subagent can work in an isolated git worktree, preventing conflicts when multiple agents edit the codebase simultaneously.
- **How we'd use it**: Run feature-branch experiments in parallel (e.g., two approaches to the booking calendar) and let Claude diff+recommend without touching main.
- **Supersedes**: Manually creating git worktrees before launching parallel sessions.

---

### Scheduling & Automation

#### Routines (cloud-hosted scheduled tasks)
- **What**: Cron-style tasks that run in the cloud even when your laptop is off. Trigger on a schedule, API call, or GitHub event. Create via `/schedule`, Desktop app, or web.
- **How we'd use it**: This very feature-watch task is an example. Also: nightly Supabase schema drift check, weekly `npm audit` with auto-PR, morning summary of overnight error logs from our Cloudflare Workers.
- **Supersedes**: GitHub Actions cron jobs for Claude-powered checks (Routines are lower overhead to set up).

#### Desktop Scheduled Tasks
- **What**: Machine-local cron tasks with access to local files and tools. Sister to cloud Routines.
- **How we'd use it**: Devs run a local nightly task that syncs Supabase types to the local codebase and commits if anything drifted.

#### `/loop` Command
- **What**: Repeats a prompt within a CLI session on a self-paced or fixed interval for quick polling tasks.
- **How we'd use it**: `/loop 5m /code-review` to keep reviewing as PRs stack up during a sprint, or watch a deploy in progress.

---

### Developer Experience Commands & Tools

#### `/code-review` Command
- **What**: Built-in slash command for reviewing a diff or PR at configurable effort levels (low/medium/high/max). Can post inline PR comments (`--comment`) or auto-fix (`--fix`). Week 21 (May 18 2026).
- **How we'd use it**: Run `/code-review --comment` automatically on every PR via a GitHub Actions Routine. Catches correctness bugs and style issues before human review.
- **Supersedes**: Manual inline review annotations and ad-hoc "review this diff" prompts.

#### `/goal` Command
- **What**: Set a persistent objective for a session; Claude tracks and self-evaluates progress toward it. Week 20 (May 11 2026).
- **How we'd use it**: `/goal all tests pass and no TS errors` before a refactor session — Claude self-checks after each change rather than waiting for us to ask.

#### `/cd` Command
- **What**: Move the current session's working directory without restarting. Week 24 (June 8 2026).
- **How we'd use it**: Start in the root, `/cd apps/web` to work on the TanStack frontend, then `/cd packages/db` for schema work — all in one session.

#### `/rewind` Command
- **What**: Resume a session at the state it was in before the last `/clear`. Week 26 (June 22 2026).
- **How we'd use it**: Accidentally cleared context mid-debugging session? `/rewind` restores without restarting.

#### `/doctor` Command & `prompt-audit` Sub-command
- **What**: Built-in setup health check. `prompt-audit` variant (v2.1.283) inspects prompt configuration for issues.
- **How we'd use it**: Add to onboarding runbook; run in CI to catch misconfigured MCP servers or CLAUDE.md issues on new developer machines.

#### Shell Mode (`!` prefix)
- **What**: Prefix a message with `!` to get a raw shell response rather than agentic loop — great for quick one-liners. Week 26 (June 22 2026).
- **How we'd use it**: `! git log --oneline -20` mid-session without triggering a full Claude turn.

#### `claude --teleport` / `claude --cloud`
- **What**: `--cloud` pushes a local terminal session to a cloud environment. `--teleport` pulls a cloud/web session into the local terminal.
- **How we'd use it**: Start a heavy refactor in the cloud while commuting, then `--teleport` it into a local terminal when back at desk for tool access.

#### `claude --desktop` Flag
- **What**: Handoff current terminal session to the Desktop app for visual diff review (v2.1.285).
- **How we'd use it**: After an agent makes many file edits, `claude --desktop` to visually review diffs before staging.

---

### Auto Mode & Permissions

#### Auto Mode as Default
- **What**: Auto mode (approve all actions automatically) is now the default permission mode. Week 32 (Aug 3 2026).
- **How we'd use it**: Faster unattended runs; we can focus on scoping with CLAUDE.md allow/deny rules rather than clicking through prompts.
- **Supersedes**: Manual approval of every file read/write in interactive sessions.

#### Auto Mode on Pro Plan + Sonnet 4.6 (then 5.x)
- **What**: Auto mode unlocked for Pro subscribers with Sonnet-tier models. Week 21 (May 18 2026).
- **How we'd use it**: All developers on Pro can run unattended agents for boilerplate generation, migration scaffolding, etc.

#### Sandboxed Bash Tool with File/Network Boundaries
- **What**: Bash tool can be sandboxed with explicit allow/deny file paths and network rules.
- **How we'd use it**: Lock agentic CI jobs to only touch `src/` and connect to Supabase — prevent accidental writes to `.env` or egress to unexpected hosts.

#### `allowedProviders` / `availableModelsMatch` / `deniedModels` Managed Settings
- **What**: Organization-wide managed settings to restrict which models and providers agents can use. v2.1.283–2.1.285.
- **How we'd use it**: In an org deployment, pin all CI agents to Sonnet 5.5 and block direct Opus use to control costs.

---

### MCP & Integrations

#### MCP Connectors for Live Artifact Data
- **What**: MCP servers can now supply live data to published Artifacts (interactive pages). Week 29 (July 13 2026).
- **How we'd use it**: Connect our Supabase MCP server to a Claude Artifact dashboard showing real-time booking stats — no manual data export needed.

#### `claude mcp login` for Shell Authentication
- **What**: OAuth-style login for MCP servers directly from the shell. Week 26 (June 22 2026).
- **How we'd use it**: Authenticate our Supabase MCP server, GitHub MCP, and any future Cloudflare MCP servers without manually pasting tokens.

#### URL Prompts from MCP Servers
- **What**: MCP servers can supply a URL prompt that opens in a browser pane for OAuth/setup flows. v2.1.287.
- **How we'd use it**: Seamless first-time auth for third-party MCP integrations (Stripe, calendar providers) without leaving Claude Code.

#### Tool Parameter Matching in Rules
- **What**: Permission rules can now match on specific tool parameters (not just tool name). Week 25 (June 15 2026).
- **How we'd use it**: Allow `Bash` only when the command matches `npm test*` — finer-grained than blanket tool allow.

---

### AI-Powered Review & Security

#### GitHub Code Review (Automatic on PRs)
- **What**: Claude Code posts inline review comments on every PR automatically via GitHub App integration.
- **How we'd use it**: Enable in our `davidfand7/refill-app` repo for zero-config review coverage on all PRs.
- **Supersedes**: Manual `/code-review` invocations and ad-hoc review agents.

#### Claude Security Plugin
- **What**: Built-in plugin for vulnerability scanning. Week 30 (July 20 2026).
- **How we'd use it**: Run on every PR and as part of nightly Routine — catches OWASP-style issues in Cloudflare Worker request handling and Supabase RLS policies.

#### "You Should Know" Built-in Mod
- **What**: A built-in Claude Mod (v2.1.287) that watches sessions for missed issues (potential bugs, security gaps, overlooked edge cases) and surfaces them proactively.
- **How we'd use it**: Enable on all developer sessions — catches `CLINIC_OWNER_ID` row-level security gaps or unvalidated form inputs before they reach PR.
- **Supersedes**: Relying on developers to remember to ask "did I miss anything?"

---

### Claude Mods System
- **What**: Plugins can now inject deeper behavior into Claude Code sessions — custom panes, tool call rules, background watchers. "Mods" category added v2.1.287 (Oct 1 2026).
- **How we'd use it**: Build a med-spa-specific mod that watches for HIPAA-sensitive field names in code and flags them before commit.
- **Supersedes**: CLAUDE.md reminders and post-commit hooks for sensitive-data checks.

---

### Desktop App Features

#### Built-in Browser Pane
- **What**: Desktop app now has a built-in browser for live testing web apps. Week 28 (July 6 2026).
- **How we'd use it**: Run the TanStack Start dev server, then use Claude's built-in browser to test booking flows — Claude sees the page and can auto-fix UI issues end-to-end.

#### Background Computer Use
- **What**: Desktop app can run macOS GUI automation tasks in the background. Week 36 (Aug 31 2026).
- **How we'd use it**: Automate browser-based E2E test runs (Playwright recordings in the background) while continuing to code in the foreground.

#### iOS Simulator Pane
- **What**: Desktop app shows an iOS Simulator pane for testing mobile views. Week 30 (July 20 2026).
- **How we'd use it**: Test the med-spa booking UI on mobile screen sizes directly within Claude Desktop without switching apps.

#### Live `/diff` Panel
- **What**: Real-time diff panel that updates as Claude edits files. Week 36 (Aug 31 2026).
- **How we'd use it**: Watch multi-file refactors as they happen and intervene early if a change looks wrong — before the whole edit sequence completes.

#### Pop-out Pane Windows
- **What**: Desktop panes (diff, browser, iOS sim) can be popped out to separate windows. Week 37 (Sept 7 2026).
- **How we'd use it**: Put the diff pane on a second monitor while coding — no context switching.

#### Terminal Session Resumption in Desktop
- **What**: Desktop app can resume a terminal session without restarting the agent. Week 35 (Aug 24 2026).
- **How we'd use it**: Resume a long refactor session after a laptop sleep without losing tool state.

---

### Other Surfaces

#### Claude in Chrome (GA)
- **What**: Chrome extension is generally available for live web app debugging. Week 27 (June 29 2026).
- **How we'd use it**: Debug the TanStack Start prod app in Chrome — Claude sees the DOM, console errors, network requests and suggests fixes inline.

#### Channels (External Event Push)
- **What**: Push events from Telegram, Discord, iMessage, or custom webhooks into a running Claude session.
- **How we'd use it**: Pipe Cloudflare Workers error alerts (via webhook) directly into a Claude session that auto-diagnoses and opens a fix PR.

#### Artifacts (Live Shareable Pages)
- **What**: Claude can publish interactive HTML pages to claude.ai with runtime capabilities (live data, shared state, file upload). Week 25 (June 15 2026).
- **How we'd use it**: Generate live admin dashboards showing Supabase booking metrics — share a URL with the clinic owner without building a custom admin panel.

#### Slack Integration (`@Claude` mention)
- **What**: Mention `@Claude` in Slack with a bug report; Claude opens a pull request.
- **How we'd use it**: Clinic staff can report booking system bugs in Slack and get fix PRs without developer involvement in triage.

#### `/design` Skill for UI Artboards
- **What**: Built-in `/design` skill generates UI artboards and visual prototypes. Week 34 (Aug 17 2026).
- **How we'd use it**: Prototype new booking calendar or patient intake form UI before writing code — get stakeholder buy-in faster.

---

### Agent SDK (Python & TypeScript)

#### Agent SDK v3+
- **What**: Production-ready SDK for building custom agents powered by Claude Code's tools. Supports streaming, structured outputs (JSON Schema / Zod / Pydantic), custom MCP tools, session persistence, multi-tenant isolation, and OpenTelemetry observability.
- **How we'd use it**: Build a `BookingAgent` in our Cloudflare Worker that uses structured outputs (Zod) to validate LLM responses before writing to Supabase. Session persistence means multi-turn booking conversations survive Worker cold starts.
- **Supersedes**: Raw Anthropic Messages API calls with manual tool-use loops.

#### Structured Outputs in SDK
- **What**: SDK supports JSON Schema, Zod (TypeScript), and Pydantic (Python) schemas for validated LLM responses.
- **How we'd use it**: Every agent response that touches Supabase goes through a Zod schema — no more `as any` casts or runtime type errors from LLM output.

#### External Session Storage / Multi-tenant Isolation
- **What**: SDK supports storing session state externally (e.g., Supabase) and isolating sessions per tenant.
- **How we'd use it**: Each med-spa clinic gets an isolated Claude agent session stored in Supabase. Session history is per-clinic, not shared.

#### OpenTelemetry Observability in SDK
- **What**: SDK emits OTEL traces for all agent operations.
- **How we'd use it**: Route traces to Cloudflare's analytics or a self-hosted Grafana to monitor agent latency and error rates per clinic.

---

## Changelog Reference

| Version | Date | Key Item |
|---------|------|----------|
| 2.1.289 | Oct 3 2026 | Bug fixes: deny/ask rules, symlink reads, sandbox auto-allow |
| 2.1.288 | Oct 2 2026 | `$.ui.selection()` for mods, Ctrl+F session search |
| 2.1.287 | Oct 1 2026 | **Claude Mods** launch, "You should know" built-in mod |
| 2.1.286 | Sep 30 2026 | Permission prompt counts, mouse support fullscreen |
| 2.1.285 | Sep 29 2026 | `claude --desktop` flag, `allowedProviders` managed setting |
| 2.1.284 | Sep 28 2026 | **Claude Sonnet 5.5** default, Ultracode toggle, spend limits in USD |
| 2.1.283 | Sep 25 2026 | `x-claude-code-prompt-id` headers, `availableModelsMatch`, `/doctor prompt-audit` |
| 2.1.282 | Sep 24 2026 | `maxProseWidth` setting |
| Week 37 | Sep 7–11 | `claude plugin eval`, Desktop pane pop-outs |
| Week 36 | Aug 31–Sep 4 | Fable 5.1, background computer use, live `/diff` panel |
| Week 35 | Aug 24–28 | Terminal session resumption, restricted mode |
| Week 34 | Aug 17–21 | `/design` skill, Concise output style |
| Week 33 | Aug 10–14 | Desktop auto-continue, GitLab MRs + marketplaces |
| Week 32 | Aug 3–7 | Session messaging, self-hosted envs, auto mode default |
| Week 30 | Jul 20–24 | Opus 5 default, iOS Simulator pane, Security plugin |
| Week 29 | Jul 13–17 | MCP connectors for Artifacts, screen reader mode |
| Week 28 | Jul 6–10 | Built-in browser Desktop, `/doctor`, auto mode transcript protections |
| Week 27 | Jun 29–Jul 3 | Sonnet 5 default, Chrome GA, background subagents, Desktop Linux beta |
| Week 26 | Jun 22–26 | `claude mcp login`, shell mode `!`, `/rewind` |
| Week 25 | Jun 15–19 | Artifacts, tool parameter rules, `/config` |
| Week 24 | Jun 8–12 | `/cd`, nested subagents, safe mode |
| Week 23 | Jun 1–5 | Auto mode on Bedrock/GCP/Azure, `/team-onboarding` |
| Week 22 | May 25–29 | Dynamic Workflows, Security-guidance plugin |
| Week 21 | May 18–22 | Auto mode Pro + Sonnet 4.6, `/usage`, `/code-review` |
| Week 20 | May 11–15 | Agent View, `/goal`, Fast mode Opus 4.7 |

---

_Last updated: 2026-10-05 by feature-watch routine_
