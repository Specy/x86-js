import {
    ELF_SECTION_COMMON,
    ELF_SECTION_LARGE_COMMON,
    ELF_SECTION_UNDEFINED,
    readElfSymbolTable,
    type ElfSymbol,
} from './elf-symbols'

/** An object to put in an archive, and the name `ld` calls it by in its messages, `archive(name)`. */
export type ArchiveMember = {
    /**
     * One to 15 printable ASCII characters, neither a space nor `/`: what fits the header's
     * 16-byte name field with the `/` that ends a GNU name, so the archive needs no table of long
     * names.
     */
    readonly name: string
    readonly data: Uint8Array
}

const MAGIC = '!<arch>\n'
const HEADER_SIZE = 60
/** A member's name field, which holds its name and the `/` that ends it. */
const NAME_FIELD_SIZE = 16
const MEMBER_NAME = /^[!-.0-~]{1,15}$/
/** The mode `ar` gives a member in deterministic mode, which also zeroes its date, owner and group. */
const MEMBER_MODE = '644'

/**
 * A GNU (System V) `ar` archive of ELF objects, with the symbol index `ld` needs before it takes
 * anything from one, laid out byte for byte as `ar rcsD` lays it out: the index first, as the
 * member named `/` (a big-endian count, the offset of each symbol's member header, then the names,
 * each ending in a NUL, padded with a NUL that its size counts), then each member under its own
 * name, its data padded to an even size with a newline its size does not count. Every date, owner
 * and group is zero and every mode the same, so the same members always make the same bytes.
 *
 * `ld` searches the index in order and takes the first member that defines a symbol it still
 * needs, so the order of `members` is the order of preference between two that define the same
 * one.
 */
export function writeArchive(members: readonly ArchiveMember[]): Uint8Array {
    for (const member of members) {
        if (!MEMBER_NAME.test(member.name)) throw new Error(`Invalid archive member name: ${member.name}`)
    }
    const encoder = new TextEncoder()
    const symbols = members.flatMap((member, index) =>
        indexedSymbols(member.data).map((name) => ({ name: encoder.encode(name), member: index })),
    )
    const indexSize = 4 + 4 * symbols.length + symbols.reduce((total, symbol) => total + symbol.name.length + 1, 0)
    // Unlike any other member's, the index's padding is part of its size, which is how GNU `ar`
    // writes it; a reader finds the first member at the same offset either way.
    const index = new Uint8Array(indexSize + (indexSize % 2))

    let size = MAGIC.length + HEADER_SIZE + index.length
    const offsets = members.map((member) => {
        const offset = size
        size += HEADER_SIZE + member.data.length + (member.data.length % 2)
        return offset
    })

    const indexView = new DataView(index.buffer)
    indexView.setUint32(0, symbols.length, false)
    let nameOffset = 4 + 4 * symbols.length
    symbols.forEach((symbol, position) => {
        indexView.setUint32(4 + 4 * position, offsets[symbol.member]!, false)
        index.set(symbol.name, nameOffset)
        nameOffset += symbol.name.length + 1
    })

    const archive = new Uint8Array(size).fill(0x0a)
    archive.set(encoder.encode(MAGIC), 0)
    archive.set(memberHeader('/', index.length, '0'), MAGIC.length)
    archive.set(index, MAGIC.length + HEADER_SIZE)
    members.forEach((member, position) => {
        archive.set(memberHeader(`${member.name}/`, member.data.length, MEMBER_MODE), offsets[position]!)
        archive.set(member.data, offsets[position]! + HEADER_SIZE)
    })
    return archive
}

/**
 * The symbols an archive's index lists for an object, in its symbol table's order: the ones `ld`
 * may take the object for, which are what GNU `ar` indexes. That is every global, weak and unique
 * definition, common symbols included. An undefined symbol is something the object needs rather
 * than offers, and a local, section or file symbol is invisible outside it.
 */
export function indexedSymbols(object: Uint8Array): string[] {
    return readElfSymbolTable(object).symbols.filter(isIndexed).map((symbol) => symbol.name)
}

function isIndexed(symbol: ElfSymbol): boolean {
    if (symbol.sectionIndex === ELF_SECTION_UNDEFINED || symbol.type === 'section' || symbol.type === 'file') {
        return false
    }
    return (
        symbol.binding === 'global' ||
        symbol.binding === 'weak' ||
        symbol.binding === 'unique' ||
        symbol.sectionIndex === ELF_SECTION_COMMON ||
        symbol.sectionIndex === ELF_SECTION_LARGE_COMMON
    )
}

/** A member's 60-byte header: its name, a zero date, owner and group, its mode and its size. */
function memberHeader(name: string, size: number, mode: string): Uint8Array {
    const text =
        field(name, NAME_FIELD_SIZE) +
        field('0', 12) +
        field('0', 6) +
        field('0', 6) +
        field(mode, 8) +
        field(String(size), 10) +
        '`\n'
    return new TextEncoder().encode(text)
}

/** `value` left-aligned in a field of `width` characters, padded with spaces as `ar` pads it. */
function field(value: string, width: number): string {
    if (value.length > width) throw new Error(`An archive header field holds ${width} characters, not ${value}`)
    return value.padEnd(width, ' ')
}
