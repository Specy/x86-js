import type { EmscriptenFS } from './wasm-types'
import type { X86Project, X86ProjectFile } from './types'

export const X86_PROJECT_ROOT = '/__x86_project'

const stagedFiles = new WeakMap<object, Set<string>>()

export function validateX86Project(project: X86Project): void {
    if (!isProjectPath(project.entry)) throw new Error(`Invalid x86 Project entry path: ${project.entry}`)
    if (!Object.hasOwn(project.files, project.entry)) {
        throw new Error(`x86 Project entry file not found: ${project.entry}`)
    }
    if (typeof project.files[project.entry] !== 'string') {
        throw new Error(`x86 Project entry must be a text file: ${project.entry}`)
    }
    for (const [path, contents] of Object.entries(project.files)) {
        if (!isProjectPath(path)) throw new Error(`Invalid x86 Project file path: ${path}`)
        if (typeof contents !== 'string' && !(contents instanceof Uint8Array)) {
            throw new Error(`Invalid x86 Project file contents: ${path}`)
        }
    }
}

/**
 * Writes a Project into the emulator filesystem and selects the Entry directory as NASM's working
 * directory. NASM consequently owns `%include` and `incbin` resolution, including paths produced by
 * preprocessor macros.
 */
export function stageX86Project(fs: EmscriptenFS, project: X86Project): void {
    validateX86Project(project)
    const previous = stagedFiles.get(fs) ?? new Set<string>()
    const current = new Set<string>()

    fs.mkdirTree(X86_PROJECT_ROOT)
    for (const [path, contents] of Object.entries(project.files)) {
        const absolutePath = `${X86_PROJECT_ROOT}/${path}`
        const separator = absolutePath.lastIndexOf('/')
        if (separator > 0) fs.mkdirTree(absolutePath.slice(0, separator))
        fs.writeFile(absolutePath, contents)
        current.add(absolutePath)
    }
    for (const path of previous) {
        if (current.has(path)) continue
        try {
            fs.unlink(path)
        } catch {
            // A recreated filesystem or an already absent stale File is already in the right state.
        }
    }

    // The assembler command remains stable at /assembly.s, avoiding command-string escaping for
    // arbitrary Project paths. Includes and incbins are resolved from the actual Entry directory.
    fs.writeFile('/assembly.s', project.files[project.entry] as string)
    fs.chdir(projectDirectory(project.entry))
    stagedFiles.set(fs, current)
}

/** Maps a path emitted by NASM or DWARF back to the exact Project path. */
export function x86ProjectSourcePath(
    sourcePath: string | undefined,
    project: Pick<X86Project, 'entry' | 'files'>,
): string {
    if (!sourcePath || sourcePath === '/assembly.s' || sourcePath === 'assembly.s') return project.entry

    const withoutRoot = sourcePath.startsWith(`${X86_PROJECT_ROOT}/`)
        ? sourcePath.slice(X86_PROJECT_ROOT.length + 1)
        : sourcePath
    const withoutLeadingSlash = withoutRoot.replace(/^\/+/, '')
    const entryDirectory = parentPath(project.entry)
    const relativeToEntry = resolvePath(entryDirectory, withoutLeadingSlash)
    if (relativeToEntry && relativeToEntry in project.files) return relativeToEntry

    const relativeToRoot = resolvePath('', withoutLeadingSlash)
    if (relativeToRoot && relativeToRoot in project.files) return relativeToRoot

    const suffix = `/${withoutLeadingSlash}`
    const suffixMatches = Object.keys(project.files).filter(
        (path) => path === withoutLeadingSlash || path.endsWith(suffix),
    )
    return suffixMatches.length === 1 ? suffixMatches[0]! : project.entry
}

function projectDirectory(entry: string): string {
    const parent = parentPath(entry)
    return parent ? `${X86_PROJECT_ROOT}/${parent}` : X86_PROJECT_ROOT
}

function parentPath(path: string): string {
    const separator = path.lastIndexOf('/')
    return separator < 0 ? '' : path.slice(0, separator)
}

function isProjectPath(path: string): boolean {
    return (
        typeof path === 'string' &&
        path.length > 0 &&
        !path.includes('\\') &&
        !path.startsWith('/') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
        !Array.from(path).some((character) => {
            const code = character.charCodeAt(0)
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
        })
    )
}

function resolvePath(base: string, written: string): string | null {
    const parts = base ? base.split('/') : []
    for (const part of written.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (!parts.length) return null
            parts.pop()
        } else {
            parts.push(part)
        }
    }
    return parts.join('/') || null
}

export function x86ProjectText(project: X86Project, path: string): string {
    const contents: X86ProjectFile | undefined = project.files[path]
    return typeof contents === 'string' ? contents : ''
}
