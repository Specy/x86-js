import {
    BaseEmulator,
    EmulatorStatus,
    RegisterSize,
    type EmulatorDecoration,
    type ExecutionStep,
    type Instruction,
    type MonacoError,
    type PokeWrite,
    type StackFrame,
} from './interface'
import { locateDiagnosticSpan, type AssemblerId, type AssemblerMode } from './assemblers'
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
    isRecordableWrite,
    makeFrameColor,
    maskForSize,
    maskRegisterValue,
    stripPrivateHistory,
    toHistoryPc,
    type OpenPokeTransaction,
    type UndoMemoryWrite,
    type X86HistoryEntry,
} from './x86-emulator-utils'
import { observeCallbackResult } from './callbacks'
import {
    X86_SSE_REGISTERS,
    X86_X87_REGISTERS,
    decodeFpuState,
    encodeFpuState,
    fpuStateBlocksEqual,
    readLogicalStBits,
    type X86FpuState,
} from './fpu-state'

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
    private openPoke: OpenPokeTransaction | null = null
    /** True while an instruction is running, so a Poke cannot open on top of one. */
    private executing = false

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
        this.assertNoOpenPoke('run')
        if (this.isTracingEnabled()) return this.run()
        const wasExecuting = this.executing
        this.executing = true
        try {
            await this.runtime.runUntilBlocked()
        } finally {
            this.executing = wasExecuting
        }
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

    /**
     * Diagnostics only: this assembles but does not link, and for an assembler
     * that runs as its own wasm module it does not touch blink at all, so a
     * loaded or paused program survives a check.
     */
    async checkProject(project: X86Project): Promise<MonacoError[]> {
        // Warnings included: a program that assembles is where they matter, and
        // dropping them here is what used to make them invisible.
        const result = await this.runtime.checkProject(project)
        return result.diagnostics.map((diagnostic) => {
            const path = diagnostic.file ?? project.entry
            const lineIndex = Math.max(0, diagnostic.line - 1)
            const lines = x86ProjectText(project, path).split(/\r?\n/)
            const line = lines[lineIndex] ?? ''
            const span = locateDiagnosticSpan(diagnostic.error, line, diagnostic.warningClass)
            return {
                file: path,
                lineIndex,
                column: span.column,
                ...(span.endColumn === undefined ? {} : { endColumn: span.endColumn }),
                line: {
                    line,
                    line_index: lineIndex,
                },
                message: diagnostic.error,
                formatted: diagnostic.error,
                severity: diagnostic.severity,
                ...(diagnostic.warningClass ? { code: diagnostic.warningClass } : {}),
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
        this.runtime.setFpuStateRaw(entry.fpuBefore)
        this.runtime.setFlags(entry.flagsBefore)
        this.callStack = cloneCallStack(entry.callStackBefore)
        this.runtime.resumeAfterStateMutation()
    }

    canUndo(): boolean {
        const entry = this.history.peekNewest()
        return Boolean(entry?.reversible)
    }

    /**
     * Opens a Poke: a register or memory value the HOST changes between two
     * instructions, recorded as one step of this history and undone like an
     * instruction.
     *
     * Everything `setRegisterValue`, `setFpuState` and `writeMemoryBytes`
     * change until `endPoke()` becomes one entry, however many calls it took.
     * Outside a transaction those setters stay exactly as direct as they were:
     * a Testcase presetting its starting values records nothing.
     *
     * Throws when a poke is already open, and when an instruction is running -
     * a step inside a transaction would hand the program's own writes to the
     * poke, and undoing it would then revert the instruction too.
     */
    beginPoke(): void {
        if (this.openPoke) {
            throw new Error('A poke is already open: end it before beginning another')
        }
        if (this.executing) {
            throw new Error('Cannot begin a poke while an instruction is executing')
        }

        const snapshot = this.runtime.getRegisterSnapshot()
        this.openPoke = {
            registersBefore: cloneRegisterValues(snapshot),
            flagsBefore: snapshot.flags,
            fpuBefore: this.runtime.getFpuStateRaw(),
            callStackBefore: cloneCallStack(this.callStack),
            memoryWrites: [],
        }
    }

    /**
     * Closes the open Poke and records it, returning whether anything was
     * recorded: a transaction that changed no value - because it wrote
     * nothing, or wrote the value that was already there - records nothing and
     * answers false, so the caller never shows an Undo step that reverts
     * nothing.
     *
     * Nothing here resumes the machine: the poke changed state, not why the
     * program stopped, and the next step resumes a paused machine itself.
     *
     * A poke takes one slot of the history, exactly as an instruction does, so
     * with `initialize(0)` it applies and answers true while the zero-capacity
     * history keeps it no more than it keeps an instruction.
     *
     * Throws when no poke is open.
     */
    endPoke(): boolean {
        const poke = this.openPoke
        if (!poke) throw new Error('No poke is open: begin one before ending it')
        this.openPoke = null

        const after = this.runtime.getRegisterSnapshot()
        const registersAfter = cloneRegisterValues(after)
        const mutations: ExecutionStep['mutations'] = []
        const writes: PokeWrite[] = []

        // `rip` is diffed here, unlike in an instruction's step, where the
        // program counter is the control flow rather than a mutation: a poke
        // moves it only because the host wrote it.
        for (const register of X86_REGISTER_NAMES) {
            const old = poke.registersBefore[register]
            const value = registersAfter[register]
            if (old === value) continue
            mutations.push({
                type: 'WriteRegister',
                value: { register, old, new: value, size: RegisterSize.Double },
            })
            writes.push({ type: 'register', name: register, old, new: value })
        }

        this.recordFpuMutations(poke.fpuBefore, this.runtime.getFpuStateRaw(), mutations, writes)
        const memoryWrites = this.recordPokeMemoryMutations(poke.memoryWrites, mutations, writes)

        if (writes.length === 0) return false

        const location = this.runtime.getSourceLocationForAddress(after.pc)
        const entry: X86HistoryEntry = {
            kind: 'poke',
            mutations,
            writes,
            pc: toHistoryPc(after.pc),
            old_ccr: { bits: poke.flagsBefore },
            new_ccr: { bits: after.flags },
            line: location?.line ?? -1,
            file: location?.path,
            registersBefore: poke.registersBefore,
            flagsBefore: poke.flagsBefore,
            fpuBefore: poke.fpuBefore,
            callStackBefore: cloneCallStack(this.callStack),
            memoryWrites,
            reversible: true,
        }

        this.history.push(entry)
        return true
    }

    /** True between `beginPoke()` and `endPoke()`. */
    isPokeOpen(): boolean {
        return this.openPoke !== null
    }

    async step(): Promise<{ terminated: boolean }> {
        this.assertNoOpenPoke('step')
        const wasExecuting = this.executing
        this.executing = true
        try {
            if (this.isTracingEnabled()) {
                this.captureStep()
            } else {
                this.prepareOneInstructionRun()
                this.runtime.step()
            }
        } finally {
            this.executing = wasExecuting
        }
        return { terminated: this.hasTerminated() }
    }

    getStatus(): EmulatorStatus {
        if (this.runtime.state === BlinkState.NotReady) return EmulatorStatus.NotReady
        if (this.runtime.state === BlinkState.ProgramReadlinePause) return EmulatorStatus.WaitingForInput
        if (this.runtime.state === BlinkState.ProgramStopped) return EmulatorStatus.Terminated
        return EmulatorStatus.Running
    }

    /**
     * Inside an open Poke the bytes this overwrites are journaled first, so
     * the transaction can put them back; outside one the write goes straight
     * into the machine and records nothing, as it always has.
     */
    writeMemoryBytes(address: bigint, data: Uint8Array): void {
        const poke = this.openPoke
        if (!poke || data.length === 0) {
            this.runtime.writeMemoryBytes(address, data)
            return
        }

        // Read before writing: a range the machine cannot read throws here,
        // leaving the memory and the transaction as they were.
        const old = [...this.runtime.readMemoryBytes(address, BigInt(data.length))]
        this.runtime.writeMemoryBytes(address, data)
        poke.memoryWrites.push({ address, old })
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

    /**
     * The SSE and x87 register files: `xmm0..xmm15` and `mxcsr`, and the x87
     * stack in logical order with its control, status and tag words. Read as
     * one block through a single bridge call. `X86_SSE_REGISTERS` and
     * `X86_X87_REGISTERS` name the values in order.
     */
    getFpuState(): X86FpuState {
        return decodeFpuState(this.runtime.getFpuStateRaw())
    }

    /**
     * Presets the SSE and x87 register files. The write goes straight into the
     * machine, like `setRegisterValue`, so it never becomes an undo entry; the
     * x87 op, instruction and data pointers are left as the machine had them.
     *
     * Like the other setters it does NOT resume the machine: presetting a
     * register on a terminated or paused program must not erase why it
     * stopped. The next step resumes a paused machine on its own.
     *
     * A preset made before the FIRST step does not survive it: the first step
     * starts the program, which builds the machine afresh, so the values are
     * wiped. This is exactly how `setRegisterValue` behaves; a caller that
     * wants to preset state must step once first.
     */
    setFpuState(state: X86FpuState): void {
        this.runtime.setFpuStateRaw(encodeFpuState(state, this.runtime.getFpuStateRaw()))
    }

    hasTerminated(): boolean {
        return this.runtime.state === BlinkState.ProgramStopped
    }

    async run(limit?: number, breakpoints: X86Breakpoint[] = []): Promise<EmulatorStatus> {
        this.assertNoOpenPoke('run')
        this.validateRunLimit(limit)
        const breakpointAddresses = this.resolveBreakpointAddresses(breakpoints)
        const wasExecuting = this.executing
        this.executing = true
        try {
            if (this.isTracingEnabled()) return await this.runWithHistory(limit, breakpointAddresses)
            if (breakpointAddresses.length) return await this.runWithBreakpoints(limit, breakpointAddresses)
            await this.runtime.runUntilBlocked({ limit, breakpointAddresses })
            return this.getStatus()
        } finally {
            this.executing = wasExecuting
        }
    }

    private assertNoOpenPoke(what: string): void {
        if (this.openPoke) throw new Error(`Cannot ${what} while a poke is open: end it first`)
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
        // A build or an initialize() throws the whole trace away; an open poke
        // has nothing left to be recorded against.
        this.openPoke = null
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
        const fpuBefore = this.runtime.getFpuStateRaw()
        const instruction = this.runtime.getInstructionAt(before.pc)
        const callStackBefore = cloneCallStack(this.callStack)

        this.runtime.step()

        const after = this.runtime.getRegisterSnapshot()
        const fpuAfter = this.runtime.getFpuStateRaw()
        const nativeStep = this.runtime.getLastStepInfo()
        this.recordStep(before, after, fpuBefore, fpuAfter, nativeStep, instruction, callStackBefore)
    }

    private recordStep(
        before: RegisterSnapshot,
        after: RegisterSnapshot,
        fpuBefore: Uint8Array,
        fpuAfter: Uint8Array,
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

        // Both sides come from the two snapshots the step already takes, so a
        // write reports what it left without any extra read of the machine.
        for (const register of X86_REGISTER_NAMES) {
            if (register === 'rip') continue
            if (registersBefore[register] !== registersAfter[register]) {
                mutations.push({
                    type: 'WriteRegister',
                    value: {
                        register,
                        old: registersBefore[register],
                        new: registersAfter[register],
                        size: RegisterSize.Double,
                    },
                })
            }
        }

        this.recordFpuMutations(fpuBefore, fpuAfter, mutations)

        const memoryWrites = nativeStep.valid ? this.recordMemoryMutations(nativeStep.memoryWrites, mutations) : []
        if (nativeStep.valid) {
            this.recordControlFlowMutation(nativeStep, instruction, mutations)
        }
        const location = this.runtime.getSourceLocationForAddress(pcBefore)

        const entry: X86HistoryEntry = {
            kind: 'instruction',
            mutations,
            pc: toHistoryPc(pcBefore),
            old_ccr: { bits: flagsBefore },
            new_ccr: { bits: flagsAfter },
            line: location?.line ?? -1,
            file: location?.path,
            registersBefore,
            flagsBefore,
            fpuBefore,
            callStackBefore,
            memoryWrites,
            reversible: !nativeStep.valid || !nativeStep.truncatedMemoryWrites,
        }

        this.history.push(entry)
    }

    /**
     * Notes the SSE and x87 registers the step wrote. Most instructions touch
     * none of them, and that case costs one byte comparison: only a block that
     * actually differs is decoded and diffed register by register.
     *
     * The block carries three fields `X86FpuState` does not name - the last
     * x87 opcode and the instruction and data pointers - so a step that moves
     * only those decodes both blocks and then names no register. Undo stays
     * exact either way, because it restores the whole block rather than
     * replaying the mutations.
     */
    private recordFpuMutations(
        fpuBefore: Uint8Array,
        fpuAfter: Uint8Array,
        mutations: ExecutionStep['mutations'],
        writes?: PokeWrite[],
    ): void {
        if (fpuStateBlocksEqual(fpuBefore, fpuAfter)) return

        const stateBefore = decodeFpuState(fpuBefore)
        const stateAfter = decodeFpuState(fpuAfter)

        for (let index = 0; index < stateBefore.xmm.length; index += 1) {
            if (stateBefore.xmm[index] === stateAfter.xmm[index]) continue
            mutations.push({
                type: 'WriteRegister',
                value: {
                    register: X86_SSE_REGISTERS[index]!,
                    old: stateBefore.xmm[index]!,
                    new: stateAfter.xmm[index]!,
                    size: RegisterSize.Quad,
                },
            })
            writes?.push({
                type: 'register',
                name: X86_SSE_REGISTERS[index]!,
                old: stateBefore.xmm[index]!,
                new: stateAfter.xmm[index]!,
            })
        }
        if (stateBefore.mxcsr !== stateAfter.mxcsr) {
            mutations.push({
                type: 'WriteRegister',
                value: {
                    register: 'mxcsr',
                    old: BigInt(stateBefore.mxcsr),
                    new: BigInt(stateAfter.mxcsr),
                    size: RegisterSize.Long,
                },
            })
            writes?.push({
                type: 'register',
                name: 'mxcsr',
                old: BigInt(stateBefore.mxcsr),
                new: BigInt(stateAfter.mxcsr),
            })
        }

        // Compared as bit patterns, in logical order: a push or a pop moves TOP,
        // so st(0) can change without any physical slot being written. The
        // consequence is that one push renames every live slot, and a single
        // `fld` onto a non-empty stack reports st0, st1, st2... - the names are
        // what the register panel shows, not the slot the instruction wrote.
        const stBitsBefore = readLogicalStBits(fpuBefore)
        const stBitsAfter = readLogicalStBits(fpuAfter)
        for (let index = 0; index < stBitsBefore.length; index += 1) {
            if (stBitsBefore[index] === stBitsAfter[index]) continue
            mutations.push({
                type: 'WriteRegister',
                value: {
                    register: X86_X87_REGISTERS[index]!,
                    old: stBitsBefore[index]!,
                    new: stBitsAfter[index]!,
                    size: RegisterSize.Double,
                },
            })
            writes?.push({
                type: 'register',
                name: X86_X87_REGISTERS[index]!,
                old: stBitsBefore[index]!,
                new: stBitsAfter[index]!,
            })
        }

        for (const word of ['fctrl', 'fstat', 'ftag'] as const) {
            if (stateBefore[word] === stateAfter[word]) continue
            mutations.push({
                type: 'WriteRegister',
                value: {
                    register: word,
                    old: BigInt(stateBefore[word]),
                    new: BigInt(stateAfter[word]),
                    size: RegisterSize.Word,
                },
            })
            writes?.push({
                type: 'register',
                name: word,
                old: BigInt(stateBefore[word]),
                new: BigInt(stateAfter[word]),
            })
        }
    }

    /**
     * The memory a Poke actually changed. The journal is collapsed per byte
     * first - the EARLIEST `old` of every address, from the first write that
     * touched it - and only then compared against what memory holds now, so a
     * range written twice inside one transaction is diffed against what the
     * machine held before the poke and not against the intermediate value the
     * first write left. A range written away and back therefore leaves no
     * trace at all, and two differing writes to one range leave one entry
     * carrying the value the machine really had. What survives keeps the old
     * bytes the way an instruction's writes do, for undo to put back in
     * reverse order.
     */
    private recordPokeMemoryMutations(
        journaled: UndoMemoryWrite[],
        mutations: ExecutionStep['mutations'],
        writes: PokeWrite[],
    ): UndoMemoryWrite[] {
        const earliest = new Map<bigint, number>()
        for (const write of journaled) {
            write.old.forEach((byte, index) => {
                const address = write.address + BigInt(index)
                if (!earliest.has(address)) earliest.set(address, byte)
            })
        }

        // Maximal contiguous runs, lowest address first: writes to the same,
        // an overlapping or an adjoining range become one entry, so neither
        // the History row nor undo ever sees a value that existed only inside
        // the transaction.
        const addresses = [...earliest.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        const ranges: UndoMemoryWrite[] = []
        for (const address of addresses) {
            const open = ranges[ranges.length - 1]
            const byte = earliest.get(address) as number
            if (open && open.address + BigInt(open.old.length) === address) {
                open.old.push(byte)
                continue
            }
            ranges.push({ address, old: [byte] })
        }

        const undoWrites: UndoMemoryWrite[] = []
        for (const range of ranges) {
            const current = [...this.runtime.readMemoryBytes(range.address, BigInt(range.old.length))]
            if (current.every((byte, index) => byte === range.old[index])) continue
            undoWrites.push(range)
            mutations.push({
                type: 'WriteMemoryBytes',
                value: { address: range.address, old: [...range.old], new: [...current] },
            })
            writes.push({
                type: 'memory',
                address: range.address,
                old: [...range.old],
                new: current,
            })
        }
        return undoWrites
    }

    /**
     * The memory a step wrote. The native journal hands over the bytes each
     * store REPLACED, captured in the machine at that store; it records
     * nothing about what a store PUT there. So `old` is the machine's own
     * capture, taken at the write, while `new` is read out of the machine as
     * the entry is recorded - the step has finished and nothing has run since,
     * so those addresses still hold what the step left.
     *
     * The read costs one page lookup per store: one for the single store
     * almost every store-bearing instruction journals, and none at all for the
     * majority of instructions, which write no memory. It goes through the
     * machine's own page lookup rather than the byte-by-byte bridge (see
     * `BlinkRuntime.spyMemoryBytes`), which keeps it far below the cost of
     * tracing the step around it.
     *
     * What reading rather than journaling costs: were one step to store twice
     * over the same address, both entries would report the bytes the step
     * ENDED with rather than the bytes each store left. No x86 instruction
     * reachable here does that - blink coalesces a `rep` into one record, and
     * push, call, ret, enter, leave, `xchg` with memory and read-modify-write
     * arithmetic each journal a single store - so nothing observable turns on
     * it today. Only a post-image in the native journal would close it, and
     * that needs the wasm rebuilt, which this package does not do.
     *
     * A range the machine refuses to read back - a step can unmap what it
     * wrote - leaves that entry with no new bytes rather than a guess, and the
     * read never throws out of recording. Truncated writes keep their existing
     * `Other` shape and stay out of the undo journal.
     */
    private recordMemoryMutations(
        writes: NativeMemoryWrite[],
        mutations: ExecutionStep['mutations'],
    ): UndoMemoryWrite[] {
        const undoWrites: UndoMemoryWrite[] = []
        const written = this.writtenBytes(writes)
        for (const [index, write] of writes.entries()) {
            if (!isRecordableWrite(write)) {
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
                    new: written[index] ?? [],
                },
            })
        }
        return undoWrites
    }

    /**
     * The bytes each of a step's stores left, by the index of that store: what
     * the addresses that store wrote hold now, at the width of the write. One
     * lookup per store it can account for, and none for a store it cannot.
     */
    private writtenBytes(writes: NativeMemoryWrite[]): number[][] {
        return writes.map((write) =>
            isRecordableWrite(write) ? this.readBytes(write.address, write.size) : [],
        )
    }

    /**
     * One read of the machine that answers with nothing rather than throwing,
     * so recording a step can never fail after the instruction already ran.
     * It takes the machine's own page lookup when that can answer for the
     * whole range and the byte-by-byte bridge otherwise; the two read the same
     * memory the same way.
     */
    private readBytes(address: bigint, length: number): number[] {
        const spied = this.runtime.spyMemoryBytes(address, length)
        if (spied) return Array.from(spied)
        try {
            return [...this.runtime.readMemoryBytes(address, BigInt(length))]
        } catch {
            return []
        }
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
