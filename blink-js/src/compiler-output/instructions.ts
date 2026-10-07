import { splitCommas, type Token } from './lexer'
import { NASM_INSTRUCTION_SET, NASM_REJECTION_REASONS } from './nasm-instruction-set'
import { operandKind, parseOperand, type Operand, type OperandProblem } from './operands'

export type Instruction = {
    /** `rep`, `lock` and the like, as written. */
    readonly prefix: string | null
    /** As written; GCC writes lowercase. */
    readonly mnemonic: string
    readonly operands: readonly Operand[]
}

export type InstructionResult = { readonly instruction: Instruction } | { readonly problems: readonly OperandProblem[] }

/** The prefixes GCC writes as words of their own, which NASM spells the same. */
const PREFIXES = new Set(['rep', 'repe', 'repz', 'repne', 'repnz', 'lock'])

/** GNU as prefix words with no NASM spelling the translator writes, or no place in the profile. */
const UNSUPPORTED_PREFIXES = new Set([
    'data16',
    'data32',
    'addr16',
    'addr32',
    'rex',
    'rex64',
    'rex2',
    'notrack',
    'bnd',
    'xacquire',
    'xrelease',
    'cs',
    'ds',
    'es',
    'fs',
    'gs',
    'ss',
])

/** A one-operand shift or rotate is by one in GNU as; NASM wants the count written. */
const SHIFTS = new Set(['sal', 'shl', 'sar', 'shr', 'rol', 'ror', 'rcl', 'rcr'])

const CONDITIONS = [
    'a',
    'ae',
    'b',
    'be',
    'c',
    'e',
    'g',
    'ge',
    'l',
    'le',
    'na',
    'nae',
    'nb',
    'nbe',
    'nc',
    'ne',
    'ng',
    'nge',
    'nl',
    'nle',
    'no',
    'np',
    'ns',
    'nz',
    'o',
    'p',
    'pe',
    'po',
    's',
    'z',
]

/** The instructions whose operand may be a bare symbol: a branch target, never a memory operand. */
const BRANCHES = new Set([
    'call',
    'jmp',
    'jcxz',
    'jecxz',
    'jrcxz',
    'loop',
    'loope',
    'loopne',
    'loopnz',
    'loopz',
    ...CONDITIONS.map((condition) => `j${condition}`),
])

/** x87 arithmetic, whose two-register forms milestone 1's matrix verifies (plan note 2). */
const X87_ARITHMETIC = new Set(['fadd', 'fsub', 'fsubr', 'fmul', 'fdiv', 'fdivr'])
const X87_POPPING = new Set(['faddp', 'fsubp', 'fsubrp', 'fmulp', 'fdivp', 'fdivrp'])
/** Comparisons with `st` first, as the corpus has them. */
const X87_COMPARISONS = new Set(['fcomi', 'fcomip', 'fucomi', 'fucomip'])
/** One-register x87 instructions, which mean the same to GNU as and NASM. */
const X87_SINGLE = new Set(['fld', 'fst', 'fstp', 'fxch', 'fcom', 'fcomp', 'fucom', 'fucomp', 'ffree'])

/** The instruction set the profile allows, for messages. */
const ALLOWED_SET = 'the x86-64 baseline, x87, SSE, SSE2 and SSE3'

/**
 * What inline assembly may use besides that set, with its forms: `syscall`, the instruction a Linux
 * program makes its system calls with, which Blink runs as Linux does. GCC's own output never has
 * it, so only an `#APP` block may.
 */
const INLINE_ASSEMBLY_INSTRUCTIONS: ReadonlyMap<string, string> = new Map([['syscall', '_']])

/** Where inline assembly's own rules apply, the message's addition to {@link ALLOWED_SET}. */
const INLINE_ALLOWED_SET = `${ALLOWED_SET}, and \`syscall\` in inline assembly`

/** What an AT&T-syntax diagnostic adds: why, and what to write instead. */
const INTEL_SYNTAX =
    'the profile compiles with -masm=intel, so inline assembly is written in Intel syntax (`mov eax, 1`, not `movl $1, %eax`)'

/** A first word and the rest of the statement after the whitespace that ends it. */
const WORDS = /^(\S+)(?:\s+([\s\S]*))?$/

export type InstructionOptions = {
    /**
     * The statement is inline assembly, between `#APP` and `#NO_APP`: `syscall` is allowed, every
     * memory operand but `lea`'s must have a size, as GCC writes them, and AT&T syntax is named.
     */
    readonly inlineAssembly?: boolean
}

/**
 * Reads an instruction statement and translates it: GCC's operands into NASM's, a count for
 * one-operand shifts, the x87 register forms NASM accepts, and the instruction-set check.
 */
export function translateInstruction(body: Token, options: InstructionOptions = {}): InstructionResult {
    const inline = options.inlineAssembly === true
    const words = WORDS.exec(body.text)
    if (!words) {
        return problem(
            'unsupported-instruction',
            `\`${body.text}\` is not an instruction the translator reads`,
            body.column,
        )
    }
    let mnemonic = { text: words[1]!, column: body.column }
    let rest = words[2] ?? ''
    let restColumn = body.column + body.text.length - rest.length
    let prefix: string | null = null

    if (UNSUPPORTED_PREFIXES.has(mnemonic.text.toLowerCase())) {
        return problem('unsupported-instruction', prefixMessage(mnemonic.text), mnemonic.column)
    }
    if (PREFIXES.has(mnemonic.text.toLowerCase())) {
        const next = WORDS.exec(rest)
        if (!next)
            return problem(
                'unsupported-instruction',
                `prefix \`${mnemonic.text}\` without an instruction`,
                mnemonic.column,
            )
        prefix = mnemonic.text
        const column = restColumn
        mnemonic = { text: next[1]!, column }
        rest = next[2] ?? ''
        restColumn = body.column + body.text.length - rest.length
        const lower = mnemonic.text.toLowerCase()
        if (UNSUPPORTED_PREFIXES.has(lower))
            return problem('unsupported-instruction', prefixMessage(mnemonic.text), mnemonic.column)
        if (PREFIXES.has(lower)) {
            return problem(
                'unsupported-instruction',
                `a second prefix, \`${mnemonic.text}\`, has no translation`,
                mnemonic.column,
            )
        }
    }

    const name = mnemonic.text.toLowerCase()
    const pieces = splitCommas({ text: rest, column: restColumn })
    if (inline) {
        const att = attSyntax(body, mnemonic, name, pieces)
        if (att) return problem('unsupported-instruction', `${att.message}; ${INTEL_SYNTAX}`, att.column)
    }
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
        return problem(
            'unsupported-instruction',
            `\`${mnemonic.text}\` is not an instruction the translator reads`,
            mnemonic.column,
        )
    }
    const entry = NASM_INSTRUCTION_SET.get(name)
    if (!entry)
        return problem('unsupported-instruction', `NASM 3.00 has no instruction \`${mnemonic.text}\``, mnemonic.column)

    const parsed: Operand[] = []
    const problems: OperandProblem[] = []
    for (const piece of pieces) {
        const result = parseOperand(piece)
        if ('problem' in result) problems.push(result.problem)
        else parsed.push(result.operand)
    }
    if (problems.length) return { problems }

    if (inline && name !== 'lea') {
        // NASM assumes a size for some operands GNU as calls ambiguous, and for `pop [rdi]` it
        // assumes another one, so inline assembly writes every size, as GCC does outside `lea`.
        const unsized = parsed.findIndex((operand) => operand.kind === 'memory' && operand.size === null)
        if (unsized >= 0) {
            const { text, column } = pieces[unsized]!
            return problem(
                'unsupported-operand',
                `memory operand \`${text}\` has no size, which NASM and GNU as do not read alike; name its size as GCC does, such as \`DWORD PTR ${text}\``,
                column,
            )
        }
    }

    for (const operand of parsed) {
        if (operand.kind === 'target' && !BRANCHES.has(name)) {
            return problem(
                'unsupported-operand',
                `\`${operand.symbol.name}\` alone is a memory operand to GNU as but an immediate to NASM; GCC writes \`${operand.symbol.name}[rip]\` or \`OFFSET FLAT:${operand.symbol.name}\` for those`,
                operand.symbol.column,
            )
        }
        if (operand.kind === 'memory' && operand.indirect && name !== 'call' && name !== 'jmp') {
            return problem(
                'unsupported-operand',
                'only an indirect `call` or `jmp` takes a bracketed memory operand',
                mnemonic.column,
            )
        }
    }

    const x87 = translateX87(name, parsed, mnemonic)
    if ('problems' in x87) return x87
    let operands = x87.operands
    if (SHIFTS.has(name) && operands.length === 1) operands = [...operands, { kind: 'immediate', text: '1' }]

    const kinds = operands.map(operandKind)
    const [allowed, rejected] = entry
    const admitted = inline ? INLINE_ASSEMBLY_INSTRUCTIONS.get(name) : undefined
    if ([allowed, admitted].some((list) => list && list.split('|').some((form) => formMatches(form, kinds)))) {
        return { instruction: { prefix, mnemonic: mnemonic.text, operands } }
    }
    const forms = rejected ? rejected.split('|').map((form) => form.split('=') as [string, string]) : []
    const matching = forms.filter(([form]) => form === '*' || formMatches(form, kinds))
    const all = [...new Set((matching.length ? matching : forms).flatMap(([, indices]) => indices.split('+')))].map(
        (index) => NASM_REJECTION_REASONS[Number(index)]!,
    )
    // APX re-encodes many legacy instructions; the legacy form's reason is the one that explains.
    const legacy = all.filter((reason) => !reason.includes('APX'))
    const reasons = legacy.length ? legacy : all
    const which = allowed || admitted ? ' in this form' : ''
    const why = reasons.length ? reasons.join(' or ') : 'has no form with these operands'
    return problem(
        'unsupported-instruction',
        `\`${mnemonic.text}\`${which} ${why}; the profile allows ${inline ? INLINE_ALLOWED_SET : ALLOWED_SET}`,
        mnemonic.column,
    )
}

/** AT&T's operand-size suffixes, which GNU as reads on a mnemonic and NASM never does. */
const ATT_SUFFIXES = new Set(['b', 'w', 'l', 'q'])

/**
 * The first sign that an instruction of inline assembly is in AT&T syntax, which GCC passes through
 * unchanged, or null: a `%` before a register, which no Intel operand has; a `$` before an
 * immediate; or a mnemonic NASM lacks that is one of its own with an AT&T size suffix (`movl`).
 */
function attSyntax(
    body: Token,
    mnemonic: Token,
    name: string,
    operands: readonly Token[],
): { readonly message: string; readonly column: number } | null {
    const percent = body.text.indexOf('%')
    if (percent >= 0) {
        const sign = /^%[A-Za-z0-9_.$]*/.exec(body.text.slice(percent))![0]
        return { message: `\`${sign}\` is AT&T syntax`, column: body.column + percent }
    }
    const immediate = operands.find((operand) => operand.text.startsWith('$'))
    if (immediate) return { message: `\`${immediate.text}\` is an AT&T immediate`, column: immediate.column }
    const suffixed =
        !NASM_INSTRUCTION_SET.has(name) &&
        ATT_SUFFIXES.has(name.slice(-1)) &&
        NASM_INSTRUCTION_SET.has(name.slice(0, -1))
    if (suffixed) {
        return {
            message: `\`${mnemonic.text}\` is \`${name.slice(0, -1)}\` with an AT&T size suffix`,
            column: mnemonic.column,
        }
    }
    return null
}

/** Whether operand kinds fit a form of the instruction-set table, such as `g,gm` or `_`. */
function formMatches(form: string, kinds: readonly string[]): boolean {
    const expected = form === '_' ? [] : form.split(',')
    return expected.length === kinds.length && expected.every((accepted, index) => accepted.includes(kinds[index]!))
}

/**
 * NASM 3.00 rejects every two-register x87 spelling (plan note 2), so `fop st, st(i)` becomes
 * `fop sti`, `fopp st(i), st` becomes `fopp sti` and a non-popping `fop st(i), st` becomes
 * `fop to sti`: exactly the forms milestone 1's x87 matrix verifies, plus the comparisons and
 * one-register forms of the corpus. Any other x87 register form is an error.
 */
function translateX87(
    name: string,
    operands: readonly Operand[],
    mnemonic: Token,
): { operands: Operand[] } | { problems: OperandProblem[] } {
    const stack = operands.map((operand) =>
        operand.kind === 'register' && operand.registerClass === 'f' ? operand : null,
    )
    const registers = stack.filter((operand) => operand !== null)
    const [first, second] = stack
    const outside = () =>
        problem(
            'unsupported-instruction',
            `\`${mnemonic.text}\` with these x87 operands is outside the forms the translator verifies`,
            mnemonic.column,
        ) as { problems: OperandProblem[] }

    if (X87_ARITHMETIC.has(name)) {
        if (operands.length === 1 && operands[0]!.kind === 'memory') return { operands: [...operands] }
        if (operands.length !== 2 || !first || !second) return outside()
        if (first.x87 === 0) return { operands: [second] }
        if (second.x87 === 0) return { operands: [{ kind: 'x87-to', name: first.name }] }
        return outside()
    }
    if (X87_POPPING.has(name)) {
        if (operands.length === 2 && first && second && second.x87 === 0) return { operands: [first] }
        return outside()
    }
    if (X87_COMPARISONS.has(name)) {
        if (operands.length === 2 && first && second && first.x87 === 0) return { operands: [second] }
        return outside()
    }
    if (X87_SINGLE.has(name)) {
        if (operands.length <= 1) return { operands: [...operands] }
        return outside()
    }
    if (registers.length) return outside()
    return { operands: [...operands] }
}

function prefixMessage(prefix: string): string {
    if (prefix.toLowerCase() === 'notrack') {
        // NASM 3.00 has no `notrack`: it reads the word as a label and drops the prefix without a
        // warning. `ds` and `{pt}` warn, and `db 0x3e` on a line of its own splits the instruction
        // in two for the debugger, so none of them is an exact equivalent.
        return 'prefix `notrack` (from -fcf-protection) has no exact NASM 3.00 equivalent; the profile compiles with -fcf-protection=none'
    }
    return `prefix \`${prefix}\` has no translation`
}

function problem(code: OperandProblem['code'], message: string, column: number): { problems: OperandProblem[] } {
    return { problems: [{ code, message, column }] }
}
