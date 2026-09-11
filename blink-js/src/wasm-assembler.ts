import createNasm from './wasm/nasm.mjs'
import { stageX86Project } from './project'
import type { X86Project } from './types'

/**
 * An assembler that runs as its own WebAssembly module rather than as an x86-64
 * ELF interpreted by blink. Blink costs roughly 1.2s of startup plus 14ms per
 * line of source for NASM; the same work in its own module takes single-digit
 * milliseconds, and produces byte-identical output.
 *
 * The object file comes back as bytes for the caller to stage wherever the
 * linker expects it, so the linker can keep running inside blink unchanged.
 */
export interface WasmAssembler {
    assemble(project: X86Project): Promise<WasmAssemblyResult>
}

export type WasmAssemblyResult = {
    /** The assembler's exit status: 0 when it wrote an object file. */
    status: number
    /** What it wrote to stdout, verbatim. */
    stdout: string
    /** What it wrote to stderr, verbatim - the diagnostics a parser reads. */
    stderr: string
    /** The object file, or null when the assembly failed. */
    object: Uint8Array | null
}

const SOURCE_PATH = '/assembly.s'
const OBJECT_PATH = '/program.o'

/**
 * `-g -F dwarf` is what makes the source map possible: the debugger reads
 * `.debug_line` out of the linked executable to map an address back to the line
 * it was written on. The paths match what `stageX86Project` writes, and the
 * working directory it selects is what lets NASM resolve `%include` itself.
 */
const NASM_ARGS = ['-g', '-F', 'dwarf', '-felf64', SOURCE_PATH, '-o', OBJECT_PATH]

export const nasmWasmAssembler: WasmAssembler = {
    async assemble(project: X86Project): Promise<WasmAssemblyResult> {
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

        stageX86Project(module.FS, project)

        // Emscripten's Node path sets `process.exitCode` from the status the
        // module exits with, so an assembly that failed would leave the host
        // process exiting non-zero for a reason of its own. NASM's status is a
        // value this function returns, never the host's to inherit.
        const host = (globalThis as { process?: { exitCode?: number | string | undefined } }).process
        const hostExitCode = host?.exitCode
        const status = module.callMain([...NASM_ARGS])
        if (host) host.exitCode = hostExitCode

        // NASM writes no object at all when it fails, and an instance is never
        // reused, so an existing file can only be the one this run produced.
        const wroteObject = status === 0 && module.FS.analyzePath(OBJECT_PATH).exists
        const object = wroteObject ? (module.FS.readFile(OBJECT_PATH) as Uint8Array) : null

        return { status, stdout, stderr, object }
    },
}
