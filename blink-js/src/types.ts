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

export type X86Project = {
    entry: string
    files: Readonly<Record<string, X86ProjectFile>>
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
