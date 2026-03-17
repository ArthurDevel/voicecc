#!/usr/bin/env bash
#
# Start a Cloudflare quick tunnel and configure the Twilio phone number
# webhook to point at it, then start the voice pipeline server.
#
# Required env vars (from ~/.voicecc/.env or exported):
#   TWILIO_ACCOUNT_SID   - Twilio account SID
#   TWILIO_AUTH_TOKEN     - Twilio auth token
#   TWILIO_PHONE_NUMBER   - Twilio phone number (E.164, e.g. +15551234567)
#   ELEVENLABS_API_KEY    - ElevenLabs API key
#
# Usage:
#   ./dev-server-start.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Create venv and install dependencies if needed
if [[ ! -d "$SCRIPT_DIR/.venv" ]]; then
  echo "Creating virtual environment..."
  python3 -m venv "$SCRIPT_DIR/.venv"
fi
source "$SCRIPT_DIR/.venv/bin/activate"
pip install -q -r "$SCRIPT_DIR/requirements.txt"

# Load ~/.voicecc/.env if present (same as config.py)
VOICECC_DIR="${VOICECC_DIR:-$HOME/.voicecc}"
if [[ -f "$VOICECC_DIR/.env" ]]; then
  set -a
  source "$VOICECC_DIR/.env"
  set +a
fi

API_PORT="${API_PORT:-7861}"

# Type check — catch type errors before starting
echo "Running type check..."
cd "$SCRIPT_DIR"
if ! python3 -m pyright .; then
  echo "ERROR: Type check failed. Fix the errors above before starting." >&2
  exit 1
fi
echo "Type check passed."

# Validate required credentials
for var in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER ELEVENLABS_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is not set. Add it to ~/.voicecc/.env or export it." >&2
    exit 1
  fi
done

# Check dependencies
if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared is not installed. brew install cloudflared" >&2
  exit 1
fi

# Start cloudflared quick tunnel in background, capture the URL from its log
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --url "http://localhost:$API_PORT" 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

cleanup() {
  echo ""
  echo "Shutting down tunnel (PID $TUNNEL_PID)..."
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT

# Wait for the tunnel URL to appear in the log
echo "Starting Cloudflare quick tunnel on port $API_PORT..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9_-]+(-[a-zA-Z0-9_-]+)+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  if [[ -n "$TUNNEL_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$TUNNEL_URL" ]]; then
  echo "ERROR: Could not get tunnel URL after 30s. cloudflared log:" >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

echo "Tunnel URL: $TUNNEL_URL"

# URL-encode the phone number (+ → %2B)
ENCODED_PHONE=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$TWILIO_PHONE_NUMBER', safe=''))")

# Look up the phone number SID
PHONE_SID=$(curl -s -X GET \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers.json?PhoneNumber=$ENCODED_PHONE" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  | python3 -c "import sys,json; nums=json.load(sys.stdin).get('incoming_phone_numbers',[]); print(nums[0]['sid'] if nums else '')")

if [[ -z "$PHONE_SID" ]]; then
  echo "ERROR: Could not find phone number $TWILIO_PHONE_NUMBER in your Twilio account." >&2
  exit 1
fi

# Update the voice webhook URL
WEBHOOK_URL="$TUNNEL_URL/twilio/voice"
echo "Updating Twilio phone number $TWILIO_PHONE_NUMBER webhook to: $WEBHOOK_URL"

curl -s -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/IncomingPhoneNumbers/$PHONE_SID.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  --data-urlencode "VoiceUrl=$WEBHOOK_URL" \
  --data-urlencode "VoiceMethod=POST" \
  > /dev/null

echo "Twilio webhook configured."
echo ""
echo "=== Ready ==="
echo "  Tunnel:  $TUNNEL_URL"
echo "  Webhook: $WEBHOOK_URL"
echo "  API:     http://localhost:$API_PORT"
echo ""

# Start the voice server with TUNNEL_URL set
export TUNNEL_URL="$TUNNEL_URL"
cd "$SCRIPT_DIR"
exec python3 server.py
