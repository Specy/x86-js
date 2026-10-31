# Changelog

## Unreleased

For 8.0.0: the wait request, the state block, the history packets and the
terminal change shape, and programs find Linux's devices. The README's
"Migrating to 8.0.0" lists what a host has to change.

- The machine has the QEMU guest's devices (`docs/design/x86-devices-plan.md`,
  M1 to M4). Its device nodes, `/dev/fb0`, `/dev/tty0`, `/dev/input/event0`
  to `event4`, `/dev/dsp`, `/dev/mixer`, `/dev/midi1` and `/dev/snd/midiC1D0`
  to `midiC1D3`, udev's links and
  `/proc/bus/input/devices` are made from one table in the Core and put back
  at every start. `open()` finds a device by its node's number; the nodes the
  machine does not cover open with ENODEV and raise the new `unsupportedDevice`
  event. What `open()` makes is an open file description that `dup()` shares
  with its `O_NONBLOCK`. An ioctl nothing knows answers ENOTTY instead of
  EINVAL, but where the driver answers otherwise: evdev and `/dev/dsp` EINVAL,
  `/dev/mixer` ENXIO. A blocking write to a device that paces it goes on from
  what it queued each time Blink starts it over. Every start finds every
  device as the machine boots it, whatever the last run left. See the README's
  "Devices".
- `/dev/fb0` is the framebuffer (M2), as Linux's DRM fbdev emulation answers on
  the QEMU guest's bochs display: XRGB8888 over two pages of the display mode
  `setDisplayMode()` sets for the next start (320×240 until then), the fixed
  and variable screen information, `FBIOPUT_VSCREENINFO` answering as
  `drm_fb_helper_check_var()` does, panning, `FBIO_WAITFORVSYNC` on the 1/60 s
  boundaries of Program time and `FBIOBLANK`. `mmap` points the guest's pages
  into one buffer that `munmap` never frees, and `read`, `write`, `pread64`,
  `pwrite64` and `lseek` reach the same bytes. Stores through a mapping, what a
  `write` replaces, file offsets and the device's settings are undoable.
  `getFramebuffer()` gives the page the scanout shows as a view of the wasm
  heap, and the `framebufferPresent` event marks pans, syncs, blanks and Undo
  moving the scanout. See the README's "The framebuffer".
- The input devices (M3): `/dev/input/event0` to `event4` answer evdev as
  Linux 7.2 does for the guest's AT keyboard, PS/2 mouse, QEMU USB tablet, PC
  Speaker and Power Button, with each one's identity and capabilities,
  readers' queues of 4,096 events with evdev's `SYN_DROPPED`, the state
  ioctls (`EVIOCGKEY`, `EVIOCGLED`, `EVIOCGABS` and the rest), `EVIOCGREP` and
  `EVIOCSREP`, `EVIOCSCLOCKID`, `EVIOCGRAB`, masks, keymaps and writes. The new
  `sendInputReport(device, events)` delivers a host key or pointer event to
  the keyboard or the tablet as the guest's hardware and drivers make it:
  `MSC_SCAN`, the lock keys' LEDs, `REL_WHEEL_HI_RES` and `SYN_REPORT`,
  stamped with Program time. Reads, flushes and writes of an input device are
  journaled rather than Undo barriers: Undo puts the events a read took back
  (ADR 0069). `/proc/bus/input/devices` is generated from the same table; the
  Power Button now lists `KEY_WAKEUP`, as Linux's has it. See the
  README's "Input devices".
- The sound devices (M4). `/dev/dsp` and `/dev/mixer` behave as Linux 7.2's
  snd-pcm-oss and snd-mixer-oss on the guest's HDA card (QEMU's
  `hda-duplex`): 8000 Hz U8 mono at open, the fixed `GETFMTS` mask, settings
  written back, the buffer and fragments the kernel computes through its
  plugins, `SETFRAGMENT` once, whole-fragment transfers, blocking and
  non-blocking writes paced on Program time, `GETOSPACE`, `GETODELAY`,
  `GETOPTR`, `SYNC`, `RESET`, a `close()` that plays the buffer out, and the
  mixer's `VOLUME` and `IGAIN`. snd-virmidi's four raw MIDI devices and
  `/dev/midi1` send at 31,250 baud behind rawmidi's buffer and answer its
  ioctls. The PC speaker sounds for `EV_SND` events written to
  `/dev/input/event3` and for `/dev/tty0`'s `KIOCSOUND` and `KDMKTONE`, which
  reach it through the input core as on Linux, so the device's readers see
  them too; `/dev/tty0` is a tty. What they play leaves the Core as the new
  `pcm`, `midi`, `tone`, `mixer` and `soundCut` events, on Program time.
  Writes to `/dev/dsp` and the MIDI ports and the devices' settings are
  journaled rather than Undo barriers: Undo puts settings back and cuts what
  was queued and not heard, and restores the MIDI channels and the speaker's
  tone. See the README's "Sound".
- The devices are the pinned guest's as its probe recorded them (M0,
  `docs/research/x86-reference-guest.md`: QEMU 10.2.1, Debian 13 with Linux
  7.2.11 from backports), where they were provisional. The input devices'
  order is the guest's, `event0` the keyboard, `event1` the PS/2 mouse,
  `event2` the tablet, `event3` the PC Speaker and `event4` the Power Button,
  with its `/proc/bus/input/devices` text, udev's links (the tablet's `-mouse`
  links lead to `js0`; `usbv2-` and `platform-LNXPWRBN:00-event` links are
  new) and `sendInputReport()`'s indices. ALSA's minors are the guest's
  dynamic ones (`midiC1D0` is 116:2). New nodes: `/dev/ttyS0` and
  `/dev/console`, the serial line descriptors 0 to 2 are on, so `ttyname(0)`
  answers `/dev/ttyS0`; `/dev/tty1`, the same console as `/dev/tty0`;
  `/dev/dmmidi1` (device 0) and `/dev/amidi1` and `/dev/admmidi1` (device 1)
  as raw MIDI ports; and, opening with ENODEV, `js0`, `controlC1`,
  `controlC2`, `hwC0D0`, `pcmC2D0p`, `timer`, `/dev/mixer1`, `/dev/mixer2`,
  `/dev/dsp2`, `/dev/audio2`, `/dev/uinput` and `/dev/tty2` to `/dev/tty63`,
  with the `/dev/snd/by-path/`, `/dev/snd/by-id/` and `/dev/dri/by-path/`
  links. `/dev/tty0` is mode 0600, its termios is what tty1's getty leaves,
  and it answers `KDGETMODE`, `KDSETMODE`, `KDGKBMODE`, `KDSKBMODE`,
  `KDGETLED`, `KDGKBLED` and `VT_GETSTATE`. The tablet has five buttons,
  `BTN_SIDE` and `BTN_EXTRA` with their usages, and a keymap `EVIOCGKEYCODE`
  and `EVIOCSKEYCODE` reach. A lock key's LED change arrives in the key's
  release packet. The keyboard has Linux 7.2's keymap (F13 to F24). The
  terminal starts with the serial line's termios as agetty leaves it (no
  `ECHOCTL`, no `IEXTEN`, `IXOFF`, `IMAXBEL`, 9600 baud with `HUPCL` and
  `CLOCAL`), and `X86TerminalMode` has `echoControl`. A pan of `/dev/fb0`
  waits for the next vertical blank, and an `FBIOPUT_VSCREENINFO` that
  changes anything for the second, as bochs-drm's commits do on 7.2;
  `smem_len` is no longer rounded to pages. Raw MIDI's `PVERSION` is 2.0.5;
  the mixer is `QEMU Generic` and its change counter starts at 14;
  `SNDCTL_DSP_CHANNELS` takes its count unsigned (-1 is EINVAL); a fragment
  whose plugin buffers are too large makes the calls that apply it answer
  ENOMEM; `GETOSPACE` counts negative space in whole fragments down.
- `X86WaitRequest` has `wakeSources`, the terminal and the input devices that
  can end a wait, and `terminalRead`, whether the instruction waiting is a
  read of the terminal, a raw read that `VTIME` times, which takes the input
  that ends the wait, rather than a `poll` or `select` that only looks at it.
  `acceptsInput` is gone: `wakeSources.terminal` says the same. A device that
  keeps time folds the moment it is ready into the deadline.
- `X86Project.includePaths` names directories of the Project that NASM
  searches, as `-I`, for a `%include` or `incbin` it does not find in the
  directory of the File it assembles, for every unit, the library's included.
  A host offers include files of its own, such as a system's headers, as Files
  under one of them, and diagnostics, instructions and breakpoints name them by
  their Project paths. See the README's "Projects".
- The terminal stores the termios a program sets, instead of ignoring it, and
  reports it: `getTerminalMode()` and the `terminalMode` event. Raw mode reads
  as `VMIN` and `VTIME` say, on Program time, and input given while no read
  waits is kept as type-ahead. `setTerminalProcessing()` turns on `ICRNL` and
  its relatives for input and `OPOST`'s `ONLCR` and `OCRNL` for output, which
  stay off unless the host asks, so that what the program writes arrives as
  it wrote it, as through a pipe. `sendSignal()` sends `SIGINT` or `SIGQUIT`
  as Ctrl+C and Ctrl+\ do under `ISIG`.
- A read of the terminal, a flush of its input and a change of its termios are
  journaled instead of being Undo barriers: Undo of a read that waited asks
  again, and type-ahead goes back (ADR 0069). The history packets carry the
  journal after a 96-byte header, so their version is now 3.
- A `rep` string instruction that writes more than the 64 KiB one instruction
  keeps stops between iterations for the history and goes on at once: it stays
  one step, one row and one instruction, and Undo restores all of it, up to
  16 MiB.
- The emulator runs VEX-encoded instructions: AVX, AVX2, FMA3, F16C, BMI1,
  BMI2, AES-NI, PCLMULQDQ and the SSE4.1 and SSE4.2 instructions. Of their
  legacy encodings, `pmulld`, `movntdqa`, `crc32` and `pclmulqdq` ran before
  and still do; the others still raise SIGILL. A VEX instruction runs the
  legacy SSE handler for each 128-bit lane, or a handler of its own where the
  lanes are not independent. AVX-512, VAES and the 256-bit `vpclmulqdq` are
  not supported, and `CPUID` reports none of the new extensions. Every VEX
  opcode, prefix, length, width and form, with `vvvv` both unused and naming a
  register, was compared with the host's answer on whether it runs.
- The state block grew from 356 to 612 bytes: the upper halves of
  `ymm0..ymm15` follow `dp`. `X86FpuState` has `ymm`, `X86_YMM_REGISTERS` names
  them, and a step that writes an upper half reports a `ymmN` register write.
  The undo history packets carry the larger block, so their version is now 2.
- `unpckhpd` copied the wrong half into the low half of its destination;
  `sqrtpd` read and wrote 32 bits of each double; float to integer conversions
  (`cvtss2si`, `cvttsd2si`, `cvtps2dq` and the rest) produced saturated or
  undefined values instead of the integer indefinite for a NaN or an
  out-of-range value, and `cvtss2si` ignored the rounding mode; `pextrw` left
  the upper bits of its destination register alone.
- `cvtpd2dq` truncated and `cvttpd2dq` rounded, the reverse of what each
  does, and both, with `cvtpd2ps`, left bits 64 to 127 of the destination
  alone instead of clearing them.
- A store that straddles two pages and faults on the second no longer writes
  the bytes it had staged into the first page when the next instruction runs.
  A legacy aligned store (`movdqa`, `movaps`, `movntdq` and relatives) checks
  that its page is writable, and Undo restores what it overwrote. A misaligned
  operand of an aligned move raises SIGSEGV with code `SI_KERNEL` and no
  address, as Linux reports the processor's general protection fault.
- `crc32` with a 16-bit source raised SIGILL, and `8f` with a ModRM reg field
  other than 0 ran as `pop` instead of raising SIGILL.
- Every instruction on an MMX register raises SIGILL, as `DISABLE_MMX` intends;
  the moves, conversions and `pshufw`, `pextrw`, `pinsrw` and `pmovmskb` on MMX
  registers used to run on the `xmm` register of the same number. `emms` still
  runs.
- A download (a bundled library, `nasm.wasm`, a blink-hosted tool) reads its
  body as it arrives and throws a `ResourceDownloadError` naming the resource
  when the request fails, the server answers with an error status, or nothing
  arrives for 20 s (`RESOURCE_STALL_TIMEOUT_MS`), with the server's HTTP
  `status` in the second case. `readResourceBytes` takes a `name` for its
  errors.
- A failed download of `nasm.wasm` ends the build and is forgotten, so the next
  build downloads it again, instead of falling back to Emscripten's own loader,
  which waited on the network with no limit. Libraries were already forgotten.
- A build that throws part way leaves the runtime `Ready` rather than
  `Assembling`, so the next build can start.
- `loadExecutable` and `compileProject` take `onProgress`, told each `download`
  they wait for, then `load`, or `assemble` and `link`; `WasmAssembler.assemble`
  takes it too.
- Creating a runtime, or `setMode`, downloads nothing. A build downloads a
  blink-hosted assembler (GNU as, fasm) before it runs it, and GNU ld (2.7 MB)
  only when it links: with NASM once the program has assembled, with GNU as
  before it runs. Each reports `download` the first time, so a runtime that only
  checks code never downloads the linker. Downloads are shared by every runtime
  and forgotten when they fail, as the libraries are. A failed download of
  either now fails the build that needed it rather than `createX86Emulator`.
  `setMode` throws during a build, which would otherwise go on with the other
  mode's tools.
- A wait request's `remainingMilliseconds` is taken in whole nanoseconds, as
  the guest compares its deadline. In floating point, a short wait on a
  real-time clock far from zero could come out as 0 while the guest still
  waited, so a virtual clock advanced by it never reached the deadline.
- Programs run faster: two and a half to four times as fast with the undo
  history recording (the least on SSE and rep string loops, the most on
  integer ones), 1.5 to 1.9 times without it, and a small program builds
  about 25% faster, as the linker runs in the same loop. A step copies the
  x87, SSE and AVX state only for an instruction that can change it, rather
  than copying and comparing all of it twice per instruction; building with
  `-DDEBUGHISTORY_CHECK_FPU` checks that list against every instruction a
  program runs. An entry keeps the registers its step left as one block,
  copied and compared a word at a time, and the registers it started from
  only when something moved them between steps; its packet is built when it
  is asked for, so the packets do not change. The byte budget counts an
  entry's registers (152 bytes) and the rest of its packet, so the oldest
  entries are hollowed at slightly different points. The new
  `blinkenlib_history_header` gives an entry's header alone, without copying
  its memory images, and the history reads it wherever it needs no more.
  Every instruction is decoded once rather than twice, and the breakpoint and
  interval timer checks cost nothing when there are none.
- A native slice runs up to 200,000 instructions rather than 50,000, so a long
  `run()` yields to the host a quarter as often. The linker and the assembler
  are preempted every 250,000 instructions rather than 100,000, and still
  stop at a hundred million.

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
