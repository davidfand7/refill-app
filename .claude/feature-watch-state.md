# Claude Code / Agent SDK / API Feature Watch

Last updated: 2026-09-21
Stack context: TanStack Start + Cloudflare Workers + Supabase (med-spa SaaS)

---

## Feature Entries

### 2026-09-21 — Initial snapshot

---

#### 1. Routines (Cloud-Scheduled Tasks)
- **What it is:** Cloud-hosted recurring automation. A Routine is a saved Claude Code configuration (prompt + repos + connectors) that runs on Anthropic infrastructure on a schedule, via API webhook, or triggered by GitHub events — even when your laptop is off. Available on Pro/Max/Team/Enterprise. Still in research preview.
- **How we'd use it:**
  - **Nightly dependency audit:** scan `package.json` across the monorepo, open a draft PR listing outdated or vulnerable packages.
  - **Post-deploy smoke check:** wire our Cloudflare deploy pipeline to the Routine's API trigger endpoint. On each production push, Claude pulls recent error logs from our Supabase edge functions and posts a go/no-go Slack message.
  - **Stale issue triage:** GitHub event trigger on PRs opened to `main`; routine applies labels and assigns reviewers based on changed file paths.
  - **This very feature-watch task** runs as a Routine (already configured in this session).
- **Supersedes manual work:** replaces ad-hoc cron scripts in CI for scheduled repo hygiene, post-deploy checks, and issue triage.
- **Ref:** `code.claude.com/docs/en/routines`

---

#### 2. GitHub Code Review (Automated PR Review Service)
- **What it is:** A managed multi-agent service (Team/Enterprise) that automatically posts inline PR review comments on logic errors, security vulnerabilities, and regressions. Uses a fleet of specialized agents with a verification step to reduce false positives. Severity markers: 🔴 Important, 🟡 Nit, 🟣 Pre-existing. Costs ~$15–25 per review, billed via usage credits. In research preview.
- **How we'd use it:**
  - Enable on `davidfand7/refill-app` with "After every push" trigger so every PR gets reviewed.
  - Add a `REVIEW.md` to calibrate: mark Cloudflare Worker edge-case failures as Important, cap nit volume to 5/review, skip `src/gen/` and lockfiles.
  - Gate merges on `bughunter-severity` from the check run in our GitHub Actions workflow.
  - Use `@claude review` on high-priority PRs in branches not set to auto-review.
- **Supersedes manual work:** replaces the ad-hoc `/code-review` slash command usage we do today; no need to remember to run it.
- **Ref:** `code.claude.com/docs/en/code-review`

---

#### 3. Channels (Bidirectional Event Push into Sessions)
- **What it is:** MCP-based plugin system that pushes external events (Telegram, Discord, iMessage, or custom webhooks) into a running Claude Code session. Claude can read the event and reply back through the same channel. Currently in research preview; requires `--channels` flag and Bun.
- **How we'd use it:**
  - Install the Telegram plugin, run `claude --channels plugin:telegram@claude-plugins-official` in a persistent tmux session on our dev machine. Text the bot from our phones to check deploy status, run quick queries against Supabase, or kick off a task without opening the laptop.
  - Build a custom webhook receiver channel to forward Sentry alerts into an open session — Claude already has our codebase loaded and can correlate the stack trace with recent commits.
- **Supersedes manual work:** replaces manually teleporting back to the terminal for quick queries; replaces separate alerting scripts.
- **Ref:** `code.claude.com/docs/en/channels`

---

#### 4. Agent SDK (Python + TypeScript Library)
- **What it is:** A Python and TypeScript library that gives you the same tools, agent loop, and context management that power Claude Code, without implementing the tool loop yourself. Supports built-in tools (Read/Write/Edit/Bash/WebSearch), hooks, subagents, MCP, permissions, sessions (resume/fork), skills, plugins, and persistent memory. Distinct from the Client SDK (no self-managed tool loop) and Managed Agents (self-hosted vs. Anthropic-hosted).
- **How we'd use it:**
  - Build a TanStack Start server function or Cloudflare Worker that accepts a natural-language task, spins up an Agent SDK session with read-only access to our Supabase schema, and returns a structured answer (e.g., "find all appointments for patient X this week").
  - Automate our nightly report generation: TypeScript agent reads Supabase analytics tables, writes a formatted HTML report to R2, and emails it via our existing transactional email service.
  - Create a `code-gen` agent with tool access scoped only to our component library directory, used in CI to auto-generate boilerplate for new med-spa service types.
- **Supersedes manual work:** replaces hand-rolled Claude API + tool-loop code we'd otherwise write from scratch.
- **Ref:** `code.claude.com/docs/en/agent-sdk/overview`

---

#### 5. Managed Agents (Anthropic-Hosted Agent REST API)
- **What it is:** A separate REST API product where Anthropic runs the agent and manages the sandbox/session infrastructure. Intended for long-running or async agents without managing your own infrastructure. Distinct from the Agent SDK (self-hosted). No direct CLI dependency.
- **How we'd use it:**
  - Offload patient-intake document analysis tasks to Managed Agents — upload a PDF intake form, get back structured JSON for Supabase insert — without standing up our own Worker to run the Agent SDK.
  - Any long-running agentic task (e.g., scanning 3 months of appointment logs for anomalies) that shouldn't block a Cloudflare Worker's 30s CPU limit.
- **Supersedes manual work:** replaces need to host our own persistent VM or Durable Object for long-running agent tasks.
- **Ref:** `platform.claude.com/docs/en/managed-agents/overview`

---

#### 6. Skills System (Shareable Workflow Packages)
- **What it is:** Custom `.claude/skills/<name>/SKILL.md` files that package repeatable Claude Code workflows. Support dynamic shell-command injection (`!` blocks), argument passing (`$ARGUMENTS`, `$0...$N`), forked subagent execution (`context: fork`), path-specific loading, model/effort overrides, tool pre-approval, and syncing from claude.ai. Can be committed to the repo to share with the team.
- **How we'd use it:**
  - `/deploy-check`: runs pre-deploy checklist (lint, type-check, migration status) before any Cloudflare deploy. Add `disable-model-invocation: true` to prevent accidental auto-trigger.
  - `/add-service <name>`: scaffolds a new med-spa service type with Supabase migration stub, Worker handler, and TanStack route component.
  - `/supabase-migrate`: checks for pending Supabase migrations, generates a diff, and asks for approval before pushing.
  - `/pr-summary`: generates a PR description from `!git diff main` — we commit this skill to the repo so all team members get it.
- **Supersedes manual work:** replaces shell scripts in `scripts/` and ad-hoc prompts we type repeatedly. Skills sync to all surfaces automatically.
- **Ref:** `code.claude.com/docs/en/skills`

---

#### 7. Subagents / Agent Tool (Parallel + Isolated Execution)
- **What it is:** Spawn specialized agents from within a Claude Code session that run in isolated context windows with custom tool restrictions, models, permissions, and persistent memory. Supports foreground/background execution, nested subagents (up to 3 layers, 20 concurrent), and session resumption via `SendMessage`. Define custom agents in `.claude/agents/` YAML files.
- **How we'd use it:**
  - Define an `Explore` agent scoped to read-only tools for codebase research without polluting the main session.
  - Create a `supabase-analyst` agent with only read access to our DB schema files — Claude can delegate "find all tables that reference appointments" without risking writes.
  - Parallelise large refactors: a lead agent spawns one subagent per module directory, each refactoring independently, then merges results.
  - Use `isolation: worktree` for experimental changes — subagent gets a throwaway git worktree so experiments don't dirty the working tree.
- **Supersedes manual work:** replaces spinning up multiple terminal sessions for parallel tasks; replaces `--dangerously-skip-permissions` workarounds for isolated research tasks.
- **Ref:** `code.claude.com/docs/en/sub-agents`

---

#### 8. AGENTS.md Support (Alternative to CLAUDE.md)
- **What it is:** Added in v2.1.277. Claude Code now reads `AGENTS.md` as an alternative (or supplement) to `CLAUDE.md`, for compatibility with other coding agents (Codex, etc.) that use that filename convention.
- **How we'd use it:**
  - If we ever adopt a secondary agent tool that reads `AGENTS.md`, we can maintain a single shared instructions file instead of duplicating it.
  - Useful if any open-source contributors send PRs that include `AGENTS.md` from their own toolchain — Claude Code will respect it automatically.
- **Supersedes:** Nothing critical for our current workflow, but prevents instruction duplication if we adopt multi-agent tooling.
- **Ref:** Changelog v2.1.277

---

#### 9. Plugin System (Package Skills + Agents + Hooks + MCP Servers)
- **What it is:** Plugins bundle skills, agent definitions, hooks, and MCP servers into a distributable package loadable by local path or from a marketplace. Install with `/plugin install <name>@<marketplace>`. Supports `/plugin eval` for running scored eval suites (v2.1.269+). Skill/plugin syncing from claude.ai account (opt-out: `syncClaudeAiSkills: false`).
- **How we'd use it:**
  - Create an internal `refill-app-plugin` that packages our deployment skills, MCP server definitions (Supabase, Cloudflare), and review hooks in one installable artifact — new team members get everything with one install command.
  - Use `claude plugin eval` in CI to score the plugin's skills against a fixed test suite, catching skill regressions before merge.
- **Supersedes manual work:** replaces the need to document and manually install multiple `.claude/` directory files for new devs.
- **Ref:** `code.claude.com/docs/en/agent-sdk/plugins`, Changelog v2.1.269

---

#### 10. Claude Apps Gateway (Self-Hosted API Proxy)
- **What it is:** An optional self-hosted gateway that sits between Claude Code and Anthropic's API. Supports hint headers (`x-claude-code-request-class`, `x-claude-code-agent-type` — opt-in with `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`), egress boundary support, per-upstream `headers:` map, and Postgres connection pooling config (`store.connect_timeout_seconds`). Added pricing/managed settings sync in v2.1.268.
- **How we'd use it:**
  - Route all Claude Code API calls through our own gateway for audit logging, cost attribution per developer, and rate limiting.
  - Use hint headers to route expensive `ultra` review requests to a higher-tier upstream while keeping regular sessions on a cheaper path.
  - Useful if we ever need to comply with data residency requirements (route EU sessions through an EU-located gateway).
- **Supersedes manual work:** replaces ad-hoc `ANTHROPIC_BASE_URL` overrides; centralises API governance.
- **Ref:** Changelog v2.1.268/273/274

---

#### 11. Remote Control + Teleport + Desktop Handoff
- **What it is:** Three related mobility features:
  - **Remote Control**: drive a local terminal session from claude.ai or the Claude mobile app; includes session forking from Remote Control sessions (v2.1.273).
  - **`claude --teleport`**: pull a running cloud/web session into your local terminal.
  - **`/desktop`**: hand off a terminal session to the Desktop app for visual diff review.
- **How we'd use it:**
  - Start a long refactor on the web, then `--teleport` it into the terminal when back at the desk.
  - Use Remote Control to approve/deny permission prompts from a phone when a Routine or background agent needs human input.
  - `/desktop` to review large diffs visually before committing.
- **Supersedes manual work:** replaces manually copying session context between surfaces.
- **Ref:** `code.claude.com/docs/en/remote-control`

---

#### 12. New Models: Claude 5 Family (Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5)
- **What it is:** Latest Claude model generation available as of the session date. IDs: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Fast mode (Opus with faster output) toggleable with `/fast`.
- **How we'd use it:**
  - Use `claude-sonnet-5` (current session default) for general coding tasks and this scheduled routine.
  - Use `claude-haiku-4-5-20251001` in subagent definitions for cheap, fast read-only exploration tasks (reduces token cost for large codebase searches).
  - Use `claude-opus-5` or `claude-fable-5-1` for high-stakes one-off tasks (security review, architecture planning) via `/fast` or explicit model selection.
  - Set `model:` in skill frontmatter to lock specific tasks to specific models.
- **Supersedes:** Previous Claude 3.x/4.x model references in any skill frontmatter or SDK calls.
- **Ref:** Session system prompt model IDs; `code.claude.com/docs/en/` model config

---

#### 13. /code-review ultra (UltraReview Cloud)
- **What it is:** `/code-review ultra` escalates to a deeper cloud-based review (UltraReview). Runs on Anthropic infrastructure against the full repo, posts findings as PR comments from your GitHub account. `--fix` applies findings to working tree. Results include collapsible extended reasoning. Available via `claude ultrareview` subcommand for non-interactive/CI use.
- **How we'd use it:**
  - Before any major feature merge to `main`, run `claude ultrareview` in CI to get a deeper analysis than the standard local `/code-review`.
  - Use `--post` to automatically post findings as inline PR comments without a separate step.
  - Run `claude -p '/code-review ultra'` in GitHub Actions for scheduled deep reviews on release branches.
- **Supersedes:** Manual deep code reviews; the old `/simplify` command (now `/code-review --fix` for bug-finding).
- **Ref:** `code.claude.com/docs/en/code-review#escalate-to-ultrareview`

---

#### 14. Auto Memory (Cross-Session Learning)
- **What it is:** Claude automatically builds a persistent memory file (`~/.claude/memory/`) as it works, saving learnings across sessions without any manual `CLAUDE.md` updates. Separate from explicit CLAUDE.md instructions.
- **How we'd use it:**
  - Let Claude learn our Cloudflare Workers conventions, Supabase table naming patterns, and preferred error handling style automatically over time.
  - Review the auto-memory file periodically and promote useful entries into explicit `CLAUDE.md` rules.
- **Supersedes manual work:** reduces the burden of manually maintaining `CLAUDE.md` for every discovered convention.
- **Ref:** `code.claude.com/docs/en/memory#auto-memory`

---

#### 15. VSCode Agent Map + Hooks/Permissions Dialogs (v2.1.271)
- **What it is:** The VS Code extension now shows an agent map — a visual tree of subagents running in the current session, with per-agent cards and Stop buttons. Also added: Hooks dialog and Permission rules dialog for managing settings from the IDE. Added in v2.1.271.
- **How we'd use it:**
  - Monitor parallel subagent progress during large refactors directly in VS Code without switching to the terminal.
  - Configure hooks and permission rules from the IDE GUI instead of editing JSON config files by hand.
- **Supersedes:** Manual terminal monitoring and direct JSON editing of settings.
- **Ref:** Changelog v2.1.271

---

#### 16. `claude plugin eval` (Skill Eval Suites, v2.1.269)
- **What it is:** New CLI subcommand that runs scored eval suites against plugin skills. Produces JSON + HTML reports. Can be used in CI to catch skill regressions.
- **How we'd use it:**
  - Write eval fixtures for our `/deploy-check` and `/add-service` skills. Run `claude plugin eval` in GitHub Actions on skill changes to confirm they still produce correct outputs.
- **Supersedes manual work:** replaces subjective manual testing of skills.
- **Ref:** Changelog v2.1.269

---

#### 17. Send-Now Key (ctrl+enter) for Interrupt + Queue (v2.1.275)
- **What it is:** New keyboard shortcut `ctrl+enter` that interrupts the current Claude Code turn and immediately sends a queued message without waiting for the current response to finish.
- **How we'd use it:**
  - Interrupt a long-running task mid-flight when we spot an error in Claude's approach, without waiting for it to finish.
- **Ref:** Changelog v2.1.275

---

#### 18. Gateway Hint Headers for Request Classification (v2.1.273)
- **What it is:** Opt-in feature (`CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`) that adds `x-claude-code-request-class`, `x-claude-code-agent-type`, and related headers to gateway requests, enabling downstream routing/logging by request type.
- **How we'd use it:**
  - In our gateway, route agent-type=`subagent` requests to a cheaper model upstream, while `primary` requests go to full Sonnet/Opus. Enables cost optimization without changing Claude Code config.
- **Ref:** Changelog v2.1.273

---

#### 19. Auto Mode Server-Side Classifier (v2.1.278)
- **What it is:** For Claude API and Enterprise users, auto mode now defaults to a server-side classifier (instead of a client-side one), eliminating classifier overhead charges. Visible in `/status` as "Auto mode server" row.
- **How we'd use it:**
  - If we're on Enterprise and using auto mode, this is a cost reduction with no action required. Verify via `/status`.
- **Ref:** Changelog v2.1.278

---

## Tracking Metadata

| Date       | Items Added | Source |
|------------|-------------|--------|
| 2026-09-21 | 19 (initial snapshot) | code.claude.com/docs, changelog |
