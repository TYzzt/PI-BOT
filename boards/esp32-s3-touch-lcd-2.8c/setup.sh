#!/bin/bash
# macOS Apple Silicon setup. Large downloaded dependencies stay outside Git.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p tools downloads vendor backups
python3 -m venv tools/venv
./tools/venv/bin/pip install 'esptool==5.4.0'
if [ ! -x tools/arduino-cli ]; then
  curl -fL --retry 2 https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_macOS_ARM64.tar.gz -o downloads/arduino-cli.tar.gz
  tar -xzf downloads/arduino-cli.tar.gz -C tools arduino-cli
fi
if [ ! -f vendor/Arduino/libraries/lvgl/library.properties ]; then
  curl -fL --retry 2 'https://files.waveshare.net/wiki/ESP32-S3-Touch-LCD-2.8C/ESP32-S3-Touch-LCD-2.8C-Demo.zip' -o downloads/vendor-demo.zip
  unzip -q -o downloads/vendor-demo.zip 'Arduino/*' 'Firmware/*' 'ReadMe.txt' -d vendor
fi
./tools/arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
python3 tools-download.py
./tools/arduino-cli core install esp32:esp32@3.0.2 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
