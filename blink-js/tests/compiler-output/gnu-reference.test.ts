// The GNU as comparison (milestone 1, gate 1): each translated corpus program against the GNU as
// build of the same compiler output, made at capture time and stored with the case, so CI loads
// it with `loadElf` and never runs GNU as. Every name GCC's output defines must have the same
// binding and section kind in both, and every function the alignment the input asks for; data
// symbols must hold the same bytes over their exact lengths, at the alignment the input asks for;
// `.init_array` must run the same constructors in the same order; and stepping both builds in Blink
// must visit the same input lines with the same general, SSE and x87 registers and flags, leaving
// the same bytes in every data symbol at exit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readElfSymbolTable } from '../../src/elf-symbols'
import { createX86Emulator, type X86Emulator } from '../../src/x86-emulator'
import {
    compareData,
    compareInitArray,
    compareSymbols,
    compareTraces,
    dataSymbols,
    instructionShape,
    prepareComparison,
    type Comparison,
} from './gnu-comparison'
import type { TranslatedLine } from '../../src/compiler-output'
import { caseInput, loadCorpus, runInBlink, translateOrThrow, type CorpusCase, type Translation } from './helpers'

const corpus = loadCorpus()
const compared = corpus.filter((entry) => entry.outcome.kind === 'exit' && entry.reference?.status === 'built')

let translatedEmulator: X86Emulator
let referenceEmulator: X86Emulator

beforeAll(async () => {
    translatedEmulator = await createX86Emulator()
    referenceEmulator = await createX86Emulator()
})

afterAll(() => {
    translatedEmulator?.dispose()
    referenceEmulator?.dispose()
})

const comparisons = new Map<string, Promise<Comparison>>()

/** Translates and builds a case once, for all of its tests. */
function comparison(entry: CorpusCase): Promise<Comparison> {
    let prepared = comparisons.get(entry.case)
    if (!prepared) {
        prepared = prepareComparison(entry, translatedEmulator)
        comparisons.set(entry.case, prepared)
    }
    return prepared
}

describe('the stored GNU references', () => {
    it('cover every runnable case but the ones GNU as cannot build', () => {
        const missing = corpus
            .filter((entry) => entry.outcome.kind === 'exit' && entry.reference?.status !== 'built')
            .map((entry) => entry.program)
        // `keywords` defines a global `si`, which GNU as rejects in GCC's own output; `callsasm` and
        // `asmcallsc` mix C and NASM, and the Core's GNU mode assembles only the Entry.
        expect(new Set(missing)).toEqual(new Set(['asmcallsc', 'callsasm', 'keywords']))
        expect(missing).toHaveLength(15)
        expect(compared).toHaveLength(156)
    })

    it('hold data symbols in most of those cases, and constructors in some', () => {
        const tables = compared.map((entry) => {
            const program = Uint8Array.from(Buffer.from(entry.reference!.elf!, 'base64'))
            return [entry, readElfSymbolTable(program)] as const
        })
        const withData = tables.filter(([entry, table]) => dataSymbols(table, caseInput(entry)).length > 0)
        const withConstructors = tables.filter(([, table]) =>
            table.sections.some((section) => section.name === '.init_array' && section.size > 0),
        )
        // The C++ class programs, `large` and `inlineasm` keep everything on the stack and in registers.
        expect(withData).toHaveLength(131)
        // `cpplocalstatic` builds its static on the first call instead.
        expect(new Set(withConstructors.map(([entry]) => entry.program))).toEqual(
            new Set(['ctor', 'ctororder', 'cppunique', 'cppvague']),
        )
    })
})

describe.each(
    corpus.filter((entry) => entry.referenceOutcome).map((entry) => [entry.case, entry] as const),
)('%s, meant to fail translation', (_, entry) => {
    const outcome = entry.referenceOutcome!
    const value = outcome.kind === 'exit' ? outcome.value : null

    it(`keeps a GNU as reference that shows the program runs as written, exiting with ${value}`, async () => {
        expect(entry.outcome.kind).toBe('translation-error')
        expect(outcome.kind).toBe('exit')
        expect(entry.reference?.status).toBe('built')
        expect(entry.reference?.native?.status).toBe(value! & 255)
        referenceEmulator.loadElf(Uint8Array.from(Buffer.from(entry.reference!.elf!, 'base64')))
        expect(await runInBlink(referenceEmulator)).toBe(value! & 255)
    })
})

describe.each(compared.map((entry) => [entry.case, entry] as const))('%s', (_, entry) => {
    it("gives every name GCC defines GNU as's binding and section kind, and functions their alignment", async () => {
        expect(compareSymbols(await comparison(entry))).toEqual([])
    })

    it('holds the same bytes in every data symbol, as long and as aligned as the input says', async () => {
        expect(compareData(await comparison(entry))).toEqual([])
    })

    it('runs the same constructors in the same order', async () => {
        expect(compareInitArray(await comparison(entry))).toEqual([])
    })

    it('steps through the same input lines with the same registers, flags and data', async () => {
        const prepared = await comparison(entry)
        comparisons.delete(entry.case)
        const trace = await compareTraces(prepared, translatedEmulator, referenceEmulator)
        // The status a parent sees: `main`'s value, its low eight bits.
        const intended = entry.outcome.kind === 'exit' ? entry.outcome.value & 255 : null
        expect(trace.exitCodes).toEqual([intended, intended])
        expect(trace.instructions).toBeGreaterThan(0)
    })
})

const named = (name: string) => corpus.find((entry) => entry.case === name)!

/** The translation of a case with `edit` applied to its lines, which keep their input lines. */
function edited(entry: CorpusCase, edit: (lines: TranslatedLine[], input: readonly string[]) => TranslatedLine[]) {
    const translation = translateOrThrow(caseInput(entry))
    const lines = edit([...translation.lines], caseInput(entry))
    return { ...translation, lines, text: `${lines.map((line) => line.text).join('\n')}\n` } satisfies Translation
}

/** The one translated line that a statement of the input line matching `pattern` became. */
function translatedLine(lines: readonly TranslatedLine[], input: readonly string[], pattern: RegExp, after = 0) {
    const at = input.findIndex((text) => pattern.test(text))
    expect(at, `${pattern}`).toBeGreaterThanOrEqual(0)
    const found = lines.filter((line) => line.inputLine === at + after && !line.synthesized)
    expect(found).toHaveLength(1)
    return found[0]!
}

// Escapes an independent review demonstrated against the comparison when it accepted any all-zero
// tail after a label without a size: each translation, mutated so, must fail it.
describe('the data comparison', () => {
    it("finds a string that lost its terminator (formatter-O2's `.LC4`, `ok`)", async () => {
        const entry = named('formatter-O2')
        const mutated = edited(entry, (lines, input) => {
            const string = translatedLine(lines, input, /^\s*\.string\s+"ok"$/)
            expect(string.text).toMatch(/, 0$/)
            return lines.map((line) => (line === string ? { ...line, text: line.text.replace(/, 0$/, '') } : line))
        })
        const failures = compareData(await prepareComparison(entry, translatedEmulator, mutated))
        expect(failures).toEqual(['.LC4: 3 bytes, but the translated LC4 reaches only 2'])
    })

    it("finds a constant that lost its last word (x87ops-O0's `.LC3`, a `long double` in 16 bytes)", async () => {
        const entry = named('x87ops-O0')
        const mutated = edited(entry, (lines, input) => {
            // `.LC3:` and its four `.long`s; the last is the padding's zero.
            const padding = translatedLine(lines, input, /^\.LC3:$/, 4)
            return lines.filter((line) => line !== padding)
        })
        const failures = compareData(await prepareComparison(entry, translatedEmulator, mutated))
        expect(failures).toEqual(['.LC3: 16 bytes, but the translated LC3 reaches only 12'])
    })
})

describe('the trace comparison', () => {
    it("reads each instruction's mnemonic and the register its first operand names", () => {
        expect(instructionShape('        add     rcx, 16')).toEqual({ mnemonic: 'add', first: 'rcx' })
        expect(instructionShape('        test    r8d, r8d')).toEqual({ mnemonic: 'test', first: 'r8' })
        expect(instructionShape('        sete    al')).toEqual({ mnemonic: 'sete', first: 'rax' })
        expect(instructionShape('        cmp     BYTE PTR [rdi], 0')).toEqual({ mnemonic: 'cmp', first: null })
        expect(instructionShape('        rep stosq')).toEqual({ mnemonic: 'stosq', first: null })
    })

    // PF and AF may differ where an instruction's result is an address the two layouts place apart
    // (statics-O1's `add rcx, 16` walks `grid`, 0x20 bytes apart in the two builds); anywhere else
    // they must still match.
    it("finds a parity flag that differs on a value (broad-O1's loop bound, `cmp rax, 64` made 65)", async () => {
        const entry = named('broad-O1')
        const mutated = edited(entry, (lines, input) => {
            const bound = translatedLine(lines, input, /^\s*cmp\s+rax, 64$/)
            return lines.map((line) => (line === bound ? { ...line, text: line.text.replace(/64$/, '65') } : line))
        })
        const comparison = await prepareComparison(entry, translatedEmulator, mutated)
        await expect(compareTraces(comparison, translatedEmulator, referenceEmulator)).rejects.toThrow(
            /^after input line 130 \(cmp\s+rax, 64\), instruction \d+: PF is 1, not 0$/,
        )
    })

    // rcx after a `syscall` is compared as the address after it in each build, not as a place the
    // two share; a `syscall` that never ran must still show.
    it("finds a `syscall` made a two-byte NOP (simwrite-O2's out-of-line `sim_write`)", async () => {
        const entry = named('simwrite-O2')
        const mutated = edited(entry, (lines, input) => {
            const syscall = translatedLine(lines, input, /^\s*syscall$/)
            return lines.map((line) => (line === syscall ? { ...line, text: '    xchg ax, ax' } : line))
        })
        const comparison = await prepareComparison(entry, translatedEmulator, mutated)
        await expect(compareTraces(comparison, translatedEmulator, referenceEmulator)).rejects.toThrow(
            /^after input line \d+ \(syscall\), instruction \d+: rcx is 0x[0-9a-f]+ and 0x[0-9a-f]+, not the addresses after the two syscalls;/,
        )
    })
})
