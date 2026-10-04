import type { DiagnosticCollector } from './diagnostics'
import { translateInstruction, type Instruction } from './instructions'
import {
    decodeGasString,
    lexLine,
    parseInteger,
    splitCommas,
    unreadableCharacter,
    type LexedStatement,
    type Token,
} from './lexer'
import { LocationTracker } from './locations'
import { isDebugLabel, isLocalLabel, symbolNameProblem } from './names'
import { operandSymbols, type OperandProblem, type SymbolRef } from './operands'
import type { TranslationRules } from './profile'
import { bareSectionFamily, classifySection, type SectionFamily } from './sections'
import type { CompilerLocation } from './types'

export type DataDirective = 'db' | 'dw' | 'dd' | 'dq'

export type DataValue =
    | { readonly kind: 'integer'; readonly text: string }
    | { readonly kind: 'symbol'; readonly symbol: SymbolRef; readonly addend: string }

/** A statement that produces output, in input order. */
export type Statement =
    | { readonly kind: 'section'; readonly line: number; readonly family: SectionFamily }
    | { readonly kind: 'label'; readonly line: number; readonly symbol: SymbolRef }
    /** `.globl` or `.weak`. */
    | { readonly kind: 'binding'; readonly line: number; readonly symbol: SymbolRef }
    | {
          readonly kind: 'common'
          readonly line: number
          readonly symbol: SymbolRef
          readonly size: string
          readonly alignment: number
      }
    | {
          readonly kind: 'align'
          readonly line: number
          readonly bytes: number
          readonly family: SectionFamily
          /** The padding byte; null in code without a fill value, which NASM pads with NOPs. */
          readonly fill: string | null
      }
    | {
          readonly kind: 'data'
          readonly line: number
          readonly directive: DataDirective
          readonly values: readonly DataValue[]
      }
    | { readonly kind: 'zero'; readonly line: number; readonly count: string; readonly family: SectionFamily }
    | {
          readonly kind: 'string'
          readonly line: number
          readonly strings: readonly Uint8Array[]
          readonly terminated: boolean
      }
    | {
          readonly kind: 'instruction'
          readonly line: number
          readonly instruction: Instruction
          readonly location: CompilerLocation | null
      }

export type SymbolUse = { readonly name: string; readonly line: number; readonly column: number }

export type Alias = { readonly alias: SymbolUse; readonly target: SymbolUse }

export type Analysis = {
    readonly statements: readonly Statement[]
    readonly lineLocations: readonly (CompilerLocation | null)[]
    /**
     * Every label definition, in input order: kept, dropped with its debug or note section, or in a
     * section already reported as unsupported, which nothing else is reported about.
     */
    readonly labels: readonly (SymbolUse & { readonly fate: 'kept' | 'dropped' | 'rejected' })[]
    readonly globals: ReadonlyMap<string, readonly SymbolUse[]>
    readonly weak: ReadonlyMap<string, readonly SymbolUse[]>
    readonly locals: ReadonlyMap<string, readonly SymbolUse[]>
    readonly commons: readonly (SymbolUse & { readonly alignment: number })[]
    readonly aliases: readonly Alias[]
    /** `.type x, @gnu_unique_object` under the `weak-object` rule, which must be weak. */
    readonly uniqueObjects: readonly SymbolUse[]
    /** Symbols named by kept instructions and data, first use of each. */
    readonly references: ReadonlyMap<string, SymbolUse>
    /** Every name the translator reads outside dropped sections, at its first appearance. */
    readonly mentions: ReadonlyMap<string, SymbolUse>
    /** Operands written as a register name alone, which a symbol of that name would make ambiguous. */
    readonly bareRegisters: readonly SymbolUse[]
    /**
     * Register names standing alone that the translator rejects anyway (`mm0`, `k1`, `cr0`): the
     * problem is reported once the unit's symbols are known, as an ambiguity if one has that name.
     */
    readonly rejectedRegisters: readonly { readonly use: SymbolUse; readonly problem: OperandProblem }[]
    readonly constructors: readonly SymbolUse[]
    /** The largest `.align` or `.p2align` the output keeps in each section family. */
    readonly sectionAlignment: ReadonlyMap<SectionFamily, number>
    readonly idents: readonly { readonly line: number; readonly text: string | null; readonly column: number }[]
}

const DATA_DIRECTIVES: ReadonlyMap<string, { readonly directive: DataDirective; readonly bits: number }> = new Map([
    ['.byte', { directive: 'db', bits: 8 }],
    ['.value', { directive: 'dw', bits: 16 }],
    ['.short', { directive: 'dw', bits: 16 }],
    ['.word', { directive: 'dw', bits: 16 }],
    ['.long', { directive: 'dd', bits: 32 }],
    ['.int', { directive: 'dd', bits: 32 }],
    ['.quad', { directive: 'dq', bits: 64 }],
] as const)

/** What a dropped section holds: debug data, read by nothing in the translation. */
const DROPPED_CONTENT = new Set([
    '.byte',
    '.value',
    '.short',
    '.word',
    '.long',
    '.int',
    '.quad',
    '.uleb128',
    '.sleb128',
    '.string',
    '.asciz',
    '.ascii',
    '.zero',
    '.align',
    '.p2align',
])

/**
 * Directives GNU as has that the version 1 rules do not translate, with what GCC uses them for. A
 * Map, like every table a word of the input is looked up in, so that no word reads a property every
 * object has.
 */
const UNSUPPORTED_DIRECTIVES: ReadonlyMap<string, string> = new Map([
    ['.previous', 'a section stack'],
    ['.pushsection', 'a section stack'],
    ['.popsection', 'a section stack'],
    ['.subsection', 'subsections'],
    ['.balign', 'alignment GCC writes as `.align` or `.p2align`'],
    ['.rept', 'repetition'],
    ['.org', 'absolute positioning'],
    ['.symver', 'symbol versioning'],
    ['.equ', 'symbol assignment'],
    ['.equiv', 'symbol assignment'],
    ['.eqv', 'symbol assignment'],
    ['.weakref', 'weak references'],
    ['.lcomm', 'local common storage, which GCC writes as `.local` and `.comm`'],
    ['.uleb128', 'variable-length data outside debug information'],
    ['.sleb128', 'variable-length data outside debug information'],
    ['.att_syntax', 'AT&T syntax'],
])

type Section =
    | { readonly kind: 'kept'; readonly family: SectionFamily }
    | { readonly kind: 'dropped' }
    | { readonly kind: 'rejected' }

/**
 * The first pass: every line read once, in order, into output statements and the facts about
 * symbols the later passes need, with a Diagnostic for every construct outside the rules.
 */
export function analyze(
    input: readonly string[],
    rules: TranslationRules,
    diagnostics: DiagnosticCollector,
    lineLocations: (CompilerLocation | null)[],
): Analysis {
    const locations = new LocationTracker(diagnostics)
    /** Null where code alignment turned out to align no function. */
    const statements: (Statement | null)[] = []
    const labels: (SymbolUse & { fate: 'kept' | 'dropped' | 'rejected' })[] = []
    const globals = new Map<string, SymbolUse[]>()
    const weak = new Map<string, SymbolUse[]>()
    const locals = new Map<string, SymbolUse[]>()
    const commons: (SymbolUse & { alignment: number })[] = []
    const aliases: Alias[] = []
    const uniqueObjects: SymbolUse[] = []
    const references = new Map<string, SymbolUse>()
    const mentions = new Map<string, SymbolUse>()
    const bareRegisters: SymbolUse[] = []
    const rejectedRegisters: { use: SymbolUse; problem: OperandProblem }[] = []
    const constructors: SymbolUse[] = []
    const sectionAlignment = new Map<SectionFamily, number>()
    const idents: { line: number; text: string | null; column: number }[] = []

    let section: Section = { kind: 'kept', family: '.text' }
    let appBlock = false

    /**
     * Plan note 8: code alignment waits to learn what it aligns, the next position in code. A label
     * other than a `.L` label there, before the next instruction, is a function's entry, which keeps
     * it: C++ pointers to member functions use the address's low bit, and `aligned(N)` functions
     * promise their alignment. Only `.L` labels there make it loop or jump-target alignment, which
     * only affects speed and is dropped, keeping Step free of NOP runs. Section switches and other
     * families' contents do not end the wait, since every code section flattens into one: GCC's hot
     * and cold partitioning puts `.section .text.unlikely`, `.Ltext_cold0:` and `.text` between a
     * function's alignment and its label.
     */
    const pendingCodeAlignment: { readonly index: number; readonly bytes: number }[] = []
    const settleCodeAlignment = (kept: boolean) => {
        for (const { index, bytes } of pendingCodeAlignment) {
            if (kept) sectionAlignment.set('.text', Math.max(sectionAlignment.get('.text') ?? 1, bytes))
            else statements[index] = null
        }
        pendingCodeAlignment.length = 0
    }

    const mention = (name: string, line: number, column: number) => {
        if (!mentions.has(name)) mentions.set(name, { name, line, column })
    }
    const reference = (symbol: SymbolRef, line: number) => {
        mention(symbol.name, line, symbol.column)
        if (!references.has(symbol.name))
            references.set(symbol.name, { name: symbol.name, line, column: symbol.column })
    }
    const record = (map: Map<string, SymbolUse[]>, use: SymbolUse) => {
        const list = map.get(use.name) ?? []
        list.push(use)
        map.set(use.name, list)
    }
    /** A symbol directive's one name, or null after reporting why it is not one. */
    const symbolArgument = (token: Token | undefined, line: number, directive: Token): SymbolUse | null => {
        if (!token || !token.text) {
            diagnostics.error(
                'unsupported-symbol',
                line,
                `\`${directive.text}\` without a symbol name`,
                directive.column,
            )
            return null
        }
        const problem = symbolNameProblem(token.text)
        if (problem) {
            diagnostics.error('unsupported-symbol', line, problem, token.column)
            return null
        }
        return { name: token.text, line, column: token.column }
    }

    const keptFamily = (): SectionFamily | null => (section.kind === 'kept' ? section.family : null)

    const onSection = (next: Section, line: number, family: SectionFamily | null) => {
        section = next
        locations.clear()
        if (family) statements.push({ kind: 'section', line, family })
    }

    const onLabel = (name: Token, line: number) => {
        const problem = symbolNameProblem(name.text)
        if (problem) {
            diagnostics.error('unsupported-symbol', line, problem, name.column)
            return
        }
        const fate =
            section.kind === 'rejected'
                ? 'rejected'
                : section.kind === 'kept' && !isDebugLabel(name.text)
                  ? 'kept'
                  : 'dropped'
        labels.push({ name: name.text, line, column: name.column, fate })
        if (fate !== 'kept') return
        mention(name.text, line, name.column)
        statements.push({ kind: 'label', line, symbol: { name: name.text, column: name.column } })
        if (keptFamily() === '.text' && !isLocalLabel(name.text)) settleCodeAlignment(true)
    }

    const onDirective = (nameToken: Token, body: Token, line: number) => {
        const name = nameToken.text.toLowerCase()
        const family = keptFamily()

        if (name.startsWith('.cfi_')) {
            if (name === '.cfi_endproc') locations.clear()
            return
        }
        switch (name) {
            case '.file':
                locations.file(body, line)
                return
            case '.loc':
                locations.loc(body, line)
                return
            case '.ident': {
                const decoded = body.text ? decodeGasString(body) : null
                idents.push({
                    line,
                    text: decoded && 'bytes' in decoded ? new TextDecoder().decode(decoded.bytes) : null,
                    column: nameToken.column,
                })
                return
            }
            case '.intel_syntax':
                if (body.text !== 'noprefix') {
                    diagnostics.error(
                        'unsupported-directive',
                        line,
                        `\`.intel_syntax ${body.text}\`: the rules read GCC's \`noprefix\` Intel syntax`,
                        nameToken.column,
                    )
                }
                return
            case '.text':
            case '.data':
            case '.bss': {
                if (body.text) {
                    diagnostics.error(
                        'unsupported-directive',
                        line,
                        `\`${nameToken.text} ${body.text}\`: subsections have no translation`,
                        body.column,
                    )
                    onSection({ kind: 'rejected' }, line, null)
                    return
                }
                const bare = bareSectionFamily(name)!
                onSection({ kind: 'kept', family: bare }, line, bare)
                return
            }
            case '.section': {
                const classified = classifySection(splitCommas(body))
                if (classified.kind === 'unsupported') {
                    diagnostics.error('unsupported-section', line, classified.message, classified.column)
                    onSection({ kind: 'rejected' }, line, null)
                } else if (classified.kind === 'dropped') onSection({ kind: 'dropped' }, line, null)
                else onSection({ kind: 'kept', family: classified.family }, line, classified.family)
                return
            }
            case '.globl':
            case '.global':
            case '.weak': {
                const args = splitCommas(body)
                if (args.length > 1) {
                    diagnostics.error(
                        'unsupported-directive',
                        line,
                        `\`${nameToken.text}\` with more than one symbol`,
                        args[1]!.column,
                    )
                    return
                }
                const symbol = symbolArgument(args[0], line, nameToken)
                if (!symbol) return
                mention(symbol.name, line, symbol.column)
                record(name === '.weak' ? weak : globals, symbol)
                statements.push({ kind: 'binding', line, symbol: { name: symbol.name, column: symbol.column } })
                return
            }
            case '.local': {
                const args = splitCommas(body)
                if (args.length > 1) {
                    diagnostics.error(
                        'unsupported-directive',
                        line,
                        '`.local` with more than one symbol',
                        args[1]!.column,
                    )
                    return
                }
                const symbol = symbolArgument(args[0], line, nameToken)
                if (!symbol) return
                mention(symbol.name, line, symbol.column)
                record(locals, symbol)
                return
            }
            case '.hidden': {
                const symbol = symbolArgument(splitCommas(body)[0], line, nameToken)
                if (symbol) mention(symbol.name, line, symbol.column)
                return
            }
            case '.protected':
            case '.internal':
                diagnostics.error(
                    'unsupported-symbol',
                    line,
                    `visibility \`${nameToken.text}\` has no translation; only \`.hidden\` is dropped`,
                    nameToken.column,
                )
                return
            case '.size': {
                const symbol = symbolArgument(splitCommas(body)[0], line, nameToken)
                if (symbol) mention(symbol.name, line, symbol.column)
                return
            }
            case '.type':
                onType(nameToken, body, line)
                return
            case '.comm':
                onCommon(nameToken, body, line)
                return
            case '.set': {
                const [aliasToken, targetToken, extra] = splitCommas(body)
                const alias = symbolArgument(aliasToken, line, nameToken)
                if (!alias) return
                mention(alias.name, line, alias.column)
                if (!targetToken || extra || symbolNameProblem(targetToken.text)) {
                    diagnostics.error(
                        'unsupported-symbol',
                        line,
                        `\`.set ${body.text}\` is not an alias of a label`,
                        targetToken?.column ?? nameToken.column,
                    )
                    return
                }
                mention(targetToken.text, line, targetToken.column)
                aliases.push({ alias, target: { name: targetToken.text, line, column: targetToken.column } })
                return
            }
        }

        const unsupported = UNSUPPORTED_DIRECTIVES.get(name)
        if (unsupported && !(section.kind === 'dropped' && DROPPED_CONTENT.has(name))) {
            diagnostics.error(
                'unsupported-directive',
                line,
                `\`${nameToken.text}\` (${unsupported}) has no translation`,
                nameToken.column,
            )
            return
        }
        if (section.kind === 'dropped' && DROPPED_CONTENT.has(name)) return
        if (section.kind === 'rejected') return

        if (name === '.align' || name === '.p2align') {
            onAlign(nameToken, body, line, family!)
            return
        }
        if (name === '.zero') {
            if (!dataAllowed(nameToken, line, family!, ['.rodata', '.data', '.bss'])) return
            const count = splitCommas(body)
            const value = count.length === 1 ? parseInteger(count[0]!.text) : null
            if (value === null) {
                diagnostics.error(
                    'unsupported-directive',
                    line,
                    `\`.zero ${body.text}\` is not a byte count the translator reads`,
                    body.column,
                )
                return
            }
            statements.push({ kind: 'zero', line, count: count[0]!.text, family: family! })
            return
        }
        if (name === '.string' || name === '.asciz' || name === '.ascii') {
            if (!dataAllowed(nameToken, line, family!, ['.rodata', '.data'])) return
            const strings: Uint8Array[] = []
            const args = splitCommas(body)
            if (args.length === 0) {
                diagnostics.error(
                    'unsupported-directive',
                    line,
                    `\`${nameToken.text}\` without a string`,
                    nameToken.column,
                )
                return
            }
            for (const arg of args) {
                const decoded = decodeGasString(arg)
                if ('error' in decoded) {
                    diagnostics.error('unsupported-directive', line, decoded.error, arg.column)
                    return
                }
                strings.push(decoded.bytes)
            }
            statements.push({ kind: 'string', line, strings, terminated: name !== '.ascii' })
            return
        }
        const data = DATA_DIRECTIVES.get(name)
        if (data) {
            onData(nameToken, body, line, family!, data.directive, data.bits)
            return
        }
        diagnostics.error('unsupported-directive', line, `\`${nameToken.text}\` has no translation`, nameToken.column)
    }

    const dataAllowed = (
        nameToken: Token,
        line: number,
        family: SectionFamily,
        allowed: readonly SectionFamily[],
    ): boolean => {
        if (allowed.includes(family)) return true
        const where =
            family === '.text'
                ? 'a code section'
                : family === '.bss'
                  ? '`.bss`, which holds only zeroed storage'
                  : '`.init_array`, which holds only constructor addresses'
        diagnostics.error(
            'unsupported-section',
            line,
            `\`${nameToken.text}\` in ${where} has no translation`,
            nameToken.column,
        )
        return false
    }

    const onData = (
        nameToken: Token,
        body: Token,
        line: number,
        family: SectionFamily,
        directive: DataDirective,
        bits: number,
    ) => {
        const initArray = family === '.init_array'
        if (initArray && directive !== 'dq') {
            dataAllowed(nameToken, line, family, [])
            return
        }
        if (!initArray && !dataAllowed(nameToken, line, family, ['.rodata', '.data'])) return
        const args = splitCommas(body)
        if (args.length === 0) {
            diagnostics.error('unsupported-directive', line, `\`${nameToken.text}\` without a value`, nameToken.column)
            return
        }
        const values: DataValue[] = []
        for (const arg of args) {
            const value = readDataValue(arg, bits)
            if ('problem' in value) {
                diagnostics.error(value.code, line, value.problem, arg.column)
                return
            }
            values.push(value)
        }
        if (initArray) {
            const [entry] = values
            if (values.length !== 1 || entry!.kind !== 'symbol' || entry.addend) {
                diagnostics.error(
                    'unsupported-operand',
                    line,
                    `\`.init_array\` entry \`${body.text}\` is not a constructor's symbol`,
                    body.column,
                )
                return
            }
            constructors.push({ name: entry.symbol.name, line, column: entry.symbol.column })
        }
        for (const value of values) if (value.kind === 'symbol') reference(value.symbol, line)
        statements.push({ kind: 'data', line, directive, values })
    }

    const onAlign = (nameToken: Token, body: Token, line: number, family: SectionFamily) => {
        const args = splitCommas(body)
        const amount = args[0] ? parseInteger(args[0].text) : null
        const extras = args.slice(1)
        const wellFormed =
            amount !== null &&
            extras.length <= 2 &&
            extras.every((arg) => arg.text === '' || parseInteger(arg.text) !== null)
        if (!wellFormed) {
            diagnostics.error(
                'unsupported-directive',
                line,
                `\`${nameToken.text} ${body.text}\` is not an alignment the translator reads`,
                body.column,
            )
            return
        }
        const p2 = nameToken.text.toLowerCase() === '.p2align'
        if ((p2 && amount > 30n) || (!p2 && (amount < 1n || amount > 1n << 30n || (amount & (amount - 1n)) !== 0n))) {
            diagnostics.error(
                'unsupported-directive',
                line,
                `\`${nameToken.text} ${body.text}\` is not a power-of-two alignment`,
                body.column,
            )
            return
        }
        const bytes = p2 ? 2 ** Number(amount) : Number(amount)
        const [fill, maximumSkip] = extras
        if (family === '.text') {
            // A maximum skip is loop alignment (plan note 8), dropped whatever follows it.
            if (maximumSkip?.text) return
            if (fill?.text && (parseInteger(fill.text) ?? 0n) > 0xffn) {
                diagnostics.error(
                    'unsupported-directive',
                    line,
                    `\`${nameToken.text} ${body.text}\` has a fill value that does not fit in a byte`,
                    fill.column,
                )
                return
            }
            pendingCodeAlignment.push({ index: statements.length, bytes })
            statements.push({ kind: 'align', line, bytes, family, fill: fill?.text || null })
            return
        }
        if (extras.some((arg) => arg.text !== '')) {
            const what = maximumSkip?.text ? 'a maximum skip' : 'a fill value'
            diagnostics.error(
                'unsupported-directive',
                line,
                `\`${nameToken.text} ${body.text}\` has ${what}, which only code alignment may have`,
                body.column,
            )
            return
        }
        sectionAlignment.set(family, Math.max(sectionAlignment.get(family) ?? 1, bytes))
        statements.push({ kind: 'align', line, bytes, family, fill: '0' })
    }

    const onType = (nameToken: Token, body: Token, line: number) => {
        const [symbolToken, typeToken, extra] = splitCommas(body)
        const symbol = symbolArgument(symbolToken, line, nameToken)
        if (!symbol) return
        mention(symbol.name, line, symbol.column)
        const type = typeToken?.text
        if (!extra && (type === '@function' || type === '@object')) return
        if (!extra && type === '@gnu_unique_object') {
            if (rules.gnuUniqueObject === 'weak-object') {
                uniqueObjects.push(symbol)
                return
            }
            diagnostics.error(
                'unsupported-symbol',
                line,
                `\`.type ${symbol.name}, @gnu_unique_object\` has no translation yet (gate 7)`,
                typeToken!.column,
            )
            return
        }
        const why =
            type === '@gnu_indirect_function' ? ': dropping it would call the resolver as if it were the function' : ''
        diagnostics.error(
            'unsupported-symbol',
            line,
            `\`.type ${body.text}\` has no translation${why}`,
            typeToken?.column ?? nameToken.column,
        )
    }

    const onCommon = (nameToken: Token, body: Token, line: number) => {
        const [symbolToken, sizeToken, alignToken, extra] = splitCommas(body)
        const symbol = symbolArgument(symbolToken, line, nameToken)
        if (!symbol) return
        mention(symbol.name, line, symbol.column)
        const size = sizeToken ? parseInteger(sizeToken.text) : null
        const alignment = alignToken ? parseInteger(alignToken.text) : null
        if (
            size === null ||
            alignment === null ||
            extra ||
            alignment < 1n ||
            (alignment & (alignment - 1n)) !== 0n ||
            alignment > 1n << 30n
        ) {
            diagnostics.error(
                'unsupported-directive',
                line,
                `\`.comm ${body.text}\` is not a common symbol with a size and a power-of-two alignment`,
                body.column,
            )
            return
        }
        commons.push({ ...symbol, alignment: Number(alignment) })
        statements.push({
            kind: 'common',
            line,
            symbol: { name: symbol.name, column: symbol.column },
            size: sizeToken!.text,
            alignment: Number(alignment),
        })
    }

    const onInstruction = (body: Token, line: number) => {
        // An instruction at the aligned position: whatever labels came first were `.L` labels.
        if (keptFamily() === '.text') settleCodeAlignment(false)
        if (section.kind === 'rejected') return
        if (section.kind === 'dropped' || section.family !== '.text') {
            const where = section.kind === 'dropped' ? 'a dropped debug or note section' : `\`${section.family}\``
            diagnostics.error('unsupported-section', line, `instruction in ${where}, outside code`, body.column)
            return
        }
        const result = translateInstruction(body)
        if ('problems' in result) {
            for (const problem of result.problems) {
                if (problem.register) {
                    const use = { name: problem.register.text, line, column: problem.register.column }
                    rejectedRegisters.push({ use, problem })
                } else diagnostics.error(problem.code, line, problem.message, problem.column)
            }
            return
        }
        const symbols = result.instruction.operands.flatMap(operandSymbols)
        const invalid = symbols
            .map((symbol) => [symbol, symbolNameProblem(symbol.name)] as const)
            .filter(([, problem]) => problem)
        for (const [symbol, problem] of invalid) diagnostics.error('unsupported-symbol', line, problem!, symbol.column)
        if (invalid.length) return
        for (const symbol of symbols) reference(symbol, line)
        for (const operand of result.instruction.operands) {
            if (operand.kind === 'register' && operand.bare) {
                bareRegisters.push({ name: operand.bare.text, line, column: operand.bare.column })
            }
        }
        statements.push({ kind: 'instruction', line, instruction: result.instruction, location: locations.current })
    }

    const onStatement = (statement: LexedStatement, line: number) => {
        switch (statement.kind) {
            case 'label':
                onLabel(statement.name, line)
                return
            case 'numeric-label':
                // `.note.gnu.property` measures itself with numeric labels; a dropped section's are
                // dropped with it, and a rejected section's are part of what was reported.
                if (section.kind !== 'kept') return
                diagnostics.error(
                    'unsupported-symbol',
                    line,
                    `numeric label \`${statement.name.text}:\` has no translation`,
                    statement.name.column,
                )
                return
            case 'quoted-label':
                diagnostics.error(
                    'unsupported-symbol',
                    line,
                    `quoted symbol name ${statement.name.text} has no translation`,
                    statement.name.column,
                )
                return
            case 'directive':
                onDirective(statement.name, statement.body, line)
                return
            case 'assignment':
                diagnostics.error(
                    'unsupported-directive',
                    line,
                    `assignment to \`${statement.name.text}\` (symbol assignment) has no translation`,
                    statement.name.column,
                )
                return
            case 'instruction':
                onInstruction(statement.body, line)
                return
            case 'unreadable':
                diagnostics.error(
                    'unsupported-directive',
                    line,
                    `\`${statement.body.text}\` is not a statement the translator reads`,
                    statement.body.column,
                )
                return
        }
    }

    input.forEach((text, line) => {
        lineLocations[line] = locations.current
        if (appBlock) {
            const lexed = lexLine(text)
            if (lexed.kind === 'comment' && lexed.text.text === '#NO_APP') appBlock = false
            return
        }
        const unreadable = unreadableCharacter(text)
        if (unreadable) {
            const codePoint = `U+${unreadable.codePoint.toString(16).toUpperCase().padStart(4, '0')}`
            diagnostics.error(
                'unreadable-line',
                line,
                `control character or line break ${codePoint} inside the line, which GCC never writes; nothing on the line is read`,
                unreadable.column,
            )
            return
        }
        const lexed = lexLine(text)
        if (lexed.kind === 'blank') return
        if (lexed.kind === 'comment') {
            if (lexed.text.text === '#APP') {
                appBlock = true
                diagnostics.error(
                    'inline-assembly',
                    line,
                    'inline assembly (`#APP` to `#NO_APP`) has no translation in version 1',
                    lexed.text.column,
                )
                return
            }
            diagnostics.error(
                'unsupported-directive',
                line,
                `comment \`${lexed.text.text}\` has no translation; the profile compiles with -fno-verbose-asm`,
                lexed.text.column,
            )
            return
        }
        if (lexed.trailingComment !== null) {
            diagnostics.error(
                'unsupported-directive',
                line,
                'a comment after a statement has no translation; the profile compiles with -fno-verbose-asm',
                lexed.trailingComment,
            )
        }
        if (lexed.statements.length > 1 || lexed.separators.length > 0) {
            const second = lexed.statements[1]
            diagnostics.error(
                'unsupported-directive',
                line,
                'several statements on one line have no translation',
                lexed.separators[0] ?? (second ? statementColumn(second) : undefined),
            )
        }
        for (const statement of lexed.statements) onStatement(statement, line)
    })
    settleCodeAlignment(false)

    return {
        statements: statements.filter((statement) => statement !== null),
        lineLocations,
        labels,
        globals,
        weak,
        locals,
        commons,
        aliases,
        uniqueObjects,
        references,
        mentions,
        bareRegisters,
        rejectedRegisters,
        constructors,
        sectionAlignment,
        idents,
    }
}

function statementColumn(statement: LexedStatement): number {
    return 'name' in statement ? statement.name.column : statement.body.column
}

/** A data value: an integer that fits the width, a symbol, or a symbol plus or minus an integer. */
function readDataValue(
    arg: Token,
    bits: number,
): DataValue | { problem: string; code: 'unsupported-operand' | 'unsupported-symbol' } {
    const text = arg.text
    const integer = /^(-?)\s*([0-9][A-Za-z0-9_]*)$/.exec(text)
    if (integer) {
        const magnitude = parseInteger(integer[2]!)
        if (magnitude === null)
            return { code: 'unsupported-operand', problem: `\`${text}\` is not an integer the translator reads` }
        const value = integer[1] ? -magnitude : magnitude
        const min = -(1n << BigInt(bits - 1))
        const max = (1n << BigInt(bits)) - 1n
        if (value < min || value > max) {
            return {
                code: 'unsupported-operand',
                problem: `\`${text}\` does not fit in ${bits / 8} byte${bits === 8 ? '' : 's'}`,
            }
        }
        return { kind: 'integer', text: `${integer[1]}${integer[2]}` }
    }
    const symbol = /^([A-Za-z_.$][A-Za-z0-9_.$]*)(?:\s*([+-])\s*([0-9][A-Za-z0-9_]*))?$/.exec(text)
    if (symbol) {
        const problem = symbolNameProblem(symbol[1]!)
        if (problem) return { code: 'unsupported-symbol', problem }
        if (symbol[3] !== undefined && parseInteger(symbol[3]) === null) {
            return { code: 'unsupported-operand', problem: `\`${symbol[3]}\` is not an integer the translator reads` }
        }
        return {
            kind: 'symbol',
            symbol: { name: symbol[1]!, column: arg.column },
            addend: symbol[2] ? `${symbol[2]}${symbol[3]}` : '',
        }
    }
    return {
        code: 'unsupported-operand',
        problem: `\`${text}\` is an expression beyond an integer, a symbol, or a symbol plus or minus an integer`,
    }
}
