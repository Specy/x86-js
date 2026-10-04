import type { CompilerLocation, TranslationDiagnostic, TranslationDiagnosticCode } from './types'

/**
 * Collects every Diagnostic of one translation. Nothing stops at the first problem: a translation
 * reports all of them, sorted by input line, and any error means no output.
 */
export class DiagnosticCollector {
    private readonly entries: TranslationDiagnostic[] = []

    /** `locationAt` gives the compiler location in effect at an input line. */
    constructor(private readonly locationAt: (inputLine: number) => CompilerLocation | null) {}

    error(code: TranslationDiagnosticCode, inputLine: number, message: string, column?: number): void {
        this.add('error', code, inputLine, message, column)
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
