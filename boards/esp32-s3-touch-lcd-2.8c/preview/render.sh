#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
clang++ -std=c++17 -DPET_PREVIEW -I preview/stubs -I demo/BoardDemo \
  preview/render.cpp demo/BoardDemo/PetAnimation.cpp -o tools/render-pet
./tools/render-pet preview/frames
