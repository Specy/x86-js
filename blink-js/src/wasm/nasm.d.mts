import type { EmscriptenFS } from '../wasm-types'

/**
 * NASM 3.00 built as its own WebAssembly module by ../../compile_wasm_nasm.sh,
 * rather than as the x86-64 ELF blink interprets. It assembles the same source
 * to a byte-identical object file, DWARF included, in single-digit milliseconds
 * instead of the ~1.2s of startup plus ~14ms per line that interpreting the ELF
 * costs.
 *
 * The module has no run loop of its own: instantiate one, stage the sources in
 * `FS`, call `callMain` once, read the object back out. NASM keeps global state
 * and does not reset between runs, so an instance is good for exactly one
 * assembly - instantiating a fresh one costs about 5ms.
 */

export type NasmModuleOptions = {
    /** Always pass true: main() runs when the host calls `callMain`, not on instantiation. */
    noInitialRun?: boolean
    /** Receives NASM's stdout, one line at a time, without its newline. */
    print?: (line: string) => void
    /** Receives NASM's diagnostics, one line at a time, without its newline. */
    printErr?: (line: string) => void
    instantiateWasm?: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
    ) => void
}

export type NasmFS = EmscriptenFS & {
    analyzePath(path: string): { exists: boolean }
}

export type NasmModule = {
    FS: NasmFS
    /**
     * Runs NASM over the staged files and returns its exit status: 0 when the
     * object file was written, 1 for anything from a syntax error to a bad
     * argument. Every NASM exit path returns rather than calling exit(), so no
     * `ExitStatus` is thrown for a build that merely failed.
     *
     * Emscripten prepends argv[0] to the array it is given **in place**, so
     * hand it a copy of any array the caller intends to reuse.
     */
    callMain(args: string[]): number
}

export default function createNasm(options?: NasmModuleOptions): Promise<NasmModule>
