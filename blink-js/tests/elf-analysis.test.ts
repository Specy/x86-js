import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyze, type ElfAnalysis, type ElfPltStub } from '../src/elf'
import { readElfSymbolTable } from '../src/elf-symbols'
import { elfFixture, swappedLoadsFixture } from './elf-fixtures'

const library = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../src/assets/linux/${name}`, import.meta.url)))

/** A copy of `bytes` with `edit` applied through a DataView. */
function patched(bytes: Uint8Array, edit: (view: DataView, copy: Uint8Array) => void) {
    const copy = bytes.slice()
    edit(new DataView(copy.buffer), copy)
    return copy
}

/** The classic anti-reversing trick: no section header table at all. */
const withoutSections = (bytes: Uint8Array) =>
    patched(bytes, (view) => {
        view.setBigUint64(40, 0n, true)
        view.setUint16(60, 0, true)
        view.setUint16(62, 0, true)
    })

/** The file offset of a link-time address, through the PT_LOAD headers. */
function fileOffset(info: ElfAnalysis, address: bigint): number {
    const load = info.programHeaders.find(
        (header) =>
            header.type === 1 &&
            address >= header.address &&
            address < header.address + BigInt(header.fileSize)
    )!
    return load.offset + Number(address - load.address)
}

/** The slot a `[endbr64] [bnd] jmp [rip+disp32]` stub jumps through, decoded independently. */
function jumpSlot(bytes: Uint8Array, info: ElfAnalysis, stub: ElfPltStub): bigint | undefined {
    let at = fileOffset(info, stub.address)
    const start = at
    if (bytes[at] === 0xf3 && bytes[at + 1] === 0x0f && bytes[at + 2] === 0x1e) at += 4
    if (bytes[at] === 0xf2) at += 1
    if (bytes[at] !== 0xff || bytes[at + 1] !== 0x25) return undefined
    const disp = new DataView(bytes.buffer, bytes.byteOffset).getInt32(at + 2, true)
    return stub.address + BigInt(at + 6 - start) + BigInt(disp)
}

/** The `push imm32` of a lazy `[endbr64] push imm32; jmp rel32` stub. */
function pushIndex(bytes: Uint8Array, info: ElfAnalysis, stub: ElfPltStub): number {
    let at = fileOffset(info, stub.address)
    if (bytes[at] === 0xf3) at += 4
    expect(bytes[at]).toBe(0x68)
    return new DataView(bytes.buffer, bytes.byteOffset).getUint32(at + 1, true)
}

const fileValue = (bytes: Uint8Array, info: ElfAnalysis, address: bigint) =>
    new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(fileOffset(info, address), true)

/** What a stub must be named after: the slot's symbol, or the function an IRELATIVE slot resolves. */
function expectedSlotName(info: ElfAnalysis, slot: bigint): string[] {
    const relocation = info.relocations.find(
        (candidate) => candidate.address === slot && [6, 7, 37].includes(candidate.type)
    )
    if (!relocation) return []
    if (relocation.type !== 37) return [relocation.symbol]
    const target = BigInt.asUintN(64, relocation.addend)
    return [...info.symbols, ...info.dynamicSymbols]
        .filter(
            (symbol) =>
                symbol.value === target &&
                (symbol.type === 'function' || symbol.type === 'ifunc') &&
                symbol.sectionIndex !== 0
        )
        .map((symbol) => symbol.name)
}

const sectionRange = (info: ElfAnalysis, name: string) => {
    const section = info.sections.find((candidate) => candidate.name === name)!
    return (address: bigint) =>
        address >= section.address && address < section.address + BigInt(section.size)
}

it('recognises all committed program fixtures from their bytes', () => {
    for (const name of [
        'crackme',
        'crackme-stripped',
        'crackme-static',
        'crackme-static-pie',
        'hello-atexit',
        'hello-atexit-static',
        'hello-atexit-static-pie',
        'math',
        'cpp',
        'argv-env',
        'ptrace',
        'self-write',
        'crackme-argv',
        'overflow',
        'timedwait',
        'avx'
    ])
        expect(analyze(elfFixture(name)), name).toMatchObject({ isElf: true, supported: true })
})

it('reads dynamic dependencies, symbols, relocations and PLT stubs after stripping', () => {
    const info = analyze(elfFixture('crackme-stripped'))
    expect(info).toMatchObject({
        stripped: true,
        pie: true,
        interpreter: '/lib64/ld-linux-x86-64.so.2',
        needed: ['libc.so.6']
    })
    expect(info.plt.some((stub) => stub.name === 'strcmp@plt')).toBe(true)
    expect(
        info.relocations.some((slot) => slot.symbol === '__libc_start_main' && slot.type === 6)
    ).toBe(true)
    expect(analyze(elfFixture('crackme')).stripped).toBe(false)
    const libc = analyze(library('libc.so.6'))
    expect(libc.soname).toBe('libc.so.6')
    const libm = analyze(library('libm.so.6'))
    expect(libm).toMatchObject({ supported: false, reason: 'a shared library, not a program' })
    expect(libc.dynamicSymbols.some((symbol) => symbol.name === 'strlen')).toBe(true)
})

it('explains unsupported and truncated files without throwing', () => {
    const bytes = elfFixture('crackme')
    expect(analyze(new Uint8Array()).isElf).toBe(false)
    const class32 = bytes.slice()
    class32[4] = 1
    expect(analyze(class32).reason).toContain('32-bit x86')
    const arm = bytes.slice()
    new DataView(arm.buffer).setUint16(18, 40, true)
    expect(analyze(arm).reason).toContain('ARM')
    const object = bytes.slice()
    new DataView(object.buffer).setUint16(16, 1, true)
    expect(analyze(object).reason).toBe('an object file, not a program')
    // Everything Linux maps must be in the file; what only section headers describe need not be.
    const info = analyze(bytes)
    const loaded = Math.max(
        ...info.programHeaders
            .filter((header) => header.type >= 1 && header.type <= 3)
            .map((header) => header.offset + header.fileSize)
    )
    for (let length = 4; length < bytes.length; length += 37) {
        expect(() => analyze(bytes.subarray(0, length))).not.toThrow()
        expect(analyze(bytes.subarray(0, length)).supported, `${length}`).toBe(length >= loaded)
    }
})

it("refuses what Blink's loader ends the process for", () => {
    const swapped = swappedLoadsFixture()
    expect(analyze(swapped).programHeaders.slice(3, 5)).toMatchObject([
        { type: 1, address: 0x2000n },
        { type: 1, address: 0x1000n }
    ])
    expect(analyze(swapped).reason).toBe(
        'an ELF program whose load segments are out of address order'
    )
    // The read-only segment's offset one byte past its address's place in the page.
    const misaligned = patched(elfFixture('crackme'), (view) =>
        view.setBigUint64(64 + 56 * 4 + 8, 0x2001n, true)
    )
    expect(analyze(misaligned).reason).toBe(
        'an ELF load segment whose address and file offset differ within a page'
    )
    // A static program whose first segment moved from 0x400000 to page 0.
    const atZero = patched(elfFixture('crackme-static'), (view) =>
        view.setBigUint64(64 + 16, 0n, true)
    )
    expect(analyze(atZero).reason).toBe('an ELF program that loads at address 0')
    // The interpreter's path ends early, and its last byte is not the NUL that must end it.
    const interpreter = patched(elfFixture('crackme'), (_, copy) => {
        copy[0x374 + 5] = 0
        copy[0x374 + 0x1b] = 0x78
    })
    expect(analyze(interpreter).reason).toBe('an unterminated ELF string')
})

describe('unsupported machines', () => {
    /** An ELF header for `machine`, written in the header's own byte order. */
    function header(machine: number, elfClass: number, data: number): Uint8Array {
        const bytes = new Uint8Array(64)
        bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, data, 1, 0])
        new DataView(bytes.buffer).setUint16(16, 2, data !== 2)
        new DataView(bytes.buffer).setUint16(18, machine, data !== 2)
        return bytes
    }
    const LE = 1
    const BE = 2

    it('names the architecture of a program for another machine', () => {
        const cases: [number, number, number, string][] = [
            [183, 2, LE, 'an ARM program'],
            [183, 2, BE, 'an ARM program'],
            [183, 1, LE, 'a 32-bit ARM program'],
            [40, 1, LE, 'a 32-bit ARM program'],
            [40, 1, BE, 'a 32-bit ARM program'],
            [8, 1, BE, 'a 32-bit MIPS program'],
            [8, 1, LE, 'a 32-bit MIPS program'],
            [8, 2, BE, 'a MIPS program'],
            [8, 2, LE, 'a MIPS program'],
            [243, 2, LE, 'a RISC-V program'],
            [243, 1, LE, 'a 32-bit RISC-V program'],
            [20, 1, BE, 'a 32-bit PowerPC program'],
            [21, 2, BE, 'a PowerPC program'],
            [21, 2, LE, 'a PowerPC program'],
            [2, 1, BE, 'a 32-bit SPARC program'],
            [18, 1, BE, 'a 32-bit SPARC program'],
            [43, 2, BE, 'a SPARC program'],
            [22, 2, BE, 'an IBM Z program'],
            [22, 1, BE, 'a 32-bit IBM Z program'],
            [258, 2, LE, 'a LoongArch program'],
            [258, 1, LE, 'a 32-bit LoongArch program'],
            [0x1234, 2, LE, 'a program for ELF machine 4660'],
            [0x1234, 2, BE, 'a program for ELF machine 4660'],
            [0x1234, 1, LE, 'a 32-bit program for ELF machine 4660'],
            // An unknown class says nothing about the width, but the machine still decides.
            [183, 0, LE, 'an ARM program']
        ]
        for (const [machine, elfClass, data, what] of cases)
            expect(
                analyze(header(machine, elfClass, data)),
                `${machine}/${elfClass}/${data}`
            ).toMatchObject({
                isElf: true,
                supported: false,
                reason: `${what}; only x86-64 programs run`
            })
    })

    it('explains 32-bit x86, big-endian x86-64 and invalid identification bytes', () => {
        const x86 = 'a 32-bit x86 program; only 64-bit x86-64 programs run'
        expect(analyze(header(3, 1, LE)).reason).toBe(x86)
        expect(analyze(header(3, 1, BE)).reason).toBe(x86)
        expect(analyze(header(3, 2, LE)).reason).toBe(x86)
        // The x32 ABI: an x86-64 machine in an ELF32 file.
        expect(analyze(header(62, 1, LE)).reason).toBe(x86)
        expect(analyze(header(62, 2, BE)).reason).toBe(
            'a big-endian x86-64 program; only little-endian x86-64 programs run'
        )
        expect(analyze(header(62, 0, LE)).reason).toBe(
            'an x86-64 ELF file of an unknown class (0); only 64-bit x86-64 programs run'
        )
        expect(analyze(header(62, 7, LE)).reason).toBe(
            'an x86-64 ELF file of an unknown class (7); only 64-bit x86-64 programs run'
        )
        expect(analyze(header(62, 2, 0)).reason).toBe(
            'an ELF file of an unknown byte order (0); only little-endian x86-64 programs run'
        )
        expect(analyze(header(62, 2, 3)).reason).toBe(
            'an ELF file of an unknown byte order (3); only little-endian x86-64 programs run'
        )
        // e_machine of a big-endian file is read big-endian: 62 written little-endian is 0x3e00.
        const swapped = header(62, 2, BE)
        swapped.set([62, 0], 18)
        expect(analyze(swapped).reason).toBe(
            'a program for ELF machine 15872; only x86-64 programs run'
        )
        expect(analyze(header(62, 2, LE).subarray(0, 19)).reason).toBe('a truncated ELF file')
        expect(analyze(header(62, 2, LE).subarray(0, 40)).reason).toBe('a truncated ELF file')
    })

    it('keeps the reasons for object files, libraries, unmapped entry points and other systems', () => {
        for (const strip of [false, true]) {
            const crackme = strip ? withoutSections(elfFixture('crackme')) : elfFixture('crackme')
            const libm = strip ? withoutSections(library('libm.so.6')) : library('libm.so.6')
            expect(analyze(libm).reason).toBe('a shared library, not a program')
            expect(analyze(patched(crackme, (view) => view.setUint16(16, 1, true))).reason).toBe(
                'an object file, not a program'
            )
            expect(analyze(patched(crackme, (view) => view.setUint16(16, 4, true))).reason).toBe(
                'an ELF file that is not an executable program'
            )
            expect(
                analyze(patched(crackme, (view) => view.setBigUint64(24, 0xdead0000n, true))).reason
            ).toBe('an ELF program with an unmapped entry point')
            expect(analyze(patched(crackme, (_, copy) => (copy[7] = 9))).reason).toBe(
                'an ELF program for an unsupported operating system'
            )
            expect(analyze(patched(crackme, (_, copy) => (copy[7] = 3))).supported).toBe(true)
        }
    })
})

describe('programs without usable section headers', () => {
    /** Everything but the section-derived parts, which name their tables differently. */
    const comparable = (info: ElfAnalysis) => ({
        supported: info.supported,
        reason: info.reason,
        type: info.type,
        pie: info.pie,
        entry: info.entry,
        interpreter: info.interpreter,
        soname: info.soname,
        needed: info.needed,
        programHeaders: info.programHeaders,
        dynamicSymbols: info.dynamicSymbols.map(({ section: _, ...symbol }) => symbol),
        relocations: info.relocations.map(({ table: _, ...relocation }) => relocation),
        plt: info.plt
    })

    it('reads a program whose section headers were zeroed through PT_DYNAMIC alone', () => {
        for (const name of ['crackme', 'crackme-stripped', 'cpp', 'math', 'argv-env']) {
            const bytes = elfFixture(name)
            const info = analyze(withoutSections(bytes))
            expect(info, name).toMatchObject({
                supported: true,
                sections: [],
                symbols: [],
                stripped: true,
                interpreter: '/lib64/ld-linux-x86-64.so.2'
            })
            expect(comparable(info), name).toEqual(comparable(analyze(bytes)))
            expect(info.dynamicSymbols.length, name).toBeGreaterThan(5)
            expect(info.plt.length, name).toBeGreaterThan(0)
            expect(new Set(info.relocations.map((relocation) => relocation.table))).toEqual(
                new Set(['DT_RELA', 'DT_JMPREL'])
            )
        }
        const crackme = analyze(withoutSections(elfFixture('crackme')))
        expect(crackme.needed).toEqual(['libc.so.6'])
        expect(crackme.plt.map((stub) => stub.name)).toEqual(
            expect.arrayContaining([
                'strcmp@plt',
                'puts@plt',
                '__cxa_finalize@plt',
                'strcmp@plt_resolver'
            ])
        )
        // Libraries too, RELR and all.
        for (const name of ['libc.so.6', 'libstdc++.so.6', 'libm.so.6']) {
            const bytes = library(name)
            expect(comparable(analyze(withoutSections(bytes))), name).toEqual(
                comparable(analyze(bytes))
            )
        }
    })

    it('ignores a section header table past the end of the file or with an invalid name index', () => {
        const bytes = elfFixture('crackme')
        const original = analyze(bytes)
        const past = analyze(
            patched(bytes, (view) => view.setBigUint64(40, BigInt(bytes.length + 64), true))
        )
        expect(past).toMatchObject({ supported: true, sections: [], needed: ['libc.so.6'] })
        expect(past.plt).toEqual(original.plt)
        const straddling = analyze(
            patched(bytes, (view) => view.setBigUint64(40, BigInt(bytes.length - 64), true))
        )
        expect(straddling).toMatchObject({ supported: true, sections: [] })
        const huge = analyze(patched(bytes, (view) => view.setBigUint64(40, 1n << 63n, true)))
        expect(huge).toMatchObject({ supported: true, sections: [] })
        const wideEntries = analyze(patched(bytes, (view) => view.setUint16(58, 40, true)))
        expect(wideEntries).toMatchObject({ supported: true, sections: [] })

        for (const index of [200, 0xfffe, 0xffff]) {
            const unnamed = analyze(patched(bytes, (view) => view.setUint16(62, index, true)))
            expect(unnamed.supported).toBe(true)
            // The headers themselves still describe the file; only their names are lost.
            expect(unnamed.sections.length).toBe(original.sections.length)
            expect(unnamed.sections.every((section) => section.name === '')).toBe(true)
            const withoutSection = ({ section: _, ...symbol }: ElfAnalysis['symbols'][number]) =>
                symbol
            expect(unnamed.symbols.map(withoutSection)).toEqual(
                original.symbols.map(withoutSection)
            )
            expect(unnamed.plt).toEqual(original.plt)
            expect(unnamed.relocations.map((relocation) => relocation.table)).toEqual(
                original.relocations.map((relocation) =>
                    relocation.table === '.rela.dyn' ? 'section 8' : 'section 9'
                )
            )
        }
        // A name table that lies outside the file names nothing either.
        const shstrtab = original.sections.find((section) => section.name === '.shstrtab')!
        const outside = analyze(
            patched(bytes, (view) => {
                const at = Number(view.getBigUint64(40, true)) + shstrtab.index * 64
                view.setBigUint64(at + 24, BigInt(bytes.length), true)
            })
        )
        expect(outside.supported).toBe(true)
        expect(outside.plt).toEqual(original.plt)
    })

    it('bounds the dynamic symbol count by what the file holds, whatever the hash tables say', () => {
        // crackme has only DT_GNU_HASH; libc also has DT_HASH, which wins.
        const crackme = withoutSections(elfFixture('crackme'))
        const crackmeInfo = analyze(crackme)
        const dynamic = crackmeInfo.programHeaders.find((header) => header.type === 2)!
        const view = new DataView(crackme.buffer)
        const tag = (wanted: number) => {
            for (let at = dynamic.offset; ; at += 16)
                if (view.getBigInt64(at, true) === BigInt(wanted))
                    return Number(view.getBigUint64(at + 8, true))
        }
        const gnuHash = fileOffset(crackmeInfo, BigInt(tag(0x6ffffef5)))
        const buckets = view.getUint32(gnuHash, true)
        const bloom = view.getUint32(gnuHash + 8, true)
        const chains = gnuHash + 16 + bloom * 8 + buckets * 4
        // Chains that never end, buckets and bloom filters far larger than the file.
        const symbols = fileOffset(crackmeInfo, BigInt(tag(6)))
        const endless = patched(crackme, (patch) => {
            for (let at = chains; at + 4 <= symbols; at += 4) patch.setUint32(at, 2, true)
        })
        for (const variant of [
            endless,
            patched(crackme, (patch) => patch.setUint32(gnuHash, 0xffffffff, true)),
            patched(crackme, (patch) => patch.setUint32(gnuHash + 8, 0xffffffff, true)),
            patched(crackme, (patch) => patch.setUint32(gnuHash + 4, 0xffffffff, true)),
            patched(crackme, (patch) => {
                for (let i = 0; i < buckets; ++i)
                    patch.setUint32(gnuHash + 16 + bloom * 8 + i * 4, 0xfffffff0, true)
            })
        ]) {
            const info = analyze(variant)
            expect(info.supported).toBe(true)
            expect(info.dynamicSymbols.length).toBeLessThanOrEqual(variant.length / 24)
        }
        const libc = withoutSections(library('libc.so.6'))
        const libcInfo = analyze(libc)
        const libcDynamic = libcInfo.programHeaders.find((header) => header.type === 2)!
        const libcView = new DataView(libc.buffer)
        let hash = 0
        for (let at = libcDynamic.offset; !hash; at += 16)
            if (libcView.getBigInt64(at, true) === 4n)
                hash = fileOffset(libcInfo, libcView.getBigUint64(at + 8, true))
        expect(libcView.getUint32(hash + 4, true)).toBe(libcInfo.dynamicSymbols.length)
        const lying = analyze(patched(libc, (patch) => patch.setUint32(hash + 4, 0xffffffff, true)))
        expect(lying.supported).toBe(true)
        expect(lying.dynamicSymbols.length).toBeLessThanOrEqual(libc.length / 24)
    })
})

describe('symbol versions', () => {
    it('strips only versions the file defines or needs from .symtab names', () => {
        const info = analyze(elfFixture('crackme'))
        expect(info.symbols.find((symbol) => symbol.index === 21)).toMatchObject({
            name: 'puts',
            version: 'GLIBC_2.2.5',
            defaultVersion: false,
            sectionIndex: 0
        })
        expect(info.symbols.find((symbol) => symbol.name === '__libc_start_main')).toMatchObject({
            version: 'GLIBC_2.34'
        })
        expect(info.symbols.find((symbol) => symbol.name === 'main')).not.toHaveProperty('version')
        expect(info.symbols.some((symbol) => symbol.name.includes('@'))).toBe(false)

        // Rename two .strtab entries in place: an `@` inside the name stays, as does an `@` that
        // names a version the file does not know.
        const bytes = elfFixture('crackme')
        const strtab = info.sections.find((section) => section.name === '.strtab')!
        const text = new TextDecoder('latin1').decode(
            bytes.subarray(strtab.offset, strtab.offset + strtab.size)
        )
        const rename = (from: string, to: string) => {
            expect(to.length).toBe(from.length)
            const at = strtab.offset + text.indexOf(`\0${from}\0`) + 1
            bytes.set(new TextEncoder().encode(to), at)
        }
        rename('puts@GLIBC_2.2.5', 'p@ts@GLIBC_2.2.5')
        rename('strcmp@GLIBC_2.2.5', 'strcmp@GLIBC_9.9.9')
        rename('strcspn@GLIBC_2.2.5', 'strcspn@@GLIBC_2.34')
        const renamed = analyze(bytes)
        expect(renamed.symbols.find((symbol) => symbol.index === 21)).toMatchObject({
            name: 'p@ts',
            version: 'GLIBC_2.2.5',
            defaultVersion: false
        })
        const strcmp = renamed.symbols.find((symbol) => symbol.name.startsWith('strcmp'))!
        expect(strcmp.name).toBe('strcmp@GLIBC_9.9.9')
        expect(strcmp).not.toHaveProperty('version')
        expect(renamed.symbols.find((symbol) => symbol.name === 'strcspn')).toMatchObject({
            version: 'GLIBC_2.34',
            defaultVersion: true
        })
    })

    it('keeps an @ in the symbols of a program without version tables', () => {
        const names = ['foo@bar', 'foo@@bar', 'baz@GLIBC_2.2.5', '@', 'plain']
        const info = analyze(minimalProgram(names))
        expect(info).toMatchObject({ supported: true, stripped: false, entry: 0x400080n })
        expect(info.symbols.map((symbol) => symbol.name)).toEqual(['', ...names])
        expect(info.symbols.some((symbol) => 'version' in symbol)).toBe(false)
        expect(info.symbols[1]).toMatchObject({
            value: 0x400080n,
            type: 'function',
            binding: 'global',
            section: expect.objectContaining({ name: '.text' })
        })
    })

    it('reads the versions of dynamic symbols from .gnu.version, with or without sections', () => {
        for (const strip of [false, true]) {
            const bytes = library('libc.so.6')
            const libc = analyze(strip ? withoutSections(bytes) : bytes)
            const memcpy = libc.dynamicSymbols.filter((symbol) => symbol.name === 'memcpy')
            expect(
                memcpy.map(({ version, defaultVersion, type }) => ({
                    version,
                    defaultVersion,
                    type
                }))
            ).toEqual(
                expect.arrayContaining([
                    { version: 'GLIBC_2.14', defaultVersion: true, type: 'ifunc' },
                    { version: 'GLIBC_2.2.5', defaultVersion: false, type: 'function' }
                ])
            )
            expect(memcpy).toHaveLength(2)
            expect(
                libc.dynamicSymbols.find((symbol) => symbol.name === '_dl_find_dso_for_object')
            ).toMatchObject({
                version: 'GLIBC_PRIVATE',
                defaultVersion: false,
                sectionIndex: 0
            })
            expect(libc.dynamicSymbols[0]).not.toHaveProperty('version')
            // Dynamic symbol names never carry versions, so none is cut.
            expect(libc.dynamicSymbols.filter((symbol) => symbol.version).length).toBeGreaterThan(
                2000
            )
        }
        const crackme = analyze(elfFixture('crackme'))
        expect(
            crackme.dynamicSymbols.map((symbol) => [symbol.name, symbol.version ?? null])
        ).toEqual([
            ['', null],
            ['__libc_start_main', 'GLIBC_2.34'],
            ['_ITM_deregisterTMCloneTable', null],
            ['puts', 'GLIBC_2.2.5'],
            ['__stack_chk_fail', 'GLIBC_2.4'],
            ['printf', 'GLIBC_2.2.5'],
            ['strcspn', 'GLIBC_2.2.5'],
            ['fgets', 'GLIBC_2.2.5'],
            ['strcmp', 'GLIBC_2.2.5'],
            ['__gmon_start__', null],
            ['_ITM_registerTMCloneTable', null],
            ['__cxa_finalize', 'GLIBC_2.2.5'],
            ['stdin', 'GLIBC_2.2.5']
        ])
    })

    it('reads .symtab as readElfSymbolTable does, apart from version suffixes', () => {
        for (const name of ['crackme', 'crackme-static', 'crackme-static-pie', 'cpp', 'avx']) {
            const bytes = elfFixture(name)
            const expected = readElfSymbolTable(bytes)
            const info = analyze(bytes)
            expect(info.sections, name).toEqual(expected.sections)
            expect(info.symbols.length, name).toBe(expected.symbols.length)
            info.symbols.forEach((symbol, index) => {
                const { version, defaultVersion, ...plain } = symbol
                const suffix = version ? `${defaultVersion ? '@@' : '@'}${version}` : ''
                expect({ ...plain, name: plain.name + suffix }).toEqual(expected.symbols[index])
            })
        }
    })
})

describe('PLT stubs', () => {
    it('names each libc stub after the slot it jumps through', () => {
        const bytes = library('libc.so.6')
        const libc = analyze(bytes)
        const stub = (address: bigint) =>
            libc.plt.find((candidate) => candidate.address === address)
        // objdump -d -j .plt.sec: 283f0 jumps through 211b98, an IRELATIVE slot resolving strnlen.
        expect(stub(0x283f0n)).toEqual({ address: 0x283f0n, name: 'strnlen@plt', got: 0x211b98n })
        expect(stub(0x28400n)).toEqual({ address: 0x28400n, name: 'realloc@plt', got: 0x211ba0n })
        expect(stub(0x283d0n)).toEqual({ address: 0x283d0n, name: 'free@plt', got: 0x211e08n })
        expect(stub(0x283e0n)).toEqual({ address: 0x283e0n, name: 'malloc@plt', got: 0x211fe8n })
        expect(stub(0x28000n)).toBeUndefined()

        const inSec = sectionRange(libc, '.plt.sec')
        const sec = libc.plt.filter((candidate) => inSec(candidate.address))
        // Every one of .plt.sec's 60 entries jumps through a slot whose relocation names it.
        expect(sec).toHaveLength(60)
        for (const candidate of sec) {
            expect(candidate.name.endsWith('@plt')).toBe(true)
            expect(jumpSlot(bytes, libc, candidate)).toBe(candidate.got)
            expect(expectedSlotName(libc, candidate.got)).toContain(candidate.name.slice(0, -4))
        }
        expect(sec.filter((candidate) => candidate.name === 'realloc@plt')).toHaveLength(1)
    })

    it('names lazy .plt stubs after the slot that points at them, as their push index says', () => {
        for (const [name, bytes] of [
            ['libc', library('libc.so.6')],
            ['libstdc++', library('libstdc++.so.6')],
            ['crackme', elfFixture('crackme')],
            ['cpp', elfFixture('cpp')],
            ['crackme-static-pie', elfFixture('crackme-static-pie')]
        ] as const) {
            const info = analyze(bytes)
            const inPlt = sectionRange(info, '.plt')
            const lazy = info.plt.filter((stub) => inPlt(stub.address))
            const jumps = info.relocations.filter((relocation) => relocation.table === '.rela.plt')
            expect(lazy.length, name).toBe(
                info.plt.filter((stub) => sectionRange(info, '.plt.sec')(stub.address)).length
            )
            for (const stub of lazy) {
                expect(stub.name.endsWith('@plt_resolver'), name).toBe(true)
                expect(fileValue(bytes, info, stub.got), name).toBe(stub.address)
                expect(jumps[pushIndex(bytes, info, stub)]?.address, name).toBe(stub.got)
                // Its jump stub shares the slot, so the two share a name.
                const jump = info.plt.find(
                    (other) => other.got === stub.got && other.name.endsWith('@plt')
                )
                expect(jump?.name.replace('@plt', '@plt_resolver'), name).toBe(stub.name)
            }
        }
    })

    it('names the stubs of crackme, static binaries and C++ programs', () => {
        const crackme = analyze(elfFixture('crackme'))
        expect(crackme.plt.map((stub) => [stub.address, stub.name, stub.got])).toEqual([
            [0x1030n, 'puts@plt_resolver', 0x3fa8n],
            [0x1040n, '__stack_chk_fail@plt_resolver', 0x3fb0n],
            [0x1050n, 'printf@plt_resolver', 0x3fb8n],
            [0x1060n, 'strcspn@plt_resolver', 0x3fc0n],
            [0x1070n, 'fgets@plt_resolver', 0x3fc8n],
            [0x1080n, 'strcmp@plt_resolver', 0x3fd0n],
            [0x1090n, '__cxa_finalize@plt', 0x3ff8n],
            [0x10a0n, 'puts@plt', 0x3fa8n],
            [0x10b0n, '__stack_chk_fail@plt', 0x3fb0n],
            [0x10c0n, 'printf@plt', 0x3fb8n],
            [0x10d0n, 'strcspn@plt', 0x3fc0n],
            [0x10e0n, 'fgets@plt', 0x3fc8n],
            [0x10f0n, 'strcmp@plt', 0x3fd0n]
        ])

        // A static program's .plt jumps through the IRELATIVE slots of its own .rela.plt.
        for (const name of ['crackme-static', 'hello-atexit-static']) {
            const bytes = elfFixture(name)
            const info = analyze(bytes)
            const plt = info.sections.find((section) => section.name === '.plt')!
            expect(info.plt, name).toHaveLength(plt.size / 16)
            for (const stub of info.plt) {
                expect(stub.name.endsWith('@plt')).toBe(true)
                expect(jumpSlot(bytes, info, stub)).toBe(stub.got)
                const relocation = info.relocations.find(
                    (candidate) => candidate.address === stub.got
                )
                expect(relocation).toMatchObject({ type: 37, table: '.rela.plt', symbol: '' })
                expect(expectedSlotName(info, stub.got)).toContain(stub.name.slice(0, -4))
            }
        }
        const crackmeStatic = analyze(elfFixture('crackme-static'))
        expect(crackmeStatic.plt[0]).toEqual({
            address: 0x401020n,
            name: 'strcpy@plt',
            got: 0x4b1000n
        })
        // Of strchr (global), index (weak) and strchr_ifunc (local) at one resolver, strchr wins.
        expect(crackmeStatic.plt.find((stub) => stub.got === 0x4b10a8n)?.name).toBe('strchr@plt')

        const staticPie = analyze(elfFixture('crackme-static-pie'))
        expect(staticPie.plt.filter((stub) => stub.name.endsWith('@plt_resolver'))).toHaveLength(22)
        expect(staticPie.plt.filter((stub) => stub.name.endsWith('@plt'))).toHaveLength(22)

        const cpp = analyze(elfFixture('cpp'))
        expect(cpp.plt.find((stub) => stub.address === 0x2160n)).toEqual({
            address: 0x2160n,
            name: '__cxa_finalize@plt',
            got: 0x5fc8n
        })
        const libstdcxx = library('libstdc++.so.6')
        const cxx = analyze(libstdcxx)
        const inGot = sectionRange(cxx, '.plt.got')
        const got = cxx.plt.filter((stub) => inGot(stub.address))
        expect(got).toHaveLength(0x1b0 / 16)
        expect(got[0]).toMatchObject({
            address: 0xa7310n,
            name: '_ZNSt17bad_function_callD1Ev@plt'
        })
        expect(got.find((stub) => stub.address === 0xa73a0n)?.name).toBe('__cxa_finalize@plt')
        for (const stub of got) {
            expect(jumpSlot(libstdcxx, cxx, stub)).toBe(stub.got)
            expect(
                cxx.relocations.find((relocation) => relocation.address === stub.got)?.type
            ).toBe(6)
        }
    })
})

describe('relocation tables', () => {
    it('reads RELR, a static .rela.plt, and names the table of each relocation', () => {
        const bytes = library('libc.so.6')
        const libc = analyze(bytes)
        const count = (table: string) =>
            libc.relocations.filter((relocation) => relocation.table === table).length
        // readelf -r: 0x828 / 24 RELA, 0x5a0 / 24 PLT, and RELR "35 entries which relocate 1096 locations".
        expect(count('.rela.dyn')).toBe(87)
        expect(count('.rela.plt')).toBe(60)
        expect(count('.relr.dyn')).toBe(1096)
        expect(libc.relocations).toHaveLength(87 + 60 + 1096)
        const relr = libc.relocations.filter((relocation) => relocation.table === '.relr.dyn')
        expect(relr[0]).toMatchObject({ address: 0x20eb98n, type: 8, symbol: '' })
        expect(relr[1]!.address).toBe(0x20eba0n)
        for (const relocation of relr)
            expect(BigInt.asUintN(64, relocation.addend)).toBe(
                fileValue(bytes, libc, relocation.address)
            )
        expect(new Set(relr.map((relocation) => relocation.address)).size).toBe(1096)

        const stripped = analyze(withoutSections(bytes))
        expect(stripped.relocations.filter((relocation) => relocation.table === 'DT_RELR')).toEqual(
            relr.map((relocation) => ({ ...relocation, table: 'DT_RELR' }))
        )
        expect(
            stripped.relocations.filter((relocation) => relocation.table === 'DT_JMPREL')
        ).toHaveLength(60)

        const crackmeStatic = analyze(elfFixture('crackme-static'))
        expect(crackmeStatic.relocations).toHaveLength(22)
        expect(
            crackmeStatic.relocations.every(
                (relocation) =>
                    relocation.type === 37 && relocation.table === '.rela.plt' && !relocation.symbol
            )
        ).toBe(true)
        expect(crackmeStatic.relocations[0]).toMatchObject({
            address: 0x4b10a8n,
            addend: 0x4553a0n
        })

        const staticPie = analyze(elfFixture('crackme-static-pie'))
        expect(new Set(staticPie.relocations.map((relocation) => relocation.table))).toEqual(
            new Set(['.rela.dyn', '.rela.plt'])
        )
        expect(staticPie.relocations).toHaveLength(1104 + 22)

        const crackme = analyze(elfFixture('crackme'))
        expect(crackme.relocations.map((relocation) => relocation.table)).toEqual([
            ...Array(9).fill('.rela.dyn'),
            ...Array(6).fill('.rela.plt')
        ])
    })
})

it('analyses libc in well under 100 ms', () => {
    const bytes = library('libc.so.6')
    const stripped = withoutSections(bytes)
    for (let i = 0; i < 3; ++i) analyze(bytes)
    for (const [name, input] of [
        ['libc', bytes],
        ['libc without sections', stripped]
    ] as const) {
        analyze(input)
        const start = performance.now()
        for (let i = 0; i < 5; ++i) analyze(input)
        const each = (performance.now() - start) / 5
        console.log(`${name}: ${each.toFixed(1)} ms per analysis`)
        expect(each).toBeLessThan(100)
    }
})

/** The smallest runnable ELF64 with a .symtab naming `names`: an assembled program has no versions. */
function minimalProgram(names: string[]): Uint8Array {
    const encoder = new TextEncoder()
    const strings = [0]
    const nameOffsets = names.map((name) => {
        const at = strings.length
        strings.push(...encoder.encode(name), 0)
        return at
    })
    const sectionNames = '\0.text\0.symtab\0.strtab\0.shstrtab\0'
    const symtab = 0x100
    const symtabSize = (names.length + 1) * 24
    const strtab = symtab + symtabSize
    const shstrtab = strtab + strings.length
    const shoff = (shstrtab + sectionNames.length + 7) & ~7
    const bytes = new Uint8Array(shoff + 5 * 64)
    const view = new DataView(bytes.buffer)
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
    view.setUint16(16, 2, true)
    view.setUint16(18, 62, true)
    view.setUint32(20, 1, true)
    view.setBigUint64(24, 0x400080n, true)
    view.setBigUint64(32, 64n, true)
    view.setBigUint64(40, BigInt(shoff), true)
    view.setUint16(52, 64, true)
    view.setUint16(54, 56, true)
    view.setUint16(56, 1, true)
    view.setUint16(58, 64, true)
    view.setUint16(60, 5, true)
    view.setUint16(62, 4, true)
    // One read-execute PT_LOAD covering the headers and a `ret` at 0x80.
    view.setUint32(64, 1, true)
    view.setUint32(68, 5, true)
    view.setBigUint64(64 + 16, 0x400000n, true)
    view.setBigUint64(64 + 24, 0x400000n, true)
    view.setBigUint64(64 + 32, 0x81n, true)
    view.setBigUint64(64 + 40, 0x81n, true)
    view.setBigUint64(64 + 48, 0x1000n, true)
    bytes[0x80] = 0xc3
    nameOffsets.forEach((offset, index) => {
        const at = symtab + (index + 1) * 24
        view.setUint32(at, offset, true)
        bytes[at + 4] = (1 << 4) | 2
        view.setUint16(at + 6, 1, true)
        view.setBigUint64(at + 8, 0x400080n, true)
        view.setBigUint64(at + 16, 1n, true)
    })
    bytes.set(strings, strtab)
    bytes.set(encoder.encode(sectionNames), shstrtab)
    const section = (
        index: number,
        name: number,
        type: number,
        flags: bigint,
        address: bigint,
        offset: number,
        size: number,
        link = 0,
        info = 0,
        entrySize = 0
    ) => {
        const at = shoff + index * 64
        view.setUint32(at, name, true)
        view.setUint32(at + 4, type, true)
        view.setBigUint64(at + 8, flags, true)
        view.setBigUint64(at + 16, address, true)
        view.setBigUint64(at + 24, BigInt(offset), true)
        view.setBigUint64(at + 32, BigInt(size), true)
        view.setUint32(at + 40, link, true)
        view.setUint32(at + 44, info, true)
        view.setBigUint64(at + 48, 1n, true)
        view.setBigUint64(at + 56, BigInt(entrySize), true)
    }
    section(1, 1, 1, 6n, 0x400080n, 0x80, 1)
    section(2, 7, 2, 0n, 0n, symtab, symtabSize, 3, 1, 24)
    section(3, 15, 3, 0n, 0n, strtab, strings.length)
    section(4, 23, 3, 0n, 0n, shstrtab, sectionNames.length)
    return bytes
}
