import { ELF_SECTION_FLAGS, ELF_SECTION_NO_BITS, readElfSymbolTable } from './elf-symbols'
import type { X86Project } from './types'
import { X86_PROJECT_ROOT } from './project'

export type X86MemoryLayout = {
    sections: string[]
    /** Tuples of address, length, kind, section index, alignment. */
    items: bigint[]
    symbols: { name: string; address: bigint; section: number; fromLibrary: boolean; file?: string }[]
}
export function readMemoryLayout(elf: Uint8Array, units: readonly { path: string; object: Uint8Array }[], project: X86Project | null): X86MemoryLayout {
    const table = readElfSymbolTable(elf)
    const sections = table.sections.filter(section => section.size && (section.flags & ELF_SECTION_FLAGS.alloc) &&
        section.name !== '.eh_frame' && section.name !== '.eh_frame_hdr' && !section.name.startsWith('.note') && !section.name.startsWith('.got'))
    const result: X86MemoryLayout = { sections: sections.map(section => section.name), items: [], symbols: [] }
    const index = new Map(sections.map((section, i) => [section.index, i]))
    for (const [i, section] of sections.entries()) result.items.push(section.address, BigInt(section.size),
        section.flags & ELF_SECTION_FLAGS.execute ? 0n : section.type === ELF_SECTION_NO_BITS ? 2n : 1n, BigInt(i), section.addressAlignment)
    const owners = new Map<string, string>()
    for (const unit of units) for (const symbol of readElfSymbolTable(unit.object).symbols) {
        if (symbol.binding !== 'local' && symbol.sectionIndex !== 0 && symbol.name) owners.set(symbol.name, unit.path)
    }
    let file: string | undefined
    // An include shares its object's STT_FILE owner. Keep the actual source path so the
    // editor can distinguish Generated assembly from handwritten labels in the same unit.
    const sourceNames = new Map<string, Map<string, { name: string; file: string }>>()
    const namesInUnit = (owner: string) => {
        const cached = sourceNames.get(owner)
        if (cached) return cached
        const names = new Map<string, { name: string; file: string }>()
        const visited = new Set<string>()
        const directory = owner.includes('/') ? owner.slice(0, owner.lastIndexOf('/') + 1) : ''
        const visit = (path: string) => {
            if (visited.has(path)) return
            visited.add(path)
            const text = project?.files[path] ?? project?.startUnits?.[path] ?? project?.library?.[path]
            if (typeof text !== 'string') return
            for (const match of text.matchAll(/^\s*([\w.$?@~#]+):/gm))
                names.set(match[1], { name: match[1], file: path })
            for (const match of text.matchAll(/^\s*; compiler-symbol (\S+) (\S+)$/gm))
                names.set(match[1], { name: match[2], file: path })
            for (const match of text.matchAll(/^\s*%include\s+"([^"\n]+)"/gm)) {
                const parts: string[] = []
                for (const part of (directory + match[1]).split('/')) {
                    if (part === '..') parts.pop()
                    else if (part && part !== '.') parts.push(part)
                }
                visit(parts.join('/'))
            }
        }
        visit(owner)
        sourceNames.set(owner, names)
        return names
    }
    for (const symbol of table.symbols) {
        if (symbol.type === 'file') { file = symbol.name === '/assembly.s' ? project?.entry : symbol.name.replace(`${X86_PROJECT_ROOT}/`, ''); continue }
        if (!symbol.name || symbol.type === 'section' || !symbol.section || (symbol.section.flags & ELF_SECTION_FLAGS.execute)) continue
        const section = index.get(symbol.sectionIndex)
        if (section === undefined) continue
        const owner = symbol.binding === 'local' ? file : owners.get(symbol.name)
        const source = owner ? namesInUnit(owner).get(symbol.name) : undefined
        result.symbols.push({ name: source?.name ?? symbol.name, address: symbol.value, section,
            fromLibrary: !!project && (!owner || !Object.hasOwn(project.files, owner)), file: source?.file ?? owner })
    }
    return result
}
