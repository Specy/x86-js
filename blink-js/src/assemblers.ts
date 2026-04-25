import type { ResourceSource } from './resources'

export interface Binary {
    file: ResourceSource
    commands: string
}

export interface DiagnosticLine {
    line: number
    error: string
}

export type DiagnosticsParser = (assemblerLogs: string) => DiagnosticLine[]

export interface AssemblerMode {
    id: string
    displayName: string
    description: string
    diagnosticsParser?: DiagnosticsParser
    binaries: {
        assembler: Binary
        linker?: Binary
    }
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
        description: 'NASM 3.00 + GNU ld v2.43.50. Both compiled as a static MUSL binary',
        diagnosticsParser: nasmDiagnostics,
        binaries: {
            assembler: {
                file: assemblerAsset('nasm.3.00.elf'),
                commands: '/assembler -felf64 /assembly.s -o /program.o',
            },
            linker: {
                file: assemblerAsset('gnu-ld.2.43.50.elf'),
                commands: '/linker /program.o -o /program',
            },
        },
    },
} satisfies Record<string, AssemblerMode>

export type AssemblerId = keyof typeof assemblers

export const DEFAULT_ASSEMBLER_ID: AssemblerId = 'GNU_trunk'

export function nasmDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lines = str.split(/\r?\n/)
    const regex = /^.*:(\d+): (error|warning): (.*)$/
    for (const line of lines) {
        const match = line.match(regex)
        if (match) {
            diagnostics.push({
                line: Number.parseInt(match[1] ?? '0', 10),
                error: (match[3] ?? '').trim(),
            })
        }
    }
    return diagnostics
}

export function gnuDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lines = str.split('\n')
    const regex = /\/assembly\.s:(\d+): (Error: .+)/
    for (const line of lines) {
        const match = line.match(regex)
        if (match) {
            diagnostics.push({
                line: Number.parseInt(match[1] ?? '0', 10),
                error: match[2] ?? '',
            })
        }
    }
    return diagnostics
}

export function fasmDiagnostics(str: string): DiagnosticLine[] {
    const diagnostics: DiagnosticLine[] = []
    const lineRegex = /\/assembly\.s \[(\d+)\]:/
    const errorRegex = /error: .+/
    const lines = str.split('\n')
    let lineNumber: number | null = null

    for (const line of lines) {
        const lineMatch = line.match(lineRegex)
        const errorMatch = line.match(errorRegex)
        if (lineMatch) lineNumber = Number.parseInt(lineMatch[1] ?? '0', 10)
        if (errorMatch && lineNumber !== null) {
            diagnostics.push({ line: lineNumber, error: errorMatch[0] })
            lineNumber = null
        }
    }
    return diagnostics
}