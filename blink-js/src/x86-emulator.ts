import {
    BaseEmulator,
    EmulatorStatus,
    RegisterSize,
    type EmulatorDecoration,
    type ExecutionStep,
    type Instruction,
    type MonacoError,
    type StackFrame,
} from './interface'
import { type AssemblerId, type AssemblerMode } from './assemblers'
import { BlinkRuntime, type BlinkRuntimeCallbacks, type BlinkRuntimeOptions } from './blink-runtime'
import {
    BlinkState,
    X86_REGISTER_NAMES,
    type StopReason,
    type X86CompileResult,
    type X86EmulatorEventHandler,
    type X86EmulatorEventMap,
    type X86EmulatorEventName,
    type X86RegisterName,
} from './types'
import type { BlinkenlibModule } from './wasm-types'

export type X86EmulatorOptions = Omit<BlinkRuntimeOptions, 'callbacks' | 'mode'> & {
    mode?: AssemblerMode | AssemblerId
    callbacks?: BlinkRuntimeCallbacks
}

export class X86Emulator extends BaseEmulator<BlinkRuntime, X86RegisterName, X86CompileResult> {
    readonly runtime: BlinkRuntime

    private readonly eventHandlers: {
        [K in X86EmulatorEventName]: Set<X86EmulatorEventHandler<K>>
    } = {
        stateChange: new Set(),
        stdout: new Set(),
        stderr: new Set(),
        signal: new Set(),
        inputRequest: new Set(),
    }

    private lastCompileResult: X86CompileResult | null = null
    private lastSourceCode = ''

    private constructor(runtime: BlinkRuntime) {
        super({
            systemSize: RegisterSize.Double,
            registerNames: [...X86_REGISTER_NAMES],
            endianness: 'little',
        })
        this.runtime = runtime
    }

    static async create(options: X86EmulatorOptions = {}): Promise<X86Emulator> {
        let emulator: X86Emulator | null = null
        const runtime = await BlinkRuntime.create({
            ...options,
            callbacks: {
                ...options.callbacks,
                stdout: (charCode) => {
                    options.callbacks?.stdout?.(charCode)
                    emulator?.emit('stdout', charCode)
                },
                stderr: (charCode) => {
                    options.callbacks?.stderr?.(charCode)
                    emulator?.emit('stderr', charCode)
                },
                signal: (signal, code) => {
                    options.callbacks?.signal?.(signal, code)
                    emulator?.emit('signal', { signal, code })
                },
                stateChange: (state, oldState) => {
                    options.callbacks?.stateChange?.(state, oldState)
                    emulator?.emit('stateChange', { state, oldState })
                },
                inputRequest: (event) => {
                    options.callbacks?.inputRequest?.(event)
                    emulator?.emit('inputRequest', event)
                },
            },
        })
        emulator = new X86Emulator(runtime)
        return emulator
    }

    get module(): BlinkenlibModule {
        return this.runtime.module
    }

    get state(): BlinkState {
        return this.runtime.state
    }

    get stopReason(): StopReason | null {
        return this.runtime.stopReason
    }

    on<T extends X86EmulatorEventName>(
        eventName: T,
        handler: X86EmulatorEventHandler<T>,
    ): () => void {
        this.eventHandlers[eventName].add(handler)
        return () => this.eventHandlers[eventName].delete(handler)
    }

    async setMode(mode: AssemblerMode | AssemblerId): Promise<void> {
        await this.runtime.setMode(mode)
    }

    async compile(code: string): Promise<X86CompileResult> {
        this.lastSourceCode = code
        this.lastCompileResult = await this.runtime.compileAssembly(code)
        return this.lastCompileResult
    }

    loadElf(data: ArrayBuffer | Uint8Array): void {
        this.runtime.loadElf(data)
    }

    async runUntilBlocked(): Promise<EmulatorStatus> {
        await this.runtime.runUntilBlocked()
        return this.getStatus()
    }

    provideInput(line: string): void {
        this.runtime.provideInput(line)
    }

    initialize(_undoSize: number): void {
        this.lastCompileResult = null
        this.lastSourceCode = ''
    }

    getCompiledCode(): { decorations: EmulatorDecoration[]; code: string } {
        return { decorations: [], code: this.lastSourceCode }
    }

    dispose(): void {
        this.eventHandlers.stateChange.clear()
        this.eventHandlers.stdout.clear()
        this.eventHandlers.stderr.clear()
        this.eventHandlers.signal.clear()
        this.eventHandlers.inputRequest.clear()
    }

    stringifyError(error: unknown): string {
        if (error instanceof Error) return error.message
        return String(error)
    }

    async checkCode(code: string): Promise<MonacoError[]> {
        const result = await this.compile(code)
        const errors = result.ok === false ? result.errors : []
        const lines = code.split(/\r?\n/)
        return errors.map((error) => ({
            lineIndex: Math.max(0, error.line - 1),
            column: 0,
            line: {
                line: lines[Math.max(0, error.line - 1)] ?? '',
                line_index: Math.max(0, error.line - 1),
            },
            message: error.error,
            formatted: error.error,
        }))
    }

    undo(): void {}

    canUndo(): boolean {
        return false
    }

    async step(): Promise<{ terminated: boolean }> {
        this.runtime.step()
        return { terminated: this.hasTerminated() }
    }

    getStatus(): EmulatorStatus {
        if (this.runtime.state === BlinkState.NotReady) return EmulatorStatus.NotReady
        if (this.runtime.state === BlinkState.ProgramReadlinePause) return EmulatorStatus.WaitingForInput
        if (this.runtime.state === BlinkState.ProgramStopped) return EmulatorStatus.Terminated
        return EmulatorStatus.Running
    }

    writeMemoryBytes(address: bigint, data: Uint8Array): void {
        this.runtime.writeMemoryBytes(address, data)
    }

    readMemoryBytes(address: bigint, length: bigint): Uint8Array {
        return this.runtime.readMemoryBytes(address, length)
    }

    getNextInstruction(): Instruction | null {
        return this.getInstructionAt(this.getPc())
    }

    getUndoHistory(_max: number): ExecutionStep[] {
        return []
    }

    getPc(): bigint {
        return this.runtime.getPc()
    }

    getSp(): bigint {
        return this.runtime.getSp()
    }

    getFlags(): { name: string; value: number; prev?: number }[] {
        const flags = this.runtime.getFlags()
        return X86_FLAGS.map((flag) => ({
            name: flag.name,
            value: (flags & BigInt(flag.mask)) > 0n ? 1 : 0,
        }))
    }

    getCallStack(): StackFrame[] {
        return []
    }

    getInstructionAt(address: bigint): Instruction | null {
        const instruction = this.runtime.getInstructionAt(address)
        if (!instruction) return null
        return {
            address: instruction.address,
            lineNumber: this.runtime.getSourceLineForAddress(instruction.address) ?? -1,
            code: instruction.code,
        }
    }

    getRegisterValues(): bigint[] {
        return X86_REGISTER_NAMES.map((register) => this.getRegisterValue(register))
    }

    getRegisterValuesRecord(): Record<X86RegisterName, bigint> {
        return Object.fromEntries(
            X86_REGISTER_NAMES.map((register) => [register, this.getRegisterValue(register)]),
        ) as Record<X86RegisterName, bigint>
    }

    getRegisterValue(register: X86RegisterName, size: RegisterSize = RegisterSize.Double): bigint {
        return maskRegisterValue(this.runtime.getRegister(register), size)
    }

    setRegisterValue(register: X86RegisterName, value: bigint, size: RegisterSize = RegisterSize.Double): void {
        const current = this.runtime.getRegister(register)
        const masked = maskRegisterValue(value, size)
        const preserved = size === RegisterSize.Double ? masked : (current & ~maskForSize(size)) | masked
        this.runtime.setRegister(register, preserved)
    }

    hasTerminated(): boolean {
        return this.runtime.state === BlinkState.ProgramStopped
    }

    async run(limit?: number, breakpoints: number[] = []): Promise<EmulatorStatus> {
        this.validateRunLimit(limit)
        const breakpointAddresses = this.resolveBreakpointAddresses(breakpoints)
        if (breakpointAddresses.length) return this.runWithBreakpoints(limit, breakpointAddresses)
        await this.runtime.runUntilBlocked({ limit, breakpointAddresses })
        return this.getStatus()
    }

    private validateRunLimit(limit: number | undefined): void {
        if (limit === undefined) return
        if (!Number.isSafeInteger(limit) || limit < 0) {
            throw new Error(`Invalid run instruction limit: ${limit}`)
        }
    }

    private resolveBreakpointAddresses(breakpoints: number[]): bigint[] {
        const addresses = new Map<string, bigint>()
        for (const lineIndex of breakpoints) {
            if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) {
                throw new Error(`Invalid breakpoint line index: ${lineIndex}`)
            }
            for (const address of this.runtime.getAddressesForSourceLine(lineIndex)) {
                addresses.set(address.toString(), address)
            }
        }
        return [...addresses.values()]
    }

    private async runWithBreakpoints(limit: number | undefined, breakpointAddresses: bigint[]): Promise<EmulatorStatus> {
        const breakpointSet = new Set(breakpointAddresses.map((address) => address.toString()))
        const hasLimit = limit !== undefined && limit > 0
        let executedInstructions = 0

        if (this.runtime.state === BlinkState.ProgramLoaded || this.runtime.state === BlinkState.ProgramStopped) {
            this.runtime.starti()
        }
        if (this.runtime.state === BlinkState.ProgramPaused) {
            this.runtime.continue()
        }

        while (this.runtime.state === BlinkState.ProgramRunning) {
            const pc = this.getPc()
            if (breakpointSet.has(pc.toString())) {
                this.runtime.pauseForBreakpoint(pc, this.runtime.getSourceLineForAddress(pc) ?? undefined)
                return this.getStatus()
            }
            if (hasLimit && executedInstructions >= limit) {
                this.runtime.pauseForLimit(pc, BigInt(executedInstructions))
                return this.getStatus()
            }

            await this.step()
            executedInstructions += 1
            if (executedInstructions % 10000 === 0) await deferToHost()
        }

        return this.getStatus()
    }

    private emit<T extends X86EmulatorEventName>(eventName: T, event: X86EmulatorEventMap[T]): void {
        for (const handler of this.eventHandlers[eventName]) handler(event)
    }
}

export async function createX86Emulator(options: X86EmulatorOptions = {}): Promise<X86Emulator> {
    return X86Emulator.create(options)
}

const X86_FLAGS = [
    { name: 'CF', mask: 0x00000001 },
    { name: 'PF', mask: 0x00000004 },
    { name: 'AF', mask: 0x00000010 },
    { name: 'ZF', mask: 0x00000040 },
    { name: 'SF', mask: 0x00000080 },
    { name: 'TF', mask: 0x00000100 },
    { name: 'DF', mask: 0x00000400 },
    { name: 'OF', mask: 0x00000800 },
] as const

function maskForSize(size: RegisterSize): bigint {
    return (1n << BigInt(size * 8)) - 1n
}

function maskRegisterValue(value: bigint, size: RegisterSize): bigint {
    return value & maskForSize(size)
}

function deferToHost(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}