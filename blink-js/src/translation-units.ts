import { x86ProjectSourcePath } from './project'
import type { X86Project } from './types'

/**
 * Extensions that make a Project File assembler input in its own right. `.inc` is deliberately
 * absent: it is what an include fragment is conventionally called, and a fragment assembled on
 * its own would define its symbols a second time. A fragment under any other name is caught by
 * the dependency scan instead.
 */
const SOURCE_EXTENSIONS = ['.asm', '.s', '.nasm'] as const

export function isX86Source(path: string): boolean {
    const lower = path.toLowerCase()
    return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * Every File that could be its own translation unit: assembled separately and linked with the
 * rest, which is what makes `global` in one File and `extern` in another resolve to each other.
 * The Entry comes first so it leads the link, and the rest follow in a stable order so two builds
 * of the same Project lay out identically.
 */
export function x86TranslationUnitCandidates(project: X86Project): string[] {
    const others = Object.keys(project.files)
        .filter((path) => path !== project.entry)
        .filter((path) => typeof project.files[path] === 'string' && isX86Source(path))
        .sort()
    return [project.entry, ...others]
}

/**
 * The Files named by one `nasm -M` run, as Project paths. A File that another source `%include`s
 * is already part of that source: assembling it again would define every one of its symbols a
 * second time, so the link would fail on duplicate definitions rather than on anything the author
 * wrote. Asking NASM rather than scanning for `%include` ourselves is what keeps macro-generated
 * and conditional includes right, since NASM is the only thing that knows which ones it took.
 */
export function parseDependencyList(output: string, project: X86Project): string[] {
    const separator = output.indexOf(':')
    if (separator < 0) return []
    return output
        .slice(separator + 1)
        .replace(/\\\r?\n/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((written) => x86ProjectSourcePath(written, project))
}
