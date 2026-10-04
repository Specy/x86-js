import { GAS_SYMBOL } from './lexer'
import { NASM_RESERVED_NAMES } from './nasm-reserved'

const RESERVED = new Set(NASM_RESERVED_NAMES)

/** NASM copies at most this many characters of an identifier (`IDLEN_MAX - 1` in `include/nasm.h`). */
const NASM_IDENTIFIER_LIMIT = 4095

/** Whether NASM reads `name` as an instruction, register, keyword, directive or standard macro. */
export function isReservedName(name: string): boolean {
    return RESERVED.has(name.toLowerCase())
}

/** GCC's assembler-local labels, which NASM would scope to the previous ordinary label. */
export function isLocalLabel(name: string): boolean {
    return name.startsWith('.L')
}

/**
 * The labels GCC writes only for debug information and call-frame tables, which the translation
 * drops: function and block boundaries, variable locations, and the text and debug section anchors.
 */
export function isDebugLabel(name: string): boolean {
    return /^\.L(?:FB|FE|BB|BE|VL)\d+$/.test(name) || /^\.Le?text\d+$/.test(name) || /^\.Ldebug\w*$/.test(name)
}

/** Why a symbol name cannot be translated, or null when it can. */
export function symbolNameProblem(name: string): string | null {
    if (!GAS_SYMBOL.test(name)) return `\`${name}\` is not a symbol name the translator reads`
    if (name.startsWith('$')) {
        return `\`${name}\` starts with \`$\`, which NASM reads as an escape rather than part of the name`
    }
    if (name.startsWith('.') && !isLocalLabel(name)) {
        return `\`${name}\` starts with \`.\`, which NASM reads as a label local to the previous one`
    }
    if (name.length >= NASM_IDENTIFIER_LIMIT) {
        return `\`${name.slice(0, 40)}…\` is longer than the ${NASM_IDENTIFIER_LIMIT} characters NASM keeps of a name`
    }
    return null
}

/**
 * How the output spells each name: a `.L` label loses its dot and gains `_` until it differs from
 * every other name of the unit, and a name NASM reserves is `$`-escaped.
 */
export class NameMap {
    private readonly spelled = new Map<string, string>()
    private escapedAny = false

    /** `unitNames` are every name the unit defines or references. */
    constructor(private readonly unitNames: ReadonlySet<string>) {}

    /** The name as the output spells it. */
    nasmName(name: string): string {
        const known = this.spelled.get(name)
        if (known !== undefined) return known
        let renamed = name
        if (isLocalLabel(name)) {
            renamed = name.slice(1)
            while (this.unitNames.has(renamed)) renamed = `_${renamed}`
        }
        const spelling = isReservedName(renamed) ? `$${renamed}` : renamed
        this.spelled.set(name, spelling)
        return spelling
    }

    /** Use while emitting: the same as {@link nasmName}, recording whether the output escapes a name. */
    emit(name: string): string {
        const spelling = this.nasmName(name)
        if (spelling.startsWith('$')) this.escapedAny = true
        return spelling
    }

    /** Whether any name emitted so far is `$`-escaped, which the header must allow for. */
    get escapes(): boolean {
        return this.escapedAny
    }
}
