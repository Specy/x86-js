import type { ResourceSource } from './resources'
import type { DiagnosticSeverity } from './interface'
import { nasmWasmAssembler, type WasmAssembler } from './wasm-assembler'

export interface Binary {
    file: ResourceSource
    commands: string
}

export interface LinkerBinary {
    file: ResourceSource
    /**
     * The command that links however many objects the Project's translation units produced. Every
     * path it is given is one this package generated, so none of them needs escaping.
     */
    link(objects: readonly string[]): string
}

export interface DiagnosticLine {
    file?: string
    line: number
    error: string
    /** A warning still assembles; only an error stops the build. */
    severity: DiagnosticSeverity
    /**
     * NASM's own name for the warning, taken from the `[-w+label-orphan]` tag it
     * appends. It is a stable identifier for the kind of mistake, which is what
     * an explanation can be keyed on.
     */
    warningClass?: string
}

export type DiagnosticsParser = (assemblerLogs: string) => DiagnosticLine[]

export interface AssemblerMode {
    id: string
    displayName: string
    description: string
    diagnosticsParser?: DiagnosticsParser
    binaries: {
        /**
         * The assembler as an x86-64 ELF for blink to interpret. Absent when
         * `wasmAssembler` is set, which runs the assembler as its own module
         * instead - far faster, but only possible for an assembler written in
         * portable C. Fasm is written in x86 assembly and has no such build.
         */
        assembler?: Binary
        linker?: LinkerBinary
    }
    /** Runs outside blink, and takes precedence over `binaries.assembler`. */
    wasmAssembler?: WasmAssembler
}

const assemblerAsset = (filename: string) =>
    new URL(`./assets/assemblers/${filename}`, import.meta.url)

const linkCommand = (objects: readonly string[]) => `/linker ${objects.join(' ')} -o /program`

export const assemblers = {
    GNU_trunk: {
        id: 'GNU_trunk',
        displayName: 'GNU as',
        description: 'GNU as + GNU ld, version 2.43.50. Compiled as a static MUSL binary',
        diagnosticsParser: gnuDiagnostics,
        binaries: {
            assembler: {
                file: assemblerAsset('gnu-as.2.43.50.elf'),
                commands: '/assembler --gdwarf-4 /assembly.s -o /program.o',
            },
            linker: {
                file: assemblerAsset('gnu-ld.2.43.50.elf'),
                link: linkCommand,
            },
        },
    },
    FASM_trunk: {
        id: 'FASM_trunk',
        displayName: 'Fasm',
        description: 'Flat assembler version 1.73.32',
        diagnosticsParser: fasmDiagnostics,
        binaries: {
            assembler: {
                file: assemblerAsset('fasm.1.73.32.elf'),
                commands: '/assembler /assembly.s /program',
            },
        },
    },
    NASM_trunk: {
        id: 'NASM_trunk',
        displayName: 'Nasm',
        description: 'NASM 3.00 compiled to WebAssembly, + GNU ld v2.43.50 as a static MUSL binary',
        diagnosticsParser: nasmDiagnostics,
        binaries: {
            linker: {
                file: assemblerAsset('gnu-ld.2.43.50.elf'),
                link: linkCommand,
            },
        },
        wasmAssembler: nasmWasmAssembler,
    },
} satisfies Record<string, AssemblerMode>

export type AssemblerId = keyof typeof assemblers

export const DEFAULT_ASSEMBLER_ID: AssemblerId = 'NASM_trunk'

export function nasmDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lines = str.split(/\r?\n/)
    const regex = /^(.*):(\d+): (error|warning): (.*)$/
    // NASM names the class of every warning it can be told to suppress, as a
    // trailing tag: "label alone on a line ... [-w+label-orphan]".
    const classRegex = /\s*\[-w\+([\w-]+)\]$/
    for (const line of lines) {
        const match = line.match(regex)
        if (!match) continue
        const text = (match[4] ?? '').trim()
        const classMatch = text.match(classRegex)
        diagnostics.push({
            file: match[1] || undefined,
            line: Number.parseInt(match[2] ?? '0', 10),
            error: classMatch ? text.slice(0, classMatch.index).trim() : text,
            severity: match[3] === 'warning' ? 'warning' : 'error',
            ...(classMatch?.[1] ? { warningClass: classMatch[1] } : {}),
        })
    }
    return diagnostics
}

export function gnuDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lines = str.split('\n')
    const regex = /^(.*):(\d+): (Error|Warning): (.+)$/
    for (const line of lines) {
        const match = line.match(regex)
        if (!match) continue
        diagnostics.push({
            file: match[1] || undefined,
            line: Number.parseInt(match[2] ?? '0', 10),
            // The severity stays in the message, which is how GNU as writes it.
            error: `${match[3]}: ${match[4]}`,
            severity: match[3] === 'Warning' ? 'warning' : 'error',
        })
    }
    return diagnostics
}

export function fasmDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lineRegex = /^(.*) \[(\d+)\]:/
    const errorRegex = /error: .+/
    const lines = str.split('\n')
    let lineNumber: number | null = null
    let file: string | undefined

    for (const line of lines) {
        const lineMatch = line.match(lineRegex)
        const errorMatch = line.match(errorRegex)
        if (lineMatch) {
            file = lineMatch[1] || undefined
            lineNumber = Number.parseInt(lineMatch[2] ?? '0', 10)
        }
        if (errorMatch && lineNumber !== null) {
            diagnostics.push({ file, line: lineNumber, error: errorMatch[0], severity: 'error' })
            lineNumber = null
            file = undefined
        }
    }
    return diagnostics
}

/**
 * What `ld` said, as diagnostics. Nothing else in the toolchain reports a symbol that no
 * translation unit defines: NASM accepts every `extern` on the author's word, and the mistake
 * only surfaces here. Without this the link simply failed and the build looked like it had
 * succeeded, leaving the program unrunnable and nothing on screen to say why.
 *
 * `ld` writes a location as `file:line:(section+offset):`, and writes the notes that introduce an
 * error - "in function `_start':" - as lines ending in a colon, which are skipped in favour of
 * the error itself.
 */
export function ldDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    // `file:line:` optionally followed by the `(.text+0x6)` that names where in the section it is.
    const locatedRegex = /^(.*?):(\d+):(?:\([^)]*\))?:\s*(.+)$/
    for (const line of str.split(/\r?\n/)) {
        // `ld` prefixes some of its messages with its own name and others not at all; dropping it
        // keeps a prefixed location from being read as part of the file path.
        const text = line.trim().replace(/^\/linker:\s*/, '')
        // Blink echoes the command it is about to run, and a note ending in a colon belongs to
        // the message on the line after it.
        if (!text || text.startsWith('$ ') || text.endsWith(':')) continue

        const located = text.match(locatedRegex)
        const message = (located?.[3] ?? text).trim()
        if (!message) continue
        // The missing entry point is reported against the source with a far better explanation
        // than `ld` can give, so its warning here would only say the same thing twice.
        if (message.includes('cannot find entry symbol')) continue

        const isWarning = message.startsWith('warning:')
        diagnostics.push({
            ...(located?.[1] ? { file: located[1] } : {}),
            line: located ? Number.parseInt(located[2] ?? '0', 10) : 1,
            error: isWarning ? message.slice('warning:'.length).trim() : message,
            severity: isWarning ? 'warning' : 'error',
        })
    }
    return diagnostics
}

/** Where in a line a diagnostic belongs, in one-based columns. */
export type DiagnosticSpan = {
    column: number
    /**
     * One-based and exclusive. Absent when nothing in the line could be
     * identified, which leaves how much to underline to the caller.
     */
    endColumn?: number
}

/**
 * Which part of a line a diagnostic belongs on. NASM reports a line and no
 * column, but it names the thing it is complaining about: `msg' in "symbol
 * `msg' not defined", `.data' in a section warning. Finding that name in the
 * line turns a whole-line squiggle into one under the mistake itself, and the
 * name's own length is how far the squiggle runs.
 *
 * Falls back to the first column and no extent, which is what the caller would
 * have used anyway, so a message that names nothing findable is no worse off.
 */
export function locateDiagnosticSpan(message: string, line: string, warningClass?: string): DiagnosticSpan {
    // A label alone on a line is the line's first token, and NASM does not
    // quote it because the whole line is the problem.
    if (warningClass === 'label-orphan') {
        const leading = line.search(/\S/)
        if (leading < 0) return { column: 1 }
        return span(leading, identifierLength(line, leading))
    }

    const quoted = message.match(/`([^'`]+)'/)?.[1]
    if (!quoted) return { column: 1 }

    const index = findIdentifier(line, quoted)
    return index < 0 ? { column: 1 } : span(index, quoted.length)
}

/** The one-based column a diagnostic belongs on. */
export function locateDiagnosticColumn(message: string, line: string, warningClass?: string): number {
    return locateDiagnosticSpan(message, line, warningClass).column
}

function span(index: number, length: number): DiagnosticSpan {
    // A zero length underlines nothing at all, so it is left to the caller
    // rather than handed back as an empty range.
    if (length <= 0) return { column: index + 1 }
    return { column: index + 1, endColumn: index + 1 + length }
}

/** How far the identifier starting at `from` runs, zero when none starts there. */
function identifierLength(line: string, from: number): number {
    let length = 0
    while (isIdentifierChar(line[from + length])) length += 1
    return length
}

const isIdentifierChar = (character: string | undefined) =>
    character !== undefined && /[\w$#@~.?]/.test(character)

/**
 * Where a name appears in a line as itself, rather than inside a longer one.
 * Identifier characters on either side mean this is a different symbol that
 * merely contains the name.
 */
function findIdentifier(line: string, name: string): number {
    let from = 0
    while (from <= line.length - name.length) {
        const index = line.indexOf(name, from)
        if (index < 0) return -1
        if (!isIdentifierChar(line[index - 1]) && !isIdentifierChar(line[index + name.length])) {
            return index
        }
        from = index + 1
    }
    return -1
}
