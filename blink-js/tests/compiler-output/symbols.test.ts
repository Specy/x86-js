// The symbol summary and determinism oracles (milestone 1): what a translation says its object
// defines, leaves common, needs from elsewhere and runs as constructors is what NASM's object of
// it holds, read with the ELF symbol-table reader; and translating the same input twice gives the
// same result, byte for byte. Both sides here are the translator's own output, so this checks the
// summary against the object, not the object against GCC's intent: the GNU comparison
// (gnu-reference.test.ts) checks each name's binding, section and constructor order against GNU
// as's build of the same input.
import { describe, expect, it } from 'vitest'
import {
    ELF_SECTION_COMMON,
    ELF_SECTION_UNDEFINED,
    readElfSectionBytes,
    readElfSymbolTable,
    type ElfSymbolTable,
} from '../../src/elf-symbols'
import { nasmWasmAssembler } from '../../src/wasm-assembler'
import { caseInput, generatedPath, loadCorpus, translate, translateOrThrow, type CorpusCase } from './helpers'

const corpus = loadCorpus()
const translatable = corpus
    .filter((entry) => entry.outcome.kind !== 'translation-error')
    .map((entry) => [entry.case, entry] as const)

const SHT_RELA = 4
const RELA_ENTRY_SIZE = 24
const byName = <T extends { name: string }>(left: T, right: T) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0

/** The Generated assembly of a case assembled on its own, as NASM's object. */
async function assemble(entry: CorpusCase, text: string): Promise<{ object: Uint8Array; report: string }> {
    const path = generatedPath(entry.sourcePath)
    const result = await nasmWasmAssembler.assemble({ entry: path, files: { [path]: text } })
    if (!result.object) throw new Error(`NASM failed:\n${result.stderr}`)
    return { object: result.object, report: result.stdout + result.stderr }
}

/**
 * The functions `.init_array` points at, in order, as the names that can stand for each entry:
 * NASM relocates an entry against a local function through its section symbol plus the function's
 * offset, so every symbol at that offset is a candidate.
 */
function initArrayTargets(object: Uint8Array, table: ElfSymbolTable): string[][] {
    const initArray = table.sections.find((section) => section.name === '.init_array')
    if (!initArray) return []
    const relocations = table.sections.find((section) => section.type === SHT_RELA && section.info === initArray.index)
    if (!relocations) throw new Error('.init_array has no relocations')
    const bytes = readElfSectionBytes(object, relocations)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const entries: { offset: bigint; names: string[] }[] = []
    for (let offset = 0; offset + RELA_ENTRY_SIZE <= bytes.length; offset += RELA_ENTRY_SIZE) {
        const target = table.symbols[Number(view.getBigUint64(offset + 8, true) >> 32n)]!
        const addend = view.getBigInt64(offset + 16, true)
        const names =
            target.type === 'section'
                ? table.symbols
                      .filter(
                          (symbol) =>
                              symbol.section === target.section &&
                              symbol.type !== 'section' &&
                              symbol.value === BigInt(addend),
                      )
                      .map((symbol) => symbol.name)
                : addend === 0n
                  ? [target.name]
                  : []
        entries.push({ offset: view.getBigUint64(offset, true), names })
    }
    expect(initArray.size).toBe(entries.length * 8)
    return entries.sort((left, right) => (left.offset < right.offset ? -1 : 1)).map((entry) => entry.names)
}

describe.each(translatable)('%s', (_, entry) => {
    it("summarizes the global, weak, common and undefined symbols of NASM's object", async () => {
        const translation = translateOrThrow(caseInput(entry))
        const { object, report } = await assemble(entry, translation.text)
        // NASM said nothing: no warnings.
        expect(report).toBe('')
        const table = readElfSymbolTable(object)
        const visible = table.symbols.filter((symbol) => symbol.index > 0 && symbol.binding !== 'local')

        const defined = visible
            .filter((symbol) => symbol.section !== null)
            .map(({ name, binding }) => ({ name, binding }))
        const common = visible
            .filter((symbol) => symbol.sectionIndex === ELF_SECTION_COMMON)
            .map(({ name }) => ({ name }))
        const external = visible
            .filter((symbol) => symbol.sectionIndex === ELF_SECTION_UNDEFINED)
            .map(({ name, binding }) => ({ name, weak: binding === 'weak' }))
        // Nothing else, such as an absolute symbol, is visible outside the object.
        expect(defined.length + common.length + external.length).toBe(visible.length)
        const { symbols } = translation
        expect(symbols.defined.map(({ name, binding }) => ({ name, binding })).sort(byName)).toEqual(
            defined.sort(byName),
        )
        expect(symbols.common.map(({ name }) => ({ name })).sort(byName)).toEqual(common.sort(byName))
        expect(symbols.external.map(({ name, weak }) => ({ name, weak })).sort(byName)).toEqual(external.sort(byName))

        const targets = initArrayTargets(object, table)
        expect(symbols.constructors).toHaveLength(targets.length)
        symbols.constructors.forEach(({ name }, index) => expect(targets[index]).toContain(name))
    })

    it('spells each summarized symbol as the output declares it', () => {
        const translation = translateOrThrow(caseInput(entry))
        const lines = new Set(translation.lines.map((line) => line.text.trim()))
        const { defined, common, external, constructors } = translation.symbols
        for (const symbol of [...defined, ...common, ...external, ...constructors]) {
            expect([symbol.name, `$${symbol.name}`]).toContain(symbol.nasmName)
        }
        for (const { nasmName, binding } of defined)
            expect(lines).toContain(`global ${nasmName}${binding === 'weak' ? ':weak' : ''}`)
        for (const { nasmName, weak } of external) expect(lines).toContain(`extern ${nasmName}${weak ? ':weak' : ''}`)
        for (const { nasmName } of common)
            expect([...lines].some((line) => line.startsWith(`common ${nasmName} `))).toBe(true)
        for (const { nasmName } of constructors) expect(lines).toContain(`dq ${nasmName}`)
    })
})

describe.each(corpus.map((entry) => [entry.case, entry] as const))('%s', (_, entry) => {
    it('translates the same twice, byte for byte', () => {
        const input = caseInput(entry)
        const first = translate(input)
        const second = translate(input)
        expect(second).toEqual(first)
        if (first.ok && second.ok) expect(second.text).toBe(first.text)
    })
})
