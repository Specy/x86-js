import type { DiagnosticCollector } from './diagnostics'
import { decodeGasString, splitWords, type Token } from './lexer'
import type { CompilerLocation } from './types'

/** `.loc` options that change nothing about which source line an instruction came from. */
const IGNORED_OPTIONS = new Set(['discriminator', 'is_stmt', 'view'])

/**
 * The compiler's own source locations: `.file N "name"` declares a file number, and `.loc N line
 * column` makes that file and line current for the instructions after it, until another `.loc`, a
 * section directive or `.cfi_endproc`.
 */
export class LocationTracker {
    private readonly files = new Map<number, string>()
    private location: CompilerLocation | null = null

    constructor(private readonly diagnostics: DiagnosticCollector) {}

    get current(): CompilerLocation | null {
        return this.location
    }

    clear(): void {
        this.location = null
    }

    /** `.file "name"`, `.file N "name"` or `.file N "directory" "name"`. */
    file(body: Token, inputLine: number): void {
        const words = splitWords(body)
        if (words.length === 1 && words[0]!.text.startsWith('"')) return // the primary source's name
        const number = words[0] && /^(?:0|[1-9][0-9]*)$/.test(words[0].text) ? Number(words[0].text) : null
        const strings = words.slice(1)
        if (number === null || strings.length < 1 || strings.length > 2) {
            this.unreadable(inputLine, `\`.file ${body.text}\` is not a form the translator reads`, body.column)
            return
        }
        const decoded = decodeGasString(strings[strings.length - 1]!)
        if ('error' in decoded) {
            this.unreadable(inputLine, `\`.file\`: ${decoded.error}`, strings[strings.length - 1]!.column)
            return
        }
        const name = new TextDecoder().decode(decoded.bytes)
        const known = this.files.get(number)
        if (known !== undefined && known !== name) {
            this.unreadable(
                inputLine,
                `\`.file ${number}\` is declared again as "${name}" after "${known}"`,
                body.column,
            )
            return
        }
        this.files.set(number, name)
    }

    /** `.loc file line [column] [option value]...`; an unreadable one leaves no location. */
    loc(body: Token, inputLine: number): void {
        this.location = null
        const words = splitWords(body)
        const [fileWord, lineWord, ...rest] = words
        const integer = (word: Token | undefined) =>
            word && /^(?:0|[1-9][0-9]*)$/.test(word.text) ? Number(word.text) : null
        const fileNumber = integer(fileWord)
        const line = integer(lineWord)
        if (fileNumber === null || line === null) {
            this.unreadable(inputLine, `\`.loc ${body.text}\` has no file and line numbers`, body.column)
            return
        }
        let column = 0
        let index = 0
        if (rest[0] && integer(rest[0]) !== null) {
            column = integer(rest[0])!
            index = 1
        }
        while (index < rest.length) {
            const option = rest[index]!
            if (!IGNORED_OPTIONS.has(option.text) || rest[index + 1] === undefined) {
                this.unreadable(
                    inputLine,
                    `\`.loc\` option \`${option.text}\` is not one the translator reads`,
                    option.column,
                )
                return
            }
            index += 2
        }
        const file = this.files.get(fileNumber)
        if (file === undefined) {
            this.unreadable(
                inputLine,
                `\`.loc\` names file ${fileNumber}, which no \`.file\` declared`,
                fileWord!.column,
            )
            return
        }
        this.location = { file, line, column }
    }

    private unreadable(inputLine: number, message: string, column: number): void {
        this.diagnostics.warning('unreadable-location', inputLine, message, column, null)
    }
}
