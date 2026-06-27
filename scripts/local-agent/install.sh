#!/bin/bash
#
# SmartSpa local delivery agent — installer.
#
# Sets up TWO tiny jobs on the spa's Mac, both keyed by the same per-spa secret:
#   1. a HEARTBEAT (every 5 min) so Connection Health knows the relay is online; and
#   2. an outbound iMessage SENDER (every 60s) that claims any texts SmartSpa has
#      queued and sends them via Messages.app — the zero-setup sender (Build 2, B).
# Both run at login (survive restarts). Idempotent: re-running re-installs cleanly.
#
# This is the committed source of truth for the one-paste installer the app's
# Connection Health page generates (with the secret embedded). To run it from a
# checkout instead:
#
#   bash scripts/local-agent/install.sh <AGENT_SECRET> [ENDPOINT]
#
# AGENT_SECRET — the per-spa secret from Settings → Connection health.
# ENDPOINT     — override the heartbeat URL (default: https://smartspa.app/api/agent/heartbeat).

set -euo pipefail

SECRET="${1:-}"
ENDPOINT="${2:-https://smartspa.app/api/agent/heartbeat}"
# The API origin both jobs talk to — derived from ENDPOINT by stripping the
# heartbeat path (so a custom ENDPOINT carries the sender to the same host).
BASE="${ENDPOINT%/api/agent/heartbeat}"

if [ -z "$SECRET" ]; then
  echo "Usage: bash install.sh <AGENT_SECRET> [ENDPOINT]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.smartspa"

# The pinger: reports liveness + whether Messages.app is running (so a Mac that's
# awake but with Messages quit still flags honestly). The single-quoted heredoc
# keeps $ENDPOINT/$SECRET/$MSG as literals expanded at RUN time, not install time
# — except we inject the two values by writing them on their own lines below.
cat > "$HOME/.smartspa/pinger.sh" <<PINGER
#!/bin/bash
# SmartSpa local delivery agent — heartbeat pinger
ENDPOINT="$ENDPOINT"
SECRET="$SECRET"
MSG=false; pgrep -x Messages >/dev/null 2>&1 && MSG=true
curl -fsS -m 15 -X POST "\$ENDPOINT" \\
  -H "x-agent-secret: \$SECRET" -H "Content-Type: application/json" \\
  -d "{\"version\":\"pinger-1.0\",\"status\":\"ok\",\"capabilities\":{\"messages_app\":\$MSG}}" >/dev/null 2>&1
PINGER
chmod +x "$HOME/.smartspa/pinger.sh"

# The launchd job. Unquoted heredoc so $HOME expands to the real path now.
PLIST="$HOME/Library/LaunchAgents/com.smartspa.localagent.plist"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.smartspa.localagent</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.smartspa/pinger.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Fire one immediate check-in so the page goes Live right away.
bash "$HOME/.smartspa/pinger.sh"

# ── The outbound iMessage sender (queue consumer) ──
# Fill the sibling sender.sh template's placeholders and install it + a launchd job
# that runs it every 60s. sed with | delimiter avoids clashing with the URL's /.
sed "s|__BASE__|$BASE|g; s|__SECRET__|$SECRET|g" "$SCRIPT_DIR/sender.sh" \
  > "$HOME/.smartspa/sender.sh"
chmod +x "$HOME/.smartspa/sender.sh"

SENDER_PLIST="$HOME/Library/LaunchAgents/com.smartspa.sender.plist"
cat > "$SENDER_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.smartspa.sender</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$HOME/.smartspa/sender.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLISTEOF

launchctl unload "$SENDER_PLIST" 2>/dev/null || true
launchctl load "$SENDER_PLIST"

echo "SmartSpa local agent installed: heartbeat + outbound iMessage sender are live."
echo "Note: the first queued text triggers a macOS Automation prompt — allow Messages so sends can go out."
