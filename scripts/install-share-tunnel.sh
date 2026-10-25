#!/bin/sh
# Keeps Golem's public artifact host running on a Mac: a launchd job that runs a Cloudflare Tunnel with the token
# in config/share-tunnel.token, and restarts it if it stops. docs/artifacts-sharing.md shows how to create the tunnel.
# Logs go to data/logs/share-tunnel.log. It uses HTTP/2 on TCP 443, because networks often block QUIC on UDP 7844.
#
#   scripts/install-share-tunnel.sh       LaunchAgent for the current user, as scripts/install-service.sh makes.
set -eu

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CLOUDFLARED="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
TOKEN="$ROOT/config/share-tunnel.token"
LABEL="dev.golem.share"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
launchctl print "$DOMAIN" >/dev/null 2>&1 || DOMAIN="user/$(id -u)"

[ -x "$CLOUDFLARED" ] || { echo "Install cloudflared first: brew install cloudflared" >&2; exit 1; }
[ -s "$TOKEN" ] || { echo "Put the tunnel token in $TOKEN first" >&2; exit 1; }
chmod 600 "$TOKEN"

mkdir -p "$ROOT/data/logs" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>LimitLoadToSessionType</key><array><string>Aqua</string><string>Background</string></array>
	<key>ProgramArguments</key><array>
		<string>$CLOUDFLARED</string><string>tunnel</string><string>--no-autoupdate</string>
		<string>--protocol</string><string>http2</string>
		<string>run</string><string>--token-file</string><string>$TOKEN</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$ROOT/data/logs/share-tunnel.log</string>
	<key>StandardErrorPath</key><string>$ROOT/data/logs/share-tunnel.log</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "The share tunnel runs as $DOMAIN/$LABEL. Restart: launchctl kickstart -k $DOMAIN/$LABEL"
