#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# -O0 preserves the comparison branch used by the debugger/patch examples.
# No debug info: Listings use ELF symbols, not source-level DWARF.
for name in crackme hello-atexit; do
  gcc -O0 -fPIE -pie "$name.c" -o "$name"
  gcc -O0 -static-pie "$name.c" -o "$name-static-pie"
  gcc -O0 -static -no-pie "$name.c" -o "$name-static"
done
cp crackme crackme-stripped
strip crackme-stripped
gcc -O0 -fPIE -pie math.c -lm -o math
g++ -O0 -fPIE -pie cpp.cpp -o cpp
for name in argv-env ptrace self-write crackme-argv overflow; do
  gcc -O0 -fno-builtin -fPIE -pie "$name.c" -o "$name"
done
gcc -O2 -fPIE -pie avx.c -o avx
if command -v go >/dev/null 2>&1; then
  CGO_ENABLED=0 go build -o hello-go hello.go
fi
sha256sum crackme crackme-stripped crackme-static* hello-atexit hello-atexit-static hello-atexit-static-pie math cpp argv-env ptrace self-write crackme-argv overflow avx
