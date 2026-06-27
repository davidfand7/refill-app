# SmartSpa local delivery agent (heartbeat + sender)

The no-show rescue loop is fully autonomous **up to the proxy email**. The final
hop — relaying that email to the patient as a text — happens on the spa owner's
Mac. The local agent owns that hop, in two parts that share one per-spa secret:

1. **Heartbeat** (`pinger.sh`, every 5 min) — POSTs `/api/agent/heartbeat` so
   Connection Health knows the relay Mac is online (the `presence` tier).
2. **Sender** (`sender.sh`, every 60 s) — the **zero-setup sender** (Build 2,
   Path B). Claims any texts SmartSpa has queued (`/api/agent/queue/claim`),
   sends each via **Messages.app** from the spa's own number, then acks the
   outcome (`/api/agent/queue/ack`). **No Gmail, no Claude Desktop routine, no
   MCP** — it deletes every link in the old drafting chain.

Because the heartbeat fires on a fixed cadence regardless of workload, **silence
is unambiguous** — it means the relay is offline, and we flag it honestly.

> **Send gate.** The sender only sends when the spa's **`auto_send`** is ON —
> enforced server-side (claim returns nothing when it's off) *and* re-checked in
> `sender.sh`. With `auto_send` off, the email-draft lane (`delivery_mode='email'`)
> stays the human-tap path. Nothing auto-sends unless explicitly enabled.

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
- `ENDPOINT` — optional; defaults to `https://smartspa.app/api/agent/heartbeat`.
  The API origin for the sender is derived from it.

## What gets installed

- `~/.smartspa/pinger.sh` — the heartbeat script.
- `~/.smartspa/sender.sh` — the outbound iMessage queue consumer.
- `~/Library/LaunchAgents/com.smartspa.localagent.plist` — launchd job running
  the pinger every 300 s (and at login).
- `~/Library/LaunchAgents/com.smartspa.sender.plist` — launchd job running the
  sender every 60 s (and at login).

> **First-send permission.** The first time the sender drives Messages.app, macOS
> prompts for **Automation** permission (System Settings → Privacy & Security →
> Automation → allow Messages). Until granted, sends fail and are acked as failed
> with that reason — visible, never silent.

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

Removes both launchd jobs + scripts. The server-side secret is left intact, so
reinstalling later reuses it (no rotation, no app change needed).

## Security

The secret is a 48-hex bearer token scoped to one spa. It lets a caller *report a
heartbeat* (stamp `last_seen_at` / capabilities) and *work that spa's outbound
queue* — claim the texts SmartSpa has already composed for that spa and ack them.
It grants **no read access to patient data** and can't compose new messages (only
SmartSpa enqueues). Treat it like a password; rotating it re-runs the installer
with the new value (the old secret dies immediately).
