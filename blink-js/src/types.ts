import type { DiagnosticSeverity } from './interface'
import type { MaybePromise } from './callbacks'

export const X86_REGISTER_NAMES = [
    'rax',
    'rbx',
    'rcx',
    'rdx',
    'rsp',
    'rbp',
    'rsi',
    'rdi',
    'r8',
    'r9',
    'r10',
    'r11',
    'r12',
    'r13',
    'r14',
    'r15',
    'rip'
] as const

export type X86RegisterName = (typeof X86_REGISTER_NAMES)[number]

export enum BlinkState {
    NotReady = 'NOT_READY',
    Ready = 'READY',
    Assembling = 'ASSEMBLING',
    Linking = 'LINKING',
    ProgramLoaded = 'PROGRAM_LOADED',
    ProgramRunning = 'PROGRAM_RUNNING',
    ProgramPaused = 'PROGRAM_PAUSED',
    ProgramReadlinePause = 'PROGRAM_READLINE_PAUSE',
    ProgramWaitPause = 'PROGRAM_WAIT_PAUSE',
    ProgramStopped = 'PROGRAM_STOPPED'
}

export type StopReasonKind =
    | 'exit'
    | 'signal'
    | 'input'
    | 'wait'
    | 'limit'
    | 'breakpoint'
    | 'load-fail'
    | 'host-error'

/** A signal that ended the program, as Linux describes it. */
export type X86SignalInfo = {
    /** The signal's number: 11 for SIGSEGV. Real-time signals run from 32 to 64. */
    number: number
    /**
     * Why the kernel sent it, the siginfo `si_code`: 1 (`SEGV_MAPERR`) for a SIGSEGV at an address
     * nothing maps, 128 (`SI_KERNEL`) for a fault with no finer cause, such as `int3`.
     */
    code: number
    /** `SIGSEGV`; a real-time signal is `SIGRTMIN+n` or `SIGRTMAX-n`, counted from the kernel's 32. */
    name: string
    /** What a shell prints when the signal ends a program: `Segmentation fault`. */
    description: string
}

export type StopReason = {
    loadFail: boolean
    /**
     * For `kind: 'exit'`, the status the program exited with, its low eight bits as a parent sees
     * them on Linux: `exit(256)` is 0 and `exit(-1)` is 255. For `kind: 'signal'`, 128 plus the
     * signal's number, as a shell reports it.
     */
    exitCode: number
    details: string
    kind?: StopReasonKind
    /** For `kind: 'signal'`, the signal that ended the program. */
    signal?: X86SignalInfo
    address?: bigint
    lineNumber?: number
    file?: string
    executedInstructions?: bigint
}

/** A system call the Core implements, as its dispatch table names it. */
export type X86ImplementedSyscall = {
    /** The value `rax` holds when the `syscall` instruction runs. */
    number: number
    /** Its name in Linux's x86-64 system call table, such as `pread64`. */
    name: string
    /** How many argument registers it reads, in order: rdi, rsi, rdx, r10, r8, r9. */
    arity: number
}

export type X86CompilationDiagnostic = {
    line: number
    error: string
    /** Project-relative source path when compiling a virtual Project. */
    file?: string
    /** A warning still assembles; only an error stops the build. */
    severity: DiagnosticSeverity
    /** The assembler's own name for the warning, such as `label-orphan`. */
    warningClass?: string
}

export type X86ProjectFile = string | Uint8Array

/**
 * The Files of a program, by path, and the Entry, the File it is built from.
 *
 * The default NASM assembler takes the Entry and every other unit, the `units` or else every
 * `.asm`, `.s` or `.nasm` File, that no other File `%include`s, each as a unit of its own, and
 * links them the way a C toolchain links objects and a static library: the Entry's unit as an
 * object, and every other unit as a member of an archive that `ld` takes a member from only for a
 * symbol still undefined, `_start` included. Which names a unit defines is read from its `global`
 * and `common` declarations before anything assembles it, from its preprocessed text when it uses
 * the preprocessor, and a unit is assembled only once the program needs one of them: a unit
 * nothing needs is neither assembled nor checked, and is not part of the program, so a Project can
 * hold Files that would otherwise clash, such as a second `_start`, or that do not assemble. The
 * blink-hosted assemblers, GNU as and fasm, assemble the Entry alone.
 */
export type X86Project = {
    entry: string
    files: Readonly<Record<string, X86ProjectFile>>
    /**
     * The Files besides the Entry the link may take, in archive order: text Files of `files`,
     * none of them the Entry. Absent, every `.asm`, `.s` or `.nasm` File other than the Entry. A
     * File another unit `%include`s is part of that unit, and no unit of its own.
     */
    units?: readonly string[]
    /**
     * Units built alongside the Project's own, such as start code that defines `_start` and calls
     * `main`: each is assembled like a Project File, under its own path, which instructions,
     * breakpoints and diagnostics name as they name a File's. A library path and a File's path
     * must differ, and neither may be a directory of the other. A library unit is never the
     * Entry, and the Project's Files cannot `%include` it. It goes into the archive ahead of the
     * Project's other units, so `ld` takes it first for a symbol both define.
     */
    /** Start objects are always linked, before the user archive. */
    startUnits?: Readonly<Record<string, X86ProjectFile>>
    /** Support archive, searched after all user units. */
    library?: Readonly<Record<string, X86ProjectFile>>
    /**
     * Directories of the Project that NASM searches, in this order, for a `%include` or `incbin`
     * it does not find in the directory of the File it assembles, as `-I` names them: a host that
     * offers include files of its own, such as a system's headers, puts them among the Files under
     * one of these. Diagnostics, instructions and Breakpoints name a File found there by its
     * Project path, as they name every other. The blink-hosted assemblers do not search them.
     */
    includePaths?: readonly string[]
}

export type X86SourceLocation = {
    path: string
    /** Zero-based source line. */
    line: number
}

export type X86Breakpoint = number | X86SourceLocation | { address: bigint }

/**
 * `diagnostics` carries everything the assembler said, warnings included - a
 * successful build routinely has some, and they are the most useful thing it
 * produces. `errors` is the subset that stopped the build.
 */
export type X86CompileResult =
    | { ok: true; report: string; diagnostics: X86CompilationDiagnostic[] }
    | {
          ok: false
          errors: X86CompilationDiagnostic[]
          report: string
          diagnostics: X86CompilationDiagnostic[]
      }

/**
 * End of input, for `provideInput()`: what Ctrl+D on an empty line gives a terminal. The read it
 * reaches returns 0, and only that read: the one after it waits for input again.
 */
export const END_OF_INPUT: unique symbol = Symbol.for('@specy/x86/END_OF_INPUT')

/**
 * What `provideInput()` takes: bytes the terminal's line discipline has released, such as a line
 * ended with Enter, or End of input. A string is taken as its UTF-8 bytes.
 */
export type X86Input = Uint8Array | string | typeof END_OF_INPUT

/** A read of the terminal that is waiting for input. */
export type X86InputRequest = {
    /** How many bytes the read asked for: a `read`'s count, the sum of a `readv`'s vectors. */
    maxBytes: bigint
}

/**
 * The termios settings the program set on its terminal that the host's line discipline follows,
 * the flag each is named after on, or off. Every program starts in canonical mode with all of them
 * on.
 */
export type X86TerminalMode = {
    /** `ICANON`: a read takes a line; off, the bytes typed so far, as `VMIN` and `VTIME` say. */
    canonical: boolean
    /** `ECHO`: what is typed is echoed. */
    echo: boolean
    /**
     * `ECHOCTL`: under `ECHO`, a control character typed is echoed as `^` and a letter (`^C`,
     * `^[`); off, as itself. The serial line starts with it off, as agetty leaves it.
     */
    echoControl: boolean
    /** `ISIG`: Ctrl+C and Ctrl+\ send `SIGINT` and `SIGQUIT` (see `sendSignal()`). */
    signals: boolean
    /** `ICRNL`: a carriage return typed is read as a line feed. */
    crToNl: boolean
    /** `OPOST`: output is processed, as the next flag says. */
    outputProcessing: boolean
    /** `ONLCR`: under `OPOST`, a line feed leaves as a carriage return and a line feed. */
    nlToCrNl: boolean
}

/** The input devices the host delivers events to; the guest's others never receive any. */
export type X86InputDeviceId = 'keyboard' | 'tablet'

/**
 * One input event as Linux's `struct input_event` has it, without its time: `EV_KEY` with a
 * `KEY_*` or `BTN_*` code and 1 down, 2 a repeat, 0 up; `EV_ABS` with `ABS_X` or `ABS_Y` and a
 * position from 0 to 32767; `EV_REL` with `REL_WHEEL` and the notches turned, positive away from
 * the user.
 */
export type X86InputEvent = { type: number; code: number; value: number }

/** What can end a wait besides its deadline and a signal. */
export type X86WakeSources = {
    /** Input given to the terminal (`provideInput()`). */
    terminal: boolean
    /** Events reaching these input devices. */
    inputDevices: X86InputDeviceId[]
}

/**
 * The machine's display mode, its `video=`: a width that is a multiple of 8 and a height, both 8
 * to 1024 pixels. A program takes the mode set when it starts; the default is 320×240.
 */
export type X86DisplayMode = { width: number; height: number }

/**
 * The framebuffer `/dev/fb0` draws on, once the program has opened it: XRGB8888 pixels, one
 * little-endian `0x00RRGGBB` word each, `lineLength` bytes a line, over twice the mode's height,
 * of which the scanout shows `height` lines from `yoffset`. Every property is read from the Core
 * when it is asked for, so one object stays current for the program.
 */
export type X86Framebuffer = {
    /** The mode's width, in pixels. */
    readonly width: number
    /** The mode's height, in lines: the scanout shows this many. */
    readonly height: number
    /** Bytes from one line to the next: `width × 4`. */
    readonly lineLength: number
    /** The first line the scanout shows, 0 to `height`: `height` shows the second page. */
    readonly yoffset: number
    /** The program blanked the display (`FBIOBLANK`): show black. */
    readonly blanked: boolean
    /**
     * The page the scanout shows, `height × lineLength` bytes: a view of the wasm heap, not a
     * copy, which the program's next store changes. It is made again when the heap has grown or
     * the scanout moved since the last call; empty once the program the framebuffer belonged to
     * is cleared or another starts.
     */
    visible(): Uint8Array
}

/** The program presented a page: it panned, synced `/dev/fb0` or blanked it, or Undo did. */
export type X86FramebufferPresent = {
    /** The first line the scanout shows now. */
    yoffset: number
}

/** A sound device a `soundCut` names: `/dev/dsp`, the raw MIDI port or the PC speaker. */
export type X86SoundDevice = 'dsp' | 'midi' | 'speaker'

/**
 * Samples `/dev/dsp` gives the card, decoded: stereo, interleaved, at the rate the program set,
 * the first heard at `start`. Each is a fragment, handed on the moment the card takes it.
 */
export type X86PcmEvent = {
    /** When the first frame plays, in nanoseconds of Program time's monotonic clock. */
    start: bigint
    /** Frames a second, as `SNDCTL_DSP_SPEED` set it; the host resamples. */
    rate: number
    /** Left and right, -1 to 1, one pair a frame. */
    frames: Float32Array
}

/** One complete message the raw MIDI port hands the synthesizer. */
export type X86MidiEvent = {
    /** When its last byte leaves the port, in nanoseconds of Program time. */
    at: bigint
    /** The whole message, its status included even when the program used running status. */
    message: Uint8Array
}

/** The PC speaker's square wave from `at` on, at the frequency the timer makes; 0 is silence. */
export type X86ToneEvent = { at: bigint; hz: number }

/**
 * The gains the program's mixer puts on `/dev/dsp`: `VOLUME` and `PCM`, 0 to 100 for the left and
 * the right. A channel the card has no control for stays at 100, whatever the program wrote to it.
 */
export type X86MixerEvent = { volume: [number, number]; pcm: [number, number] }

/**
 * Drop everything scheduled after `after` (nanoseconds of Program time) for `device`, or for every
 * sound device without one: Undo, `SNDCTL_DSP_RESET`, the MIDI port's `DROP`, a signal that ends
 * the program, and the end of the machine (`clearExecution()`, a new start) cut what has not been
 * heard yet.
 */
export type X86SoundCutEvent = { after: bigint; device?: X86SoundDevice }

export type X86EmulatorEventMap = {
    stateChange: { state: BlinkState; oldState: BlinkState }
    /**
     * The program panned the framebuffer, synced it or blanked it, or Undo moved the scanout:
     * show `getFramebuffer().visible()` now.
     */
    framebufferPresent: X86FramebufferPresent
    /** Samples `/dev/dsp` gives the card. */
    pcm: X86PcmEvent
    /** A message the raw MIDI port gives the synthesizer. */
    midi: X86MidiEvent
    /** The PC speaker's tone changes. */
    tone: X86ToneEvent
    /** The mixer's gains on `/dev/dsp`, at each start of a program and at every change. */
    mixer: X86MixerEvent
    /** What was scheduled after a time no longer plays. */
    soundCut: X86SoundCutEvent
    /** The terminal's mode at each start of a program, and whenever the program changes it. */
    terminalMode: X86TerminalMode
    /**
     * A program opened a device node the machine has but does not cover, such as
     * `/dev/dri/card0`: the open failed with `ENODEV`. `path` is the node's own path, whatever
     * link the program opened it through.
     */
    unsupportedDevice: { path: string }
    /** The bytes of one write to standard output, or to the terminal opened by another name. */
    stdout: Uint8Array
    /** The bytes of one write to standard error. */
    stderr: Uint8Array
    signal: { signal: number; code: number }
    inputRequest: X86InputRequest
    waitRequest: X86WaitRequest
    unimplementedSyscall: { number: number; name: string }
}

export type X86EmulatorEventName = keyof X86EmulatorEventMap

export type X86EmulatorEventHandler<T extends X86EmulatorEventName> = (
    event: X86EmulatorEventMap[T]
) => MaybePromise<void>

/**
 * A pending syscall. A null deadline means only one of its wake sources, or a signal, can end it.
 * A device that keeps time (a buffer draining, a port sending) folds the moment it is ready into
 * the deadline.
 */
export type X86WaitRequest = {
    clock: number
    deadlineNanoseconds: bigint | null
    remainingMilliseconds: number | null
    /** What can end the wait besides its deadline. */
    wakeSources: X86WakeSources
    /**
     * Whether the instruction waiting is a read of the terminal, which takes the input that ends
     * the wait: a raw read that `VTIME` times. False for `poll`, `select`, a sleep and a device's
     * wait, which input for the terminal can end without taking it. A read with nothing to time it
     * is an input request instead (`inputRequest`, `WaitingForInput`), with no wait request.
     */
    terminalRead: boolean
    instructionSerial: string
}
/** Synchronous sources are selected before initialize/start, including loader AT_RANDOM. */
export type X86Environment = {
    /** Linux clock id; milliseconds. Real-time=0, monotonic=1. */
    now?: (clock: number) => number
    /** Return exactly length bytes. Loader calls have null identity. */
    random?: (length: number, instructionSerial: string | null) => Uint8Array
    /** Optional transport; resolve to wake, reject to cancel with EINTR. */
    wait?: (request: X86WaitRequest, signal: AbortSignal) => Promise<void>
}

/** A clock/random hook failed or returned invalid data. */
export class X86EnvironmentError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), { cause })
        this.name = 'X86EnvironmentError'
    }
}

/** What an executable needs and which libraries could not be bundled. */
export type X86ExecutableInfo = {
    pie: boolean
    interpreter?: string
    needed: string[]
    missing: string[]
}
/** Bytes of the process-start block: where they start and how many, a string's NUL included. */
export type X86ProcessStartBytes = { address: bigint; length: number }

/**
 * What a Linux process starts with, as the loader wrote it above the initial stack pointer at the
 * program's last start (`getProcessStart()`): `argc`, the `argv[]`, `envp[]` and auxiliary vectors,
 * and the strings and bytes they point at. Addresses are the program's own; the facts are what the
 * loader wrote, whatever the program does to that memory afterwards.
 */
export type X86ProcessStart = {
    /** The initial `rsp`, where `argc` is: the block's first byte. */
    start: bigint
    /** One past its last byte, the end of the strings above it: the top of the stack. */
    end: bigint
    /** The number of arguments, `argv[0]` included, which the eight bytes at `start` hold. */
    argc: number
    /** The NULL-terminated array of pointers to the arguments, right after `argc`. */
    argv: bigint
    /** The NULL-terminated array of pointers to the environment's strings, after `argv`'s NULL. */
    envp: bigint
    /** The auxiliary vector, type and value pairs after `envp`'s NULL. */
    auxv: bigint
    /** One past the auxiliary vector's `AT_NULL` pair: the end of the vectors. */
    auxvEnd: bigint
    /** Each argument's string, `argv[0]` first. */
    arguments: X86ProcessStartBytes[]
    /** Each environment string, `NAME=value`, in `envp`'s order. */
    environment: X86ProcessStartBytes[]
    /** The program's path that `AT_EXECFN` points at. */
    execfn?: X86ProcessStartBytes
    /** The 16 random bytes `AT_RANDOM` points at, which seed the C library's stack guard. */
    random?: X86ProcessStartBytes
    /**
     * The program's path the loader writes first, at the very top, where Linux puts the file name
     * `AT_EXECFN` points at; this loader points `AT_EXECFN` at a copy of it below.
     */
    path?: X86ProcessStartBytes
}

/**
 * What a build or a load is doing, told to its `onProgress` as it moves on. `download` waits for a
 * file the Core downloads the first time it needs it, which over a slow network is where the time
 * goes: `resource` is what it is called, as a `ResourceDownloadError` names it, a Bundled library
 * by its soname (`libc.so.6`), an assembler (NASM or a blink-hosted one) as `the assembler` and
 * GNU ld as `the linker`. A build reports `assemble` and `link`, and a load `load` once its
 * libraries are at hand. With NASM, the linker's download comes between `assemble` and `link`,
 * once the program assembled; a blink-hosted assembler's build downloads both before `assemble`.
 */
export type X86Progress =
    | { phase: 'download'; resource: string }
    | { phase: 'assemble' }
    | { phase: 'link' }
    | { phase: 'load' }

export type X86BuildOptions = {
    /**
     * Told each phase of this build or load as it starts; never after a later one supersedes it.
     * The Core waits for the promise it returns before it carries on: assembling, linking and
     * loading each hold the thread for their whole run, so a page that shows the phase returns a
     * wait for its next paint, and the phase is on screen while it lasts.
     */
    onProgress?: (progress: X86Progress) => unknown
}

export type X86ExecutableOptions = X86BuildOptions & {
    argv0?: string
    arguments?: string[]
    protectedPath?: string | null
}

/** An ELF the loader mapped from a file: the program, the dynamic linker or a shared library. */
export type X86LoadedObject = {
    /**
     * Where the loader opened it. The program is `/program`, a path that exists only while the
     * loader reads it (it is removed before the first instruction); libraries are at their
     * Linux paths, such as `/lib/x86_64-linux-gnu/libc.so.6`.
     */
    path: string
    /** `DT_SONAME`, for a shared library that has one. */
    soname?: string
    /** The load bias: what is added to the ELF's link-time addresses. */
    base: bigint
    /** The end of its highest segment, page-aligned, as a runtime address. */
    end: bigint
    /** True for the program itself, false for the dynamic linker and libraries. */
    main: boolean
}
