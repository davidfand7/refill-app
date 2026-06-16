# SmartSpa local delivery agent (heartbeat)

The no-show rescue loop is fully autonomous **up to the proxy email**. The final
hop — relaying that email to the patient as a text — happens on the spa owner's
Mac (Claude Desktop + the iMessage MCP). SmartSpa had **zero signal** on that
leg: if the Mac sleeps, Claude Desktop is closed, or Messages quits, rescues
silently stop relaying and nothing reports it.

This is the fix: a **presence heartbeat**. A tiny pinger on the relay Mac POSTs
to `/api/agent/heartbeat` every 5 minutes with the spa's secret and what it can
verify (is Messages running). Connection Health ages the last check-in into a
**Live / Quiet / Silent** verdict (the `presence` tier). Because a heartbeat
fires on a fixed cadence regardless of workload, **silence is unambiguous** — it
means the relay is offline, and we can flag it honestly.

## Setup (per spa)

1. In the app: **Settings → Connection health → Local delivery agent → Set up
   the local agent.** This mints the per-spa secret and shows a one-paste
   installer (secret already embedded).
2. On the relay Mac (the one with Messages signed in), open **Terminal**, paste
   the command, press **Return**.
3. The "Local delivery agent" card turns **Live** within a few minutes.

### From a checkout (alternative)

```bash
bash scripts/local-agent/install.sh <AGENT_SECRET> [ENDPOINT]
```

- `AGENT_SECRET` — from Settings → Connection health.
- `ENDPOINT` — optional; defaults to `https://getrefill.app/api/agent/heartbeat`.

## What gets installed

- `~/.smartspa/pinger.sh` — the heartbeat script.
- `~/Library/LaunchAgents/com.smartspa.localagent.plist` — a launchd job that
  runs the pinger every 300s and at login (survives restarts).

## Verdict thresholds (`presence` tier)

| State | Last check-in | Meaning |
|-------|---------------|---------|
| **Live** (healthy) | ≤ 30 min | Online and standing by; texts can relay. |
| **Quiet** (stale) | 30 min – 4 h | Mac may be asleep / Claude Desktop closed. |
| **Silent** (broken) | > 4 h | Relay offline; rescue texts can't go out. |

A check-in that reports `messages_app: false` flags as **broken** even while
fresh — the Mac is awake but can't relay until Messages is open.

## Uninstall

```bash
bash scripts/local-agent/uninstall.sh
```

Removes the launchd job + pinger. The server-side secret is left intact, so
reinstalling later reuses it (no rotation, no app change needed).

## Security

The secret is a 48-hex bearer token scoped to one spa; it only lets a caller
*report a heartbeat* (stamp `last_seen_at` / capabilities) — it grants no read
access to patient data. Treat it like a password. Rotating it (future) would
require re-running the installer with the new value.
