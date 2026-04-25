# blink-js

TypeScript API for the x86-64 playground emulator.

The package wraps the existing blink WebAssembly runtime and exposes an async factory plus a `BaseEmulator`-compatible `X86Emulator` class. Emulator state is exposed through a copied C++/Embind facade, so the TypeScript bridge does not read or write wasm linear memory directly.

```ts
import { createX86Emulator } from 'blink-js'

const emulator = await createX86Emulator({
  callbacks: {
    stdout: (charCode) => process.stdout.write(String.fromCharCode(charCode)),
  },
})

const result = await emulator.compile(`
.intel_syntax noprefix
.global _start
.text
_start:
  mov rax, 60
  xor rdi, rdi
  syscall
`)

if (result.ok) {
  await emulator.runUntilBlocked()
  console.log(emulator.stopReason)
}
```

## Runtime Support

The intended target is browser and Node.js. The checked-in wasm artifacts must be rebuilt with Emscripten using `-sENVIRONMENT=web,node`, `-sWASM_BIGINT=1`, and Embind support before Node integration tests can run.

The package imports `blinkenlib.wasm` through `rolldown-plugin-wasm` using the `?init` pathway. `createX86Emulator()` awaits that initialization internally, so consumers do not need to pass a wasm URL or load bytes themselves.

Build from WSL:

```sh
cd /mnt/c/Users/specy/Desktop/progetti/x86-64-playground
./compile_blink.sh
```

Then run library checks:

```sh
cd /mnt/c/Users/specy/Desktop/progetti/x86-64-playground/blink-js
npm run type-check
npm test
npm run build
```

## Current Shims

These API points are present but intentionally minimal while the C++ facade grows dedicated support:

- Undo history is empty and `canUndo()` returns `false`.
- Call stack inspection returns an empty list.
- Virtual memory reads and writes are copied through the native facade and throw when the current emulator cannot map the requested guest address.

## Execution Controls

`compile()` and `checkCode()` are async and run the actual assembler/linker pipeline. `checkCode()` uses the current runtime, so it updates the loaded program just like `compile()`.

`run(limit, breakpoints)` supports an optional instruction limit and source-line breakpoints. Breakpoints are 0-based source line indices at the public API layer; the runtime resolves them to native instruction addresses using debug line information from the compiled ELF. GNU as emits DWARF line data by default in this package. Assembler modes without source maps still support exact native instruction lookup, but source-line breakpoint resolution may not find addresses.