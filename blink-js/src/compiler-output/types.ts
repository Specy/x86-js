/** The translation profiles this package knows, each a pinned compiler, flag set and rule set. */
export type TranslationProfileId = 'gcc-intel-v1'

export type TranslationProfile = {
    readonly id: TranslationProfileId
    /** A missing or different `.ident` adds a warning, never an error. */
    readonly compiler: { readonly name: 'GCC'; readonly version: '14.2'; readonly target: 'x86-64' }
    /** The groups of the profile table; driver and runtime flags are not part of it. */
    readonly flags: {
        readonly translation: readonly string[]
        readonly locations: readonly string[]
        readonly target: readonly string[]
        readonly language: { readonly c: readonly string[]; readonly cpp: readonly string[] }
    }
    /** The optimization levels the profile's corpus passes at. */
    readonly optimizations: readonly ('0' | '1' | '2' | '3' | 's')[]
}

/** From the compiler's own `.file` and `.loc`. */
export type CompilerLocation = {
    /** The `.file` name as written, such as `src/main.c` or `/app/values.h`. */
    readonly file: string
    readonly line: number
    readonly column: number
}

export type TranslatedLine = {
    readonly text: string
    /** Zero-based input line; null in the header. */
    readonly inputLine: number | null
    /** True for a line no input statement translates to: the header, and the section switches and alignment around a local common. */
    readonly synthesized: boolean
    /** Instructions only. */
    readonly location: CompilerLocation | null
}

export type TranslationDiagnosticCode =
    /** A control character or line break inside a line, which no statement pattern reads. */
    | 'unreadable-line'
    | 'unsupported-directive'
    | 'unsupported-section'
    | 'unsupported-operand'
    | 'unsupported-symbol'
    | 'unsupported-instruction'
    | 'inline-assembly'
    | 'ambiguous-register-name'
    | 'unverified-compiler'
    | 'unreadable-location'

export type TranslationDiagnostic = {
    readonly severity: 'error' | 'warning'
    readonly code: TranslationDiagnosticCode
    readonly message: string
    /** Zero-based. */
    readonly inputLine: number
    /** One-based, when a token can be pointed at. */
    readonly column?: number
    /** The compiler location in effect at the input line, if any. */
    readonly location: CompilerLocation | null
}

/** `name` as the compiler wrote it; `nasmName` as the output spells it, `$`-escaped if reserved. */
export type TranslatedSymbol = { readonly name: string; readonly nasmName: string }

/** What the translated unit's object holds besides its local symbols. */
export type SymbolSummary = {
    /** Global and weak definitions, in output order. */
    readonly defined: readonly (TranslatedSymbol & { readonly binding: 'global' | 'weak' })[]
    /** Common symbols, `.comm` without `.local`. */
    readonly common: readonly TranslatedSymbol[]
    /**
     * Undefined symbols the output references, in the order of the header's `extern` lines.
     * NASM writes no symbol for an `extern` nothing references, so a `.globl` or `.weak` of a
     * symbol the unit never uses has a header line but no entry here.
     */
    readonly external: readonly (TranslatedSymbol & { readonly weak: boolean })[]
    /** `.init_array` entries, in order. */
    readonly constructors: readonly TranslatedSymbol[]
}

export type TranslationResult =
    | {
          readonly ok: true
          readonly text: string
          readonly lines: readonly TranslatedLine[]
          readonly symbols: SymbolSummary
          readonly diagnostics: readonly TranslationDiagnostic[]
      }
    | { readonly ok: false; readonly diagnostics: readonly TranslationDiagnostic[] }

export type TranslationOptions = { readonly profile: TranslationProfileId }
