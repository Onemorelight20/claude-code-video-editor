#!/bin/sh
# Start the editor UI and open it in the browser.  Stop with Ctrl+C.
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-8765}"
(sleep 1 && open "http://127.0.0.1:$PORT") &
exec python3 tools/server.py --port "$PORT"
