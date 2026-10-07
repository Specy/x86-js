#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR/libblink"

#---------------------
# check dependencies
#---------------------
requirements=(
    "emmake"
    "make"
)
for cmd in "${requirements[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || { echo >&2 "Required program $cmd is not installed. Aborting. (source emsdk_env.sh first)"; exit 1; }
done

#---------------------
# compile blink wasm+js
#---------------------
# Everything the build depends on is in the committed config.h and config.mk,
# so this starts from nothing: a stale object compiled under another
# configuration cannot end up in the module.
rm -rf o
emmake make -j"$(nproc 2>/dev/null || echo 4)" o//blink/blinkenlib.js


#---------------------
# copy blink wasm+js in
# the web assets folder
#---------------------
cp ./o/blink/blinkenlib.wasm ../blink-js/src/wasm/
cp ./o/blink/blinkenlib.js ../blink-js/src/wasm/

# The same sources built with the same emsdk give the same bytes; this is what
# to compare when checking that a committed module is the one its sources make.
echo "emsdk: $(emcc --version | head -n1)"
for file in ../blink-js/src/wasm/blinkenlib.wasm ../blink-js/src/wasm/blinkenlib.js; do
  echo "$(sha256sum "$file" | cut -d' ' -f1)  $(wc -c < "$file") bytes  ${file#../}"
done
