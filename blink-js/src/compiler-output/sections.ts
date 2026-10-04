import type { Token } from './lexer'

/** The NASM sections GCC's sections flatten into. */
export type SectionFamily = '.text' | '.rodata' | '.data' | '.bss' | '.init_array'

export type SectionClass =
    | { readonly kind: 'kept'; readonly family: SectionFamily }
    /** Debug information and notes, whose contents the translation drops. */
    | { readonly kind: 'dropped' }
    | { readonly kind: 'unsupported'; readonly message: string; readonly column: number }

/**
 * The alignment NASM's ELF backend gives each section unless told otherwise (`output/outelf.c`,
 * `elf_known_sections`; `.init_array` gets the pointer size).
 */
export const NASM_DEFAULT_ALIGNMENT: Readonly<Record<SectionFamily, number>> = {
    '.text': 16,
    '.rodata': 4,
    '.data': 4,
    '.bss': 4,
    '.init_array': 8,
}

type FamilyRule = {
    readonly family: SectionFamily
    /** Flags GCC writes for the family; `G` (a COMDAT group) is allowed on top of any of them. */
    readonly flags: readonly string[]
    readonly types: readonly string[]
}

const RULES: readonly (FamilyRule & { readonly matches: (name: string) => boolean })[] = [
    { matches: (name) => family(name, '.text'), family: '.text', flags: ['ax'], types: ['@progbits'] },
    {
        matches: (name) => family(name, '.data.rel.ro'),
        family: '.rodata',
        flags: ['aw'],
        types: ['@progbits'],
    },
    {
        matches: (name) => family(name, '.rodata'),
        family: '.rodata',
        flags: ['a', 'aM', 'aMS'],
        types: ['@progbits'],
    },
    { matches: (name) => family(name, '.data'), family: '.data', flags: ['aw'], types: ['@progbits'] },
    { matches: (name) => family(name, '.bss'), family: '.bss', flags: ['aw'], types: ['@nobits'] },
    {
        matches: (name) => name === '.init_array',
        family: '.init_array',
        flags: ['aw', 'a'],
        types: ['@init_array'],
    },
]

function family(name: string, base: string): boolean {
    return name === base || name.startsWith(`${base}.`)
}

/** Sections whose contents are debug information or metadata that a static link does not need. */
function isDropped(name: string): boolean {
    return name.startsWith('.debug_') || name === '.note.GNU-stack' || name === '.note.gnu.property'
}

/** Why GCC would have written each section the translation rejects. */
function unsupportedReason(name: string): string {
    if (name === '.tdata' || name === '.tbss' || family(name, '.tdata') || family(name, '.tbss')) {
        return 'thread-local storage'
    }
    if (/^\.(?:init|fini)_array\.\d+$/.test(name)) return 'a constructor or destructor with a priority'
    if (name === '.fini_array' || name === '.dtors') return 'a destructor run at exit'
    if (name === '.preinit_array' || name === '.ctors') return 'a constructor table version 1 does not run'
    if (name === '.eh_frame' || name === '.gcc_except_table') return 'exception handling'
    return 'a section outside the version 1 rules'
}

/** Classifies a `.section` directive's arguments, `name[,"flags"[,@type[,…]]]`. */
export function classifySection(args: readonly Token[]): SectionClass {
    const nameToken = args[0]
    if (!nameToken || !nameToken.text) {
        return { kind: 'unsupported', message: '`.section` without a name', column: nameToken?.column ?? 1 }
    }
    const name = nameToken.text
    if (!/^[A-Za-z0-9_.$-]+$/.test(name)) {
        return {
            kind: 'unsupported',
            message: `section name \`${name}\` is not one the translator reads`,
            column: nameToken.column,
        }
    }
    const flags = args[1]
    if (name === '.note.GNU-stack' && flags && /^"[A-Za-z?]*x[A-Za-z?]*"$/.test(flags.text)) {
        // The note is dropped, and with it a request for an executable stack, which a nested
        // function's trampoline needs; only the ordinary `""` is dropped.
        return {
            kind: 'unsupported',
            message: `section \`${name}\` with flags ${flags.text} (an executable stack, which GCC asks for when a nested function's trampoline runs on the stack) has no translation`,
            column: flags.column,
        }
    }
    if (isDropped(name)) return { kind: 'dropped' }
    const rule = RULES.find((candidate) => candidate.matches(name))
    if (!rule) {
        return {
            kind: 'unsupported',
            message: `section \`${name}\` (${unsupportedReason(name)}) has no translation`,
            column: nameToken.column,
        }
    }
    const problem = attributeProblem(rule, args)
    if (problem)
        return { kind: 'unsupported', message: `section \`${name}\` ${problem.message}`, column: problem.column }
    return { kind: 'kept', family: rule.family }
}

/** The flags, type and extra fields must be what GCC writes for the family, or nothing at all. */
function attributeProblem(rule: FamilyRule, args: readonly Token[]): { message: string; column: number } | null {
    const [, flagsToken, typeToken, ...rest] = args
    if (!flagsToken) return null
    const flagsMatch = /^"([A-Za-z?]*)"$/.exec(flagsToken.text)
    if (!flagsMatch) return { message: `has unreadable flags \`${flagsToken.text}\``, column: flagsToken.column }
    const flags = flagsMatch[1]!
    const grouped = flags.includes('G')
    const base = flags.replace('G', '')
    if (!rule.flags.includes(base) || flags.indexOf('G') !== flags.lastIndexOf('G')) {
        return {
            message: `has flags "${flags}", where GCC writes ${rule.flags.map((f) => `"${f}"`).join(' or ')}`,
            column: flagsToken.column,
        }
    }
    if (typeToken && !rule.types.includes(typeToken.text)) {
        return {
            message: `has type \`${typeToken.text}\`, where GCC writes \`${rule.types[0]}\``,
            column: typeToken.column,
        }
    }
    if (!typeToken && (grouped || base.includes('M'))) {
        return { message: 'has merge or group flags without a type', column: flagsToken.column }
    }
    let index = 0
    if (base.includes('M')) {
        const entrySize = rest[index]
        if (!entrySize || !/^[1-9][0-9]*$/.test(entrySize.text)) {
            return { message: 'has a merge flag without an entry size', column: entrySize?.column ?? flagsToken.column }
        }
        index += 1
    }
    if (grouped) {
        const group = rest[index]
        if (!group || !/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(group.text)) {
            return { message: 'has a group flag without a group name', column: group?.column ?? flagsToken.column }
        }
        index += 1
        if (rest[index]?.text === 'comdat') index += 1
    }
    const extra = rest[index]
    if (extra) return { message: `has an extra field \`${extra.text}\``, column: extra.column }
    return null
}

/** What `.text`, `.data` and `.bss` written as directives of their own switch to. */
export function bareSectionFamily(directive: string): SectionFamily | null {
    if (directive === '.text') return '.text'
    if (directive === '.data') return '.data'
    if (directive === '.bss') return '.bss'
    return null
}
