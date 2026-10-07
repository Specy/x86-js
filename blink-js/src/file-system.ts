import type { EmscriptenFS, EmscriptenFSNode } from './wasm-types'

/**
 * The directory every program starts in, empty: what a run leaves there, or anywhere else, is
 * gone when the next program starts.
 */
export const X86_WORKING_DIRECTORY = '/project'

/** What a program finds besides the working directory, as the module started with them. */
const SKELETON_ROOTS = ['/dev', '/proc', '/tmp']

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFCHR = 0o020000
const S_IFLNK = 0o120000

type SkeletonEntry = {
    path: string
    /** The type and permission bits. */
    mode: number
    /** A device's number. */
    rdev: number
    /** A symbolic link's target. */
    link?: string
}

/**
 * The file system a program starts with: `/dev`, `/proc` and an empty `/tmp`, as Emscripten made
 * them before anything ran, and the root's own permissions. A mount point is kept, and what is
 * under it belongs to the file system mounted there.
 */
export type FileSystemSkeleton = {
    readonly rootMode: number
    /** Parents before their children. */
    readonly entries: readonly SkeletonEntry[]
}

export function captureFileSystemSkeleton(fs: EmscriptenFS): FileSystemSkeleton {
    const entries: SkeletonEntry[] = []
    const visit = (path: string) => {
        const node = entryNode(fs, path)
        const entry: SkeletonEntry = { path, mode: node.mode, rdev: node.rdev ?? 0 }
        if (isType(node.mode, S_IFLNK)) entry.link = fs.readlink(path)
        entries.push(entry)
        if (isType(node.mode, S_IFDIR) && !isMounted(fs, node)) {
            for (const name of children(fs, path)) visit(`${path}/${name}`)
        }
    }
    for (const root of SKELETON_ROOTS) visit(root)
    return { rootMode: fs.lookupPath('/').node.mode, entries }
}

/**
 * Puts the file system back to the skeleton and makes the empty working directory the current
 * one: everything a build staged and everything an earlier run made goes, wherever it is, and
 * whatever an earlier run removed from `/dev`, `/proc` or `/tmp`, or whose permissions it
 * changed, comes back as it was. A file system mounted at the working directory is left as it is,
 * contents and all, since what it holds is not the Core's.
 *
 * The program's own descriptors are closed when it is replaced, by the Core; a file removed here
 * while one of them is open goes once that happens.
 */
export function resetFileSystem(fs: EmscriptenFS, skeleton: FileSystemSkeleton): void {
    const kept = new Map(skeleton.entries.map((entry) => [entry.path, entry]))
    // first, since a root a program closed to everyone could not even be entered
    fs.chmod('/', skeleton.rootMode & 0o7777)
    fs.chdir('/')
    const prune = (path: string) => {
        for (const name of children(fs, path)) {
            const child = path === '/' ? `/${name}` : `${path}/${name}`
            const node = entryNode(fs, child)
            const entry = kept.get(child)
            if (child === X86_WORKING_DIRECTORY && isMounted(fs, node)) continue
            if (!entry || (entry.mode & S_IFMT) !== (node.mode & S_IFMT) || entry.rdev !== (node.rdev ?? 0)) {
                removeTree(fs, child)
                continue
            }
            if (isType(node.mode, S_IFLNK)) {
                if (fs.readlink(child) !== entry.link) removeTree(fs, child)
                continue
            }
            if ((node.mode & 0o7777) !== (entry.mode & 0o7777)) fs.chmod(child, entry.mode & 0o7777)
            if (isType(node.mode, S_IFDIR) && !isMounted(fs, node)) prune(child)
        }
    }
    prune('/')
    for (const entry of skeleton.entries) {
        if (exists(fs, entry.path)) continue
        if (isType(entry.mode, S_IFDIR)) fs.mkdir(entry.path, entry.mode & 0o7777)
        else if (isType(entry.mode, S_IFCHR)) fs.mkdev(entry.path, entry.mode & 0o7777, entry.rdev)
        else if (entry.link !== undefined) fs.symlink(entry.link, entry.path)
    }
    if (!exists(fs, X86_WORKING_DIRECTORY)) fs.mkdir(X86_WORKING_DIRECTORY, 0o777)
    fs.chdir(X86_WORKING_DIRECTORY)
}

/** The node of the entry at `path` itself: not the target of a link, not a file system mounted there. */
function entryNode(fs: EmscriptenFS, path: string): EmscriptenFSNode {
    return fs.lookupPath(path, { follow: false, follow_mount: false }).node
}

/**
 * Whether another file system is mounted at a directory. Looking a path up finds either the mount
 * point or, when the mounted file system's root took the mount point's name, as `/proc/self/fd`'s
 * does, that root.
 */
function isMounted(fs: EmscriptenFS, node: EmscriptenFSNode): boolean {
    return fs.isMountpoint(node) || node.mount?.root === node
}

function children(fs: EmscriptenFS, path: string): string[] {
    return fs.readdir(path).filter((name) => name !== '.' && name !== '..')
}

function exists(fs: EmscriptenFS, path: string): boolean {
    try {
        entryNode(fs, path)
        return true
    } catch {
        return false
    }
}

function isType(mode: number, type: number): boolean {
    return (mode & S_IFMT) === type
}

/** Removes an entry and, for a directory, what is in it, whatever permissions a program gave them. */
function removeTree(fs: EmscriptenFS, path: string): void {
    const node = entryNode(fs, path)
    if (!isType(node.mode, S_IFDIR)) {
        fs.unlink(path)
        return
    }
    // A mount point cannot be removed, and what it holds is not the Core's to remove.
    if (isMounted(fs, node)) return
    fs.chmod(path, 0o777)
    for (const name of children(fs, path)) removeTree(fs, `${path}/${name}`)
    fs.rmdir(path)
}
