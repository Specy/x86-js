import { readElfSymbolTable, type ElfSectionHeader, type ElfSymbol } from '../elf-symbols'

export type ElfProgramHeader = {
    type: number; flags: number; offset: number; address: bigint
    fileSize: number; memorySize: bigint; alignment: bigint
}
export type ElfRelocation = { address: bigint; type: number; symbol: string; addend: bigint }
export type ElfPltStub = { address: bigint; name: string; got: bigint }
export type ElfAnalysis = {
    isElf: boolean; supported: boolean; reason?: string; type: number
    pie: boolean; entry: bigint; interpreter?: string; soname?: string
    needed: string[]; stripped: boolean; programHeaders: ElfProgramHeader[]
    sections: readonly ElfSectionHeader[]; symbols: readonly ElfSymbol[]
    dynamicSymbols: ElfSymbol[]; relocations: ElfRelocation[]; plt: ElfPltStub[]
}

/** Read an ELF without executing it. Unsupported and malformed files return a reason. */
export function analyze(bytes: Uint8Array): ElfAnalysis {
    const result: ElfAnalysis = {
        isElf: bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46,
        supported: false, type: 0, pie: false, entry: 0n, needed: [], stripped: true,
        programHeaders: [], sections: [], symbols: [], dynamicSymbols: [], relocations: [], plt: []
    }
    const fail = (reason: string) => { result.reason = reason; return result }
    if (!result.isElf) return fail('not an ELF program')
    if (bytes.length < 20) return fail('a truncated ELF file')
    if (bytes[4] === 1) return fail('a 32-bit x86 program; only 64-bit x86-64 programs run')
    if (bytes[4] !== 2 || bytes[5] !== 1) return fail('only little-endian ELF64 programs run')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const machine = view.getUint16(18, true)
    if (machine !== 62) {
        const names: Record<number, string> = { 3: '32-bit x86', 8: 'MIPS', 40: 'ARM', 183: 'AArch64', 243: 'RISC-V' }
        return fail(`an ${names[machine] ?? `ELF machine ${machine}`} program; only x86-64 programs run`)
    }
    if (bytes.length < 64) return fail('a truncated ELF file')
    if (bytes[7] !== 0 && bytes[7] !== 3) return fail('an ELF program for an unsupported operating system')
    const number = (value: bigint) => {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('an ELF offset is too large')
        return Number(value)
    }
    const range = (offset: number, size: number) => {
        if (offset < 0 || size < 0 || offset > bytes.length - size) throw new Error('a truncated ELF file')
    }
    const string = (offset: number, end: number) => {
        range(offset, 0)
        if (end > bytes.length || end < offset) throw new Error('a truncated ELF string table')
        let stop = offset
        while (stop < end && bytes[stop]) ++stop
        if (stop === end) throw new Error('an unterminated ELF string')
        return new TextDecoder().decode(bytes.subarray(offset, stop))
    }
    try {
        result.type = view.getUint16(16, true)
        result.pie = result.type === 3
        result.entry = view.getBigUint64(24, true)
        const phoff = number(view.getBigUint64(32, true))
        const phsize = view.getUint16(54, true)
        const phcount = view.getUint16(56, true)
        if (phcount && phsize !== 56) throw new Error('an invalid ELF program header size')
        range(phoff, phsize * phcount)
        for (let i = 0; i < phcount; ++i) {
            const at = phoff + i * phsize
            const header: ElfProgramHeader = {
                type: view.getUint32(at, true), flags: view.getUint32(at + 4, true),
                offset: number(view.getBigUint64(at + 8, true)), address: view.getBigUint64(at + 16, true),
                fileSize: number(view.getBigUint64(at + 32, true)), memorySize: view.getBigUint64(at + 40, true),
                alignment: view.getBigUint64(at + 48, true)
            }
            range(header.offset, header.fileSize)
            if (header.type === 1 && BigInt(header.fileSize) > header.memorySize) throw new Error('an invalid ELF load segment')
            result.programHeaders.push(header)
            if (header.type === 3) result.interpreter = string(header.offset, header.offset + header.fileSize)
        }
        const table = readElfSymbolTable(bytes)
        for (const section of table.sections) if (section.type !== 8) range(section.offset, section.size)
        result.sections = table.sections
        result.symbols = table.symbols.map(symbol => ({ ...symbol, name: symbol.name.split('@')[0] }))
        result.stripped = !table.sections.some(section => section.type === 2)
        const dynsym = table.sections.find(section => section.type === 11)
        if (dynsym) {
            if (dynsym.entrySize !== 24 || dynsym.size % 24) throw new Error('an invalid ELF dynamic symbol table')
            const strings = table.sections[dynsym.link]
            if (!strings) throw new Error('an invalid ELF dynamic string table')
            range(dynsym.offset, dynsym.size); range(strings.offset, strings.size)
            for (let i = 0; i < dynsym.size / 24; ++i) {
                const at = dynsym.offset + i * 24
                const info = view.getUint8(at + 4)
                const sectionIndex = view.getUint16(at + 6, true)
                const nameAt = view.getUint32(at, true)
                if (nameAt >= strings.size) throw new Error('an invalid ELF dynamic symbol name')
                result.dynamicSymbols.push({
                    index: i, name: string(strings.offset + nameAt, strings.offset + strings.size).split('@')[0],
                    value: view.getBigUint64(at + 8, true), size: view.getBigUint64(at + 16, true),
                    type: ({ 1: 'object', 2: 'function', 6: 'tls', 10: 'ifunc' } as const)[info & 15] ?? 'notype',
                    binding: ({ 0: 'local', 1: 'global', 2: 'weak', 10: 'unique' } as const)[info >> 4] ?? 'other',
                    visibility: (['default', 'internal', 'hidden', 'protected'] as const)[view.getUint8(at + 5) & 3],
                    sectionIndex, section: table.sections[sectionIndex] ?? null
                })
            }
        }
        const dynamic = result.programHeaders.find(header => header.type === 2)
        if (dynamic) {
            const entries: { tag: bigint; value: bigint }[] = []
            for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.fileSize; at += 16) {
                const tag = view.getBigInt64(at, true)
                if (!tag) break
                entries.push({ tag, value: view.getBigUint64(at + 8, true) })
            }
            const straddr = entries.find(entry => entry.tag === 5n)?.value
            const strsize = entries.find(entry => entry.tag === 10n)?.value
            const segment = result.programHeaders.find(header => header.type === 1 && straddr !== undefined && straddr >= header.address && straddr < header.address + BigInt(header.fileSize))
            if (segment && straddr !== undefined && strsize !== undefined) {
                const start = segment.offset + number(straddr - segment.address)
                const end = start + number(strsize)
                range(start, number(strsize))
                for (const entry of entries) {
                    if (entry.tag === 1n) result.needed.push(string(start + number(entry.value), end))
                    if (entry.tag === 14n) result.soname = string(start + number(entry.value), end)
                }
            } else if (entries.some(entry => entry.tag === 1n || entry.tag === 14n)) {
                throw new Error('an invalid ELF dynamic string table')
            }
        }
        for (const section of table.sections.filter(section => section.type === 4 && section.link === dynsym?.index)) {
            if (section.entrySize !== 24 || section.size % 24) throw new Error('an invalid ELF relocation table')
            range(section.offset, section.size)
            const slots: ElfRelocation[] = []
            for (let at = section.offset; at < section.offset + section.size; at += 24) {
                const info = view.getBigUint64(at + 8, true)
                const relocation = {
                    address: view.getBigUint64(at, true), type: Number(info & 0xffffffffn),
                    symbol: result.dynamicSymbols[number(info >> 32n)]?.name ?? '',
                    addend: view.getBigInt64(at + 16, true)
                }
                result.relocations.push(relocation)
                if (relocation.type === 7) slots.push(relocation)
            }
            for (const name of ['.plt', '.plt.sec']) {
                const plt = table.sections.find(candidate => candidate.name === name)
                if (!plt || !section.name.includes('plt')) continue
                const stride = plt.entrySize || 16
                slots.forEach((slot, index) => {
                    const offset = (index + (name === '.plt' ? 1 : 0)) * stride
                    if (offset < plt.size) result.plt.push({ address: plt.address + BigInt(offset), name: `${slot.symbol}${name === '.plt' && table.sections.some(s => s.name === '.plt.sec') ? '@plt_resolver' : '@plt'}`, got: slot.address })
                })
            }
        }
        const pltgot = table.sections.find(section => section.name === '.plt.got')
        if (pltgot) {
            range(pltgot.offset, pltgot.size)
            for (let offset = 0; offset + 6 <= pltgot.size; ++offset) {
                const at = pltgot.offset + offset
                if (bytes[at] !== 0xff || bytes[at + 1] !== 0x25) continue
                const got = pltgot.address + BigInt(offset + 6) + BigInt(view.getInt32(at + 2, true))
                const slot = result.relocations.find(relocation => relocation.type === 6 && relocation.address === got)
                if (slot?.symbol) result.plt.push({ address: pltgot.address + BigInt(Math.floor(offset / (pltgot.entrySize || 8)) * (pltgot.entrySize || 8)), name: `${slot.symbol}@plt`, got })
            }
        }
        if (result.type === 1) return fail('an object file, not a program')
        if (result.type !== 2 && result.type !== 3) return fail('an ELF file that is not an executable program')
        if (!result.entry) return fail('a shared library, not a program')
        if (!result.programHeaders.some(header => header.type === 1 && (header.flags & 1) && result.entry >= header.address && result.entry < header.address + header.memorySize)) return fail('an ELF program with an unmapped entry point')
        result.supported = true
        return result
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)) }
}

export type { ElfSectionHeader, ElfSymbol } from '../elf-symbols'
