# @specy/x86

TypeScript wrapper around the [blink](https://github.com/jart/blink) x86-64 emulator, compiled to WebAssembly via Emscripten.

## Usage

```ts
import { createX86Emulator } from '@specy/x86'

const emulator = await createX86Emulator({
  callbacks: {
    stdout: (charCode) => process.stdout.write(String.fromCharCode(charCode)),
    stderr: (charCode) => process.stderr.write(String.fromCharCode(charCode)),
  },
})

const result = await emulator.compile(`
global _start
section .text
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

`createX86Emulator()` initializes and awaits the wasm module internally; no wasm URL or byte buffer needs to be passed by the caller. NASM is the default assembler; pass `mode: 'GNU_trunk'` to use GNU as instead.

### Compile and run

```ts
// Assemble and link source, returns { ok, errors }
const result = await emulator.compile(sourceCode)

// Run until a breakpoint, syscall block, or instruction limit is hit
await emulator.run(limit, breakpoints)

// Convenience wrapper — runs with no limit and no breakpoints
await emulator.runUntilBlocked()
```

`run(limit, breakpoints)` accepts an optional maximum instruction count and an array of 0-based source-line breakpoint indices. Breakpoints are resolved to native instruction addresses using the DWARF line information emitted by the assembler.

### Check code without running

```ts
// Assembles and links but does not execute; updates the loaded program
const result = await emulator.checkCode(sourceCode)
```

### Read registers and memory

```ts
const rax = emulator.getRegisterValue('rax')
const bytes = emulator.readMemoryBytes(address, length)
```

### Undo history and call stack

Undo recording is opt-in. Call `initialize(undoSize)` after loading or compiling a program and before execution. `undoSize` is the maximum number of reversible instructions kept in history; internally this is a fixed-size circular buffer, so older entries are discarded when the buffer fills.

```ts
const result = await emulator.compile(sourceCode)
if (!result.ok) throw new Error(result.errors[0]?.error ?? 'Assembly failed')

// Keep the last 128 reversible instructions.
emulator.initialize(128)

await emulator.step()
await emulator.step()

const [latestStep] = emulator.getUndoHistory(1)
console.log(latestStep?.pc, latestStep?.mutations)

if (emulator.canUndo()) {
  emulator.undo()
}
```

History entries include register writes, memory writes, flag changes, and call-stack mutations. `getUndoHistory(max)` returns the newest entries first, as `ExecutionStep[]`, which is useful for instruction-history UIs.

Every write mutation carries both sides of the change: `old`, the value it replaced, and `new`, the value it left. A `WriteRegister` reports the WHOLE register on both sides, whatever width the store was - `mov $0xff, %al` on an `rax` of `0x1122334455667788` reports `old: 0x1122334455667788n, new: 0x11223344556677ffn` - and a `WriteMemoryBytes` reports the bytes at the width of the write, the ones it overwrote and the ones it left there. Register and FPU values come from the two snapshots the step already takes, so they cost nothing extra. Memory is different: the machine's write journal captures the bytes a store replaced, at that store, but records nothing about what it put there, so `new` is read back out of the machine as the entry is recorded, with the step over and nothing run since. That read is one page lookup per contiguous run of written addresses, and none at all for an instruction that writes no memory. It has one consequence: were one step ever to store twice over the same address, both entries would report the bytes the step ENDED with - no reachable x86 instruction journals two stores to one address, and closing it for good would need a post-image in the native journal, which means rebuilding the wasm. Once recorded, an entry keeps saying what its own step wrote however much has happened afterwards.

```ts
for (const step of emulator.getUndoHistory(10)) {
  console.log(step.pc, step.mutations)
}
```

The call stack is tracked while history recording is enabled. Calls push frames and returns pop them; undo restores the previous call-stack snapshot along with registers, flags, PC, SP, and captured memory bytes.

```ts
emulator.initialize(64)
await emulator.run(20)

const frames = emulator.getCallStack()
console.log(frames.map((frame) => frame.name))
```

When history is enabled, `run()` uses traced stepping so each executed instruction can be undone. If history is disabled with `initialize(0)` or by never calling `initialize`, normal fast execution remains available and `canUndo()` returns `false`.

Very large or truncated memory writes may not be reversible. In that case `canUndo()` returns `false` for the latest step, and calling `undo()` throws instead of restoring a partial state.

### Events

```ts
emulator.on('stateChange', (state) => { /* ... */ })
emulator.on('stdout',      (charCode) => { /* ... */ })
emulator.on('stderr',      (charCode) => { /* ... */ })
emulator.on('signal',      (signal)   => { /* ... */ })
emulator.on('inputRequest', ()        => { /* ... */ })
```

Callbacks passed to `createX86Emulator()` and handlers registered with `on()` may return either `void` or `Promise<void>`. Async callbacks are observed but not awaited by the emulator, so UI work can be scheduled without blocking execution. `stdin` remains synchronous because it is called directly by Emscripten's filesystem; for non-blocking UI input, listen for `inputRequest` and call `provideInput()` when the user submits text.
