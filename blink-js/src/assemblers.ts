import type { ResourceSource } from './resources'
import type { DiagnosticSeverity } from './interface'
import { nasmWasmAssembler, type WasmAssembler } from './wasm-assembler'

export interface Binary {
    file: ResourceSource
    commands: string
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
        linker?: Binary
    }
    /** Runs outside blink, and takes precedence over `binaries.assembler`. */
    wasmAssembler?: WasmAssembler
}

const assemblerAsset = (filename: string) =>
    new URL(`./assets/assemblers/${filename}`, import.meta.url)

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
                commands: '/linker /program.o -o /program',
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
                commands: '/linker /program.o -o /program',
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
 * The one-based column a diagnostic belongs on. NASM reports a line and no
 * column, but it names the thing it is complaining about: `msg' in "symbol
 * `msg' not defined", `.data' in a section warning. Finding that name in the
 * line turns a whole-line squiggle into one under the mistake itself.
 *
 * Falls back to the first column, which is what the caller would have used
 * anyway, so a message that names nothing findable is no worse off.
 */
export function locateDiagnosticColumn(message: string, line: string, warningClass?: string): number {
    // A label alone on a line is the line's first token, and NASM does not
    // quote it because the whole line is the problem.
    if (warningClass === 'label-orphan') {
        const leading = line.search(/\S/)
        return leading < 0 ? 1 : leading + 1
    }

    const quoted = message.match(/`([^'`]+)'/)?.[1]
    if (!quoted) return 1

    const index = findIdentifier(line, quoted)
    return index < 0 ? 1 : index + 1
}

/**
 * Where a name appears in a line as itself, rather than inside a longer one.
 * Identifier characters on either side mean this is a different symbol that
 * merely contains the name.
 */
function findIdentifier(line: string, name: string): number {
    const isIdentifierChar = (character: string | undefined) =>
        character !== undefined && /[\w$#@~.?]/.test(character)

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
