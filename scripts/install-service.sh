#!/bin/sh
# Keeps Golem running on a Mac: a launchd job that runs `bun start` in this checkout and restarts it if it stops.
# Logs go to data/golem.log.
#
#   scripts/install-service.sh            LaunchAgent for the current user. Runs while the user has a session,
#                                         also without a desktop login (for example over SSH).
#   sudo scripts/install-service.sh --daemon
#                                         LaunchDaemon that runs as the invoking user from boot, with nobody logged in.
set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
LABEL="dev.golem.server"

if [ "${1:-}" = "--daemon" ]; then
	RUN_AS="${SUDO_USER:?Run the daemon install with sudo}"
	PLIST="/Library/LaunchDaemons/$LABEL.plist"
	DOMAIN="system"
	USER_KEY="<key>UserName</key><string>$RUN_AS</string>"
	# A daemon must not compete with a per-user copy for the port.
	launchctl bootout "gui/$(id -u "$RUN_AS")/$LABEL" 2>/dev/null || true
	launchctl bootout "user/$(id -u "$RUN_AS")/$LABEL" 2>/dev/null || true
else
	PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
	DOMAIN="gui/$(id -u)"
	launchctl print "$DOMAIN" >/dev/null 2>&1 || DOMAIN="user/$(id -u)"
	USER_KEY=""
fi

mkdir -p "$ROOT/data" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	$USER_KEY
	<key>ProgramArguments</key><array><string>$BUN</string><string>run</string><string>start</string></array>
	<key>WorkingDirectory</key><string>$ROOT</string>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$BUN"):/usr/bin:/bin</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$ROOT/data/golem.log</string>
	<key>StandardErrorPath</key><string>$ROOT/data/golem.log</string>
</dict>
</plist>
EOF
[ -n "$USER_KEY" ] && chown "$RUN_AS" "$ROOT/data"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Golem runs as $DOMAIN/$LABEL. Restart: launchctl kickstart -k $DOMAIN/$LABEL"
