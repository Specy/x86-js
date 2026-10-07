/** A piece of an input line and the one-based column it starts at. */
export type Token = { readonly text: string; readonly column: number }

/** One statement of a line, classified by its first word. */
export type LexedStatement =
    | { readonly kind: 'label'; readonly name: Token }
    | { readonly kind: 'numeric-label'; readonly name: Token }
    | { readonly kind: 'quoted-label'; readonly name: Token }
    /** `name` keeps the dot and the compiler's case; `body` is everything after it. */
    | { readonly kind: 'directive'; readonly name: Token; readonly body: Token }
    | { readonly kind: 'assignment'; readonly name: Token }
    | { readonly kind: 'instruction'; readonly body: Token }
    | { readonly kind: 'unreadable'; readonly body: Token }

export type LexedLine =
    | { readonly kind: 'blank' }
    /** A line whose first character is `#`, from the `#` on. */
    | { readonly kind: 'comment'; readonly text: Token }
    | {
          readonly kind: 'code'
          readonly statements: readonly LexedStatement[]
          /** Column of a `#` comment after the code, if any. */
          readonly trailingComment: number | null
          /** Columns of the `;` separating statements, if any. */
          readonly separators: readonly number[]
      }

/** GNU as symbol names; quoted names and names with other characters are not read. */
export const GAS_SYMBOL = /^[A-Za-z_.$][A-Za-z0-9_.$]*$/

/**
 * Control characters other than a tab (C0, DEL and C1) and the Unicode line and paragraph
 * separators. GCC writes none of them inside a line, and the separators and a carriage return end a
 * line for `.` in a regular expression, so the statement patterns cannot read past them.
 */
export const UNREADABLE_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * The first character of a line that the lexer does not read, with its one-based column, or null.
 * A carriage return at the very end is part of a CRLF line ending, which {@link lexLine} drops.
 */
export function unreadableCharacter(raw: string): { readonly codePoint: number; readonly column: number } | null {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const found = UNREADABLE_CHARACTER.exec(line)
    return found ? { codePoint: found[0].charCodeAt(0), column: found.index + 1 } : null
}

/**
 * Splits a line into statements the way GNU as does for x86: `#` starts a comment and `;` separates
 * statements, except inside a string. A line with an {@link unreadableCharacter} is not lexed.
 */
export function lexLine(raw: string): LexedLine {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const first = line.search(/\S/)
    if (first < 0) return { kind: 'blank' }
    if (line[first] === '#') return { kind: 'comment', text: { text: line.slice(first).trimEnd(), column: first + 1 } }

    let inString = false
    let comment: number | null = null
    const separators: number[] = []
    for (let index = first; index < line.length; index += 1) {
        const character = line[index]
        if (inString) {
            if (character === '\\') index += 1
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') inString = true
        else if (character === '#') {
            comment = index
            break
        } else if (character === ';') separators.push(index)
    }

    const end = comment ?? line.length
    const statements: LexedStatement[] = []
    let start = first
    for (const cut of [...separators, end]) {
        lexStatements(line.slice(start, cut), start + 1, statements)
        start = cut + 1
    }
    return {
        kind: 'code',
        statements,
        trailingComment: comment === null ? null : comment + 1,
        separators: separators.map((index) => index + 1),
    }
}

/** The label forms a statement can start with, in the order they are tried. */
const LABEL_FORMS = [
    { kind: 'label', pattern: /^([A-Za-z_.$][A-Za-z0-9_.$]*):/ },
    { kind: 'numeric-label', pattern: /^(\d+):/ },
    { kind: 'quoted-label', pattern: /^("(?:[^"\\]|\\.)*"):/ },
] as const

/** The label `text` starts with, and how many characters it and its colon take. */
function leadingLabel(
    text: string,
): { readonly kind: (typeof LABEL_FORMS)[number]['kind']; readonly name: string; readonly length: number } | null {
    for (const { kind, pattern } of LABEL_FORMS) {
        const match = pattern.exec(text)
        if (match) return { kind, name: match[1]!, length: match[0].length }
    }
    return null
}

/**
 * Appends the statements of one `;`-delimited piece to `statements`: normally one, more when labels
 * share its line. A loop rather than recursion, so that any number of labels on one line is read in
 * time and stack proportional to its length.
 */
function lexStatements(piece: string, pieceColumn: number, statements: LexedStatement[]): void {
    let rest = piece
    let restColumn = pieceColumn
    for (;;) {
        const leading = rest.search(/\S/)
        if (leading < 0) return
        const text = rest.slice(leading).trimEnd()
        const column = restColumn + leading

        const label = leadingLabel(text)
        if (label) {
            statements.push({ kind: label.kind, name: { text: label.name, column } })
            rest = text.slice(label.length)
            restColumn = column + label.length
            continue
        }
        const directive = /^\.[A-Za-z_][A-Za-z0-9_]*(?=\s|$)/.exec(text)
        if (directive) {
            const after = text.slice(directive[0].length)
            const bodyStart = after.search(/\S/)
            statements.push({
                kind: 'directive',
                name: { text: directive[0], column },
                body:
                    bodyStart < 0
                        ? { text: '', column: column + text.length }
                        : { text: after.slice(bodyStart), column: column + directive[0].length + bodyStart },
            })
            return
        }
        const assignment = /^([A-Za-z_.$][A-Za-z0-9_.$]*)\s*=/.exec(text)
        if (assignment) statements.push({ kind: 'assignment', name: { text: assignment[1]!, column } })
        else if (/^[A-Za-z][A-Za-z0-9]*(?=\s|$)/.test(text))
            statements.push({ kind: 'instruction', body: { text, column } })
        else statements.push({ kind: 'unreadable', body: { text, column } })
        return
    }
}

/** Splits at commas outside strings, brackets and parentheses, keeping empty pieces. */
export function splitCommas(body: Token): Token[] {
    if (!body.text.trim()) return []
    const pieces: Token[] = []
    let depth = 0
    let inString = false
    let start = 0
    const push = (end: number) => {
        const raw = body.text.slice(start, end)
        const leading = raw.search(/\S/)
        pieces.push(
            leading < 0
                ? { text: '', column: body.column + start }
                : { text: raw.slice(leading).trimEnd(), column: body.column + start + leading },
        )
    }
    for (let index = 0; index < body.text.length; index += 1) {
        const character = body.text[index]
        if (inString) {
            if (character === '\\') index += 1
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') inString = true
        else if (character === '[' || character === '(') depth += 1
        else if (character === ']' || character === ')') depth -= 1
        else if (character === ',' && depth === 0) {
            push(index)
            start = index + 1
        }
    }
    push(body.text.length)
    return pieces
}

/** Splits at whitespace outside strings, which is how `.file` and `.loc` separate their fields. */
export function splitWords(body: Token): Token[] {
    const words: Token[] = []
    let index = 0
    const text = body.text
    while (index < text.length) {
        while (index < text.length && /\s/.test(text[index]!)) index += 1
        if (index >= text.length) break
        const start = index
        let inString = false
        while (index < text.length && (inString || !/\s/.test(text[index]!))) {
            if (inString && text[index] === '\\') index += 1
            else if (text[index] === '"') inString = !inString
            index += 1
        }
        words.push({ text: text.slice(start, index), column: body.column + start })
    }
    return words
}

/**
 * An integer as GNU as reads it where GCC writes one: decimal, or hexadecimal with `0x`. A decimal
 * with a leading zero is octal to GNU as and decimal to NASM, so it is not read at all.
 */
export function parseInteger(text: string): bigint | null {
    if (/^(?:0|[1-9][0-9]*)$/.test(text)) return BigInt(text)
    if (/^0[xX][0-9a-fA-F]+$/.test(text)) return BigInt(text)
    return null
}

const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
    ['b', 8],
    ['f', 12],
    ['n', 10],
    ['r', 13],
    ['t', 9],
    ['"', 34],
    ['\\', 92],
])

/**
 * The bytes of a GNU as string literal, quotes included in `token`. Every escape GNU as gives a
 * meaning is read; anything it would only warn about, or read differently from a C compiler, is an
 * error rather than a guess.
 */
export function decodeGasString(token: Token): { bytes: Uint8Array } | { error: string } {
    const text = token.text
    if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
        return { error: `expected a string in double quotes, found \`${text}\`` }
    }
    const bytes: number[] = []
    const encoder = new TextEncoder()
    for (let index = 1; index < text.length - 1; index += 1) {
        const character = text[index]!
        if (character === '"') return { error: `unexpected \`"\` inside \`${text}\`` }
        if (character !== '\\') {
            // By code point, so that a character outside the BMP, two UTF-16 units, is one character.
            const code = text.codePointAt(index)!
            if (code < 0x80) bytes.push(code)
            else {
                const unit = String.fromCodePoint(code)
                bytes.push(...encoder.encode(unit))
                index += unit.length - 1
            }
            continue
        }
        const escape = text[index + 1]
        if (escape === undefined || index + 1 >= text.length - 1) return { error: `unfinished escape in \`${text}\`` }
        const simple = SIMPLE_ESCAPES.get(escape)
        if (simple !== undefined) {
            bytes.push(simple)
            index += 1
            continue
        }
        const octal = /^[0-7]{1,3}/.exec(text.slice(index + 1, text.length - 1))
        if (octal) {
            // GNU as reads up to three decimal digits here, so `\18` is not `\1` then `8` to it.
            if (octal[0].length < 3 && /[89]/.test(text[index + 1 + octal[0].length] ?? '')) {
                return { error: `octal escape followed by a digit GNU as would read into it, in \`${text}\`` }
            }
            const value = Number.parseInt(octal[0], 8)
            if (value > 0xff) return { error: `octal escape \\${octal[0]} is larger than a byte in \`${text}\`` }
            bytes.push(value)
            index += octal[0].length
            continue
        }
        if (escape === 'x' || escape === 'X') {
            const hex = /^[0-9a-fA-F]{1,2}(?![0-9a-fA-F])/.exec(text.slice(index + 2, text.length - 1))
            if (!hex) return { error: `hexadecimal escape GNU as and NASM read differently in \`${text}\`` }
            bytes.push(Number.parseInt(hex[0], 16))
            index += 1 + hex[0].length
            continue
        }
        return { error: `escape \\${escape} has no meaning GNU as defines, in \`${text}\`` }
    }
    return { bytes: Uint8Array.from(bytes) }
}

const NASM_SIMPLE_ESCAPES: ReadonlyMap<number, string> = new Map([
    [8, '\\b'],
    [9, '\\t'],
    [10, '\\n'],
    [12, '\\f'],
    [13, '\\r'],
    [92, '\\\\'],
    [96, '\\`'],
])

/**
 * A NASM backquote string with exactly these bytes. Printable ASCII is written as itself, the C
 * escapes GNU as and NASM share are kept, and every other byte is a three-digit octal escape, which
 * NASM reads up to three digits of, so a following digit can never join it.
 */
export function encodeNasmString(bytes: Uint8Array): string {
    let text = '`'
    for (const byte of bytes) {
        const simple = NASM_SIMPLE_ESCAPES.get(byte)
        if (simple) text += simple
        else if (byte >= 0x20 && byte <= 0x7e) text += String.fromCharCode(byte)
        else text += `\\${byte.toString(8).padStart(3, '0')}`
    }
    return `${text}\``
}
