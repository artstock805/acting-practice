#!/bin/sh
# macOS / Linux: serve on localhost (mic needs http://localhost, not file://) and open the browser.
cd "$(dirname "$0")" || exit 1
PORT=8765
URL="http://localhost:$PORT/"
if command -v python3 >/dev/null 2>&1; then PY=python3; elif command -v python >/dev/null 2>&1; then PY=python; else
  echo "Python 3 is required here. Or just use the web version (see README)."; exit 1
fi
( sleep 1; if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL"; fi ) &
echo "Open $URL in Chrome or Edge. Press Ctrl+C to stop."
exec "$PY" -m http.server "$PORT" --bind 127.0.0.1
