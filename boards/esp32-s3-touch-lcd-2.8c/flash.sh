#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
port="${1:-/dev/cu.usbmodem5B910686821}"
./tools/venv/bin/esptool --chip esp32s3 --port "$port" --baud 115200 \
  write-flash --flash-size 16MB \
  0x0 build/BoardDemo.ino.bootloader.bin \
  0x8000 build/BoardDemo.ino.partitions.bin \
  0xe000 "$HOME/Library/Arduino15/packages/esp32/hardware/esp32/3.0.2/tools/partitions/boot_app0.bin" \
  0x10000 build/BoardDemo.ino.bin
