#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
./tools/venv/bin/esptool --chip esp32s3 \
  --port "${1:-/dev/cu.usbmodem5B910686821}" --baud 115200 \
  write-flash 0x0 vendor/Firmware/ESP32-S3-Touch-LCD-2.8C.bin
