// GCC's output read for its data layout, independently of the translator: the section each label
// is in, how many bytes each data label's directives emit, what alignment the input asks of it,
// which names it declares global, weak or local, and its `.init_array` entries. The GNU comparison
// compares exact lengths and alignments with it instead of trusting either build's layout.
//
// Two layouts are read. GNU as aligns and places each object within its own GCC section. The
// translation flattens GCC's sections into NASM families in input order (plan: `.text*`,
// `.rodata*`, `.data*`, `.bss*` become `.text`, `.rodata`, `.data`, `.bss`, `.data.rel.ro*` becomes
// `.rodata`, and a local common is placed in `.bss` where `.comm` stands), so between one object of
// a family and the next there is only the padding the alignment directives between them ask for.

/** The NASM section a GCC section flattens into (the plan's translation rules). */
export type Family = '.text' | '.rodata' | '.data' | '.bss' | '.init_array'

export function familyOf(section: string): Family | null {
    const within = (base: string) => section === base || section.startsWith(`${base}.`)
    if (within('.text')) return '.text'
    if (within('.data.rel.ro')) return '.rodata'
    if (within('.rodata')) return '.rodata'
    if (within('.data')) return '.data'
    if (within('.bss')) return '.bss'
    if (section === '.init_array') return '.init_array'
    return null
}

/** True for a GCC section the plan translates as read-only although GCC asks for a writable one. */
export function isReadOnlyRelocated(section: string): boolean {
    return section === '.data.rel.ro' || section.startsWith('.data.rel.ro.')
}

export type InputObject = {
    readonly name: string
    /** The input line that defines it: its label, or its `.comm`. */
    readonly line: number
    /** GCC's section as written; `.bss` for a local common, and null for a global one, which `ld` places. */
    readonly section: string | null
    readonly family: Family | null
    readonly kind: 'label' | 'local-common' | 'common'
    /**
     * For data: the bytes its directives emit up to the next label, alignment directive or section
     * switch, which for a label without a size is the only record of its length; a label directly
     * followed by another shares that one's bytes. Null in code.
     */
    readonly length: number | null
    /**
     * The alignment the input asks of it: the largest `.align`, `.p2align` or `.balign` its section
     * has seen since it last emitted a byte, or a common's own; in code, since the last instruction,
     * counting only alignment without a maximum skip, which is all the plan keeps there (note 8:
     * function entries, never loops). 1 when nothing asks.
     */
    readonly alignment: number
    /**
     * In the translation's flattened family: the alignment the directives after its bytes and before
     * the family's next object ask for, 1 for none, and that next object.
     */
    readonly padding: number
    readonly next: string | null
}

export type InputLayout = {
    /** Every label the input defines in a kept section, every common and every `.set` alias, by name. */
    readonly objects: ReadonlyMap<string, InputObject>
    /** The binding each name is declared with: `.globl`, `.weak` or `.local`. */
    readonly declared: ReadonlyMap<string, 'global' | 'weak' | 'local'>
    /** Names declared `.hidden`. */
    readonly hidden: ReadonlySet<string>
    /** `.init_array` entries in input order: the symbol each names and its input line. */
    readonly constructors: readonly { readonly symbol: string; readonly line: number }[]
}

const DATA_WIDTHS: Readonly<Record<string, number>> = {
    '.byte': 1,
    '.1byte': 1,
    '.value': 2,
    '.short': 2,
    '.word': 2,
    '.2byte': 2,
    '.long': 4,
    '.int': 4,
    '.4byte': 4,
    '.float': 4,
    '.single': 4,
    '.quad': 8,
    '.8byte': 8,
    '.double': 8,
    '.octa': 16,
}

type Group = { readonly names: string[]; readonly line: number; length: number; readonly alignment: number }
type FamilyEvent =
    | { readonly kind: 'object'; readonly group: Group }
    | { readonly kind: 'bytes' }
    | { readonly kind: 'align'; readonly bytes: number }

/** Reads GCC's output; throws, naming the line, for data it cannot measure or that no label owns. */
export function readInputLayout(input: readonly string[]): InputLayout {
    const declared = new Map<string, 'global' | 'weak' | 'local'>()
    const hidden = new Set<string>()
    const constructors: { symbol: string; line: number }[] = []
    const objects = new Map<string, Omit<InputObject, 'padding' | 'next' | 'length'> & { group: Group | null }>()
    const aliases: { alias: string; target: string; line: number }[] = []
    const events = new Map<Family, FamilyEvent[]>()
    const familyEvents = (family: Family) => {
        let list = events.get(family)
        if (!list) events.set(family, (list = []))
        return list
    }
    /** Per GCC section: the object its next bytes belong to, and the alignment asked since its last byte. */
    const states = new Map<string, { open: Group | null; pending: number }>()
    const stateOf = (section: string) => {
        let state = states.get(section)
        if (!state) states.set(section, (state = { open: null, pending: 1 }))
        return state
    }

    let section = '.text'
    let previous = '.text'
    const stack: string[] = []
    const enter = (name: string) => {
        if (familyOf(section) !== '.text') stateOf(section).open = null
        previous = section
        section = name
    }
    const fail = (line: number, message: string): never => {
        throw new Error(`input line ${line} (${input[line]!.trim()}): ${message}`)
    }

    const emit = (line: number, bytes: number) => {
        const family = familyOf(section)
        if (family === null || family === '.text') return
        const state = stateOf(section)
        if (!state.open) fail(line, `${bytes} bytes in ${section} that no label names`)
        state.open!.length += bytes
        state.pending = 1
        familyEvents(family).push({ kind: 'bytes' })
    }
    const align = (bytes: number) => {
        const family = familyOf(section)
        if (family === null || family === '.text') return
        const state = stateOf(section)
        state.open = null
        state.pending = Math.max(state.pending, bytes)
        familyEvents(family).push({ kind: 'align', bytes })
    }

    input.forEach((text, line) => {
        const trimmed = text.trim()
        if (trimmed === '' || trimmed.startsWith('#')) return
        const label = /^([^\s:#"]+):(.*)$/.exec(trimmed)
        if (label) {
            if (label[2]!.trim() !== '') fail(line, 'a statement after a label')
            const name = label[1]!
            const family = familyOf(section)
            if (family === null) return
            if (family === '.text') {
                const alignment = stateOf(section).pending
                objects.set(name, { name, line, section, family, kind: 'label', alignment, group: null })
                return
            }
            const state = stateOf(section)
            let group = state.open
            if (group && group.length === 0) group.names.push(name)
            else {
                group = { names: [name], line, length: 0, alignment: state.pending }
                state.open = group
                state.pending = 1
                familyEvents(family).push({ kind: 'object', group })
            }
            objects.set(name, { name, line, section, family, kind: 'label', alignment: group.alignment, group })
            return
        }
        const directive = /^(\.[A-Za-z_][\w.]*)(?:\s+(.*))?$/.exec(trimmed)
        if (!directive) {
            // An instruction: only code holds them, and code is not measured, only aligned.
            const family = familyOf(section)
            if (family === '.text') stateOf(section).pending = 1
            else if (family !== null) fail(line, `an instruction in ${section}`)
            return
        }
        const name = directive[1]!.toLowerCase()
        const args = splitArguments(directive[2] ?? '')
        switch (name) {
            case '.section':
            case '.pushsection': {
                if (name === '.pushsection') stack.push(section)
                enter(args[0]!.replace(/^"|"$/g, ''))
                return
            }
            case '.text':
            case '.data':
            case '.bss':
                enter(name)
                return
            case '.popsection':
                enter(stack.pop() ?? '.text')
                return
            case '.previous':
                enter(previous)
                return
            case '.globl':
            case '.global':
                declared.set(args[0]!, 'global')
                return
            case '.weak':
                declared.set(args[0]!, 'weak')
                return
            case '.local':
                declared.set(args[0]!, 'local')
                return
            case '.hidden':
                hidden.add(args[0]!)
                return
            case '.set':
            case '.equ':
                aliases.push({ alias: args[0]!, target: args[1]!, line })
                return
            case '.comm':
            case '.lcomm': {
                const [symbol, size, alignment] = args
                const bytes = integer(size, line, fail)
                const requested = alignment === undefined ? 1 : integer(alignment, line, fail)
                if (name === '.comm' && declared.get(symbol!) !== 'local') {
                    objects.set(symbol!, {
                        name: symbol!,
                        line,
                        section: null,
                        family: null,
                        kind: 'common',
                        alignment: requested,
                        group: { names: [symbol!], line, length: bytes, alignment: requested },
                    })
                    return
                }
                // GNU as places a local common in `.bss` (behind its other contents); the
                // translation places it in its `.bss` where the `.comm` stands, aligned.
                stateOf('.bss').open = null
                const group: Group = { names: [symbol!], line, length: bytes, alignment: requested }
                const list = familyEvents('.bss')
                list.push({ kind: 'align', bytes: requested }, { kind: 'object', group })
                if (bytes > 0) list.push({ kind: 'bytes' })
                objects.set(symbol!, {
                    name: symbol!,
                    line,
                    section: '.bss',
                    family: '.bss',
                    kind: 'local-common',
                    alignment: requested,
                    group,
                })
                return
            }
            case '.align':
            case '.balign':
            case '.p2align': {
                const amount = integer(args[0], line, fail)
                const bytes = name === '.p2align' ? 2 ** amount : amount
                const family = familyOf(section)
                if (family === null) return
                if (family === '.text') {
                    // A maximum skip makes it loop alignment, which may be skipped altogether.
                    if (args[2] === undefined || args[2].trim() === '') {
                        const state = stateOf(section)
                        state.pending = Math.max(state.pending, bytes)
                    }
                    return
                }
                if (args.length > 1 && args.slice(1).some((arg) => arg.trim() !== '')) {
                    fail(line, 'an alignment with a fill or a maximum skip outside code')
                }
                align(bytes)
                return
            }
            case '.zero':
            case '.skip':
            case '.space':
                emit(line, integer(args[0], line, fail))
                return
            case '.string':
            case '.asciz':
            case '.ascii': {
                if (args.length === 0) fail(line, `${name} without a string`)
                const terminator = name === '.ascii' ? 0 : 1
                emit(
                    line,
                    args.reduce((total, arg) => total + gasStringLength(arg.trim(), line, fail) + terminator, 0),
                )
                return
            }
        }
        const width = DATA_WIDTHS[name]
        if (width !== undefined) {
            if (section === '.init_array') {
                if (name !== '.quad' || args.length !== 1) fail(line, 'an `.init_array` entry that is not one `.quad`')
                constructors.push({ symbol: args[0]!.trim(), line })
                return
            }
            if (args.length === 0) fail(line, `${name} without a value`)
            emit(line, width * args.length)
            return
        }
        const family = familyOf(section)
        if (family !== null && family !== '.text' && /^\.(?:uleb128|sleb128|incbin|fill|org|rept|base64)$/.test(name)) {
            fail(line, `${name} in ${section}, whose size this reader does not measure`)
        }
    })

    for (const { alias, target, line } of aliases) {
        const object = objects.get(target)
        if (object) objects.set(alias, { ...object, name: alias, line })
    }

    // The flattened families: each object's padding and next object.
    const following = new Map<Group, { padding: number; next: string | null }>()
    for (const list of events.values()) {
        list.forEach((event, index) => {
            if (event.kind !== 'object') return
            let padding = 1
            let next: string | null = null
            for (const later of list.slice(index + 1)) {
                if (later.kind === 'object') {
                    next = later.group.names[0]!
                    break
                }
                if (later.kind === 'align') padding = Math.max(padding, later.bytes)
            }
            following.set(event.group, { padding, next })
        })
    }
    const layout = new Map<string, InputObject>()
    for (const [name, { group, ...object }] of objects) {
        const after = group ? following.get(group) : undefined
        layout.set(name, {
            ...object,
            length: group ? group.length : null,
            padding: after?.padding ?? 1,
            next: after?.next ?? null,
        })
    }
    return { objects: layout, declared, hidden, constructors }
}

const ENCODER = new TextEncoder()

function integer(text: string | undefined, line: number, fail: (line: number, message: string) => never): number {
    const value = text === undefined ? NaN : Number(text.trim())
    if (!Number.isSafeInteger(value) || value < 0) fail(line, `\`${text ?? ''}\` is not a size this reader reads`)
    return value
}

/** Splits at commas outside double quotes. */
function splitArguments(text: string): string[] {
    if (text.trim() === '') return []
    const parts: string[] = []
    let quoted = false
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (quoted) {
            if (character === '\\') index += 1
            else if (character === '"') quoted = false
        } else if (character === '"') quoted = true
        else if (character === ',') {
            parts.push(text.slice(start, index).trim())
            start = index + 1
        }
    }
    parts.push(text.slice(start).trim())
    return parts
}

/**
 * How many bytes GNU as emits for a string literal, before any terminator: each character as its
 * UTF-8 bytes, and each escape as one byte (`\b \f \n \r \t \\ \"`, up to three octal digits, or
 * `\x` and its hexadecimal digits). An escape GCC does not write is an error, not a guess.
 */
export function gasStringLength(
    literal: string,
    line: number,
    fail: (line: number, message: string) => never,
): number {
    if (!/^".*"$/s.test(literal)) fail(line, `\`${literal}\` is not a string literal`)
    const body = literal.slice(1, -1)
    let bytes = 0
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== '\\') {
            // A run of plain characters, encoded whole so a surrogate pair counts as one character.
            const run = /^[^\\]+/.exec(body.slice(index))![0]
            if (run.includes('"')) fail(line, 'an unescaped quote inside a string')
            bytes += ENCODER.encode(run).length
            index += run.length - 1
            continue
        }
        const escape = body[index + 1]
        if (escape === undefined) fail(line, 'a string ending in a backslash')
        if ('bfnrt\\"'.includes(escape!)) index += 1
        else if (/[0-7]/.test(escape!)) index += /^[0-7]{1,3}/.exec(body.slice(index + 1))![0].length
        else if (escape === 'x' && /^[0-9a-fA-F]/.test(body.slice(index + 2))) {
            index += 1 + /^[0-9a-fA-F]+/.exec(body.slice(index + 2))![0].length
        } else fail(line, `the escape \\${escape} in a string`)
        bytes += 1
    }
    return bytes
}
