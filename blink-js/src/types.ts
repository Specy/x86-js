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
    'rip',
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
    ProgramStopped = 'PROGRAM_STOPPED',
}

export type StopReasonKind = 'exit' | 'signal' | 'input' | 'limit' | 'breakpoint' | 'load-fail'

export type StopReason = {
    loadFail: boolean
    exitCode: number
    details: string
    kind?: StopReasonKind
    address?: bigint
    lineNumber?: number
    file?: string
    executedInstructions?: bigint
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
    | { ok: false; errors: X86CompilationDiagnostic[]; report: string; diagnostics: X86CompilationDiagnostic[] }

export type X86EmulatorEventMap = {
    stateChange: { state: BlinkState; oldState: BlinkState }
    stdout: number
    stderr: number
    signal: { signal: number; code: number }
    inputRequest: { maxBytes: bigint }
}

export type X86EmulatorEventName = keyof X86EmulatorEventMap

export type X86EmulatorEventHandler<T extends X86EmulatorEventName> = (
    event: X86EmulatorEventMap[T],
) => MaybePromise<void>
