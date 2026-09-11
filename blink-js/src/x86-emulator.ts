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
    type X86Breakpoint,
    type X86EmulatorEventHandler,
    type X86EmulatorEventMap,
    type X86EmulatorEventName,
    type X86RegisterName,
    type X86Project,
} from './types'
import { x86ProjectText } from './project'
import type {
    BlinkenlibModule,
    NativeInstruction,
    NativeMemoryWrite,
    NativeStepInfo,
    RegisterSnapshot,
} from './wasm-types'
import {
    CircularHistory,
    X86_FLAGS,
    cloneCallStack,
    cloneRegisterValues,
    deferToHost,
    makeFrameColor,
    maskForSize,
    maskRegisterValue,
    stripPrivateHistory,
    toHistoryPc,
    type UndoMemoryWrite,
    type X86HistoryEntry,
} from './x86-emulator-utils'
import { observeCallbackResult } from './callbacks'

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
    private history = new CircularHistory<X86HistoryEntry>(0)
    private callStack: StackFrame[] = []

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
                    const result = options.callbacks?.stdout?.(charCode)
                    emulator?.emit('stdout', charCode)
                    return result
                },
                stderr: (charCode) => {
                    const result = options.callbacks?.stderr?.(charCode)
                    emulator?.emit('stderr', charCode)
                    return result
                },
                signal: (signal, code) => {
                    const result = options.callbacks?.signal?.(signal, code)
                    emulator?.emit('signal', { signal, code })
                    return result
                },
                stateChange: (state, oldState) => {
                    const result = options.callbacks?.stateChange?.(state, oldState)
                    emulator?.emit('stateChange', { state, oldState })
                    return result
                },
                inputRequest: (event) => {
                    const result = options.callbacks?.inputRequest?.(event)
                    emulator?.emit('inputRequest', event)
                    return result
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
        this.clearExecutionTrace()
        await this.runtime.setMode(mode)
    }

    async compile(code: string): Promise<X86CompileResult> {
        return this.compileProject({ entry: 'assembly.s', files: { 'assembly.s': code } })
    }

    async compileProject(project: X86Project): Promise<X86CompileResult> {
        this.clearExecutionTrace()
        this.lastSourceCode = x86ProjectText(project, project.entry)
        this.lastCompileResult = await this.runtime.compileProject(project)
        return this.lastCompileResult
    }

    loadElf(data: ArrayBuffer | Uint8Array): void {
        this.clearExecutionTrace()
        this.runtime.loadElf(data)
    }

    async runUntilBlocked(): Promise<EmulatorStatus> {
        if (this.isTracingEnabled()) return this.run()
        await this.runtime.runUntilBlocked()
        return this.getStatus()
    }

    provideInput(line: string): void {
        this.runtime.provideInput(line)
    }

    initialize(undoSize: number): void {
        const undoLimit = Number.isFinite(undoSize) ? Math.max(0, Math.floor(undoSize)) : 0
        this.history = new CircularHistory<X86HistoryEntry>(undoLimit)
        this.clearExecutionTrace()
        this.runtime.setStepRecording(this.isTracingEnabled())
    }

    getCompiledCode(): { decorations: EmulatorDecoration[]; code: string } {
        return { decorations: [], code: this.lastSourceCode }
    }

    dispose(): void {
        this.runtime.setStepRecording(false)
        this.clearExecutionTrace()
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
        return this.checkProject({ entry: 'assembly.s', files: { 'assembly.s': code } })
    }

    async checkProject(project: X86Project): Promise<MonacoError[]> {
        const result = await this.compileProject(project)
        const errors = result.ok === false ? result.errors : []
        return errors.map((error) => {
            const path = error.file ?? project.entry
            const lineIndex = Math.max(0, error.line - 1)
            const lines = x86ProjectText(project, path).split(/\r?\n/)
            return {
                file: path,
                lineIndex,
                column: 0,
                line: {
                    line: lines[lineIndex] ?? '',
                    line_index: lineIndex,
                },
                message: error.error,
                formatted: error.error,
            }
        })
    }

    undo(): void {
        const entry = this.history.pop()
        if (!entry) return
        if (!entry.reversible) {
            this.history.push(entry)
            throw new Error('The latest x86 step cannot be undone because its memory writes were too large to capture')
        }

        for (let index = entry.memoryWrites.length - 1; index >= 0; index -= 1) {
            const write = entry.memoryWrites[index]
            if (write) this.runtime.writeMemoryBytes(write.address, Uint8Array.from(write.old))
        }
        for (const register of X86_REGISTER_NAMES) {
            this.runtime.setRegister(register, entry.registersBefore[register])
        }
        this.runtime.setFlags(entry.flagsBefore)
        this.callStack = cloneCallStack(entry.callStackBefore)
        this.runtime.resumeAfterStateMutation()
    }

    canUndo(): boolean {
        const entry = this.history.peekNewest()
        return Boolean(entry?.reversible)
    }

    async step(): Promise<{ terminated: boolean }> {
        if (this.isTracingEnabled()) {
            this.captureStep()
        } else {
            this.prepareOneInstructionRun()
            this.runtime.step()
        }
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
        if (this.runtime.state === BlinkState.ProgramLoaded) this.runtime.pauseAtEntry()
        return this.getInstructionAt(this.getPc())
    }

    getUndoHistory(max: number): ExecutionStep[] {
        const count = Math.max(0, Math.floor(max))
        if (count === 0) return []
        return this.history.newestFirst(count).map(stripPrivateHistory)
    }

    getPc(): bigint {
        return this.runtime.getPc()
    }

    getSp(): bigint {
        return this.runtime.getSp()
    }

    getFlags(): { name: string; value: number; prev?: number }[] {
        const flags = this.runtime.getFlags()
        const latest = this.history.peekNewest()
        const previousFlags = latest ? BigInt(latest.flagsBefore) : flags
        return X86_FLAGS.map((flag) => ({
            name: flag.name,
            value: (flags & BigInt(flag.mask)) > 0n ? 1 : 0,
            prev: (previousFlags & BigInt(flag.mask)) > 0n ? 1 : 0,
        }))
    }

    getCallStack(): StackFrame[] {
        return cloneCallStack(this.callStack)
    }

    getInstructionAt(address: bigint): Instruction | null {
        const instruction = this.runtime.getInstructionAt(address)
        if (!instruction) return null
        const location = this.runtime.getSourceLocationForAddress(instruction.address)
        return {
            address: instruction.address,
            lineNumber: location?.line ?? -1,
            file: location?.path,
            size: instruction.size,
            bytes: this.runtime.readMemoryBytes(instruction.address, BigInt(instruction.size)),
            code: instruction.code,
        }
    }

    /** Every instruction address represented in the linked program's DWARF source map. */
    getCompiledInstructions(): Instruction[] {
        // Compiling leaves the ELF on the virtual filesystem but does not map it into Blink's
        // memory until execution starts. Load and pause at its entry before reading instruction
        // bytes; callers commonly request build metadata before their first step.
        if (this.runtime.state === BlinkState.ProgramLoaded) this.runtime.pauseAtEntry()
        return this.runtime.getSourceMappedAddresses().flatMap((address) => {
            const instruction = this.getInstructionAt(address)
            return instruction ? [instruction] : []
        })
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

    async run(limit?: number, breakpoints: X86Breakpoint[] = []): Promise<EmulatorStatus> {
        this.validateRunLimit(limit)
        const breakpointAddresses = this.resolveBreakpointAddresses(breakpoints)
        if (this.isTracingEnabled()) return this.runWithHistory(limit, breakpointAddresses)
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

    private resolveBreakpointAddresses(breakpoints: X86Breakpoint[]): bigint[] {
        const addresses = new Map<string, bigint>()
        for (const breakpoint of breakpoints) {
            const lineIndex = typeof breakpoint === 'number' ? breakpoint : breakpoint.line
            if (!Number.isSafeInteger(lineIndex) || lineIndex < 0) {
                throw new Error(`Invalid breakpoint line index: ${lineIndex}`)
            }
            const resolved =
                typeof breakpoint === 'number'
                    ? this.runtime.getAddressesForSourceLine(lineIndex)
                    : this.runtime.getAddressesForSourceLocation(breakpoint)
            for (const address of resolved) {
                addresses.set(address.toString(), address)
            }
        }
        return [...addresses.values()]
    }

    private async runWithBreakpoints(limit: number | undefined, breakpointAddresses: bigint[]): Promise<EmulatorStatus> {
        const breakpointSet = new Set(breakpointAddresses.map((address) => address.toString()))
        const hasLimit = limit !== undefined && limit > 0
        let executedInstructions = 0

        this.prepareOneInstructionRun()

        while (this.runtime.state === BlinkState.ProgramRunning) {
            const pc = this.getPc()
            if (breakpointSet.has(pc.toString())) {
                this.runtime.pauseForBreakpoint(
                    pc,
                    this.runtime.getSourceLocationForAddress(pc) ?? undefined,
                )
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

    private async runWithHistory(limit: number | undefined, breakpointAddresses: bigint[]): Promise<EmulatorStatus> {
        const breakpointSet = new Set(breakpointAddresses.map((address) => address.toString()))
        const hasLimit = limit !== undefined && limit > 0
        let executedInstructions = 0

        this.prepareOneInstructionRun()

        while (this.runtime.state === BlinkState.ProgramRunning) {
            const pc = this.getPc()
            if (breakpointSet.has(pc.toString())) {
                this.runtime.pauseForBreakpoint(
                    pc,
                    this.runtime.getSourceLocationForAddress(pc) ?? undefined,
                )
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

    private isTracingEnabled(): boolean {
        return this.history.capacity > 0
    }

    private clearExecutionTrace(): void {
        this.history.clear()
        this.callStack = []
    }

    private prepareOneInstructionRun(): void {
        if (this.runtime.state === BlinkState.ProgramLoaded || this.runtime.state === BlinkState.ProgramStopped) {
            this.runtime.starti()
            return
        }
        if (this.runtime.state === BlinkState.ProgramPaused) {
            this.runtime.resumeAfterStateMutation()
        }
    }

    private captureStep(): void {
        this.prepareOneInstructionRun()
        const before = this.runtime.getRegisterSnapshot()
        const instruction = this.runtime.getInstructionAt(before.pc)
        const callStackBefore = cloneCallStack(this.callStack)

        this.runtime.step()

        const after = this.runtime.getRegisterSnapshot()
        const nativeStep = this.runtime.getLastStepInfo()
        this.recordStep(before, after, nativeStep, instruction, callStackBefore)
    }

    private recordStep(
        before: RegisterSnapshot,
        after: RegisterSnapshot,
        nativeStep: NativeStepInfo,
        instruction: NativeInstruction | null,
        callStackBefore: StackFrame[],
    ): void {
        const registersBefore = cloneRegisterValues(before)
        const registersAfter = cloneRegisterValues(after)
        const pcBefore = nativeStep.valid ? nativeStep.pcBefore : before.pc
        const pcAfter = nativeStep.valid ? nativeStep.pcAfter : after.pc
        const flagsBefore = nativeStep.valid ? nativeStep.flagsBefore : before.flags
        const flagsAfter = nativeStep.valid ? nativeStep.flagsAfter : after.flags
        const mutations: ExecutionStep['mutations'] = []

        for (const register of X86_REGISTER_NAMES) {
            if (register === 'rip') continue
            if (registersBefore[register] !== registersAfter[register]) {
                mutations.push({
                    type: 'WriteRegister',
                    value: {
                        register,
                        old: registersBefore[register],
                        size: RegisterSize.Double,
                    },
                })
            }
        }

        const memoryWrites = nativeStep.valid ? this.recordMemoryMutations(nativeStep.memoryWrites, mutations) : []
        if (nativeStep.valid) {
            this.recordControlFlowMutation(nativeStep, instruction, mutations)
        }
        const location = this.runtime.getSourceLocationForAddress(pcBefore)

        const entry: X86HistoryEntry = {
            mutations,
            pc: toHistoryPc(pcBefore),
            old_ccr: { bits: flagsBefore },
            new_ccr: { bits: flagsAfter },
            line: location?.line ?? -1,
            file: location?.path,
            registersBefore,
            flagsBefore,
            callStackBefore,
            memoryWrites,
            reversible: !nativeStep.valid || !nativeStep.truncatedMemoryWrites,
        }

        this.history.push(entry)
    }

    private recordMemoryMutations(
        writes: NativeMemoryWrite[],
        mutations: ExecutionStep['mutations'],
    ): UndoMemoryWrite[] {
        const undoWrites: UndoMemoryWrite[] = []
        for (const write of writes) {
            if (write.truncated || write.old.length !== write.size) {
                mutations.push({
                    type: 'Other',
                    value: `Wrote ${write.size} bytes to 0x${write.address.toString(16)}`,
                })
                continue
            }
            undoWrites.push({ address: write.address, old: [...write.old] })
            mutations.push({
                type: 'WriteMemoryBytes',
                value: {
                    address: write.address,
                    old: [...write.old],
                },
            })
        }
        return undoWrites
    }

    private recordControlFlowMutation(
        step: Extract<NativeStepInfo, { valid: true }>,
        instruction: NativeInstruction | null,
        mutations: ExecutionStep['mutations'],
    ): void {
        if (step.controlFlow === 'call') {
            const returnAddress = instruction ? instruction.address + BigInt(instruction.size) : step.pcBefore
            const symbol = this.runtime.resolveSymbol(step.pcAfter)
            const frameAddress = symbol?.address ?? step.pcAfter
            const location = this.runtime.getSourceLocationForAddress(frameAddress)
            this.callStack.push({
                name: symbol?.name ?? '',
                address: frameAddress,
                destination: returnAddress,
                sp: step.spAfter,
                line: location?.line ?? -1,
                file: location?.path,
                color: makeFrameColor(this.callStack.length, frameAddress),
            })
            mutations.push({ type: 'PushCallStack', value: { from: step.pcBefore, to: step.pcAfter } })
            return
        }

        if (step.controlFlow === 'return') {
            if (this.callStack.pop()) {
                mutations.push({ type: 'PopCallStack', value: { from: step.pcBefore, to: step.pcAfter } })
            }
        }
    }

    private emit<T extends X86EmulatorEventName>(eventName: T, event: X86EmulatorEventMap[T]): void {
        for (const handler of this.eventHandlers[eventName]) observeCallbackResult(handler(event))
    }
}

export async function createX86Emulator(options: X86EmulatorOptions = {}): Promise<X86Emulator> {
    return X86Emulator.create(options)
}
