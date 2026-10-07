#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! cmp -s demo/BoardDemo/lv_conf.h vendor/Arduino/libraries/lvgl/src/lv_conf.h; then
  cp demo/BoardDemo/lv_conf.h vendor/Arduino/libraries/lvgl/src/lv_conf.h
fi
./tools/arduino-cli compile \
  --fqbn 'esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=default' \
  --libraries "$PWD/vendor/Arduino/libraries" \
  --output-dir "$PWD/build" "$PWD/demo/BoardDemo"
