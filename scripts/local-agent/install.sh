#!/bin/bash
#
# SmartSpa local delivery agent — installer.
#
# Sets up a tiny heartbeat on the Mac that relays rescue texts over iMessage, so
# SmartSpa's Connection Health page can tell, live, whether that relay is online.
# Installs a launchd job that POSTs a check-in every 5 minutes and runs at login
# (survives restarts). Idempotent: re-running re-installs cleanly.
#
# This is the committed source of truth for the one-paste installer the app's
# Connection Health page generates (with the secret embedded). To run it from a
# checkout instead:
#
#   bash scripts/local-agent/install.sh <AGENT_SECRET> [ENDPOINT]
#
# AGENT_SECRET — the per-spa secret from Settings → Connection health.
# ENDPOINT     — override the heartbeat URL (default: https://getrefill.app/api/agent/heartbeat).

set -euo pipefail

SECRET="${1:-}"
ENDPOINT="${2:-https://getrefill.app/api/agent/heartbeat}"

if [ -z "$SECRET" ]; then
  echo "Usage: bash install.sh <AGENT_SECRET> [ENDPOINT]" >&2
  exit 1
fi

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
echo "SmartSpa local agent installed and checked in. Connection Health → Local delivery agent should read Live within a few minutes."
