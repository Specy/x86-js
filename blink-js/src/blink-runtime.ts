import blinkenlib from './wasm/blinkenlib.js'
import initBlinkWasm from './wasm/blinkenlib.wasm?init'
import {
    assemblers,
    DEFAULT_ASSEMBLER_ID,
    ldDiagnostics,
    type AssemblerId,
    type AssemblerMode,
} from './assemblers'
import { readResourceBytes } from './resources'
import { parseSourceMap, type SourceMap } from './source-map'
import { stageX86Project, x86ProjectSourcePath } from './project'
import { DEFAULT_ENTRY_SYMBOL, findNearestSymbol, readDefinedGlobalSymbols } from './elf-symbols'
import {
    BlinkState,
    type StopReason,
    type X86CompilationDiagnostic,
    type X86CompileResult,
    type X86Project,
    type X86SourceLocation,
} from './types'
import { observeCallbackResult, type MaybePromise } from './callbacks'
import type {
    BlinkenlibModule,
    DisassemblySnapshot,
    NativeInstruction,
    NativeStepInfo,
    NativeSymbol,
    RegisterSnapshot,
} from './wasm-types'

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
    stdout?: (charCode: number) => MaybePromise<void>
    stderr?: (charCode: number) => MaybePromise<void>
    signal?: (signal: number, code: number) => MaybePromise<void>
    stateChange?: (state: BlinkState, oldState: BlinkState) => MaybePromise<void>
    inputRequest?: (event: { maxBytes: bigint }) => MaybePromise<void>
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
    /** The subset of `assemblerDiagnostics` that stopped the build. */
    assemblerErrors: X86CompilationDiagnostic[] = []
    /** Everything the assembler said, warnings included. */
    assemblerDiagnostics: X86CompilationDiagnostic[] = []

    private readonly callbacks: Required<BlinkRuntimeCallbacks>
    private readonly scheduler: (callback: () => void) => void
    private readonly stateWaiters: StateWaiter[] = []
    private readonly stdinBytes: number[] = []
    private sourceMap: SourceMap | null = null
    private sourceProject: X86Project | null = null
    private assembleOnly = false
    private assembledObjects: Uint8Array[] = []
    /** What the linker said, kept apart from the assembler's log so `ld`'s own parser reads it. */
    private linkerLogs: string | null = null

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
                        observeCallbackResult(callbacks.stdout(charCode))
                    },
                    (charCode) => {
                        runtime?.collectAssemblerLog(charCode)
                        observeCallbackResult(callbacks.stderr(charCode))
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
        if (this.mode.binaries.assembler) {
            await this.writeExecutable('/assembler', await readResourceBytes(this.mode.binaries.assembler.file))
        }
        if (this.mode.binaries.linker) {
            await this.writeExecutable('/linker', await readResourceBytes(this.mode.binaries.linker.file))
        }
        this.setState(BlinkState.Ready)
    }

    async compileAssembly(code: string): Promise<X86CompileResult> {
        return this.compileProject({ entry: 'assembly.s', files: { 'assembly.s': code } })
    }

    async compileProject(project: X86Project): Promise<X86CompileResult> {
        return this.buildProject(project, { link: true })
    }

    /**
     * Assembles without linking, for diagnostics. The linked executable is only
     * needed to run or debug a program; a caller that just wants to know what is
     * wrong with the source pays ~450ms for a link it never looks at.
     *
     * A mode with a `wasmAssembler` never touches blink here, so checking also
     * leaves a loaded program - and anything paused in the debugger - alone.
     */
    async checkProject(project: X86Project): Promise<X86CompileResult> {
        if (this.mode.wasmAssembler) return this.checkProjectWithWasmAssembler(project)
        return this.buildProject(project, { link: false })
    }

    private async checkProjectWithWasmAssembler(project: X86Project): Promise<X86CompileResult> {
        const sourceProject = copyX86Project(project)
        const assembled = await this.mode.wasmAssembler!.assemble(sourceProject)
        const report = assembled.stdout + assembled.stderr
        const diagnostics = [
            ...this.parseAssemblerDiagnostics(report, sourceProject),
            ...this.entryPointDiagnostics(
                assembled.units.map((unit) => unit.object),
                sourceProject,
            ),
        ]
        return toCompileResult(diagnostics, report)
    }

    private async buildProject(project: X86Project, options: { link: boolean }): Promise<X86CompileResult> {
        this.assertReadyForCompile()
        const sourceProject = copyX86Project(project)
        this.sourceProject = sourceProject
        this.stopReason = null
        this.assemblerLogs = ''
        this.assemblerErrors = []
        this.assemblerDiagnostics = []
        this.assembledObjects = []
        this.linkerLogs = null
        this.sourceMap = null
        this.assembleOnly = !options.link

        try {
            if (this.mode.wasmAssembler) {
                await this.assembleWithWasmAssembler(sourceProject, options)
            } else {
                await this.assembleInBlink(sourceProject)
            }
        } finally {
            this.assembleOnly = false
            this.module.FS.chdir('/')
        }

        const diagnostics = [
            ...this.assemblerDiagnostics.map((diagnostic) => ({
                ...diagnostic,
                file: x86ProjectSourcePath(diagnostic.file, sourceProject),
            })),
            ...this.entryPointDiagnostics(this.takeAssembledObjects(), sourceProject),
            ...this.linkDiagnostics(sourceProject),
        ]

        if (this.state === BlinkState.ProgramLoaded) this.sourceMap = this.tryReadSourceMap()
        return toCompileResult(diagnostics, this.assemblerLogs)
    }

    /**
     * The objects this build's assembler wrote, for the checks that read them
     * rather than the assembler's own words. Empty when the assembly failed, and
     * when the assembler writes an executable directly and never produces one.
     * Read once per build, so a previous build's objects can never stand in for
     * ones that were never written.
     */
    private takeAssembledObjects(): Uint8Array[] {
        const objects = this.assembledObjects
        this.assembledObjects = []
        return objects
    }

    /**
     * What the link had to say. A link that failed leaves no program to run, so a build that
     * reported nothing would hand the caller a success it cannot act on - the state stays `Ready`
     * and the next step or run fails with a message about the emulator rather than the mistake.
     * The fallback covers a linker that fails in a way its parser does not recognise, so a failed
     * link is always visible as an error whatever `ld` chose to say about it.
     */
    private linkDiagnostics(sourceProject: X86Project): X86CompilationDiagnostic[] {
        if (this.linkerLogs === null) return []
        const diagnostics = ldDiagnostics(this.linkerLogs).map((diagnostic) => ({
            ...diagnostic,
            file: x86ProjectSourcePath(diagnostic.file, sourceProject),
        }))
        const linked = this.state === BlinkState.ProgramLoaded
        if (linked || diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
            return diagnostics
        }
        return [
            ...diagnostics,
            {
                line: 1,
                file: sourceProject.entry,
                severity: 'error',
                error: 'linking failed, so there is no program to run.',
            },
        ]
    }

    /**
     * Nothing in the toolchain treats a missing entry point as a failure: NASM
     * has no opinion on it and `ld` only warns, then starts the program at the
     * top of its text segment, where it runs whatever happens to be first. That
     * is the least explicable thing a program can do to someone learning, so it
     * is reported as an error here and the mistake is usually a misspelling.
     */
    private entryPointDiagnostics(
        objects: readonly Uint8Array[],
        sourceProject: X86Project,
    ): X86CompilationDiagnostic[] {
        if (!objects.length || !this.mode.binaries.linker) return []
        // Any translation unit may be the one that exports the entry point, so the question is
        // whether the Project as a whole defines it, not whether the Entry File does.
        const globals = objects.flatMap((object) => readDefinedGlobalSymbols(object))
        if (globals.includes(DEFAULT_ENTRY_SYMBOL)) return []

        const nearest = findNearestSymbol(DEFAULT_ENTRY_SYMBOL, globals)
        const nearestHint = nearest
            ? ` Did you mean \`${DEFAULT_ENTRY_SYMBOL}\` where you wrote \`${nearest}\`?`
            : ''
        const exportHint = globals.length
            ? ''
            : ` Defining the label is not enough on its own: \`global ${DEFAULT_ENTRY_SYMBOL}\` is what exports it.`

        return [
            {
                line: 1,
                file: sourceProject.entry,
                severity: 'error',
                warningClass: 'entry-point',
                error:
                    `no \`${DEFAULT_ENTRY_SYMBOL}\` to start from.` +
                    `${nearestHint}${exportHint}`,
            },
        ]
    }

    private async assembleInBlink(sourceProject: X86Project): Promise<void> {
        stageX86Project(this.module.FS, sourceProject)
        this.setState(BlinkState.Assembling)
        await defer()
        this.setEmulationArgs('/assembler', this.mode.binaries.assembler!.commands, '')
        this.module._blinkenlib_run_fast()
        await this.waitForState(
            (state) => state !== BlinkState.Assembling && state !== BlinkState.Linking,
        )
        if (this.assemblerErrors.length === 0) {
            try {
                this.assembledObjects = [this.module.FS.readFile('/program.o') as Uint8Array]
            } catch {
                // An assembler that writes its executable directly, such as fasm,
                // produces no object, and has no linker to need an entry symbol.
            }
        }
    }

    /**
     * Assembles outside blink and hands the object file to the linker inside it,
     * which is where the state machine picks up again as if blink had produced
     * the object itself.
     */
    private async assembleWithWasmAssembler(
        sourceProject: X86Project,
        options: { link: boolean },
    ): Promise<void> {
        this.setState(BlinkState.Assembling)
        const assembled = await this.mode.wasmAssembler!.assemble(sourceProject)

        // The assembler no longer writes through blink's stdout, so its output
        // reaches the host's callbacks and the log the same way by hand.
        this.emitAssemblerOutput(assembled.stdout, this.callbacks.stdout)
        this.emitAssemblerOutput(assembled.stderr, this.callbacks.stderr)

        this.collectAssemblerDiagnostics()
        if (!assembled.units.length) {
            this.setState(BlinkState.Ready)
            return
        }

        this.assembledObjects = assembled.units.map((unit) => unit.object)
        if (!options.link) {
            this.setState(BlinkState.Ready)
            return
        }

        // One object per translation unit, named by position so the linker command never has to
        // carry a Project path. The Entry leads, which is the order the units were assembled in.
        const objectPaths = assembled.units.map((_, index) =>
            index === 0 ? '/program.o' : `/program.${index}.o`,
        )
        assembled.units.forEach((unit, index) => this.writeExecutableSync(objectPaths[index]!, unit.object))

        this.beginLinking()
        await defer()
        this.setEmulationArgs('/linker', this.mode.binaries.linker?.link(objectPaths) ?? '', '')
        this.module._blinkenlib_run_fast()
        await this.waitForState((state) => state !== BlinkState.Linking)
    }

    /**
     * Starts the link, and starts a log of its own for it. The assembler's parser cannot read
     * `ld`'s diagnostics and `ld`'s cannot read the assembler's, so what each of them said has to
     * stay separable even though both reach the caller as one report.
     */
    private beginLinking(): void {
        this.linkerLogs = ''
        this.setState(BlinkState.Linking)
    }

    private collectAssemblerDiagnostics(): void {
        this.assemblerDiagnostics = this.mode.diagnosticsParser?.(this.assemblerLogs) ?? []
        this.assemblerErrors = this.assemblerDiagnostics.filter(
            (diagnostic) => diagnostic.severity === 'error',
        )
    }

    private emitAssemblerOutput(text: string, callback: (charCode: number) => MaybePromise<void>): void {
        for (let index = 0; index < text.length; index += 1) {
            const charCode = text.charCodeAt(index)
            this.assemblerLogs += String.fromCharCode(charCode)
            observeCallbackResult(callback(charCode))
        }
    }

    private parseAssemblerDiagnostics(
        report: string,
        sourceProject: X86Project,
    ): X86CompilationDiagnostic[] {
        return (this.mode.diagnosticsParser?.(report) ?? []).map((error) => ({
            ...error,
            file: x86ProjectSourcePath(error.file, sourceProject),
        }))
    }

    loadElf(data: ArrayBuffer | Uint8Array): void {
        if (this.state === BlinkState.NotReady) throw new Error('Blink runtime is not ready')
        this.writeExecutableSync('/program', data instanceof Uint8Array ? data : new Uint8Array(data))
        this.stopReason = null
        this.sourceMap = null
        this.sourceProject = null
        this.setState(BlinkState.ProgramLoaded)
    }

    starti(): void {
        this.startProgram('_blinkenlib_starti')
    }

    pauseAtEntry(): void {
        this.starti()
        if (this.state === BlinkState.ProgramRunning) this.setState(BlinkState.ProgramPaused)
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

    setFlags(flags: bigint | number): void {
        this.module.blinkenlibSetFlags(Number(flags) >>> 0)
    }

    setStepRecording(enabled: boolean): void {
        this.module.blinkenlibSetStepRecording(enabled)
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

    getLastStepInfo(): NativeStepInfo {
        return this.module.blinkenlibGetLastStepInfo()
    }

    resolveSymbol(address: bigint): NativeSymbol | null {
        return this.module.blinkenlibResolveSymbol(address)
    }

    getSourceLineForAddress(address: bigint): number | null {
        return this.getSourceLocationForAddress(address)?.line ?? null
    }

    getSourceLocationForAddress(address: bigint): X86SourceLocation | null {
        const location = this.sourceMap?.getLocation(address)
        if (!location) return null
        return {
            path: this.sourceProject
                ? x86ProjectSourcePath(location.file, this.sourceProject)
                : (location.file ?? 'assembly.s'),
            line: location.lineIndex,
        }
    }

    getAddressesForSourceLine(lineIndex: number): bigint[] {
        return this.sourceMap?.getAddressesForLine(lineIndex) ?? []
    }

    getAddressesForSourceLocation(location: X86SourceLocation): bigint[] {
        if (!this.sourceMap || !this.sourceProject) return []
        return this.sourceMap.getAddressesMatching(
            location.line,
            (file) => x86ProjectSourcePath(file, this.sourceProject!) === location.path,
        )
    }

    getSourceMappedAddresses(): bigint[] {
        return this.sourceMap?.getAddresses() ?? []
    }

    pauseForBreakpoint(address: bigint, location: X86SourceLocation | undefined): void {
        this.stopReason = {
            loadFail: false,
            exitCode: 0,
            kind: 'breakpoint',
            details: `execution paused at breakpoint 0x${address.toString(16)}`,
            address,
            lineNumber: location?.line,
            file: location?.path,
        }
        this.setState(BlinkState.ProgramPaused)
    }

    pauseForLimit(address: bigint, executedInstructions: bigint): void {
        const location = this.getSourceLocationForAddress(address)
        this.stopReason = {
            loadFail: false,
            exitCode: 0,
            kind: 'limit',
            details: `execution paused after ${executedInstructions.toString()} instructions`,
            address,
            lineNumber: location?.line,
            file: location?.path,
            executedInstructions,
        }
        this.setState(BlinkState.ProgramPaused)
    }

    resumeAfterStateMutation(): void {
        this.stopReason = null
        if (
            this.state === BlinkState.ProgramStopped ||
            this.state === BlinkState.ProgramPaused ||
            this.state === BlinkState.ProgramReadlinePause
        ) {
            this.setState(BlinkState.ProgramRunning)
        }
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
        if (this.state !== BlinkState.Assembling && this.state !== BlinkState.Linking) return
        const character = String.fromCharCode(charCode)
        this.assemblerLogs += character
        if (this.state === BlinkState.Linking && this.linkerLogs !== null) this.linkerLogs += character
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
            observeCallbackResult(this.callbacks.signal(signal, code))
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
            observeCallbackResult(this.callbacks.inputRequest({ maxBytes: this.getInputMaxBytes() }))
        }

        if (code === SIGTRAP_CODES.BLINK_BREAKPOINT || code === SIGTRAP_CODES.BLINK_RUN_LIMIT) {
            const stop = this.module.blinkenlibGetRunStop()
            const location = this.getSourceLocationForAddress(stop.address)
            this.stopReason = {
                loadFail: false,
                exitCode: 0,
                kind: stop.kind === 'limit' ? 'limit' : 'breakpoint',
                details:
                    stop.kind === 'limit'
                        ? `execution paused after ${stop.executedInstructions.toString()} instructions`
                        : `execution paused at breakpoint 0x${stop.address.toString(16)}`,
                address: stop.address,
                lineNumber: location?.line,
                file: location?.path,
                executedInstructions: stop.executedInstructions,
            }
            this.setState(BlinkState.ProgramPaused)
        }

        observeCallbackResult(this.callbacks.signal(signal, code))
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
        // Parsed either way: an assembler that succeeded still has warnings to
        // report, and they are the ones nobody would otherwise see.
        this.collectAssemblerDiagnostics()
        if (code !== 0) {
            this.setState(BlinkState.Ready)
            return
        }

        // Checking wants the diagnostics, not a program to run.
        if (this.assembleOnly) {
            this.setState(BlinkState.Ready)
            return
        }

        if (!this.mode.binaries.linker) {
            this.module.FS.chmod('/program', 0o777)
            this.setState(BlinkState.ProgramLoaded)
            return
        }

        this.beginLinking()
        this.scheduler(() => {
            this.setEmulationArgs('/linker', this.mode.binaries.linker?.link(['/program.o']) ?? '', '')
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
        observeCallbackResult(this.callbacks.stateChange(state, oldState))
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

/**
 * A build succeeded when nothing in it was an error. Warnings ride along on both
 * outcomes, because a program that assembles is exactly where they matter.
 */
function toCompileResult(diagnostics: X86CompilationDiagnostic[], report: string): X86CompileResult {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length === 0) return { ok: true, report, diagnostics }
    return { ok: false, errors, report, diagnostics }
}

/** Detaches a Project from the caller, who is free to mutate its own copy afterwards. */
function copyX86Project(project: X86Project): X86Project {
    return {
        entry: project.entry,
        files: Object.fromEntries(
            Object.entries(project.files).map(([path, contents]) => [
                path,
                contents instanceof Uint8Array ? contents.slice() : contents,
            ]),
        ),
    }
}
