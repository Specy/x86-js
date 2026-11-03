import {
    DEFAULT_ENTRY_SYMBOL,
    ELF_SECTION_ABSOLUTE,
    ELF_SECTION_COMMON,
    ELF_SECTION_LARGE_COMMON,
    ELF_SECTION_UNDEFINED,
    readElfSymbolTable,
    type ElfSymbol
} from './elf-symbols'

/** A unit's object, named by the path of the source it was assembled from. */
export type LinkUnit = { readonly path: string; readonly object: Uint8Array }

/**
 * Where a name stands while `ld` reads its inputs, as its symbol table records it: needed, needed
 * only weakly, a common symbol nothing has defined yet, or defined, weakly or not.
 */
type NameState = 'undefined' | 'weak-undefined' | 'common' | 'defined'

const isCommon = (symbol: ElfSymbol) =>
    symbol.sectionIndex === ELF_SECTION_COMMON || symbol.sectionIndex === ELF_SECTION_LARGE_COMMON

/**
 * The symbols of an object another object can see: its global, weak and unique ones. Kept per
 * object, as a check reads the same library objects every time it runs.
 */
const visible = new WeakMap<Uint8Array, ElfSymbol[]>()
function visibleSymbols(object: Uint8Array): ElfSymbol[] {
    let symbols = visible.get(object)
    if (!symbols) {
        symbols = readElfSymbolTable(object).symbols.filter(
            (symbol) =>
                symbol.name !== '' &&
                symbol.binding !== 'local' &&
                symbol.type !== 'section' &&
                symbol.type !== 'file'
        )
        visible.set(object, symbols)
    }
    return symbols
}

/**
 * The units `ld --start-group <objects> <archives> --end-group` takes into the program: every
 * object, and the archive members it extracts, which is the rule GNU ld (BFD's
 * `elf_link_add_archive_symbols`) follows. The entry symbol is needed from the start, as the
 * default linker script's `ENTRY` makes it. Each archive is read in its index's order, the members
 * in order and each member's symbols in its symbol table's order, as `writeArchive` lays the index
 * out. A member is taken for the first entry of the index whose name is needed and not yet defined,
 * and again from the top while taking one adds anything, and the group is read again while any
 * archive gave a member. A weak reference takes nothing, and a common symbol takes a member only
 * for a real definition. A member none of whose definitions is needed is never read, so whatever it
 * defines twice with another unit is no error of the link.
 *
 * A Build links with `ld` itself, which says what it took through its map; this answers the same
 * question for a check, which links nothing.
 */
export function selectLinkedUnits(
    objects: readonly LinkUnit[],
    archives: readonly (readonly LinkUnit[])[],
    entrySymbol: string = DEFAULT_ENTRY_SYMBOL
): Set<LinkUnit> {
    const states = new Map<string, NameState>([[entrySymbol, 'undefined']])
    const linked = new Set<LinkUnit>()
    const take = (unit: LinkUnit) => {
        linked.add(unit)
        for (const symbol of visibleSymbols(unit.object)) {
            const state = states.get(symbol.name)
            if (symbol.sectionIndex === ELF_SECTION_UNDEFINED) {
                if (state === undefined)
                    states.set(
                        symbol.name,
                        symbol.binding === 'weak' ? 'weak-undefined' : 'undefined'
                    )
                else if (state === 'weak-undefined' && symbol.binding !== 'weak')
                    states.set(symbol.name, 'undefined')
            } else if (isCommon(symbol)) {
                if (state !== 'defined') states.set(symbol.name, 'common')
            } else states.set(symbol.name, 'defined')
        }
    }
    for (const object of objects) take(object)
    // what `writeArchive` indexes (`indexedSymbols`), read from the symbols kept for the object
    const indexes = archives.map((members) =>
        members.flatMap((member) =>
            visibleSymbols(member.object)
                .filter(
                    (symbol) =>
                        symbol.sectionIndex !== ELF_SECTION_UNDEFINED &&
                        (symbol.binding === 'global' ||
                            symbol.binding === 'weak' ||
                            symbol.binding === 'unique' ||
                            isCommon(symbol))
                )
                .map((symbol) => ({ name: symbol.name, member }))
        )
    )
    let grouped: boolean
    do {
        grouped = false
        for (const index of indexes) {
            let again: boolean
            do {
                again = false
                for (const { name, member } of index) {
                    if (linked.has(member)) continue
                    const state = states.get(name)
                    const wanted =
                        state === 'undefined' ||
                        (state === 'common' &&
                            visibleSymbols(member.object).some(
                                (symbol) =>
                                    symbol.name === name &&
                                    symbol.sectionIndex !== ELF_SECTION_UNDEFINED &&
                                    !isCommon(symbol)
                            ))
                    if (!wanted) continue
                    take(member)
                    again = grouped = true
                }
            } while (again)
        }
    } while (grouped)
    return linked
}

/**
 * The names more than one of `units` defines strongly, with the units that define each, in order:
 * what `ld` reports as a multiple definition when it links them all. A weak definition beside a
 * strong one, several common symbols, and an absolute symbol given the same value twice are none.
 */
export function strongDuplicates(units: readonly LinkUnit[]): Map<string, LinkUnit[]> {
    const definitions = new Map<string, { unit: LinkUnit; symbol: ElfSymbol }[]>()
    for (const unit of units)
        for (const symbol of visibleSymbols(unit.object)) {
            if (
                symbol.binding === 'weak' ||
                symbol.sectionIndex === ELF_SECTION_UNDEFINED ||
                isCommon(symbol)
            )
                continue
            const found = definitions.get(symbol.name) ?? []
            found.push({ unit, symbol })
            definitions.set(symbol.name, found)
        }
    const duplicates = new Map<string, LinkUnit[]>()
    for (const [name, found] of definitions) {
        if (found.length < 2) continue
        const [first] = found
        const sameAbsolute = found.every(
            ({ symbol }) =>
                symbol.sectionIndex === ELF_SECTION_ABSOLUTE && symbol.value === first!.symbol.value
        )
        const defining = [...new Set(found.map(({ unit }) => unit))]
        if (!sameAbsolute && defining.length > 1) duplicates.set(name, defining)
    }
    return duplicates
}
