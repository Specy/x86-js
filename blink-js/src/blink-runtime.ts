import blinkenlib from './wasm/blinkenlib.js'
import initBlinkWasm from './wasm/blinkenlib.wasm?init'
import { assemblers, DEFAULT_ASSEMBLER_ID, type AssemblerId, type AssemblerMode } from './assemblers'
import { readResourceBytes } from './resources'
import { parseSourceMap, type SourceMap } from './source-map'
import { BlinkState, type StopReason, type X86CompileResult } from './types'
import type { BlinkenlibModule, DisassemblySnapshot, NativeInstruction, RegisterSnapshot } from './wasm-types'

const SIGNALS = {
    SIGTRAP: 5,
    SIGXCPU: 24,
} as const

const SIGTRAP_CODES = {
    BLINK_PREEMPT: 40,
    BLINK_STEP: 41,
    BLINK_FAKE_TTY: 42,
    BLINK_BREAKPOINT: 43,
    BLINK_RUN_LIMIT: 44,
} as const

const SIGNAL_INFO: Record<number, { name: string; description: string }> = {
    1: { name: 'SIGHUP', description: 'Hang up controlling terminal or process.' },
    2: { name: 'SIGINT', description: 'Interrupt from keyboard, Control-C.' },
    3: { name: 'SIGQUIT', description: 'Quit from keyboard, Control-\\.' },
    4: { name: 'SIGILL', description: 'Illegal instruction.' },
    5: { name: 'SIGTRAP', description: 'Breakpoint for debugging.' },
    6: { name: 'SIGABRT', description: 'Abnormal termination.' },
    7: { name: 'SIGBUS', description: 'Bus error.' },
    8: { name: 'SIGFPE', description: 'Floating-point exception.' },
    9: { name: 'SIGKILL', description: 'Forced-process termination.' },
    10: { name: 'SIGUSR1', description: 'Available to processes.' },
    11: { name: 'SIGSEGV', description: 'Invalid memory reference.' },
    12: { name: 'SIGUSR2', description: 'Available to processes.' },
    13: { name: 'SIGPIPE', description: 'Write to pipe with no readers.' },
    14: { name: 'SIGALRM', description: 'Real-timer clock.' },
    15: { name: 'SIGTERM', description: 'Process termination.' },
    24: { name: 'SIGXCPU', description: 'CPU time limit exceeded, execution took too long.' },
}

export type BlinkRuntimeCallbacks = {
    stdin?: () => number | null
    stdout?: (charCode: number) => void
    stderr?: (charCode: number) => void
    signal?: (signal: number, code: number) => void
    stateChange?: (state: BlinkState, oldState: BlinkState) => void
    inputRequest?: (event: { maxBytes: bigint }) => void
}

export type BlinkRuntimeOptions = {
    mode?: AssemblerMode | AssemblerId
    callbacks?: BlinkRuntimeCallbacks
    scheduler?: (callback: () => void) => void
}

export type BlinkRunOptions = {
    limit?: number
    breakpointAddresses?: bigint[]
}

type StateWaiter = {
    predicate: (state: BlinkState) => boolean
    resolve: (state: BlinkState) => void
}

export class BlinkRuntime {
    readonly module: BlinkenlibModule

    mode: AssemblerMode
    state = BlinkState.NotReady
    stopReason: StopReason | null = null
    assemblerLogs = ''
    assemblerErrors: Array<{ line: number; error: string }> = []

    private readonly callbacks: Required<BlinkRuntimeCallbacks>
    private readonly scheduler: (callback: () => void) => void
    private readonly stateWaiters: StateWaiter[] = []
    private readonly stdinBytes: number[] = []
    private sourceMap: SourceMap | null = null

    private readonly defaultArgc = '/program'
    private readonly defaultArgv = ''

    private constructor(
        module: BlinkenlibModule,
        mode: AssemblerMode,
        callbacks: Required<BlinkRuntimeCallbacks>,
        scheduler: (callback: () => void) => void,
    ) {
        this.module = module
        this.mode = mode
        this.callbacks = callbacks
        this.scheduler = scheduler
    }

    static async create(options: BlinkRuntimeOptions = {}): Promise<BlinkRuntime> {
        const mode = resolveAssemblerMode(options.mode)
        const callbacks = withDefaultCallbacks(options.callbacks)
        const scheduler = options.scheduler ?? defaultScheduler

        let runtime: BlinkRuntime | null = null
        let resolveWasmInit: ((wasmInit: Promise<WebAssembly.Instance>) => void) | null = null
        const wasmInitStarted = new Promise<Promise<WebAssembly.Instance>>((resolve) => {
            resolveWasmInit = resolve
        })
        const modulePromise = blinkenlib({
            noInitialRun: true,
            instantiateWasm: (imports, receiveInstance) => {
                const wasmInit = initBlinkWasm(imports)
                resolveWasmInit?.(wasmInit)
                void wasmInit.then((instance) => receiveInstance(instance), () => undefined)
            },
            preRun: (moduleInstance) => {
                moduleInstance.FS.init(
                    () => (runtime?.stdinBytes.length ? runtime.stdinBytes.pop() ?? null : callbacks.stdin()),
                    (charCode) => {
                        runtime?.collectAssemblerLog(charCode)
                        callbacks.stdout(charCode)
                    },
                    (charCode) => {
                        runtime?.collectAssemblerLog(charCode)
                        callbacks.stderr(charCode)
                    },
                )
            },
        })
        const module = await awaitBlinkenlibModule(modulePromise, wasmInitStarted)

        const signalPointer = module.addFunction(
            (signal: number, code: number) => runtime?.handleSignal(signal, code),
            'vii',
        )
        const exitPointer = module.addFunction((code: number) => runtime?.handleExit(code), 'vi')

        module.callMain([signalPointer.toString(), exitPointer.toString()])

        runtime = new BlinkRuntime(module, mode, callbacks, scheduler)
        await runtime.setMode(mode)
        return runtime
    }

    async setMode(mode: AssemblerMode | AssemblerId): Promise<void> {
        this.mode = resolveAssemblerMode(mode)
        this.assemblerLogs = ''
        this.assemblerErrors = []
        this.setState(BlinkState.NotReady)
        await this.writeExecutable('/assembler', await readResourceBytes(this.mode.binaries.assembler.file))
        if (this.mode.binaries.linker) {
            await this.writeExecutable('/linker', await readResourceBytes(this.mode.binaries.linker.file))
        }
        this.setState(BlinkState.Ready)
    }

    async compileAssembly(code: string): Promise<X86CompileResult> {
        this.assertReadyForCompile()
        this.stopReason = null
        this.assemblerLogs = ''
        this.assemblerErrors = []
        this.sourceMap = null
        this.module.FS.writeFile('/assembly.s', code)
        this.setState(BlinkState.Assembling)
        await defer()
        this.setEmulationArgs('/assembler', this.mode.binaries.assembler.commands, '')
        this.module._blinkenlib_run_fast()
        await this.waitForState((state) => state !== BlinkState.Assembling && state !== BlinkState.Linking)

        if (this.state === BlinkState.ProgramLoaded) {
            this.sourceMap = this.tryReadSourceMap()
            return { ok: true, report: this.assemblerLogs }
        }
        return { ok: false, errors: this.assemblerErrors, report: this.assemblerLogs }
    }

    loadElf(data: ArrayBuffer | Uint8Array): void {
        if (this.state === BlinkState.NotReady) throw new Error('Blink runtime is not ready')
        this.writeExecutableSync('/program', data instanceof Uint8Array ? data : new Uint8Array(data))
        this.stopReason = null
        this.sourceMap = null
        this.setState(BlinkState.ProgramLoaded)
    }

    starti(): void {
        this.startProgram('_blinkenlib_starti')
    }

    run(): void {
        this.startProgram('_blinkenlib_run')
    }

    step(): void {
        if (this.state === BlinkState.ProgramLoaded) this.starti()
        if (this.state !== BlinkState.ProgramRunning) {
            throw new Error(`Cannot step while emulator is ${this.state}`)
        }
        this.module._blinkenlib_stepi()
    }

    continue(): void {
        if (this.state === BlinkState.ProgramPaused) this.setState(BlinkState.ProgramRunning)
        if (this.state !== BlinkState.ProgramRunning) {
            throw new Error(`Cannot continue while emulator is ${this.state}`)
        }
        this.module._blinkenlib_continue()
    }

    async runUntilBlocked(options: BlinkRunOptions = {}): Promise<BlinkState> {
        this.configureRunControls(options)
        if (this.state === BlinkState.ProgramLoaded || this.state === BlinkState.ProgramStopped) this.run()
        if (this.state === BlinkState.ProgramPaused) this.continue()
        if (this.state === BlinkState.ProgramRunning) {
            return this.waitForState(
                (state) =>
                    state === BlinkState.ProgramStopped ||
                    state === BlinkState.ProgramReadlinePause ||
                    state === BlinkState.ProgramPaused,
            )
        }
        return this.state
    }

    provideInput(line: string): void {
        const bytes = Array.from(new TextEncoder().encode(line)).reverse()
        this.stdinBytes.length = 0
        this.stdinBytes.push(...bytes)
        this.setState(BlinkState.ProgramRunning)
        this.module._blinkenlib_faketty_resume()
    }

    readMemoryBytes(address: bigint, length: bigint): Uint8Array {
        const size = Number(length)
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid memory read length: ${length}`)
        const result = this.module.blinkenlibReadMemoryBytes(address, size)
        if (!result.ok) throw new Error(`${result.error}: 0x${address.toString(16)}`)
        return Uint8Array.from(result.bytes)
    }

    writeMemoryBytes(address: bigint, data: Uint8Array): void {
        const result = this.module.blinkenlibWriteMemoryBytes(address, data)
        if (!result.ok) throw new Error(`${result.error}: 0x${address.toString(16)}`)
    }

    getDisassemblyLines(): string[] {
        return this.getDisassemblySnapshot().lines
    }

    getDisassemblyCurrentLine(): number {
        return this.getDisassemblySnapshot().currentLine
    }

    getRegisterSnapshot(): RegisterSnapshot {
        return this.module.blinkenlibGetRegisterSnapshot()
    }

    getRegister(register: keyof RegisterSnapshot['registers']): bigint {
        return this.module.blinkenlibGetRegister(register)
    }

    setRegister(register: keyof RegisterSnapshot['registers'], value: bigint): void {
        if (!this.module.blinkenlibSetRegister(register, value)) {
            throw new Error(`Unknown x86 register: ${register}`)
        }
    }

    getPc(): bigint {
        return this.getRegisterSnapshot().pc
    }

    getSp(): bigint {
        return this.getRegister('rsp')
    }

    getFlags(): bigint {
        return BigInt(this.getRegisterSnapshot().flags)
    }

    getInputMaxBytes(): bigint {
        return this.module.blinkenlibGetInputMaxBytes()
    }

    getInstructionAt(address: bigint): NativeInstruction | null {
        return this.module.blinkenlibGetInstructionAt(address)
    }

    getSourceLineForAddress(address: bigint): number | null {
        return this.sourceMap?.getLineIndex(address) ?? null
    }

    getAddressesForSourceLine(lineIndex: number): bigint[] {
        return this.sourceMap?.getAddressesForLine(lineIndex) ?? []
    }

    pauseForBreakpoint(address: bigint, lineNumber: number | undefined): void {
        this.stopReason = {
            loadFail: false,
            exitCode: 0,
            kind: 'breakpoint',
            details: `execution paused at breakpoint 0x${address.toString(16)}`,
            address,
            lineNumber,
        }
        this.setState(BlinkState.ProgramPaused)
    }

    pauseForLimit(address: bigint, executedInstructions: bigint): void {
        this.stopReason = {
            loadFail: false,
            exitCode: 0,
            kind: 'limit',
            details: `execution paused after ${executedInstructions.toString()} instructions`,
            address,
            lineNumber: this.getSourceLineForAddress(address) ?? undefined,
            executedInstructions,
        }
        this.setState(BlinkState.ProgramPaused)
    }

    private startProgram(method: '_blinkenlib_run' | '_blinkenlib_start' | '_blinkenlib_starti'): void {
        try {
            this.stopReason = null
            this.setState(BlinkState.ProgramRunning)
            this.setEmulationArgs('/program', this.defaultArgc, this.defaultArgv)
            this.module[method]()
        } catch {
            this.stopReason = { loadFail: true, exitCode: 0, details: 'invalid ELF', kind: 'load-fail' }
            this.setState(BlinkState.ProgramStopped)
        }
    }

    private async writeExecutable(path: string, data: Uint8Array): Promise<void> {
        this.writeExecutableSync(path, data)
    }

    private writeExecutableSync(path: string, data: Uint8Array): void {
        const stream = this.module.FS.open(path, 'w+')
        this.module.FS.write(stream, data, 0, data.length, 0)
        this.module.FS.close(stream)
        this.module.FS.chmod(path, 0o777)
    }

    private setEmulationArgs(progname: string, argc: string, argv: string): void {
        this.module.blinkenlibSetEmulationArgs(progname, argc, argv)
    }

    private configureRunControls(options: BlinkRunOptions): void {
        const limit = options.limit ?? 0
        this.module.blinkenlibSetRunControls(
            BigInt(limit),
            (options.breakpointAddresses ?? []).map((address) => address.toString()),
        )
    }

    private collectAssemblerLog(charCode: number): void {
        if (this.state === BlinkState.Assembling || this.state === BlinkState.Linking) {
            this.assemblerLogs += String.fromCharCode(charCode)
        }
    }

    private handleSignal(signal: number, code: number): void {
        if (signal !== SIGNALS.SIGTRAP) {
            const exitCode = 128 + signal
            const signalInfo = SIGNAL_INFO[signal]
            this.stopReason = {
                loadFail: false,
                exitCode,
                kind: 'signal',
                details: signalInfo
                    ? `Program terminated with Exit(${exitCode}) due to signal ${signalInfo.name}: ${signalInfo.description}`
                    : `Program terminated with Exit(${exitCode}) due to signal ${signal}`,
            }
            this.setState(BlinkState.ProgramStopped)
            this.callbacks.signal(signal, code)
            return
        }

        if (code === SIGTRAP_CODES.BLINK_PREEMPT) {
            this.scheduler(() => this.module._blinkenlib_preempt_resume())
            return
        }

        if (code === SIGTRAP_CODES.BLINK_FAKE_TTY) {
            this.stopReason = {
                loadFail: false,
                exitCode: 0,
                kind: 'input',
                details: 'program is waiting for input',
            }
            this.setState(BlinkState.ProgramReadlinePause)
            this.callbacks.inputRequest({ maxBytes: this.getInputMaxBytes() })
        }

        if (code === SIGTRAP_CODES.BLINK_BREAKPOINT || code === SIGTRAP_CODES.BLINK_RUN_LIMIT) {
            const stop = this.module.blinkenlibGetRunStop()
            const lineNumber = this.getSourceLineForAddress(stop.address) ?? undefined
            this.stopReason = {
                loadFail: false,
                exitCode: 0,
                kind: stop.kind === 'limit' ? 'limit' : 'breakpoint',
                details:
                    stop.kind === 'limit'
                        ? `execution paused after ${stop.executedInstructions.toString()} instructions`
                        : `execution paused at breakpoint 0x${stop.address.toString(16)}`,
                address: stop.address,
                lineNumber,
                executedInstructions: stop.executedInstructions,
            }
            this.setState(BlinkState.ProgramPaused)
        }

        this.callbacks.signal(signal, code)
    }

    private handleExit(code: number): void {
        if (this.state === BlinkState.Assembling) {
            this.handleAssemblerExit(code)
            return
        }
        if (this.state === BlinkState.Linking) {
            this.handleLinkerExit(code)
            return
        }

        this.stopReason = {
            loadFail: false,
            exitCode: code,
            kind: 'exit',
            details: `program terminated with Exit(${code})`,
        }
        this.setState(BlinkState.ProgramStopped)
    }

    private handleAssemblerExit(code: number): void {
        if (code !== 0) {
            this.assemblerErrors = this.mode.diagnosticsParser?.(this.assemblerLogs) ?? []
            this.setState(BlinkState.Ready)
            return
        }

        if (!this.mode.binaries.linker) {
            this.module.FS.chmod('/program', 0o777)
            this.setState(BlinkState.ProgramLoaded)
            return
        }

        this.setState(BlinkState.Linking)
        this.scheduler(() => {
            this.setEmulationArgs('/linker', this.mode.binaries.linker?.commands ?? '', '')
            this.module._blinkenlib_run_fast()
        })
    }

    private handleLinkerExit(code: number): void {
        if (code !== 0) {
            this.setState(BlinkState.Ready)
            return
        }
        this.module.FS.chmod('/program', 0o777)
        this.setState(BlinkState.ProgramLoaded)
    }

    private setState(state: BlinkState): void {
        if (this.state === state) return
        const oldState = this.state
        this.state = state
        this.callbacks.stateChange(state, oldState)
        this.resolveStateWaiters(state)
    }

    private waitForState(predicate: (state: BlinkState) => boolean): Promise<BlinkState> {
        if (predicate(this.state)) return Promise.resolve(this.state)
        return new Promise((resolve) => {
            this.stateWaiters.push({ predicate, resolve })
        })
    }

    private resolveStateWaiters(state: BlinkState): void {
        for (let index = this.stateWaiters.length - 1; index >= 0; index -= 1) {
            const waiter = this.stateWaiters[index]
            if (waiter?.predicate(state)) {
                this.stateWaiters.splice(index, 1)
                waiter.resolve(state)
            }
        }
    }

    private assertReadyForCompile(): void {
        if (
            this.state === BlinkState.NotReady ||
            this.state === BlinkState.Assembling ||
            this.state === BlinkState.Linking
        ) {
            throw new Error(`Cannot compile while emulator is ${this.state}`)
        }
    }

    private getDisassemblySnapshot(): DisassemblySnapshot {
        return this.module.blinkenlibGetDisassembly()
    }

    private tryReadSourceMap(): SourceMap | null {
        try {
            const file = this.module.FS.readFile('/program', { encoding: 'binary' })
            const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file
            return parseSourceMap(bytes)
        } catch {
            return null
        }
    }
}

function resolveAssemblerMode(mode: AssemblerMode | AssemblerId | undefined): AssemblerMode {
    if (!mode) return assemblers[DEFAULT_ASSEMBLER_ID]
    if (typeof mode === 'string') return assemblers[mode]
    return mode
}

function withDefaultCallbacks(callbacks: BlinkRuntimeCallbacks = {}): Required<BlinkRuntimeCallbacks> {
    return {
        stdin: callbacks.stdin ?? (() => null),
        stdout: callbacks.stdout ?? (() => undefined),
        stderr: callbacks.stderr ?? (() => undefined),
        signal: callbacks.signal ?? (() => undefined),
        stateChange: callbacks.stateChange ?? (() => undefined),
        inputRequest: callbacks.inputRequest ?? (() => undefined),
    }
}

async function awaitBlinkenlibModule(
    modulePromise: Promise<BlinkenlibModule>,
    wasmInitStarted: Promise<Promise<WebAssembly.Instance>>,
): Promise<BlinkenlibModule> {
    const wasmInit = await Promise.race([modulePromise.then(() => null), wasmInitStarted])
    if (!wasmInit) return modulePromise
    await wasmInit
    return modulePromise
}

function defaultScheduler(callback: () => void): void {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(callback)
        return
    }
    setTimeout(callback, 0)
}

function defer(): Promise<void> {
    return new Promise((resolve) => defaultScheduler(resolve))
}