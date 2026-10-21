# Changelog

## Unreleased

- The emulator runs VEX-encoded instructions: AVX, AVX2, FMA3, F16C, BMI1,
  BMI2, AES-NI, PCLMULQDQ and the SSE4.1 and SSE4.2 instructions (a legacy
  encoding of those still raises SIGILL, as `CPUID` reports none of them). A
  VEX instruction runs the legacy SSE handler for each 128-bit lane, or a
  handler of its own where the lanes are not independent. AVX-512 is not
  supported. Every VEX opcode, prefix, length, width and form was compared
  with the host's answer on whether it runs.
- The state block grew from 356 to 612 bytes: the upper halves of
  `ymm0..ymm15` follow `dp`. `X86FpuState` has `ymm`, `X86_YMM_REGISTERS` names
  them, and a step that writes an upper half reports a `ymmN` register write.
- `unpckhpd` copied the wrong half into the low half of its destination;
  `sqrtpd` read and wrote 32 bits of each double; float to integer conversions
  (`cvtss2si`, `cvttsd2si`, `cvtps2dq`, `cvttpd2dq` and the rest) produced
  saturated or undefined values instead of the integer indefinite for a NaN or
  an out-of-range value, and `cvtss2si` ignored the rounding mode; `pextrw`
  left the upper bits of its destination register alone.
- A download (a bundled library, `nasm.wasm`, a blink-hosted tool) reads its
  body as it arrives and throws a `ResourceDownloadError` naming the resource
  when the request fails, the server answers with an error status, or nothing
  arrives for 20 s (`RESOURCE_STALL_TIMEOUT_MS`). `readResourceBytes` takes a
  `name` for its errors.
- A failed download of `nasm.wasm` ends the build and is forgotten, so the next
  build downloads it again, instead of falling back to Emscripten's own loader,
  which waited on the network with no limit. Libraries were already forgotten.
- A build that throws part way leaves the runtime `Ready` rather than
  `Assembling`, so the next build can start.
- `loadExecutable` and `compileProject` take `onProgress`, told each `download`
  they wait for, then `load`, or `assemble` and `link`; `WasmAssembler.assemble`
  takes it too.

## 7.0.0

The Linux memory layout changes for every program: PIEs start at
0x555555554000, mappings allocate downwards below 0x7ffff7fff000, the
stack is below 0x7ffffffff000, and the heap starts after the main executable.
Debugger reads and Undo work throughout the guest address space.

- Run static and dynamic glibc programs, fixing the Linux entry rdx and
  copying private file mappings into ordinary pages to avoid browser mmap
  aborts and excessive heap growth. Only the pages that hold file bytes are
  copied: pages wholly past the end of the file are zero pages allocated on
  first touch, so mapping 2 GiB of a small file costs nothing up front.
- mmap maps regular files only (ENODEV otherwise, as Linux), answers ENOMEM
  instead of ending the process when the host runs out of memory, treats an
  address without MAP_FIXED as a hint (rounded down, raised to mmap_min_addr,
  ignored outside the address space), and maps a mounted Project File
  privately as a copy; a shared mapping of one is still ENODEV.
- The top-down mmap allocator keeps a free-area cache, so placing thousands of
  mappings no longer takes quadratic time.
- A native exit inside the wasm no longer leaves the runtime unusable: it
  becomes a `host-error` stop, and Node's `process.exitCode` is left alone.
  When Blink's loader ends the process for a program it cannot load, the stop
  is `load-fail` with exit code 127 and the loader's message (such as
  "program headers aren't ordered").
- Load ELF programs with loadExecutable, resolving the five bundled Ubuntu
  libraries on demand: ld-linux, libc, libm, libstdc++ and libgcc_s. A load
  copies its bytes, checks its options before replacing the program, and
  throws when a later load or build supersedes it; a build started before a
  load throws the same way, leaving the later program loaded. A load or build
  its own checks refuse supersedes nothing.
- Pass lossless UTF-8 Arguments and the fixed Linux environment.
- `getProcessStart()` reports the block the loader wrote above the initial
  stack pointer at the last start: argc, the argv, envp and auxiliary
  vectors, and each string's address and length.
- Protect a mounted running Executable from writes/truncation with ETXTBSY
  and from unlink/rename with EBUSY.
- Support set_robust_list, get_robust_list (EFAULT for an unwritable
  destination), rseq (unregistering resets the area as Linux does),
  ptrace TRACEME (and EPERM for attaching to itself); correct LZCNT and
  TZCNT.
- The terminal on descriptors 0, 1 and 2 answers termios2's TCGETS2,
  TCSETS2, TCSETSW2 and TCSETSF2 as it answers TCGETS and TCSETS, with
  38400 bits per second, so glibc 2.42 and later find a tty: isatty() is
  true, and standard output is line-buffered, which writes a prompt
  without a newline before the read that waits for its answer. Setting the
  terminal through termios2 is an Undo boundary, as through TCSETS.
- A Call stack frame has `target`, where its call went, beside `address`, where
  the symbol covering it starts: a call into a PLT stub, which no symbol names,
  goes to the stub, not to `_init` before it.
- A Call stack frame ends when the stack pointer passes its return address, by a
  `ret` or otherwise: the frames a caught C++ exception or a longjmp unwinds are
  gone, and a `ret` through an address no `call` pushed leaves its caller's
  frame in place.
- futex waits time out: FUTEX_WAIT's relative and FUTEX_WAIT_BITSET's absolute
  timeouts (CLOCK_MONOTONIC, or CLOCK_REALTIME with FUTEX_CLOCK_REALTIME) wait
  through the environment's clock and answer ETIMEDOUT, so glibc's
  sem_timedwait and pthread_cond_timedwait work, on a virtual clock too.
- Add @specy/x86/elf, a wasm-free ELF analyser: support decided from the ELF
  header and program headers alone, section headers read when usable, dynamic
  symbols, dependencies, relocations (RELR and static `.rela.plt` included,
  each naming its table), symbol versions and PLT stub names read through
  PT_DYNAMIC when they are not, and a reason naming the machine of a program
  for another one. A program Blink's loader would refuse is unsupported, with
  a reason: load segments out of address order, a segment whose address and
  file offset are at different places in a page, an ET_EXEC program in page 0,
  an interpreter path whose last byte is not NUL. analyze never throws.
- Add @specy/x86/disassembler with Zydis 4.1.1 batch decoding behind
  loadDisassembler(); importing the package or a subpath no longer
  instantiates wasm or awaits at the top level. Instruction queries use its
  NASM text, including CET and vector extensions Blink cannot execute: size
  keywords wherever no other operand implies the size, one spelling per
  condition (je, jne, jae, ja, jge, jg, and the same for setcc and cmovcc),
  NASM's names for the 16-bit and far forms (pushfw, popfw, iretw, retfq),
  and nops, x87 register forms and rounding modes as NASM writes them.
  Invalid bytes are one-byte `db` entries, flagged `isTruncated` when the
  bytes ended before the instruction did. getInstructionAt answers null for
  an instruction whose bytes run into unmapped memory.
- Add address Breakpoints, getLoadedObjects (with `main` on the program),
  getLoadedObjectBytes (a copy) and the unimplementedSyscall event, retaining
  each call's ENOSYS result; a listener that throws no longer interrupts the
  system call.
- Add assembleInstruction for temporary instruction patches through Pokes. It
  reads the disassembler's text back: `[rel 0x404010]` is encoded
  RIP-relative from the instruction's address (as `[rel $$+delta]`), a name
  inside `[rel ...]` is refused, and NASM runs with -Werror, so a value it
  would truncate, a target out of reach, a memory operand whose size it would
  guess or a form NASM 3.00 encodes wrongly is an error rather than other
  bytes. A branch or `[rel ...]` target and a 64-bit displacement may be any
  constant expression of numbers, `$`, `+ - * / ~` and parentheses: it is
  computed and checked before NASM encodes it, and one written otherwise is
  refused.
- Remove Blink's own disassembly listing (getDisassemblyLines,
  getDisassemblyCurrentLine and its native bindings), which nothing used.

This version was prepared locally for binary-import implementation. It has
not been tagged, pushed or published.
