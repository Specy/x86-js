import type {
    ElfSectionHeader,
    ElfSymbol,
    ElfSymbolBinding,
    ElfSymbolType,
    ElfSymbolVisibility
} from '../elf-symbols'

// Pure TypeScript with type-only imports: `@specy/x86/elf` must load no WebAssembly.

export type ElfProgramHeader = {
    type: number
    flags: number
    offset: number
    address: bigint
    fileSize: number
    memorySize: bigint
    alignment: bigint
}
/** One relocation the file asks the loader (or a static program's startup code) to apply. */
export type ElfRelocation = {
    /** `r_offset`: the link-time address it patches. */
    address: bigint
    /** `R_X86_64_*`, such as 6 `GLOB_DAT`, 7 `JUMP_SLOT`, 8 `RELATIVE` or 37 `IRELATIVE`. */
    type: number
    /** The name of the symbol it names, '' for none. */
    symbol: string
    /** `r_addend`; for an entry packed in RELR, which has none, the value the file holds at `address`. */
    addend: bigint
    /**
     * The table it comes from: a section name such as '.rela.dyn', '.rela.plt' or '.relr.dyn'
     * ('section N' when the file names no sections), or 'DT_RELA', 'DT_JMPREL' or 'DT_RELR' when it
     * was read through the dynamic section because no usable section header describes it.
     */
    table: string
}
/**
 * A PLT stub, named after the slot its `jmp [rel slot]` goes through: `name@plt`, or
 * `name@plt_resolver` for a lazy-binding stub of `.plt` when `.plt.sec` holds the jumps.
 */
export type ElfPltStub = {
    address: bigint
    name: string
    /** The GOT slot the stub jumps through, or, for a lazy stub, the slot it binds. */
    got: bigint
}
/** A symbol as {@link analyze} reads it: its name never carries a version suffix. */
export type ElfAnalysisSymbol = ElfSymbol & {
    /**
     * Its symbol version, such as 'GLIBC_2.2.5': from `.gnu.version` for a dynamic symbol, or from
     * a `@VERSION`/`@@VERSION` suffix naming a version of the file's version tables for `.symtab`.
     */
    readonly version?: string
    /**
     * With a version: true for the default version of a definition (`name@@VERSION`), false for a
     * hidden or non-default one and for a reference to another file's version (`name@VERSION`).
     */
    readonly defaultVersion?: boolean
}
export type ElfAnalysis = {
    isElf: boolean
    supported: boolean
    reason?: string
    type: number
    pie: boolean
    entry: bigint
    interpreter?: string
    soname?: string
    needed: string[]
    stripped: boolean
    programHeaders: ElfProgramHeader[]
    /** The section headers, or none when the table is missing or unreadable (Linux ignores it). */
    sections: readonly ElfSectionHeader[]
    /** `.symtab`, null symbol included, or none. */
    symbols: readonly ElfAnalysisSymbol[]
    /** `.dynsym`, or the table `DT_SYMTAB` names when no usable section describes it. */
    dynamicSymbols: ElfAnalysisSymbol[]
    relocations: ElfRelocation[]
    /** Sorted by address. */
    plt: ElfPltStub[]
}

const EM_386 = 3
const EM_IAMCU = 6
const EM_X86_64 = 62
/** How a reason names a program for another machine: the article goes with how the name is said. */
const MACHINES: Record<number, readonly [article: string, name: string]> = {
    2: ['a', 'SPARC'],
    4: ['a', 'Motorola 68000'],
    8: ['a', 'MIPS'],
    10: ['a', 'MIPS'],
    15: ['a', 'PA-RISC'],
    18: ['a', 'SPARC'],
    20: ['a', 'PowerPC'],
    21: ['a', 'PowerPC'],
    22: ['an', 'IBM Z'],
    40: ['an', 'ARM'],
    42: ['a', 'SuperH'],
    43: ['a', 'SPARC'],
    50: ['an', 'Itanium'],
    183: ['an', 'ARM'],
    220: ['a', 'Z80'],
    243: ['a', 'RISC-V'],
    247: ['an', 'eBPF'],
    258: ['a', 'LoongArch'],
    0x9026: ['an', 'Alpha']
}

const PT_LOAD = 1
const PT_DYNAMIC = 2
const PT_INTERP = 3
const PF_X = 1

const SHT_SYMTAB = 2
const SHT_RELA = 4
const SHT_NOBITS = 8
const SHT_DYNSYM = 11
const SHT_SYMTAB_SHNDX = 18
const SHT_RELR = 19
const SHT_GNU_VERDEF = 0x6ffffffd
const SHT_GNU_VERNEED = 0x6ffffffe
const SHT_GNU_VERSYM = 0x6fffffff
const SHF_ALLOC = 2n
const SHF_EXECINSTR = 4n
const SHN_UNDEF = 0
const SHN_LORESERVE = 0xff00
const SHN_XINDEX = 0xffff

const DT_NEEDED = 1
const DT_PLTRELSZ = 2
const DT_HASH = 4
const DT_STRTAB = 5
const DT_SYMTAB = 6
const DT_RELA = 7
const DT_RELASZ = 8
const DT_STRSZ = 10
const DT_SONAME = 14
const DT_PLTREL = 20
const DT_JMPREL = 23
const DT_RELRSZ = 35
const DT_RELR = 36
const DT_GNU_HASH = 0x6ffffef5
const DT_VERSYM = 0x6ffffff0
const DT_VERDEF = 0x6ffffffc
const DT_VERDEFNUM = 0x6ffffffd
const DT_VERNEED = 0x6ffffffe
const DT_VERNEEDNUM = 0x6fffffff

const R_X86_64_GLOB_DAT = 6
const R_X86_64_JUMP_SLOT = 7
const R_X86_64_RELATIVE = 8
const R_X86_64_IRELATIVE = 37

const SYMBOL_SIZE = 24
const RELA_SIZE = 24
/** Version indexes 0 (local) and 1 (global) name no version; the top bit hides a definition. */
const VERSYM_HIDDEN = 0x8000
const VER_FLG_BASE = 1
/** A version index has 15 bits, so no version table can usefully hold more entries. */
const MAX_VERSIONS = 0x8000

const BINDINGS: Record<number, ElfSymbolBinding> = {
    0: 'local',
    1: 'global',
    2: 'weak',
    10: 'unique'
}
const TYPES: Record<number, ElfSymbolType> = {
    0: 'notype',
    1: 'object',
    2: 'function',
    3: 'section',
    4: 'file',
    5: 'common',
    6: 'tls',
    10: 'ifunc'
}
const VISIBILITIES: readonly ElfSymbolVisibility[] = ['default', 'internal', 'hidden', 'protected']

const decoder = new TextDecoder()

/** Bounds-checked reads of a little-endian ELF64 file, and its load segments' address map. */
class ElfReader {
    readonly view: DataView
    readonly length: number
    /** PT_LOAD headers whose file image lies inside the file. */
    readonly loads: ElfProgramHeader[] = []
    /**
     * The load segments' file images as disjoint address ranges sorted by address (where segments
     * overlap, the one starting lower keeps the overlap), so that an address maps in log time.
     */
    images: { start: bigint; end: bigint; offset: number; executable: boolean }[] = []
    /**
     * Bytes left to scan for strings. Many symbols can name the same long string, so the total a
     * corrupt file can make the reader decode is capped at a multiple of its size.
     */
    private budget: number
    readonly bytes: Uint8Array

    constructor(bytes: Uint8Array) {
        this.bytes = bytes
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.length = bytes.length
        this.budget = 8 * bytes.length + 0x100000
    }

    fits(offset: number, size: number): boolean {
        return (
            Number.isSafeInteger(offset) &&
            Number.isSafeInteger(size) &&
            offset >= 0 &&
            size >= 0 &&
            offset + size <= this.length
        )
    }
    u16(at: number) {
        return this.view.getUint16(at, true)
    }
    u32(at: number) {
        return this.view.getUint32(at, true)
    }
    i32(at: number) {
        return this.view.getInt32(at, true)
    }
    u64(at: number) {
        return this.view.getBigUint64(at, true)
    }
    i64(at: number) {
        return this.view.getBigInt64(at, true)
    }
    /** A 64-bit file offset or size, or undefined when it cannot lie inside the file. */
    small(value: bigint): number | undefined {
        return value <= BigInt(this.length) ? Number(value) : undefined
    }
    /** Builds {@link images} once {@link loads} is complete. */
    indexLoads() {
        const sorted = [...this.loads].sort((a, b) =>
            a.address < b.address ? -1 : a.address > b.address ? 1 : 0
        )
        let covered = 0n
        this.images = []
        for (const load of sorted) {
            const end = load.address + BigInt(load.fileSize)
            const start = load.address > covered ? load.address : covered
            if (start >= end) continue
            this.images.push({
                start,
                end,
                offset: load.offset + Number(start - load.address),
                executable: !!(load.flags & PF_X)
            })
            covered = end
        }
    }
    /** Where the file holds link-time `address`, and how many bytes its load segment holds from there. */
    map(address: bigint): { offset: number; available: number } | undefined {
        const images = this.images
        let low = 0
        let high = images.length - 1
        while (low <= high) {
            const middle = (low + high) >> 1
            const image = images[middle]!
            if (address < image.start) high = middle - 1
            else if (address >= image.end) low = middle + 1
            else
                return {
                    offset: image.offset + Number(address - image.start),
                    available: Number(image.end - address)
                }
        }
        return undefined
    }
    /** The file offset of `size` bytes at link-time `address`, when one load segment's image holds them. */
    offsetOf(address: bigint, size: number): number | undefined {
        const where = this.map(address)
        return where && where.available >= size ? where.offset : undefined
    }
    /** The NUL-terminated string at `offset`, or undefined when no NUL ends it before `end`. */
    string(offset: number, end: number): string | undefined {
        end = Math.min(end, this.length)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= end || this.budget <= 0)
            return undefined
        const window = Math.min(end, offset + this.budget)
        const stop = this.bytes.subarray(offset, window).indexOf(0)
        this.budget -= stop < 0 ? window - offset : stop + 1
        if (stop < 0) return undefined
        return stop ? decoder.decode(this.bytes.subarray(offset, offset + stop)) : ''
    }
}

/** A string table: names are offsets from `offset`, and none may run to `end`. */
type StringTable = { offset: number; end: number }

/** Why a header that is not a little-endian x86-64 Linux ELF64 cannot run, read from e_ident and e_machine. */
function identify(bytes: Uint8Array): string | undefined {
    if (bytes.length < 20) return 'a truncated ELF file'
    const elfClass = bytes[4]!
    const data = bytes[5]!
    if (data !== 1 && data !== 2)
        return `an ELF file of an unknown byte order (${data}); only little-endian x86-64 programs run`
    const machine = data === 1 ? bytes[18]! | (bytes[19]! << 8) : (bytes[18]! << 8) | bytes[19]!
    const bits32 = elfClass === 1
    if (machine === EM_386 || machine === EM_IAMCU || (machine === EM_X86_64 && bits32))
        return 'a 32-bit x86 program; only 64-bit x86-64 programs run'
    if (machine !== EM_X86_64) {
        const known = MACHINES[machine]
        const prefix = bits32 ? '32-bit ' : ''
        const what = known
            ? bits32
                ? `a 32-bit ${known[1]} program`
                : `${known[0]} ${known[1]} program`
            : `a ${prefix}program for ELF machine ${machine}`
        return `${what}; only x86-64 programs run`
    }
    if (elfClass !== 2)
        return `an x86-64 ELF file of an unknown class (${elfClass}); only 64-bit x86-64 programs run`
    if (data !== 1) return 'a big-endian x86-64 program; only little-endian x86-64 programs run'
    if (bytes.length < 64) return 'a truncated ELF file'
    if (bytes[7] !== 0 && bytes[7] !== 3)
        return 'an ELF program for an unsupported operating system'
    return undefined
}

/**
 * Read an ELF without executing it. Whether it runs (`supported`, or a `reason`) depends only on the
 * ELF header and its PT_LOAD, PT_INTERP and PT_DYNAMIC program headers, as for Linux and Blink;
 * sections, symbols, relocations and PLT stubs are read best-effort, through the dynamic section
 * when the section headers are missing or corrupt. Never throws.
 */
export function analyze(bytes: Uint8Array): ElfAnalysis {
    const result: ElfAnalysis = {
        isElf: bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46,
        supported: false,
        type: 0,
        pie: false,
        entry: 0n,
        needed: [],
        stripped: true,
        programHeaders: [],
        sections: [],
        symbols: [],
        dynamicSymbols: [],
        relocations: [],
        plt: []
    }
    if (!result.isElf) {
        result.reason = 'not an ELF program'
        return result
    }
    const unsupported = identify(bytes)
    if (unsupported) {
        result.reason = unsupported
        return result
    }
    const reader = new ElfReader(bytes)
    const dynamic: DynamicEntry[] = []
    let reason: string | undefined
    try {
        reason = readProgram(reader, result, dynamic)
    } catch {
        // The readers check every range; this only guards against a mistake in them.
        reason = 'a malformed ELF file'
    }
    result.supported = !reason
    if (reason) result.reason = reason
    try {
        readContents(reader, result, dynamic)
    } catch {
        // Best-effort: what could not be read stays empty.
    }
    return result
}

type DynamicEntry = { tag: number; value: bigint }

/** The header, program headers, interpreter and dynamic dependencies: why the program cannot run, if so. */
function readProgram(
    reader: ElfReader,
    result: ElfAnalysis,
    dynamic: DynamicEntry[]
): string | undefined {
    result.type = reader.u16(16)
    result.pie = result.type === 3
    result.entry = reader.u64(24)
    const tableOffset = reader.small(reader.u64(32))
    const headerSize = reader.u16(54)
    const count = reader.u16(56)
    if (count && headerSize !== 56) return 'an invalid ELF program header size'
    if (count && (tableOffset === undefined || !reader.fits(tableOffset, count * 56)))
        return 'a truncated ELF file'
    let problem: string | undefined
    for (let i = 0; i < count; ++i) {
        const at = tableOffset! + i * 56
        const offset = reader.u64(at + 8)
        const fileSize = reader.u64(at + 32)
        const header: ElfProgramHeader = {
            type: reader.u32(at),
            flags: reader.u32(at + 4),
            offset: Number(offset),
            address: reader.u64(at + 16),
            fileSize: Number(fileSize),
            memorySize: reader.u64(at + 40),
            alignment: reader.u64(at + 48)
        }
        result.programHeaders.push(header)
        if (header.type !== PT_LOAD && header.type !== PT_DYNAMIC && header.type !== PT_INTERP)
            continue
        if (offset + fileSize > BigInt(reader.length)) problem ??= 'a truncated ELF file'
        else if (header.type === PT_LOAD && fileSize > header.memorySize)
            problem ??= 'an invalid ELF load segment'
        else if (header.type === PT_LOAD) reader.loads.push(header)
    }
    reader.indexLoads()
    if (problem) return problem
    const interpreter = result.programHeaders.find((header) => header.type === PT_INTERP)
    if (interpreter) {
        result.interpreter = reader.string(
            interpreter.offset,
            interpreter.offset + interpreter.fileSize
        )
        if (result.interpreter === undefined) return 'an unterminated ELF string'
    }
    const segment = result.programHeaders.find((header) => header.type === PT_DYNAMIC)
    if (segment) {
        for (let at = segment.offset; at + 16 <= segment.offset + segment.fileSize; at += 16) {
            const tag = reader.i64(at)
            if (!tag) break
            // Every tag this reader knows fits 32 bits; the others are kept out of the way.
            if (tag > 0n && tag <= 0x7fffffffn)
                dynamic.push({ tag: Number(tag), value: reader.u64(at + 8) })
        }
        const strings = dynamicStrings(reader, dynamic)
        const names = (tag: number) =>
            dynamic.filter((entry) => entry.tag === tag).map((entry) => entry.value)
        const name = (offset: bigint) =>
            strings && offset < BigInt(strings.end - strings.offset)
                ? reader.string(strings.offset + Number(offset), strings.end)
                : undefined
        for (const offset of names(DT_NEEDED)) {
            const needed = name(offset)
            if (needed === undefined) return 'an invalid ELF dynamic string table'
            result.needed.push(needed)
        }
        // The loader reads DT_SONAME only to name a library, so an unreadable one is left out.
        const soname = names(DT_SONAME)[0]
        if (soname !== undefined) result.soname = name(soname)
    }
    if (result.type === 1) return 'an object file, not a program'
    if (result.type !== 2 && result.type !== 3)
        return 'an ELF file that is not an executable program'
    if (!result.entry) return 'a shared library, not a program'
    if (
        !reader.loads.some(
            (header) =>
                header.flags & PF_X &&
                result.entry >= header.address &&
                result.entry - header.address < header.memorySize
        )
    )
        return 'an ELF program with an unmapped entry point'
    return undefined
}

function dynamicValue(dynamic: DynamicEntry[], tag: number): bigint | undefined {
    return dynamic.find((entry) => entry.tag === tag)?.value
}

/** DT_STRTAB, as far as DT_STRSZ and its load segment's file image both reach. */
function dynamicStrings(reader: ElfReader, dynamic: DynamicEntry[]): StringTable | undefined {
    const address = dynamicValue(dynamic, DT_STRTAB)
    const where = address === undefined ? undefined : reader.map(address)
    if (!where) return undefined
    const size = dynamicValue(dynamic, DT_STRSZ)
    const length =
        size === undefined || size > BigInt(where.available) ? where.available : Number(size)
    return { offset: where.offset, end: where.offset + length }
}

/** Everything read best-effort: each part that cannot be read is left empty. */
function readContents(reader: ElfReader, result: ElfAnalysis, dynamic: DynamicEntry[]) {
    const attempt = <T>(read: () => T, otherwise: T): T => {
        try {
            return read()
        } catch {
            return otherwise
        }
    }
    const { sections, named } = attempt(() => readSections(reader), { sections: [], named: false })
    result.sections = sections
    result.stripped = !sections.some((section) => section.type === SHT_SYMTAB)
    const symbols = attempt(() => readSymbolTable(reader, sections), [])
    const dynamicSymbols = attempt(() => readDynamicSymbols(reader, sections, dynamic), {
        symbols: [] as ElfAnalysisSymbol[],
        versions: new Set<string>()
    })
    result.dynamicSymbols = dynamicSymbols.symbols
    result.symbols = attempt(() => stripVersions(symbols, dynamicSymbols.versions), symbols)
    const relocations = attempt(() => readRelocations(reader, result, dynamic), {
        relocations: [],
        entries: new Map(),
        jumpTable: undefined
    } as Relocations)
    result.relocations = relocations.relocations
    result.plt = attempt(() => readPlt(reader, result, relocations, named), [])
}

/** The section header table, or none when it does not fit the file; names are '' without a usable name table. */
function readSections(reader: ElfReader): { sections: ElfSectionHeader[]; named: boolean } {
    const none = { sections: [], named: false }
    const tableOffset = reader.small(reader.u64(40))
    if (!tableOffset || reader.u16(58) !== 64 || !reader.fits(tableOffset, 64)) return none
    let count = reader.u16(60)
    let namesIndex = reader.u16(62)
    // With 0xff00 sections or more, the count and the name table's index live in section 0.
    if (count === 0) count = reader.small(reader.u64(tableOffset + 32)) ?? 0
    if (namesIndex === SHN_XINDEX) namesIndex = reader.u32(tableOffset + 40)
    if (!count || !reader.fits(tableOffset, count * 64)) return none
    const headers: (ElfSectionHeader & { nameOffset: number })[] = []
    for (let index = 0; index < count; ++index) {
        const at = tableOffset + index * 64
        headers.push({
            index,
            name: '',
            nameOffset: reader.u32(at),
            type: reader.u32(at + 4),
            flags: reader.u64(at + 8),
            address: reader.u64(at + 16),
            offset: Number(reader.u64(at + 24)),
            size: Number(reader.u64(at + 32)),
            link: reader.u32(at + 40),
            info: reader.u32(at + 44),
            addressAlignment: reader.u64(at + 48),
            entrySize: Number(reader.u64(at + 56))
        })
    }
    const names = namesIndex ? headers[namesIndex] : undefined
    const named = !!names && reader.fits(names.offset, names.size)
    const sections = headers.map(({ nameOffset, ...header }): ElfSectionHeader => ({
        ...header,
        name:
            named && header.index && nameOffset < names!.size
                ? (reader.string(names!.offset + nameOffset, names!.offset + names!.size) ?? '')
                : ''
    }))
    return { sections, named }
}

/** Whether a section's bytes lie inside the file. */
function holds(reader: ElfReader, section: ElfSectionHeader): boolean {
    return section.type !== SHT_NOBITS && reader.fits(section.offset, section.size)
}

/** The string table a symbol table's `sh_link` names, when it lies inside the file. */
function linkedStrings(
    reader: ElfReader,
    sections: readonly ElfSectionHeader[],
    table: ElfSectionHeader
): StringTable | undefined {
    const strings = sections[table.link]
    return strings && table.link && holds(reader, strings)
        ? { offset: strings.offset, end: strings.offset + strings.size }
        : undefined
}

/** `count` symbols from `offset`; names are '' when `strings` cannot hold them. */
function readSymbols(
    reader: ElfReader,
    offset: number,
    count: number,
    strings: StringTable | undefined,
    sections: readonly ElfSectionHeader[],
    extended?: { offset: number; count: number }
): ElfAnalysisSymbol[] {
    const symbols: ElfAnalysisSymbol[] = []
    const stringSize = strings ? strings.end - strings.offset : 0
    for (let index = 0; index < count; ++index) {
        const at = offset + index * SYMBOL_SIZE
        const nameOffset = reader.u32(at)
        const info = reader.bytes[at + 4]!
        const written = reader.u16(at + 6)
        let sectionIndex = written
        if (written === SHN_XINDEX && extended && index < extended.count)
            sectionIndex = reader.u32(extended.offset + index * 4)
        const special =
            written === SHN_UNDEF || (written >= SHN_LORESERVE && written !== SHN_XINDEX)
        symbols.push({
            index,
            name:
                strings && nameOffset < stringSize
                    ? (reader.string(strings.offset + nameOffset, strings.end) ?? '')
                    : '',
            value: reader.u64(at + 8),
            size: reader.u64(at + 16),
            binding: BINDINGS[info >> 4] ?? 'other',
            type: TYPES[info & 15] ?? 'other',
            visibility: VISIBILITIES[reader.bytes[at + 5]! & 3]!,
            sectionIndex,
            section: special ? null : (sections[sectionIndex] ?? null)
        })
    }
    return symbols
}

/** `.symtab`, when its entries and names fit the file. */
function readSymbolTable(
    reader: ElfReader,
    sections: readonly ElfSectionHeader[]
): ElfAnalysisSymbol[] {
    const table = sections.find((section) => section.type === SHT_SYMTAB)
    if (!table || table.entrySize !== SYMBOL_SIZE || !holds(reader, table)) return []
    const extended = sections.find(
        (section) => section.type === SHT_SYMTAB_SHNDX && section.link === table.index
    )
    return readSymbols(
        reader,
        table.offset,
        Math.floor(table.size / SYMBOL_SIZE),
        linkedStrings(reader, sections, table),
        sections,
        extended && holds(reader, extended)
            ? { offset: extended.offset, count: Math.floor(extended.size / 4) }
            : undefined
    )
}

/**
 * How many symbols DT_SYMTAB holds: DT_HASH's chain count, else the last symbol DT_GNU_HASH
 * reaches, else the room before DT_STRTAB; never more than its load segment's image can hold.
 */
function dynamicSymbolCount(
    reader: ElfReader,
    dynamic: DynamicEntry[],
    symbols: bigint,
    available: number
): number {
    const most = Math.floor(available / SYMBOL_SIZE)
    const hash = dynamicValue(dynamic, DT_HASH)
    const hashAt = hash === undefined ? undefined : reader.offsetOf(hash, 8)
    if (hashAt !== undefined) return Math.min(reader.u32(hashAt + 4), most)
    const gnu = dynamicValue(dynamic, DT_GNU_HASH)
    const gnuAt = gnu === undefined ? undefined : reader.map(gnu)
    if (gnuAt && gnuAt.available >= 16) {
        const buckets = reader.u32(gnuAt.offset)
        const first = reader.u32(gnuAt.offset + 4)
        const bloom = reader.u32(gnuAt.offset + 8)
        const bucketsAt = gnuAt.offset + 16 + bloom * 8
        const chainsAt = bucketsAt + buckets * 4
        const end = gnuAt.offset + gnuAt.available
        if (chainsAt <= end) {
            let last = 0
            for (let i = 0; i < buckets; ++i) last = Math.max(last, reader.u32(bucketsAt + i * 4))
            if (last < first) return Math.min(first, most)
            // Each chain ends with an odd hash; a chain that never does stops at the image's end.
            let index = last
            while (index < most) {
                const at = chainsAt + (index - first) * 4
                if (at + 4 > end || reader.u32(at) & 1) break
                ++index
            }
            return Math.min(index + 1, most)
        }
    }
    const strings = dynamicValue(dynamic, DT_STRTAB)
    if (strings !== undefined && strings > symbols)
        return Math.min(Number((strings - symbols) / BigInt(SYMBOL_SIZE)), most)
    return 0
}

type VersionTables = {
    /** Version names by index, from verdef (the file's own versions) and verneed (others'). */
    defined: Map<number, string>
    needed: Map<number, string>
}

/** Reads verdef (`defined`) or verneed entries, following their forward links. */
function readVersionTable(
    reader: ElfReader,
    start: number | undefined,
    count: number | undefined,
    strings: StringTable | undefined,
    kind: 'defined' | 'needed',
    into: VersionTables
) {
    if (start === undefined || !strings) return
    const name = (offset: number) =>
        offset < strings.end - strings.offset
            ? reader.string(strings.offset + offset, strings.end)
            : undefined
    // Links only go forward, but a corrupt table can still chain many tiny steps: cap them all.
    let steps = 2 * MAX_VERSIONS
    let at = start
    for (let n = 0; n < Math.min(count || MAX_VERSIONS, MAX_VERSIONS) && --steps > 0; ++n) {
        if (!reader.fits(at, kind === 'defined' ? 20 : 16)) return
        if (kind === 'defined') {
            const flags = reader.u16(at + 2)
            const index = reader.u16(at + 4) & 0x7fff
            const aux = at + reader.u32(at + 12)
            const version = reader.fits(aux, 8) ? name(reader.u32(aux)) : undefined
            if (version && !(flags & VER_FLG_BASE) && !into.defined.has(index))
                into.defined.set(index, version)
            const next = reader.u32(at + 16)
            if (!next) return
            at += next
        } else {
            let aux = at + reader.u32(at + 8)
            for (let k = 0; k < reader.u16(at + 2) && --steps > 0; ++k) {
                if (!reader.fits(aux, 16)) break
                const index = reader.u16(aux + 6) & 0x7fff
                const version = name(reader.u32(aux + 8))
                if (version && !into.needed.has(index)) into.needed.set(index, version)
                const next = reader.u32(aux + 12)
                if (!next) break
                aux += next
            }
            const next = reader.u32(at + 12)
            if (!next) return
            at += next
        }
    }
}

/**
 * The dynamic symbols with their versions, from `.dynsym` and the version sections when they are
 * usable, else from DT_SYMTAB, DT_STRTAB and the DT_VER* tables; and every version name the file
 * defines or needs.
 */
function readDynamicSymbols(
    reader: ElfReader,
    sections: readonly ElfSectionHeader[],
    dynamic: DynamicEntry[]
): { symbols: ElfAnalysisSymbol[]; versions: Set<string> } {
    let symbols: ElfAnalysisSymbol[] = []
    let strings: StringTable | undefined
    const table = sections.find((section) => section.type === SHT_DYNSYM)
    const tableStrings = table && linkedStrings(reader, sections, table)
    if (table && table.entrySize === SYMBOL_SIZE && holds(reader, table) && tableStrings) {
        strings = tableStrings
        symbols = readSymbols(
            reader,
            table.offset,
            Math.floor(table.size / SYMBOL_SIZE),
            strings,
            sections
        )
    } else {
        const address = dynamicValue(dynamic, DT_SYMTAB)
        const where = address === undefined ? undefined : reader.map(address)
        strings = dynamicStrings(reader, dynamic)
        if (where && address !== undefined) {
            const count = dynamicSymbolCount(reader, dynamic, address, where.available)
            symbols = readSymbols(reader, where.offset, count, strings, sections)
        }
    }

    const usable = (type: number) => {
        const section = sections.find((candidate) => candidate.type === type)
        return section && holds(reader, section) ? section : undefined
    }
    const fromDynamic = (tag: number) => {
        const address = dynamicValue(dynamic, tag)
        return address === undefined ? undefined : reader.map(address)?.offset
    }
    const versions: VersionTables = { defined: new Map(), needed: new Map() }
    const verdef = usable(SHT_GNU_VERDEF)
    const verneed = usable(SHT_GNU_VERNEED)
    const count = (tag: number) => {
        const value = dynamicValue(dynamic, tag)
        return value === undefined || value > BigInt(MAX_VERSIONS) ? undefined : Number(value)
    }
    readVersionTable(
        reader,
        verdef?.offset ?? fromDynamic(DT_VERDEF),
        verdef ? verdef.info : count(DT_VERDEFNUM),
        strings,
        'defined',
        versions
    )
    readVersionTable(
        reader,
        verneed?.offset ?? fromDynamic(DT_VERNEED),
        verneed ? verneed.info : count(DT_VERNEEDNUM),
        strings,
        'needed',
        versions
    )
    const versym = usable(SHT_GNU_VERSYM)
    const versymAt = versym?.offset ?? fromDynamic(DT_VERSYM)
    if (versymAt !== undefined && (versions.defined.size || versions.needed.size)) {
        symbols = symbols.map((symbol) => {
            const at = versymAt + symbol.index * 2
            if (!reader.fits(at, 2)) return symbol
            const value = reader.u16(at)
            const index = value & 0x7fff
            const defined = versions.defined.get(index)
            const version = defined ?? versions.needed.get(index)
            if (index < 2 || version === undefined) return symbol
            return {
                ...symbol,
                version,
                defaultVersion:
                    defined !== undefined &&
                    !(value & VERSYM_HIDDEN) &&
                    symbol.sectionIndex !== SHN_UNDEF
            }
        })
    }
    return {
        symbols,
        versions: new Set([...versions.defined.values(), ...versions.needed.values()])
    }
}

/**
 * `.symtab` names with a `@VERSION` or `@@VERSION` suffix lose it when VERSION is one of the file's
 * versions; any other `@` is part of the name (a NASM label may hold one).
 */
function stripVersions(symbols: ElfAnalysisSymbol[], versions: Set<string>): ElfAnalysisSymbol[] {
    if (!versions.size) return symbols
    return symbols.map((symbol) => {
        const at = symbol.name.lastIndexOf('@')
        if (at < 0) return symbol
        const version = symbol.name.slice(at + 1)
        if (!versions.has(version)) return symbol
        const defaultVersion = at > 0 && symbol.name[at - 1] === '@'
        return {
            ...symbol,
            name: symbol.name.slice(0, defaultVersion ? at - 1 : at),
            version,
            defaultVersion
        }
    })
}

type Relocations = {
    relocations: ElfRelocation[]
    /** Each RELA entry by its file offset. */
    entries: Map<number, ElfRelocation>
    /** The file offset and size of the PLT relocation table, which `push` in a lazy stub indexes. */
    jumpTable: { offset: number; size: number } | undefined
}

/**
 * RELR packs relative relocations as addresses, each followed by bitmaps of the 63 words after it.
 * A bitmap word names up to 63 slots, but a file holds no more distinct slots than 8-byte words, so
 * all RELR tables together yield at most `budget.left` relocations.
 */
function decodeRelr(
    reader: ElfReader,
    offset: number,
    size: number,
    table: string,
    into: ElfRelocation[],
    budget: { left: number }
) {
    let where = 0n
    const add = (address: bigint) => {
        if (--budget.left < 0) return
        // Relative relocations patch file-backed data; a slot outside it is corrupt.
        const at = reader.offsetOf(address, 8)
        if (at !== undefined)
            into.push({
                address,
                type: R_X86_64_RELATIVE,
                symbol: '',
                addend: reader.i64(at),
                table
            })
    }
    for (let at = offset; at + 8 <= offset + size && budget.left > 0; at += 8) {
        const low = reader.u32(at)
        const high = reader.u32(at + 4)
        if (!(low & 1)) {
            where = reader.u64(at)
            add(where)
            where += 8n
            continue
        }
        for (let bit = 1; bit < 64; ++bit) {
            const set = bit < 32 ? (low >>> bit) & 1 : (high >>> (bit - 32)) & 1
            if (set) add(where + BigInt((bit - 1) * 8))
        }
        where += 63n * 8n
    }
}

/**
 * The relocation tables of allocated RELA and RELR sections, then whatever DT_RELA, DT_JMPREL and
 * DT_RELR describe that no section did.
 */
function readRelocations(
    reader: ElfReader,
    result: ElfAnalysis,
    dynamic: DynamicEntry[]
): Relocations {
    const relocations: ElfRelocation[] = []
    const entries = new Map<number, ElfRelocation>()
    const { sections } = result
    const readRela = (
        offset: number,
        size: number,
        table: string,
        names: readonly ElfAnalysisSymbol[],
        skip?: { offset: number; size: number }
    ) => {
        for (let at = offset; at + RELA_SIZE <= offset + size; at += RELA_SIZE) {
            if (entries.has(at)) continue
            if (skip && at >= skip.offset && at < skip.offset + skip.size) continue
            const relocation: ElfRelocation = {
                address: reader.u64(at),
                type: reader.u32(at + 8),
                symbol: names[reader.u32(at + 12)]?.name ?? '',
                addend: reader.i64(at + 16),
                table
            }
            entries.set(at, relocation)
            relocations.push(relocation)
        }
    }

    // Overlapping tables are read once: a later one that overlaps an earlier one is skipped.
    const tables = sections
        .filter(
            (section) =>
                ((section.type === SHT_RELA &&
                    section.entrySize === RELA_SIZE &&
                    section.flags & SHF_ALLOC) ||
                    (section.type === SHT_RELR &&
                        (section.entrySize === 8 || !section.entrySize))) &&
                holds(reader, section)
        )
        .sort((a, b) => a.offset - b.offset || a.index - b.index)
    let reached = 0
    const accepted = tables
        .filter((section) => {
            if (section.size && section.offset < reached) return false
            reached = Math.max(reached, section.offset + section.size)
            return true
        })
        .sort((a, b) => a.index - b.index)
    const relrRead: ElfSectionHeader[] = []
    const relrBudget = { left: Math.floor(reader.length / 8) + 64 }
    for (const section of accepted) {
        const table = section.name || `section ${section.index}`
        if (section.type === SHT_RELR) {
            relrRead.push(section)
            decodeRelr(reader, section.offset, section.size, table, relocations, relrBudget)
            continue
        }
        const linked = sections[section.link]
        const names =
            section.link && linked?.type === SHT_DYNSYM
                ? result.dynamicSymbols
                : section.link && linked?.type === SHT_SYMTAB
                  ? result.symbols
                  : []
        readRela(section.offset, section.size, table, names)
    }

    const range = (addressTag: number, sizeTag: number) => {
        const address = dynamicValue(dynamic, addressTag)
        const size = dynamicValue(dynamic, sizeTag)
        const where = address === undefined ? undefined : reader.map(address)
        if (!where || size === undefined) return undefined
        return {
            offset: where.offset,
            size: size > BigInt(where.available) ? where.available : Number(size)
        }
    }
    const pltRelocationType = dynamicValue(dynamic, DT_PLTREL)
    const jumps =
        pltRelocationType === undefined || pltRelocationType === BigInt(DT_RELA)
            ? range(DT_JMPREL, DT_PLTRELSZ)
            : undefined
    const rela = range(DT_RELA, DT_RELASZ)
    if (rela) readRela(rela.offset, rela.size, 'DT_RELA', result.dynamicSymbols, jumps)
    if (jumps) readRela(jumps.offset, jumps.size, 'DT_JMPREL', result.dynamicSymbols)
    const relr = range(DT_RELR, DT_RELRSZ)
    if (
        relr &&
        !relrRead.some(
            (section) =>
                relr.offset >= section.offset && relr.offset < section.offset + section.size
        )
    )
        decodeRelr(reader, relr.offset, relr.size, 'DT_RELR', relocations, relrBudget)

    // Without a dynamic section (a static program), `.rela.plt` is the table lazy stubs index.
    const staticJumps = sections.find(
        (section) => section.type === SHT_RELA && section.name === '.rela.plt'
    )
    return {
        relocations,
        entries,
        jumpTable:
            jumps ??
            (staticJumps && holds(reader, staticJumps)
                ? { offset: staticJumps.offset, size: staticJumps.size }
                : undefined)
    }
}

/** A PLT entry recognised from its bytes. */
type PltEntry = {
    /** Offset from the start of the scanned range, and file offset. */
    delta: number
    at: number
    length: number
    kind: 'plt0' | 'jump' | 'lazy'
    /** For a jump: the slot of its `jmp [rip+disp32]`, as an offset from the entry's address. */
    slot?: bigint
    /** For a lazy stub: the `push` immediate (its index in the PLT relocation table) and `jmp` target. */
    index?: number
    target?: bigint
}

const ENDBR64 = [0xf3, 0x0f, 0x1e, 0xfa]

/** Whether `pattern` (-1 matching any byte) lies at `offset`, before `end`. */
function matches(bytes: Uint8Array, offset: number, end: number, pattern: readonly number[]) {
    if (offset + pattern.length > end) return false
    for (let i = 0; i < pattern.length; ++i)
        if (pattern[i]! >= 0 && bytes[offset + i] !== pattern[i]) return false
    return true
}

/**
 * The PLT entry at file offset `at`, decoded by hand: `[endbr64] [bnd] jmp [rip+disp32]`, a lazy
 * `[endbr64] push imm32; [bnd] jmp rel32`, or (strictly only) PLT0. `strict` asks for the whole
 * entry exactly as `ld` and `lld` write it, padding included, for scanning code without sections.
 */
function matchPltEntry(
    reader: ElfReader,
    at: number,
    end: number,
    strict: boolean,
    aligned16: boolean
): Omit<PltEntry, 'delta' | 'at'> | undefined {
    const bytes = reader.bytes
    const is = (offset: number, pattern: readonly number[]) => matches(bytes, offset, end, pattern)
    if (strict) {
        // Every strict form but the 8-byte non-lazy one fills a 16-byte, 16-aligned entry.
        if (aligned16 && is(at, [0xff, 0x35]) && at + 16 <= end) {
            const bnd = bytes[at + 6] === 0xf2 ? 1 : 0
            if (
                is(at + 6 + bnd, [0xff, 0x25]) &&
                is(at + 12 + bnd, bnd ? [0x0f, 0x1f, 0x00] : [0x0f, 0x1f, 0x40, 0x00])
            )
                return { length: 16, kind: 'plt0' }
        }
    }
    let p = at
    const endbr = is(p, ENDBR64)
    if (endbr) p += 4
    const bnd = bytes[p] === 0xf2 ? 1 : 0
    if (is(p + bnd, [0xff, 0x25])) {
        const after = p + bnd + 6
        if (after > end) return undefined
        const slot = BigInt(after - at) + BigInt(reader.i32(p + bnd + 2))
        if (!strict) return { length: after - at, kind: 'jump', slot }
        if (endbr) {
            const pad = bnd ? [0x0f, 0x1f, 0x44, 0x00, 0x00] : [0x66, 0x0f, 0x1f, 0x44, 0x00, 0x00]
            return aligned16 && is(after, pad) ? { length: 16, kind: 'jump', slot } : undefined
        }
        if (is(after, bnd ? [0x90] : [0x66, 0x90])) return { length: 8, kind: 'jump', slot }
        // The classic lazy entry: the jump, then the push and jump that bind it.
        if (!bnd && aligned16 && is(after, [0x68, -1, -1, -1, -1, 0xe9]) && after + 10 <= end)
            return { length: 16, kind: 'jump', slot }
        return undefined
    }
    if (bytes[p] === 0x68 && p + 5 <= end) {
        const index = reader.u32(p + 1)
        const q = p + 5
        const jumpBnd = bytes[q] === 0xf2 ? 1 : 0
        if (!is(q + jumpBnd, [0xe9]) || q + jumpBnd + 5 > end) return undefined
        const after = q + jumpBnd + 5
        const target = BigInt(after - at) + BigInt(reader.i32(q + jumpBnd + 1))
        if (!strict) return { length: after - at, kind: 'lazy', index, target }
        const pad = endbr
            ? jumpBnd
                ? [0x90]
                : [0x66, 0x90]
            : jumpBnd
              ? [0x0f, 0x1f, 0x44, 0x00, 0x00]
              : undefined
        return aligned16 && pad && after - at + pad.length === 16 && is(after, pad)
            ? { length: 16, kind: 'lazy', index, target }
            : undefined
    }
    return undefined
}

/**
 * Whether `a` names an address better than `b`: fewer leading underscores (`strnlen` before
 * `__strnlen`), then global before weak before local, the shorter, then code-unit order.
 */
function preferredName(a: ElfAnalysisSymbol, b: ElfAnalysisSymbol): boolean {
    const rank = (symbol: ElfAnalysisSymbol) => [
        /^_*/.exec(symbol.name)![0].length,
        { global: 0, unique: 0, weak: 1, local: 2, other: 3 }[symbol.binding],
        symbol.name.length
    ]
    const x = rank(a)
    const y = rank(b)
    for (let i = 0; i < x.length; ++i) if (x[i] !== y[i]) return x[i]! < y[i]!
    return a.name < b.name
}

/**
 * The PLT stubs, each named after the relocation of the slot it jumps through, or, for a lazy
 * stub, of the slot whose initial value points at it (else the relocation its `push` indexes).
 * When sections name usable PLT sections only those are scanned; otherwise the executable load
 * segments are, for runs of whole PLT entries exactly as linkers write them.
 */
function readPlt(
    reader: ElfReader,
    result: ElfAnalysis,
    relocations: Relocations,
    named: boolean
): ElfPltStub[] {
    const slots = new Map<bigint, ElfRelocation>()
    for (const relocation of relocations.relocations)
        if (
            (relocation.type === R_X86_64_JUMP_SLOT ||
                relocation.type === R_X86_64_GLOB_DAT ||
                relocation.type === R_X86_64_IRELATIVE) &&
            !slots.has(relocation.address)
        )
            slots.set(relocation.address, relocation)
    if (!slots.size) return []

    let functions: Map<bigint, ElfAnalysisSymbol> | undefined
    const functionAt = (address: bigint) => {
        if (!functions) {
            functions = new Map()
            for (const symbol of [...result.symbols, ...result.dynamicSymbols]) {
                if (symbol.type !== 'function' && symbol.type !== 'ifunc') continue
                if (!symbol.name || symbol.sectionIndex === SHN_UNDEF) continue
                if (symbol.sectionIndex >= SHN_LORESERVE && !symbol.section) continue
                const current = functions.get(symbol.value)
                if (!current || preferredName(symbol, current)) functions.set(symbol.value, symbol)
            }
        }
        return functions.get(address)?.name
    }
    const slotName = (relocation: ElfRelocation | undefined) =>
        !relocation
            ? undefined
            : relocation.type === R_X86_64_IRELATIVE
              ? functionAt(BigInt.asUintN(64, relocation.addend))
              : relocation.symbol || undefined

    // A lazy stub is where its slot points before binding.
    let initial: Map<bigint, ElfRelocation> | undefined
    const lazyRelocation = (address: bigint, index: number) => {
        if (!initial) {
            initial = new Map()
            for (const relocation of slots.values()) {
                if (relocation.type === R_X86_64_GLOB_DAT) continue
                const at = reader.offsetOf(relocation.address, 8)
                if (at === undefined) continue
                const value = reader.u64(at)
                if (!initial.has(value)) initial.set(value, relocation)
            }
        }
        const pointing = initial.get(address)
        if (pointing) return pointing
        const table = relocations.jumpTable
        if (!table || index >= Math.floor(table.size / RELA_SIZE)) return undefined
        const indexed = relocations.entries.get(table.offset + index * RELA_SIZE)
        return indexed && indexed.type !== R_X86_64_GLOB_DAT ? indexed : undefined
    }

    const stubs = new Map<bigint, ElfPltStub>()
    const name = (entry: PltEntry, address: bigint) => {
        if (entry.kind === 'jump') {
            const got = address + entry.slot!
            const stub = slotName(slots.get(got))
            if (stub && !stubs.has(address))
                stubs.set(address, { address, name: `${stub}@plt`, got })
        } else if (entry.kind === 'lazy') {
            const relocation = lazyRelocation(address, entry.index!)
            const stub = slotName(relocation)
            if (stub && !stubs.has(address))
                stubs.set(address, {
                    address,
                    name: `${stub}@plt_resolver`,
                    got: relocation!.address
                })
        }
    }

    const isPlt = (section: ElfSectionHeader) =>
        section.name === '.plt' || section.name.startsWith('.plt.') || section.name === '.iplt'
    // Overlapping sections or segments are scanned once, and the scan never covers more positions
    // than the file holds, whatever a corrupt header table repeats.
    let positions = Math.ceil(reader.length / 8) + 64
    let reached = 0
    const pltSections = (named ? result.sections : [])
        .filter(
            (section) => isPlt(section) && section.flags & SHF_EXECINSTR && holds(reader, section)
        )
        .sort((a, b) => a.offset - b.offset)
        .filter((section) => {
            if (section.offset < reached) return false
            reached = section.offset + section.size
            return true
        })
    if (pltSections.length) {
        // `.plt` holds lazy stubs worth naming only when the jumps live in `.plt.sec` (or `.plt.bnd`).
        const separate = result.sections.some(
            (section) => section.name === '.plt.sec' || section.name === '.plt.bnd'
        )
        for (const section of pltSections) {
            const end = section.offset + section.size
            for (let delta = 0; delta + 6 <= section.size && --positions > 0;) {
                const at = section.offset + delta
                const match = matchPltEntry(reader, at, end, false, false)
                if (match && (match.kind === 'jump' || (separate && section.name === '.plt')))
                    name({ ...match, delta, at }, section.address + BigInt(delta))
                delta = match ? (delta + match.length + 7) & ~7 : delta + 8
            }
        }
    } else {
        for (const image of reader.images) {
            if (!image.executable) continue
            const phase = Number(image.start & 15n)
            const entries: PltEntry[] = []
            const size = Number(image.end - image.start)
            const end = image.offset + size
            for (let delta = (8 - (phase & 7)) & 7; delta + 8 <= size && --positions > 0;) {
                const at = image.offset + delta
                // Every entry starts with endbr64, bnd, jmp [rip+disp32], push imm32 or push [rip+disp32].
                const first = reader.bytes[at]
                if (first !== 0xf3 && first !== 0xf2 && first !== 0xff && first !== 0x68) {
                    delta += 8
                    continue
                }
                const match = matchPltEntry(reader, at, end, true, ((phase + delta) & 15) === 0)
                if (match) {
                    entries.push({ ...match, delta, at })
                    delta += match.length
                } else delta += 8
            }
            // Only runs of whole entries count: two or more back to back, or one after a PLT0.
            const plt0 = new Set(
                entries.filter((entry) => entry.kind === 'plt0').map((entry) => entry.delta)
            )
            for (let i = 0; i < entries.length;) {
                let j = i + 1
                while (
                    j < entries.length &&
                    entries[j]!.delta === entries[j - 1]!.delta + entries[j - 1]!.length
                )
                    ++j
                const run = entries.slice(i, j)
                if (run.length >= 2 || run.some((entry) => entry.kind === 'plt0'))
                    for (const entry of run) {
                        if (
                            entry.kind === 'lazy' &&
                            !plt0.has(Number(BigInt(entry.delta) + entry.target!))
                        )
                            continue
                        name(entry, image.start + BigInt(entry.delta))
                    }
                i = j
            }
        }
    }
    return [...stubs.values()].sort((a, b) =>
        a.address < b.address ? -1 : a.address > b.address ? 1 : 0
    )
}

export type { ElfSectionHeader, ElfSymbol } from '../elf-symbols'
