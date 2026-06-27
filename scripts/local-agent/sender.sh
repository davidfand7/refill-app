#!/bin/bash
#
# SmartSpa local delivery agent — OUTBOUND iMessage sender (queue consumer).
#
# The zero-setup sender (Build 2, Path B). Runs on the spa's own Mac alongside the
# heartbeat pinger. Every ~60s it claims any texts SmartSpa has queued for this spa
# and sends each via Messages.app — from the spa's own number, no Gmail, no Claude
# Desktop routine, no MCP. SmartSpa queues; this sends; this acks the outcome.
#
# Auth + identity: the SAME per-spa secret the heartbeat uses (x-agent-secret).
# Send gate: SmartSpa only hands out items when the spa's auto_send is ON, and this
# script double-checks `autoSend` before sending (belt-and-suspenders — nothing
# goes out unless auto-send is explicitly enabled).
#
# Permission note: the FIRST send triggers a macOS Automation prompt
# (System Settings → Privacy & Security → Automation → allow controlling Messages).
# Until granted, sends fail and are acked as failed with that reason.
#
# __BASE__ and __SECRET__ are filled in by the installer (install.sh /
# the app's one-paste command). Don't run this template directly.

BASE="__BASE__"
SECRET="__SECRET__"

# 1) Claim up to 5 queued texts for this spa. -fsS: quiet, but fail on HTTP error.
RESP=$(curl -fsS -m 20 -X POST "$BASE/api/agent/queue/claim" \
  -H "x-agent-secret: $SECRET" -H "Content-Type: application/json" \
  -d '{"limit":5}' 2>/dev/null) || exit 0
[ -z "$RESP" ] && exit 0

# 2) Flatten the claimed items to TSV via JXA (osascript ships on every Mac, parses
#    JSON natively). Emits NOTHING unless autoSend===true. Each line:
#    id <TAB> recipient <TAB> claimToken <TAB> body (tabs→spaces, newlines→\n,
#    backslashes escaped) — so one item is exactly one safe line.
LINES=$(/usr/bin/osascript -l JavaScript -e 'function run(a){var d;try{d=JSON.parse(a[0])}catch(e){return ""}if(d.autoSend!==true)return "";return (d.items||[]).map(function(it){var b=String(it.body).replace(/\\/g,"\\\\").replace(/\t/g," ").replace(/\r?\n/g,"\\n");return [it.id,it.recipient,d.claimToken,b].join("\t")}).join("\n")}' "$RESP" 2>/dev/null) || exit 0
[ -z "$LINES" ] && exit 0

# 3) Send each via Messages.app, then ack the outcome.
OLDIFS="$IFS"
IFS=$'\n'
for line in $LINES; do
  ID=$(printf '%s' "$line" | cut -f1)
  PHONE=$(printf '%s' "$line" | cut -f2)
  TOKEN=$(printf '%s' "$line" | cut -f3)
  BODY=$(printf '%b' "$(printf '%s' "$line" | cut -f4-)")  # %b un-escapes \n and \\

  STATUS="sent"
  ERR=""
  if /usr/bin/osascript - "$PHONE" "$BODY" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  set targetPhone to item 1 of argv
  set targetMessage to item 2 of argv
  tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetParticipant to participant targetPhone of targetService
    send targetMessage to targetParticipant
  end tell
end run
APPLESCRIPT
  then
    STATUS="sent"
  else
    STATUS="failed"
    ERR="Messages send failed (grant Automation permission for Messages, or check the number)"
  fi

  # Ack — the claimToken proves this lease is ours; SmartSpa 409s a stale/foreign
  # ack. id/token are UUIDs and ERR is a fixed string, so this JSON is always safe.
  curl -fsS -m 20 -X POST "$BASE/api/agent/queue/ack" \
    -H "x-agent-secret: $SECRET" -H "Content-Type: application/json" \
    -d "{\"id\":\"$ID\",\"claimToken\":\"$TOKEN\",\"status\":\"$STATUS\",\"error\":\"$ERR\"}" \
    >/dev/null 2>&1 || true
done
IFS="$OLDIFS"
