# blink-js

TypeScript wrapper around the [blink](https://github.com/jart/blink) x86-64 emulator, compiled to WebAssembly via Emscripten.

## Usage

```ts
import { createX86Emulator } from 'blink-js'

const emulator = await createX86Emulator({
  callbacks: {
    stdout: (charCode) => process.stdout.write(String.fromCharCode(charCode)),
    stderr: (charCode) => process.stderr.write(String.fromCharCode(charCode)),
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

`createX86Emulator()` initializes and awaits the wasm module internally; no wasm URL or byte buffer needs to be passed by the caller.

### Compile and run

```ts
// Assemble and link source, returns { ok, errors }
const result = await emulator.compile(sourceCode)

// Run until a breakpoint, syscall block, or instruction limit is hit
await emulator.run(limit, breakpoints)

// Convenience wrapper — runs with no limit and no breakpoints
await emulator.runUntilBlocked()
```

`run(limit, breakpoints)` accepts an optional maximum instruction count and an array of 0-based source-line breakpoint indices. Breakpoints are resolved to native instruction addresses using the DWARF line information emitted by GNU as.

### Check code without running

```ts
// Assembles and links but does not execute; updates the loaded program
const result = await emulator.checkCode(sourceCode)
```

### Read registers and memory

```ts
const rax = emulator.getRegister('rax')
const bytes = emulator.readMemory(address, length)
```

### Undo

```ts
if (emulator.canUndo()) emulator.undo()
```

### Events

```ts
emulator.on('stateChange', (state) => { /* ... */ })
emulator.on('stdout',      (charCode) => { /* ... */ })
emulator.on('stderr',      (charCode) => { /* ... */ })
emulator.on('signal',      (signal)   => { /* ... */ })
emulator.on('inputRequest', ()        => { /* ... */ })
```

## Current Shims

These API points are present but intentionally minimal while the C++ facade grows dedicated support:

- Undo history is empty and `canUndo()` always returns `false`.
- Call stack inspection returns an empty list.