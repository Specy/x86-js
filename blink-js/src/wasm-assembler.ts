import createNasm from './wasm/nasm.mjs'
import { selectX86Source, stageX86Project } from './project'
import { readResourceBytes } from './resources'
import { parseDependencyList, x86TranslationUnitCandidates } from './translation-units'
import type { X86Project } from './types'
import type { NasmModule } from './wasm/nasm.d.mts'

/**
 * An assembler that runs as its own WebAssembly module rather than as an x86-64
 * ELF interpreted by blink. Blink costs roughly 1.2s of startup plus 14ms per
 * line of source for NASM; the same work in its own module takes single-digit
 * milliseconds, and produces byte-identical output.
 *
 * The object files come back as bytes for the caller to stage wherever the
 * linker expects them, so the linker can keep running inside blink unchanged.
 */
export interface WasmAssembler {
    assemble(project: X86Project): Promise<WasmAssemblyResult>
}

/** One translation unit's object, and the Project File it was assembled from. */
export type WasmAssemblyUnit = {
    path: string
    object: Uint8Array
}

export type WasmAssemblyResult = {
    /** The assembler's exit status: 0 when every translation unit assembled. */
    status: number
    /** What it wrote to stdout, verbatim. */
    stdout: string
    /** What it wrote to stderr, verbatim - the diagnostics a parser reads. */
    stderr: string
    /**
     * The objects to link: the Entry's, then the library's units and then the
     * Project's other units, each group by path, which is the order the archive
     * holds them in. Empty when any translation unit failed: a partial link would
     * report missing symbols that are only missing because the File defining them
     * is the one that did not assemble.
     */
    units: WasmAssemblyUnit[]
    /** The Entry's object, or null when the assembly failed. */
    object: Uint8Array | null
}

const OBJECT_PATH = '/program.o'
const DEPENDENCIES_PATH = '/unit.d'

/**
 * `-g -F dwarf` is what makes the source map possible: the debugger reads
 * `.debug_line` out of the linked executable to map an address back to the line
 * it was written on. The working directory `selectX86Source` selects is what
 * lets NASM resolve `%include` itself.
 */
const NASM_ARGS = ['-g', '-F', 'dwarf', '-felf64']

const NASM_WASM = new URL('./wasm/nasm.wasm', import.meta.url)
let compiledNasm: Promise<WebAssembly.Module | null> | null = null

/**
 * `nasm.wasm` compiled once for every instance. Left to itself, Emscripten compiles the 1.2MB
 * module again for each instance it creates, which for a Project with a Runtime library, hundreds
 * of units, cost more than assembling them. Null when the module cannot be loaded from here, and
 * each instance then loads its own as Emscripten would.
 */
function compiledNasmModule(): Promise<WebAssembly.Module | null> {
    compiledNasm ??= readResourceBytes(NASM_WASM)
        .then((bytes) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>))
        .catch(() => null)
    return compiledNasm
}

async function createNasmModule(): Promise<{ module: NasmModule; stdout: () => string; stderr: () => string }> {
    let stdout = ''
    let stderr = ''
    const compiled = await compiledNasmModule()
    // Emscripten waits on `receiveInstance` forever, so a failed instantiation is raced in instead.
    let failInstantiation: (error: unknown) => void = () => undefined
    const instantiationFailed = new Promise<never>((_, reject) => {
        failInstantiation = reject
    })
    const module = await Promise.race([
        createNasm({
            noInitialRun: true,
            print: (line) => {
                stdout += `${line}\n`
            },
            printErr: (line) => {
                stderr += `${line}\n`
            },
            ...(compiled
                ? {
                      instantiateWasm: (imports, receiveInstance) => {
                          WebAssembly.instantiate(compiled, imports).then(
                              (instance) => receiveInstance(instance, compiled),
                              failInstantiation,
                          )
                      },
                  }
                : {}),
        }),
        instantiationFailed,
    ])
    return { module, stdout: () => stdout, stderr: () => stderr }
}

type LibraryObject = { object: Uint8Array; stdout: string; stderr: string; size: number }

/**
 * Library and start units already assembled, by path and source. A Runtime library is the same
 * hundreds of units on every build and every check, and assembling them was most of the work. A
 * unit is kept only when NASM read nothing but the unit itself, so its object cannot depend on a
 * File of the Project, and only when it does not ask for the date or time, the one other input an
 * assembly has. A Map iterates in insertion order, which makes it least recently used first.
 */
const libraryObjects = new Map<string, LibraryObject>()
const LIBRARY_OBJECT_BUDGET = 64 * 1024 * 1024
let libraryObjectBytes = 0

/** NASM's `__?DATE?__`, `__?TIME_NUM?__`, `__?UTC_DATE?__`, `__?POSIX_TIME?__`, and their old spellings. */
const CLOCK_MACRO = /__\??(?:UTC_)?(?:DATE|TIME)|__\??POSIX_TIME/

function libraryObjectKey(path: string, source: string): string {
    return `${path}\0${source}`
}

function takeLibraryObject(key: string): LibraryObject | undefined {
    const cached = libraryObjects.get(key)
    if (!cached) return undefined
    libraryObjects.delete(key)
    libraryObjects.set(key, cached)
    return cached
}

function keepLibraryObject(key: string, unit: Omit<LibraryObject, 'size'>): void {
    const size = unit.object.byteLength + key.length + unit.stdout.length + unit.stderr.length
    if (size > LIBRARY_OBJECT_BUDGET) return
    libraryObjects.set(key, { ...unit, size })
    libraryObjectBytes += size
    for (const [oldest, cached] of libraryObjects) {
        if (libraryObjectBytes <= LIBRARY_OBJECT_BUDGET) break
        libraryObjects.delete(oldest)
        libraryObjectBytes -= cached.size
    }
}

/**
 * Emscripten's Node path sets `process.exitCode` from the status the module
 * exits with, so an assembly that failed would leave the host process exiting
 * non-zero for a reason of its own. NASM's status belongs to the caller of this
 * function, never to the host.
 */
function callNasm(module: NasmModule, args: string[]): number {
    const host = (globalThis as { process?: { exitCode?: number | string | undefined } }).process
    const hostExitCode = host?.exitCode
    const status = module.callMain(args)
    if (host) host.exitCode = hostExitCode
    return status
}

/**
 * Which Files the Project's candidate translation units `%include`, so that a fragment is
 * assembled as part of whatever includes it and never a second time on its own. Every candidate
 * is scanned before any of them is treated as a unit, because a fragment can be included by a
 * File that sorts after it.
 */
async function scanIncludedFiles(project: X86Project, candidates: readonly string[]): Promise<Set<string>> {
    const included = new Set<string>()
    if (candidates.length < 2) return included

    for (const path of candidates) {
        const { module, stdout } = await createNasmModule()
        stageX86Project(module.FS, project)
        const source = selectX86Source(module.FS, project, path)
        // `-M` preprocesses and writes the dependency list without assembling, so a fragment that
        // cannot stand on its own costs nothing here; its diagnostics are deliberately discarded.
        callNasm(module, ['-M', ...NASM_ARGS, source, '-o', OBJECT_PATH])
        for (const dependency of parseDependencyList(stdout(), project)) {
            if (dependency !== path) included.add(dependency)
        }
    }
    return included
}

/**
 * The Project as a library unit's assembly sees it: its Files, and the unit among them at its
 * library path, so that the unit is staged and selected exactly as a File would be and its DWARF
 * names it by that path. Only its own assembly stages it, which is what keeps the Project's Files
 * from `%include`ing it.
 */
function withLibraryUnit(project: X86Project, path: string): X86Project {
    return { entry: project.entry, files: { ...project.files, [path]: (project.startUnits?.[path] ?? project.library?.[path])! } }
}

export const nasmWasmAssembler: WasmAssembler = {
    async assemble(project: X86Project): Promise<WasmAssemblyResult> {
        const candidates = x86TranslationUnitCandidates(project)
        const included = await scanIncludedFiles(project, candidates)
        const [entry, ...others] = candidates.filter((path) => path === project.entry || !included.has(path))
        const library = new Set(Object.keys({ ...project.startUnits, ...project.library }))
        const units = [entry!, ...[...library].sort(), ...others]

        let stdout = ''
        let stderr = ''
        let status = 0
        const assembled: WasmAssemblyUnit[] = []

        for (const path of units) {
            const isLibrary = library.has(path)
            const unitSource = isLibrary ? (project.startUnits?.[path] ?? project.library?.[path]) : undefined
            // Only a unit written as text is kept: a library given as bytes is assembled every time.
            const key = typeof unitSource === 'string' ? libraryObjectKey(path, unitSource) : undefined
            const cached = key === undefined ? undefined : takeLibraryObject(key)
            if (cached) {
                stdout += cached.stdout
                stderr += cached.stderr
                assembled.push({ path, object: cached.object.slice() })
                continue
            }

            const { module, stdout: readStdout, stderr: readStderr } = await createNasmModule()
            const staged = isLibrary ? withLibraryUnit(project, path) : project
            stageX86Project(module.FS, staged)
            const source = selectX86Source(module.FS, staged, path)
            const dependencies = key === undefined ? [] : ['-MD', DEPENDENCIES_PATH]
            const unitStatus = callNasm(module, [...NASM_ARGS, ...dependencies, source, '-o', OBJECT_PATH])
            const unitStdout = readStdout()
            const unitStderr = readStderr()
            stdout += unitStdout
            stderr += unitStderr

            // NASM writes no object at all when it fails, and an instance is never reused, so an
            // existing file can only be the one this run produced.
            const wroteObject = unitStatus === 0 && module.FS.analyzePath(OBJECT_PATH).exists
            if (!wroteObject) {
                if (status === 0) status = unitStatus === 0 ? 1 : unitStatus
                continue
            }
            const object = module.FS.readFile(OBJECT_PATH) as Uint8Array
            assembled.push({ path, object })
            if (key !== undefined && !CLOCK_MACRO.test(unitSource as string) && module.FS.analyzePath(DEPENDENCIES_PATH).exists) {
                const read = parseDependencyList(module.FS.readFile(DEPENDENCIES_PATH, { encoding: 'utf8' }) as string, staged)
                if (read.length === 1) keepLibraryObject(key, { object: object.slice(), stdout: unitStdout, stderr: unitStderr })
            }
        }

        const ok = status === 0 && assembled.length === units.length
        return {
            status,
            stdout,
            stderr,
            units: ok ? assembled : [],
            object: ok ? (assembled[0]?.object ?? null) : null,
        }
    },
}
