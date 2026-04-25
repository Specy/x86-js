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
  command -v "$cmd" >/dev/null 2>&1 || { echo >&2 "Required program $cmd is not installed. Aborting."; exit 1; }
done

#---------------------
# compile blink wasm+js
#---------------------
rm -f o//blink/blinkenlib.js o//blink/blinkenlib.wasm
emmake make \
  CXX=em++ \
  'CXXFLAGS=-g -O2' \
  'LDFLAGS=-sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1 -sEXIT_RUNTIME=0 -sWASM_BIGINT=1 -sEXPORT_ES6=1 -sMODULARIZE -sEXPORT_NAME="blinkenlib" -sEXPORTED_RUNTIME_METHODS=[UTF8ToString,stringToNewUTF8,AsciiToString,FS,callMain,addFunction,wasmExports] -lembind' \
  o//blink/blinkenlib.js


#---------------------
# copy blink wasm+js in
# the web assets folder
#---------------------
cp ./o/blink/blinkenlib.wasm ../blink-js/src/wasm/
cp ./o/blink/blinkenlib.js ../blink-js/src/wasm/
