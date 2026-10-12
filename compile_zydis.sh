#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")" && pwd)"
command -v emcc >/dev/null || { echo 'Source emsdk_env.sh first' >&2; exit 1; }
emcc -O2 -DZYDIS_STATIC_BUILD -DZYCORE_STATIC_BUILD \
  -I"$package_dir/third_party/zydis" -I"$package_dir/third_party/zydis/zycore/include" \
  "$package_dir/third_party/zydis/Zydis.c" "$package_dir"/third_party/zydis/zycore/src/*.c \
  "$package_dir/blink-js/src/disassembler/wrapper.c" \
  --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=1 -sMALLOC=emmalloc \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_decode","_release_decoded"]' \
  -o "$package_dir/blink-js/src/disassembler/zydis.wasm"
echo "emsdk: $(emcc --version | head -n1)"
file="$package_dir/blink-js/src/disassembler/zydis.wasm"
echo "$(sha256sum "$file" | cut -d' ' -f1)  $(wc -c < "$file") bytes  blink-js/src/disassembler/zydis.wasm"
