#!/bin/bash
cd "$(dirname "$0")"
echo "Avvio Help Desk Console su http://127.0.0.1:8765 ..."
open "http://127.0.0.1:8765" 2>/dev/null || true
python3 server.py
