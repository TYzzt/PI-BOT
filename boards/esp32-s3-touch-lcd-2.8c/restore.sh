#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
backup="backups/original-20261002.bin"
if [ "$(wc -c < "$backup" | tr -d ' ')" != 16777216 ]; then
  echo 'Backup must be a complete 16MB image.' >&2
  exit 1
fi
./tools/venv/bin/esptool --chip esp32s3 \
  --port "${1:-/dev/cu.usbmodem5B910686821}" --baud 115200 \
  write-flash 0x0 "$backup"
