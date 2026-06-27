#!/bin/bash
#
# SmartSpa local delivery agent — uninstaller. Stops BOTH jobs (heartbeat + the
# outbound iMessage sender) and removes their launchd jobs + scripts. The agent
# row + secret on the server are untouched (reinstall any time with the same secret).

set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.smartspa.localagent.plist"
SENDER_PLIST="$HOME/Library/LaunchAgents/com.smartspa.sender.plist"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl unload "$SENDER_PLIST" 2>/dev/null || true
rm -f "$PLIST" "$SENDER_PLIST"
rm -rf "$HOME/.smartspa"
echo "SmartSpa local agent removed (heartbeat + sender). Connection Health will show it go Silent, then you can hide it from the app."
