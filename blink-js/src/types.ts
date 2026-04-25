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
    executedInstructions?: bigint
}

export type X86CompilationDiagnostic = {
    line: number
    error: string
}

export type X86CompileResult =
    | { ok: true; report: string }
    | { ok: false; errors: X86CompilationDiagnostic[]; report: string }

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
