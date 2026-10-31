# @specy/x86

TypeScript wrapper around the [blink](https://github.com/jart/blink) x86-64 emulator, compiled to WebAssembly via Emscripten.

## Usage

```ts
import { createX86Emulator } from '@specy/x86'

const emulator = await createX86Emulator({
    callbacks: {
        stdout: (bytes) => process.stdout.write(bytes),
        stderr: (bytes) => process.stderr.write(bytes)
    }
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

The module uses WebAssembly exception handling, which Chrome 95, Firefox 100, Safari 15.2 and Node 17 and later support. Long work, such as linking, runs in slices, and the next slice starts as a task of its own, so the page can still render between slices and a hidden tab does not stop the work.

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

### Projects

`compileProject(project)` builds a program from several Files, named by path, and the Entry, the File the program is built from. `checkProject(project)` assembles a Project for its diagnostics without linking it.

```ts
const result = await emulator.compileProject({
    entry: 'main.asm',
    files: {
        'main.asm': mainSource,
        'lib/print.asm': printSource,
        'lib/macros.inc': macros, // %include "lib/macros.inc"
        'data/table.bin': tableBytes // incbin "data/table.bin", as a Uint8Array
    },
    library: { 'runtime/start.asm': startSource }
})
```

With the default NASM assembler, the Entry and every `.asm`, `.s` or `.nasm` File that no other File `%include`s are each assembled as a unit of their own, and linked the way a C toolchain links objects and a static library. The Entry's unit is linked whole. Every other unit goes into an archive, and `ld` takes a unit from it only for a symbol the program still needs, `_start` included, which it needs from the start. A unit nothing needs is still assembled, and its mistakes are reported, but it is not part of the program, so a Project can hold a File with a `_start` of its own beside the program its Entry builds. Taking a unit for one symbol takes all of it, though: a `_start` in a unit the program needs for something else is a duplicate definition, reported where it is written. As in a static library, a unit's `.init_array` constructors run only when the unit is taken.

`library` holds units built alongside the Project's own, such as the start code under [Starting the program](#starting-the-program). Each is assembled like a File and named by its path wherever a File is, in instructions, breakpoints and diagnostics, but it is never the Entry and no File can `%include` it. A library path and a File's path must differ, and neither may be a directory of the other: `compileProject` and `checkProject` throw for a Project that breaks this. The library's units come first in the archive, so for a symbol a library unit and a Project unit both define, `ld` takes the library's: its `_start` over one a File writes, and its weak definitions, such as a default `memcpy`, over a File's strong ones unless that File is taken for something else. Nothing is taken from the archive for a symbol the Entry defines. A library unit written as text is assembled once and reused, by every emulator in the page or process, for as long as its source stays the same. A unit for which NASM read another File, through `%include` for example, or that uses one of NASM's date and time macros, is assembled again every time. The blink-hosted assemblers, GNU as and fasm, assemble the Entry alone.

This differs from 3.x, which linked every unit into the program, so that two Files defining one symbol always clashed. `projectLinking` is `'archive'` on an emulator that links Projects this way, and absent in 3.x.

`includePaths` names directories of the Project that NASM searches, in order, for a `%include` or `incbin` it does not find in the directory of the File it assembles, as `-I` does on Linux, for every unit, the library's included. A host offers include files of its own, such as a system's headers, as Files under one of them:

```ts
await emulator.compileProject({
    entry: 'main.asm', // %include "linux/fb.inc"
    files: {
        'main.asm': mainSource,
        'system/include/linux/fb.inc': fb, // %include "linux/ioctl.inc"
        'system/include/linux/ioctl.inc': ioctl
    },
    includePaths: ['system/include']
})
```

A File found through an include path is named by its Project path, `system/include/linux/fb.inc`, in diagnostics, instructions and breakpoints, as every File is, and the files there find each other by their paths under the directory, through the same search. Each include path must be a Project path and no File's; `compileProject` and `checkProject` throw for one that is not. The Files under an include path are Files like the others: an `.asm` among them is assembled on its own unless something includes it. The blink-hosted assemblers do not search include paths.

### Read registers and memory

```ts
const rax = emulator.getRegisterValue('rax')
const bytes = emulator.readMemoryBytes(address, length)
```

### Vector registers and instruction sets

`getFpuState()` returns the SSE and x87 register files in one call. `xmm` holds `xmm0` to `xmm15` as 128-bit values and `ymm` holds `ymm0` to `ymm15` as 256-bit values, the matching `xmm` in the low half. `setFpuState()` writes both: change `ymm[n]` to set a whole register, or `xmm[n]` alone to keep the upper half. A step that writes a `ymm` register's upper half reports a `WriteRegister` of `ymm`*n* with the whole 256-bit value on both sides; a step that only changes the low half reports `xmm`*n*, as before. `X86_YMM_REGISTERS` names them.

The emulator runs the x86-64 baseline, x87, SSE through SSE3 and SSSE3, and, VEX-encoded, AVX, AVX2, FMA3, F16C, BMI1, BMI2, AES-NI, PCLMULQDQ and the SSE4.1 and SSE4.2 instructions (including the string compares). Without VEX it runs `pmulld`, `movntdqa`, `crc32`, `pclmulqdq` and `popcnt`; the other SSE4.1, SSE4.2 and AES-NI instructions raise SIGILL in their legacy encoding, and so does every instruction on an MMX register (`emms` runs and does nothing). It does not run AVX-512 (EVEX), VAES, the 256-bit `vpclmulqdq`, or `adcx`, `adox` and `movbe`. `CPUID` reports the baseline, SSE3, SSSE3, PCLMULQDQ, POPCNT, CMPXCHG16B and RDRAND but no AVX or later extension, so a C library selects its SSE2 routines; a program built with `-mavx2` runs, because it uses the instructions without asking. A 256-bit access may be unaligned except for the aligned moves (`vmovaps`, `vmovdqa`, `vmovntdq` and relatives), whose misaligned operand raises SIGSEGV with code `SI_KERNEL` and no address, as Linux reports a general protection fault. A vector instruction that faults leaves every register and every byte of memory as it was, apart from a gather, which keeps the elements it loaded before the fault and clears their mask bits, as the processor does. A signal frame holds the legacy `xmm` state only, so the upper halves are neither saved nor restored around a handler.

Floating point follows MXCSR's rounding mode in the conversions to integers, `vroundps` and its relatives and `vcvtps2ph`, but arithmetic, fused multiply-add, the dot products and the other conversions round to nearest whatever MXCSR says, `DAZ` and `FTZ` have no effect, and apart from the invalid-operation flag of `comiss` and its relatives, no instruction sets MXCSR's exception flags or raises SIGFPE for an unmasked one. These limits are Blink's, older than its AVX support.

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

A frame names the symbol its call went into (`name`, starting at `address`), where the call went (`target`, which differs from `address` when no symbol starts there, such as a PLT stub) and where it returns (`destination`).

When history is enabled, every instruction `run()` or `step()` executes is recorded inside the wasm. CPU instructions and queries can be undone; an instruction with unjournaled input, File, descriptor, pipe, mapping or process-state effects forms an irreversible boundary. If history is disabled with `initialize(0)` or by never calling `initialize`, nothing is recorded and `canUndo()` returns `false`.

A `rep` string instruction whose writes outgrow the 64 KiB of replaced bytes the machine keeps for one instruction stops between iterations for the history and goes on at once, so that clearing a framebuffer page or a `memset` stays reversible; its parts are one step, one history row and one instruction in every count. Memory writes too large even for that (more than 16 MiB in one instruction) or truncated otherwise are not reversible. In that case `canUndo()` returns `false` for the latest step, and calling `undo()` throws instead of restoring a partial state.

`canUndoSteps(count)` preflights a whole group before any rollback. It checks every retained packet's reversibility and the Undo floor; a negative or noninteger count throws. Zero returns true unless an instruction is waiting. Barriers retain their visible History row, serial, captured memory mutations and contribution to `getUndoDepth()`. Reversible instructions and Pokes above a barrier remain undoable. Direct `undo()` refuses a barrier before changing any state.

`getUndoDepth()` says how many entries the history holds within `undo()`'s reach: one per instruction, and one per host edit recorded with `beginPoke()` and `endPoke()`. It never exceeds `undoSize`, since a full history drops its oldest entry for each new one. An entry `undo()` cannot take back is counted but stops `undo()`, which `canUndo()` reports: one whose memory writes were too large to capture or could not be read back, and an old one the history hollowed, keeping only its header, once its entries held more than 256 MiB.

`getRecordedEntryCount()` counts every entry the history has recorded since the emulator was created, including those since undone, hollowed or dropped. It only grows, and stands still while nothing is recorded, so its difference across a `run()` or `step()` is how many instructions that executed.

`setUndoEnabled(false)` turns undo off until `setUndoEnabled(true)`, so that nothing run in between can be undone. A debugger can use it to run a program's start code, such as the `start.asm` under [Starting the program](#starting-the-program), up to the program's own first instruction:

```ts
emulator.initialize(128)
emulator.setUndoEnabled(false)
while (emulator.getNextInstruction()?.file === 'start.asm') await emulator.step()
emulator.setUndoEnabled(true)

console.log(emulator.getUndoDepth(), emulator.canUndo()) // 0 false
await emulator.step()
console.log(emulator.getUndoDepth(), emulator.canUndo()) // 1 true
```

What runs while undo is off is still recorded, which keeps the call stack: above, `getCallStack()` holds the frame of the call that entered the program's own code, although that call ran with undo off. It can never be undone, though, and nothing recorded before undo was turned back on can be undone either, since undo goes newest first. While undo is off, `canUndo()` returns `false`, `getUndoDepth()` returns 0 and `getUndoHistory()` returns nothing; once it is back on they cover only what ran since. Entries recorded while it was off still take slots of the history until newer ones push them out. Asking for the state it is already in changes nothing, and `initialize()` turns undo back on. Changing it while a `beginPoke()` transaction is open, from a callback that runs during an instruction, or while an instruction waits for input, throws.

### Events

```ts
emulator.on('stateChange', ({ state, oldState }) => {
    /* ... */
})
emulator.on('stdout', (bytes) => {
    /* one write's bytes, a Uint8Array */
})
emulator.on('stderr', (bytes) => {
    /* ... */
})
emulator.on('signal', ({ signal, code }) => {
    /* ... */
})
emulator.on('inputRequest', ({ maxBytes }) => {
    /* answer with provideInput() */
})
emulator.on('terminalMode', (mode) => {
    /* { canonical, echo, signals, crToNl, outputProcessing, nlToCrNl } */
})
emulator.on('unsupportedDevice', ({ path }) => {
    /* the program opened /dev/dri/card0 or another node the machine does not cover */
})
emulator.on('framebufferPresent', ({ yoffset }) => {
    /* the program panned, synced or blanked /dev/fb0: show getFramebuffer().visible() now */
})
emulator.on('pcm', ({ start, rate, frames }) => {
    /* stereo samples /dev/dsp plays from `start` (ns of Program time) at `rate` */
})
emulator.on('midi', ({ at, message }) => {
    /* one whole MIDI message, which reaches the synthesizer at `at` */
})
emulator.on('tone', ({ at, hz }) => {
    /* the PC speaker from `at` on; 0 is silence */
})
emulator.on('mixer', ({ volume, pcm }) => {
    /* the program's gains on /dev/dsp, [left, right] each, 0 to 100 */
})
emulator.on('soundCut', ({ after, device }) => {
    /* drop what was scheduled after `after`, for `device` or every sound device */
})
```

Callbacks passed to `createX86Emulator()` and handlers registered with `on()` may return either `void` or `Promise<void>`. Async callbacks are observed but not awaited by the emulator, so UI work can be scheduled without blocking execution. A `stdout`, `stderr`, `terminalMode`, `unsupportedDevice` or sound callback that throws is reported as a rejected promise is, asynchronously, and the call that raised it still succeeds. [Standard streams](#standard-streams) says what `stdout`, `stderr`, `inputRequest` and `terminalMode` carry, [Devices](#devices) what `unsupportedDevice` does, and [Sound](#sound) what `pcm`, `midi`, `tone`, `mixer` and `soundCut` do.

### How a program ends

`stopReason` says why the program stopped. When it ended, `kind` is `'exit'` or `'signal'`:

```ts
await emulator.runUntilBlocked()
emulator.stopReason
// { kind: 'exit', exitCode: 44, ... }  after exit(300)
// { kind: 'signal', exitCode: 139,
//   signal: { number: 11, code: 1, name: 'SIGSEGV', description: 'Segmentation fault' }, ... }
```

An exit's `exitCode` is the status a parent sees on Linux, the low eight bits of what the program passed to `exit` or `exit_group`: `exit(256)` is 0 and `exit(-1)` is 255. A signal whose default action is termination ends the program with `exitCode` 128 plus its number, as a shell reports it. `signal` names every Linux signal, the real-time ones counted from the kernel's `SIGRTMIN` (32), with the `si_code` the kernel would give it (`SEGV_MAPERR` for an unmapped address, `SI_KERNEL` for `int3` or a general protection fault) and the text a shell prints. This includes SIGTRAP: an `int3`, or a single step with the trap flag set, ends a program that has no handler for it, as on Linux; a program with a handler keeps running. Job-control stop signals such as SIGSTOP and SIGTSTP currently terminate the guest rather than suspending a process group; this one-process browser environment has no external process to send SIGCONT.

The emulator writes nothing to stdout or stderr of its own: no banner when it starts and no command line before a program, so everything the `stdout` and `stderr` callbacks receive is the program's. What the assembler and the linker write goes only into the build's `report`, which names each tool it ran, with a `$ /linker ...` line before what the linker said.

### Standard streams

Descriptors 0, 1 and 2 are a terminal, as for a Linux process started from a shell: one tty, open for reading and writing (`fcntl(F_GETFL)` says `O_RDWR`), which `isatty()` recognises. A descriptor `dup`'d from one of them is the terminal too, and so is what a program opens as `/dev/tty`, `/dev/stdin`, `/dev/stdout` or `/dev/stderr`.

**Output.** Every write reaches the host as one call of the `stdout` callback, or of `stderr` for a write through descriptor 2 or a copy of it, with the bytes it wrote as a `Uint8Array`, in the order the program wrote them; a `writev` is one call with its vectors joined, and a write of nothing makes none. The bytes are as written, so a UTF-8 character a program writes in two writes arrives split, and decoding is the host's (a `TextDecoder` with `stream: true` keeps the split character). Writes to descriptor 0 or to `/dev/tty` arrive as standard output. `setTerminalProcessing({ output: true })` has the terminal process output as Linux's line discipline does under the program's `OPOST`: with `ONLCR`, which every program starts with, a line feed arrives as a carriage return and a line feed, and with `OCRNL` a carriage return as a line feed, so a program that turns `OPOST` off (`cfmakeraw()` does) moves down without returning. The write still returns the bytes the program wrote. Output processing is off unless the host asks for it, so that a host whose output stands for a pipe, such as a test's expected transcript, receives what the program wrote.

**Input.** The host gives the terminal bytes, as `provideInput(bytes)`, whether or not a read waits for them: in canonical mode what its line discipline releases, a line ended with Enter or a paste; in raw mode each key as it is typed. A string is taken as its UTF-8 bytes. `provideInput(END_OF_INPUT)` gives End of input, what Ctrl+D on an empty line gives a terminal. Both queue in the order given, behind what no read has taken. With `setTerminalProcessing({ input: true })` the bytes go through the program's `ICRNL`, `INLCR` and `IGNCR` as they arrive, so a typed carriage return is read as a line feed; a Testcase's scripted input, which Linux would pipe, is better given without. In canonical mode (`ICANON`) a read takes at most the bytes it asked for, and never past a line feed, so the rest waits for the next read. Without it, a read takes what is queued, as many as it asked for, and waits as `VMIN` and `VTIME` say, `VTIME`'s tenths of a second on Program time: with neither it returns at once, 0 on nothing; with `VTIME` alone it waits that long for the first byte; with `VMIN` it waits for that many bytes, and with both `VTIME` restarts after each byte. End of input at the head of the queue makes the read that reaches it return 0, and only that read, and one further back ends the read before it. A read with nothing to take, or short of `VMIN`, waits: `getStatus()` says `WaitingForInput`, the `inputRequest` event gives `maxBytes`, the bytes the read asked for, and `provideInput()` resumes it; one with a `VTIME` deadline says `Waiting` instead, with the deadline, `wakeSources.terminal` and `terminalRead` in its `waitRequest`: it takes the input that ends the wait, where a poll only looks. A read of no bytes returns 0 at once, as on Linux.

**Modes.** Blink stores the termios the program sets with `TCSETS` and its relatives and reads it back with `TCGETS`; every program starts with the settings below. `getTerminalMode()` and the `terminalMode` event, at every start and every change, report what a host's line discipline follows: `canonical` (`ICANON`), `echo` (`ECHO`), `signals` (`ISIG`), `crToNl` (`ICRNL`), `outputProcessing` (`OPOST`) and `nlToCrNl` (`ONLCR`). Under `ISIG` a host sends Ctrl+C and Ctrl+\ as `sendSignal(2)` and `sendSignal(3)`: the signal reaches a running program at its next instruction and ends a wait at once, and, as on Linux, the input no read took is discarded unless the program set `NOFLSH`. A signal from outside the program is an Undo barrier, as a timer's is.

```ts
import { END_OF_INPUT, EmulatorStatus } from '@specy/x86'

let status = await emulator.run()
while (status === EmulatorStatus.WaitingForInput) {
    const line = await nextLine() // null once the user presses Ctrl+D
    emulator.provideInput(line ?? END_OF_INPUT) // a string is sent as UTF-8
    status = await emulator.run()
}
```

Given to a read that waits, the input finishes it, and the history records the read as one instruction; a run the runtime's own loop was driving goes on (see `runUntilBlocked()`), while `run()` and `step()` leave the next instruction to the next call. Given at any other time, the input waits for the program's next read: input given after a build, or after a run ended, is the next run's. What a run was given and did not read is forgotten when it ends or is started over.

`read`, `readv`, `preadv2` at the current position (offset -1) and the descriptors above all read the same queue. The terminal has no file position: `pread64`, `preadv`, `pwrite64`, `pwritev` and `lseek` answer ESPIPE, and `sendfile` from it EINVAL (ESPIPE with an offset), as Linux, which splices only from files, does. It answers the requests a Linux pseudo-terminal answers:

- `TCGETS` gives the settings a terminal starts each program with: `ICRNL | IXON | IUTF8`, `OPOST | ONLCR`, `B38400 | CS8 | CREAD` and `ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN`, with Linux's control characters, `VMIN` 1 and `VTIME` 0. That is canonical input, echoed, with Enter read as a line feed and Backspace erasing a whole UTF-8 character, which is what the host's line discipline is expected to do before it calls `provideInput()`. `TCSETS`, `TCSETSW` and `TCSETSF` store the termios they are given, `TCSETSF` after discarding the input no read took; `TCGETS2` and the `TCSETS2` family do the same with the speed `c_cflag` gives.
- `TIOCGWINSZ` gives 80 columns by 24 rows, since the host's terminal has no fixed grid; `TIOCSWINSZ` succeeds and changes nothing.
- `TIOCGPGRP` and `TIOCGSID` give the process's group and session, which the terminal leads it in; `TIOCSPGRP` accepts only that group.
- `FIONREAD` counts the bytes no read has taken; `TCFLSH` with `TCIFLUSH` or `TCIOFLUSH` drops them and any End of input; `TIOCOUTQ` is 0, `TCSBRK` and `TCXONC` succeed.
- Any other request answers ENOTTY, except those every descriptor takes (`FIONBIO`, `FIOCLEX`, `FIONCLEX`).

`poll` and `select` report the terminal readable when input bytes or an End of input token are queued, in raw mode with `VMIN` and no `VTIME` when `VMIN` bytes are. A timed or indefinite poll of an empty terminal suspends the instruction asynchronously; `getStatus()` says `Waiting`, and the `waitRequest` event has `wakeSources.terminal` true and `terminalRead` false. `provideInput()` wakes that poll without consuming the input. An empty terminal read with `O_NONBLOCK` returns EAGAIN immediately, but for a raw one with neither `VMIN` nor `VTIME`, which returns 0.

**Undo.** What each read takes is journaled in the history, so a read is not an Undo barrier, and Undo follows [ADR 0069](../../../docs/adr/0069-x86-journals-the-input-its-reads-take.md): a read that waited for its input asks again, so neither what it took nor the rest of what arrived while it waited, a line it read only part of, is put back; what a read found already queued, type-ahead, goes back at the front of the queue, End of input included. What `TCFLSH` or `TCSETSF` discarded goes back too, and Undo of a `TCSETS` puts the termios back, with a `terminalMode` event. The terminal transcript is not rewound; ordinary stdout/stderr writes do not form barriers.

### Devices

The machine has the devices of the QEMU guest x86's devices follow ([ADR 0067](../../../docs/adr/0067-x86-devices-follow-a-qemu-guest.md)): `/dev/fb0`, `/dev/tty0`, `/dev/input/event0` to `event4` (the Power Button, the AT keyboard, the PS/2 mouse, QEMU's USB tablet and the PC Speaker), `/dev/dsp`, `/dev/mixer`, the raw MIDI ports at `/dev/snd/midiC1D0` to `midiC1D3` and `/dev/midi1`, udev's links under `/dev/input/by-path/` and `/dev/input/by-id/`, and `/proc/bus/input/devices`. One table in the Core says each node's path, its Linux device number and what it is; the wrapper makes the nodes from it, and every start puts them back. A program's `open()` finds the device by the number of the node it reached, through a link or not, and `stat()` answers that number. The numbers, names and links are the guest's as far as they are known, provisional until it is booted.

The nodes the guest has but this machine does not cover, `/dev/dri/card0`, ALSA's `controlC0`, `pcmC0D0p`, `pcmC0D0c` and `seq`, `/dev/input/mice`, `mouse0` and `mouse1`, and `/dev/audio`, exist, and opening one fails with ENODEV and raises `unsupportedDevice` with the node's path, for the host to say what to use instead. There is no `/dev/sequencer` or `/dev/music`, as in the guest.

What `open()` makes is an open file description, which `dup()` shares, with its status flags (`O_NONBLOCK` set through one descriptor holds for every copy), and which the last `close()` releases. An ioctl a descriptor does not know answers ENOTTY, on every descriptor, as Linux does, but where the driver answers otherwise: evdev and `/dev/dsp` answer EINVAL and `/dev/mixer` ENXIO, as evdev, snd-pcm-oss and snd-mixer-oss do; a request that carries its size is matched on its type and number whatever size it names. Each device is described below:

- `/dev/fb0` is [the framebuffer](#the-framebuffer);
- the input devices are evdev's, see [Input devices](#input-devices);
- `/dev/dsp`, `/dev/mixer`, the raw MIDI port and the PC speaker are the [Sound](#sound) devices; `/dev/tty0` sounds the speaker, is a tty (`TCGETS` answers the virtual console's settings, so `isatty()` holds), takes writes and never yields a read.

A wait's `wakeSources` say what can end it besides its deadline: `terminal`, input given to the terminal, and `inputDevices`, events reaching the keyboard or the tablet, the only input devices a host delivers events to. A device that keeps time, such as `/dev/dsp` or the MIDI port draining or the framebuffer's next vertical blank, folds the moment it is ready into the deadline. A blocking write Blink starts over after a wait goes on from what it already queued, which the open file description keeps for that instruction alone.

### The framebuffer

`/dev/fb0` answers as Linux's DRM fbdev emulation does on the guest's bochs display (`drm_fbdev_ttm` behind `fb_chrdev.c`, Linux 6.12): one little-endian `0x00RRGGBB` word a pixel, XRGB8888, over two pages. Its size is the machine's display mode, which `setDisplayMode({ width, height })` sets for the next program start, as the guest's `video=` does: a width that is a multiple of 8 and a height, both 8 to 1024, 320×240 until set. A program reads it and never changes it.

```ts
emulator.setDisplayMode({ width: 320, height: 240 }) // from the next start on
await emulator.run()
const framebuffer = emulator.getFramebuffer() // null until the program opens /dev/fb0
if (framebuffer) {
    const page = framebuffer.visible() // height × lineLength bytes, a view of the wasm heap
    const xrgb = new Uint32Array(page.buffer, page.byteOffset, page.length / 4)
    const rgba = new Uint32Array(image.data.buffer) // an ImageData of width × height
    for (let i = 0; i < rgba.length; i++) {
        const word = framebuffer.blanked ? 0 : xrgb[i]! // lineLength is width × 4
        rgba[i] = 0xff000000 | ((word & 0xff) << 16) | (word & 0xff00) | ((word >> 16) & 0xff)
    }
}
```

- `FBIOGET_FSCREENINFO` gives `id` `bochs-drmdrmfb`, `smem_start` 0 (hidden, as DRM hides it), `smem_len` the buffer's size, `width × 4 × height × 2` rounded up to whole pages, `FB_TYPE_PACKED_PIXELS`, `FB_VISUAL_TRUECOLOR`, `xpanstep` and `ypanstep` 1, `ywrapstep` 0, `line_length` `width × 4` and `FB_ACCEL_NONE`.
- `FBIOGET_VSCREENINFO` gives the mode as `xres` and `yres`, `xres_virtual` the width and `yres_virtual` twice the height (`drm_fbdev_overalloc=200`), the offsets, 32 bits a pixel with red at 16, green at 8 and blue at 0, eight bits each and no transparency, and the display's size in mm, 320 by 200 (QEMU's EDID), with every timing 0.
- `FBIOPUT_VSCREENINFO` answers as `drm_fb_helper_check_var()` does: a size up to the buffer's and at least 8 by 8 is accepted and read back while the scanout keeps showing the whole mode, a depth of 32 or less reads back as 32, a pixel clock is cleared, and a larger size, a larger virtual size, grayscale, `nonstd` or a pixel format other than the device's, explicit or not, answers EINVAL; all fields zero takes the device's. A new `yoffset` pans. `FB_ACTIVATE_TEST` checks without setting, and `FB_ACTIVATE_INV_MODE` refuses the mode in use.
- `FBIOPAN_DISPLAY` pans within what the screen information's size leaves of the buffer (EINVAL past it, and for `FB_VMODE_YWRAP`), and answers ENOSPC where the whole mode would not fit, as DRM's commit does. A double-buffering program draws on the page it does not show and pans to it.
- `FBIO_WAITFORVSYNC` waits until the next 1/60 s boundary of Program time, a wait with that deadline and no wake source that a signal does not end; in a Testcase the virtual clock moves to it. It reads no argument.
- `FBIOBLANK` takes `FB_BLANK_UNBLANK` to `FB_BLANK_POWERDOWN` (EINVAL above): anything but unblank turns the display off, `blanked` says so, and the next pan or size set turns it on again. `FBIO_CURSOR` answers EINVAL, and any other request ENOTTY, `FBIOGETCMAP`, `FBIOPUTCMAP` and the console map requests included, which the guest would answer.
- `mmap` of `MAP_SHARED` points the guest's pages into the one buffer, every page present, so every mapping, `read` and `write` see the same bytes, and `munmap` never gives its pages back. A range past `smem_len` answers EINVAL, where the guest would map it and raise SIGBUS at the first touch past the end. `MAP_PRIVATE` is a copy made at `mmap`, as a private mapping of a file is here; the guest's is copy-on-write, so a page not yet written there still shows later changes.
- `read`, `write`, `pread64`, `pwrite64`, `readv` and `writev` reach the same buffer at the open file description's offset, which `dup()` shares, as `fb_sys_read()` and `fb_sys_write()` do: short at the end of `smem_len`, a read past it 0, a write at it ENOSPC and past it EFBIG. `lseek` takes any offset from 0 on (`SEEK_END` counts from 0, `SEEK_DATA` and `SEEK_HOLE` find no data), and `preadv2` and `pwritev2` take no flag but `RWF_HIPRI`. `fsync` and `fdatasync` present.
- The buffer is made black when the program first opens `/dev/fb0` and lasts, as the program left it, until the next program starts or the session is cleared; a program that opens it again finds it as it was.

The `framebufferPresent` event, with the line the scanout starts at, comes at every pan that took, `FBIOPUT_VSCREENINFO` included, at `fsync` and `fdatasync`, when `FBIOBLANK` turns the display off or on, and when Undo moves the scanout or blanks it. A host shows the visible page then, at the end of every run slice and at every wait; nothing else marks what changed, so it reads the whole page, which the view gives without a copy. `visible()` is made again when the wasm heap has grown or the scanout moved, and the object `getFramebuffer()` returns reads every property from the Core when asked.

**Undo.** A store through a mapping is an ordinary memory write, and a `rep stosd` clearing a whole page stays one undoable step. What a `write` replaces, the offset `read`, `write` and `lseek` move, and the screen information, pan and blank the ioctls change are journaled too, so none of them is an Undo barrier; a read into memory larger than the 64 KiB one instruction keeps is, as for any File. Opening `/dev/fb0` and mapping it stay barriers, as every descriptor and mapping change is.

### Input devices

`/dev/input/event0` to `event4` are evdev devices with the identities and capabilities Linux 6.12's drivers give the guest's Power Button, AT keyboard (translated set 2), PS/2 mouse (IntelliMouse Explorer), QEMU 10.0 USB tablet and PC Speaker: `EVIOCGNAME`, `EVIOCGPHYS`, `EVIOCGUNIQ`, `EVIOCGID`, `EVIOCGVERSION`, `EVIOCGPROP` and `EVIOCGBIT` for every type answer as there, and `/proc/bus/input/devices` lists the same bits. Every program starts on a machine just booted: nothing held, no LED lit, the tablet at 0, 0.

The host delivers what the user does with `sendInputReport(device, events)`, one host event at a time, to `'keyboard'` or `'tablet'`, as Linux `struct input_event`s without their times (`X86InputEvent`):

```ts
emulator.sendInputReport('keyboard', [{ type: 1, code: 30, value: 1 }]) // EV_KEY, KEY_A, down
emulator.sendInputReport('tablet', [
    { type: 3, code: 0, value: 16384 }, // EV_ABS, ABS_X: floor(x × 32767 ÷ width)
    { type: 3, code: 1, value: 8000 }, // ABS_Y
    { type: 1, code: 0x110, value: 1 } // BTN_LEFT
])
emulator.sendInputReport('tablet', [{ type: 2, code: 8, value: 1 }]) // REL_WHEEL, a notch away
```

The Core turns them into what the guest's hardware and drivers make of them. A key, `EV_KEY` with a `KEY_*` code and 1, 2 or 0, becomes the scan codes QEMU's PS/2 keyboard sends for it, which atkbd reads into `MSC_SCAN` (the set 1 code, 0x80 for an E0 prefix), the key and `SYN_REPORT`: a key held is a repeat, value 2, a make code within half the repeat delay of the first is dropped as atkbd drops a double press, Pause goes down and up at once and sends nothing as it is released, and Print Screen is `0xb7`. A key the AT keyboard does not have is ignored. Caps Lock, Num Lock and Scroll Lock going down toggle the console's locks, which light the LEDs in a packet of their own after the key's, as the console's keyboard handler does, unless a reader holds `EVIOCGRAB`. The pointer, `BTN_LEFT`, `BTN_RIGHT` and `BTN_MIDDLE`, `ABS_X` and `ABS_Y` from 0 to 32767 and `REL_WHEEL` notches, is QEMU's tablet's next HID report through hid-input: each button that changes with its HID usage (`0x90001` to `0x90003`) as `MSC_SCAN`, the axes that moved, clamped to their range, `REL_WHEEL` and `REL_WHEEL_HI_RES` at 120 a notch, and `SYN_REPORT`. Events of other types and codes, and the `MSC_SCAN`, `EV_LED` and `SYN_REPORT` events the Core adds itself, are ignored. The packets are stamped with Program time (the environment's `now`) and queued for every reader of the device, or only the one holding the grab; with no reader they are dropped and the device's state still changes. A read or `poll` waiting on the device resumes. Nothing happens without a running program, and a Testcase should never call it.

Each `open()` is a reader with a queue of its own, 4,096 events where Linux's keyboard has 64; once a reader is that far behind, what it did not read is dropped for a `SYN_DROPPED` and the newest event, as evdev does. A read takes whole 24-byte events of the packets complete so far (EINVAL for a smaller buffer), waits for one unless `O_NONBLOCK` (EAGAIN), with the keyboard or the tablet in its `waitRequest`'s `wakeSources.inputDevices`; `poll` is always writable and readable once a packet is queued. Event times are in the reader's clock, `CLOCK_REALTIME` until `EVIOCSCLOCKID` asks for `CLOCK_MONOTONIC` or `CLOCK_BOOTTIME`, which throws the queued events away for a `SYN_DROPPED`.

The state ioctls answer as evdev does: `EVIOCGKEY`, `EVIOCGLED`, `EVIOCGSND` and `EVIOCGSW` answer the state now and throw away that reader's queued events of their type; `EVIOCGABS` answers the tablet's axes (0 before any movement) and `EVIOCSABS` sets them; `EVIOCGREP` answers the keyboard's 250 and 33 ms, `EVIOCSREP` reads back atkbd's rounded values and changes no repeat, which are the host's; `EVIOCGRAB` is exclusive (EBUSY for a second); `EVIOCGMASK` and `EVIOCSMASK` filter a reader's events; `EVIOCREVOKE` ends a reader; `EVIOCGKEYCODE` and `EVIOCSKEYCODE` read and change the keyboard's keymap. An ioctl evdev does not know answers EINVAL, as evdev answers it, whatever its type. A write takes whole events, at most 170 at a time (EINVAL for less than one), and injects them as evdev does: an `EV_LED` lights the keyboard's LED, and an `EV_SND` reaches the PC Speaker's driver.

Undo (ADR 0069): what a read took goes back at the front of its reader's queue, whether or not it waited for it, and so do the events an `EVIOCGKEY` and its relatives or `EVIOCSCLOCKID` threw away; the clock, the grab, a mask, an axis's absinfo, and what a write or `EVIOCSREP` delivered and changed are taken back too. The keys held, the pointer and the LEDs the lock keys set are live: after Undo the state ioctls answer the state as it is now. A queue that overflowed since cannot get its dropped events back. `EVIOCREVOKE` and `EVIOCSKEYCODE` are Undo barriers.

### Sound

The sound devices are the guest's (x86-devices.md): OSS's `/dev/dsp` and `/dev/mixer` on its HDA card, QEMU's `hda-duplex` codec as Linux 6.12's snd-pcm-oss and snd-mixer-oss present it; snd-virmidi's raw MIDI ports, its four devices at `/dev/snd/midiC1D0` to `midiC1D3` and device 0 again at `/dev/midi1`, all played by the one synthesizer; the PC speaker. Nothing in the Core plays: what each device would play leaves it as a timeline on Program time's monotonic clock, in nanoseconds, the moment it is decided, for the host to schedule. Each device keeps its time lazily, worked out from Program time whenever a call asks, so a Testcase's virtual clock paces it as a real clock does, and Pause changes nothing.

**`/dev/dsp`** opens at 8000 Hz, unsigned 8-bit, mono. `SNDCTL_DSP_GETFMTS` answers snd-pcm-oss's fixed mask (μ-law, U8, S8, S16 and U16 in both byte orders, S24 in both and packed, S32 in both; no A-law), and `SETFMT`, `SPEED`, `CHANNELS` and `STEREO` write back what they set: U8 for a format outside the mask, a rate clamped to 1000 to 192000 Hz, 1 to 128 channels (EINVAL above). One description at a time holds playback; a second open for writing answers EBUSY. The card plays 16-bit stereo at 16 to 96 kHz, so snd-pcm-oss converts through plugins, and the fragment it chooses comes out of that conversion: at the default format 32 fragments of 2 KiB (the 8 kHz stream goes through a rate plugin to the card's 16 kHz, which halves the 4 KiB `snd_pcm_oss_period_size()` chooses), at 44.1 kHz 16-bit stereo set rate first 32 of 16 KiB, and 32 of 32 KiB when the rate is set last, since the kernel computes part of the new size with the rate plugin still in the chain. `SNDCTL_DSP_SETFRAGMENT` works once (EINVAL after), as does `SUBDIVIDE`; a setting that changes after samples were queued drops them, as the reconfiguration does on Linux. A write stages bytes until a fragment is full and gives the card whole fragments: a write shorter than a fragment stays silent until the fragment fills, `SNDCTL_DSP_SYNC` or `close()`. A blocking write waits for room, the card draining at its rate; with `O_NONBLOCK` it gives what fits and answers EAGAIN when nothing does, and `poll` reports `POLLOUT` once a fragment is free. `GETOSPACE`, `GETODELAY`, `GETOPTR` and `GETBLKSIZE` report the buffer as snd-pcm-oss does, an underrun included; `SYNC` pads the staged fragment with silence and waits until everything has played; `RESET` drops it all; `POST` starts nothing a write did not start already; `GETCAPS` answers `DSP_CAP_TRIGGER | DSP_CAP_REALTIME` and revision 1, `DSP_CAP_DUPLEX` for a description opened for reading too, and no `DSP_CAP_MMAP`. The mixer's requests work on `/dev/dsp` too. `close()` of the last descriptor holding playback pads the staged fragment and waits until the buffer has played, a signal ending the wait; `exit` plays the staged fragment out without waiting; a signal that ends the program drops what was queued. Not covered: reading (recording), `mmap`, turning the trigger off with `SETTRIGGER` (EINVAL), `GETISPACE` and `GETIPTR` (EINVAL).

Each fragment reaches the host as `pcm`: `start`, when its first frame plays; `rate`, the program's; `frames`, stereo floats from -1 to 1, interleaved, every format decoded. A mono stream is on both sides; of more channels the first two are kept, as the kernel's route plugin keeps them. The host resamples.

**`/dev/mixer`** has the card's channels: `VOLUME` ("Master") and `IGAIN` ("Capture"), both stereo, at 73 and 100, the levels `alsactl init` gives a card with no saved state. A write clamps each side to 100 and reads back what it set; a channel the card has no control for, `PCM` among them, keeps what it was written, mono, and changes nothing. `SOUND_MIXER_INFO` names the card's driver, `HDA-Intel`, and codec, `QEMU ID 22`, with a count of the controls writes changed. `mixer` reports the gains that apply to `/dev/dsp`, `volume` and `pcm`, `[left, right]` from 0 to 100, at each start of a program and at every change: `pcm` stays `[100, 100]` on this card. The channel's level is the amplifier's step, which QEMU applies linearly. The levels are provisional until the pinned guest is booted.

**The raw MIDI port** takes the whole MIDI byte stream behind rawmidi's 4 KiB buffer, sending at MIDI's 31,250 baud on Program time (320 µs a byte): a blocking write waits for room, keeping what it queued each time Blink starts it over; one through `/dev/midi1` or with `O_APPEND` (which needs `O_NONBLOCK`, EINVAL otherwise) is atomic, and EIO when larger than the buffer; `O_DSYNC` waits until everything has left. Every open of every device shares one substream, its buffer and its running status, a documented deviation: Linux gives each of the four devices sixteen substreams, and an ALSA open without `O_APPEND` a free one of its own, with a buffer and running status of its own, so that only OSS opens and `O_APPEND` opens of one device share. The bytes are parsed as the kernel's sequencer encoder parses them, and each complete message reaches the host as `midi` with the time its last byte leaves: running status expanded, a SysEx `F0` to `F7` whole. Real-time bytes (`F8` to `FF`) and system common messages take their time on the port and are not handed on, nor is a SysEx longer than the encoder's 256 bytes, since FluidSynth ignores or mangles them. `PVERSION` (2.0.4), `INFO` (card 1, the node's device, `VirMidi`, `Virtual Raw MIDI`, 16 subdevices), `USER_PVERSION`, `PARAMS` (which drains first, a buffer of 32 bytes to 1 MiB), `STATUS`, `DROP` and `DRAIN` answer as rawmidi does; anything not of type `'W'` answers ENOTTY. `close()` of the last descriptor drains it, sending an active sensing byte first when `PARAMS` asked for one. A read never yields a byte, nothing playing into the port.

**The PC speaker** is one square wave at 1193182 ÷ ⌊1193182 ÷ f⌋ Hz, or silence, reported as `tone` at each change. An `EV_SND` event written to `/dev/input/event4` sets it as the pcspkr driver does: `SND_TONE` with a frequency between 20 and 32767 Hz exclusive, silence otherwise, `SND_BELL` 1000 Hz for any value but 0. `/dev/tty0`'s `KIOCSOUND` takes the timer's divisor (0 for silence) and `KDMKTONE` the divisor in its low 16 bits and a duration in milliseconds above, rounded up to the guest's 4 ms jiffies, after which the speaker falls silent; either cancels a `KDMKTONE` still running. Only root may use them (EPERM otherwise), as on the guest, where `/dev/tty0` is not the controlling terminal. They reach the speaker as the console's `kd_mksound()` does, through the input core: `SND_TONE` with the frequency, and `SND_BELL` 0 after it for silence, injected into `/dev/input/event4`, so its readers see them, and `EVIOCGSND` too. Like every event the input core passes on, they wait in the packet being built until a `SYN_REPORT` closes it or eight values fill it, which the input core then closes itself; a reader holding `EVIOCGRAB` on the device keeps them out, and the speaker does not sound. The silence at the end of a `KDMKTONE` is injected the same way, and reaches the device the next time a reader of it reads, polls, writes or asks; a grab taken while that tone sounds does not keep its end out, as it would on the guest.

**Undo** follows ADR 0059. Each device journals what an instruction did to it, so writing to `/dev/dsp` or the MIDI port and their ioctls are not Undo barriers. Undo puts the settings back, `/dev/dsp`'s format, rate, channels, fragments and staged bytes, the mixer's levels (with a `mixer` event), the port's buffer settings and the speaker's tone, and takes back the samples and bytes the undone instructions queued that have not been heard: a `soundCut` with the device drops them from the host's schedule. Nothing heard plays again, and Program time does not rewind. What a `RESET`, a `DROP` or a reconfiguration dropped is not brought back, as Undo never restarts a stopped sound. For the MIDI port, Undo of a write whose messages reached the synthesizer sends what puts each channel's program and bank, controllers, RPN parameters, pitch bend and pressure and the master volume back as they were, and a note-off for each note the write started; notes it ended do not start again. The speaker's tone is put back and sounds again if it was sounding, as a chip's register would. Opening and closing a device stay barriers.

At the end of the machine, `clearExecution()` or the next start, a `soundCut` without a device drops everything scheduled. What to do at the end of a program, releasing held notes or silencing the speaker, is the host's.

### Each run starts afresh

Every start of the program, whether after a build or again after it ended, is a new process on a new file system. Descriptors the last run left open are closed, and 0 to 2 are the terminal again, whatever that run closed or replaced, so the first file a program opens is 3. The file system holds `/dev`, `/proc` and an empty `/tmp`, as the module started with them, and the working directory, `X86_WORKING_DIRECTORY` (`/project`), empty and current: whatever an earlier run created, wherever it did, is gone, and whatever it removed or changed under `/dev`, `/proc` and `/tmp` is back. A build starts from the same file system.

The program never finds the toolchain: its own executable is written out for the loader and removed before its first instruction, and the linker, the assembler, the objects and the staged Files are gone by then. `getExecutable()` returns the executable the last build linked, or the one `loadElf()` was given.

This differs from 4.x, where the callbacks received one byte per call, a `stdin` callback supplied input byte by byte, `provideInput(line)` replaced what the last read had left, `readv` and `dup`'d descriptors read nothing, standard streams were not ttys, and descriptors, files and a `close(1)` carried over from one run to the next.

### Project Files and session lifecycle

`mountProjectFileSystem(capability: X86ProjectFileSystem | null)` attaches a synchronous structural capability at `/project`. The exported type matches the editor's `FileSystemSession` without importing editor code. Pass `performInstruction`, `open`, `close`, positional `pread`/`pwrite`, `truncate`/`ftruncate`, `stat`/`fstat`, `list`, `rename` and `remove` (see `src/project-file-system.ts` for their exact types). Paths passed to the capability are Project-relative. A guest FileSystem error is an exception with a supported POSIX `code` such as `ENOENT`, `EEXIST`, `EBADF`, `ENOSPC` or `EFBIG`; the Core translates it to the guest's Linux errno.

```ts
const result = await emulator.compileProject(project)
if (!result.ok) throw new Error(result.report)
emulator.initialize(500)
emulator.setEnvironment(runSources)
emulator.mountProjectFileSystem(session)
// Register/memory inspection and presets can load the process; mount before these too.
await emulator.run(100000)
// Stop must detach and cancel native execution before the host ends its capability.
emulator.clearExecution()
session.stop()
```

Every capability mutation runs inside `performInstruction(exactSerial, operation)` before its effects. Serials are opaque decimal strings; keep them as strings, including with history capacity zero. Multiple callbacks of one syscall have the same serial and the capability must coalesce them into one instruction frame. Metadata lookup may happen during loading without a serial; mutations without an active instruction are refused. Positional capability I/O avoids advancing its own cursor as well as Emscripten's. Emscripten owns shared dup offsets; the last close closes the capability handle. Linux positional writes on O_APPEND append while preserving that shared offset; pwritev2 with RWF_NOAPPEND instead honors the requested position and preserves shared append flags even on failure. Open-unlink and unlink/recreate keep the old handle's File alive for reads, writes, fstat and ftruncate.

The capability owns content and File-count limits (the editor uses 16 MiB / 4,096 Files), and checks expected guest errors before changes. Open/create/truncate are deferred into its atomic `open`; both the guest descriptor limit and a capability refusal leave Files unchanged. Seeking past the content limit is allowed and a later write enforces capacity. A capability must return a Uint8Array of at most the requested read length and an integer write count between zero and the request length. Unexpected exceptions or malformed results stop with `X86EnvironmentError` and the original useful message, after native syscall cleanup. Any potentially partial mutation remains a barrier. If a later readv callback raises a guest error, Emscripten may return that errno rather than Linux's earlier partial byte count; earlier bytes and cursor changes remain irreversible. writev/pwritev gather their payload into one capability write, whose capacity check is atomic. sendfile commits source cursors and explicit offsets only for bytes actually transferred, and a rejected first write leaves them unchanged.

Directories are implicit path prefixes, listed through `stat`/`list` without opening a capability handle. Parent Directories must exist when creating or renaming a File through Linux paths. Empty Directory creation/removal, Directory moves, replacement rename, links and persistent permission/owner/time changes have no session representation. Directory creation/removal and persistent metadata changes return EOPNOTSUPP; links fail because the mount supplies no link operations, and replacement rename returns EEXIST. Mounted nodes expose synthetic mode 0777, uid/gid zero and epoch timestamps; unlink reports link count zero through retained File handles. A Directory disappears with its last File; open Directory lifetime consequently follows the capability's implicit-Directory model. A private mapping of a regular File on this mount is a copy read through the capability's `pread`, as any read of the File is; a shared one returns ENODEV before replacing any prior map.

Attach a fresh capability after each successful Build/loadElf and before the first process load. The compiler stages under `/__x86_project`, outside the mounted `/project`; builds detach the old capability first and do not write compiler artifacts into it. Build, loadElf, clearExecution and dispose detach before old native descriptors are cleaned up, so cleanup never calls an ended session. Reusing a completed process start without a new Build/loadElf drops the old mount; use a fresh Build/loadElf and capability per interactive run or Testcase.

`clearExecution()` cancels wait transport, timers, pending instruction and scheduled continuations, detaches the capability, closes native descriptors, frees the process, clears input and History, and returns to `BlinkState.Ready`. It preserves registered callbacks and configured sources for recompilation, and repeated calls are harmless. End the host capability afterward. Calling it during an open Poke, a native instruction callback, or an active Build throws; it is available while a read/wait is pending and between asynchronous Run slices. `dispose()` also clears execution and then removes callbacks. Mount changes are guarded during execution, a Poke, a pending read/wait, a Build and after process loading; Stop uses `clearExecution()` rather than replacing an active mount.

### System calls

`getImplementedSyscalls()` lists the Linux system calls the Core implements, sorted by number, with the name Linux's x86-64 table gives each (`pread64`, `newfstatat`) and how many argument registers it reads. The list is read from the dispatch table the wasm was compiled with, so it is exactly what a program can call; any other number answers ENOSYS, as Linux does for a call it lacks. It needs no program and never changes, so a documentation generator can read it once:

```ts
const emulator = await createX86Emulator()
emulator.getImplementedSyscalls()
// [{ number: 0, name: 'read', arity: 3 }, { number: 1, name: 'write', arity: 3 }, ...]
```

Every call behaves as it does for a Linux process on a terminal. The ones that need state the host does not keep are emulated by blink and checked against Linux, call by call, by `tests/linux-syscalls.test.ts`, which runs each probe in the Core and natively:

- `brk` keeps the break exactly where it is asked to go, refuses to move it below where the heap started or within a page of another mapping, and returns the break either way.
- `prlimit64`, `getrlimit` and `setrlimit` keep every limit, starting from the ones Linux gives its first process (an 8 MiB stack, 1024 open files of a hard 4096, ...). Blink enforces `RLIMIT_AS` and `RLIMIT_NOFILE`; the others are only reported.
- The process starts as root, as its host reports it, and `setuid`, `setreuid`, `setresuid`, their group forms and `setgroups` change its ids by Linux's rules: it holds `CAP_SETUID` and `CAP_SETGID` while its effective user id is 0, so dropping all three user ids drops root for good.
- `prctl` keeps the name (`PR_SET_NAME`, initially the program's file name), the parent death signal, dumpability, `no_new_privs` and the RDTSC trap (`PR_SET_TSC`); other options answer EINVAL.
- `sysinfo` describes the machine blink models: 8 GiB of memory less what the program keeps resident, one process, and up since the boot clock started.
- `sched_getaffinity` reports one CPU.
- `preadv2` and `pwritev2` take their flags from the sixth register, as Linux does. `RWF_HIPRI`, `RWF_DSYNC`, `RWF_SYNC`, `RWF_APPEND`, `RWF_NOAPPEND` and `RWF_NOSIGNAL` work; `RWF_NOWAIT`, `RWF_ATOMIC` and `RWF_DONTCACHE` answer EOPNOTSUPP, as Linux does on a file system without them.
- `renameat2` takes `RENAME_NOREPLACE` and `RENAME_EXCHANGE`; `RENAME_WHITEOUT` answers EINVAL, as on a file system without whiteouts.
- `O_TMPFILE` opens an unnamed file, and `fstatat` and `fchownat` take `AT_EMPTY_PATH`.
- The clocks Linux adds to POSIX's read the host clock that keeps their time: `CLOCK_MONOTONIC_RAW`, `CLOCK_MONOTONIC_COARSE` and `CLOCK_BOOTTIME` the monotonic clock, `CLOCK_REALTIME_COARSE` and `CLOCK_TAI` the wall clock (Linux keeps TAI there until something sets its TAI offset). `clock_getres` reports Linux's resolutions, a nanosecond, or a 250 Hz tick for the coarse clocks.
- `select` and `pselect6` write back the time left, as Linux does, and touch only the bytes of the descriptor sets that `nfds` covers.

`getrandom`, `pipe` and `pipe2` are available. Pipes keep an in-process byte queue of 65,536 bytes, with atomic writes up to 4,096 bytes, shared endpoint flags and lifetime across duplicates, EOF after the last writer closes, and SIGPIPE/EPIPE after the last reader closes. Pipe `fstat` describes a FIFO; `FIONREAD` counts its queued bytes. Nonblocking reads and writes return EAGAIN when they cannot proceed. Positioned I/O on a pipe returns ESPIPE. This is a single-process transport; `fork` is not provided.

File system calls work on Emscripten's in-memory file system, reset at every start (see [Each run starts afresh](#each-run-starts-afresh)). Undo restores registers, flags, the FPU and memory, and the terminal's input and termios, not other syscall-owned state: an undone `brk`, `setuid` or `setrlimit` stays done, and so does a read of pipe input. External random stream positions also need a host journal to rewind them; the Core exposes instruction identities for that purpose but does not keep such a journal.

### Clock, random and asynchronous waits

Pass `environment` to `createX86Emulator()`, or call `setEnvironment()` before the program starts. `compile()` and `compileProject()` build an executable; they do not load the guest process. `initialize()` prepares debugger history, and the first `step()`, `run()` or `runUntilBlocked()` loads the process. Select clock and random sources and mount the run's FileSystem before that first execution call, before applying register or memory presets that start the process. `loadElf()` replaces the executable and abandons any pending instruction; it also loads the process only on execution. Each actual start resets the process file system before loading, preserving a newly attached `/project` capability and dropping compiler staging.

`now(clock)` returns finite, nonnegative milliseconds for the effective Linux clock: 0 for realtime, 1 for monotonic, 2 and 3 for process and thread CPU time. The same source supplies clock syscalls, guest RDTSC and wait deadlines. `nanosleep`, poll and select timeouts use monotonic time; `clock_nanosleep`, relative or absolute, uses its requested effective clock, and a futex wait uses monotonic time, or realtime with `FUTEX_CLOCK_REALTIME`. `random(length, instructionSerial)` must return exactly `length` bytes. One source covers loader `AT_RANDOM`, `getrandom`, `/dev/random`, `/dev/urandom`, RDRAND and RDSEED. Loader draws have a null identity; instruction draws carry the active decimal serial. The assembler and linker always use host clock, entropy and wait transport, so compilation consumes none of the selected program sources. Replacing sources while an instruction is waiting is rejected.

`nanosleep`, `clock_nanosleep`, `select`, `pselect6`, `poll`, `ppoll`, `pause`, `rt_sigsuspend`, blocking pipe operations and blocking reads and writes of devices halt without waiting on the JavaScript thread. `getWaitRequest()` and the `waitRequest` event expose the effective `clock`, absolute `deadlineNanoseconds` as a bigint, `remainingMilliseconds`, `wakeSources` (see [Devices](#devices)), `terminalRead`, and the waiting `instructionSerial`. `remainingMilliseconds` is the deadline less `now(clock)`, taken in whole nanoseconds as the guest compares them, so it stays above zero for as long as the instruction waits, even on a real-time clock where a double cannot hold every nanosecond. A null deadline means the instruction needs an external wake source. Only a wait that asks for a readable terminal descriptor has `wakeSources.terminal`; an empty pipe, `pause`, or a sleep does not. `terminalRead` says whether the waiting instruction is a read of the terminal, a raw read `VTIME` times, which takes the input that ends the wait, rather than a `poll` or `select` that only looks at it: a host that journals what a key typed during the wait does, such as its echo, gives it to the read's instruction then and to no instruction otherwise. A read with nothing to time it out never makes a wait request; it is an input request (`WaitingForInput`).

With no `wait` hook, finite waits use a host timer and indefinite waits remain suspended. The optional `wait(request, signal)` hook resolves to wake the instruction, or rejects to cancel it with EINTR. An early wake can suspend again with the original deadline and the same serial. For a virtual clock, advance the clock to a finite deadline before resolving; leave an indefinite wait pending until input or a signal can wake it, or cancel it and report a scripted-run failure. Repeatedly resolving an indefinite wait would create a spin.

```ts
import type { X86WaitRequest } from '@specy/x86'

const environment = {
    now: (clock: number) => (clock === 0 ? virtualRealtimeMs : virtualMonotonicMs),
    random: (length: number) => seededBytes(length),
    wait: async (request: X86WaitRequest, signal: AbortSignal) => {
        if (request.deadlineNanoseconds === null) {
            await externalWake(signal) // Reject when the script has no possible wake source.
        } else {
            advanceVirtualClock(request.clock, request.deadlineNanoseconds)
        }
    }
}
emulator.setEnvironment(environment)
```

`resumeWait()` explicitly retries the pending instruction; `cancelWait()` retries it with EINTR, including remaining-time writes and temporary signal-mask restoration. Both return whether a wait was present. A wake completes only the blocked instruction when driven by `step()` or `run()`; the caller chooses when to execute subsequent instructions. `run()`, `step()`, Pokes, Undo and `initialize()` are guarded while an instruction is pending. A new compile, `loadElf()`, or `dispose()` abandons the old instruction, aborts its transport and prevents a late promise from resuming the replacement program. Clock/random hook failures preserve their original message; execution failures throw `X86EnvironmentError`, and loader failures expose the message in the stop reason.

`getInstructionsExecuted()` returns a module-wide bigint count of completed native instructions. It includes tool execution and exit instructions, excludes faulting or still-blocked instructions, and keeps increasing through Undo, Pokes, history changes and program replacement. Take a difference around guest execution to measure guest instructions. `getRecordedEntryCount()` continues to count recorded history entries, including Pokes, and stays unchanged with zero history capacity. `getCurrentInstructionSerial()` returns the active decimal identity, or null between instructions; history rows expose the same identity as `serial`. Identities are assigned before callbacks even with history disabled, stay stable across wait replay, and are fresh after Undo. Treat them as opaque strings or convert to bigint, never to a JavaScript number. These counters use bounded native state rather than a growing identity journal.

`kill`, `tkill` and `tgkill` send signals only to this guest process or its one thread. They never signal a host process. `wait4` returns ECHILD because the guest cannot create children. `alarm`, `getitimer` and `setitimer` support ITIMER_REAL using the selected monotonic clock, so changing the wall clock does not shift an armed timer. Alarm delivery is checked when a wait wakes and at the start of an execution slice. A timer also wakes an empty terminal read; without SA_RESTART that read returns EINTR, and with SA_RESTART the handler runs before the read resumes. Handler instructions and a restarted read receive their own instruction identities. `ITIMER_VIRTUAL` and `ITIMER_PROF` return EOPNOTSUPP: there is no guest CPU-time pacing model ([ADR 0010](../../../docs/adr/0010-program-time-without-clock-pacing.md)). A handler's signal frame and mask, signal queue and timer changes form irreversible Undo boundaries until process-state journaling is added; Undo cannot silently cross them.

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

Then translate the output, and build it with a start unit of your own as the Project's library, since the translator writes no startup code (`start.asm` is the one under [Starting the program](#starting-the-program)):

```ts
import { readFile } from 'node:fs/promises'
import { createX86Emulator } from '@specy/x86'
import { translateCompilerOutput } from '@specy/x86/compiler-output'

const assembly = await readFile('main.s', 'utf8')
const result = translateCompilerOutput(assembly.split('\n'), { profile: 'gcc-intel-v1' })
for (const diagnostic of result.diagnostics) {
    console.error(
        `main.s:${diagnostic.inputLine + 1}: ${diagnostic.severity}: ${diagnostic.message}`
    )
}
if (!result.ok) throw new Error('main.s did not translate')

const emulator = await createX86Emulator()
const build = await emulator.compileProject({
    entry: 'main.asm',
    files: { 'main.asm': result.text },
    library: { 'start.asm': await readFile('start.asm', 'utf8') }
})
if (!build.ok) throw new Error(build.report)

await emulator.runUntilBlocked()
console.log(emulator.stopReason?.exitCode) // what main returned
```

The translation is the Entry, so all of it is linked, and `ld` takes the start unit from the library for the `_start` it needs, which calls the translation's `main`. Any other File of the Project, such as NASM written by hand, joins the program when the translation refers to something it defines (see [Projects](#projects)).

### The `gcc-intel-v1` profile

A profile pins a compiler, its flags and the rules that translate its output. There is one so far, `gcc-intel-v1`, exported as `GCC_INTEL_V1` and passed to `translateCompilerOutput` by its id: GCC 14.2's x86-64 output under these flags, grouped as in `GCC_INTEL_V1.flags`.

| Group          | Flags                                  | Why                                                                                                                |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `translation`  | `-masm=intel`                          | The dialect the translator reads.                                                                                  |
|                | `-fno-pie`                             | Position-independent code uses `@PLT` and `@GOTPCREL`, which are not translated; the emulator links statically.    |
|                | `-fno-stack-protector`                 | The stack protector loads its canary through `fs:` and calls `__stack_chk_fail`.                                   |
|                | `-fcf-protection=none`                 | Some GCC builds turn control-flow protection on by default, and its `notrack` prefix has no exact NASM equivalent. |
|                | `-fno-verbose-asm`                     | Comments are not read.                                                                                             |
| `locations`    | `-g1`                                  | Writes the `.file` and `.loc` directives the source locations come from.                                           |
| `target`       | `-march=x86-64 -mtune=generic`         | Keeps to the instruction set Blink runs.                                                                           |
| `language.c`   | `-std=c17`                             |                                                                                                                    |
| `language.cpp` | `-std=c++17 -fno-exceptions -fno-rtti` | Exception tables are not translated, and type information needs a C++ runtime that nothing links in.               |

The profile is verified at `-O0`, `-O1`, `-O2`, `-O3` and `-Os` (`GCC_INTEL_V1.optimizations`). Other flags are the caller's, but the corpus the profile is verified on was also compiled with `-ffreestanding`, and C++ with `-fno-threadsafe-statics`, which keeps function-local statics from calling `__cxa_guard_acquire`; both change the code GCC writes, so use them to stay on verified ground. Output whose `.ident` names anything but GCC 14.2, or that has none, still translates, with an `unverified-compiler` warning.

### The result

`translateCompilerOutput(input, { profile })` takes the compiler's output as an array of lines and a profile id. It throws only for a profile id it does not know: everything about the input is a diagnostic. Every problem is reported in one pass, sorted by input line, and any error means no output. The same input and profile always give the same output.

```ts
type TranslationResult =
    | {
          ok: true
          text: string
          lines: TranslatedLine[]
          symbols: SymbolSummary
          diagnostics: TranslationDiagnostic[]
      }
    | { ok: false; diagnostics: TranslationDiagnostic[] }

type TranslatedLine = {
    text: string // one line of `text`
    inputLine: number | null // the zero-based input line it came from; null in the header
    synthesized: boolean // the header, and the section switches and alignment around a local common
    location: CompilerLocation | null // instructions only: the `.loc` in effect
}

type CompilerLocation = { file: string; line: number; column: number }

type TranslationDiagnostic = {
    severity: 'error' | 'warning'
    code: TranslationDiagnosticCode // see "What is rejected"
    message: string
    inputLine: number // zero-based
    column?: number // one-based, when a token can be pointed at
    location: CompilerLocation | null // the compiler location in effect at that line
}

type SymbolSummary = {
    defined: { name: string; nasmName: string; binding: 'global' | 'weak' }[]
    common: { name: string; nasmName: string }[] // `.comm` without `.local`
    external: { name: string; nasmName: string; weak: boolean }[] // undefined symbols the output references
    constructors: { name: string; nasmName: string }[] // `.init_array` entries, in order
}
```

The exported types are the same, with every field `readonly`.

`text` is NASM 3.00 source for one ELF64 object. It starts with a header: `default rel`, then `[dollarhex off]` when a name needs escaping, then an `extern` for every symbol the unit references, or declares global, without defining it. One line per kept statement follows, in input order except that an alias's label follows its target's, with labels at column 0 and everything else indented four spaces.

Code, data, read-only data, zeroed and common storage, and global, weak and alias (`.set`) symbols are translated; an alias at an offset into another label (`.set .LC12,.LC1+8`, which GCC writes when one constant lies inside another) becomes an `equ`. C++ COMDAT sections become ordinary ones, since NASM's ELF output has no section groups, and `.init_array` stays a section of its own. Debug sections, `.note.GNU-stack` (unless it asks for an executable stack) and `.note.gnu.property`, call-frame directives (`.cfi_*`), `.size`, `.hidden` and the `.type` of functions and objects are dropped; `.file`, `.loc` and `.ident` are dropped once read.

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

### Inline assembly

GCC writes the text of an `asm` statement between `#APP` and `#NO_APP`, with its operands already substituted, so an operand bound to a register arrives as that register's name. The translator reads that text by the rules it reads GCC's own output with: each line must be an instruction or directive GCC itself could have written, one to a line, in Intel syntax. Two rules differ. `syscall`, which GCC never writes, is allowed, so a program can make Linux system calls. And every memory operand except `lea`'s must name its size, as GCC's do (`DWORD PTR [rdi]`), because where GNU as calls a size-less operand ambiguous NASM picks one, and for `pop [rdi]` it picks a different one. The line markers GCC frames each statement with are not needed, since `.loc` already locates it, and a file-scope `asm` translates like any other block.

```c
static inline long write_bytes(long fd, const void *buf, long count) {
    register long rax __asm__("rax") = 1; // write
    register long rdi __asm__("rdi") = fd;
    register const void *rsi __asm__("rsi") = buf;
    register long rdx __asm__("rdx") = count;
    __asm__ volatile("syscall" : "+r"(rax) : "r"(rdi), "r"(rsi), "r"(rdx) : "rcx", "r11", "memory");
    return rax; // the count written, or a negative errno
}
```

The `syscall` it compiles to is located at the `__asm__` line, whether the function is inlined or not. Anything else in a block is an `inline-assembly` error on its own line, whatever the problem, with a message quoting the line: AT&T syntax (`%eax`, `$1`, `movl`), comments, several statements on one line, numeric labels (`%=` makes a named label unique instead), a size-less memory operand, system instructions other than `syscall`, and whatever the rules reject in GCC's own output, such as `.rept`. Under `-std=c17`, C has only the `__asm__` spelling; C++ also has `asm`.

### What is rejected

Anything outside the rules is an error at its input line, never a silent drop or a guess.

| Code                      | Severity | Raised for                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline-assembly`         | error    | Every error on a line of an `asm` statement, between `#APP` and `#NO_APP`, whatever its kind (see [Inline assembly](#inline-assembly)); the message quotes the line.                                                                                                                                                                                                                                                                                                            |
| `unsupported-section`     | error    | Thread-local storage (`.tdata`, `.tbss`), destructors (`.fini_array`, `.dtors`), `.preinit_array` and `.ctors`, constructors with a priority (`.init_array.N`), exception tables (`.eh_frame`, `.gcc_except_table`), an executable stack (`.note.GNU-stack` with the `x` flag, which GCC writes when a nested function's trampoline runs on the stack), and any other section or section attributes outside the rules; data or instructions in a section that cannot hold them. |
| `unsupported-operand`     | error    | Relocation operators (`@PLT`, `@GOTPCREL`, `@tpoff` and the like) from position-independent code and thread-local storage; segment overrides (`fs:`, `gs:`), from thread-local storage and the stack protector; expressions beyond an integer, a symbol, or a symbol plus or minus an integer; absolute addresses and other operand shapes.                                                                                                                                     |
| `unsupported-instruction` | error    | Instructions outside the x86-64 baseline, x87, SSE, SSE2 and SSE3 (SSSE3, SSE4, AVX, AVX-512, BMI, MMX and others); registers outside the general-purpose, x87 and `xmm0`-`xmm15` sets, such as `ymm0`, `mm0`, `k1`, `fs` or `cr0`; `YMMWORD` and `ZMMWORD` operands; prefixes with no exact NASM equivalent (`notrack` from `-fcf-protection`, `bnd`, `xacquire`, `data16` and others); x87 register forms outside the verified ones.                                          |
| `unsupported-symbol`      | error    | Ifuncs (`.type @gnu_indirect_function`) and other symbol types; `.protected` and `.internal` visibility; numeric and quoted labels; a `.set` that is not an alias of a label, or of a label plus or minus an integer, in the same output; a symbol defined twice.                                                                                                                                                                                                               |
| `unsupported-directive`   | error    | Comments (the profile compiles with `-fno-verbose-asm`); several statements on one line; `.rept`, `.org`, `.symver`, `.equ` and `=`, `.weakref`, `.lcomm`, `.balign`; `.pushsection`, `.popsection` and `.previous`; subsections; `.uleb128` and `.sleb128` outside debug sections; `.att_syntax`; any other directive outside the rules.                                                                                                                                       |
| `ambiguous-register-name` | error    | An operand spelled like a register when the unit also has a symbol of that name (`jmp si` beside a function `si`), which GCC's Intel syntax cannot tell apart.                                                                                                                                                                                                                                                                                                                  |
| `unreadable-line`         | error    | A control character other than a tab, or a Unicode line or paragraph separator, inside a line, which GCC never writes; nothing else on the line is read. A carriage return that ends a line is a CRLF line ending, and is read as one.                                                                                                                                                                                                                                          |
| `unverified-compiler`     | warning  | No `.ident`, or one naming anything but GCC 14.2.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unreadable-location`     | warning  | A `.file` or `.loc` the translator cannot read; the instructions it would have located get no location.                                                                                                                                                                                                                                                                                                                                                                         |

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

`ld` defines `__init_array_start` and `__init_array_end` even when no unit has a constructor, and the loop then runs none. `main` gets no arguments, which suits `int main(void)`. Linux starts a program with `rsp` 16-byte aligned, and because `_start` pushes nothing, every call it makes enters its callee 8 bytes below a 16-byte boundary, as the System V ABI requires. Keep it that way if you change it: GCC's SSE code relies on that alignment. Blink faults on a misaligned `movaps` or `movdqa` as a processor does, but not on a misaligned memory operand of most other legacy SSE instructions (`addps`, `pshufd`), so a misaligned start can run here and crash natively.

## Memory layout and bounds

`getMemoryLayout()` returns `{ sections, items, symbols }` from the linked ELF.
`items` is a flat `bigint[]`, with five fields per allocated non-empty section:
address, byte length, kind (`0` executable code, `1` data, `2` NOBITS reserved),
index into `sections`, and alignment. Unwind metadata, notes and GOT sections are
omitted. Executable sections remain code even when they contain inline data.

Data symbols carry `{ name, address, section, fromLibrary, file? }`. Ownership
comes from the defining object, including local symbols and the startup units.
Compiler-symbol comments emitted by the Intel-to-NASM translator preserve names
such as `.LC0`, including in included Generated assembly. They are metadata only
and do not affect NASM output. `resolveMemoryLabel(name)` resolves a data or code
name to its address, or returns `undefined` when no definition is present.

`getHeapStart()`, `getHeapBreak()` and `getStackTop()` return `bigint`. The heap
uses Linux `brk`. The stack top begins at the initialized RSP; an instruction moving
RSP by more than 4096 bytes starts a new stack, and raising RSP above its top raises
the top. Native history restores the previous top on Undo. Linux `brk` retains its
existing irreversible-history boundary.

The Linux process also answers `set_robust_list`, `get_robust_list` and `rseq` for a
single thread on CPU 0. `ptrace(PTRACE_TRACEME)` succeeds once and then returns
`EPERM`, as attaching to the process itself does (`PTRACE_ATTACH`, `PTRACE_SEIZE`);
other requests return `ESRCH`.

`futex` waits for one thread: nothing else can wake a waiter, so a wait whose word
matches ends when its timeout does, with `ETIMEDOUT`. `FUTEX_WAIT` takes a relative
timeout on `CLOCK_MONOTONIC` and `FUTEX_WAIT_BITSET` an absolute one, on
`CLOCK_REALTIME` with `FUTEX_CLOCK_REALTIME`; the wait reaches the host as a wait
request, like `nanosleep`, so an `environment` clock decides when it ends. A wait
without a timeout returns 0 at once, as a spurious wakeup would. glibc's
`sem_timedwait` and `pthread_cond_timedwait` therefore time out as they do on Linux.

`mmap` maps regular files only (anything else answers `ENODEV`, as Linux does). A
private file mapping is a copy of the file's pages; pages wholly past the end of
the file are zero pages allocated on first touch (Linux raises `SIGBUS` there), so
a large mapping of a small file costs nothing up front. When the host runs out of
memory for a mapping, `mmap` answers `ENOMEM`. Without `MAP_FIXED` an address is a
hint, rounded down to its page and raised to `mmap_min_addr` (`0x10000`), and
ignored when its range does not fit the address space.

## Loading an executable

`loadExecutable(bytes)` accepts a little-endian x86-64 Linux ELF executable,
including a PIE. It loads its interpreter and recursively resolves dependencies
from five bundled Ubuntu libraries: `ld-linux-x86-64.so.2`, `libc.so.6`,
`libm.so.6`, `libstdc++.so.6` and `libgcc_s.so.1`. They are fetched only when
needed and cached. The result includes `pie`, `interpreter`, `needed` and
`missing`; missing libraries still reach the dynamic linker, whose error is
written to stderr. `loadElf(bytes)` remains available without library resolution.

```ts
const emulator = await createX86Emulator()
const info = await emulator.loadExecutable(bytes)
emulator.setProgramArguments('./crackme', ['hunter2'])
emulator.initialize(200_000)
await emulator.run(1_000_000, [{ address: 0x555555555170n }])
```

The fixed Linux layout places PIEs at `0x555555554000`, maps downwards below
`0x7ffff7fff000`, and reserves the stack below `0x7ffffffff000`. Non-PIE
executables use their ELF addresses; the heap starts after the main executable.
`getLoadedObjects()` reports each object's path, soname, load bias and end, with
`main: true` on the program itself. Its path, `/program`, is where the loader
read it, and is removed before the first instruction. `getLoadedObjectBytes(path)`
returns a copy for inspection, which can be changed freely. Debugger addresses,
`getMemoryLayout()` and `resolveMemoryLabel()` include the main program's bias.

A library is downloaded the first time any load needs it, NASM's `nasm.wasm` the
first time anything is assembled, a blink-hosted assembler (GNU as, fasm) the
first time a build runs it, and GNU ld the first time a build that links needs
it: with NASM once the program has assembled, with GNU as before it runs.
Creating an emulator downloads nothing, and checking code never downloads the
linker. A download throws a `ResourceDownloadError` naming what it could not get
when the request fails, the server answers with an error status, or nothing
arrives for 20 seconds (`RESOURCE_STALL_TIMEOUT_MS`), however long the whole
download takes, as in "Could not download libc.so.6: no data for 20 s". Its
`status` is the server's HTTP status when the server answered with an error,
which trying the same URL again does not change, and undefined otherwise. A
failed download is forgotten, so the next load or build downloads it again. A
build that throws this way leaves no program, and the next build can start.

`onProgress` reports what a load or a build is waiting for: a `download` of a
resource it lacks (a library by its soname, an assembler as `the assembler`, GNU
ld as `the linker`), then `load` once a load has its libraries, or `assemble`
and `link` for a build. With NASM the linker's download comes between `assemble`
and `link`; a blink-hosted assembler's build downloads both before `assemble`.
It hears nothing once a later load or build has superseded its own.

```ts
await emulator.loadExecutable(bytes, {
    onProgress: (progress) => {
        if (progress.phase === 'download') status(`Downloading ${progress.resource}…`)
    }
})
await emulator.compileProject(project, { onProgress })
```

`loadExecutable` copies the bytes it is given (a Node `Buffer` too) and checks its
options before it replaces the loaded program, so a load that throws leaves the
previous one in place. A load is superseded by any later load or build that starts
while it fetches libraries: it then throws, and the later one wins. A build is
superseded the same way by a load or build that starts before it finishes. A load
or build that its own checks refuse supersedes nothing.

A program that `analyze` accepts but Blink's loader cannot load (only possible
through `loadElf`, which takes the bytes as they are) stops at its start with
`kind: 'load-fail'`, exit code 127 and the loader's message in `details`.

## Arguments and the executable's File

`setProgramArguments(argv0, words)` supplies UTF-8 words as an array, preserving
empty strings and spaces. NUL is refused, with limits of 1,024 argument words
and 128 KiB including argv0 and terminators. A start supplies PATH, HOME, PWD,
LANG, TERM, SHELL, USER and LOGNAME with fixed Linux values. AT_EXECFN continues
to name the actual executable path. Arguments apply at the next start.

`getProcessStart()` says where the loader put them, for a debugger to name the
bytes above the initial stack pointer. Each start reads the block back once,
before the first instruction, and keeps it until the next start, after the
program ends too; it is `null` before a program's first start, after a build, a
load or `clearExecution()`, and when the loader failed. Addresses are `bigint`;
each string's `length` counts its NUL.

```ts
emulator.setProgramArguments('./main', ['hello'])
emulator.initialize(0)
emulator.getNextInstruction() // starts the program
const start = emulator.getProcessStart()!
// start.start: the initial rsp, where argc is; start.end: the top of the stack
// start.argv, start.envp, start.auxv (to start.auxvEnd): the vectors, in that order
// start.arguments[i], start.environment[i]: { address, length } of each string
// start.execfn, start.random: what AT_EXECFN and AT_RANDOM point at
// start.path: the program's path the loader writes first, at the very top
```

The strings follow the vectors, past at most 15 bytes of alignment padding, in
this order: the arguments, the environment, AT_EXECFN's path, the 16 AT_RANDOM
bytes and the path at the top.

With a mounted Project FileSystem, `setProtectedPath('/project/crackme')`
protects the executable from writes and truncation (`ETXTBSY`). Reads remain
available. Unlinking or renaming it, including replacing its name, returns
`EBUSY`; this deliberately differs from Linux to preserve the original File.

## Reading an ELF

```ts
import { analyze } from '@specy/x86/elf'
const elf = analyze(bytes)
if (!elf.supported) console.log(`This is ${elf.reason}`)
```

`@specy/x86/elf` is plain TypeScript: importing it loads no WebAssembly. `analyze`
reads an ELF without running it and never throws: a file it cannot run, or cannot
read, comes back with `supported: false` and a `reason` naming what it is ("an ARM
program; only x86-64 programs run", "a shared library, not a program"). Whether a
program runs is decided as Linux and Blink's loader decide it, from the ELF header
and the `PT_LOAD`, `PT_INTERP` and `PT_DYNAMIC` program headers (load segments in
address order, each at the same place in a page in the file as in memory, none of
an ET_EXEC program in page 0, an interpreter path ended by its last byte); section
headers, which
Linux ignores and a stripped or protected binary may lack or corrupt, are read
when they are usable. Without them, dynamic symbols, `needed`, `soname`,
relocations and symbol versions are read through `PT_DYNAMIC`, and PLT stubs are
found by their shape in the executable segments.

The result has the headers, `sections`, `symbols` (`.symtab`) and `dynamicSymbols`,
each symbol with its `version` and `defaultVersion` when it has one (a `.symtab`
name loses a `@VERSION` or `@@VERSION` suffix only for a version the file defines
or needs, so an assembled `foo@bar` keeps its name). `relocations` covers every
table the loader applies, RELR included, each entry naming its `table`. `plt`
names each stub after the slot its `jmp [rel slot]` goes through: `strcmp@plt`,
or `strcmp@plt_resolver` for a lazy stub of `.plt` beside `.plt.sec`.

## Disassembly and address Breakpoints

```ts
import { loadDisassembler } from '@specy/x86/disassembler'
const { disassemble } = await loadDisassembler()
const instructions = disassemble(codeBytes, 0x401000n)
```

The subpath needs no Blink instance, and importing it instantiates nothing:
`loadDisassembler()` instantiates Zydis's wasm on its first call and answers the
same decoder after that. `disassemble` uses Zydis 4.1.1, including CET and
AVX-512, and prints NASM that `assembleInstruction` reads back to the same
instruction, apart from the few forms NASM 3.00 cannot encode. It exposes instruction lengths, flow kinds, direct branch targets
and RIP-relative targets with text spans.

- Memory operands carry NASM's size keywords, without `ptr`, unless another
  operand implies the size: `idiv qword [rbp-0x08]`, `call far dword [rax]`;
  `push word 0x10` is the 16-bit push.
- Each condition has one spelling, in `text` and `mnemonic` alike: `je`, `jne`,
  `jae`, `ja`, `jge` and `jg`, and the same for `setcc` and `cmovcc` (loops and
  `jrcxz` keep theirs). The 16-bit and far forms NASM names apart are `pushfw`,
  `popfw`, `iretw`, `retf`, `retfq` and `retfw`.
- RIP-relative operands print the address they reach, `[rel 0x404010]`.
  Multi-byte nops print their memory operand only, with any segment prefix the
  CPU ignores (`nop word cs:[rax+rax*1]`); x87 register forms name the register
  encoded (`fadd st1`, `fadd to st1`); a rounding mode is an operand of its own
  (`vaddps zmm0, zmm1, zmm2, {rn-sae}`); and VEX forms NASM would encode as EVEX
  start with `{vex}`.
- Invalid bytes become one-byte `db` instructions with `isInvalid`. When the
  bytes given end before the instruction does, `isTruncated` is set too: more
  bytes might decode as a valid instruction.

The Core's instruction queries use the same text (`createX86Emulator` loads the
decoder itself, so `getInstructionAt` stays synchronous); Blink executes the
instructions and may reject extensions it lacks. `getInstructionAt` answers null
where nothing is mapped and for an instruction that runs into unmapped memory.

`run(limit, [{ address }])` stops before the instruction at that runtime
address, with the same continue semantics as source Breakpoints.
`unimplementedSyscall` emits `{ number, name }` on each unimplemented call,
without pausing or changing the program's ENOSYS result.

## Assembling an instruction

`assembleInstruction(text, address)` uses NASM 3.00 in its own wasm module and
returns `{ bytes }`, or `{ error }` with a message that names no NASM file, line
or severity. It reads the disassembler's text, with every address written as a
number:

- A direct branch names its absolute target (`je 0x401020`,
  `call 0x401000+0x10`) and is encoded relative to `address`, short whenever
  the target is in reach of one.
- `[rel 0x404010]`, `[rel 0x404010+0x8]` and `[rel 0x404010-0x8]` name the
  address a RIP-relative operand reaches. NASM encodes `[rel <number>]` as an
  absolute address, so the operand is rewritten as `[rel $$+delta]` from the
  instruction's address, which NASM encodes RIP-relative. A name inside
  `[rel ...]` is an error: labels are the caller's to resolve. `[0x404010]` is
  an absolute address.
- Such a target, and a displacement beside a 64-bit register, may be any
  constant expression of numbers in NASM's notations, `$` (the instruction's
  address), `+ - * / ~` and parentheses (`jmp 0x401000+2*0x10`,
  `[rax+(0x10-0x8)]`). It is computed and checked here, since NASM encodes a
  branch to an absolute number with a displacement it never range-checks; one
  written with anything else (`'ab'`, `1 << 4`) is an error.
- Nothing is silently encoded as something else. NASM runs with `-Werror`, so a
  value it would truncate is an error and not a warning; so are a branch or
  RIP-relative target out of reach of its displacement, a 64-bit displacement
  that does not fit in 32 bits, a memory operand whose size NASM 3.00 would
  guess (`add [rax], 1`), and the forms NASM 3.00 encodes wrongly (`kunpckbw`,
  `kunpckwd`, and `bswap` or `smsw` of a 16-bit register). `notrack` and
  `cmpxchg` with a 64-bit or 16-bit register, which NASM 3.00 drops or encodes
  as 32-bit, are encoded as written.

NASM's `-Ox` still chooses the shortest encoding, which may not be the
original's: `mov rax, 0x10` becomes `mov eax, 0x10`. To apply a temporary
patch, check its length, pad shorter replacements with `0x90`, and write the
bytes between `beginPoke()` and `endPoke()`. Undo restores the original bytes.

## Migrating to 8.0.0

What a host written for 7.0.0 has to change:

- **Waits.** `X86WaitRequest.acceptsInput` is gone; `wakeSources.terminal` says what it said. A wait with no deadline may now be ended by an input device, which `wakeSources.inputDevices` names, so a `wait` hook that took "no deadline and not the terminal" for "nothing can end it" looks there too. `terminalRead` says whether the instruction waiting is a read of the terminal, a raw read `VTIME` times, rather than a `poll` or `select` of it. A request a host makes up, in a test, has all three.
- **The terminal.** Blink keeps the termios a program sets instead of ignoring it. A program that turns `ICANON` off reads key by key, as `VMIN` and `VTIME` say, so a host that hands the terminal whole lines follows `getTerminalMode()` and the `terminalMode` event and gives each key as it is typed while the program is in raw mode. `provideInput()` is taken whenever it is called, as type-ahead when no read waits. Reads of standard input, `TCFLSH` and the `TCSETS` family are journaled rather than Undo barriers: Undo of a read that waited asks for its input again, and type-ahead goes back. `ICRNL` and `ONLCR` still apply only once `setTerminalProcessing()` asks for them. Under `ISIG` the host sends Ctrl+C and Ctrl+\ as `sendSignal()`. An ioctl nothing knows answers ENOTTY, as on Linux, instead of EINVAL.
- **Devices.** Programs find `/dev/fb0`, `/dev/input/event0` to `event4` and their links, `/proc/bus/input/devices`, `/dev/dsp`, `/dev/mixer`, the raw MIDI ports and `/dev/tty0`, made again at every start, so a mapping of `/dev/fb0` succeeds where it answered ENODEV. What a program draws is `getFramebuffer()`, at the size `setDisplayMode()` set, and `framebufferPresent` marks its pans and syncs; what it plays leaves as the `pcm`, `midi`, `tone`, `mixer` and `soundCut` events; the keyboard and the tablet have only the events the host gives `sendInputReport()`. A host that wires none of this still runs such programs, unseen, unheard and with no input events. A node the machine has but does not cover opens with ENODEV and raises `unsupportedDevice`.
- **The vector state.** `X86FpuState` has `ymm`, the state block is 612 bytes (`X86_FPU_STATE_SIZE`), `RegisterSize` has `Oct`, and a step that writes the upper half of a `ymm` register reports a write of `ymm`*n*. An instruction on an MMX register raises SIGILL, `emms` apart.
- **The module.** The history packets are version 3, and `createX86Emulator()` refuses a `blinkenlib.wasm` that records another version: the wrapper and the module of one release go together.
- **Downloads.** Creating a runtime and `setMode()` download nothing; a build downloads the assembler and the linker it needs, and a download that fails throws a `ResourceDownloadError` from that build rather than from `createX86Emulator()`. `setMode()` throws while a build runs.
