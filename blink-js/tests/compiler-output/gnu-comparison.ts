// The GNU as comparison's machinery: a translated build and its stored GNU as reference read as
// executables; their symbols' bindings and section kinds, their data symbols' lengths, alignments
// and bytes, and their `.init_array` entries compared; and both stepped in Blink side by side.
//
// The two builds lay out code and data differently - the translation keeps only function-entry
// alignment in code and flattens GCC's sections into NASM's in input order, GNU as keeps `.L`
// labels and `ld` sorts input sections - so an address is compared by what it names, never by its
// value: an instruction address as the input line it runs, any other address inside the image as
// symbol plus offset. Lengths and alignments come from GCC's output itself (gcc-layout.ts), so
// neither build's layout is trusted to say how long a label is or how it must be aligned.
import {
    ELF_SECTION_FLAGS,
    readElfSectionBytes,
    readElfSymbolTable,
    type ElfSectionHeader,
    type ElfSymbol,
    type ElfSymbolTable,
} from '../../src/elf-symbols'
import type { X86FpuState } from '../../src/fpu-state'
import type { X86Emulator } from '../../src/x86-emulator'
import { isReadOnlyRelocated, readInputLayout, type InputLayout, type InputObject } from './gcc-layout'
import {
    caseInput,
    errors,
    linkedProgram,
    START_UNIT_PATH,
    translatedProject,
    translateOrThrow,
    type CorpusCase,
    type Translation,
} from './helpers'

/**
 * A safety bound, not a sampling one: every trace runs to the program's exit. The longest corpus
 * trace (bigcopy-O0) is about 18,000 compared instructions, at about 30 µs each with the SSE and
 * x87 state compared, so this stops a translation that loops forever after about 2 s here, well
 * inside vitest's 30 s on a runner several times slower, and before it spills into other cases.
 */
export const MAX_STEPS = 60_000
const POINTER_SIZE = 8
const LANE = (1n << 64n) - 1n

/** The symbols both start units read, besides the program's own. */
const START_SYMBOLS = new Set(['__init_array_start', '__init_array_end'])

/**
 * Labels the translation drops by rule (the plan's translation rules: `.LFB*`, `.LFE*`, `.LBB*`,
 * `.LBE*`, `.LVL*`, `.Ltext0`, `.Letext0`, `.Ldebug*`), which GNU as's build keeps.
 */
const DROPPED_LABEL = /^\.L(?:FB|FE|BB|BE|VL)\d+$|^\.L(?:e?text)\d+$|^\.Ldebug/

/**
 * The names GCC's output defines: labels, commons and `.set` aliases, as written. Only these and
 * the start's `.init_array` bounds are places an address can name: `ld`'s own symbols, such as
 * `__bss_start` or `_edata`, sit on the first object of a section in one build and on another
 * object in the other.
 */
export function definedNames(input: readonly string[]): Set<string> {
    const names = new Set<string>()
    for (const text of input) {
        const label = /^([^\s:#"]+):/.exec(text)
        if (label) names.add(label[1]!)
        const declared = /^\s*\.(?:comm|lcomm|set|equ)\s+([^\s,]+)\s*,/.exec(text)
        if (declared) names.add(declared[1]!)
    }
    return names
}

/**
 * The name each input label has in the translated object: `.Lx` renamed `Lx` (with `_` prepended
 * while that is taken), and a name NASM reserves `$`-escaped in the text but plain in the object.
 * Read from the translation itself, through each label line's input line.
 */
export function translatedNames(input: readonly string[], translation: Translation): Map<string, string> {
    const labels = new Map<number, string>()
    for (const line of translation.lines) {
        if (line.inputLine === null || line.synthesized) continue
        const label = /^(\S+):$/.exec(line.text)
        if (label) labels.set(line.inputLine, label[1]!.replace(/^\$/, ''))
    }
    const names = new Map<string, string>()
    input.forEach((text, index) => {
        const label = /^([^\s:#"]+):/.exec(text)
        const translated = labels.get(index)
        if (label && translated !== undefined) names.set(label[1]!, translated)
    })
    return names
}

/** What a value names: itself, the input line of an instruction, or the places a data address can be read as. */
export type Description =
    | { readonly kind: 'value'; readonly value: bigint }
    | { readonly kind: 'line'; readonly line: number }
    | { readonly kind: 'place'; readonly places: readonly string[] }

type Group = { readonly address: bigint; readonly names: readonly string[] }

function byAddress<T extends { address: bigint }>(left: T, right: T): number {
    return left.address < right.address ? -1 : left.address > right.address ? 1 : 0
}

/** A linked executable: its bytes, its symbols by address and the input line of each instruction address. */
export class ProgramImage {
    readonly table: ElfSymbolTable
    readonly allocated: readonly ElfSectionHeader[]
    private readonly groups: readonly Group[]
    private readonly low: bigint
    private readonly high: bigint

    /**
     * @param lines the input line of each instruction address; null for the start unit's.
     * @param places the name a symbol is compared under (the reference's `.Lx` becomes the
     *   translation's `Lx`), or null for a symbol no address should be read as.
     */
    constructor(
        readonly bytes: Uint8Array,
        readonly lines: ReadonlyMap<bigint, number | null>,
        places: (symbol: ElfSymbol) => string | null,
    ) {
        this.table = readElfSymbolTable(bytes)
        this.allocated = this.table.sections
            .filter((section) => (section.flags & ELF_SECTION_FLAGS.alloc) !== 0n && section.size > 0)
            .sort(byAddress)
        const names = new Map<bigint, string[]>()
        for (const symbol of this.table.symbols) {
            if (!symbol.section || symbol.type === 'section' || symbol.type === 'file') continue
            if ((symbol.section.flags & ELF_SECTION_FLAGS.alloc) === 0n) continue
            const name = places(symbol)
            if (name === null) continue
            const atAddress = names.get(symbol.value) ?? []
            if (!atAddress.includes(name)) atAddress.push(name)
            names.set(symbol.value, atAddress)
        }
        this.groups = [...names.entries()].map(([address, group]) => ({ address, names: group.sort() })).sort(byAddress)
        this.low = this.allocated[0]?.address ?? 0n
        // `ld` puts the `.init_array` bounds of a program without constructors past its last
        // section, where the next segment would have started, so the image reaches them too.
        const ends = [
            ...this.allocated.map((section) => section.address + BigInt(section.size)),
            ...this.groups.map((group) => group.address),
        ]
        this.high = ends.reduce((high, address) => (address > high ? address : high), 0n)
    }

    /** The allocated section holding `address`, if any. */
    sectionAt(address: bigint): ElfSectionHeader | null {
        for (const section of this.allocated) {
            if (address >= section.address && address < section.address + BigInt(section.size)) return section
        }
        return null
    }

    /** `length` bytes from `address`, or null when they are not all inside one allocated section. */
    read(address: bigint, length: number): Uint8Array | null {
        if (length === 0) return new Uint8Array(0)
        const section = this.sectionAt(address)
        if (!section) return null
        const offset = Number(address - section.address)
        if (offset + length > section.size) return null
        return readElfSectionBytes(this.bytes, section, offset, length)
    }

    /**
     * The compared symbols at the lowest address above `address` in the section holding it, or
     * null when none follows there; `end` is that address, or else the section's end.
     */
    following(address: bigint): { readonly end: bigint; readonly next: Group | null } {
        const section = this.sectionAt(address)
        const sectionEnd = section ? section.address + BigInt(section.size) : address
        const index = this.groupAtOrBelow(address) + 1
        const next = this.groups[index]
        if (next && next.address < sectionEnd) return { end: next.address, next }
        return { end: sectionEnd, next: null }
    }

    /**
     * What `value` names in this image. An instruction address is its input line. Any other address
     * inside the image is each place it can be read as: the symbols at the nearest address at or
     * below it plus the offset, and, exactly at a symbol, the symbols before it plus theirs, which
     * is how a pointer one past the end of an object reads. Anything else is itself.
     */
    describe(value: bigint): Description {
        if (value < this.low || value > this.high) return { kind: 'value', value }
        const section = this.sectionAt(value)
        if (section && (section.flags & ELF_SECTION_FLAGS.execute) !== 0n) {
            const line = this.lines.get(value)
            if (typeof line === 'number') return { kind: 'line', line }
        }
        const index = this.groupAtOrBelow(value)
        if (index < 0) return { kind: 'value', value }
        const group = this.groups[index]!
        const places = group.names.map((name) => `${name}+${value - group.address}`)
        const previous = this.groups[index - 1]
        if (group.address === value && previous) {
            places.push(...previous.names.map((name) => `${name}+${value - previous.address}`))
        }
        return { kind: 'place', places }
    }

    private groupAtOrBelow(value: bigint): number {
        let low = 0
        let high = this.groups.length - 1
        let found = -1
        while (low <= high) {
            const middle = (low + high) >> 1
            if (this.groups[middle]!.address <= value) {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        return found
    }
}

export function sameDescription(left: Description, right: Description): boolean {
    if (left.kind === 'value' && right.kind === 'value') return left.value === right.value
    if (left.kind === 'line' && right.kind === 'line') return left.line === right.line
    if (left.kind === 'place' && right.kind === 'place')
        return right.places.some((place) => left.places.includes(place))
    return false
}

export function showDescription(description: Description, input?: readonly string[]): string {
    if (description.kind === 'value') return `0x${description.value.toString(16)}`
    if (description.kind === 'line') {
        const text = input?.[description.line]?.trim()
        return `the address of input line ${description.line}${text ? ` (${text})` : ''}`
    }
    return description.places.join(' = ')
}

/**
 * How many bytes a symbol's label reaches: to the next symbol of its section, or to the section's
 * end. For a label without a size that is its data and any alignment padding after it.
 */
export function symbolSpan(table: ElfSymbolTable, symbol: ElfSymbol): number {
    const section = symbol.section
    if (!section) return 0
    let end = section.address + BigInt(section.size)
    for (const other of table.symbols) {
        if (other.section !== section || other.type === 'section' || other.type === 'file') continue
        if (other.value > symbol.value && other.value < end) end = other.value
    }
    return end > symbol.value ? Number(end - symbol.value) : 0
}

/** A case translated and built beside the start unit, with its GNU as reference, both read as images. */
export type Comparison = {
    readonly entry: CorpusCase
    readonly input: readonly string[]
    readonly translation: Translation
    /** The translated object's name for each label of GCC's output, where it differs or is escaped. */
    readonly renamed: ReadonlyMap<string, string>
    /** GCC's output's own record of its data: lengths, alignments, sections and constructors. */
    readonly layout: InputLayout
    readonly translated: ProgramImage
    readonly reference: ProgramImage
}

/**
 * Builds the translation of a case (or the given one) in `emulator` and reads both executables.
 * Leaves the translated program loaded in `emulator`.
 */
export async function prepareComparison(
    entry: CorpusCase,
    emulator: X86Emulator,
    translation: Translation = translateOrThrow(caseInput(entry)),
): Promise<Comparison> {
    const input = caseInput(entry)
    const project = translatedProject(entry.sourcePath, translation.text)
    const build = await emulator.compileProject(project)
    if (!build.ok) throw new Error(`the translated build failed:\n${errors(build)}`)
    // The input line of each instruction address: through the translation's own lines for the
    // Generated assembly, null for the start unit's. Anything else stays unmapped, and fails a trace.
    const translatedLines = new Map<bigint, number | null>()
    for (const instruction of emulator.getCompiledInstructions()) {
        if (instruction.file === START_UNIT_PATH) translatedLines.set(instruction.address, null)
        if (instruction.file !== project.entry) continue
        const line = translation.lines[instruction.lineNumber]?.inputLine
        if (typeof line === 'number') translatedLines.set(instruction.address, line)
    }

    const reference = entry.reference
    if (reference?.status !== 'built' || !reference.elf || !reference.instructions) {
        throw new Error(`${entry.case} has no GNU as reference executable`)
    }
    const referenceLines = new Map<bigint, number | null>(
        reference.instructions.map(([address, line]) => [BigInt(address), line]),
    )

    const defined = definedNames(input)
    const renamed = translatedNames(input, translation)
    const translatedDefined = new Set([...defined].map((name) => renamed.get(name) ?? name))
    return {
        entry,
        input,
        translation,
        renamed,
        layout: readInputLayout(input),
        translated: new ProgramImage(linkedProgram(emulator), translatedLines, ({ name }) =>
            translatedDefined.has(name) || START_SYMBOLS.has(name) ? name : null,
        ),
        reference: new ProgramImage(
            Uint8Array.from(Buffer.from(reference.elf, 'base64')),
            referenceLines,
            ({ name }) => (defined.has(name) ? (renamed.get(name) ?? name) : START_SYMBOLS.has(name) ? name : null),
        ),
    }
}

/** The one symbol named `name` in `table`, ignoring section and file symbols; null for none or several. */
function only(table: ElfSymbolTable, name: string): { symbol: ElfSymbol | null; count: number } {
    const found = table.symbols.filter(
        (symbol) => symbol.name === name && symbol.type !== 'section' && symbol.type !== 'file',
    )
    return { symbol: found.length === 1 ? found[0]! : null, count: found.length }
}

/** The binding a static link gives a name, with GNU's `STB_GNU_UNIQUE` read as the weak binding it pairs with. */
function bindingOf(symbol: ElfSymbol, layout: InputLayout, name: string): string {
    // `ld` makes a hidden global local in an executable; the translation drops `.hidden` (the plan's
    // rules), so the input's own declaration is what the translated build must show.
    if (symbol.binding === 'local' && symbol.visibility === 'hidden' && layout.hidden.has(name)) {
        const declared = layout.declared.get(name)
        if (declared === 'global' || declared === 'weak') return declared
    }
    return symbol.binding === 'unique' ? 'weak' : symbol.binding
}

const { write, execute } = ELF_SECTION_FLAGS

function sectionKind(flags: bigint): string {
    const kind = [(flags & write) !== 0n ? 'writable' : 'read-only', (flags & execute) !== 0n ? 'code' : 'data']
    return kind.join(' ')
}

/**
 * Every name GCC's output defines that GNU as's build has, against the translated build's symbol
 * of that name: present (unless the plan's rules drop it), and with the same binding, weak standing
 * for GNU's unique, and the same section kind, writable or read-only and code or data, except that
 * `.data.rel.ro*` becomes read-only `.rodata` as the plan's rules say. A function, or any label in
 * code but a `.L` one, must also sit at the alignment the input asks for it, which the plan keeps
 * (note 8): C++ pointers to member functions read the address's low bit, and `aligned(N)` functions
 * promise it. Data alignment is {@link compareData}'s. The differences, if any.
 */
export function compareSymbols({ input, layout, renamed, reference, translated }: Comparison): string[] {
    const failures: string[] = []
    for (const name of definedNames(input)) {
        const { symbol: expected, count } = only(reference.table, name)
        // Labels of debug sections, which the reference's preparation drops with them.
        if (count === 0) continue
        if (!expected) {
            failures.push(`${name}: ${count} symbols of that name in the reference`)
            continue
        }
        const translatedName = renamed.get(name) ?? name
        const { symbol: actual, count: translatedCount } = only(translated.table, translatedName)
        if (!actual) {
            if (translatedCount === 0 && DROPPED_LABEL.test(name)) continue
            failures.push(`${name}: ${translatedCount} symbols named ${translatedName} in the translated build`)
            continue
        }
        const binding = bindingOf(expected, layout, name)
        if (actual.binding !== binding) {
            failures.push(`${name}: ${actual.binding} in the translated build, not ${binding}`)
        }
        const object = layout.objects.get(name)
        const sectioned = expected.section !== null && actual.section !== null
        if (object?.family === '.text' && !name.startsWith('.L') && object.alignment > 1 && sectioned) {
            const misaligned = misalignment(actual, object.alignment)
            if (misalignment(expected, object.alignment)) {
                failures.push(`${name}: GNU as's build does not align it to ${object.alignment}, as the input reads`)
            } else if (misaligned) {
                failures.push(
                    `${name}: ${misaligned} in the translated build, not aligned to ${object.alignment} as input ` +
                        `line ${object.line} asks`,
                )
            }
        }
        if (!expected.section || !actual.section) {
            if (expected.section !== actual.section) {
                const where = (symbol: ElfSymbol) => symbol.section?.name ?? 'no section'
                failures.push(`${name}: in ${where(actual)} in the translated build, not ${where(expected)}`)
            }
            continue
        }
        const section = object?.section
        const kind =
            section && isReadOnlyRelocated(section) ? sectionKind(0n) : sectionKind(expected.section.flags)
        const actualKind = sectionKind(actual.section.flags)
        if (actualKind !== kind) {
            failures.push(
                `${name}: in ${actual.section.name}, ${actualKind}, not ${kind} as in ${expected.section.name}`,
            )
        }
    }
    return failures
}

/**
 * The reference's data symbols that GCC's output defines, local labels included: every one in an
 * allocated section that holds no code. A symbol without a size spans to the next symbol of its
 * section, or to the section's end.
 */
export function dataSymbols(table: ElfSymbolTable, input: readonly string[]): DataSymbol[] {
    const defined = definedNames(input)
    const { alloc } = ELF_SECTION_FLAGS
    return table.symbols.flatMap((symbol) => {
        const section = symbol.section
        if (!section || !defined.has(symbol.name) || symbol.type === 'section' || symbol.type === 'file') return []
        if ((section.flags & alloc) === 0n || (section.flags & execute) !== 0n) return []
        const sized = symbol.size > 0n
        return [{ symbol, sized, length: sized ? Number(symbol.size) : symbolSpan(table, symbol) }]
    })
}

export type DataSymbol = { readonly symbol: ElfSymbol; readonly sized: boolean; readonly length: number }

/** A data symbol of both builds and its exact length: its size, or for a label without one, its directives'. */
export type DataObject = {
    readonly name: string
    readonly object: InputObject
    readonly reference: ElfSymbol
    readonly translated: ElfSymbol
    readonly length: number
}

/**
 * The reference's data symbols with their translated counterparts and exact lengths, and what
 * keeps a symbol out of that list. The lengths are checked against GNU as's build first, so that a
 * misreading of the input cannot shorten what is compared: a symbol with a size must have the
 * length its directives give, and every one must fit before the reference's next symbol, with only
 * zeros after it, at an address aligned as the input asks.
 */
export function dataObjects({ input, layout, renamed, reference, translated }: Comparison): {
    readonly objects: readonly DataObject[]
    readonly failures: readonly string[]
} {
    const objects: DataObject[] = []
    const failures: string[] = []
    for (const { symbol, sized } of dataSymbols(reference.table, input)) {
        const name = symbol.name
        const object = layout.objects.get(name)
        if (!object || object.length === null) {
            failures.push(`${name}: GCC's output gives it no data length`)
            continue
        }
        if (sized && BigInt(object.length) !== symbol.size) {
            failures.push(`${name}: its directives emit ${object.length} bytes, but GNU as sized it ${symbol.size}`)
            continue
        }
        const length = object.length
        const { end } = reference.following(symbol.value)
        const room = Number(end - symbol.value)
        const tail = room >= length ? reference.read(symbol.value + BigInt(length), room - length) : null
        const misaligned = misalignment(symbol, object.alignment)
        const disagreement = !tail
            ? `has ${room} bytes before its next symbol, where the input's directives emit ${length}`
            : tail.some((byte) => byte !== 0)
              ? `holds more than the ${length} bytes the input's directives emit`
              : misaligned
                ? `has it ${misaligned}, not aligned to ${object.alignment} as input line ${object.line} asks`
                : null
        if (disagreement) {
            failures.push(`${name}: GNU as's build ${disagreement}, so the input is misread`)
            continue
        }
        const translatedName = renamed.get(name) ?? name
        const { symbol: counterpart, count } = only(translated.table, translatedName)
        if (!counterpart || !counterpart.section) {
            failures.push(`${name}: ${count} symbols named ${translatedName} in the translated build`)
            continue
        }
        objects.push({ name, object, reference: symbol, translated: counterpart, length })
    }
    return { objects, failures }
}

/**
 * Why a symbol is not aligned to `alignment` in a build, or null when it is: its address must be a
 * multiple of it, and so must its section's own alignment, without which the address is aligned
 * only by where this one link happened to put the section, and a link with other objects in front,
 * such as a Runtime library's, would move it.
 */
function misalignment(symbol: ElfSymbol, alignment: number): string | null {
    const wanted = BigInt(alignment)
    if (symbol.value % wanted !== 0n) return `at 0x${symbol.value.toString(16)}`
    const section = symbol.section!
    if (section.addressAlignment < wanted) {
        return `in ${section.name}, whose own alignment is ${section.addressAlignment}`
    }
    return null
}

function alignUp(value: bigint, alignment: number): bigint {
    const step = BigInt(alignment)
    return ((value + step - 1n) / step) * step
}

/**
 * Each reference data symbol against the translated symbol of the same name, `.Lx` read as the
 * translation's `Lx`; the differences, if any. The translated symbol must be aligned as the input
 * asks, hold the symbol's exact length (its size, or for a label without one the length its
 * directives give) byte for byte, and be followed by nothing but the zeros of the input's own
 * alignment: when the next symbol is the next object of its flattened section, exactly as many as
 * the input's alignment directives between them ask for, so a translated object that is shorter or
 * longer than the reference's shows. A differing pointer-sized word passes when both builds
 * resolve it to the same symbol plus offset, or for a code address to the same input line.
 */
export function compareData(comparison: Comparison): string[] {
    const { renamed, translated, reference } = comparison
    const { objects, failures: unmatched } = dataObjects(comparison)
    const failures = [...unmatched]
    const inputName = new Map([...renamed].map(([name, translatedName]) => [translatedName, name]))
    for (const { name, object, reference: symbol, translated: counterpart, length } of objects) {
        const address = counterpart.value
        const misaligned = misalignment(counterpart, object.alignment)
        if (misaligned) {
            failures.push(
                `${name}: ${misaligned} in the translated build, not aligned to ${object.alignment} as input line ` +
                    `${object.line} asks`,
            )
        }
        const { end, next } = translated.following(address)
        const room = Number(end - address)
        if (room < length) {
            failures.push(`${name}: ${length} bytes, but the translated ${counterpart.name} reaches only ${room}`)
            continue
        }
        const padding = translated.read(address + BigInt(length), room - length)!
        if (padding.some((byte) => byte !== 0)) {
            failures.push(`${name}: the translated build holds more than its ${length} bytes, ${room - length} more`)
        } else if (next && object.next !== null && object.family !== null) {
            const following = next.names.map((label) => inputName.get(label) ?? label)
            const expected = alignUp(address + BigInt(length), object.padding)
            if (!following.includes(object.next)) {
                failures.push(
                    `${name}: the translated build puts ${following.join(' = ')} next in ${object.family}, ` +
                        `not ${object.next} as the input does`,
                )
            } else if (end !== expected) {
                failures.push(
                    `${name}: ${room} bytes in the translated build before ${object.next}, where its ${length} ` +
                        `bytes and the input's alignment of ${object.padding} make ${Number(expected - address)}`,
                )
            }
        }
        const expectedBytes = reference.read(symbol.value, length)!
        const actual = translated.read(address, length)!
        const difference = explainBytes(expectedBytes, reference, actual, translated)
        if (difference) failures.push(`${name} (${length} bytes): ${difference}`)
    }
    return failures
}

/**
 * `.init_array` of both builds, entry by entry, as the input line each constructor's address runs:
 * the same constructors, in the same order. The differences, if any.
 */
export function compareInitArray({ input, translated, reference }: Comparison): string[] {
    const entries = (image: ProgramImage) => {
        const section = image.allocated.find((candidate) => candidate.name === '.init_array')
        if (!section) return []
        const bytes = readElfSectionBytes(image.bytes, section)
        if (bytes.length % POINTER_SIZE !== 0) throw new Error(`.init_array holds ${bytes.length} bytes`)
        return Array.from({ length: bytes.length / POINTER_SIZE }, (_, index) =>
            showDescription(image.describe(littleEndian(bytes, index * POINTER_SIZE)), input),
        )
    }
    const expected = entries(reference)
    const actual = entries(translated)
    if (expected.some((entry) => !entry.startsWith('the address of input line'))) {
        return [`GNU as's .init_array holds something other than code: ${expected.join('; ')}`]
    }
    if (JSON.stringify(actual) === JSON.stringify(expected)) return []
    return [`.init_array runs [${actual.join('; ')}], not [${expected.join('; ')}]`]
}

function explainBytes(
    expected: Uint8Array,
    reference: ProgramImage,
    actual: Uint8Array,
    translated: ProgramImage,
): string | null {
    for (let offset = 0; offset < expected.length; offset += 1) {
        if (expected[offset] === actual[offset]) continue
        const word = offset - (offset % POINTER_SIZE)
        if (word + POINTER_SIZE > expected.length) {
            return `byte ${offset} is ${hex(actual[offset]!)}, not ${hex(expected[offset]!)}`
        }
        const left = translated.describe(littleEndian(actual, word))
        const right = reference.describe(littleEndian(expected, word))
        if (!sameDescription(left, right)) {
            return `the word at offset ${word} is ${showDescription(left)}, not ${showDescription(right)}`
        }
        offset = word + POINTER_SIZE - 1
    }
    return null
}

function littleEndian(bytes: Uint8Array, offset: number): bigint {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, POINTER_SIZE).getBigUint64(0, true)
}

function hex(byte: number): string {
    return `0x${byte.toString(16).padStart(2, '0')}`
}

/** Blink's disassembly is a row of an HTML table; the instruction's text is in its `str` cell. */
export function disassembly(code: string | undefined): string {
    return (/class='str'>([^<]*)</.exec(code ?? '')?.[1] ?? code ?? '?').trim()
}

/**
 * One build stepped in Blink, stopping only at instructions from GCC's output: the start unit's
 * are stepped over in both builds, and so is the alignment padding of the reference, which the
 * translation drops except before functions, where it never runs.
 */
class Stepper {
    steps = 0
    private readonly addresses: readonly bigint[]

    constructor(
        readonly emulator: X86Emulator,
        private readonly image: ProgramImage,
        private readonly input: readonly string[],
        private readonly what: string,
        private readonly padded: boolean,
    ) {
        this.addresses = [...image.lines.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    }

    load(): void {
        this.emulator.loadElf(this.image.bytes)
        this.emulator.initialize(0)
        // Starts the program, paused on its first instruction.
        this.emulator.getNextInstruction()
    }

    /** The input line of the next instruction from GCC's output, or null once the program has exited. */
    async next(): Promise<number | null> {
        for (;;) {
            if (this.emulator.hasTerminated()) return null
            const pc = this.emulator.getPc()
            const line = this.image.lines.get(pc)
            if (typeof line === 'number') return line
            if (line === undefined && !(this.padded && this.isAlignmentPadding(pc))) {
                const instruction = disassembly(this.emulator.getInstructionAt(pc)?.code)
                throw new Error(
                    `the ${this.what} build ran 0x${pc.toString(16)} (${instruction}), which no input line made`,
                )
            }
            await this.step()
        }
    }

    async step(): Promise<void> {
        this.steps += 1
        if (this.steps > MAX_STEPS) throw new Error(`the ${this.what} build ran more than ${MAX_STEPS} instructions`)
        await this.emulator.step()
    }

    registers() {
        return this.emulator.getRegisterValuesRecord()
    }

    flags() {
        return this.emulator.getFlags()
    }

    fpu(): X86FpuState {
        return this.emulator.getFpuState()
    }

    exitCode(): number | null {
        const stop = this.emulator.stopReason
        return stop?.kind === 'exit' ? stop.exitCode : null
    }

    /**
     * GNU as pads code to a `.p2align` or `.align` with NOPs that have no line of their own: a NOP
     * before the next instruction with a line, where that instruction follows an alignment
     * directive in the input with only labels and directives between them.
     */
    private isAlignmentPadding(pc: bigint): boolean {
        if (!/^nop\b/.test(disassembly(this.emulator.getInstructionAt(pc)?.code))) return false
        const next = this.addresses.find((address) => address > pc)
        const line = next === undefined ? undefined : this.image.lines.get(next)
        if (typeof line !== 'number') return false
        for (let index = line - 1; index >= 0; index -= 1) {
            const text = this.input[index]!.trim()
            if (/^\.(?:p2align|align)\b/.test(text)) return true
            if (!(text === '' || text.startsWith('.') || text.endsWith(':'))) return false
        }
        return false
    }
}

/**
 * The flags an instruction derives from the low bits of its result: the parity of its low byte (PF)
 * and the carry out of bit 3 (AF). Where the result is an address, which the two builds may place
 * apart, these differ legitimately. ZF, SF, CF and OF cannot: an address and an offset from it lie
 * far from zero, from the sign bit and from any carry out of the register in both builds, so they
 * stay strict even there.
 */
const ADDRESS_DEPENDENT_FLAGS: ReadonlySet<string> = new Set(['PF', 'AF'])

/**
 * The instructions, by GCC's mnemonic, that always write each of those flags. A difference
 * accepted at an address result carries over while neither build's value of the flag changes, and
 * never past one of these, which compute it afresh. (A shift by a count of 0 leaves the flags as
 * they were, and other instructions leave them undefined, so neither is listed.)
 */
const ALWAYS_WRITTEN_BY: Readonly<Record<string, RegExp>> = {
    PF: /^(?:add|adc|sub|sbb|cmp|neg|inc|dec|and|or|xor|test|u?comis[sd]|fu?comip?)$/,
    AF: /^(?:add|adc|sub|sbb|cmp|neg|inc|dec)$/,
}

/** Each general register name GCC writes, for its 64-bit register as the Core names it. */
const GENERAL_REGISTERS: ReadonlyMap<string, string> = new Map([
    ...[
        ['rax', 'eax', 'ax', 'al', 'ah'],
        ['rbx', 'ebx', 'bx', 'bl', 'bh'],
        ['rcx', 'ecx', 'cx', 'cl', 'ch'],
        ['rdx', 'edx', 'dx', 'dl', 'dh'],
        ['rsi', 'esi', 'si', 'sil'],
        ['rdi', 'edi', 'di', 'dil'],
        ['rbp', 'ebp', 'bp', 'bpl'],
        ['rsp', 'esp', 'sp', 'spl'],
    ].flatMap(([full, ...parts]) => [full!, ...parts].map((name) => [name, full!] as const)),
    ...Array.from({ length: 8 }, (_, index) => `r${index + 8}`).flatMap((full) =>
        ['', 'd', 'w', 'b'].map((suffix) => [`${full}${suffix}`, full] as const),
    ),
])

/**
 * An instruction of GCC's output as the flag comparison reads it: its mnemonic, after any prefix,
 * and the 64-bit register its first operand names, which holds its result (or, for `cmp` and
 * `test`, the value the flags describe); null for a memory operand, an immediate or none.
 */
export function instructionShape(text: string): { readonly mnemonic: string; readonly first: string | null } {
    const statement = text.trim().replace(/^(?:(?:rep|repe|repz|repne|repnz|lock|notrack)\s+)+/i, '')
    const match = /^([a-z][a-z0-9]*)(?:\s+([^,]+))?/i.exec(statement)
    const first = match?.[2]?.trim().toLowerCase()
    return {
        mnemonic: match?.[1]?.toLowerCase() ?? '',
        first: first === undefined ? null : (GENERAL_REGISTERS.get(first) ?? null),
    }
}

export type TraceResult = {
    /** Instructions from GCC's output each build ran, which is every one of them. */
    readonly instructions: number
    readonly exitCodes: readonly [number | null, number | null]
}

/** The x87 status word's fields as compared: TOP, the condition codes C0 to C3, and the exception flags. */
function x87Status(word: number) {
    return {
        top: (word >> 11) & 7,
        conditions: ((word >> 8) & 7) | ((word >> 11) & 8),
        exceptions: word & 0xff,
    }
}

const X87_TAGS = ['valid', 'zero', 'special', 'empty'] as const
const X87_EMPTY = 3

/** The two-bit tag of each logical slot `st(i)`, as `readLogicalStTags` reads them. */
function logicalTags(state: X86FpuState): number[] {
    const top = (state.fstat >> 11) & 7
    return Array.from({ length: 8 }, (_, index) => (state.ftag >> (2 * ((index + top) & 7))) & 3)
}

/**
 * The SSE and x87 state of both builds after a step: each XMM register's two 64-bit lanes equal or
 * naming the same place, MXCSR and the x87 control word equal, the x87 status word's TOP,
 * condition codes and exception flags equal, the tag of each logical slot equal, and the value of
 * each slot that is not empty equal.
 */
function compareFpu(
    actual: X86FpuState,
    expected: X86FpuState,
    translated: ProgramImage,
    reference: ProgramImage,
    input: readonly string[],
    differences: string[],
): void {
    actual.xmm.forEach((value, index) => {
        const wanted = expected.xmm[index]!
        if (value === wanted) return
        for (const [lane, shift] of [
            ['low', 0n],
            ['high', 64n],
        ] as const) {
            const left = (value >> shift) & LANE
            const right = (wanted >> shift) & LANE
            if (left === right) continue
            const named = translated.describe(left)
            const expectedNamed = reference.describe(right)
            if (!sameDescription(named, expectedNamed)) {
                differences.push(
                    `xmm${index}'s ${lane} lane is ${showDescription(named, input)}, ` +
                        `not ${showDescription(expectedNamed, input)}`,
                )
            }
        }
    })
    const word = (value: number) => `0x${value.toString(16).padStart(4, '0')}`
    if (actual.mxcsr !== expected.mxcsr) differences.push(`mxcsr is ${word(actual.mxcsr)}, not ${word(expected.mxcsr)}`)
    if (actual.fctrl !== expected.fctrl) {
        differences.push(`the x87 control word is ${word(actual.fctrl)}, not ${word(expected.fctrl)}`)
    }
    const status = x87Status(actual.fstat)
    const expectedStatus = x87Status(expected.fstat)
    const fields = { top: 'TOP is', conditions: 'condition codes are', exceptions: 'exception flags are' } as const
    for (const field of Object.keys(fields) as (keyof typeof fields)[]) {
        if (status[field] !== expectedStatus[field]) {
            differences.push(`the x87 ${fields[field]} ${status[field]}, not ${expectedStatus[field]}`)
        }
    }
    const tags = logicalTags(actual)
    const expectedTags = logicalTags(expected)
    tags.forEach((tag, index) => {
        if (tag !== expectedTags[index]) {
            differences.push(`st${index} is ${X87_TAGS[tag]}, not ${X87_TAGS[expectedTags[index]!]}`)
        } else if (tag !== X87_EMPTY && !Object.is(actual.st[index], expected.st[index])) {
            differences.push(`st${index} is ${actual.st[index]}, not ${expected.st[index]}`)
        }
    })
}

const PAGE_SIZE = 0x1000n

/**
 * `length` bytes of a program's memory at `address`, page by page. Blink maps the whole pages of a
 * file-backed segment only when the program first touches them, and until then reads them as not
 * mapped; such a page still holds what the executable's file does, so that is what it reads as.
 */
function memory(emulator: X86Emulator, image: ProgramImage, address: bigint, length: number): Uint8Array {
    const bytes = new Uint8Array(length)
    for (let start = address; start < address + BigInt(length); ) {
        const end = (start / PAGE_SIZE + 1n) * PAGE_SIZE
        const stop = end < address + BigInt(length) ? end : address + BigInt(length)
        const size = Number(stop - start)
        let chunk: Uint8Array | null
        try {
            chunk = emulator.readMemoryBytes(start, BigInt(size))
        } catch (error) {
            if (!/not mapped/.test(String(error))) throw error
            chunk = image.read(start, size)
            if (!chunk) throw error
        }
        bytes.set(chunk, Number(start - address))
        start = stop
    }
    return bytes
}

/**
 * Steps both builds from the start, side by side. They must run the same input lines in the same
 * order, and after each one hold the same flags, general registers, SSE registers and x87 state:
 * equal values, or, where the two layouts make them differ, addresses naming the same input line or
 * symbol plus offset. The instruction pointer is compared as the input line each runs next. Flags
 * are equal too, except PF and AF after an instruction whose result is an address: its first
 * operand's register differs between the builds but names the same place, so the result's low bits
 * differ with the layout. Such a difference carries over while neither build's flag changes, never
 * past an instruction that computes the flag afresh, and nowhere else is one accepted. Once both
 * have exited, every data symbol must hold the same bytes in both, read as the data comparison
 * reads the executables. Throws at the first difference, saying where.
 */
export async function compareTraces(
    comparison: Comparison,
    translatedEmulator: X86Emulator,
    referenceEmulator: X86Emulator,
): Promise<TraceResult> {
    const { input, translated: translatedImage, reference: referenceImage } = comparison
    const translated = new Stepper(translatedEmulator, translatedImage, input, 'translated', false)
    const reference = new Stepper(referenceEmulator, referenceImage, input, 'reference', true)
    translated.load()
    reference.load()

    const show = (line: number) => `${line} (${input[line]!.trim()})`
    const recent: number[] = []
    /** Each flag difference accepted at an address result, as `translated/reference`, until flags are written. */
    const carried = new Map<string, string>()
    let instructions = 0
    for (;;) {
        const left = await translated.next()
        const right = await reference.next()
        if (left === null || right === null) {
            if (left !== right) {
                const running =
                    left === null ? `the reference runs ${show(right!)}` : `the translation runs ${show(left)}`
                throw new Error(`after ${instructions} instructions one build exited while ${running}`)
            }
            break
        }
        if (left !== right) {
            throw new Error(
                `after ${instructions} instructions the translation runs input line ${show(left)} where the ` +
                    `reference runs ${show(right)}; the lines before: ${recent.join(', ')}`,
            )
        }
        await translated.step()
        await reference.step()
        instructions += 1
        recent.push(left)
        if (recent.length > 8) recent.shift()

        const differences: string[] = []
        const leftRegisters = translated.registers()
        const rightRegisters = reference.registers()
        /** Registers whose values differ between the builds but name the same place: addresses. */
        const addressed = new Set<string>()
        for (const register of Object.keys(leftRegisters) as (keyof typeof leftRegisters)[]) {
            if (register === 'rip') continue
            const value = leftRegisters[register]
            const expected = rightRegisters[register]
            if (value === expected) continue
            const named = translatedImage.describe(value)
            const expectedNamed = referenceImage.describe(expected)
            if (sameDescription(named, expectedNamed)) addressed.add(register)
            else {
                differences.push(
                    `${register} is ${showDescription(named, input)}, not ${showDescription(expectedNamed, input)}`,
                )
            }
        }
        const { mnemonic, first } = instructionShape(input[left]!)
        const fromAddress = first !== null && addressed.has(first)
        const rightFlags = reference.flags()
        translated.flags().forEach((flag, index) => {
            const expected = rightFlags[index]!
            if (flag.name === expected.name && flag.value === expected.value) {
                carried.delete(flag.name)
                return
            }
            const pair = `${flag.value}/${expected.value}`
            const justified = fromAddress && ADDRESS_DEPENDENT_FLAGS.has(flag.name)
            const inherited =
                carried.get(flag.name) === pair && !(ALWAYS_WRITTEN_BY[flag.name]?.test(mnemonic) ?? false)
            if (flag.name === expected.name && (justified || inherited)) carried.set(flag.name, pair)
            else {
                carried.delete(flag.name)
                differences.push(`${flag.name} is ${flag.value}, not ${expected.value}`)
            }
        })
        compareFpu(translated.fpu(), reference.fpu(), translatedImage, referenceImage, input, differences)
        if (differences.length) {
            throw new Error(`after input line ${show(left)}, instruction ${instructions}: ${differences.join('; ')}`)
        }
    }

    const { objects } = dataObjects(comparison)
    const differences = objects.flatMap(({ name, reference: symbol, translated: counterpart, length }) => {
        const expected = memory(referenceEmulator, referenceImage, symbol.value, length)
        const actual = memory(translatedEmulator, translatedImage, counterpart.value, length)
        const difference = explainBytes(expected, referenceImage, actual, translatedImage)
        return difference ? [`${name} (${length} bytes): ${difference}`] : []
    })
    if (differences.length) throw new Error(`at exit, after ${instructions} instructions: ${differences.join('; ')}`)
    return { instructions, exitCodes: [translated.exitCode(), reference.exitCode()] }
}
