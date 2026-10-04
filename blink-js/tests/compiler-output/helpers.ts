// Shared by the compiler-output oracles: the stored `gcc-intel-v1` corpus and x87 matrix, the
// start unit a translated program is built beside, and builds and native runs of what the
// translator writes. Everything here reads stored captures; nothing contacts Compiler Explorer or
// runs GNU as (gate 1 of docs/design/x86-compiler-assembly-translation-plan.md).
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
    translateCompilerOutput,
    type TranslationDiagnosticCode,
    type TranslationResult,
} from '../../src/compiler-output'
import { ELF_SECTION_FLAGS, readElfSectionBytes, readElfSymbolTable } from '../../src/elf-symbols'
import type { X86Emulator } from '../../src/x86-emulator'
import type { X86CompileResult, X86Project } from '../../src/types'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/gcc-intel-v1')

export type Outcome =
    | { readonly kind: 'exit'; readonly value: number }
    | { readonly kind: 'link-failure'; readonly symbols: readonly string[] }
    | { readonly kind: 'translation-error'; readonly code: TranslationDiagnosticCode }

/** Compiler Explorer's mapping of one output line to a source line, from its own reading of `.loc`. */
export type CompilerExplorerSource = {
    readonly file: string | null
    readonly line: number
    readonly column?: number
    readonly mainsource?: boolean
}

/**
 * What a native run of a stored executable gave at capture time: hardware's answer, which no change
 * to the package can make stale. Blink's answer is not stored, since a fix to Blink changes it; the
 * tests run the reference in Blink themselves.
 */
export type RecordedRuns = {
    readonly native?: {
        readonly status?: number
        readonly signal?: string
        readonly error?: string
        readonly timedOut?: boolean
    }
}

/**
 * The GNU as build of a case, made at capture time from GCC's output prepared for GNU as with the
 * same start as {@link START_UNIT} in front of it.
 */
export type GnuReference = RecordedRuns & {
    readonly status: 'built' | 'link-failed' | 'assembly-failed'
    /** The prepared file, and the input line each of its lines came from (null for the start). */
    readonly prepared: { readonly lines: readonly string[]; readonly inputLines: readonly (number | null)[] }
    readonly diagnostics: readonly {
        readonly severity: string
        readonly line: number
        readonly inputLine: number | null
        readonly message: string
    }[]
    readonly undefinedSymbols?: readonly string[]
    /** The linked executable, base64. */
    readonly elf?: string
    /** Every instruction address of the executable's line table, with its input line (null for the start). */
    readonly instructions?: readonly (readonly [number, number | null])[]
    /** The x87 matrix only: the form's two bytes as GNU as encoded them, in hex. */
    readonly encoding?: string | null
}

export type CorpusCase = {
    readonly case: string
    readonly program: string
    readonly language: 'c' | 'cpp'
    readonly optimization: string
    readonly sourcePath: string
    readonly files: Readonly<Record<string, string>>
    readonly outcome: Outcome
    /**
     * For a case whose translation is meant to fail, what its GNU as reference does instead, built
     * and run at capture time to show the program itself works as written.
     */
    readonly referenceOutcome?: Outcome
    readonly note?: string
    readonly response: {
        readonly code: number
        readonly asm: readonly { readonly text: string; readonly source: CompilerExplorerSource | null }[]
    }
    readonly reference?: GnuReference
    readonly referenceSkipped?: string
}

export type X87Form = {
    readonly name: string
    readonly instruction: string
    readonly intended: number
    readonly intelOpcode: string
    readonly input: readonly string[]
    /** The input line of the form under test. */
    readonly formLine: number
    readonly reference: GnuReference
}

export type Manifest = {
    readonly optimizations: readonly string[]
    readonly programs: readonly {
        readonly name: string
        readonly optimizations?: readonly string[]
        readonly outcome: Outcome
        readonly outcomes?: Readonly<Record<string, Outcome>>
        readonly referenceOutcome?: Outcome
        readonly files: Readonly<Record<string, string>>
    }[]
    readonly x87Matrix: { readonly forms: readonly { readonly name: string; readonly intended: number }[] }
}

function readGzipJson<T>(path: string): T {
    return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T
}

export function loadManifest(): Manifest {
    return JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8')) as Manifest
}

/** Every stored case, by name. */
export function loadCorpus(): CorpusCase[] {
    const directory = join(FIXTURES, 'cases')
    return readdirSync(directory)
        .filter((file) => file.endsWith('.json.gz'))
        .sort()
        .map((file) => readGzipJson<CorpusCase>(join(directory, file)))
}

/** Every stored x87 form, by name. */
export function loadX87Forms(): X87Form[] {
    const directory = join(FIXTURES, 'x87')
    return readdirSync(directory)
        .filter((file) => file.endsWith('.json.gz'))
        .sort()
        .map((file) => readGzipJson<X87Form>(join(directory, file)))
}

/** GCC's output as the translator receives it: the response's lines of text. */
export function caseInput(entry: CorpusCase): string[] {
    return entry.response.asm.map((line) => line.text)
}

export function translate(input: readonly string[]): TranslationResult {
    return translateCompilerOutput(input, { profile: 'gcc-intel-v1' })
}

export type Translation = Extract<TranslationResult, { ok: true }>

/** Translates input that must translate, naming every diagnostic otherwise. */
export function translateOrThrow(input: readonly string[]): Translation {
    const result = translate(input)
    if (!result.ok) {
        const errors = result.diagnostics.map((d) => `  ${d.inputLine}: ${d.code}: ${d.message}`)
        throw new Error(`the translation failed:\n${errors.join('\n')}`)
    }
    return result
}

export const START_UNIT_PATH = 'runtime/start.asm'

/**
 * The start the translator never writes, as a Runtime library's `crt0` would: each `.init_array`
 * entry in order, with a callee-saved register as the cursor and no pushes, so the stack Linux
 * hands `_start` stays 16-byte aligned at every call; then `main`, exiting with its result. These
 * are the instructions of the GNU reference's start (`START` in scripts/capture-gcc-fixtures.mjs),
 * so both builds reach the program with the same registers and flags.
 */
export const START_UNIT = `${[
    'global _start',
    'extern main',
    'extern __init_array_start',
    'extern __init_array_end',
    'section .text',
    '_start:',
    '    mov rbx, __init_array_start',
    '.next:',
    '    cmp rbx, __init_array_end',
    '    jae .main',
    '    call [rbx]',
    '    add rbx, 8',
    '    jmp .next',
    '.main:',
    '    call main',
    '    mov edi, eax',
    '    mov eax, 60',
    '    syscall',
].join('\n')}\n`

/** Where Generated assembly lives in a Project: beside its source, as `<source>.asm`. */
export function generatedPath(sourcePath: string): string {
    return `${sourcePath}.asm`
}

/** A translated program as a Project: its Generated assembly as the Entry, the start unit and any NASM Files. */
export function translatedProject(
    sourcePath: string,
    text: string,
    files: Readonly<Record<string, string>> = {},
): X86Project {
    const entry = generatedPath(sourcePath)
    return { entry, files: { ...files, [entry]: text, [START_UNIT_PATH]: START_UNIT } }
}

export function warnings(build: X86CompileResult): string[] {
    return build.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'warning')
        .map((diagnostic) => `${diagnostic.file ?? '?'}:${diagnostic.line}: ${diagnostic.error}`)
}

export function errors(build: X86CompileResult): string {
    return build.diagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => `${diagnostic.file ?? '?'}:${diagnostic.line}: ${diagnostic.error}`)
        .join('\n')
}

/** The executable the last successful build linked. */
export function linkedProgram(emulator: X86Emulator): Uint8Array {
    return Uint8Array.from(emulator.module.FS.readFile('/program') as Uint8Array)
}

/** `length` bytes of a linked executable at `address`, from the allocated section holding them. */
export function programBytes(program: Uint8Array, address: bigint, length: number): Uint8Array {
    for (const section of readElfSymbolTable(program).sections) {
        if ((section.flags & ELF_SECTION_FLAGS.alloc) === 0n || address < section.address) continue
        const offset = Number(address - section.address)
        if (offset + length <= section.size) return readElfSectionBytes(program, section, offset, length).slice()
    }
    throw new Error(`no section of the program holds 0x${address.toString(16)}`)
}

/**
 * How many instructions a run in Blink may take. The longest corpus program runs fewer than 32,000
 * and Blink runs about ten million a second here, so a translation that loops forever fails in a
 * tenth of a second instead of running into the test's timeout.
 */
export const RUN_LIMIT = 1_000_000

/** Runs the program the emulator holds to its end and returns its full exit value. */
export async function runInBlink(emulator: X86Emulator, limit = RUN_LIMIT): Promise<number> {
    await emulator.run(limit)
    const stop = emulator.stopReason
    if (stop?.kind === 'limit') throw new Error(`the program ran more than ${limit} instructions`)
    if (stop?.kind !== 'exit')
        throw new Error(`the program stopped with ${stop?.kind ?? 'nothing'}: ${stop?.details ?? ''}`)
    return stop.exitCode
}

/** Native runs need an x86-64 Linux host; elsewhere they are skipped, visibly. */
export const NATIVE = process.platform === 'linux' && process.arch === 'x64'
const NATIVE_TIMEOUT_MS = 10_000

let nativeScratch: string | null = null

/** Runs an executable on the host and returns its exit status, which is the exit value's low byte. */
export function runNatively(program: Uint8Array, name: string): number {
    nativeScratch ??= mkdtempSync(join(tmpdir(), 'compiler-output-'))
    const path = join(nativeScratch, `${name.replace(/[^\w.-]/g, '_')}.elf`)
    writeFileSync(path, program)
    chmodSync(path, 0o755)
    try {
        const run = spawnSync(path, [], { timeout: NATIVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
        if (run.error) throw run.error
        if (run.status === null) throw new Error(`the program was killed by ${run.signal}`)
        return run.status
    } finally {
        rmSync(path, { force: true })
    }
}

/** For `afterAll`: removes what {@link runNatively} wrote. */
export function removeNativeScratch(): void {
    if (nativeScratch) rmSync(nativeScratch, { recursive: true, force: true })
    nativeScratch = null
}
