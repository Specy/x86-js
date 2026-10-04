// The ELF64 symbol-table reader: every symbol of an object or an executable, with its section, as
// the compiler-output oracles and the Runtime library's index read them.
import { describe, expect, it } from 'vitest'
import {
    ELF_SECTION_ABSOLUTE,
    ELF_SECTION_COMMON,
    ELF_SECTION_FLAGS,
    ELF_SECTION_LARGE_COMMON,
    ELF_SECTION_NO_BITS,
    ELF_SECTION_UNDEFINED,
    readDefinedGlobalSymbols,
    readElfSectionBytes,
    readElfSymbolTable,
    type ElfSymbol,
    type ElfSymbolTable,
} from '../src/elf-symbols'
import { nasmWasmAssembler } from '../src/wasm-assembler'
import { createX86Emulator } from '../src/x86-emulator'

const SOURCE = [
    'default rel',
    'extern outside',
    'extern maybe:weak',
    'global _start:function',
    'global value:data 4',
    'global soft:weak',
    'common shared 8:4',
    'section .text',
    '_start:',
    '    call outside',
    '    call maybe',
    '.inner:',
    '    mov eax, [value]',
    '    mov eax, 60',
    '    syscall',
    'local_code:',
    '    ret',
    'soft:',
    '    ret',
    'section .data',
    'value: dd 7',
    'section .bss',
    'zeros: resb 16',
    'section .rodata',
    'constant: dq 0x1122334455667788',
].join('\n')

async function assemble(source: string): Promise<Uint8Array> {
    const result = await nasmWasmAssembler.assemble({ entry: 'unit.asm', files: { 'unit.asm': source } })
    if (!result.object) throw new Error(result.stderr)
    return result.object
}

function symbol(table: ElfSymbolTable, name: string): ElfSymbol {
    const found = table.symbols.filter((candidate) => candidate.name === name)
    expect(found, name).toHaveLength(1)
    return found[0]!
}

function section(table: ElfSymbolTable, name: string) {
    const found = table.sections.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no section ${name}`)
    return found
}

describe('an object file', () => {
    it('reads every symbol with its binding, type, size and section', async () => {
        const table = readElfSymbolTable(await assemble(SOURCE))
        expect(table.fileType).toBe(1)
        expect(table.entry).toBe(0n)
        expect(table.symbols[0]).toMatchObject({ index: 0, name: '', binding: 'local', sectionIndex: 0, section: null })
        expect(table.symbols.map((entry) => entry.index)).toEqual(table.symbols.map((_, index) => index))

        const pick = (name: string) => {
            const { binding, type, visibility, sectionIndex, section, value, size } = symbol(table, name)
            return { binding, type, visibility, sectionIndex, section: section?.name ?? null, value, size }
        }
        expect(pick('_start')).toEqual({
            binding: 'global',
            type: 'function',
            visibility: 'default',
            sectionIndex: section(table, '.text').index,
            section: '.text',
            value: 0n,
            size: 0n,
        })
        expect(pick('value')).toMatchObject({
            binding: 'global',
            type: 'object',
            section: '.data',
            value: 0n,
            size: 4n,
        })
        expect(pick('soft')).toMatchObject({ binding: 'weak', section: '.text' })
        expect(pick('_start.inner')).toMatchObject({ binding: 'local', section: '.text', value: 10n })
        expect(pick('local_code')).toMatchObject({ binding: 'local', section: '.text' })
        expect(pick('zeros')).toMatchObject({ binding: 'local', section: '.bss', value: 0n })
        expect(pick('constant')).toMatchObject({ binding: 'local', section: '.rodata', value: 0n })
        // Referenced but not defined, one of them weakly.
        expect(pick('outside')).toMatchObject({ binding: 'global', sectionIndex: ELF_SECTION_UNDEFINED, section: null })
        expect(pick('maybe')).toMatchObject({ binding: 'weak', sectionIndex: ELF_SECTION_UNDEFINED, section: null })
        // A common symbol's value is its alignment until the linker places it.
        expect(pick('shared')).toMatchObject({
            binding: 'global',
            sectionIndex: ELF_SECTION_COMMON,
            section: null,
            value: 4n,
            size: 8n,
        })
        // NASM names the file the assembler read, as an absolute symbol, and gives each section one.
        expect(pick('/assembly.s')).toMatchObject({
            binding: 'local',
            type: 'file',
            sectionIndex: ELF_SECTION_ABSOLUTE,
        })
        const sectionSymbols = table.symbols
            .filter((entry) => entry.type === 'section')
            .map((entry) => entry.section?.name)
        expect(sectionSymbols).toEqual(expect.arrayContaining(['.text', '.data', '.bss', '.rodata']))
    })

    it('reads the section headers, so a symbol leads to its bytes', async () => {
        const bytes = await assemble(SOURCE)
        const table = readElfSymbolTable(bytes)
        expect(table.sections[0]).toMatchObject({ index: 0, name: '', type: 0, size: 0 })
        const { alloc, write, execute } = ELF_SECTION_FLAGS
        expect(section(table, '.text').flags).toBe(alloc | execute)
        expect(section(table, '.data').flags).toBe(alloc | write)
        expect(section(table, '.rodata').flags).toBe(alloc)
        expect(section(table, '.bss')).toMatchObject({ type: ELF_SECTION_NO_BITS, flags: alloc | write, size: 16 })

        const bytesOf = (name: string, length: number) => {
            const { section: home, value } = symbol(table, name)
            return [...readElfSectionBytes(bytes, home!).subarray(Number(value), Number(value) + length)]
        }
        expect(bytesOf('value', 4)).toEqual([7, 0, 0, 0])
        expect(bytesOf('constant', 8)).toEqual([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
        // .bss takes no room in the file and reads as the zeros it holds once loaded.
        expect(readElfSectionBytes(bytes, section(table, '.bss'))).toEqual(new Uint8Array(16))
        // A range reads only those bytes, from a section in the file or from .bss alike.
        expect([...readElfSectionBytes(bytes, section(table, '.rodata'), 2, 3)]).toEqual([0x66, 0x55, 0x44])
        expect(readElfSectionBytes(bytes, section(table, '.bss'), 12, 4)).toEqual(new Uint8Array(4))
        expect(() => readElfSectionBytes(bytes, section(table, '.bss'), 12, 5)).toThrow(/lie outside it/)
        expect(() => readElfSectionBytes(bytes, section(table, '.rodata'), -1, 2)).toThrow(/invalid range/)
    })

    it('agrees with readDefinedGlobalSymbols, which it leaves as it was', async () => {
        const bytes = await assemble(SOURCE)
        const defined = readElfSymbolTable(bytes)
            .symbols.filter((entry) => entry.binding !== 'local' && entry.sectionIndex !== ELF_SECTION_UNDEFINED)
            .map((entry) => entry.name)
        expect(readDefinedGlobalSymbols(bytes)).toEqual(defined)
        expect(defined.sort()).toEqual(['_start', 'shared', 'soft', 'value'])
    })
})

describe('an executable', () => {
    it('reads addresses, the entry point and the symbols the linker added', async () => {
        // Linked, so nothing may stay undefined but the weak reference.
        const program = SOURCE.replace('extern outside\n', '').replace('    call outside\n', '')
        const emulator = await createX86Emulator()
        let bytes: Uint8Array
        try {
            const build = await emulator.compileProject({ entry: 'unit.asm', files: { 'unit.asm': program } })
            expect(build.ok, build.report).toBe(true)
            bytes = Uint8Array.from(emulator.module.FS.readFile('/program') as Uint8Array)
        } finally {
            emulator.dispose()
        }
        const table = readElfSymbolTable(bytes)
        expect(table.fileType).toBe(2)
        expect(table.entry).toBe(symbol(table, '_start').value)
        expect(symbol(table, '_start').value).toBe(section(table, '.text').address)

        const value = symbol(table, 'value')
        const data = section(table, '.data')
        expect(value.section).toBe(data)
        const offset = Number(value.value - data.address)
        expect([...readElfSectionBytes(bytes, data).subarray(offset, offset + 4)]).toEqual([7, 0, 0, 0])
        // The linker allocated the common symbol in .bss and added symbols of its own.
        expect(symbol(table, 'shared')).toMatchObject({ binding: 'global', section: section(table, '.bss'), size: 8n })
        expect(symbol(table, '_end')).toMatchObject({ binding: 'global', section: section(table, '.bss') })
        for (const entry of table.symbols) {
            if (!entry.section || entry.type === 'section') continue
            const { address, size } = entry.section
            expect(entry.value >= address && entry.value <= address + BigInt(size), entry.name).toBe(true)
        }
    })
})

/**
 * A minimal little-endian ELF64 object: the given sections after the null one, then the section
 * name table, the symbol name table and the symbol table, whose symbols follow the null symbol.
 */
function buildElf(options: {
    /** `size` stands for the bytes of a section that has none in the file, such as `.bss`. */
    sections?: { name: string; type: number; bytes?: number[]; size?: number }[]
    symbols?: { name: string; info: number; sectionIndex: number; value?: bigint; size?: bigint }[]
    extendedIndexes?: number[]
    countInSectionZero?: boolean
}): Uint8Array {
    const strings = (names: string[]) => {
        const offsets: number[] = []
        const bytes = [0]
        for (const name of names) {
            offsets.push(bytes.length)
            bytes.push(...new TextEncoder().encode(name), 0)
        }
        return { offsets, bytes }
    }
    const sections = [...(options.sections ?? [])]
    const symbols = options.symbols ?? []
    const symbolNames = strings(symbols.map((entry) => entry.name))
    const symbolBytes = new Uint8Array(24 * (symbols.length + 1))
    const symbolView = new DataView(symbolBytes.buffer)
    symbols.forEach((entry, index) => {
        const offset = 24 * (index + 1)
        symbolView.setUint32(offset, symbolNames.offsets[index]!, true)
        symbolView.setUint8(offset + 4, entry.info)
        symbolView.setUint16(offset + 6, entry.sectionIndex, true)
        symbolView.setBigUint64(offset + 8, entry.value ?? 0n, true)
        symbolView.setBigUint64(offset + 16, entry.size ?? 0n, true)
    })
    const symtabIndex = sections.length + 3
    type Entry = { name: string; type: number; bytes?: number[]; size?: number; link: number; entrySize: number }
    const all: Entry[] = [
        ...sections.map((entry) => ({ ...entry, link: 0, entrySize: 0 })),
        { name: '.shstrtab', type: 3, bytes: [] as number[], link: 0, entrySize: 0 },
        { name: '.strtab', type: 3, bytes: symbolNames.bytes, link: 0, entrySize: 0 },
        { name: '.symtab', type: 2, bytes: [...symbolBytes], link: sections.length + 2, entrySize: 24 },
    ]
    if (options.extendedIndexes) {
        const indexes = new Uint8Array(4 * options.extendedIndexes.length)
        options.extendedIndexes.forEach((value, index) =>
            new DataView(indexes.buffer).setUint32(4 * index, value, true),
        )
        all.push({ name: '.symtab_shndx', type: 18, bytes: [...indexes], link: symtabIndex, entrySize: 4 })
    }
    const sectionNames = strings(all.map((entry) => entry.name))
    all[sections.length]!.bytes = sectionNames.bytes

    const contents: number[] = []
    const offsets = all.map((entry) => {
        const offset = 64 + contents.length
        contents.push(...(entry.bytes ?? []))
        return offset
    })
    const tableOffset = 64 + contents.length
    const file = new Uint8Array(tableOffset + 64 * (all.length + 1))
    const view = new DataView(file.buffer)
    file.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
    view.setUint16(16, 1, true)
    view.setUint16(18, 62, true)
    view.setBigUint64(40, BigInt(tableOffset), true)
    view.setUint16(52, 64, true)
    view.setUint16(58, 64, true)
    view.setUint16(60, options.countInSectionZero ? 0 : all.length + 1, true)
    view.setUint16(62, options.countInSectionZero ? 0xffff : sections.length + 1, true)
    file.set(contents, 64)
    if (options.countInSectionZero) {
        view.setBigUint64(tableOffset + 32, BigInt(all.length + 1), true)
        view.setUint32(tableOffset + 40, sections.length + 1, true)
    }
    all.forEach((entry, index) => {
        const header = tableOffset + 64 * (index + 1)
        view.setUint32(header, sectionNames.offsets[index]!, true)
        view.setUint32(header + 4, entry.type, true)
        view.setBigUint64(header + 24, BigInt(offsets[index]!), true)
        view.setBigUint64(header + 32, BigInt(entry.size ?? entry.bytes?.length ?? 0), true)
        view.setUint32(header + 40, entry.link, true)
        view.setBigUint64(header + 56, BigInt(entry.entrySize), true)
    })
    return file
}

describe('the file format itself', () => {
    const data = { name: '.data', type: 1, bytes: [1, 2, 3, 4] }
    const global = (name: string, sectionIndex: number) => ({ name, info: 0x11, sectionIndex })

    it('reads a hand-built file the same way', () => {
        const table = readElfSymbolTable(buildElf({ sections: [data], symbols: [global('item', 1)] }))
        expect(table.sections.map((entry) => entry.name)).toEqual(['', '.data', '.shstrtab', '.strtab', '.symtab'])
        expect(table.symbols.map((entry) => [entry.name, entry.binding, entry.type, entry.section?.name])).toEqual([
            ['', 'local', 'notype', undefined],
            ['item', 'global', 'object', '.data'],
        ])
    })

    it('names bindings and types beyond the common ones, and keeps visibility', () => {
        const table = readElfSymbolTable(
            buildElf({
                sections: [data],
                symbols: [
                    { name: 'unique', info: 0xa1, sectionIndex: 1 },
                    { name: 'resolver', info: 0x1a, sectionIndex: 1 },
                    { name: 'odd', info: 0x3d, sectionIndex: 1 },
                    { name: 'thread', info: 0x16, sectionIndex: 1 },
                ],
            }),
        )
        expect(table.symbols.slice(1).map((entry) => [entry.binding, entry.type])).toEqual([
            ['unique', 'object'],
            ['global', 'ifunc'],
            ['other', 'other'],
            ['global', 'tls'],
        ])
    })

    it('follows the extended section numbering of very large files', () => {
        const table = readElfSymbolTable(
            buildElf({
                sections: [data],
                symbols: [global('far', 0xffff)],
                extendedIndexes: [0, 1],
                countInSectionZero: true,
            }),
        )
        expect(table.sections).toHaveLength(6)
        expect(symbol(table, 'far')).toMatchObject({ sectionIndex: 1, section: table.sections[1] })
    })

    it('throws for an extended section index it cannot resolve, rather than give the symbol no section', () => {
        const far = { sections: [data], symbols: [global('far', 0xffff)], countInSectionZero: true }
        expect(() => readElfSymbolTable(buildElf(far))).toThrow(/far.*no SHT_SYMTAB_SHNDX section/)
        // An index table that stops before the symbol: only the null symbol has one.
        expect(() => readElfSymbolTable(buildElf({ ...far, extendedIndexes: [0] }))).toThrow(
            /far.*past the end of the extended section index table/,
        )
        expect(() => readElfSymbolTable(buildElf({ sections: [data], symbols: [global('lost', 42)] }))).toThrow(
            /lost.*names section 42, which does not exist/,
        )
    })

    it('reads a reserved section index, a large common one included, as naming no section', () => {
        const bytes = buildElf({
            sections: [data],
            symbols: [
                { name: 'huge', info: 0x11, sectionIndex: ELF_SECTION_LARGE_COMMON, value: 64n, size: 1n << 33n },
                { name: 'shared', info: 0x11, sectionIndex: ELF_SECTION_COMMON, value: 8n, size: 8n },
                { name: 'fixed', info: 0x10, sectionIndex: ELF_SECTION_ABSOLUTE, value: 5n },
                { name: 'processor', info: 0x10, sectionIndex: 0xff1f },
            ],
            countInSectionZero: true,
        })
        const read = (file: Uint8Array) =>
            readElfSymbolTable(file).symbols.map(({ name, sectionIndex, section, value }) => [
                name,
                sectionIndex,
                section,
                value,
            ])
        const expected = [
            ['', 0, null, 0n],
            ['huge', ELF_SECTION_LARGE_COMMON, null, 64n],
            ['shared', ELF_SECTION_COMMON, null, 8n],
            ['fixed', ELF_SECTION_ABSOLUTE, null, 5n],
            ['processor', 0xff1f, null, 0n],
        ]
        expect(read(bytes)).toEqual(expected)
        // Even in a file with more sections than that, where a section of that index exists: blank
        // section headers appended to the table, which ends the file, and counted in section 0.
        const count = 0xff20
        const large = new Uint8Array(bytes.length + 64 * (count - readElfSymbolTable(bytes).sections.length))
        large.set(bytes)
        const view = new DataView(large.buffer)
        view.setBigUint64(Number(view.getBigUint64(40, true)) + 32, BigInt(count), true)
        expect(readElfSymbolTable(large).sections).toHaveLength(count)
        expect(read(large)).toEqual(expected)
    })

    it('throws for a symbol table that is not a whole number of entries', () => {
        const bytes = buildElf({ sections: [data], symbols: [global('item', 1)] })
        const symtab = readElfSymbolTable(bytes).sections.find((entry) => entry.name === '.symtab')!
        const view = new DataView(bytes.buffer)
        const header = Number(view.getBigUint64(40, true)) + 64 * symtab.index
        view.setBigUint64(header + 32, BigInt(symtab.size - 1), true)
        expect(() => readElfSymbolTable(bytes)).toThrow(/not a whole number of 24-byte entries/)
    })

    it('reads a range of a section without bytes in the file, without allocating all of it', () => {
        // A terabyte of .bss: allocating it whole would throw.
        const bytes = buildElf({ sections: [data, { name: '.bss', type: ELF_SECTION_NO_BITS, size: 2 ** 40 }] })
        const bss = readElfSymbolTable(bytes).sections.find((entry) => entry.name === '.bss')!
        expect(bss.size).toBe(2 ** 40)
        expect(readElfSectionBytes(bytes, bss, 2 ** 39, 8)).toEqual(new Uint8Array(8))
        expect(() => readElfSectionBytes(bytes, bss, 2 ** 40 - 4, 8)).toThrow(/lie outside it/)
        const words = readElfSymbolTable(bytes).sections.find((entry) => entry.name === '.data')!
        expect([...readElfSectionBytes(bytes, words, 1, 2)]).toEqual([2, 3])
    })

    it('reads a file without a symbol table as one without symbols', () => {
        const bytes = buildElf({ sections: [data], symbols: [global('item', 1)] })
        const table = readElfSymbolTable(bytes)
        const view = new DataView(bytes.buffer)
        // Retype .symtab as plain data.
        const tableOffset = Number(view.getBigUint64(40, true))
        view.setUint32(tableOffset + 64 * table.sections.findIndex((entry) => entry.name === '.symtab') + 4, 1, true)
        expect(readElfSymbolTable(bytes).symbols).toEqual([])
        view.setBigUint64(40, 0n, true)
        expect(readElfSymbolTable(bytes)).toMatchObject({ sections: [], symbols: [] })
    })

    it('throws rather than read past the file or guess at another format', () => {
        const valid = () => buildElf({ sections: [data], symbols: [global('item', 1)] })
        expect(() => readElfSymbolTable(new Uint8Array(16))).toThrow(/Not an ELF file/)
        const narrow = valid()
        narrow[4] = 1
        expect(() => readElfSymbolTable(narrow)).toThrow(/ELF64/)
        expect(() => readElfSymbolTable(valid().subarray(0, 100))).toThrow(/runs past the end/)

        const misnamed = valid()
        const view = new DataView(misnamed.buffer)
        const symtab = readElfSymbolTable(misnamed).sections.find((entry) => entry.name === '.symtab')!
        view.setUint32(symtab.offset + 24, 9999, true)
        expect(() => readElfSymbolTable(misnamed)).toThrow(/outside its string table/)
    })
})
