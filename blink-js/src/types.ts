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
    'exit' | 'signal' | 'input' | 'wait' | 'limit' | 'breakpoint' | 'load-fail' | 'host-error'

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
 * The default NASM assembler assembles the Entry and every `.asm`, `.s` or `.nasm` File that no
 * other File `%include`s, each as a unit of its own, and links them the way a C toolchain links
 * objects and a static library: the Entry's unit as an object, and every other unit as a member
 * of an archive that `ld` takes a member from only for a symbol still undefined, `_start`
 * included. A unit nothing needs is assembled, and its mistakes reported, but it is not part of
 * the program, so a Project can hold Files that would otherwise clash, such as a second `_start`.
 * The blink-hosted assemblers, GNU as and fasm, assemble the Entry alone.
 */
export type X86Project = {
    entry: string
    files: Readonly<Record<string, X86ProjectFile>>
    /**
     * Units built alongside the Project's own, such as start code that defines `_start` and calls
     * `main`: each is assembled like a Project File, under its own path, which instructions,
     * breakpoints and diagnostics name as they name a File's. A library path and a File's path
     * must differ, and neither may be a directory of the other. A library unit is never the
     * Entry, and the Project's Files cannot `%include` it. It goes into the archive ahead of the
     * Project's other units, so `ld` takes it first for a symbol both define.
     */
    library?: Readonly<Record<string, X86ProjectFile>>
}

export type X86SourceLocation = {
    path: string
    /** Zero-based source line. */
    line: number
}

export type X86Breakpoint = number | X86SourceLocation

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

export type X86EmulatorEventMap = {
    stateChange: { state: BlinkState; oldState: BlinkState }
    /** The bytes of one write to standard output, or to the terminal opened by another name. */
    stdout: Uint8Array
    /** The bytes of one write to standard error. */
    stderr: Uint8Array
    signal: { signal: number; code: number }
    inputRequest: X86InputRequest
    waitRequest: X86WaitRequest
}

export type X86EmulatorEventName = keyof X86EmulatorEventMap

export type X86EmulatorEventHandler<T extends X86EmulatorEventName> = (
    event: X86EmulatorEventMap[T]
) => MaybePromise<void>

/** A pending syscall. Null deadline means an external wake source is required. */
export type X86WaitRequest = {
    clock: number
    deadlineNanoseconds: bigint | null
    remainingMilliseconds: number | null
    acceptsInput: boolean
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
