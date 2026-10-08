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

`library` holds units built alongside the Project's own, such as the start code under [Starting the program](#starting-the-program). Each is assembled like a File and named by its path wherever a File is, in instructions, breakpoints and diagnostics, but it is never the Entry and no File can `%include` it. A library path and a File's path must differ, and neither may be a directory of the other: `compileProject` and `checkProject` throw for a Project that breaks this. The library's units come first in the archive, so for a symbol a library unit and a Project unit both define, `ld` takes the library's: its `_start` over one a File writes, and its weak definitions, such as a default `memcpy`, over a File's strong ones unless that File is taken for something else. Nothing is taken from the archive for a symbol the Entry defines. The blink-hosted assemblers, GNU as and fasm, assemble the Entry alone.

This differs from 3.x, which linked every unit into the program, so that two Files defining one symbol always clashed. `projectLinking` is `'archive'` on an emulator that links Projects this way, and absent in 3.x.

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

When history is enabled, every instruction `run()` or `step()` executes is recorded inside the wasm. CPU instructions and queries can be undone; an instruction with unjournaled input, File, descriptor, pipe, mapping or process-state effects forms an irreversible boundary. If history is disabled with `initialize(0)` or by never calling `initialize`, nothing is recorded and `canUndo()` returns `false`.

Very large or truncated memory writes may not be reversible. In that case `canUndo()` returns `false` for the latest step, and calling `undo()` throws instead of restoring a partial state.

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
```

Callbacks passed to `createX86Emulator()` and handlers registered with `on()` may return either `void` or `Promise<void>`. Async callbacks are observed but not awaited by the emulator, so UI work can be scheduled without blocking execution. A `stdout` or `stderr` callback that throws is reported as a rejected promise is, asynchronously, and the write still succeeds. [Standard streams](#standard-streams) says what `stdout`, `stderr` and `inputRequest` carry.

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

**Output.** Every write reaches the host as one call of the `stdout` callback, or of `stderr` for a write through descriptor 2 or a copy of it, with the bytes it wrote as a `Uint8Array`, in the order the program wrote them; a `writev` is one call with its vectors joined, and a write of nothing makes none. The bytes are as written, so a UTF-8 character a program writes in two writes arrives split, and decoding is the host's (a `TextDecoder` with `stream: true` keeps the split character). Writes to descriptor 0 or to `/dev/tty` arrive as standard output.

**Input.** The host gives the terminal what its line discipline releases, as `provideInput(bytes)`: a line ended with Enter, a paste, as bytes or as a string, which is taken as its UTF-8 bytes. `provideInput(END_OF_INPUT)` gives End of input, what Ctrl+D on an empty line gives a terminal. Both queue in the order given, behind what no read has taken, and a read takes from the queue as a read of a Linux terminal in canonical mode does: at most the bytes it asked for, and never past a line feed, so the rest waits for the next read. End of input at the head of the queue makes the read that reaches it return 0, and only that read. A read that finds the queue empty waits: `getStatus()` says `WaitingForInput`, the `inputRequest` event gives `maxBytes`, the bytes the read asked for, and `provideInput()` resumes it. A read of no bytes returns 0 at once, as on Linux.

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

- `TCGETS` gives the settings a terminal emulator's pseudo-terminal starts with: `ICRNL | IXON | IUTF8`, `OPOST | ONLCR`, `B38400 | CS8 | CREAD` and `ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN`, with Linux's control characters. That is canonical input, echoed, with Enter read as a line feed and Backspace erasing a whole UTF-8 character, which is what the host's line discipline is expected to do before it calls `provideInput()`. `TCSETS`, `TCSETSW` and `TCSETSF` succeed and change nothing, so a program cannot switch the terminal to raw mode.
- `TIOCGWINSZ` gives 80 columns by 24 rows, since the host's terminal has no fixed grid; `TIOCSWINSZ` succeeds and changes nothing.
- `TIOCGPGRP` and `TIOCGSID` give the process's group and session, which the terminal leads it in; `TIOCSPGRP` accepts only that group.
- `FIONREAD` counts the bytes no read has taken; `TCFLSH` with `TCIFLUSH` or `TCIOFLUSH` drops them and any End of input; `TIOCOUTQ` is 0, `TCSBRK` and `TCXONC` succeed.
- Any other request answers ENOTTY, except those every descriptor takes (`FIONBIO`, `FIOCLEX`, `FIONCLEX`).

`poll` and `select` report the terminal readable when input bytes or an End of input token are queued. A timed or indefinite poll of an empty terminal suspends the instruction asynchronously; `getStatus()` says `Waiting`, and the `waitRequest` event has `acceptsInput: true`. `provideInput()` wakes that poll without consuming the input. An empty terminal read with `O_NONBLOCK` returns EAGAIN immediately.

A read which takes bytes or an End of input token is irreversible until input journaling is implemented. `TCFLSH` also forms a barrier when it discards queued bytes or End of input. A zero-length read and an empty flush are reversible. The terminal transcript is not rewound; ordinary stdout/stderr writes do not form barriers.

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

Directories are implicit path prefixes, listed through `stat`/`list` without opening a capability handle. Parent Directories must exist when creating or renaming a File through Linux paths. Empty Directory creation/removal, Directory moves, replacement rename, links and persistent permission/owner/time changes have no session representation. Directory creation/removal and persistent metadata changes return EOPNOTSUPP; links fail because the mount supplies no link operations, and replacement rename returns EEXIST. Mounted nodes expose synthetic mode 0777, uid/gid zero and epoch timestamps; unlink reports link count zero through retained File handles. A Directory disappears with its last File; open Directory lifetime consequently follows the capability's implicit-Directory model. Regular-File mmap returns ENODEV on this mount before replacing any prior map; anonymous mappings remain available.

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

File system calls work on Emscripten's in-memory file system, reset at every start (see [Each run starts afresh](#each-run-starts-afresh)). Undo restores registers, flags, the FPU and memory, not syscall-owned state: an undone `brk`, `setuid` or `setrlimit` stays done, and so does a read of terminal or pipe input. External random stream positions also need a host journal to rewind them; the Core exposes instruction identities for that purpose but does not keep such a journal.

### Clock, random and asynchronous waits

Pass `environment` to `createX86Emulator()`, or call `setEnvironment()` before the program starts. `compile()` and `compileProject()` build an executable; they do not load the guest process. `initialize()` prepares debugger history, and the first `step()`, `run()` or `runUntilBlocked()` loads the process. Select clock and random sources and mount the run's FileSystem before that first execution call, before applying register or memory presets that start the process. `loadElf()` replaces the executable and abandons any pending instruction; it also loads the process only on execution. Each actual start resets the process file system before loading, preserving a newly attached `/project` capability and dropping compiler staging.

`now(clock)` returns finite, nonnegative milliseconds for the effective Linux clock: 0 for realtime and 1 for monotonic. The same source supplies clock syscalls, guest RDTSC and wait deadlines. Relative sleep, poll and select timeouts use monotonic time; an absolute `clock_nanosleep` uses its requested effective clock. `random(length, instructionSerial)` must return exactly `length` bytes. One source covers loader `AT_RANDOM`, `getrandom`, `/dev/random`, `/dev/urandom`, RDRAND and RDSEED. Loader draws have a null identity; instruction draws carry the active decimal serial. The assembler and linker always use host clock, entropy and wait transport, so compilation consumes none of the selected program sources. Replacing sources while an instruction is waiting is rejected.

`nanosleep`, `clock_nanosleep`, `select`, `pselect6`, `poll`, `ppoll`, `pause`, `rt_sigsuspend`, and blocking pipe operations halt without waiting on the JavaScript thread. `getWaitRequest()` and the `waitRequest` event expose the effective `clock`, absolute `deadlineNanoseconds` as a bigint, `remainingMilliseconds`, `acceptsInput`, and the waiting `instructionSerial`. A null deadline means the instruction needs an external wake source. Only a wait that requests a readable terminal descriptor sets `acceptsInput`; an empty pipe, `pause`, or a sleep does not request terminal input.

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
| `unsupported-symbol`      | error    | Ifuncs (`.type @gnu_indirect_function`) and other symbol types; `.protected` and `.internal` visibility; numeric and quoted labels; a `.set` that is not an alias of a label in the same output; a symbol defined twice.                                                                                                                                                                                                                                                        |
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

`ld` defines `__init_array_start` and `__init_array_end` even when no unit has a constructor, and the loop then runs none. `main` gets no arguments, which suits `int main(void)`. Linux starts a program with `rsp` 16-byte aligned, and because `_start` pushes nothing, every call it makes enters its callee 8 bytes below a 16-byte boundary, as the System V ABI requires. Keep it that way if you change it: GCC's SSE code relies on that alignment, and Blink, unlike a real processor, does not fault on a misaligned `movaps`, so a misaligned start can run here and crash natively.

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
