# Claude Code / Anthropic Feature Watch State

> Maintained by the `claude/feature-watch` scheduled routine.
> Stack context: TanStack Start + Cloudflare Workers + Supabase · med-spa SaaS.
> Last updated: **2026-08-31**

---

## Known Features (first scan — 2026-08-31)

All items below were captured during the initial run. Future runs will only add items not already listed here.

---

### Models

#### Claude Opus 5 · Week 30 (Jul 20–24, 2026)
- **What it is:** New flagship Opus model with a 1 M-token context window. Fast mode at $10/$50 per MTok. Default Opus model in Claude Code.
- **How WE'd use it:** Switch our scheduled routines and `/ultrareview` runs to Opus 5 for deeper analysis of the full Supabase schema + Cloudflare Worker bundle in one context. Fast mode makes it cost-competitive for nightly CI jobs.
- **Supersedes:** Manual chunking of large codebase reviews because context no longer overflows.

#### Claude Sonnet 5 · Week 27 (Jun 29 – Jul 3, 2026)
- **What it is:** New default model for Pro/Team/Enterprise; 1 M-token context, adaptive thinking on by default, top-tier coding and tool use at Sonnet pricing.
- **How WE'd use it:** Default for day-to-day feature work — full repo fits in one context so no `-p` chunking tricks needed. Adaptive thinking helps with complex TanStack routing edge cases.
- **Supersedes:** Sonnet 4.6 as the team's everyday driver.

#### Claude Opus 4.8 · Week 22 (May 25–29, 2026)
- **What it is:** High effort on by default; `/effort xhigh` unlocks maximum reasoning for hardest tasks. Default for Max/Team Premium/Enterprise PAYG.
- **How WE'd use it:** Use `xhigh` effort for complex Supabase RLS policy rewrites or Worker security audits before release.
- **Supersedes:** Manual prompt engineering to get deeper reasoning.

#### Claude Opus 4.7 · Week 16 (Apr 13–17, 2026)
- **What it is:** Introduced `xhigh` effort level and interactive `/effort` slider. Was default for Max/Team Premium.
- **How WE'd use it:** Historical — superseded by Opus 4.8 and Opus 5.

---

### Permission & Safety

#### Auto Mode · Week 13 (Mar 23–27, 2026)
- **What it is:** Research-preview → GA classifier that handles permission prompts automatically. Safe actions run without interruption; risky ones are blocked. Middle ground between manual approval and `--dangerously-skip-permissions`. Now default for Pro/Max/Team starting Aug 14.
- **How WE'd use it:** Enable in CI GitHub Actions runs so the agent can iterate on Worker builds and Supabase migrations without waiting for human approvals on file edits, while still blocking `rm -rf` and force-push.
- **Supersedes:** Per-run `--dangerously-skip-permissions` hacks and hand-curated allow-lists.

#### Auto Mode on Bedrock/Vertex/Foundry · Week 23 (Jun 1–5, 2026)
- **What it is:** Auto mode now works on third-party providers (Opus 4.7+).
- **How WE'd use it:** If we ever route through Bedrock for compliance, auto mode still applies — no separate approval flow needed.

#### Auto Mode Blocks Destructive Git · Week 25 (Jun 15–19, 2026)
- **What it is:** Auto mode now intercepts `git reset --hard` / `git clean` etc. when you didn't explicitly ask to discard local work.
- **How WE'd use it:** Safer unattended overnight runs — the agent won't nuke local changes during a rebase conflict resolution.

#### `--restricted` Mode · v2.1.248 (Aug 27, 2026)
- **What it is:** New CLI flag that locks down what the agent can do, beyond auto mode.
- **How WE'd use it:** Use in read-only analysis routines (dependency audits, cost-report generation) where no file writes should happen.

#### Sandbox Credential Masking · v2.1.224 (Aug 7, 2026)
- **What it is:** Bash sandbox now masks extracted credentials, JWTs, and AWS SigV4 signatures from tool outputs.
- **How WE'd use it:** Safer to run agents against production Supabase URLs in CI without worrying about leaking service-role keys into transcripts.

---

### Parallel Agents & Orchestration

#### Dynamic Workflows · Week 22 (May 25–29, 2026)
- **What it is:** The `Workflow` tool lets Claude write a JS script that fans out dozens–hundreds of subagents in parallel, with typed schemas and pipeline/parallel/phase primitives.
- **How WE'd use it:** Orchestrate parallel review of every Cloudflare Worker route + every Supabase Edge Function simultaneously; collect structured findings; deduplicate. Replaces manually spawning subagents one by one.
- **Supersedes:** Ad-hoc multi-agent prompting without coordination.

#### Agent View (`claude agents`) · Week 20 (May 11–15, 2026)
- **What it is:** One terminal screen showing every Claude Code session — running, blocked, done — with colored state and AI-written headline per agent.
- **How WE'd use it:** Monitor parallel feature-branch agents (e.g., one per patient-flow screen) from a single pane instead of tabbing between terminals.

#### Fork Mode Default · Week 33 (Aug 10–14, 2026)
- **What it is:** Subagent forking is now on by default in interactive sessions — Claude can hand a side task to a background subagent that inherits the full conversation, then keep the main session going.
- **How WE'd use it:** Let Claude fork off a "run tests" subagent while the main session continues planning the next feature. Zero manual orchestration.

#### Cross-Session Messaging · Week 32 (Aug 3–7, 2026)
- **What it is:** Claude Code sessions on macOS/Linux can send messages to each other (`SendMessage`/`ListAgents`). A finding or decision passes between sessions without re-explaining context.
- **How WE'd use it:** A nightly audit agent can push findings to a daytime feature-dev session, so the developer's next morning session already knows about the Supabase index recommendation.

#### `@` Session Mentions · v2.1.232 (Aug 13, 2026)
- **What it is:** Type `@session-name` in the prompt to mention (and message) another live Claude session by name.
- **How WE'd use it:** From the main dev session, ping a background migration-runner session mid-conversation without switching windows.

#### Subagents Spawn Subagents (5 levels deep) · Week 24 (Jun 8–12, 2026)
- **What it is:** Sub-agents can now spawn their own sub-agents, capped at 5 levels.
- **How WE'd use it:** Top-level review agent → per-feature agents → per-file agents for granular parallel analysis of the entire TanStack Start route tree.

---

### Scheduling & Automation

#### Routines · Week 16 (Apr 13–17, 2026)
- **What it is:** Cloud-hosted scheduled agents that fire from a cron schedule, GitHub event, or API call — keep running even when the dev machine is off.
- **How WE'd use it:** Morning PR review routine; nightly Supabase migration drift check; weekly Cloudflare Workers usage cost report. This very feature-watch script is an example.
- **Supersedes:** Manually running scripts or GitHub Actions for recurring analysis.

#### Desktop Scheduled Tasks · existing, now documented
- **What it is:** Local machine scheduled Claude tasks (separate from cloud Routines).
- **How WE'd use it:** Local dev tasks that need file system access (e.g., regenerating local fixtures from prod snapshots).

#### `/loop` Self-Pacing · Week 15 (Apr 6–10, 2026)
- **What it is:** Omit the interval from `/loop` and Claude paces itself based on what it's waiting for.
- **How WE'd use it:** Use `/loop` without an interval when polling a long Cloudflare deployment instead of hard-coding a sleep.

#### `/goal` · Week 20 (May 11–15, 2026)
- **What it is:** Keeps Claude working across turns until a declarative completion condition holds.
- **How WE'd use it:** `/goal "all Playwright tests pass"` — Claude iterates fixes autonomously without manual re-prompting.
- **Supersedes:** Manual "try again" loops.

---

### Code Review & Quality

#### `/ultrareview` (Cloud Review Fleet) · Week 17 (Apr 20–24, 2026)
- **What it is:** A fleet of bug-hunting subagents runs in the cloud; findings land back in CLI/Desktop automatically. GA as `claude ultrareview` in Week 18.
- **How WE'd use it:** Run before every major release to catch security issues in Cloudflare Worker auth logic and Supabase RLS policies that single-agent review would miss.
- **Supersedes:** Manual code review checklists.

#### `/code-review` Command · Week 21 (May 18–22, 2026)
- **What it is:** Built-in slash command that reports correctness bugs; runs as a background subagent.
- **How WE'd use it:** Drop into CLAUDE.md as a pre-PR gate: `claude -p "/code-review"` in CI.

#### Claude Security Plugin · Week 30 (Jul 20–24, 2026)
- **What it is:** Multi-agent vulnerability scan of the codebase; findings you pick get turned into patches you apply.
- **How WE'd use it:** Run quarterly on the Cloudflare Worker + Supabase Edge Function layer. Especially valuable for our HIPAA-adjacent patient data flows.
- **Supersedes:** Manual security review PRs.

#### `/design` (Research Preview) · Week 34 (Aug 17–21, 2026)
- **What it is:** Brings Claude Design's artboard workflow into CLI/Desktop — Claude drafts editable artboards; you pick one and it implements it.
- **How WE'd use it:** Prototype new med-spa booking UI screens before writing TanStack Start route components. Cuts the design→implementation loop.

---

### Developer Ergonomics

#### Computer Use in CLI · Week 14 (Mar 30 – Apr 3, 2026)
- **What it is:** Claude can open native apps, click through UI, verify changes from the terminal.
- **How WE'd use it:** Let Claude verify a booking form works end-to-end in a real browser, not just unit tests — especially useful for Cloudflare Pages previews.

#### iOS Simulator Pane (Desktop) · Week 30 (Jul 20–24, 2026)
- **What it is:** Claude Code Desktop opens an iOS Simulator pane; Claude runs the app and taps through it while you watch.
- **How WE'd use it:** If we ever ship a native companion app, Claude can run through the appointment-booking flow automatically.

#### Claude in Chrome (GA) · Week 27 (Jun 29 – Jul 3, 2026)
- **What it is:** Chrome extension with Claude Code integration is now generally available on all direct Anthropic plans.
- **How WE'd use it:** Debug live Cloudflare Pages previews — Claude reads the DOM and console errors in context.

#### In-App Browser on Desktop · Week 28 (Jul 6–10, 2026)
- **What it is:** Built-in browser in Claude Code Desktop; Claude can pull up docs and interact with pages the same as local dev servers.
- **How WE'd use it:** Claude can open Supabase docs or Stripe API docs while implementing a feature, without the developer copy-pasting.

#### `/cd` Mid-Session Directory Change · Week 24 (Jun 8–12, 2026)
- **What it is:** Move the session to a new working directory without rebuilding the prompt cache.
- **How WE'd use it:** In a monorepo, switch between `apps/web` and `packages/api` mid-conversation without starting a new session.

#### `/fork` · Week 29 (Jul 13–17, 2026)
- **What it is:** Copies the current conversation into a new background session while the main session continues.
- **How WE'd use it:** Fork off a "run E2E tests" session mid-feature-build without losing the current context.

#### Shell Mode Responds to Command Output · Week 26 (Jun 22–26, 2026)
- **What it is:** `! npm test` runs the command and Claude explains the output without a second prompt.
- **How WE'd use it:** Run `! wrangler deploy --dry-run` and Claude immediately explains any warnings.

#### `/rewind` Resumes Past `/clear` · Week 26 (Jun 22–26, 2026)
- **What it is:** `/rewind` can now resume a conversation from before `/clear` was run.
- **How WE'd use it:** Recover context after accidentally clearing a long debugging session.

#### Concise Output Style · v2.1.237 (Aug 20, 2026)
- **What it is:** Built-in "Concise" output style makes Claude lead with the result and skip preamble.
- **How WE'd use it:** Set as default in CI runs where output goes to logs — cleaner signal-to-noise.

#### `ANTHROPIC_DEFAULT_MODEL` Env Var · v2.1.236 (Aug 19, 2026)
- **What it is:** Sets the model new sessions start on via environment variable.
- **How WE'd use it:** Pin `claude-sonnet-5` in `.env.local` so all devs default to the same model without manual `/model` commands.

#### `modelPicker` + `promptCacheTtl` Settings · v2.1.243 (Aug 25, 2026)
- **What it is:** `modelPicker` controls which models appear in the `/model` menu; `promptCacheTtl` configures prompt-cache TTL.
- **How WE'd use it:** Lock the model picker to approved models in our CLAUDE.md managed settings. Set longer TTL for the large shared system prompt in Routines.

#### `fallbackModel` · Week 24 (Jun 8–12, 2026)
- **What it is:** Configure up to three fallback models tried in order if the primary is unavailable.
- **How WE'd use it:** Set `sonnet-5 → opus-5 → sonnet-4.6` fallback chain in CI so a model outage doesn't stall deployments.

#### `--safe-mode` · Week 24 (Jun 8–12, 2026)
- **What it is:** Starts Claude Code with all customizations disabled for troubleshooting.
- **How WE'd use it:** First step when diagnosing a broken CLAUDE.md or misbehaving hook.

#### Windows Without Git Bash · Week 18 (Apr 27 – May 1, 2026)
- **What it is:** Claude Code uses PowerShell as the shell tool when Bash is absent.
- **How WE'd use it:** Windows team members no longer need Git Bash installed — lower onboarding friction.

#### Claude Desktop on Linux (Beta) · Week 27 (Jun 29 – Jul 3, 2026)
- **What it is:** Desktop app now in beta on Ubuntu/Debian.
- **How WE'd use it:** Linux developers on the team get the visual diff review and multi-session management of Desktop.

---

### Artifacts

#### Artifacts (Beta) · Week 25 (Jun 15–19, 2026)
- **What it is:** Turn a session's output into a live, shareable page on claude.ai that updates in place as the session works. Team/Enterprise beta.
- **How WE'd use it:** Publish nightly dependency audit reports as Artifacts shared with the team lead — always shows the latest run, no Slack attachment archaeology.
- **Supersedes:** Copy-pasting Claude output into Notion or Slack.

#### Artifacts Call MCP Connectors · Week 29 (Jul 13–17, 2026)
- **What it is:** A published artifact can pull live data through each viewer's own MCP connectors when they open the page. Also adds public sharing links and editor roles.
- **How WE'd use it:** A "refill status" dashboard artifact that each viewer sees populated with their own Supabase data via MCP, without us building a separate dashboard page.

---

### MCP & Integrations

#### `claude mcp login` · Week 26 (Jun 22–26, 2026)
- **What it is:** Authenticate a configured MCP server from the shell (`claude mcp login`) and clear credentials with `claude mcp logout`.
- **How WE'd use it:** Script MCP auth in our CI onboarding so engineers don't have to navigate the interactive `/mcp` menu on first run.

#### MCP `headersHelper` for Marketplace Auth · v2.1.238 (Aug 20, 2026)
- **What it is:** MCP servers in the marketplace can declare a `headersHelper` for authentication.
- **How WE'd use it:** When we publish an internal MCP server for our Supabase schema, auth tokens are handled cleanly without custom wrapper scripts.

#### GitLab Support · Week 33 (Aug 10–14, 2026)
- **What it is:** GitLab MR URLs work with `--worktree`, `claude agents` view, and marketplaces clone bare `gitlab.com` URLs.
- **How WE'd use it:** If any part of our infrastructure lives on GitLab (e.g., customer's self-hosted), we can run the same agent workflows there.

#### Plugin System Enhancements · Weeks 18–19 (Apr–May 2026)
- **What it is:** Plugins load from `.zip` archives and URLs (`--plugin-url`); `archive` source type; marketplace support.
- **How WE'd use it:** Package our internal review checklist as a plugin zip distributed via a private URL — no marketplace publishing needed.

#### Channels for Event Pushing · existing, newly documented
- **What it is:** Push events from Telegram, Discord, iMessage, or custom webhooks into a Claude session.
- **How WE'd use it:** Patient appointment cancellations from our webhook could trigger a Claude session to draft a re-engagement message or flag for staff review.

#### Slack Integration · existing
- **What it is:** Mention `@Claude` in Slack with a bug report, get a PR back.
- **How WE'd use it:** Staff Slack channel — ops team reports a booking bug, Claude investigates and opens a draft PR without dev team involvement.

---

### Self-Hosted & Enterprise

#### Self-Hosted Environments (Public Beta) · Week 32 (Aug 3–7, 2026)
- **What it is:** Run Claude Code cloud sessions on your own infrastructure. Team/Enterprise plans. Managed via `claude self-hosted-runner`.
- **How WE'd use it:** If HIPAA requirements mandate data residency, run cloud sessions inside our own VPC so patient context never leaves our infrastructure.
- **Supersedes:** Blocking cloud agent use due to compliance concerns.

#### Self-Hosted Runner Client Labels · v2.1.248 (Aug 27, 2026)
- **What it is:** Label self-hosted runner clients for routing and identification.
- **How WE'd use it:** Label runners by environment (`prod-vpc`, `staging-vpc`) so Routines target the right one.

#### Server-Managed Settings · v2.1.248 (Aug 27, 2026) / v2.1.243
- **What it is:** Org-level settings pushed from the server; diagnostics for debugging merge conflicts.
- **How WE'd use it:** Enforce `modelPricing` and allowed-model lists across all developer machines from one managed config, rather than relying on each person's local settings.

---

### Hooks & Scripting

#### PreModelSwitch / PostModelSwitch Hooks · v2.1.251 (Aug 28, 2026)
- **What it is:** New hook events that fire before and after Claude switches models during a session.
- **How WE'd use it:** Log model switches in CI for cost attribution; block unapproved model switches in regulated environments.

#### Server-Supplied Hook Support · v2.1.229 (Aug 12, 2026)
- **What it is:** Hooks can be supplied by the server (managed settings), not just local config.
- **How WE'd use it:** Push a mandatory cost-logging hook to all developer machines via managed settings — no per-developer config required.

#### Conditional `if` Hooks · Week 13 (Mar 23–27, 2026)
- **What it is:** Hook rules can include `if` conditions.
- **How WE'd use it:** Only trigger the Supabase migration linter hook when files under `supabase/migrations/` are edited.

#### Hooks See Effort Level · Week 19 (May 4–8, 2026)
- **What it is:** Hooks receive `effort.level` and `$CLAUDE_EFFORT` env var.
- **How WE'd use it:** Route `xhigh`-effort runs to a separate cost-alert webhook so finance is notified when expensive reasoning runs happen.

---

### Miscellaneous / UI

#### Remote Control · existing, GA
- **What it is:** Continue a local session from phone or another device. Device cards appear on the Code tab on mobile.
- **How WE'd use it:** Start a long Worker refactor on Desktop, step away, monitor and steer from iPhone.

#### Mobile Push Notifications · Week 16 (Apr 13–17, 2026)
- **What it is:** Phone notification when a long task finishes or Claude needs approval.
- **How WE'd use it:** Overnight Routine completion alerts so we know in the morning if the nightly audit surfaced issues.

#### `/usage` Breakdown · Week 21 (May 18–22, 2026)
- **What it is:** Shows what's driving plan limits broken down by skill, subagent, plugin, MCP server; v2.1.243 adds Loops breakdown.
- **How WE'd use it:** Identify if a runaway Routine is eating our token budget.

#### `SendFeedback` Tool · v2.1.247 (Aug 26, 2026)
- **What it is:** New tool that lets Claude send feedback to Anthropic directly from a session.
- **How WE'd use it:** When Claude hits an unexpected edge case in our Worker setup, it can file feedback without us writing a report.

#### Ultraplan (Early Preview) · Week 15 (Apr 6–10, 2026)
- **What it is:** Draft a plan in the cloud from CLI, review/comment in a web editor, run it remotely or pull back local.
- **How WE'd use it:** Plan a major Supabase schema migration collaboratively — dev writes the prompt, PM reviews the plan before Claude executes.

#### `/doctor` Setup Checkup · Week 28 (Jul 6–10, 2026)
- **What it is:** Full setup diagnostic that finds and can fix config issues. Alias: `/checkup`.
- **How WE'd use it:** First thing new team members run after installing Claude Code — surfaces MCP config issues, auth problems, etc.

#### Screen Reader Mode · Week 29 (Jul 13–17, 2026)
- **What it is:** Replaces visual terminal interface with plain linear text for VoiceOver/NVDA.
- **How WE'd use it:** Accessibility — any team member using a screen reader gets full Claude Code access.

#### Spend Limit Bar · v2.1.251 (Aug 28, 2026)
- **What it is:** Visual spend limit indicator in the UI.
- **How WE'd use it:** Developers see at a glance how much of the session budget is used — prevents surprise overages.

#### Per-Session Prompt-Cache Metrics · v2.1.251 (Aug 28, 2026)
- **What it is:** Prompt cache hit/miss stats per session.
- **How WE'd use it:** Tune our CLAUDE.md structure to maximize cache hits across Routine runs — directly lowers cost.

---

## Changelog — Version Snapshots

| Version | Date | Key Changes |
|---------|------|-------------|
| 2.1.251 | 2026-08-28 | PreModelSwitch/PostModelSwitch hooks, live subagent streaming, spend limit bar, per-session cache metrics, multiple security fixes |
| 2.1.248 | 2026-08-27 | `--restricted` mode, `experimental.cacheTtl`, self-hosted runner labels, cross-session messaging on Bedrock/Vertex/Foundry |
| 2.1.247 | 2026-08-26 | `SendFeedback` tool, customizable spinner tips, `/claude-api cost-optimize`, auto mode permissions tab |
| 2.1.243 | 2026-08-25 | Loops breakdown in `/usage`, `modelPicker`, `promptCacheTtl`, `modelPricing` managed setting, keyless Console sign-in |
| 2.1.239 | 2026-08-21 | Cost estimates with US-only-inference premium, `/claude-api upgrade`, synced plugins from claude.ai |
| 2.1.238 | 2026-08-20 | `keybindingFlavor` readline mode, MCP `headersHelper`, prompt cache for LLM gateways, Concise output style |
| 2.1.236 | 2026-08-19 | `ANTHROPIC_DEFAULT_MODEL` env var, `notify_when_idle` cross-session messaging |
| 2.1.234 | 2026-08-17 | `CLAUDE_CODE_PROJECT_DIR_NAME` env var, GitLab MR badge, auto-continue at usage limit |
| 2.1.233 | 2026-08-14 | GitLab MR support for `--worktree`, `forward_user_identity` gateway setting |
| 2.1.232 | 2026-08-13 | Subagent fork default, `@` session mentions, GitLab marketplace support |
| 2.1.229 | 2026-08-12 | Server-supplied hook support, SSE keepalive, plugin marketplace `command` sources |
| 2.1.224 | 2026-08-07 | Self-hosted runner environments, `crossSessionInbound`/`dialogExpiry` settings, sandbox credential masking |
