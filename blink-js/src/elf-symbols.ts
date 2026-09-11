import { findElfSection, readNullTerminatedString } from './source-map'

/**
 * The entry symbol `ld` looks for when no `-e` is given. A program without it
 * still links: `ld` warns, defaults the entry address to the start of the text
 * segment, and the program runs from whatever happens to be there.
 */
export const DEFAULT_ENTRY_SYMBOL = '_start'

const SYMBOL_ENTRY_SIZE = 24
const SHN_UNDEF = 0
const STB_LOCAL = 0

/**
 * Names every symbol an object file defines and exports, which is what decides
 * whether the linker can find an entry point. A symbol that is merely referenced
 * (`st_shndx` of SHN_UNDEF) is not defined here, and a local one - a label
 * without a matching `global` directive - is invisible to the linker.
 */
export function readDefinedGlobalSymbols(objectBytes: Uint8Array): string[] {
    const symbolTable = findElfSection(objectBytes, '.symtab')
    const stringTable = findElfSection(objectBytes, '.strtab')
    if (!symbolTable || !stringTable) return []

    const view = new DataView(objectBytes.buffer, objectBytes.byteOffset, objectBytes.byteLength)
    const strings = objectBytes.subarray(stringTable.offset, stringTable.offset + stringTable.size)
    const names: string[] = []

    for (let offset = 0; offset + SYMBOL_ENTRY_SIZE <= symbolTable.size; offset += SYMBOL_ENTRY_SIZE) {
        const entry = symbolTable.offset + offset
        const nameOffset = view.getUint32(entry, true)
        const binding = view.getUint8(entry + 4) >> 4
        const sectionIndex = view.getUint16(entry + 6, true)
        if (binding === STB_LOCAL || sectionIndex === SHN_UNDEF) continue
        if (nameOffset >= strings.length) continue
        const [name] = readNullTerminatedString(strings, nameOffset, strings.length)
        if (name) names.push(name)
    }

    return names
}

/**
 * The symbol a misspelling was probably meant to be, or null when nothing in the
 * object looks close enough to say. Deliberately strict: naming the wrong symbol
 * is worse than naming none, so this only answers for a small edit distance on a
 * name of a similar length.
 */
export function findNearestSymbol(target: string, candidates: readonly string[]): string | null {
    let best: string | null = null
    let bestDistance = Number.POSITIVE_INFINITY

    for (const candidate of candidates) {
        if (candidate === target) return null
        if (Math.abs(candidate.length - target.length) > 2) continue
        const distance = editDistance(candidate, target)
        if (distance < bestDistance) {
            bestDistance = distance
            best = candidate
        }
    }

    const allowed = target.length <= 4 ? 1 : 2
    return bestDistance <= allowed ? best : null
}

function editDistance(left: string, right: string): number {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex]
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const substitution =
                previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
            current.push(Math.min(substitution, previous[rightIndex]! + 1, current[rightIndex - 1]! + 1))
        }
        previous = current
    }
    return previous[right.length]!
}
