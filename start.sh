#!/usr/bin/env bash
# (Re)starts the game server and a Cloudflare quick tunnel in the background.
# Prints the public HTTPS URL (also saved to public-url.txt).
set -e
cd "$(dirname "$0")"
PORT="${PORT:-3000}"
[ -d node_modules ] || npm install --silent
if [ ! -x bin/cloudflared ]; then
  mkdir -p bin
  curl -sL -o bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x bin/cloudflared
fi
pkill -f "node server.js" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1
PORT=$PORT nohup node server.js > server.log 2>&1 &
echo $! > server.pid
for i in $(seq 1 20); do curl -fs "http://localhost:$PORT/health" >/dev/null && break; sleep 0.5; done
nohup bin/cloudflared tunnel --no-autoupdate --protocol http2 --url "http://localhost:$PORT" > tunnel.log 2>&1 &
echo $! > tunnel.pid
URL=""
for i in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' tunnel.log | head -1 || true)
  [ -n "$URL" ] && break; sleep 1
done
if [ -z "$URL" ]; then echo "Tunnel URL not found; see tunnel.log"; exit 1; fi
echo "$URL" > public-url.txt
echo "Game is live at: $URL"
