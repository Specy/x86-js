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
import type { BlinkenlibModule } from './wasm-types'
import { X86_FLAGS, deferToHost, maskForSize, maskRegisterValue } from './x86-emulator-utils'
import { observeCallbackResult } from './callbacks'
import { NativeHistory } from './native-history'
import {
    X86_SSE_REGISTERS,
    X86_X87_REGISTERS,
    decodeFpuState,
    encodeFpuState,
    fpuStateBlocksEqual,
    readLogicalStBits,
    type X86FpuState,
} from './fpu-state'

/** What {@link X86Emulator.run} does with the breakpoint the program counter is on. */
export type X86RunOptions = {
    /**
     * `true` (the default) runs the instruction the program counter is on even
     * when a breakpoint names it, which is what continuing from a breakpoint
     * needs; `false` stops before it, having run nothing.
     */
    skipBreakpointAtPc?: boolean
}

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
    /** What `initialize()` was given: how many steps the history keeps, 0 recording none. */
    private undoSize = 0
    /** The undo history and call stack, both recorded inside the wasm. */
    private readonly history: NativeHistory
    private pokeOpen = false
    /** True while an instruction is running, so a Poke cannot open on top of one. */
    private executing = false
    /**
     * Input resumed the program and nothing has driven it since. A run left to
     * the runtime's own loop goes on inside `provideInput()`, and may end there
     * or still be going on, preempted, when the next call comes.
     */
    private resumedByInput = false

    private constructor(runtime: BlinkRuntime) {
        super({
            systemSize: RegisterSize.Double,
            registerNames: [...X86_REGISTER_NAMES],
            endianness: 'little',
        })
        this.runtime = runtime
        this.history = new NativeHistory(runtime, this.recordFpuMutations.bind(this))
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
        NativeHistory.assertSupported(runtime.module)
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
            if (!(await this.endedAfterInput())) await this.runtime.runUntilBlocked()
        } finally {
            this.executing = wasExecuting
        }
        return this.getStatus()
    }

    provideInput(line: string): void {
        this.runtime.provideInput(line)
        this.resumedByInput = true
    }

    initialize(undoSize: number): void {
        this.undoSize = Number.isFinite(undoSize) ? Math.max(0, Math.floor(undoSize)) : 0
        this.clearExecutionTrace()
        this.history.initialize(this.undoSize)
        this.runtime.setStepRecording(this.isTracingEnabled())
    }

    getCompiledCode(): { decorations: EmulatorDecoration[]; code: string } {
        return { decorations: [], code: this.lastSourceCode }
    }

    dispose(): void {
        this.runtime.setStepRecording(false)
        this.clearExecutionTrace()
        this.history.initialize(0)
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
        if (this.history.undo()) this.runtime.resumeAfterStateMutation()
    }

    canUndo(): boolean {
        return this.history.canUndo()
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
        if (this.isPokeOpen()) {
            throw new Error('A poke is already open: end it before beginning another')
        }
        if (this.executing) {
            throw new Error('Cannot begin a poke while an instruction is executing')
        }

        this.history.beginPoke()
        this.pokeOpen = true
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
        if (!this.pokeOpen) throw new Error('No poke is open: begin one before ending it')
        this.pokeOpen = false
        return this.history.endPoke()
    }

    /** True between `beginPoke()` and `endPoke()`. */
    isPokeOpen(): boolean {
        return this.pokeOpen
    }

    async step(): Promise<{ terminated: boolean }> {
        this.assertNoOpenPoke('step')
        const wasExecuting = this.executing
        this.executing = true
        try {
            if (await this.endedAfterInput()) return { terminated: true }
            this.prepareOneInstructionRun()
            this.runtime.step()
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
        // Read before writing: a range the machine cannot read throws here,
        // leaving the memory and the transaction as they were.
        if (this.pokeOpen && data.length) this.runtime.readMemoryBytes(address, BigInt(data.length))
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
        return this.history.newestFirst(count)
    }

    getPc(): bigint {
        return this.runtime.getPc()
    }

    getSp(): bigint {
        return this.runtime.getSp()
    }

    getFlags(): { name: string; value: number; prev?: number }[] {
        const flags = this.runtime.getFlags()
        const previous = this.history.previousFlags()
        const previousFlags = previous === undefined ? flags : BigInt(previous)
        return X86_FLAGS.map((flag) => ({
            name: flag.name,
            value: (flags & BigInt(flag.mask)) > 0n ? 1 : 0,
            prev: (previousFlags & BigInt(flag.mask)) > 0n ? 1 : 0,
        }))
    }

    getCallStack(): StackFrame[] {
        return this.history.callStack()
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

    /**
     * Runs until the program stops for input, hits one of `breakpoints`, runs
     * `limit` instructions or ends.
     *
     * `options.skipBreakpointAtPc` says what a breakpoint on the instruction
     * the program counter is *already* on does, and only that one. It defaults
     * to `true`, which runs it anyway: without that, a run resumed from a
     * breakpoint stops on the same breakpoint again having executed nothing,
     * and the program never moves. A caller that resumes mid-program some
     * other way - after feeding the program its input, or after its own budget
     * ran out - passes `false`, because the instruction it is about to run has
     * not run yet.
     */
    async run(
        limit?: number,
        breakpoints: X86Breakpoint[] = [],
        options: X86RunOptions = {},
    ): Promise<EmulatorStatus> {
        this.assertNoOpenPoke('run')
        this.validateRunLimit(limit)
        const breakpointAddresses = this.resolveBreakpointAddresses(breakpoints)
        const wasExecuting = this.executing
        this.executing = true
        try {
            if (await this.endedAfterInput()) return this.getStatus()
            return await this.runNativeSlices(limit, breakpointAddresses, options)
        } finally {
            this.executing = wasExecuting
        }
    }

    private assertNoOpenPoke(what: string): void {
        if (this.isPokeOpen()) throw new Error(`Cannot ${what} while a poke is open: end it first`)
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

    private isTracingEnabled(): boolean {
        return this.undoSize > 0
    }

    private clearExecutionTrace(): void {
        this.history.clear()
        // A build or an initialize() throws the whole trace away; an open poke
        // has nothing left to be recorded against, and the program input
        // resumed is no longer the one there.
        this.pokeOpen = false
        this.resumedByInput = false
    }

    /**
     * Whether the program ended after input resumed it and before this call:
     * an end the caller reports, not a reason to start the program over. A
     * loop the input resumed that is still going on, preempted, is waited for
     * first, so two loops never drive the machine at once.
     */
    private async endedAfterInput(): Promise<boolean> {
        if (!this.resumedByInput) return false
        this.resumedByInput = false
        await this.runtime.settle()
        return this.hasTerminated()
    }

    private async runNativeSlices(
        limit: number | undefined,
        breakpoints: bigint[],
        options: X86RunOptions,
    ): Promise<EmulatorStatus> {
        this.prepareOneInstructionRun()
        const hasLimit = limit !== undefined && limit > 0
        let executed = 0
        let skipAtPc = options.skipBreakpointAtPc ?? true
        while (this.runtime.state === BlinkState.ProgramRunning) {
            const budget = hasLimit ? Math.min(50000, limit - executed) : 50000
            executed += this.runtime.runSlice(budget, breakpoints, skipAtPc)
            skipAtPc = false
            if ((this.runtime.state as BlinkState) !== BlinkState.ProgramPaused || this.stopReason?.kind !== 'limit') break
            if (hasLimit && executed >= limit) {
                this.runtime.pauseForLimit(this.getPc(), BigInt(executed))
                break
            }
            await deferToHost()
            this.runtime.resumeAfterStateMutation()
        }
        return this.getStatus()
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

    private emit<T extends X86EmulatorEventName>(eventName: T, event: X86EmulatorEventMap[T]): void {
        for (const handler of this.eventHandlers[eventName]) observeCallbackResult(handler(event))
    }
}

export async function createX86Emulator(options: X86EmulatorOptions = {}): Promise<X86Emulator> {
    return X86Emulator.create(options)
}
