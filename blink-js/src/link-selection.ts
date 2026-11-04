import type { DeclaredName } from './declarations'
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

/** What `ld` has learned of the names its inputs define and need, and how it answers whether it wants a member. */
class NameStates {
    private readonly states: Map<string, NameState>
    constructor(entrySymbol: string) {
        this.states = new Map([[entrySymbol, 'undefined']])
    }
    /** Reads an object the link takes: what it defines, and what it needs that nothing defines yet. */
    take(object: Uint8Array): void {
        for (const symbol of visibleSymbols(object)) {
            const state = this.states.get(symbol.name)
            if (symbol.sectionIndex === ELF_SECTION_UNDEFINED) {
                if (state === undefined)
                    this.states.set(symbol.name, symbol.binding === 'weak' ? 'weak-undefined' : 'undefined')
                else if (state === 'weak-undefined' && symbol.binding !== 'weak') this.states.set(symbol.name, 'undefined')
            } else if (isCommon(symbol)) {
                if (state !== 'defined') this.states.set(symbol.name, 'common')
            } else this.states.set(symbol.name, 'defined')
        }
    }
    define(name: string): void {
        this.states.set(name, 'defined')
    }
    /** Needs `name`, as an undefined reference of an object would, unless something defines it. */
    need(name: string): void {
        const state = this.states.get(name)
        if (state === undefined || state === 'weak-undefined') this.states.set(name, 'undefined')
    }
    /**
     * Whether a member that offers `name` is taken for it: the name is needed, or only common so
     * far and the member really defines it.
     */
    wants(name: string, definesReally: () => boolean): boolean {
        const state = this.states.get(name)
        return state === 'undefined' || (state === 'common' && definesReally())
    }
}

/** An archive's index as `writeArchive` lays it out (`indexedSymbols`), read from the symbols kept for each object. */
function archiveIndex<Unit extends LinkUnit>(members: readonly Unit[]): { name: string; member: Unit }[] {
    return members.flatMap((member) =>
        visibleSymbols(member.object)
            .filter(
                (symbol) =>
                    symbol.sectionIndex !== ELF_SECTION_UNDEFINED &&
                    (symbol.binding === 'global' || symbol.binding === 'weak' || symbol.binding === 'unique' || isCommon(symbol))
            )
            .map((symbol) => ({ name: symbol.name, member }))
    )
}

/** Whether `object` defines `name` with a real definition, neither common nor undefined. */
function definesReally(object: Uint8Array, name: string): boolean {
    return visibleSymbols(object).some(
        (symbol) => symbol.name === name && symbol.sectionIndex !== ELF_SECTION_UNDEFINED && !isCommon(symbol)
    )
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
    const states = new NameStates(entrySymbol)
    const linked = new Set<LinkUnit>()
    const take = (unit: LinkUnit) => {
        linked.add(unit)
        states.take(unit.object)
    }
    for (const object of objects) take(object)
    const indexes = archives.map(archiveIndex)
    let grouped: boolean
    do {
        grouped = false
        for (const index of indexes) {
            let again: boolean
            do {
                again = false
                for (const { name, member } of index) {
                    if (linked.has(member)) continue
                    if (!states.wants(name, () => definesReally(member.object, name))) continue
                    take(member)
                    again = grouped = true
                }
            } while (again)
        }
    } while (grouped)
    return linked
}

/**
 * A unit of an archive known only by its text until the link takes it: what a scan of its
 * declarations says it defines (`declaredNames`).
 */
export type DeclaredUnit = { readonly path: string; readonly defines: readonly DeclaredName[] }

/**
 * The units of `declared` that `ld --start-group <objects> <declared> <archive> --end-group` takes,
 * by the rule of {@link selectLinkedUnits}, when the units of `declared` are not assembled yet: the
 * index of that archive is what their declarations say they define, and each is assembled by
 * `assemble` only once the link takes it, so a unit the program does not need is never assembled.
 * The object `assemble` returns then says what the unit needs in turn; a unit it could not
 * assemble, null, counts as defining what it declares, so nothing else is taken in its place.
 * Returns the units taken, in the order of `declared`.
 *
 * `known` stands in for an object that could not be made, the Entry's when it does not assemble:
 * the names it `defines` and `needs` as a scan of its text reads them, so that the units it would
 * need are still assembled, and checked.
 */
export async function pullDeclaredUnits<Unit extends DeclaredUnit>(
    objects: readonly LinkUnit[],
    declared: readonly Unit[],
    archive: readonly LinkUnit[],
    assemble: (unit: Unit) => Promise<Uint8Array | null>,
    entrySymbol: string = DEFAULT_ENTRY_SYMBOL,
    known: { readonly defines?: readonly string[]; readonly needs?: readonly string[] } = {}
): Promise<Unit[]> {
    const states = new NameStates(entrySymbol)
    for (const name of known.defines ?? []) states.define(name)
    for (const object of objects) states.take(object.object)
    for (const name of known.needs ?? []) states.need(name)
    const taken = new Set<Unit>()
    const archiveTaken = new Set<LinkUnit>()
    const declaredIndex = declared.flatMap((unit) => unit.defines.map(({ name }) => ({ name, unit })))
    const index = archiveIndex(archive)
    let grouped: boolean
    do {
        grouped = false
        let again: boolean
        do {
            again = false
            for (const { name, unit } of declaredIndex) {
                if (taken.has(unit)) continue
                if (!states.wants(name, () => unit.defines.some((defined) => defined.name === name && !defined.common))) continue
                taken.add(unit)
                const object = await assemble(unit)
                if (object) states.take(object)
                else for (const defined of unit.defines) states.define(defined.name)
                again = grouped = true
            }
        } while (again)
        do {
            again = false
            for (const { name, member } of index) {
                if (archiveTaken.has(member)) continue
                if (!states.wants(name, () => definesReally(member.object, name))) continue
                archiveTaken.add(member)
                states.take(member.object)
                again = grouped = true
            }
        } while (again)
    } while (grouped)
    return declared.filter((unit) => taken.has(unit))
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
