#!/bin/bash

# Builds NASM as a standalone WebAssembly module, so the editor can assemble
# without running the nasm x86-64 ELF inside blink. Blink interprets that ELF
# one instruction at a time, which costs ~1.2s of startup plus ~14ms per line
# of source; the wasm module below assembles the same input in single-digit
# milliseconds.
#
# Emitted next to blinkenlib, as src/wasm/nasm.mjs + src/wasm/nasm.wasm.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

#---------------------
# check dependencies
#---------------------
requirements=(
    "wget"
    "tar"
    "patch"
    "make"
    "perl"
    "emconfigure"
    "emmake"
)

for cmd in "${requirements[@]}"; do
  command -v "$cmd" >/dev/null 2>&1 || { echo >&2 "Required program $cmd is not installed. Aborting."; exit 1; }
done

mkdir -p "$SCRIPT_DIR/wasm_nasm"
cd "$SCRIPT_DIR/wasm_nasm"

#---------------------
# clone nasm v3.00
#---------------------
if [ ! -d nasm ] ; then
  wget https://www.nasm.us/pub/nasm/releasebuilds/3.00/nasm-3.00.tar.gz
  tar -xf nasm-3.00.tar.gz
  mv nasm-3.00 nasm

  #---------------------
  # two source fixes that
  # only matter off x86;
  # see the patch header
  #---------------------
  patch -p1 -d nasm < "$SCRIPT_DIR/patches/nasm-3.00-wasm.patch"
fi

cd nasm

#---------------------
# Run ./configure as a
# wasm32 cross build.
# --host is what tells
# autoconf not to try
# running its test
# programs.
#---------------------
common_configure_flags=(
    "--host=wasm32-unknown-emscripten"
    "--disable-gdb"
    "--disable-werror"
    "--disable-largefile"
    "--disable-gc"
)

emconfigure ./configure "${common_configure_flags[@]}" CFLAGS="-O3"

#---------------------
# build nasm.mjs+wasm.
#
# -g0 overrides the -g3
# configure picks by
# default, which would
# otherwise carry DWARF
# for nasm itself into
# the wasm and triple
# its size.
#
# INVOKE_RUN=0 leaves
# main() for the host to
# call per assembly;
# EXIT_RUNTIME=1 makes
# nasm's exit status
# readable from the
# ExitStatus it throws.
#---------------------
emscripten_ldflags=(
    "-g0"
    "-O3"
    "-sMODULARIZE"
    "-sEXPORT_ES6"
    "-sEXPORT_NAME=createNasm"
    "-sEXPORTED_RUNTIME_METHODS=FS,callMain"
    "-sINVOKE_RUN=0"
    "-sEXIT_RUNTIME=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFORCE_FILESYSTEM=1"
    "-sENVIRONMENT=web,node"
    "-sSTACK_SIZE=1MB"
)

emmake make nasm.mjs -j"$(nproc)" \
  X=.mjs \
  EXTRA_CFLAGS="-g0" \
  EXTRA_LDFLAGS="${emscripten_ldflags[*]}"

#---------------------
# copy nasm wasm+js in
# the web assets folder
#---------------------
cp nasm.mjs ../../blink-js/src/wasm/
cp nasm.wasm ../../blink-js/src/wasm/

echo
echo "built $(cd ../../blink-js/src/wasm && ls -la nasm.mjs nasm.wasm | awk '{print $9" ("$5" bytes)"}' | paste -sd' ')"
