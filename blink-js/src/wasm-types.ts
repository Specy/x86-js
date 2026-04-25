import type { X86RegisterName } from './types'

export type EmscriptenFS = {
    init(stdin: () => number | null, stdout: (charCode: number) => void, stderr: (charCode: number) => void): void
    writeFile(path: string, data: string | Uint8Array): void
    open(path: string, flags: string): unknown
    write(stream: unknown, data: Uint8Array, offset: number, length: number, position: number): void
    close(stream: unknown): void
    chmod(path: string, mode: number): void
    readFile(path: string, options?: { encoding?: 'binary' | 'utf8' }): Uint8Array | string
}

export type BlinkenlibModuleOptions = {
    noInitialRun?: boolean
    preRun?: (module: BlinkenlibModule) => void
    instantiateWasm?: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
    ) => void
}

export type RegisterSnapshot = {
    registers: Record<X86RegisterName, bigint>
    rip: bigint
    rsp: bigint
    pc: bigint
    flags: number
}

export type MemoryReadResult =
    | { ok: true; bytes: number[] }
    | { ok: false; error: string; readBytes: number }

export type MemoryWriteResult =
    | { ok: true; writtenBytes: number }
    | { ok: false; error: string; writtenBytes: number }

export type NativeRunStopKind = 'none' | 'breakpoint' | 'limit'

export type NativeRunStop = {
    kind: NativeRunStopKind
    address: bigint
    executedInstructions: bigint
}

export type NativeRunControls = {
    breakpoints: bigint[]
}

export type NativeInstruction = {
    address: bigint
    size: number
    code: string
}

export type DisassemblySnapshot = {
    lines: string[]
    currentLine: number
}

export type BlinkenlibModule = {
    FS: EmscriptenFS
    callMain(args: string[]): void
    addFunction(fn: (...args: never[]) => void, signature: string): number
    _blinkenlib_run_fast(): void
    _blinkenlib_run(): void
    _blinkenlib_start(): void
    _blinkenlib_starti(): void
    _blinkenlib_stepi(): void
    _blinkenlib_continue(): void
    _blinkenlib_preempt_resume(): void
    _blinkenlib_faketty_resume(): void
    blinkenlibGetRegister(register: X86RegisterName): bigint
    blinkenlibSetRegister(register: X86RegisterName, value: bigint): boolean
    blinkenlibGetRegisterSnapshot(): RegisterSnapshot
    blinkenlibReadMemoryBytes(address: bigint, length: number): MemoryReadResult
    blinkenlibWriteMemoryBytes(address: bigint, bytes: Uint8Array | number[]): MemoryWriteResult
    blinkenlibGetDisassembly(): DisassemblySnapshot
    blinkenlibSetEmulationArgs(progname: string, argc: string, argv: string): void
    blinkenlibGetInputMaxBytes(): bigint
    blinkenlibSetRunControls(limit: bigint, breakpointAddresses: string[]): void
    blinkenlibGetRunControls(): NativeRunControls
    blinkenlibGetRunStop(): NativeRunStop
    blinkenlibGetInstructionAt(address: bigint): NativeInstruction | null
}