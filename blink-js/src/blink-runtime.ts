import blinkenlib from './wasm/blinkenlib.js'
import initBlinkWasm from './wasm/blinkenlib.wasm?init'
import {
    assemblers,
    DEFAULT_ASSEMBLER_ID,
    ldDiagnostics,
    type AssemblerId,
    type AssemblerMode
} from './assemblers'
import { writeArchive } from './archive'
import { readResourceBytes } from './resources'
import { parseSourceMap, type SourceMap } from './source-map'
import {
    stageX86Project,
    validateX86Project,
    X86_PROJECT_ROOT,
    x86ProjectSourcePath
} from './project'
import { DEFAULT_ENTRY_SYMBOL, findNearestSymbol, readDefinedGlobalSymbols, readElfSymbolTable } from './elf-symbols'
import { captureFileSystemSkeleton, resetFileSystem, type FileSystemSkeleton } from './file-system'
import { ProjectFileSystemMount, type X86ProjectFileSystem } from './project-file-system'
import {
    BlinkState,
    END_OF_INPUT,
    X86_REGISTER_NAMES,
    X86EnvironmentError,
    type StopReason,
    type X86CompilationDiagnostic,
    type X86CompileResult,
    type X86ImplementedSyscall,
    type X86Input,
    type X86InputRequest,
    type X86WaitRequest,
    type X86Environment,
    type X86Project,
    type X86SourceLocation
} from './types'
import { observeCallbackResult, type MaybePromise } from './callbacks'
import { X86_FPU_STATE_SIZE, emptyFpuStateBlock } from './fpu-state'
import { describeSignal } from './signals'
import type {
    BlinkenlibModule,
    DisassemblySnapshot,
    NativeInstruction,
    NativeStepInfo,
    NativeSymbol,
    RegisterSnapshot
} from './wasm-types'

/** The machine's page size: a page is contiguous in the host heap, the next page need not be. */
const BLINK_PAGE_SIZE = 4096

/** Where the program is written to be loaded, and removed from once it is. */
const PROGRAM = '/program'
/** The terminal's output channels, as the wasm numbers them. */
const STDERR_CHANNEL = 2

/** The Entry's object, which the link always takes whole. */
const ENTRY_OBJECT = '/program.o'
/** Every other unit's object, as a member `ld` takes only when the program needs it. */
const UNIT_ARCHIVE = '/program.a'
/** How `ld` names an archive member in its messages, `/program.a(u3.o)`, with the member's position. */
const ARCHIVE_MEMBER = /^\/(?:program|support)\.a\(u(\d+)\.o\)$/

/** The name of the archive's member at `position`: short enough to need no long-name table. */
function archiveMemberName(position: number): string {
    return `u${position}.o`
}

/**
 * The shadow-memory range blink keeps for its own bookkeeping, which the
 * memory bridge refuses to read. Kept in step with `IsShadow` in
 * `blink/blinkenlib.c`, so the fast read path refuses exactly what the bridge
 * refuses.
 */
export function isShadowAddress(address: bigint): boolean {
    return address >= 0x7fff8000n && address < 0x100080000000n
}

const SIGTRAP = 5

/**
 * The events the wasm sends as SIGTRAP with a code of its own. Linux never sends SIGTRAP with
 * these codes (its own are 1 to 6, `SI_KERNEL` and the negative `SI_*`), so a SIGTRAP with any other
 * code is the signal itself, which ends the program when no handler takes it.
 */
const SIGTRAP_CODES = {
    BLINK_PREEMPT: 40,
    BLINK_STEP: 41,
    BLINK_FAKE_TTY: 42,
    BLINK_BREAKPOINT: 43,
    BLINK_RUN_LIMIT: 44,
    BLINK_WAIT: 45
} as const

const BLINK_EVENT_CODES: ReadonlySet<number> = new Set(Object.values(SIGTRAP_CODES))

export type BlinkRuntimeCallbacks = {
    /**
     * The bytes of one write a program made to its standard output, or to the terminal opened by
     * another name, such as `/dev/tty`: one call per write, in the order the program wrote, with
     * `stderr`'s calls in between where they came. The assembler and the linker write only to the
     * build's report.
     */
    stdout?: (bytes: Uint8Array) => MaybePromise<void>
    /** The bytes of one write a program made to its standard error. */
    stderr?: (bytes: Uint8Array) => MaybePromise<void>
    signal?: (signal: number, code: number) => MaybePromise<void>
    stateChange?: (state: BlinkState, oldState: BlinkState) => MaybePromise<void>
    /** A read found the terminal empty: answer it with `provideInput()`. */
    inputRequest?: (event: X86InputRequest) => MaybePromise<void>
    waitRequest?: (event: X86WaitRequest) => MaybePromise<void>
}

export type BlinkRuntimeOptions = {
    mode?: AssemblerMode | AssemblerId
    callbacks?: BlinkRuntimeCallbacks
    environment?: X86Environment
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
    /** Cached view over the wasm heap, for `spyMemoryBytes`; growth invalidates it. */
    private heapView: Uint8Array | null = null

    mode: AssemblerMode
    state = BlinkState.NotReady
    stopReason: StopReason | null = null
    assemblerLogs = ''
    /** The subset of `assemblerDiagnostics` that stopped the build. */
    assemblerErrors: X86CompilationDiagnostic[] = []
    /** Everything the assembler said, warnings included. */
    assemblerDiagnostics: X86CompilationDiagnostic[] = []

    private environment: X86Environment = {}
    private waitController: AbortController | null = null
    private waitTimer: ReturnType<typeof setTimeout> | null = null
    private waitRequest: X86WaitRequest | null = null
    private waitResumeState = BlinkState.ProgramRunning
    private programSources = false
    private generation = 0
    private readonly callbacks: Required<BlinkRuntimeCallbacks>
    private readonly scheduler: (callback: () => void) => void
    /**
     * A preempted native loop is waiting for the scheduler to resume it: the
     * only time `ProgramRunning` means the program moves on its own. A step,
     * `starti()` or an undo also leaves it `ProgramRunning`, with nothing
     * executing it.
     */
    private resumeScheduled = false
    private readonly stateWaiters: StateWaiter[] = []
    /** The file system every program starts with, captured before anything ran. */
    private readonly skeleton: FileSystemSkeleton
    private projectMount: ProjectFileSystemMount | null = null
    private projectMountUsed = false
    /** The executable the last build linked, or `loadElf()` was given, written out at each start. */
    private programBytes: Uint8Array | null = null
    /** The assembler's and the linker's executables, by path, written out before each of their runs. */
    private readonly tools = new Map<string, Uint8Array>()
    private sourceMap: SourceMap | null = null
    private sourceProject: X86Project | null = null
    private assembleOnly = false
    private assembledObjects: Uint8Array[] = []
    /** The path of the unit each member of the archive was assembled from, in member order. */
    private archiveMembers: string[] = []
    private startObjectSources = new Map<string, string>()
    private unitDiagnostics: X86CompilationDiagnostic[] = []
    /** What the linker said, kept apart from the assembler's log so `ld`'s own parser reads it. */
    private linkerLogs: string | null = null

    private readonly defaultArgc = '/program'
    private readonly defaultArgv = ''

    private constructor(
        module: BlinkenlibModule,
        mode: AssemblerMode,
        callbacks: Required<BlinkRuntimeCallbacks>,
        scheduler: (callback: () => void) => void
    ) {
        this.module = module
        this.mode = mode
        this.callbacks = callbacks
        this.scheduler = scheduler
        this.skeleton = captureFileSystemSkeleton(module.FS)
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
                void wasmInit.then(
                    (instance) => receiveInstance(instance),
                    () => undefined
                )
            },
            preRun: (moduleInstance) => {
                // Programs read and write the terminal without these: Emscripten's standard
                // streams only hold descriptors 0 to 2 for it, and take what blink itself writes.
                moduleInstance.FS.init(
                    () => null,
                    (byte) => runtime?.deliverOutput(1, Uint8Array.of(byte)),
                    (byte) => runtime?.deliverOutput(STDERR_CHANNEL, Uint8Array.of(byte))
                )
            }
        })
        const module = await awaitBlinkenlibModule(modulePromise, wasmInitStarted)

        const signalPointer = module.addFunction(
            (signal: number, code: number) => runtime?.handleSignal(signal, code),
            'vii'
        )
        const exitPointer = module.addFunction((code: number) => runtime?.handleExit(code), 'vi')
        const outputPointer = module.addFunction(
            (channel: number, pointer: number, length: number) =>
                runtime?.handleOutput(channel, pointer, length),
            'viii'
        )

        module.blinkHostNow = (clock) => runtime?.hostNow(clock) ?? hostNow(clock)
        module.blinkHostRandom = (pointer, length) => {
            const serial = runtime?.getCurrentInstructionSerial() ?? null
            const bytes =
                runtime?.programSources && runtime.environment.random
                    ? runtime.environment.random(length, serial)
                    : hostRandom(length)
            if (!(bytes instanceof Uint8Array) || bytes.length !== length)
                throw new Error('Random source must return exactly the requested bytes')
            runtime!.heapBytes().set(bytes, pointer)
        }
        module.callMain([
            signalPointer.toString(),
            exitPointer.toString(),
            outputPointer.toString()
        ])
        module._blinkenlib_set_deferred_disassembly?.(true)

        runtime = new BlinkRuntime(module, mode, callbacks, scheduler)
        runtime.environment = options.environment ?? {}
        await runtime.setMode(mode)
        return runtime
    }

    async setMode(mode: AssemblerMode | AssemblerId): Promise<void> {
        this.mode = resolveAssemblerMode(mode)
        this.assemblerLogs = ''
        this.assemblerErrors = []
        this.setState(BlinkState.NotReady)
        this.tools.clear()
        if (this.mode.binaries.assembler) {
            this.tools.set('/assembler', await readResourceBytes(this.mode.binaries.assembler.file))
        }
        if (this.mode.binaries.linker) {
            this.tools.set('/linker', await readResourceBytes(this.mode.binaries.linker.file))
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
        validateX86Project(project)
        const sourceProject = copyX86Project(project)
        const assembled = await this.mode.wasmAssembler!.assemble(sourceProject)
        const report = assembled.stdout + assembled.stderr
        const diagnostics = [
            ...this.parseAssemblerDiagnostics(report, sourceProject),
            ...duplicateUserDefinitions(assembled.units, sourceProject),
            ...this.entryPointDiagnostics(
                assembled.units.map((unit) => unit.object),
                sourceProject
            )
        ]
        return toCompileResult(diagnostics, report)
    }

    private async buildProject(
        project: X86Project,
        options: { link: boolean }
    ): Promise<X86CompileResult> {
        this.assertReadyForCompile()
        // Before anything changes, so that a Project the build cannot take leaves the previous
        // program, and the state it is in, exactly as they were.
        validateX86Project(project)
        this.detachProjectFileSystem()
        const sourceProject = copyX86Project(project)
        this.sourceProject = sourceProject
        // The build starts from the file system every program does, so nothing an earlier run
        // left behind can stand in for a File, an object or a tool; it replaces the program, and
        // what was typed for that one is not for the next.
        resetFileSystem(this.module.FS, this.skeleton)
        this.module.blinkenlibClearInput()
        this.programBytes = null
        this.stopReason = null
        this.assemblerLogs = ''
        this.assemblerErrors = []
        this.assemblerDiagnostics = []
        this.assembledObjects = []
        this.archiveMembers = []
        this.startObjectSources.clear()
        this.unitDiagnostics = []
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
                file: x86ProjectSourcePath(diagnostic.file, sourceProject)
            })),
            ...this.unitDiagnostics,
            ...this.entryPointDiagnostics(this.takeAssembledObjects(), sourceProject),
            ...this.linkDiagnostics(sourceProject)
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
        const projectPath = (path: string | undefined) => x86ProjectSourcePath(path, sourceProject)
        const objectSource = (object: string) => this.objectSource(object)
        const diagnostics = ldDiagnostics(this.linkerLogs, projectPath, objectSource).map(
            (diagnostic) => ({
                ...diagnostic,
                file: projectPath(diagnostic.file)
            })
        )
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
                error: 'linking failed, so there is no program to run.'
            }
        ]
    }

    /**
     * The source an object `ld` names was assembled from, written as the assembler wrote it into
     * the object, which is how `ld` writes the source paths it finds: `/assembly.s` for the
     * Entry's, the staged path for an archive member's. Undefined for an object this build did not
     * make.
     */
    private objectSource(object: string): string | undefined {
        if (object === ENTRY_OBJECT) return '/assembly.s'
        if (this.startObjectSources.has(object)) return this.startObjectSources.get(object)
        const member = ARCHIVE_MEMBER.exec(object)
        const path = member ? this.archiveMembers[Number(member[1])] : undefined
        return path === undefined ? undefined : `${X86_PROJECT_ROOT}/${path}`
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
        sourceProject: X86Project
    ): X86CompilationDiagnostic[] {
        if (!objects.length || !this.mode.binaries.linker) return []
        // Any translation unit may be the one that exports the entry point, a library's included:
        // `ld` needs the entry symbol from the start, so it takes the archive member that defines
        // it. The question is whether the Project as a whole defines it, not whether the Entry does.
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
                    `no \`${DEFAULT_ENTRY_SYMBOL}\` to start from.` + `${nearestHint}${exportHint}`
            }
        ]
    }

    private async assembleInBlink(sourceProject: X86Project): Promise<void> {
        stageX86Project(this.module.FS, sourceProject)
        this.setState(BlinkState.Assembling)
        await defer()
        this.runTool('/assembler', this.mode.binaries.assembler!.commands)
        await this.waitForState(
            (state) => state !== BlinkState.Assembling && state !== BlinkState.Linking
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
        options: { link: boolean }
    ): Promise<void> {
        this.setState(BlinkState.Assembling)
        const assembled = await this.mode.wasmAssembler!.assemble(sourceProject)

        // What the assembler said goes into the report, as a blink-hosted tool's does.
        this.assemblerLogs += assembled.stdout + assembled.stderr

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

        const [entry, ...others] = assembled.units
        this.unitDiagnostics = duplicateUserDefinitions(assembled.units, sourceProject)
        if (this.unitDiagnostics.length) { this.setState(BlinkState.Ready); return }
        this.writeExecutableSync(ENTRY_OBJECT, entry!.object)
        const inputs = [ENTRY_OBJECT]
        const starts = others.filter(unit => Object.hasOwn(sourceProject.startUnits ?? {}, unit.path))
        for (const [i, unit] of starts.entries()) {
            const object = `/start${i}.o`
            this.writeExecutableSync(object, unit.object)
            this.startObjectSources.set(object, `${X86_PROJECT_ROOT}/${unit.path}`)
            inputs.push(object)
        }
        const members = others.filter(unit => !Object.hasOwn(sourceProject.startUnits ?? {}, unit.path))
        this.archiveMembers = members.map(unit => unit.path)
        const userMembers = members.filter(unit => Object.hasOwn(sourceProject.files, unit.path))
        const support = members.filter(unit => Object.hasOwn(sourceProject.library ?? {}, unit.path))
        for (const [archivePath, units] of [[UNIT_ARCHIVE, userMembers], ['/support.a', support]] as const) {
            if (!units.length) continue
            this.writeExecutableSync(archivePath, writeArchive(units.map(unit => ({
                name: archiveMemberName(members.indexOf(unit)), data: unit.object
            }))))
            inputs.push(archivePath)
        }
        // A support member may reference a secondary user definition. Re-search archives for it.
        this.beginLinking()
        await defer()
        this.runTool('/linker', this.mode.binaries.linker?.link(inputs).replace(
            inputs.join(' '), `--start-group ${inputs.join(' ')} --end-group`) + ' -Map /program.map')
        await this.waitForState(state => state !== BlinkState.Linking)
        if (this.state === BlinkState.ProgramLoaded) {
            const map = this.module.FS.readFile('/program.map', { encoding: 'utf8' }) as string
            for (const unit of userMembers) {
                const member = archiveMemberName(members.indexOf(unit))
                if (!map.includes(`${UNIT_ARCHIVE}(${member})`)) this.unitDiagnostics.push({
                    file: unit.path, line: 1, severity: 'hint', warningClass: 'not-linked',
                    error: 'nothing refers to a symbol this File defines, so it is not part of the program'
                })
            }
        }
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
            (diagnostic) => diagnostic.severity === 'error'
        )
    }

    private parseAssemblerDiagnostics(
        report: string,
        sourceProject: X86Project
    ): X86CompilationDiagnostic[] {
        return (this.mode.diagnosticsParser?.(report) ?? []).map((error) => ({
            ...error,
            file: x86ProjectSourcePath(error.file, sourceProject)
        }))
    }

    loadElf(data: ArrayBuffer | Uint8Array): void {
        this.clearWaitTransport()
        ++this.generation
        this.detachProjectFileSystem()
        this.module._blinkenlib_abandon_execution()
        if (this.state === BlinkState.NotReady) throw new Error('Blink runtime is not ready')
        this.programBytes =
            data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0))
        this.module.blinkenlibClearInput()
        this.stopReason = null
        this.sourceMap = null
        this.sourceProject = null
        this.setState(BlinkState.ProgramLoaded)
    }

    /**
     * The executable the last build linked, or the one `loadElf()` was given: a copy, or null
     * before either. The program never sees it on the file system (see `startProgram`).
     */
    getExecutable(): Uint8Array | null {
        return this.programBytes?.slice() ?? null
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
        this.checkHostError()
    }

    continue(): void {
        if (this.state === BlinkState.ProgramPaused) this.setState(BlinkState.ProgramRunning)
        if (this.state !== BlinkState.ProgramRunning) {
            throw new Error(`Cannot continue while emulator is ${this.state}`)
        }
        this.module._blinkenlib_continue()
        this.checkHostError()
    }

    async runUntilBlocked(options: BlinkRunOptions = {}): Promise<BlinkState> {
        this.configureRunControls(options)
        if (this.state === BlinkState.ProgramLoaded || this.state === BlinkState.ProgramStopped)
            this.run()
        // Waiting is right only for a loop that resumes itself: one left
        // running by a step has to be continued, or nothing ever stops it.
        if (
            this.state === BlinkState.ProgramPaused ||
            (this.state === BlinkState.ProgramRunning && !this.resumeScheduled)
        ) {
            this.continue()
        }
        if (this.state === BlinkState.ProgramRunning) return this.waitUntilBlocked()
        return this.state
    }

    /**
     * Resolves once no preempted loop is left to resume itself, with the state
     * it stopped in, and at once when there is none. Unlike `runUntilBlocked`
     * it never starts or continues the program.
     */
    async settle(): Promise<BlinkState> {
        if (this.state === BlinkState.ProgramRunning && this.resumeScheduled)
            return this.waitUntilBlocked()
        return this.state
    }

    /** Synchronous bounded execution; input and exit callbacks may stop it early. */
    runSlice(budget: number, breakpoints: bigint[], skipAtPc: boolean): number {
        this.configureRunControls({ breakpointAddresses: breakpoints })
        this.resumeAfterStateMutation()
        this.module._blinkenlib_run_slice!(budget, skipAtPc)
        this.checkHostError()
        return Number(this.module.blinkenlibGetRunStop().executedInstructions)
    }

    /**
     * Gives the terminal input: bytes its line discipline released, a string as its UTF-8 bytes,
     * or `END_OF_INPUT`. It queues after what earlier calls gave and no read has taken, and reads
     * take it as on a Linux terminal (see the README's "Standard streams"). A read waiting for
     * input resumes and starts over: returns true for that. Otherwise the input waits for the
     * program's next read, of this run or, between runs, of the next one.
     */
    setEnvironment(environment: X86Environment): void {
        if (this.isWaiting())
            throw new Error('Cannot replace sources while an instruction is waiting')
        this.environment = environment
    }
    getInstructionsExecuted(): bigint {
        if (this.state === BlinkState.ProgramLoaded) return 0n
        return this.module._blinkenlib_instructions_executed()
    }
    getCurrentInstructionSerial(): string | null {
        const serial = this.module._blinkenlib_active_instruction()
        return serial ? serial.toString() : null
    }
    isWaiting(): boolean {
        return (
            this.state === BlinkState.ProgramReadlinePause ||
            this.state === BlinkState.ProgramWaitPause
        )
    }
    getWaitRequest(): X86WaitRequest | null {
        return this.waitRequest
    }
    private hostNow(clock: number): number {
        const value =
            this.programSources && this.environment.now
                ? this.environment.now(clock)
                : hostNow(clock)
        if (!Number.isFinite(value) || value < 0)
            throw new Error('Clock source must return finite nonnegative milliseconds')
        return value
    }
    private checkHostError(): void {
        if (this.module.blinkHostError === undefined) return
        const error = new X86EnvironmentError(this.module.blinkHostError)
        delete this.module.blinkHostError
        this.clearWaitTransport()
        this.module._blinkenlib_abandon_execution()
        this.stopReason = {
            loadFail: false,
            exitCode: 0,
            kind: 'host-error',
            details: error.message
        }
        this.setState(BlinkState.ProgramStopped)
        throw error
    }
    private clearWaitTransport(): void {
        this.waitController?.abort()
        this.waitController = null
        if (this.waitTimer !== null) clearTimeout(this.waitTimer)
        this.waitTimer = null
        this.waitRequest = null
    }
    private scheduleInputTimer(): void {
        const deadline = this.module._blinkenlib_timer_deadline()
        if (deadline < 0n) return
        const delay = Math.max(0, Number(deadline) / 1e6 - this.hostNow(1))
        const generation = this.generation
        this.waitTimer = setTimeout(
            () => {
                this.waitTimer = null
                if (
                    generation !== this.generation ||
                    this.state !== BlinkState.ProgramReadlinePause
                )
                    return
                this.stopReason = null
                this.setState(BlinkState.ProgramRunning)
                this.module._blinkenlib_faketty_resume()
                this.checkHostError()
            },
            Math.min(2147483647, Math.ceil(delay))
        )
    }
    resumeWait(cancel = false): boolean {
        if (
            this.state !== BlinkState.ProgramWaitPause &&
            !(this.waitRequest && !this.programSources)
        )
            return false
        const resumeState = this.waitResumeState
        this.clearWaitTransport()
        if (cancel) this.module._blinkenlib_wait_cancel()
        this.stopReason = null
        this.setState(resumeState)
        this.module._blinkenlib_faketty_resume()
        this.checkHostError()
        return true
    }
    cancelWait(): boolean {
        return this.resumeWait(true)
    }
    /** End a session while retaining the module, environment sources and callback registrations. */
    clearExecution(): void {
        if (
            this.state === BlinkState.Assembling ||
            this.state === BlinkState.Linking ||
            (this.getCurrentInstructionSerial() !== null && !this.isWaiting())
        )
            throw new Error('Cannot clear x86 execution from an active native instruction or build')
        this.clearWaitTransport()
        ++this.generation
        this.resumeScheduled = false
        this.detachProjectFileSystem()
        this.module._blinkenlib_clear_execution()
        delete this.module.blinkHostError
        this.programSources = false
        this.programBytes = null
        this.sourceMap = null
        this.sourceProject = null
        this.stopReason = null
        resetFileSystem(this.module.FS, this.skeleton)
        this.setState(BlinkState.Ready)
    }
    dispose(): void {
        this.clearExecution()
        this.setState(BlinkState.ProgramStopped)
    }
    provideInput(input: X86Input): boolean {
        if (input === END_OF_INPUT) {
            this.module.blinkenlibProvideEndOfInput()
        } else {
            const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
            if (!(bytes instanceof Uint8Array))
                throw new TypeError('provideInput takes bytes, a string or END_OF_INPUT')
            this.module.blinkenlibProvideInput(bytes)
        }
        if (this.state === BlinkState.ProgramWaitPause && this.waitRequest?.acceptsInput)
            return this.resumeWait()
        if (this.state !== BlinkState.ProgramReadlinePause) return false
        if (this.waitTimer !== null) clearTimeout(this.waitTimer)
        this.waitTimer = null
        this.setState(BlinkState.ProgramRunning)
        this.module._blinkenlib_faketty_resume()
        this.checkHostError()
        return true
    }

    readMemoryBytes(address: bigint, length: bigint): Uint8Array {
        const size = Number(length)
        if (!Number.isSafeInteger(size) || size < 0)
            throw new Error(`Invalid memory read length: ${length}`)
        const result = this.module.blinkenlibReadMemoryBytes(address, size)
        if (!result.ok) throw new Error(`${result.error}: 0x${address.toString(16)}`)
        return Uint8Array.from(result.bytes)
    }

    /**
     * The bytes at `address` read straight out of the machine's own pages,
     * or null when the machine cannot answer for the whole range.
     *
     * `blinkenlibReadMemoryBytes` looks each byte up and then builds a
     * JavaScript array inside the bridge, which costs about four times as much
     * as this does; recording a step reads only addresses the step just wrote,
     * so it takes this path and falls back to the bridge whenever this one
     * declines. The two agree byte for byte because they do the same lookup:
     * `blinkenlib_spy_address` IS the lookup `blinkenlib_read_memory_byte`
     * makes, and the shadow-memory range the bridge refuses is refused here
     * too. A page is contiguous in the host heap and the next page need not
     * be, so the read stops at every page boundary and looks the next one up.
     */
    spyMemoryBytes(address: bigint, length: number): Uint8Array | null {
        const spy = this.module._blinkenlib_spy_address
        if (!spy || !this.module.wasmExports?.memory) return null
        if (!Number.isSafeInteger(length) || length <= 0) return null
        // Without a machine there are no pages to look into, and the bridge
        // answers that case with an error rather than a pointer.
        if (this.state === BlinkState.NotReady || this.state === BlinkState.Ready) return null

        const bytes = new Uint8Array(length)
        let offset = 0
        while (offset < length) {
            const target = address + BigInt(offset)
            if (isShadowAddress(target)) return null
            const pointer = spy.call(this.module, target) >>> 0
            if (pointer === 0) return null
            const take = Math.min(BLINK_PAGE_SIZE - Number(target & 4095n), length - offset)
            bytes.set(this.heapBytes().subarray(pointer, pointer + take), offset)
            offset += take
        }
        return bytes
    }

    /**
     * A view over the wasm heap, rebuilt only when growth has replaced the
     * buffer the last one was taken from.
     */
    private heapBytes(): Uint8Array {
        const buffer = this.module.wasmExports!.memory!.buffer
        if (!this.heapView || this.heapView.buffer !== buffer)
            this.heapView = new Uint8Array(buffer)
        return this.heapView
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
        const read = this.module._blinkenlib_get_register_snapshot
        if (read && this.module.wasmExports?.memory) {
            const pointer = read.call(this.module) >>> 0
            // The native call may grow memory: acquire the view afterwards.
            const view = new DataView(this.heapBytes().buffer, pointer, 19 * 8)
            const registers = {} as RegisterSnapshot['registers']
            for (let index = 0; index < X86_REGISTER_NAMES.length; index++) {
                registers[X86_REGISTER_NAMES[index]!] = view.getBigUint64(index * 8, true)
            }
            return {
                registers,
                rip: registers.rip,
                rsp: registers.rsp,
                pc: view.getBigUint64(17 * 8, true),
                flags: view.getUint32(18 * 8, true)
            }
        }
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

    /**
     * A copy of the whole packed FPU state block: `xmm0..xmm15`, `mxcsr`, the
     * x87 stack and its control, status and tag words. One bridge call reads
     * the lot, so a per-step snapshot costs the same whatever the instruction
     * touched. Before a program is loaded there is no machine, the bridge
     * answers with an empty array, and the block reads as zeros.
     *
     * Any other length means the wasm and this package disagree about the
     * layout, which would silently degrade every read to zeros, every step to
     * "the FPU did not change" and every undo to writing a zeroed FPU file, so
     * it throws instead.
     */
    getFpuStateRaw(): Uint8Array {
        const read = this.module._blinkenlib_get_fpu_snapshot
        if (read && this.module.wasmExports?.memory) {
            const pointer = read.call(this.module) >>> 0
            if (!pointer) return emptyFpuStateBlock()
            // History owns its bytes; never retain a view into the reusable buffer.
            return this.heapBytes().slice(pointer, pointer + X86_FPU_STATE_SIZE)
        }
        const raw = this.module.blinkenlibGetFpuState()
        if (raw.length === 0) return emptyFpuStateBlock()
        if (raw.length !== X86_FPU_STATE_SIZE) {
            throw new Error(
                `The x86 FPU bridge returned ${raw.length} bytes, expected ${X86_FPU_STATE_SIZE}: the wasm and blink-js are out of step`
            )
        }
        return raw
    }

    /**
     * Restores a block read by `getFpuStateRaw()`. The write goes straight
     * into the machine, so it is never recorded as a step of its own. A block
     * of any other length is rejected here, before the bridge, so that a
     * layout mistake does not read as a missing machine.
     */
    setFpuStateRaw(bytes: Uint8Array): void {
        // The bridge answers false for a wrong length as well as for a missing
        // machine; check the length here so a hand-built block is named for
        // what it is instead of sending the caller hunting for the machine.
        if (bytes.length !== X86_FPU_STATE_SIZE) {
            throw new Error(
                `An x86 FPU state block must be ${X86_FPU_STATE_SIZE} bytes, got ${bytes.length}`
            )
        }
        if (!this.module.blinkenlibSetFpuState(bytes)) {
            throw new Error('Cannot write the x86 FPU state: no machine is loaded')
        }
    }

    setFlags(flags: bigint | number): void {
        this.module.blinkenlibSetFlags(Number(flags) >>> 0)
    }

    setStepRecording(enabled: boolean): void {
        this.module.blinkenlibSetStepRecording(enabled)
    }

    getPc(): bigint {
        if (this.module._blinkenlib_get_pc) return this.module._blinkenlib_get_pc()
        return this.getRegisterSnapshot().pc
    }

    getSp(): bigint {
        return this.getRegister('rsp')
    }

    getFlags(): bigint {
        if (this.module._blinkenlib_get_flags) return BigInt(this.module._blinkenlib_get_flags())
        return BigInt(this.getRegisterSnapshot().flags)
    }

    getInputMaxBytes(): bigint {
        return this.module.blinkenlibGetInputMaxBytes()
    }

    /**
     * The system calls this Core implements, by number: the arms of the dispatch table the wasm
     * was compiled with, so a call its configuration leaves out is not listed. A number not listed
     * answers ENOSYS. The list is the same for every program and never changes while the module
     * lives.
     */
    getImplementedSyscalls(): X86ImplementedSyscall[] {
        return this.module
            .blinkenlibGetSyscalls()
            .map(({ number, name, arity }) => ({ number, name, arity }))
            .sort((a, b) => a.number - b.number)
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
            line: location.lineIndex
        }
    }

    getAddressesForSourceLine(lineIndex: number): bigint[] {
        return this.sourceMap?.getAddressesForLine(lineIndex) ?? []
    }

    getAddressesForSourceLocation(location: X86SourceLocation): bigint[] {
        if (!this.sourceMap || !this.sourceProject) return []
        return this.sourceMap.getAddressesMatching(
            location.line,
            (file) => x86ProjectSourcePath(file, this.sourceProject!) === location.path
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
            file: location?.path
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
            executedInstructions
        }
        this.setState(BlinkState.ProgramPaused)
    }

    resumeAfterStateMutation(): void {
        if (this.isWaiting()) throw new Error('Cannot change state while an instruction is waiting')
        this.stopReason = null
        if (
            this.state === BlinkState.ProgramStopped ||
            this.state === BlinkState.ProgramPaused ||
            this.state === BlinkState.ProgramReadlinePause
        ) {
            this.setState(BlinkState.ProgramRunning)
        }
    }

    /**
     * Starts the program afresh. It finds the file system every program starts with, the empty
     * working directory its current one, and descriptors 0 to 2 the terminal, whatever the run
     * before it did: the Core closes what that run left open. The executable is written out only
     * for the loader and removed before the first instruction, so the program sees none of the
     * toolchain's files. Input given for a run that never ended is forgotten; input given after
     * a run ended, or since the build, is the new run's.
     */
    private startProgram(method: '_blinkenlib_run' | '_blinkenlib_starti'): void {
        this.clearWaitTransport()
        ++this.generation
        this.programSources = true
        try {
            if (this.projectMountUsed) this.detachProjectFileSystem()
            if (
                this.state !== BlinkState.ProgramLoaded &&
                this.state !== BlinkState.ProgramStopped
            ) {
                this.module.blinkenlibClearInput()
            }
            this.stopReason = null
            this.setState(BlinkState.ProgramRunning)
            resetFileSystem(this.module.FS, this.skeleton)
            this.projectMountUsed = this.projectMount !== null
            if (this.programBytes) this.writeExecutableSync(PROGRAM, this.programBytes)
            this.setEmulationArgs(PROGRAM, this.defaultArgc, this.defaultArgv)
            this.module._blinkenlib_starti()
            this.checkHostError()
            this.module.FS.unlink(PROGRAM)
            if (method === '_blinkenlib_run') {
                this.module._blinkenlib_continue()
                this.checkHostError()
            }
        } catch (error) {
            const cause = this.module.blinkHostError ?? error
            delete this.module.blinkHostError
            this.stopReason = {
                loadFail: true,
                exitCode: 0,
                details: cause instanceof Error ? cause.message : String(cause),
                kind: 'load-fail'
            }
            this.setState(BlinkState.ProgramStopped)
        }
    }

    /** Mount a one-run capability after Build and before the first instruction (or loader). */
    mountProjectFileSystem(capability: X86ProjectFileSystem | null): void {
        if (
            this.state === BlinkState.Assembling ||
            this.state === BlinkState.Linking ||
            this.state === BlinkState.NotReady ||
            this.isWaiting() ||
            this.resumeScheduled ||
            (this.programSources && this.state !== BlinkState.ProgramLoaded)
        )
            throw new Error('Cannot change the x86 Project FileSystem while a program is active')
        this.detachProjectFileSystem()
        if (capability) {
            this.projectMount = new ProjectFileSystemMount(this.module, capability, () =>
                this.getCurrentInstructionSerial()
            )
        }
    }

    private detachProjectFileSystem(): void {
        this.projectMount?.detach()
        this.projectMount = null
        this.projectMountUsed = false
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

    /**
     * Runs the assembler or the linker inside the wasm. The report gets the command first, the
     * way a shell echoes it, so it says which tool wrote what follows; neither reaches the
     * `stdout` and `stderr` callbacks, which are the program's.
     */
    private runTool(progname: string, command: string): void {
        this.clearWaitTransport()
        ++this.generation
        this.programSources = false
        this.assemblerLogs += `\n$ ${command}\n`
        // Written each time: a program may have left a file of that name.
        const tool = this.tools.get(progname)
        if (tool) this.writeExecutableSync(progname, tool)
        this.setEmulationArgs(progname, command, '')
        this.module._blinkenlib_run_fast()
    }

    private configureRunControls(options: BlinkRunOptions): void {
        const limit = options.limit ?? 0
        this.module.blinkenlibSetRunControls(
            BigInt(limit),
            (options.breakpointAddresses ?? []).map((address) => address.toString())
        )
    }

    /**
     * What a program wrote to the terminal, `length` bytes at `pointer` in the wasm heap: one
     * write, which the host receives as one call. The assembler's and the linker's go to the
     * report instead.
     */
    private handleOutput(channel: number, pointer: number, length: number): void {
        this.deliverOutput(channel, this.heapBytes().slice(pointer, pointer + length))
    }

    private deliverOutput(channel: number, bytes: Uint8Array): void {
        if (this.state === BlinkState.Assembling || this.state === BlinkState.Linking) {
            this.collectToolOutput(bytes)
            return
        }
        const callback = channel === STDERR_CHANNEL ? this.callbacks.stderr : this.callbacks.stdout
        // A handler that throws must not unwind the wasm in the middle of a system call; it is
        // reported as an asynchronous callback's failure is.
        try {
            observeCallbackResult(callback(bytes))
        } catch (error) {
            observeCallbackResult(Promise.reject(error))
        }
    }

    /** A tool's output, a character per byte, as the diagnostics parsers read it. */
    private collectToolOutput(bytes: Uint8Array): void {
        let text = ''
        for (let index = 0; index < bytes.length; index += 8192) {
            text += String.fromCharCode(...bytes.subarray(index, index + 8192))
        }
        this.assemblerLogs += text
        if (this.state === BlinkState.Linking && this.linkerLogs !== null) this.linkerLogs += text
    }

    private handleSignal(signal: number, code: number): void {
        if (signal !== SIGTRAP || !BLINK_EVENT_CODES.has(code)) {
            // A signal no handler took, which ends the program as Linux's default action does: a
            // shell reports it as 128 plus the signal's number.
            const exitCode = 128 + signal
            const info = describeSignal(signal, code)
            this.stopReason = {
                loadFail: false,
                exitCode,
                kind: 'signal',
                signal: info,
                details: `Program terminated with Exit(${exitCode}) due to signal ${info.name}: ${info.description}`
            }
            // what was typed for the run is not for the next one
            this.module.blinkenlibClearInput()
            this.setState(BlinkState.ProgramStopped)
            observeCallbackResult(this.callbacks.signal(signal, code))
            return
        }

        if (code === SIGTRAP_CODES.BLINK_PREEMPT) {
            this.resumeScheduled = true
            const generation = this.generation
            this.scheduler(() => {
                if (generation !== this.generation) return
                this.resumeScheduled = false
                this.module._blinkenlib_preempt_resume()
                this.checkHostError()
            })
            return
        }

        if (code === SIGTRAP_CODES.BLINK_WAIT) {
            if (this.module.blinkHostError !== undefined) return
            this.clearWaitTransport()
            const deadline = this.module._blinkenlib_wait_deadline()
            const clock = this.module._blinkenlib_wait_clock()
            const request: X86WaitRequest = {
                clock,
                deadlineNanoseconds: deadline < 0n ? null : deadline,
                remainingMilliseconds:
                    deadline < 0n
                        ? null
                        : Math.max(0, Number(deadline) / 1e6 - this.hostNow(clock)),
                acceptsInput: Boolean(this.module._blinkenlib_wait_input()),
                instructionSerial: this.getCurrentInstructionSerial()!
            }
            this.waitRequest = request
            this.waitResumeState = this.programSources ? BlinkState.ProgramRunning : this.state
            if (this.programSources)
                this.stopReason = {
                    loadFail: false,
                    exitCode: 0,
                    kind: 'wait',
                    details: 'program is waiting'
                }
            if (this.programSources) {
                this.setState(BlinkState.ProgramWaitPause)
                observeCallbackResult(this.callbacks.waitRequest(request))
                if (this.state !== BlinkState.ProgramWaitPause) return
            }
            const controller = new AbortController()
            this.waitController = controller
            if (this.programSources && this.environment.wait) {
                const timerDeadline = this.module._blinkenlib_timer_deadline()
                if (timerDeadline >= 0n)
                    this.waitTimer = setTimeout(
                        () => {
                            if (!controller.signal.aborted) this.resumeWait()
                        },
                        Math.min(
                            2147483647,
                            Math.ceil(Math.max(0, Number(timerDeadline) / 1e6 - this.hostNow(1)))
                        )
                    )
                Promise.resolve()
                    .then(() => {
                        if (!controller.signal.aborted)
                            return this.environment.wait!(request, controller.signal)
                    })
                    .then(
                        () => {
                            if (!controller.signal.aborted) this.resumeWait()
                        },
                        () => {
                            if (!controller.signal.aborted) this.cancelWait()
                        }
                    )
            } else if (request.remainingMilliseconds !== null) {
                this.waitTimer = setTimeout(
                    () => {
                        if (!controller.signal.aborted) this.resumeWait()
                    },
                    Math.min(2147483647, Math.ceil(request.remainingMilliseconds))
                )
            }
        }
        if (code === SIGTRAP_CODES.BLINK_FAKE_TTY) {
            this.stopReason = {
                loadFail: false,
                exitCode: 0,
                kind: 'input',
                details: 'program is waiting for input'
            }
            this.setState(BlinkState.ProgramReadlinePause)
            this.scheduleInputTimer()
            observeCallbackResult(
                this.callbacks.inputRequest({ maxBytes: this.getInputMaxBytes() })
            )
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
                executedInstructions: stop.executedInstructions
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

        // The wasm keeps the status as a parent sees it, its low eight bits.
        this.stopReason = {
            loadFail: false,
            exitCode: code,
            kind: 'exit',
            details: `program terminated with Exit(${code})`
        }
        // what was typed for the run is not for the next one
        this.module.blinkenlibClearInput()
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
            this.takeProgram()
            return
        }

        this.beginLinking()
        this.scheduler(() =>
            this.runTool('/linker', this.mode.binaries.linker?.link(['/program.o']) ?? '')
        )
    }

    private handleLinkerExit(code: number): void {
        if (code !== 0) {
            this.setState(BlinkState.Ready)
            return
        }
        this.takeProgram()
    }

    /** Keeps the executable the build wrote, which every start of the program writes out again. */
    private takeProgram(): void {
        this.module.FS.chmod(PROGRAM, 0o777)
        this.programBytes = Uint8Array.from(this.module.FS.readFile(PROGRAM) as Uint8Array)
        this.setState(BlinkState.ProgramLoaded)
    }

    private setState(state: BlinkState): void {
        if (this.state === state) return
        const oldState = this.state
        this.state = state
        observeCallbackResult(this.callbacks.stateChange(state, oldState))
        this.resolveStateWaiters(state)
    }

    private waitUntilBlocked(): Promise<BlinkState> {
        return this.waitForState(
            (state) =>
                state === BlinkState.ProgramStopped ||
                state === BlinkState.ProgramReadlinePause ||
                state === BlinkState.ProgramWaitPause ||
                state === BlinkState.ProgramPaused
        )
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
        if (!this.programBytes) return null
        try {
            return parseSourceMap(this.programBytes)
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

function withDefaultCallbacks(
    callbacks: BlinkRuntimeCallbacks = {}
): Required<BlinkRuntimeCallbacks> {
    return {
        stdout: callbacks.stdout ?? (() => undefined),
        stderr: callbacks.stderr ?? (() => undefined),
        signal: callbacks.signal ?? (() => undefined),
        stateChange: callbacks.stateChange ?? (() => undefined),
        inputRequest: callbacks.inputRequest ?? (() => undefined),
        waitRequest: callbacks.waitRequest ?? (() => undefined)
    }
}

async function awaitBlinkenlibModule(
    modulePromise: Promise<BlinkenlibModule>,
    wasmInitStarted: Promise<Promise<WebAssembly.Instance>>
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
function toCompileResult(
    diagnostics: X86CompilationDiagnostic[],
    report: string
): X86CompileResult {
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    if (errors.length === 0) return { ok: true, report, diagnostics }
    return { ok: false, errors, report, diagnostics }
}

/** Detaches a Project from the caller, who is free to mutate its own copy afterwards. */
function copyX86Project(project: X86Project): X86Project {
    const copy = (files: X86Project['files']) =>
        Object.fromEntries(
            Object.entries(files).map(([path, contents]) => [
                path,
                contents instanceof Uint8Array ? contents.slice() : contents
            ])
        )
    return {
        entry: project.entry,
        files: copy(project.files),
        ...(project.library ? { library: copy(project.library) } : {}),
        ...(project.startUnits ? { startUnits: copy(project.startUnits) } : {})
    }
}

function hostNow(clock: number): number {
    return clock === 0 || clock === 5 ? Date.now() : performance.now()
}
function hostRandom(length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i += 65536)
        crypto.getRandomValues(bytes.subarray(i, Math.min(length, i + 65536)))
    return bytes
}

function duplicateUserDefinitions(units: readonly { path: string; object: Uint8Array }[], project: X86Project): X86CompilationDiagnostic[] {
    const definitions = new Map<string, string[]>()
    for (const unit of units) {
        if (!Object.hasOwn(project.files, unit.path)) continue
        for (const symbol of readElfSymbolTable(unit.object).symbols) {
            if (symbol.binding !== 'global' || symbol.sectionIndex === 0 || !symbol.name) continue
            const paths = definitions.get(symbol.name) ?? []
            paths.push(unit.path)
            definitions.set(symbol.name, paths)
        }
    }
    return [...definitions].flatMap(([name, files]) => files.length < 2 ? [] : files.map(file => ({
        file, line: 1, severity: 'error' as const, error: `multiple definition of '${name}'`
    })))
}
