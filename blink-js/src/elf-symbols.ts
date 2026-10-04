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

/** `st_shndx` of a symbol that is referenced but not defined here. */
export const ELF_SECTION_UNDEFINED = 0
/** `st_shndx` of an absolute symbol, such as the file symbol NASM writes. */
export const ELF_SECTION_ABSOLUTE = 0xfff1
/** `st_shndx` of a common symbol, whose value is its alignment until `ld` allocates it. */
export const ELF_SECTION_COMMON = 0xfff2
/**
 * `st_shndx` of an x86-64 large common symbol (`SHN_X86_64_LCOMMON`, from `.largecomm`), which
 * `ld` allocates in `.lbss`; like {@link ELF_SECTION_COMMON}, its value is its alignment.
 */
export const ELF_SECTION_LARGE_COMMON = 0xff02
/**
 * `SHN_LORESERVE`: an `st_shndx` from here up names no section of the file but something special
 * (absolute, common, processor- or OS-specific), except {@link SHN_XINDEX}.
 */
const SHN_LORESERVE = 0xff00
/** `st_shndx` saying the real index is in the `SHT_SYMTAB_SHNDX` section. */
const SHN_XINDEX = 0xffff

/** `sh_type` of a section that takes room in memory but none in the file, such as `.bss`. */
export const ELF_SECTION_NO_BITS = 8
/** `sh_flags` bits. */
export const ELF_SECTION_FLAGS = { write: 0x1n, alloc: 0x2n, execute: 0x4n } as const

const ELF_HEADER_SIZE = 64
const SECTION_HEADER_SIZE = 64
const SHT_SYMTAB = 2
const SHT_SYMTAB_SHNDX = 18

const BINDINGS = { 0: 'local', 1: 'global', 2: 'weak', 10: 'unique' } as const
const TYPES = {
    0: 'notype',
    1: 'object',
    2: 'function',
    3: 'section',
    4: 'file',
    5: 'common',
    6: 'tls',
    10: 'ifunc',
} as const
const VISIBILITIES = ['default', 'internal', 'hidden', 'protected'] as const

/** `STB_*`, with `unique` for GNU's `STB_GNU_UNIQUE`; `other` for a value this reader does not name. */
export type ElfSymbolBinding = (typeof BINDINGS)[keyof typeof BINDINGS] | 'other'
/** `STT_*`, with `ifunc` for GNU's `STT_GNU_IFUNC`; `other` for a value this reader does not name. */
export type ElfSymbolType = (typeof TYPES)[keyof typeof TYPES] | 'other'
export type ElfSymbolVisibility = (typeof VISIBILITIES)[number]

/** One entry of the section header table. */
export type ElfSectionHeader = {
    /** Its index in the section header table, which is what a symbol's `sectionIndex` names. */
    readonly index: number
    readonly name: string
    /** `sh_type`, such as 1 for `SHT_PROGBITS` or {@link ELF_SECTION_NO_BITS}. */
    readonly type: number
    /** `sh_flags`; {@link ELF_SECTION_FLAGS} names the bits. */
    readonly flags: bigint
    /** `sh_addr`: where an executable maps the section, 0 in an object file. */
    readonly address: bigint
    /** `sh_offset`: where the file holds the section's bytes. */
    readonly offset: number
    readonly size: number
    readonly link: number
    readonly info: number
    readonly addressAlignment: bigint
    readonly entrySize: number
}

/** One entry of `.symtab`, the null symbol at index 0 included. */
export type ElfSymbol = {
    /** Its index in the symbol table, which is what a relocation names. */
    readonly index: number
    readonly name: string
    /**
     * `st_value`: the offset in its section for a defined symbol of an object file, the address
     * for one of an executable, and the alignment for a common symbol.
     */
    readonly value: bigint
    readonly size: bigint
    readonly binding: ElfSymbolBinding
    readonly type: ElfSymbolType
    readonly visibility: ElfSymbolVisibility
    /**
     * `st_shndx`, resolved through `SHT_SYMTAB_SHNDX` when the table needs it: a section index, or
     * {@link ELF_SECTION_UNDEFINED}, {@link ELF_SECTION_ABSOLUTE}, {@link ELF_SECTION_COMMON},
     * {@link ELF_SECTION_LARGE_COMMON} or another reserved index (`0xff00` up), which names no
     * section.
     */
    readonly sectionIndex: number
    /** The section `sectionIndex` names, or null when it names none: undefined, or a reserved index. */
    readonly section: ElfSectionHeader | null
}

export type ElfSymbolTable = {
    /** `e_type`: 1 for an object file, 2 for an executable. */
    readonly fileType: number
    /** `e_entry`: where an executable starts, 0 in an object file. */
    readonly entry: bigint
    readonly sections: readonly ElfSectionHeader[]
    /** Every symbol of `.symtab` in table order, or none when the file has no symbol table. */
    readonly symbols: readonly ElfSymbol[]
}

/**
 * Every symbol of a little-endian ELF64 file - local, global, weak, common and undefined alike,
 * with its name, value, size, binding, type, visibility and section - and the section headers, so
 * that a symbol's section name and bytes can be found. Unlike {@link readDefinedGlobalSymbols},
 * which answers a narrow question and ignores what it cannot read, this throws for a file that is
 * not ELF64 or whose tables do not fit in it: a reader that silently returned nothing would make
 * every comparison built on it pass.
 */
export function readElfSymbolTable(bytes: Uint8Array): ElfSymbolTable {
    const magic = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
    if (bytes.length < ELF_HEADER_SIZE || !magic) throw new Error('Not an ELF file')
    if (bytes[4] !== 2 || bytes[5] !== 1) throw new Error('Not a little-endian ELF64 file')

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const fileType = view.getUint16(16, true)
    const entry = view.getBigUint64(24, true)
    const tableOffset = fileNumber(view.getBigUint64(40, true), 'the section header table offset')
    const headerSize = view.getUint16(58, true)
    let count = view.getUint16(60, true)
    let namesIndex = view.getUint16(62, true)
    if (tableOffset === 0) return { fileType, entry, sections: [], symbols: [] }
    if (headerSize !== SECTION_HEADER_SIZE) throw new Error(`Unexpected section header size ${headerSize}`)
    requireRange(bytes, tableOffset, SECTION_HEADER_SIZE, 'The section header table')
    // With 0xff00 sections or more, the count and the name table's index live in section 0.
    if (count === 0) count = fileNumber(view.getBigUint64(tableOffset + 32, true), 'the section count')
    if (namesIndex === SHN_XINDEX) namesIndex = view.getUint32(tableOffset + 40, true)
    requireRange(bytes, tableOffset, count * SECTION_HEADER_SIZE, 'The section header table')

    const raw = Array.from({ length: count }, (_, index) => {
        const header = tableOffset + index * SECTION_HEADER_SIZE
        return {
            index,
            nameOffset: view.getUint32(header, true),
            type: view.getUint32(header + 4, true),
            flags: view.getBigUint64(header + 8, true),
            address: view.getBigUint64(header + 16, true),
            offset: fileNumber(view.getBigUint64(header + 24, true), 'a section offset'),
            size: fileNumber(view.getBigUint64(header + 32, true), 'a section size'),
            link: view.getUint32(header + 40, true),
            info: view.getUint32(header + 44, true),
            addressAlignment: view.getBigUint64(header + 48, true),
            entrySize: fileNumber(view.getBigUint64(header + 56, true), 'a section entry size'),
        }
    })
    // Index 0 means the file has no section name table, and then every name is empty.
    const names = namesIndex === 0 ? null : raw[namesIndex]
    if (names === undefined) throw new Error(`The section name table ${namesIndex} does not exist`)
    const sectionNames = names ? sectionContents(bytes, names, 'The section name table') : null
    const sections: ElfSectionHeader[] = raw.map(({ nameOffset, ...header }) => ({
        ...header,
        name: sectionNames && header.index !== 0 ? readName(sectionNames, nameOffset, 'section') : '',
    }))

    const table = sections.find((section) => section.type === SHT_SYMTAB)
    if (!table) return { fileType, entry, sections, symbols: [] }
    if (table.entrySize !== SYMBOL_ENTRY_SIZE) throw new Error(`Unexpected symbol entry size ${table.entrySize}`)
    if (table.size % SYMBOL_ENTRY_SIZE !== 0) {
        throw new Error(
            `The symbol table's ${table.size} bytes are not a whole number of ${SYMBOL_ENTRY_SIZE}-byte entries`,
        )
    }
    const strings = sections[table.link]
    if (!strings) throw new Error(`The symbol table names string table ${table.link}, which does not exist`)
    const symbolNames = sectionContents(bytes, strings, 'The symbol name table')
    const extended = sections.find((section) => section.type === SHT_SYMTAB_SHNDX && section.link === table.index)
    const extendedBytes = extended ? sectionContents(bytes, extended, 'The extended section index table') : null
    const extendedIndexes = extendedBytes
        ? new DataView(extendedBytes.buffer, extendedBytes.byteOffset, extendedBytes.byteLength)
        : null
    const symbolBytes = sectionContents(bytes, table, 'The symbol table')
    const symbolView = new DataView(symbolBytes.buffer, symbolBytes.byteOffset, symbolBytes.byteLength)

    const symbols: ElfSymbol[] = []
    for (let index = 0; (index + 1) * SYMBOL_ENTRY_SIZE <= symbolBytes.length; index += 1) {
        const entryOffset = index * SYMBOL_ENTRY_SIZE
        const info = symbolView.getUint8(entryOffset + 4)
        const name = readName(symbolNames, symbolView.getUint32(entryOffset, true), 'symbol')
        const written = symbolView.getUint16(entryOffset + 6, true)
        let sectionIndex = written
        if (written === SHN_XINDEX) {
            // The real index lives in SHT_SYMTAB_SHNDX; without it the symbol's section is unknown,
            // which must not read as "no section", the way an undefined symbol's does.
            if (!extendedIndexes) {
                throw new Error(
                    `Symbol ${index} (${name}) has an extended section index, but the file has no ` +
                        'SHT_SYMTAB_SHNDX section for its symbol table',
                )
            }
            if ((index + 1) * 4 > extendedIndexes.byteLength) {
                throw new Error(`Symbol ${index} (${name}) lies past the end of the extended section index table`)
            }
            sectionIndex = extendedIndexes.getUint32(index * 4, true)
        }
        // A reserved index names no section, whatever the file's section count; an extended index is
        // always a real one.
        const special = written === ELF_SECTION_UNDEFINED || (written >= SHN_LORESERVE && written !== SHN_XINDEX)
        const section = special ? null : sections[sectionIndex]
        if (section === undefined) {
            throw new Error(`Symbol ${index} (${name}) names section ${sectionIndex}, which does not exist`)
        }
        symbols.push({
            index,
            name,
            value: symbolView.getBigUint64(entryOffset + 8, true),
            size: symbolView.getBigUint64(entryOffset + 16, true),
            binding: BINDINGS[(info >> 4) as keyof typeof BINDINGS] ?? 'other',
            type: TYPES[(info & 0xf) as keyof typeof TYPES] ?? 'other',
            visibility: VISIBILITIES[symbolView.getUint8(entryOffset + 5) & 0x3]!,
            sectionIndex,
            section,
        })
    }
    return { fileType, entry, sections, symbols }
}

/**
 * The bytes `section` holds, or the `length` of them from `start` (by default all of them). A
 * section that takes no room in the file ({@link ELF_SECTION_NO_BITS}, such as `.bss`) holds zeros
 * once loaded, so it reads as zeros here too, allocating only the range asked for. Throws for a
 * range outside the section.
 */
export function readElfSectionBytes(
    bytes: Uint8Array,
    section: ElfSectionHeader,
    start = 0,
    length = section.size - start,
): Uint8Array {
    const what = `Section ${section.name || section.index}`
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0) {
        throw new Error(`${what}: invalid range of ${length} bytes from ${start}`)
    }
    if (start + length > section.size) {
        throw new Error(`${what} holds ${section.size} bytes, so ${length} from ${start} lie outside it`)
    }
    if (section.type === ELF_SECTION_NO_BITS) return new Uint8Array(length)
    return sectionContents(bytes, section, what).subarray(start, start + length)
}

function sectionContents(
    bytes: Uint8Array,
    section: Pick<ElfSectionHeader, 'offset' | 'size'>,
    what: string,
): Uint8Array {
    requireRange(bytes, section.offset, section.size, what)
    return bytes.subarray(section.offset, section.offset + section.size)
}

function requireRange(bytes: Uint8Array, offset: number, size: number, what: string): void {
    if (offset + size > bytes.length) throw new Error(`${what} runs past the end of the file`)
}

function fileNumber(value: bigint, what: string): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Unreadable ELF file: ${what} is ${value}`)
    return Number(value)
}

function readName(strings: Uint8Array, offset: number, what: string): string {
    if (offset >= strings.length) {
        if (offset === 0) return ''
        throw new Error(`A ${what} name at ${offset} lies outside its string table`)
    }
    return readNullTerminatedString(strings, offset, strings.length)[0]
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
