# Blink's build settings for the @specy/x86 WebAssembly Core, committed with
# config.h instead of written by ./configure, whose probes cannot run under
# Emscripten. Nothing here depends on the build machine beyond having the
# emsdk on PATH (source emsdk_env.sh first), so the same sources and the same
# emsdk build the same wasm. ../compile_blink.sh builds with it.

CC = emcc
CXX = em++
AR = emar
MODE ?=
PREFIX = /usr/local

CFLAGS = -g -O2
CXXFLAGS = -g -O2
CPPFLAGS = -isystem tool/stdatomic -DHTML -D_FILE_OFFSET_BITS=64 -D_DARWIN_C_SOURCE -D_DEFAULT_SOURCE -D_BSD_SOURCE -D_GNU_SOURCE
UOPFLAGS = -O2
TARGET_ARCH =
LDFLAGS = -O2 -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1 -sEXIT_RUNTIME=0 -sEXPORT_ES6=1 -sMODULARIZE -sEXPORT_NAME="blinkenlib" -sEXPORTED_RUNTIME_METHODS=[UTF8ToString,stringToNewUTF8,AsciiToString,FS,callMain,addFunction,wasmExports] -lembind
LDLIBS =
ZLIB = o/$(MODE)/third_party/libz/zlib.a

# The Makefile reads these to pick host-specific flags; none of its branches
# applies to an Emscripten build, which is the same on every host.
HOST_OS = GNU/Linux
HOST_ARCH = x86_64
HOST_SYSTEM = Linux

# The Makefile reruns ./configure when it finds a configuration written on
# another host, or a configure script newer than config.h. Neither applies to
# a committed configuration: the hostname always matches, and rerunning only
# says so.
CONFIG_HOSTNAME = $(shell hostname)
CONFIG_COMMAND = @echo "config.h and config.mk are committed: edit them rather than running ./configure" >&2
CONFIG_ARGUMENTS = -DCONFIG_ARGUMENTS="\"committed config.h\""

# What uname(2) reports as the kernel's version string. The Makefile would
# stamp in the build's date and the repository's commit count, which made
# every build a different wasm; these fixed values keep it reproducible.
BLINK_UNAME_V = -DBLINK_UNAME_V="\"NOJIT NOSOCK\""
override BLINK_COMMITS := -DBLINK_COMMITS="\"1\""
override BLINK_GITSHA := -DBLINK_GITSHA="\"\""
override BUILD_TIMESTAMP := -DBUILD_TIMESTAMP="\"Mon Oct  5 00:00:00 UTC 2026\""
override BUILD_TOOLCHAIN := -DBUILD_TOOLCHAIN="\"emcc\""
