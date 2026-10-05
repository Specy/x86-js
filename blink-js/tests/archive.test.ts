// The archive writer: a GNU `ar` archive with a symbol index, read back here by the format's own
// rules rather than by the writer's code, so a mistake in one is not repeated in the other.
import { describe, expect, it } from 'vitest'
import { indexedSymbols, writeArchive, type ArchiveMember } from '../src/archive'
import { nasmWasmAssembler } from '../src/wasm-assembler'

type ReadMember = {
    /** Where its header starts, which is what the index's offsets name. */
    offset: number
    name: string
    date: string
    owner: string
    group: string
    mode: string
    data: Uint8Array
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes)

/**
 * Every member of an archive, by the format's rules: the magic string, then for each member a
 * 60-byte header of space-padded fields ending in a backquote and a newline, then its data, then a
 * newline whenever that leaves an odd offset.
 */
function readArchive(bytes: Uint8Array): ReadMember[] {
    expect(ascii(bytes.subarray(0, 8))).toBe('!<arch>\n')
    const members: ReadMember[] = []
    let offset = 8
    while (offset < bytes.length) {
        const header = ascii(bytes.subarray(offset, offset + 60))
        expect(header.slice(58)).toBe('`\n')
        const size = Number(header.slice(48, 58).trimEnd())
        expect(Number.isSafeInteger(size)).toBe(true)
        members.push({
            offset,
            name: header.slice(0, 16),
            date: header.slice(16, 28),
            owner: header.slice(28, 34),
            group: header.slice(34, 40),
            mode: header.slice(40, 48),
            data: bytes.subarray(offset + 60, offset + 60 + size),
        })
        offset += 60 + size
        if (offset % 2) {
            expect(bytes[offset]).toBe(0x0a)
            offset += 1
        }
    }
    expect(offset).toBe(bytes.length)
    return members
}

/** The symbol index: a big-endian count, that many big-endian member offsets, then the names. */
function readIndex(index: Uint8Array): { name: string; offset: number }[] {
    const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
    const count = view.getUint32(0, false)
    const names = ascii(index.subarray(4 + 4 * count)).split('\0')
    return Array.from({ length: count }, (_, position) => ({
        name: names[position]!,
        offset: view.getUint32(4 + 4 * position, false),
    }))
}

async function assemble(files: Record<string, string>): Promise<Uint8Array[]> {
    const result = await nasmWasmAssembler.assemble({ entry: 'entry.asm', files: { 'entry.asm': '', ...files } })
    expect(result.stderr).toBe('')
    return result.units.slice(1).map((unit) => unit.object)
}

describe('the archive writer', () => {
    it('indexes every global, weak, common and absolute definition, and nothing a unit only uses', async () => {
        const [object] = await assemble({
            'unit.asm': [
                'extern outside',
                'extern maybe:weak',
                'global entry_point',
                'global soft:weak',
                'global limit',
                'global value:data',
                'common shared 8',
                'limit equ 64',
                'section .text',
                'entry_point:',
                '    call outside',
                'soft:',
                'local_label:',
                '    ret',
                'section .data',
                'value: dq maybe',
            ].join('\n'),
        })

        // In symbol table order, which is the order GNU `ar` lists them in.
        expect(indexedSymbols(object!)).toEqual(['shared', 'limit', 'entry_point', 'soft', 'value'])
    })

    it('writes the index first, naming each symbol\'s member by its header\'s offset, in member order', async () => {
        const [first, second, third] = await assemble({
            'a.asm': ['global a_one', 'global a_two', 'section .text', 'a_one:', 'a_two:', '    ret'].join('\n'),
            'b.asm': ['section .text', 'only_local:', '    ret'].join('\n'),
            'c.asm': ['global c_one', 'section .data', 'c_one: dq 1'].join('\n'),
        })
        const members: ArchiveMember[] = [
            { name: 'u0.o', data: first! },
            { name: 'u1.o', data: second! },
            { name: 'u2.o', data: third! },
        ]

        const [index, ...read] = readArchive(writeArchive(members))
        expect(index!.name).toBe('/'.padEnd(16))
        expect(read.map((member) => member.name)).toEqual(['u0.o/', 'u1.o/', 'u2.o/'].map((name) => name.padEnd(16)))
        expect(read.map((member) => member.data)).toEqual(members.map((member) => member.data))
        expect(readIndex(index!.data)).toEqual([
            { name: 'a_one', offset: read[0]!.offset },
            { name: 'a_two', offset: read[0]!.offset },
            { name: 'c_one', offset: read[2]!.offset },
        ])
    })

    it('pads odd data with a newline outside its size, and the index with a NUL inside it', async () => {
        const [object] = await assemble({ 'a.asm': ['global ab', 'section .text', 'ab:', '    ret'].join('\n') })
        // NASM's objects are always of even size; one more byte makes this one odd.
        const odd = Uint8Array.from([...object!, 0x90])

        const bytes = writeArchive([{ name: 'odd.o', data: odd }])
        const [index, member] = readArchive(bytes)

        // A count, one offset and `ab` with its NUL make 11 bytes, and GNU `ar` counts the 12th.
        expect(index!.data).toEqual(Uint8Array.from([0, 0, 0, 1, 0, 0, 0, member!.offset, 0x61, 0x62, 0, 0]))
        expect(member!.data).toEqual(odd)
        expect(bytes.at(-1)).toBe(0x0a)
    })

    it('writes an index with no symbols rather than none, which `ld` would refuse', async () => {
        const [object] = await assemble({ 'a.asm': ['section .text', 'local_only:', '    ret'].join('\n') })

        const [index] = readArchive(writeArchive([{ name: 'u0.o', data: object! }]))
        expect(index!.name).toBe('/'.padEnd(16))
        expect(index!.data).toEqual(new Uint8Array(4))
    })

    it('makes the same bytes from the same members, with no date, owner or group to differ by', async () => {
        const objects = await assemble({
            'a.asm': ['global a', 'section .text', 'a:', '    ret'].join('\n'),
            'b.asm': ['global b', 'section .text', 'b:', '    ret'].join('\n'),
        })
        const members = objects.map((data, position) => ({ name: `u${position}.o`, data }))

        const bytes = writeArchive(members)
        expect(writeArchive(members.map((member) => ({ ...member, data: member.data.slice() })))).toEqual(bytes)
        const [index, ...read] = readArchive(bytes)
        for (const member of [index!, ...read]) {
            expect([member.date, member.owner, member.group]).toEqual(['0'.padEnd(12), '0'.padEnd(6), '0'.padEnd(6)])
        }
        // GNU `ar` gives the index a mode of 0 and, in deterministic mode, every member 644.
        expect(index!.mode).toBe('0'.padEnd(8))
        expect(read.map((member) => member.mode)).toEqual(['644'.padEnd(8), '644'.padEnd(8)])
    })

    it('refuses a name the header cannot hold without a long-name table', async () => {
        const [data] = await assemble({ 'a.asm': ['section .text', '    ret'].join('\n') })
        for (const name of ['', 'sixteen-chars.oo', 'a/b.o', 'has space.o', 'naïve.o']) {
            expect(() => writeArchive([{ name, data: data! }]), name).toThrow('Invalid archive member name')
        }
        expect(() => writeArchive([{ name: 'fifteen-chars.o', data: data! }])).not.toThrow()
    })
})
