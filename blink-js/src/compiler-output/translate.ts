import { analyze, type Analysis } from './analyze'
import { DiagnosticCollector } from './diagnostics'
import { emit, resolve } from './emit'
import { resolveProfile, type TranslationRules } from './profile'
import type { CompilerLocation, TranslationOptions, TranslationProfile, TranslationResult } from './types'

/**
 * Translates one compiler output, as lines of text, into NASM 3.00 source for one ELF64 object.
 * Throws only for an unknown profile id; everything about the input is a Diagnostic, and any error
 * means no output.
 */
export function translateCompilerOutput(input: readonly string[], options: TranslationOptions): TranslationResult {
    const { profile, rules } = resolveProfile((options as Partial<TranslationOptions> | undefined)?.profile)
    return translateWithRules(input, profile, rules)
}

/** {@link translateCompilerOutput} with the rules spelled out, so a pending rule can be tried. */
export function translateWithRules(
    input: readonly string[],
    profile: TranslationProfile,
    rules: TranslationRules,
): TranslationResult {
    const lineLocations: (CompilerLocation | null)[] = []
    const diagnostics = new DiagnosticCollector((line) => lineLocations[line] ?? null)
    const analysis = analyze(input, rules, diagnostics, lineLocations)
    checkCompiler(analysis, profile, diagnostics)
    const resolution = resolve(analysis, diagnostics)
    if (diagnostics.hasErrors) return { ok: false, diagnostics: diagnostics.sorted() }

    const { lines, symbols } = emit(analysis, resolution)
    return {
        ok: true,
        text: `${lines.map((line) => line.text).join('\n')}\n`,
        lines,
        symbols,
        diagnostics: diagnostics.sorted(),
    }
}

/**
 * GCC names itself in `.ident`, `GCC: (pkgversion) 14.2.0`. Anything else, or nothing, is a
 * warning that the output comes from a compiler the profile was not verified on.
 */
function checkCompiler(analysis: Analysis, profile: TranslationProfile, diagnostics: DiagnosticCollector): void {
    const { name, version } = profile.compiler
    const expected = `${name} ${version}`
    if (analysis.idents.length === 0) {
        diagnostics.warning(
            'unverified-compiler',
            0,
            `No \`.ident\` names the compiler; profile ${profile.id} is verified only on ${expected} output`,
            undefined,
            null,
        )
        return
    }
    const pattern = new RegExp(`^${name}: (?:\\(.*\\) )?${version.replace('.', '\\.')}\\.\\d+(?:\\s|$)`)
    for (const ident of analysis.idents) {
        if (ident.text !== null && pattern.test(ident.text)) continue
        const named = ident.text === null ? 'an unreadable compiler' : `"${ident.text}"`
        diagnostics.warning(
            'unverified-compiler',
            ident.line,
            `\`.ident\` names ${named}; profile ${profile.id} is verified only on ${expected} output`,
            ident.column,
            null,
        )
    }
}
