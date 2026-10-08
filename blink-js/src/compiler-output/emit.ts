import type { Analysis, DataValue, Statement, SymbolUse } from './analyze'
import type { DiagnosticCollector } from './diagnostics'
import { encodeNasmString } from './lexer'
import { isLocalLabel, NameMap } from './names'
import { renderOperand } from './operands'
import { NASM_DEFAULT_ALIGNMENT, type SectionFamily } from './sections'
import type { CompilerLocation, SymbolSummary, TranslatedLine, TranslatedSymbol } from './types'

type Resolution = {
    readonly names: NameMap
    /** Names the output defines: kept labels, aliases and local commons. */
    readonly defined: ReadonlySet<string>
    readonly localCommons: ReadonlySet<string>
    readonly globalCommons: ReadonlySet<string>
    readonly weak: ReadonlySet<string>
    readonly global: ReadonlySet<string>
    /** Alias uses by the label they follow, in `.set` order. */
    readonly aliasesByLabel: ReadonlyMap<string, readonly SymbolUse[]>
    readonly externs: readonly { readonly name: string; readonly weak: boolean; readonly referenced: boolean }[]
    readonly alignment: ReadonlyMap<SectionFamily, number>
}

/**
 * The second pass: checks that need the whole unit (definitions, aliases, bindings, references and
 * register-named symbols) and decides how every name is spelled and which are external.
 */
export function resolve(analysis: Analysis, diagnostics: DiagnosticCollector): Resolution {
    const firstDefinition = new Map<string, SymbolUse>()
    const kept = new Set<string>()
    const dropped = new Set<string>()
    /** Defined in a section already reported as unsupported: nothing more is said about them. */
    const rejected = new Set<string>()
    for (const label of analysis.labels) {
        if (firstDefinition.has(label.name)) {
            diagnostics.error('unsupported-symbol', label.line, `\`${label.name}\` is defined twice`, label.column)
            continue
        }
        firstDefinition.set(label.name, label)
        if (label.fate === 'kept') kept.add(label.name)
        else if (label.fate === 'dropped') dropped.add(label.name)
        else rejected.add(label.name)
    }

    const locals = new Set(analysis.locals.keys())
    const weak = new Set(analysis.weak.keys())
    const global = new Set(analysis.globals.keys())
    const localCommons = new Set<string>()
    const globalCommons = new Set<string>()
    const alignment = new Map(analysis.sectionAlignment)
    for (const common of analysis.commons) {
        if (firstDefinition.has(common.name) || localCommons.has(common.name) || globalCommons.has(common.name)) {
            diagnostics.error('unsupported-symbol', common.line, `\`${common.name}\` is defined twice`, common.column)
            continue
        }
        if (locals.has(common.name)) {
            localCommons.add(common.name)
            alignment.set('.bss', Math.max(alignment.get('.bss') ?? 1, common.alignment))
        } else globalCommons.add(common.name)
        if (weak.has(common.name) || (global.has(common.name) && !locals.has(common.name))) {
            const binding = weak.has(common.name) ? '.weak' : '.globl'
            diagnostics.error(
                'unsupported-symbol',
                common.line,
                `common symbol \`${common.name}\` is also declared \`${binding}\`, which has no translation`,
                common.column,
            )
        }
    }

    const aliasTargets = new Map<string, SymbolUse>()
    for (const { alias, target } of analysis.aliases) {
        if (
            firstDefinition.has(alias.name) ||
            localCommons.has(alias.name) ||
            globalCommons.has(alias.name) ||
            aliasTargets.has(alias.name)
        ) {
            diagnostics.error('unsupported-symbol', alias.line, `\`${alias.name}\` is defined twice`, alias.column)
            continue
        }
        aliasTargets.set(alias.name, target)
    }
    const aliasesByLabel = new Map<string, SymbolUse[]>()
    const aliases = new Set<string>()
    for (const { alias, target } of analysis.aliases) {
        if (aliasTargets.get(alias.name) !== target) continue
        const seen = new Set([alias.name])
        let root = target.name
        while (aliasTargets.has(root) && !seen.has(root)) {
            seen.add(root)
            root = aliasTargets.get(root)!.name
        }
        if (!kept.has(root)) {
            if (!rejected.has(root)) {
                diagnostics.error(
                    'unsupported-symbol',
                    alias.line,
                    `\`.set ${alias.name}, ${target.name}\` is not an alias of a label in this output`,
                    target.column,
                )
            }
            continue
        }
        aliases.add(alias.name)
        const list = aliasesByLabel.get(root) ?? []
        list.push(alias)
        aliasesByLabel.set(root, list)
    }

    const defined = new Set([...kept, ...aliases, ...localCommons])

    for (const name of locals) {
        if (!global.has(name) && !weak.has(name)) continue
        const use = (analysis.globals.get(name) ?? analysis.weak.get(name))![0]!
        diagnostics.error(
            'unsupported-symbol',
            use.line,
            `\`${name}\` is declared both \`.local\` and global or weak`,
            use.column,
        )
    }
    for (const use of analysis.uniqueObjects) {
        if (!weak.has(use.name)) {
            diagnostics.error(
                'unsupported-symbol',
                use.line,
                `\`${use.name}\` is \`@gnu_unique_object\` without \`.weak\`, which has no translation`,
                use.column,
            )
        }
    }
    for (const [name, uses] of [...analysis.globals, ...analysis.weak]) {
        const use = uses[0]!
        if (rejected.has(name)) continue
        if (isLocalLabel(name)) {
            diagnostics.error(
                'unsupported-symbol',
                use.line,
                `\`${name}\` is an assembler-local label declared global or weak`,
                use.column,
            )
        } else if (dropped.has(name) && !defined.has(name)) {
            diagnostics.error(
                'unsupported-symbol',
                use.line,
                `\`${name}\` is defined only where the translation drops it`,
                use.column,
            )
        }
    }
    for (const [name, use] of analysis.references) {
        if (defined.has(name) || globalCommons.has(name) || rejected.has(name)) continue
        if (dropped.has(name)) {
            diagnostics.error(
                'unsupported-symbol',
                use.line,
                `\`${name}\` is a label the translation drops`,
                use.column,
            )
        } else if (isLocalLabel(name)) {
            diagnostics.error('unsupported-symbol', use.line, `local label \`${name}\` is never defined`, use.column)
        }
    }
    const ambiguous = (use: SymbolUse) =>
        diagnostics.error(
            'ambiguous-register-name',
            use.line,
            `\`${use.name}\` alone reads as a register, but this unit also has a symbol \`${use.name}\`; GCC's Intel syntax cannot tell them apart`,
            use.column,
        )
    for (const use of analysis.bareRegisters) if (analysis.mentions.has(use.name)) ambiguous(use)
    for (const { use, problem } of analysis.rejectedRegisters) {
        if (analysis.mentions.has(use.name)) ambiguous(use)
        else diagnostics.error(problem.code, use.line, problem.message, problem.column)
    }

    const externs: { name: string; weak: boolean; referenced: boolean }[] = []
    for (const name of analysis.mentions.keys()) {
        const referenced = analysis.references.has(name)
        if (!referenced && !global.has(name) && !weak.has(name)) continue
        if (
            defined.has(name) ||
            globalCommons.has(name) ||
            isLocalLabel(name) ||
            dropped.has(name) ||
            rejected.has(name)
        )
            continue
        externs.push({ name, weak: weak.has(name), referenced })
    }

    const unitNames = new Set([...analysis.mentions.keys(), ...kept])
    return {
        names: new NameMap(unitNames),
        defined,
        localCommons,
        globalCommons,
        weak,
        global,
        aliasesByLabel,
        externs,
        alignment,
    }
}

const INDENT = '    '

/**
 * The third pass: the output lines, header first, each statement line carrying its input line and
 * every synthesized line the input line that required it.
 */
export function emit(analysis: Analysis, resolution: Resolution): { lines: TranslatedLine[]; symbols: SymbolSummary } {
    const { names } = resolution
    const body: TranslatedLine[] = []
    const declared = new Set<SectionFamily>()
    const definedOrder: string[] = []
    let current: SectionFamily = '.text'

    const push = (
        text: string,
        inputLine: number,
        options: { synthesized?: boolean; label?: boolean; location?: CompilerLocation | null } = {},
    ) => {
        body.push({
            text: options.label ? text : `${INDENT}${text}`,
            inputLine,
            synthesized: options.synthesized ?? false,
            location: options.location ?? null,
        })
    }
    const enter = (family: SectionFamily, inputLine: number, synthesized: boolean) => {
        let attributes = ''
        if (!declared.has(family)) {
            declared.add(family)
            const needed = resolution.alignment.get(family) ?? 1
            if (needed > NASM_DEFAULT_ALIGNMENT[family]) attributes = ` align=${needed}`
        }
        push(`section ${family}${attributes}`, inputLine, { synthesized })
        current = family
    }
    const value = (data: DataValue) =>
        data.kind === 'integer' ? data.text : `${names.emit(data.symbol.name)}${data.addend}`

    const emitStatement = (statement: Statement) => {
        switch (statement.kind) {
            case 'section':
                enter(statement.family, statement.line, false)
                return
            case 'label': {
                const name = statement.symbol.name
                push(`${names.emit(name)}:`, statement.line, { label: true })
                definedOrder.push(name)
                for (const alias of resolution.aliasesByLabel.get(name) ?? []) {
                    push(`${names.emit(alias.name)}:`, alias.line, { label: true })
                    definedOrder.push(alias.name)
                }
                return
            }
            case 'binding': {
                const name = statement.symbol.name
                if (!resolution.defined.has(name)) return // an `extern` in the header
                push(`global ${names.emit(name)}${resolution.weak.has(name) ? ':weak' : ''}`, statement.line)
                return
            }
            case 'common': {
                const name = statement.symbol.name
                if (!resolution.localCommons.has(name)) {
                    push(`common ${names.emit(name)} ${statement.size}:${statement.alignment}`, statement.line)
                    return
                }
                const previous = current
                if (previous !== '.bss') enter('.bss', statement.line, true)
                push(`alignb ${statement.alignment}`, statement.line, { synthesized: true })
                push(`${names.emit(name)}: resb ${statement.size}`, statement.line, { label: true })
                if (previous !== '.bss') enter(previous, statement.line, true)
                return
            }
            case 'align':
                push(
                    statement.family === '.bss'
                        ? `alignb ${statement.bytes}`
                        : statement.fill === null
                          ? `align ${statement.bytes}`
                          : `align ${statement.bytes}, db ${statement.fill}`,
                    statement.line,
                )
                return
            case 'data':
                push(`${statement.directive} ${statement.values.map(value).join(', ')}`, statement.line)
                return
            case 'zero':
                push(
                    statement.family === '.bss' ? `resb ${statement.count}` : `times ${statement.count} db 0`,
                    statement.line,
                )
                return
            case 'string': {
                const parts = statement.strings.map(
                    (bytes) => `${encodeNasmString(bytes)}${statement.terminated ? ', 0' : ''}`,
                )
                push(`db ${parts.join(', ')}`, statement.line)
                return
            }
            case 'instruction': {
                const { prefix, mnemonic, operands } = statement.instruction
                const rendered = operands.map((operand) => renderOperand(operand, (name) => names.emit(name)))
                const text = `${prefix ? `${prefix} ` : ''}${mnemonic}${rendered.length ? ` ${rendered.join(', ')}` : ''}`
                push(text, statement.line, { location: statement.location })
                return
            }
        }
    }
    for (const statement of analysis.statements) emitStatement(statement)

    const externNames = resolution.externs.map((extern) => names.emit(extern.name))
    const header: string[] = []
    // An instruction-set directive such as `CPU X64` would be the first line; gate 8 chose the
    // generated `unsupported-instruction` check over it.
    header.push('default rel')
    if (names.escapes) header.push('[dollarhex off]')
    resolution.externs.forEach((extern, index) =>
        header.push(`extern ${externNames[index]}${extern.weak ? ':weak' : ''}`),
    )

    for (const [original, spelling] of names.entries()) {
        const assembled = spelling.replace(/^\$/, '')
        if (assembled !== original) header.push(`; compiler-symbol ${assembled} ${original}`)
    }
    const lines: TranslatedLine[] = [
        ...header.map((text) => ({ text: `${INDENT}${text}`, inputLine: null, synthesized: true, location: null })),
        ...body,
    ]

    const symbol = (name: string): TranslatedSymbol => ({ name, nasmName: names.nasmName(name) })
    const symbols: SymbolSummary = {
        defined: definedOrder
            .filter((name) => resolution.global.has(name) || resolution.weak.has(name))
            .map((name) => ({
                ...symbol(name),
                binding: resolution.weak.has(name) ? ('weak' as const) : ('global' as const),
            })),
        common: analysis.commons
            .filter((common) => resolution.globalCommons.has(common.name))
            .map((common) => symbol(common.name)),
        external: resolution.externs
            .filter((extern) => extern.referenced)
            .map((extern) => ({ ...symbol(extern.name), weak: extern.weak })),
        constructors: analysis.constructors.map((constructor) => symbol(constructor.name)),
    }
    return { lines, symbols }
}
