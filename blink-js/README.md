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

When history is enabled, every instruction `run()` or `step()` executes is recorded inside the wasm, so each one can be undone. If history is disabled with `initialize(0)` or by never calling `initialize`, nothing is recorded and `canUndo()` returns `false`.

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

## Compiling C and C++

`@specy/x86/compiler-output` translates the assembly GCC writes for x86-64 Linux into NASM source that this emulator assembles and links like any hand-written File, and records where every output line came from. A C or C++ program compiled with GCC can then be run, stepped and undone here, with each instruction leading back to its source line. The translator does not compile: GCC runs wherever you run it, and the translator reads what it wrote. The subpath is a bundle of its own with no WebAssembly in it, so importing it loads neither the emulator nor NASM, and it runs the same in Node, browsers and workers.

### Example

Compile with GCC 14.2 for x86-64 Linux under the profile's flags:

```sh
gcc -S -O2 -ffreestanding \
  -masm=intel -fno-pie -fno-stack-protector -fcf-protection=none -fno-verbose-asm \
  -g1 -march=x86-64 -mtune=generic -std=c17 \
  -o main.s main.c
```

Then translate the output, and build it beside a start unit of your own, since the translator writes no startup code (`start.asm` is the one under [Starting the program](#starting-the-program)):

```ts
import { readFile } from 'node:fs/promises'
import { createX86Emulator } from '@specy/x86'
import { translateCompilerOutput } from '@specy/x86/compiler-output'

const assembly = await readFile('main.s', 'utf8')
const result = translateCompilerOutput(assembly.split('\n'), { profile: 'gcc-intel-v1' })
for (const diagnostic of result.diagnostics) {
  console.error(`main.s:${diagnostic.inputLine + 1}: ${diagnostic.severity}: ${diagnostic.message}`)
}
if (!result.ok) throw new Error('main.s did not translate')

const emulator = await createX86Emulator()
const build = await emulator.compileProject({
  entry: 'main.asm',
  files: { 'main.asm': result.text, 'start.asm': await readFile('start.asm', 'utf8') },
})
if (!build.ok) throw new Error(build.report)

await emulator.runUntilBlocked()
console.log(emulator.stopReason?.exitCode) // what main returned
```

Every `.asm`, `.s` or `.nasm` File of a Project that no other File includes is assembled on its own, with the default NASM assembler, and linked with the rest, so the translation and the start unit become one program.

### The `gcc-intel-v1` profile

A profile pins a compiler, its flags and the rules that translate its output. There is one so far, `gcc-intel-v1`, exported as `GCC_INTEL_V1` and passed to `translateCompilerOutput` by its id: GCC 14.2's x86-64 output under these flags, grouped as in `GCC_INTEL_V1.flags`.

| Group | Flags | Why |
| --- | --- | --- |
| `translation` | `-masm=intel` | The dialect the translator reads. |
| | `-fno-pie` | Position-independent code uses `@PLT` and `@GOTPCREL`, which are not translated; the emulator links statically. |
| | `-fno-stack-protector` | The stack protector loads its canary through `fs:` and calls `__stack_chk_fail`. |
| | `-fcf-protection=none` | Some GCC builds turn control-flow protection on by default, and its `notrack` prefix has no exact NASM equivalent. |
| | `-fno-verbose-asm` | Comments are not read. |
| `locations` | `-g1` | Writes the `.file` and `.loc` directives the source locations come from. |
| `target` | `-march=x86-64 -mtune=generic` | Keeps to the instruction set Blink runs. |
| `language.c` | `-std=c17` | |
| `language.cpp` | `-std=c++17 -fno-exceptions -fno-rtti` | Exception tables are not translated, and type information needs a C++ runtime that nothing links in. |

The profile is verified at `-O0`, `-O1`, `-O2`, `-O3` and `-Os` (`GCC_INTEL_V1.optimizations`). Other flags are the caller's, but the corpus the profile is verified on was also compiled with `-ffreestanding`, and C++ with `-fno-threadsafe-statics`, which keeps function-local statics from calling `__cxa_guard_acquire`; both change the code GCC writes, so use them to stay on verified ground. Output whose `.ident` names anything but GCC 14.2, or that has none, still translates, with an `unverified-compiler` warning.

### The result

`translateCompilerOutput(input, { profile })` takes the compiler's output as an array of lines and a profile id. It throws only for a profile id it does not know: everything about the input is a diagnostic. Every problem is reported in one pass, sorted by input line, and any error means no output. The same input and profile always give the same output.

```ts
type TranslationResult =
  | { ok: true; text: string; lines: TranslatedLine[]; symbols: SymbolSummary; diagnostics: TranslationDiagnostic[] }
  | { ok: false; diagnostics: TranslationDiagnostic[] }

type TranslatedLine = {
  text: string                      // one line of `text`
  inputLine: number | null          // the zero-based input line it came from; null in the header
  synthesized: boolean              // the header, and the section switches and alignment around a local common
  location: CompilerLocation | null // instructions only: the `.loc` in effect
}

type CompilerLocation = { file: string; line: number; column: number }

type TranslationDiagnostic = {
  severity: 'error' | 'warning'
  code: TranslationDiagnosticCode   // see "What is rejected"
  message: string
  inputLine: number                 // zero-based
  column?: number                   // one-based, when a token can be pointed at
  location: CompilerLocation | null // the compiler location in effect at that line
}

type SymbolSummary = {
  defined: { name: string; nasmName: string; binding: 'global' | 'weak' }[]
  common: { name: string; nasmName: string }[]                  // `.comm` without `.local`
  external: { name: string; nasmName: string; weak: boolean }[] // undefined symbols the output references
  constructors: { name: string; nasmName: string }[]            // `.init_array` entries, in order
}
```

The exported types are the same, with every field `readonly`.

`text` is NASM 3.00 source for one ELF64 object. It starts with a header: `default rel`, then `[dollarhex off]` when a name needs escaping, then an `extern` for every symbol the unit references, or declares global, without defining it. One line per kept statement follows, in input order except that an alias's label follows its target's, with labels at column 0 and everything else indented four spaces.

Code, data, read-only data, zeroed and common storage, and global, weak and alias (`.set`) symbols are translated. C++ COMDAT sections become ordinary ones, since NASM's ELF output has no section groups, and `.init_array` stays a section of its own. Debug sections, `.note.GNU-stack` (unless it asks for an executable stack) and `.note.gnu.property`, call-frame directives (`.cfi_*`), `.size`, `.hidden` and the `.type` of functions and objects are dropped; `.file`, `.loc` and `.ident` are dropped once read.

Alignment in code is kept where it aligns a function, that is, where a label other than GCC's `.L` labels comes before the next instruction. Two things depend on it: a C++ pointer to a member function tells a virtual function from an ordinary one by the low bit of the address, so GCC writes `.align 2` before every member function, and an `__attribute__((aligned(N)))` function promises its alignment. It becomes NASM's `align`, whose NOPs follow the previous function's last instruction, where nothing runs them, and the code section's `align=` covers the largest. Alignment of loops and jump targets, written with a maximum skip (`.p2align 4,,10`) or followed only by `.L` labels before the next instruction, affects nothing but speed and is dropped, which keeps stepping free of NOP runs.

In `symbols`, `name` is a symbol as the compiler wrote it and `nasmName` as the output spells it. GCC's `.L` labels lose their dot (`.LC0` becomes `LC0`, with `_` prepended until it differs from every other name in the unit), and a name NASM reserves, as an instruction, register, keyword, directive or standard macro, is escaped: a C function `add` is written `$add`, and is still `add` in the object. `external` is what other units must define; with nothing defining it, a call to `printf` fails at link time.

### Source locations

The emulator reports each instruction's File and zero-based line, in `getNextInstruction()` and `getCompiledInstructions()` for example. In the File that holds a translation, that line is an index into `result.lines`, and its `location` is the source line the instruction was compiled from:

```ts
const instruction = emulator.getNextInstruction()
if (instruction?.file === 'main.asm') {
  console.log(result.lines[instruction.lineNumber]?.location) // { file: 'main.c', line: 4, column: 5 }
}
```

`file` is the name as the compiler's `.file` directive wrote it, such as `src/main.c` or `/app/values.h`. An instruction carries the last `.loc` before it, unless a section directive or the end of its function (`.cfi_endproc`) came in between; labels, data and the header carry none.

### What is rejected

Anything outside the rules is an error at its input line, never a silent drop or a guess.

| Code | Severity | Raised for |
| --- | --- | --- |
| `inline-assembly` | error | `asm` statements: everything GCC writes between `#APP` and `#NO_APP`. |
| `unsupported-section` | error | Thread-local storage (`.tdata`, `.tbss`), destructors (`.fini_array`, `.dtors`), `.preinit_array` and `.ctors`, constructors with a priority (`.init_array.N`), exception tables (`.eh_frame`, `.gcc_except_table`), an executable stack (`.note.GNU-stack` with the `x` flag, which GCC writes when a nested function's trampoline runs on the stack), and any other section or section attributes outside the rules; data or instructions in a section that cannot hold them. |
| `unsupported-operand` | error | Relocation operators (`@PLT`, `@GOTPCREL`, `@tpoff` and the like) from position-independent code and thread-local storage; segment overrides (`fs:`, `gs:`), from thread-local storage and the stack protector; expressions beyond an integer, a symbol, or a symbol plus or minus an integer; absolute addresses and other operand shapes. |
| `unsupported-instruction` | error | Instructions outside the x86-64 baseline, x87, SSE, SSE2 and SSE3 (SSSE3, SSE4, AVX, AVX-512, BMI, MMX and others); registers outside the general-purpose, x87 and `xmm0`-`xmm15` sets, such as `ymm0`, `mm0`, `k1`, `fs` or `cr0`; `YMMWORD` and `ZMMWORD` operands; prefixes with no exact NASM equivalent (`notrack` from `-fcf-protection`, `bnd`, `xacquire`, `data16` and others); x87 register forms outside the verified ones. |
| `unsupported-symbol` | error | Ifuncs (`.type @gnu_indirect_function`) and other symbol types; `.protected` and `.internal` visibility; numeric and quoted labels; a `.set` that is not an alias of a label in the same output; a symbol defined twice. |
| `unsupported-directive` | error | Comments (the profile compiles with `-fno-verbose-asm`); several statements on one line; `.rept`, `.org`, `.symver`, `.equ` and `=`, `.weakref`, `.lcomm`, `.balign`; `.pushsection`, `.popsection` and `.previous`; subsections; `.uleb128` and `.sleb128` outside debug sections; `.att_syntax`; any other directive outside the rules. |
| `ambiguous-register-name` | error | An operand spelled like a register when the unit also has a symbol of that name (`jmp si` beside a function `si`), which GCC's Intel syntax cannot tell apart. |
| `unreadable-line` | error | A control character other than a tab, or a Unicode line or paragraph separator, inside a line, which GCC never writes; nothing else on the line is read. A carriage return that ends a line is a CRLF line ending, and is read as one. |
| `unverified-compiler` | warning | No `.ident`, or one naming anything but GCC 14.2. |
| `unreadable-location` | warning | A `.file` or `.loc` the translator cannot read; the instructions it would have located get no location. |

One ambiguity goes unreported. A C function named like a 64-bit register that the unit calls without defining it or naming it anywhere else, such as `extern int rbx(void);` called as `rbx()`, comes out of GCC as `call rbx`, exactly what GCC writes for an indirect call through the register. GNU as reads it as that indirect call, and so does the translation; `ambiguous-register-name` needs a symbol of that name in the unit to notice.

### Starting the program

The translator never writes startup code. Its output defines no `_start`, the entry point `ld` links the program to, and nothing in it runs the constructors it keeps in `.init_array`. Starting the program is a unit of your own, as a C runtime's `crt0` would be. This one, `start.asm` in the example, runs the `.init_array` entries in order, calls `main`, and exits with `main`'s result through the `exit` system call, 60:

```nasm
    default rel
    extern main
    extern __init_array_start     ; ld defines both, around .init_array
    extern __init_array_end
    global _start

    section .text
_start:
    lea rbx, [__init_array_start] ; rbx is callee-saved: it survives the calls
.next:
    lea rax, [__init_array_end]
    cmp rbx, rax
    jae .done
    call [rbx]                    ; one constructor
    add rbx, 8
    jmp .next
.done:
    call main
    mov edi, eax                  ; main's result is the exit status
    mov eax, 60                   ; exit
    syscall
```

`ld` defines `__init_array_start` and `__init_array_end` even when no unit has a constructor, and the loop then runs none. `main` gets no arguments, which suits `int main(void)`. Linux starts a program with `rsp` 16-byte aligned, and because `_start` pushes nothing, every call it makes enters its callee 8 bytes below a 16-byte boundary, as the System V ABI requires. Keep it that way if you change it: GCC's SSE code relies on that alignment, and Blink, unlike a real processor, does not fault on a misaligned `movaps`, so a misaligned start can run here and crash natively.
