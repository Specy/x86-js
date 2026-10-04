import { parseInteger, type Token } from './lexer'
import { NASM_REGISTERS } from './nasm-reserved'
import type { TranslationDiagnosticCode } from './types'

/** A symbol as an operand names it, before renaming and escaping. */
export type SymbolRef = { readonly name: string; readonly column: number }

/** `g` a general register, `x` an `xmm` register, `f` an x87 register. */
export type RegisterClass = 'g' | 'x' | 'f'

export type Operand =
    /** `name` is the output spelling: `eax`, `xmm0`, `st1`. */
    | {
          readonly kind: 'register'
          readonly name: string
          readonly registerClass: RegisterClass
          /** The x87 stack index of `st` or `st(i)`. */
          readonly x87?: number
          /** The register as written, when it stood alone, which is what an ambiguous name looks like. */
          readonly bare?: Token
      }
    /** NASM's `to stN`: an x87 destination other than `st0`. */
    | { readonly kind: 'x87-to'; readonly name: string }
    | { readonly kind: 'immediate'; readonly text: string }
    /** `OFFSET FLAT:sym+8`: the symbol's address as an immediate. */
    | { readonly kind: 'address'; readonly symbol: SymbolRef; readonly addend: string }
    /** A bare symbol, which only a branch takes. */
    | { readonly kind: 'target'; readonly symbol: SymbolRef }
    | {
          readonly kind: 'memory'
          readonly size: string | null
          readonly symbol: SymbolRef | null
          /** `rip` for a RIP-relative operand. */
          readonly base: string | null
          readonly offset: string | null
          readonly index: string | null
          readonly scale: string | null
          /** `call [QWORD PTR [rbx]]`: the brackets GCC writes around an indirect branch's operand. */
          readonly indirect: boolean
      }

export type OperandProblem = {
    readonly code: TranslationDiagnosticCode
    readonly message: string
    readonly column: number
    /** A register name standing alone, which a symbol of the same name would make ambiguous instead. */
    readonly register?: Token
}

export type OperandResult = { readonly operand: Operand } | { readonly problem: OperandProblem }

/**
 * GCC's Intel size names and NASM's. Maps, like every table the input's words are looked up in, so
 * that no word reads a property every object has (`constructor PTR`, `__proto__ PTR`).
 */
const SIZES: ReadonlyMap<string, string> = new Map([
    ['byte', 'byte'],
    ['word', 'word'],
    ['dword', 'dword'],
    ['qword', 'qword'],
    ['tbyte', 'tword'],
    ['xmmword', 'oword'],
])

const UNSUPPORTED_SIZES: ReadonlyMap<string, string> = new Map([
    ['ymmword', 'a 32-byte operand needs AVX'],
    ['zmmword', 'a 64-byte operand needs AVX-512'],
])

const GPR64 = [
    'rax',
    'rbx',
    'rcx',
    'rdx',
    'rsi',
    'rdi',
    'rbp',
    'rsp',
    'r8',
    'r9',
    'r10',
    'r11',
    'r12',
    'r13',
    'r14',
    'r15',
]

/** The general registers of x86-64 in every width, as GCC spells them. */
const GENERAL_REGISTERS = new Set([
    ...GPR64,
    ...['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp'],
    ...['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp'],
    ...['al', 'bl', 'cl', 'dl', 'ah', 'bh', 'ch', 'dh', 'sil', 'dil', 'bpl', 'spl'],
    ...[8, 9, 10, 11, 12, 13, 14, 15].flatMap((n) => [`r${n}d`, `r${n}w`, `r${n}b`]),
])

const SEGMENT_REGISTERS = new Set(['es', 'cs', 'ss', 'ds', 'fs', 'gs'])

/**
 * What GNU as reads as a register in GCC's output: NASM's register names, which are GNU as's apart
 * from NASM's own `st0`-`st7` and `segr6`-`segr7`, plus GNU as's `st` and its address-only names.
 */
const GAS_REGISTERS = new Set([
    ...NASM_REGISTERS.filter((name) => !/^st[0-7]$|^segr[67]$/.test(name)),
    'st',
    'rip',
    'eip',
    'riz',
    'eiz',
])

/** Whether GNU as reads `text` as a register, whatever its case. */
export function isGasRegister(text: string): boolean {
    return GAS_REGISTERS.has(text.toLowerCase())
}

/** Why a register outside the translator's set is rejected; the code is the Diagnostic's. */
function registerProblem(name: string): { code: TranslationDiagnosticCode; reason: string } {
    if (/^mm[0-7]$/.test(name))
        return {
            code: 'unsupported-instruction',
            reason: "is an MMX register, and this Core's Blink is built without MMX",
        }
    if (/^ymm\d+$/.test(name)) return { code: 'unsupported-instruction', reason: 'is an AVX register' }
    if (/^(zmm\d+|xmm(1[6-9]|2\d|3[01]))$/.test(name))
        return { code: 'unsupported-instruction', reason: 'is an AVX-512 register' }
    if (/^k[0-7]$/.test(name)) return { code: 'unsupported-instruction', reason: 'is an AVX-512 mask register' }
    if (/^r(1[6-9]|2\d|3[01])[bwd]?$/.test(name))
        return { code: 'unsupported-instruction', reason: 'is an APX register' }
    if (/^tmm\d$/.test(name)) return { code: 'unsupported-instruction', reason: 'is an AMX register' }
    if (/^bnd\d$/.test(name)) return { code: 'unsupported-instruction', reason: 'is an MPX register' }
    if (SEGMENT_REGISTERS.has(name)) return { code: 'unsupported-instruction', reason: 'is a segment register' }
    if (/^(cr|dr|tr)\d+$/.test(name)) return { code: 'unsupported-instruction', reason: 'is a system register' }
    return { code: 'unsupported-operand', reason: 'cannot stand alone as an operand' }
}

type OperandToken = { readonly kind: 'ident' | 'number' | 'punct'; readonly text: string; readonly column: number }

function tokenize(operand: Token): OperandToken[] | OperandProblem {
    const tokens: OperandToken[] = []
    const text = operand.text
    let index = 0
    while (index < text.length) {
        const character = text[index]!
        const column = operand.column + index
        if (/\s/.test(character)) {
            index += 1
            continue
        }
        const ident = /^[A-Za-z_.$][A-Za-z0-9_.$]*/.exec(text.slice(index))
        if (ident) {
            tokens.push({ kind: 'ident', text: ident[0], column })
            index += ident[0].length
            continue
        }
        const number = /^[0-9][A-Za-z0-9_]*/.exec(text.slice(index))
        if (number) {
            if (/^\d+[bf]$/.test(number[0])) {
                return {
                    code: 'unsupported-symbol',
                    message: `\`${number[0]}\` refers to a numeric label, which the translator does not read`,
                    column,
                }
            }
            tokens.push({ kind: 'number', text: number[0], column })
            index += number[0].length
            continue
        }
        if ('[](),+-*:'.includes(character)) {
            tokens.push({ kind: 'punct', text: character, column })
            index += 1
            continue
        }
        if (character === '@') {
            const operator = /^@[A-Za-z0-9_]*/.exec(text.slice(index))?.[0] ?? character
            return {
                code: 'unsupported-operand',
                message: `relocation operator \`${operator}\` has no translation; the profile compiles with -fno-pie and without thread-local storage`,
                column,
            }
        }
        return { code: 'unsupported-operand', message: `unexpected \`${character}\` in operand \`${text}\``, column }
    }
    return tokens
}

const isPunct = (token: OperandToken | undefined, text: string) => token?.kind === 'punct' && token.text === text
const isWord = (token: OperandToken | undefined, word: string) =>
    token?.kind === 'ident' && token.text.toLowerCase() === word

function shapeProblem(operand: Token): OperandProblem {
    return {
        code: 'unsupported-operand',
        message: `operand \`${operand.text}\` has a shape the translator does not read`,
        column: operand.column,
    }
}

/** A number the operand grammar accepts, with its sign. */
function readNumber(tokens: readonly OperandToken[], at: number): { text: string; value: bigint; next: number } | null {
    const negative = isPunct(tokens[at], '-')
    const token = tokens[negative ? at + 1 : at]
    if (token?.kind !== 'number') return null
    const value = parseInteger(token.text)
    if (value === null) return null
    return {
        text: negative ? `-${token.text}` : token.text,
        value: negative ? -value : value,
        next: (negative ? at + 1 : at) + 1,
    }
}

/**
 * Reads one instruction operand of GCC's Intel syntax, as `ix86_print_operand` writes them: a
 * register, `st(i)`, an integer, `OFFSET FLAT:sym±n`, a bare branch target, or memory, which is an
 * optional `SIZE PTR`, an optional symbol and `[base±offset+index*scale]`, `[offset+index*scale]`
 * or `[rip±offset]`, and for an indirect branch the whole of that in brackets once more.
 */
export function parseOperand(operand: Token): OperandResult {
    const tokens = tokenize(operand)
    if (!Array.isArray(tokens)) return { problem: tokens }
    if (tokens.length === 0)
        return { problem: { code: 'unsupported-operand', message: 'empty operand', column: operand.column } }
    const [first, second] = tokens

    const sizeName = first?.kind === 'ident' ? first.text.toLowerCase() : ''
    if (first?.kind === 'ident' && isWord(second, 'ptr')) {
        const unsupported = UNSUPPORTED_SIZES.get(sizeName)
        if (unsupported) {
            return {
                problem: {
                    code: 'unsupported-instruction',
                    message: `\`${first.text} PTR\`: ${unsupported}`,
                    column: first.column,
                },
            }
        }
        const size = SIZES.get(sizeName)
        if (!size) return { problem: shapeProblem(operand) }
        return parseMemory(operand, tokens.slice(2), size, false)
    }

    if (isPunct(first, '[') && isPunct(tokens[tokens.length - 1], ']') && isWord(tokens[2], 'ptr')) {
        const innerSize = tokens[1]?.kind === 'ident' ? SIZES.get(tokens[1].text.toLowerCase()) : undefined
        if (!innerSize) return { problem: shapeProblem(operand) }
        return parseMemory(operand, tokens.slice(3, -1), innerSize, true)
    }
    if (isPunct(first, '[')) return parseMemory(operand, tokens, null, false)

    if (isWord(first, 'offset') && isWord(second, 'flat') && isPunct(tokens[2], ':')) {
        const symbol = tokens[3]
        if (symbol?.kind !== 'ident') return { problem: shapeProblem(operand) }
        if (tokens.length === 4)
            return { operand: { kind: 'address', symbol: { name: symbol.text, column: symbol.column }, addend: '' } }
        const sign = tokens[4]
        const number = tokens[5]
        const value = number?.kind === 'number' ? parseInteger(number.text) : null
        if (tokens.length !== 6 || !(isPunct(sign, '+') || isPunct(sign, '-')) || value === null) {
            return { problem: expressionProblem(operand) }
        }
        return {
            operand: {
                kind: 'address',
                symbol: { name: symbol.text, column: symbol.column },
                addend: `${sign!.text}${number!.text}`,
            },
        }
    }

    if (
        first?.kind === 'ident' &&
        first.text.toLowerCase() === 'st' &&
        tokens.length === 4 &&
        isPunct(second, '(') &&
        isPunct(tokens[3], ')')
    ) {
        const index = tokens[2]?.kind === 'number' ? /^[0-7]$/.exec(tokens[2].text) : null
        if (!index) return { problem: shapeProblem(operand) }
        return { operand: { kind: 'register', name: `st${index[0]}`, registerClass: 'f', x87: Number(index[0]) } }
    }

    if (first?.kind === 'ident' && tokens.length === 1) {
        const name = first.text.toLowerCase()
        if (!isGasRegister(name))
            return { operand: { kind: 'target', symbol: { name: first.text, column: first.column } } }
        const bare = { text: first.text, column: first.column }
        if (name === 'st') return { operand: { kind: 'register', name: 'st0', registerClass: 'f', x87: 0, bare } }
        if (GENERAL_REGISTERS.has(name)) return { operand: { kind: 'register', name, registerClass: 'g', bare } }
        if (/^xmm([0-9]|1[0-5])$/.test(name)) return { operand: { kind: 'register', name, registerClass: 'x', bare } }
        const problem = registerProblem(name)
        return {
            problem: {
                code: problem.code,
                message: `\`${first.text}\` ${problem.reason}`,
                column: first.column,
                register: bare,
            },
        }
    }

    if (first?.kind === 'ident' && isPunct(second, '[')) return parseMemory(operand, tokens, null, false)
    if (first?.kind === 'ident' && SEGMENT_REGISTERS.has(first.text.toLowerCase()) && isPunct(second, ':')) {
        return { problem: segmentProblem(first) }
    }

    const number = readNumber(tokens, 0)
    if (number && number.next === tokens.length) return { operand: { kind: 'immediate', text: number.text } }
    if (first?.kind === 'number' && parseInteger(first.text) === null) {
        return {
            problem: {
                code: 'unsupported-operand',
                message: `\`${first.text}\` is not an integer the translator reads`,
                column: first.column,
            },
        }
    }
    return { problem: expressionProblem(operand) }
}

function expressionProblem(operand: Token): OperandProblem {
    return {
        code: 'unsupported-operand',
        message: `operand \`${operand.text}\` is an expression beyond an integer, a symbol, or a symbol plus or minus an integer`,
        column: operand.column,
    }
}

function segmentProblem(token: OperandToken): OperandProblem {
    const why = /^[fg]s$/i.test(token.text)
        ? 'GCC writes it for thread-local storage and the stack protector'
        : 'GCC writes it for an absolute address'
    return {
        code: 'unsupported-operand',
        message: `segment override \`${token.text}:\` has no translation; ${why}`,
        column: token.column,
    }
}

function parseMemory(
    operand: Token,
    tokens: readonly OperandToken[],
    size: string | null,
    indirect: boolean,
): OperandResult {
    let at = 0
    const head = tokens[0]
    if (head?.kind === 'ident' && SEGMENT_REGISTERS.has(head.text.toLowerCase()) && isPunct(tokens[1], ':')) {
        return { problem: segmentProblem(head) }
    }
    let symbol: SymbolRef | null = null
    if (head?.kind === 'ident' && isPunct(tokens[1], '[')) {
        // Plan note 1: whatever its spelling, a token before `[` is a symbol.
        symbol = { name: head.text, column: head.column }
        at = 1
    }
    if (!isPunct(tokens[at], '[') || !isPunct(tokens[tokens.length - 1], ']')) return { problem: shapeProblem(operand) }
    const inner = tokens.slice(at + 1, -1)
    if (inner.some((token) => isPunct(token, '[') || isPunct(token, ']'))) return { problem: shapeProblem(operand) }

    let index = 0
    let base: string | null = null
    let offset: { text: string; value: bigint } | null = null
    let indexRegister: string | null = null
    let scale: string | null = null

    const baseToken = inner[0]
    if (baseToken?.kind === 'ident') {
        const name = baseToken.text.toLowerCase()
        if (name !== 'rip' && !GPR64.includes(name)) return { problem: addressRegisterProblem(baseToken) }
        base = name
        index = 1
        if (isPunct(inner[1], '+') || isPunct(inner[1], '-')) {
            const value = inner[2]?.kind === 'number' ? parseInteger(inner[2].text) : null
            if (value !== null) {
                offset = {
                    text: `${inner[1]!.text === '-' ? '-' : ''}${inner[2]!.text}`,
                    value: inner[1]!.text === '-' ? -value : value,
                }
                index = 3
            }
        }
    } else {
        const number = readNumber(inner, 0)
        if (!number) return { problem: shapeProblem(operand) }
        offset = { text: number.text, value: number.value }
        index = number.next
    }
    if (isPunct(inner[index], '+') && inner[index + 1]?.kind === 'ident') {
        const register = inner[index + 1]!
        const name = register.text.toLowerCase()
        if (!GPR64.includes(name) || name === 'rsp') return { problem: addressRegisterProblem(register) }
        indexRegister = name
        index += 2
        if (isPunct(inner[index], '*')) {
            const factor = inner[index + 1]
            if (factor?.kind !== 'number' || !['1', '2', '4', '8'].includes(factor.text))
                return { problem: shapeProblem(operand) }
            scale = factor.text
            index += 2
        }
    }
    if (index !== inner.length) return { problem: shapeProblem(operand) }

    if (base === 'rip' && (indexRegister || !symbol)) return { problem: shapeProblem(operand) }
    if (!base && !indexRegister) {
        return {
            problem: {
                code: 'unsupported-operand',
                message: `operand \`${operand.text}\` is an absolute address, which the translator does not read`,
                column: operand.column,
            },
        }
    }
    return {
        operand: {
            kind: 'memory',
            size,
            symbol,
            base,
            offset: offset ? offset.text : null,
            index: indexRegister,
            scale,
            indirect,
        },
    }
}

function addressRegisterProblem(token: OperandToken): OperandProblem {
    return {
        code: 'unsupported-operand',
        message: `\`${token.text}\` is not a 64-bit base or index register the translator reads in an address`,
        column: token.column,
    }
}

/** Whether an offset of a memory operand is zero, which NASM needs no `+0` for after a symbol. */
function isZero(text: string): boolean {
    return parseInteger(text.replace(/^-/, '')) === 0n
}

/** The operand in NASM syntax, `nasmName` spelling each symbol. */
export function renderOperand(operand: Operand, nasmName: (name: string) => string): string {
    switch (operand.kind) {
        case 'register':
            return operand.name
        case 'x87-to':
            return `to ${operand.name}`
        case 'immediate':
            return operand.text
        case 'address':
            return `${nasmName(operand.symbol.name)}${operand.addend}`
        case 'target':
            return nasmName(operand.symbol.name)
        case 'memory': {
            const signed = (text: string) => (text.startsWith('-') ? text : `+${text}`)
            let address: string
            if (operand.base === 'rip') {
                address = `rel ${nasmName(operand.symbol!.name)}${operand.offset && !isZero(operand.offset) ? signed(operand.offset) : ''}`
            } else {
                address = operand.symbol ? nasmName(operand.symbol.name) : ''
                if (operand.base) address += `${address ? '+' : ''}${operand.base}`
                if (operand.offset !== null) {
                    if (operand.base) address += signed(operand.offset)
                    else if (operand.symbol) address += isZero(operand.offset) ? '' : signed(operand.offset)
                    else address += operand.offset
                }
                if (operand.index) address += `+${operand.index}${operand.scale ? `*${operand.scale}` : ''}`
            }
            return `${operand.size ? `${operand.size} ` : ''}[${address}]`
        }
    }
}

/** The operand kind an instruction-set form names: `g`, `x`, `f`, `m` or `i`. */
export function operandKind(operand: Operand): string {
    switch (operand.kind) {
        case 'register':
            return operand.registerClass
        case 'x87-to':
            return 'f'
        case 'memory':
            return 'm'
        default:
            return 'i'
    }
}

/** The symbols an operand names, in the order it names them. */
export function operandSymbols(operand: Operand): SymbolRef[] {
    if (operand.kind === 'address' || operand.kind === 'target') return [operand.symbol]
    if (operand.kind === 'memory' && operand.symbol) return [operand.symbol]
    return []
}
