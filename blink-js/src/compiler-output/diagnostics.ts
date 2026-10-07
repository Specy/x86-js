import { UNREADABLE_CHARACTER } from './lexer'
import type { CompilerLocation, TranslationDiagnostic, TranslationDiagnosticCode } from './types'

/** How much of an inline-assembly line an error quotes. */
const QUOTED_LENGTH = 60

/** The characters a quoted line spells as escapes, since the lexer reads none of them. */
const UNPRINTABLE = new RegExp(UNREADABLE_CHARACTER.source, 'g')

/**
 * Collects every Diagnostic of one translation. Nothing stops at the first problem: a translation
 * reports all of them, sorted by input line, and any error means no output.
 */
export class DiagnosticCollector {
    private readonly entries: TranslationDiagnostic[] = []
    /** The input lines inside `#APP` blocks, with their text as an error quotes it. */
    private readonly inlineAssembly = new Map<number, string>()

    /** `locationAt` gives the compiler location in effect at an input line. */
    constructor(private readonly locationAt: (inputLine: number) => CompilerLocation | null) {}

    /**
     * Marks an input line as inline assembly, before anything on it is read: every error reported
     * on it from then on, by any pass, has the code `inline-assembly` and quotes the line, which
     * the program's author wrote in an `asm` statement rather than the compiler.
     */
    markInlineAssembly(inputLine: number, text: string): void {
        const shown = text
            .trim()
            .replace(/\t/g, ' ')
            .replace(UNPRINTABLE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
        this.inlineAssembly.set(inputLine, shown.length > QUOTED_LENGTH ? `${shown.slice(0, QUOTED_LENGTH)}…` : shown)
    }

    error(code: TranslationDiagnosticCode, inputLine: number, message: string, column?: number): void {
        const quoted = this.inlineAssembly.get(inputLine)
        if (quoted === undefined) this.add('error', code, inputLine, message, column)
        else this.add('error', 'inline-assembly', inputLine, `inline assembly \`${quoted}\`: ${message}`, column)
    }

    warning(
        code: TranslationDiagnosticCode,
        inputLine: number,
        message: string,
        column?: number,
        location?: CompilerLocation | null,
    ): void {
        this.add('warning', code, inputLine, message, column, location)
    }

    get hasErrors(): boolean {
        return this.entries.some((entry) => entry.severity === 'error')
    }

    /** Sorted by input line, keeping the order they were found in within a line. */
    sorted(): TranslationDiagnostic[] {
        return this.entries
            .map((entry, order) => ({ entry, order }))
            .sort((left, right) => left.entry.inputLine - right.entry.inputLine || left.order - right.order)
            .map(({ entry }) => entry)
    }

    private add(
        severity: 'error' | 'warning',
        code: TranslationDiagnosticCode,
        inputLine: number,
        message: string,
        column?: number,
        location?: CompilerLocation | null,
    ): void {
        this.entries.push({
            severity,
            code,
            message,
            inputLine,
            ...(column === undefined ? {} : { column }),
            location: location === undefined ? this.locationAt(inputLine) : location,
        })
    }
}
