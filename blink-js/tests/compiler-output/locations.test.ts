// The locations oracle (milestone 1, gate 3): the translator reads locations from GCC's own `.file`
// and `.loc`, and Compiler Explorer's `source` field, stored with each case, is the oracle. Every
// translated instruction must carry the location Compiler Explorer gives its input line, once both
// file names are Project paths, and every line Compiler Explorer leaves unmapped must carry none.
import { describe, expect, it } from 'vitest'
import type { CompilerLocation } from '../../src/compiler-output'
import { caseInput, loadCorpus, translateOrThrow, type CompilerExplorerSource, type CorpusCase } from './helpers'

const translatable = loadCorpus()
    .filter((entry) => entry.outcome.kind !== 'translation-error')
    .map((entry) => [entry.case, entry] as const)

/**
 * A compiler's file name as the Project path the editor maps it to (`projectPath` in the editor's
 * src/lib/sourceCompilation/compilerExplorer.ts): the main source for no name or Compiler
 * Explorer's own `example.c`, and otherwise the name without Compiler Explorer's `/app/` directory.
 */
function projectPath(file: string | null | undefined, sourcePath: string, mainsource = false): string {
    if (file === undefined || file === null || file === '' || mainsource) return sourcePath
    if (/^\/?(?:app\/)?example\.(?:c|cpp|cc|cxx)$/.test(file)) return sourcePath
    return file.replace(/^\/app\//, '').replace(/^\.\//, '')
}

type Place = { file: string; line: number; column?: number }

function fromCompilerExplorer(source: CompilerExplorerSource | null, entry: CorpusCase): Place | null {
    if (!source) return null
    const place: Place = { file: projectPath(source.file, entry.sourcePath, source.mainsource), line: source.line }
    if (typeof source.column === 'number') place.column = source.column
    return place
}

function fromTranslation(location: CompilerLocation | null, entry: CorpusCase, expected: Place | null): Place | null {
    if (!location) return null
    const place: Place = { file: projectPath(location.file, entry.sourcePath), line: location.line }
    if (expected?.column !== undefined) place.column = location.column
    return place
}

describe.each(translatable)('%s', (_, entry) => {
    it("gives each instruction Compiler Explorer's location for its input line, and nothing else one", () => {
        const translation = translateOrThrow(caseInput(entry))
        const { asm } = entry.response
        const wrong: string[] = []
        const carried = new Set<number>()
        for (const [index, line] of translation.lines.entries()) {
            // Header and synthesized lines translate no statement of their own, so they have no place.
            const expected =
                line.inputLine === null || line.synthesized
                    ? null
                    : fromCompilerExplorer(asm[line.inputLine]!.source, entry)
            const actual = fromTranslation(line.location, entry, expected)
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                wrong.push(
                    `output line ${index} (${line.text.trim()}): ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}`,
                )
            }
            if (line.inputLine !== null && !line.synthesized && line.location) carried.add(line.inputLine)
        }
        expect(wrong).toEqual([])
        // And no input line Compiler Explorer maps is lost on the way.
        const mapped = asm.flatMap((line, index) => (line.source ? [index] : []))
        expect(mapped.filter((index) => !carried.has(index))).toEqual([])
        expect(mapped.length).toBeGreaterThan(0)
    })
})
