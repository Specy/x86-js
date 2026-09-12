import createNasm from './wasm/nasm.mjs'
import { selectX86Source, stageX86Project } from './project'
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
     * The objects to link, Entry first. Empty when any translation unit failed:
     * a partial link would report missing symbols that are only missing because
     * the File defining them is the one that did not assemble.
     */
    units: WasmAssemblyUnit[]
    /** The Entry's object, or null when the assembly failed. */
    object: Uint8Array | null
}

const OBJECT_PATH = '/program.o'

/**
 * `-g -F dwarf` is what makes the source map possible: the debugger reads
 * `.debug_line` out of the linked executable to map an address back to the line
 * it was written on. The working directory `selectX86Source` selects is what
 * lets NASM resolve `%include` itself.
 */
const NASM_ARGS = ['-g', '-F', 'dwarf', '-felf64']

async function createNasmModule(): Promise<{ module: NasmModule; stdout: () => string; stderr: () => string }> {
    let stdout = ''
    let stderr = ''
    const module = await createNasm({
        noInitialRun: true,
        print: (line) => {
            stdout += `${line}\n`
        },
        printErr: (line) => {
            stderr += `${line}\n`
        },
    })
    return { module, stdout: () => stdout, stderr: () => stderr }
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

export const nasmWasmAssembler: WasmAssembler = {
    async assemble(project: X86Project): Promise<WasmAssemblyResult> {
        const candidates = x86TranslationUnitCandidates(project)
        const included = await scanIncludedFiles(project, candidates)
        const units = candidates.filter((path) => path === project.entry || !included.has(path))

        let stdout = ''
        let stderr = ''
        let status = 0
        const assembled: WasmAssemblyUnit[] = []

        for (const path of units) {
            const { module, stdout: readStdout, stderr: readStderr } = await createNasmModule()
            stageX86Project(module.FS, project)
            const source = selectX86Source(module.FS, project, path)
            const unitStatus = callNasm(module, [...NASM_ARGS, source, '-o', OBJECT_PATH])
            stdout += readStdout()
            stderr += readStderr()

            // NASM writes no object at all when it fails, and an instance is never reused, so an
            // existing file can only be the one this run produced.
            const wroteObject = unitStatus === 0 && module.FS.analyzePath(OBJECT_PATH).exists
            if (!wroteObject) {
                if (status === 0) status = unitStatus === 0 ? 1 : unitStatus
                continue
            }
            assembled.push({ path, object: module.FS.readFile(OBJECT_PATH) as Uint8Array })
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
