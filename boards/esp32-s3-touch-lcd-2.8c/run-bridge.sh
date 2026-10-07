#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
exec ./tools/venv/bin/python -u agent_bridge.py "$@"
