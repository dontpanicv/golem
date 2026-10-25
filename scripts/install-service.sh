#!/bin/sh
# Keeps Golem running on a Mac: installs a LaunchAgent that runs `bun start` in this checkout,
# starts it at login, and restarts it if it stops. Logs go to data/golem.log.
set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUN="$(command -v bun)"
LABEL="dev.golem.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$BUN</string><string>run</string><string>start</string></array>
	<key>WorkingDirectory</key><string>$ROOT</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$ROOT/data/golem.log</string>
	<key>StandardErrorPath</key><string>$ROOT/data/golem.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Golem runs as $LABEL. Restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
