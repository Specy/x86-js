import type { X86RegisterName } from './types'

/** A node of Emscripten's file system, as `lookupPath` returns it. */
export type EmscriptenFSNode = {
    /** The type and permission bits. */
    mode: number
    /** A device's number. */
    rdev?: number
    /** The file system the node belongs to, whose `root` is the directory it is mounted as. */
    mount?: { root: EmscriptenFSNode }
    [key: string]: unknown
}

export type EmscriptenFS = {
    ErrnoError: new (errno: number) => Error
    FSNode: new (parent: unknown, name: string, mode: number, rdev: number) => EmscriptenFSNode
    createNode(parent: unknown, name: string, mode: number, rdev: number): EmscriptenFSNode
    destroyNode(node: EmscriptenFSNode): void
    closeStream(fd: number): void
    mount(
        type: { mount(mount: unknown): EmscriptenFSNode },
        opts: object,
        path: string
    ): EmscriptenFSNode
    unmount(path: string): void
    init(
        stdin: () => number | null,
        stdout: (byte: number) => void,
        stderr: (byte: number) => void
    ): void
    writeFile(path: string, data: string | Uint8Array): void
    open(path: string, flags: string | number): unknown
    write(
        stream: unknown,
        data: Uint8Array,
        offset: number,
        length: number,
        position?: number
    ): number
    close(stream: unknown): void
    read(
        stream: unknown,
        data: Uint8Array,
        offset: number,
        length: number,
        position?: number
    ): number
    chmod(path: string, mode: number): void
    readFile(path: string, options?: { encoding?: 'binary' | 'utf8' }): Uint8Array | string
    mkdir(path: string, mode?: number): void
    mkdirTree(path: string): void
    mkdev(path: string, mode: number, dev: number): void
    symlink(target: string, path: string): void
    readlink(path: string): string
    readdir(path: string): string[]
    rmdir(path: string): void
    unlink(path: string): void
    chdir(path: string): void
    cwd(): string
    lookupPath(
        path: string,
        options?: { follow?: boolean; follow_mount?: boolean }
    ): { path: string; node: EmscriptenFSNode }
    isMountpoint(node: EmscriptenFSNode): boolean
}

export type BlinkenlibModuleOptions = {
    noInitialRun?: boolean
    preRun?: (module: BlinkenlibModule) => void
    instantiateWasm?: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void
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
    { ok: true; bytes: number[] } | { ok: false; error: string; readBytes: number }

export type MemoryWriteResult =
    { ok: true; writtenBytes: number } | { ok: false; error: string; writtenBytes: number }

export type NativeRunStopKind = 'none' | 'breakpoint' | 'limit'

export type NativeRunStop = {
    kind: NativeRunStopKind
    address: bigint
    executedInstructions: bigint
}

export type NativeRunControls = {
    breakpoints: bigint[]
}

export type NativeControlFlowKind = 'none' | 'call' | 'return'

export type NativeMemoryWrite = {
    address: bigint
    size: number
    old: number[]
    truncated: boolean
}

export type NativeStepInfo =
    | {
          valid: false
          memoryWrites: NativeMemoryWrite[]
      }
    | {
          valid: true
          pcBefore: bigint
          pcAfter: bigint
          spBefore: bigint
          spAfter: bigint
          flagsBefore: number
          flagsAfter: number
          controlFlow: NativeControlFlowKind
          truncatedMemoryWrites: boolean
          memoryWrites: NativeMemoryWrite[]
      }

export type NativeSymbol = {
    address: bigint
    name: string
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
    blinkHostNow?: (clock: number) => number
    blinkHostRandom?: (pointer: number, length: number) => void
    blinkHostError?: unknown
    _blinkenlib_instructions_executed(): bigint
    _blinkenlib_active_instruction(): bigint
    _blinkenlib_wait_pending(): boolean
    _blinkenlib_wait_input(): boolean
    _blinkenlib_wait_clock(): number
    _blinkenlib_wait_deadline(): bigint
    _blinkenlib_timer_deadline(): bigint
    _blinkenlib_wait_cancel(): void
    _blinkenlib_abandon_execution(): void
    _blinkenlib_clear_execution(): void
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
    /** Opt in to refreshing the legacy listing only when explicitly requested. */
    _blinkenlib_set_deferred_disassembly?(enabled: boolean): void
    /** Optional bulk/scalar exports, with the Embind APIs retained as fallbacks. */
    _blinkenlib_get_register_snapshot?(): number
    _blinkenlib_get_fpu_snapshot?(): number
    _blinkenlib_get_pc?(): bigint
    _blinkenlib_get_flags?(): number
    _blinkenlib_run_slice?(budget: number, skipAtPc: boolean): void
    _blinkenlib_history_version?(): number
    _blinkenlib_history_capacity?(capacity: number): void
    _blinkenlib_history_clear?(): void
    _blinkenlib_history_count?(): number
    _blinkenlib_history_entry?(offset: number): number
    _blinkenlib_history_can_undo?(): boolean
    _blinkenlib_history_mark_irreversible?(): void
    _blinkenlib_history_undo?(): number
    _blinkenlib_history_stack_depth?(): number
    _blinkenlib_history_frame?(index: number): number
    _blinkenlib_history_begin_poke?(): boolean
    _blinkenlib_history_end_poke?(): number
    blinkenlibGetRegister(register: X86RegisterName): bigint
    blinkenlibSetRegister(register: X86RegisterName, value: bigint): boolean
    blinkenlibSetFlags(flags: number): void
    blinkenlibSetStepRecording(enabled: boolean): void
    blinkenlibGetRegisterSnapshot(): RegisterSnapshot
    /** A copy of the packed FPU state block; empty when there is no machine. */
    blinkenlibGetFpuState(): Uint8Array
    /** Restores the whole packed FPU state block; false when there is no machine or the length is wrong. */
    blinkenlibSetFpuState(bytes: Uint8Array | number[]): boolean
    /**
     * The host address of a guest byte inside the wasm heap, or 0 when the
     * address is not mapped - the same lookup `blinkenlibReadMemoryBytes` does
     * per byte, without building a JavaScript array. Optional: a build whose
     * bridge does not export it simply has no fast read path.
     */
    _blinkenlib_spy_address?(address: bigint): number
    /** The wasm instance's own exports; `memory.buffer` is the heap `_blinkenlib_spy_address` points into. */
    wasmExports?: {
        memory?: { buffer: ArrayBuffer }
        /**
         * How many entries the history has recorded since the module loaded, never going down
         * (see `X86Emulator.getRecordedEntryCount()`). The glue does not bind it, so it is
         * reached here, unprefixed.
         */
        blinkenlib_history_recorded?: () => bigint
    }
    blinkenlibReadMemoryBytes(address: bigint, length: number): MemoryReadResult
    blinkenlibWriteMemoryBytes(address: bigint, bytes: Uint8Array | number[]): MemoryWriteResult
    blinkenlibGetDisassembly(): DisassemblySnapshot
    blinkenlibSetEmulationArgs(progname: string, argc: string, argv: string): void
    /** How many bytes the read waiting for input asked for. */
    blinkenlibGetInputMaxBytes(): bigint
    /** Appends bytes to the terminal's input. */
    blinkenlibProvideInput(bytes: Uint8Array): void
    /** Appends an End of input token, which ends one read with 0 bytes. */
    blinkenlibProvideEndOfInput(): void
    /** Discards the terminal's input, bytes and End of input alike. */
    blinkenlibClearInput(): void
    blinkenlibSetRunControls(limit: bigint, breakpointAddresses: string[]): void
    blinkenlibGetRunControls(): NativeRunControls
    blinkenlibGetRunStop(): NativeRunStop
    blinkenlibGetLastStepInfo(): NativeStepInfo
    blinkenlibGetInstructionAt(address: bigint): NativeInstruction | null
    blinkenlibResolveSymbol(address: bigint): NativeSymbol | null
    /** The system calls the dispatcher was compiled with, in no particular order. */
    blinkenlibGetSyscalls(): NativeSyscall[]
}

export type NativeSyscall = {
    number: number
    name: string
    arity: number
}
