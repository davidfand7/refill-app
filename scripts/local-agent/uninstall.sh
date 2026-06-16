#!/bin/bash
#
# SmartSpa local delivery agent — uninstaller. Stops the heartbeat and removes
# the launchd job + pinger. The agent row + secret on the server are untouched
# (reinstall any time with the same secret).

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.smartspa.localagent.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/.smartspa"
echo "SmartSpa local agent removed. Connection Health will show it go Silent, then you can hide it from the app."
