// The corpus oracle (milestone 1): every stored `gcc-intel-v1` case reaches its intended outcome.
// A runnable case, built beside the start unit and its NASM Files, returns its value in Blink and
// its low byte natively; a link failure names the symbols it should, on the input lines the GNU as
// reference's link named; a negative case reports its code on the offending lines, with no output;
// and nothing NASM assembles warns.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../../src/x86-emulator'
import {
    caseInput,
    errors,
    linkedProgram,
    loadCorpus,
    loadManifest,
    NATIVE,
    removeNativeScratch,
    runInBlink,
    runNatively,
    translate,
    translatedProject,
    translateOrThrow,
    warnings,
    type CorpusCase,
} from './helpers'

const manifest = loadManifest()
const corpus = loadCorpus()
const byKind = <K extends CorpusCase['outcome']['kind']>(kind: K) =>
    corpus
        .filter(
            (entry): entry is CorpusCase & { outcome: Extract<CorpusCase['outcome'], { kind: K }> } =>
                entry.outcome.kind === kind,
        )
        .map((entry) => [entry.case, entry] as const)

/**
 * The input lines each negative program's error belongs on: what the profile cannot translate.
 * Every such line must carry the program's code, and no other line may.
 */
const OFFENDING_LINES: Readonly<Record<string, RegExp>> = {
    inlineasm: /^#APP$/,
    tls: /^\s*\.section\s+\.t(?:bss|data)\b/,
    ifunc: /^\s*\.type\s+\S+,\s*@gnu_indirect_function$/,
    ctorpriority: /^\s*\.section\s+\.init_array\.\d+/,
    registername: /^\s*(?:call|jmp)\s+si$/,
    cfprotection: /^\s*notrack\s+jmp\b/,
}

let emulator: X86Emulator

beforeAll(async () => {
    emulator = await createX86Emulator()
})

afterAll(() => {
    emulator?.dispose()
    removeNativeScratch()
})

describe('the stored corpus', () => {
    it('holds every case of the manifest, each with the outcome the manifest intends', () => {
        const intended = manifest.programs
            .flatMap((program) =>
                (program.optimizations ?? manifest.optimizations).map((level) => ({
                    case: `${program.name}-O${level}`,
                    outcome: program.outcomes?.[level] ?? program.outcome,
                    referenceOutcome: program.referenceOutcome,
                    files: program.files,
                })),
            )
            .sort((left, right) => left.case.localeCompare(right.case))
        const stored = corpus
            .map((entry) => ({
                case: entry.case,
                outcome: entry.outcome,
                referenceOutcome: entry.referenceOutcome,
                files: entry.files,
            }))
            .sort((left, right) => left.case.localeCompare(right.case))
        expect(stored).toEqual(intended)
        expect(corpus.filter((entry) => entry.response.code !== 0).map((entry) => entry.case)).toEqual([])
    })

    it('has 146 runnable cases, 15 link failures and 26 translation errors', () => {
        expect([byKind('exit').length, byKind('link-failure').length, byKind('translation-error').length]).toEqual([
            146, 15, 26,
        ])
        expect(Object.keys(OFFENDING_LINES).sort()).toEqual(
            [...new Set(byKind('translation-error').map(([, entry]) => entry.program))].sort(),
        )
    })
})

describe.each(byKind('translation-error'))('%s', (_, entry) => {
    it(`is rejected with ${entry.outcome.code} on the offending lines, with no output`, () => {
        const input = caseInput(entry)
        const result = translate(input)
        expect(result.ok).toBe(false)
        expect(Object.keys(result).sort()).toEqual(['diagnostics', 'ok'])
        const reported = result.diagnostics
            .filter((diagnostic) => diagnostic.severity === 'error' && diagnostic.code === entry.outcome.code)
            .map((diagnostic) => diagnostic.inputLine)
        const offending = input.flatMap((text, index) => (OFFENDING_LINES[entry.program]!.test(text) ? [index] : []))
        expect(offending.length).toBeGreaterThan(0)
        expect(reported).toEqual(offending)
    })
})

/** A case translated and built once, for its Blink and native tests. */
type Built = { readonly program: Uint8Array }
const builds = new Map<string, Promise<Built>>()

function built(entry: CorpusCase): Promise<Built> {
    let build = builds.get(entry.case)
    if (!build) {
        build = buildCase(entry)
        builds.set(entry.case, build)
    }
    return build
}

async function buildCase(entry: CorpusCase): Promise<Built> {
    const translation = translateOrThrow(caseInput(entry))
    expect(translation.diagnostics).toEqual([])
    const result = await emulator.compileProject(translatedProject(entry.sourcePath, translation.text, entry.files))
    expect(warnings(result)).toEqual([])
    if (!result.ok) throw new Error(`the build failed:\n${errors(result)}`)
    return { program: linkedProgram(emulator) }
}

describe.each(byKind('exit'))('%s', (_, entry) => {
    const { value } = entry.outcome

    it(`returns ${value} in Blink`, async () => {
        const { program } = await built(entry)
        if (!NATIVE) builds.delete(entry.case)
        emulator.loadElf(program)
        expect(await runInBlink(emulator)).toBe(value)
    })

    it.skipIf(!NATIVE)(`returns ${value & 255} natively`, async () => {
        const { program } = await built(entry)
        builds.delete(entry.case)
        expect(runNatively(program, entry.case)).toBe(value & 255)
    })
})

describe.each(byKind('link-failure'))('%s', (_, entry) => {
    it(`fails to link, naming ${entry.outcome.symbols.join(', ')} where the GNU reference does`, async () => {
        const translation = translateOrThrow(caseInput(entry))
        expect(translation.diagnostics).toEqual([])
        const project = translatedProject(entry.sourcePath, translation.text, entry.files)
        const result = await emulator.compileProject(project)
        expect(result.ok).toBe(false)
        expect(warnings(result)).toEqual([])

        // Each of `ld`'s errors names an undefined symbol on a line of the Generated assembly, which
        // leads back to the input line the reference's link named for the same symbol.
        const named = result.diagnostics.map((diagnostic) => ({
            message: diagnostic.error,
            inputLine:
                diagnostic.file === project.entry ? translation.lines[diagnostic.line - 1]?.inputLine : undefined,
        }))
        const symbols = named.map(({ message }) => /^undefined reference to `(.+)'$/.exec(message)?.[1] ?? message)
        expect([...new Set(symbols)].sort()).toEqual([...entry.outcome.symbols].sort())
        const reference = entry.reference!
        expect(reference.status).toBe('link-failed')
        const byLine = (left: { message: string; inputLine?: number | null }, right: typeof left) =>
            (left.inputLine ?? -1) - (right.inputLine ?? -1) || left.message.localeCompare(right.message)
        expect(named.sort(byLine)).toEqual(
            reference.diagnostics.map(({ message, inputLine }) => ({ message, inputLine })).sort(byLine),
        )
    })
})
