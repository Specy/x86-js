// The ELF analyser reads untrusted files: truncated or corrupted at any offset, it must neither
// throw nor build output larger than the file can hold, and it must finish quickly.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { analyze } from '../src/elf'
import { elfFixture } from './elf-fixtures'

const library = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../src/assets/linux/${name}`, import.meta.url)))

const withoutSections = (bytes: Uint8Array) => {
    const copy = bytes.slice()
    const view = new DataView(copy.buffer)
    view.setBigUint64(40, 0n, true)
    view.setUint16(60, 0, true)
    view.setUint16(62, 0, true)
    return copy
}

/** A small seeded generator, so that a failure can be replayed. */
function random(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

let slowest = 0
/** Analyses `bytes`, failing with `label` if it throws or returns more than the file can hold. */
function check(bytes: Uint8Array, label: string) {
    const start = performance.now()
    let info
    try {
        info = analyze(bytes)
    } catch (error) {
        throw new Error(`${label}: analyze threw ${String(error)}`)
    }
    slowest = Math.max(slowest, performance.now() - start)
    const limits: [string, number, number][] = [
        ['sections', info.sections.length, bytes.length / 64],
        ['symbols', info.symbols.length, bytes.length / 24],
        ['dynamicSymbols', info.dynamicSymbols.length, bytes.length / 24],
        ['programHeaders', info.programHeaders.length, bytes.length / 56],
        ['needed', info.needed.length, bytes.length / 16],
        // RELA entries take 24 bytes; RELR words expand to at most a slot per 8 file bytes per table.
        ['relocations', info.relocations.length, 3 * (bytes.length / 8 + 64)],
        ['plt', info.plt.length, bytes.length / 8 + 64]
    ]
    for (const [what, count, limit] of limits)
        if (count > limit) throw new Error(`${label}: ${count} ${what} from ${bytes.length} bytes`)
    if (typeof info.supported !== 'boolean' || (!info.supported && !info.reason))
        throw new Error(`${label}: no reason for an unsupported file`)
    return info
}

/** The offsets of the ELF header, program headers, section headers and dynamic entries. */
function structure(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const info = analyze(bytes)
    const phoff = Number(view.getBigUint64(32, true))
    const shoff = Number(view.getBigUint64(40, true))
    const dynamic = info.programHeaders.find((header) => header.type === 2)
    return {
        header: [...Array(64).keys()],
        programHeaders: [...Array(info.programHeaders.length * 56).keys()].map((i) => phoff + i),
        sectionHeaders: shoff
            ? [...Array(view.getUint16(60, true) * 64).keys()].map((i) => shoff + i)
            : [],
        dynamic: dynamic ? [...Array(dynamic.fileSize).keys()].map((i) => dynamic.offset + i) : []
    }
}

const FIELD_VALUES = (length: number) => [
    0n,
    1n,
    8n,
    0x7fffffffn,
    0xffffffffn,
    BigInt(length - 1),
    BigInt(length),
    BigInt(length + 1),
    1n << 63n,
    (1n << 64n) - 1n
]

/** Byte and 64-bit field corruption at every structural offset, and at random ones. */
function corrupt(name: string, bytes: Uint8Array, seed: number, randomOffsets: number) {
    const next = random(seed)
    const parts = structure(bytes)
    const byteOffsets = [
        ...parts.header,
        ...parts.programHeaders,
        ...parts.sectionHeaders,
        ...parts.dynamic,
        ...Array.from({ length: randomOffsets }, () => Math.floor(next() * bytes.length))
    ]
    for (const at of byteOffsets)
        for (const value of [0x00, 0xff, Math.floor(next() * 256)]) {
            const copy = bytes.slice()
            copy[at] = value
            check(copy, `${name} byte ${at} = ${value}`)
        }
    const fields = [
        ...parts.header,
        ...parts.programHeaders,
        ...parts.sectionHeaders,
        ...parts.dynamic
    ]
        .filter((at, index, all) => index === 0 || at % 8 === all[0]! % 8)
        .filter((at) => at + 8 <= bytes.length)
    for (const at of fields)
        for (const value of [
            ...FIELD_VALUES(bytes.length),
            BigInt(Math.floor(next() * 2 ** 32)) << 16n
        ]) {
            const copy = bytes.slice()
            new DataView(copy.buffer).setBigUint64(at, BigInt.asUintN(64, value), true)
            check(copy, `${name} field ${at} = ${value}`)
        }
}

it('never throws for a truncated fixture or library', { timeout: 120_000 }, () => {
    for (const name of ['crackme', 'cpp', 'crackme-static', 'crackme-static-pie']) {
        const bytes = elfFixture(name)
        const step = bytes.length > 100_000 ? Math.floor(bytes.length / 97) : 7
        for (let length = 0; length <= Math.min(bytes.length, 1024); ++length)
            check(bytes.subarray(0, length), `${name} cut at ${length}`)
        for (let length = 1024; length < bytes.length; length += step)
            check(bytes.subarray(0, length), `${name} cut at ${length}`)
        for (let length = 1024; length < bytes.length; length += step)
            check(
                withoutSections(bytes).subarray(0, length),
                `${name} without sections, cut at ${length}`
            )
    }
    const libc = library('libc.so.6')
    for (let length = 64; length < libc.length; length += Math.floor(libc.length / 61))
        check(libc.subarray(0, length), `libc cut at ${length}`)
    expect(slowest).toBeLessThan(1000)
})

it(
    'never throws for corrupted headers, section headers and dynamic entries',
    { timeout: 300_000 },
    () => {
        corrupt('crackme', elfFixture('crackme'), 1, 500)
        corrupt('crackme without sections', withoutSections(elfFixture('crackme')), 2, 500)
        corrupt('cpp without sections', withoutSections(elfFixture('cpp')), 3, 200)
        expect(slowest).toBeLessThan(1000)
    }
)

it('never throws for corrupted dynamic tables of large binaries', { timeout: 300_000 }, () => {
    for (const [name, original] of [
        ['libc', withoutSections(library('libc.so.6'))],
        ['crackme-static-pie', withoutSections(elfFixture('crackme-static-pie'))]
    ] as const) {
        const next = random(name.length)
        const info = analyze(original)
        const dynamic = info.programHeaders.find((header) => header.type === 2)!
        const view = new DataView(original.buffer)
        // Each dynamic entry's value, pointing nowhere, at the end of the file, or at random places;
        // and each tag replaced with one of the tags the analyser follows.
        const tags = [
            1, 2, 4, 5, 6, 7, 8, 10, 14, 20, 23, 35, 36, 0x6ffffef5, 0x6ffffff0, 0x6ffffffc,
            0x6ffffffd, 0x6ffffffe, 0x6fffffff
        ]
        for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.fileSize; at += 16) {
            if (!view.getBigInt64(at, true)) break
            for (const value of [
                0n,
                BigInt(original.length),
                1n << 63n,
                (1n << 64n) - 1n,
                BigInt(Math.floor(next() * original.length)),
                view.getBigUint64(at + 8, true) + 1n
            ]) {
                const copy = original.slice()
                new DataView(copy.buffer).setBigUint64(at + 8, BigInt.asUintN(64, value), true)
                check(copy, `${name} dynamic value at ${at} = ${value}`)
            }
            const copy = original.slice()
            new DataView(copy.buffer).setBigInt64(
                at,
                BigInt(tags[Math.floor(next() * tags.length)]!),
                true
            )
            check(copy, `${name} dynamic tag at ${at}`)
        }
        // Random damage anywhere: tables, hash tables, version tables, PLT code.
        for (let i = 0; i < 150; ++i) {
            const copy = original.slice()
            const at = Math.floor(next() * (copy.length - 64))
            for (let k = 0; k < 64; ++k) copy[at + k] = Math.floor(next() * 256)
            check(copy, `${name} 64 random bytes at ${at}`)
        }
    }
    expect(slowest).toBeLessThan(1000)
})

it(
    'survives a section header table of repeated, overlapping and oversized entries',
    { timeout: 60_000 },
    () => {
        const bytes = elfFixture('crackme')
        const info = analyze(bytes)
        const shoff = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(40, true))
        // Every section header copied from .rela.plt, .plt.sec, .dynsym or .symtab in turn: tables
        // that all overlap must each be read once.
        for (const name of ['.rela.plt', '.plt.sec', '.dynsym', '.symtab', '.gnu.version_r']) {
            const section = info.sections.find((candidate) => candidate.name === name)!
            const copy = bytes.slice()
            const source = copy.slice(shoff + section.index * 64, shoff + section.index * 64 + 64)
            for (let index = 1; index < info.sections.length; ++index)
                if (index !== 30) copy.set(source, shoff + index * 64)
            check(copy, `every section is ${name}`)
        }
        // e_shoff, e_shnum and e_shstrndx together.
        for (const offset of [
            0n,
            1n,
            64n,
            BigInt(shoff),
            BigInt(bytes.length - 64),
            BigInt(bytes.length),
            1n << 62n
        ])
            for (const count of [0, 1, 31, 32, 0xff00, 0xffff])
                for (const names of [0, 1, 30, 31, 0xfeff, 0xffff]) {
                    const copy = bytes.slice()
                    const view = new DataView(copy.buffer)
                    view.setBigUint64(40, offset, true)
                    view.setUint16(60, count, true)
                    view.setUint16(62, names, true)
                    const result = check(
                        copy,
                        `e_shoff ${offset}, e_shnum ${count}, e_shstrndx ${names}`
                    )
                    expect(result.supported).toBe(true)
                    expect(result.needed).toEqual(['libc.so.6'])
                }
        // Section 0 announcing more sections than the file holds (e_shnum 0 means "ask section 0").
        const many = bytes.slice()
        const view = new DataView(many.buffer)
        view.setUint16(60, 0, true)
        view.setBigUint64(shoff + 32, 0xffffffffn, true)
        expect(check(many, 'section 0 size').sections).toEqual([])
        expect(slowest).toBeLessThan(1000)
    }
)
