import type { BlinkenlibModule, EmscriptenFS, EmscriptenFSNode } from './wasm-types'
import { X86_WORKING_DIRECTORY } from './file-system'

/** A structural capability supplied for one debug session. No editor code is imported by the Core. */
export type X86ProjectFileSystem = {
    performInstruction<T>(serial: string, operation: () => T): T
    open(
        path: string,
        flags: {
            access: 'read' | 'write' | 'read-write'
            create?: boolean
            exclusive?: boolean
            truncate?: boolean
            append?: boolean
        }
    ): number
    close(fd: number): void
    pread(fd: number, position: number, length: number): Uint8Array
    pwrite(fd: number, position: number, bytes: Uint8Array): number
    truncate(path: string, length: number): void
    ftruncate(fd: number, length: number): void
    stat(path: string): { kind: 'file' | 'directory'; size: number } | undefined
    fstat(fd: number): { kind: 'file' | 'directory'; size: number }
    list(path: string): { name: string; kind: 'file' | 'directory' }[]
    rename(from: string, to: string): void
    /** FileSystemSession calls this operation `remove`. */
    remove(path: string): void
}

type ProjectNode = EmscriptenFSNode & {
    projectPath: string
    projectKind: 'file' | 'directory'
    pendingCreate?: boolean
    pendingTruncate?: boolean
    freshlyCreated?: boolean
    unlinked?: boolean
    openHandles?: Set<number>
    detached?: boolean
    node_ops: Record<string, (...args: any[]) => any>
    stream_ops: Record<string, (...args: any[]) => any>
}

type ProjectStream = {
    node: ProjectNode
    fd: number
    flags: number
    position: number
    shared: { position: number; flags: number; projectHandle?: { fd: number; references: number } }
}

const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const O_ACCMODE = 3
const O_WRONLY = 1
const O_RDWR = 2
const O_CREAT = 64
const O_APPEND = 1024
const ERRNO: Record<string, number> = {
    EACCES: 2,
    EBADF: 8,
    EEXIST: 20,
    EFBIG: 22,
    EINVAL: 28,
    EIO: 29,
    EISDIR: 31,
    EMFILE: 33,
    ENOENT: 44,
    ENOSPC: 51,
    ENOTDIR: 54,
    ENOTSUP: 138,
    EPERM: 63
}

/**
 * Emscripten owns the guest stream's shared offset (including dup). The capability sees only
 * positional reads and writes; its own handle cursor never advances twice.
 */
export class ProjectFileSystemMount {
    private attached = true
    private opening = 0
    private readonly pendingNodes = new Set<ProjectNode>()
    private root: ProjectNode | null = null
    private readonly oldOpen: EmscriptenFS['open']
    private readonly wrappedOpen: EmscriptenFS['open']
    private readonly oldWrite: EmscriptenFS['write']
    private readonly wrappedWrite: EmscriptenFS['write']
    private readonly oldRead: EmscriptenFS['read']
    private readonly wrappedRead: EmscriptenFS['read']
    constructor(
        private readonly module: BlinkenlibModule,
        private readonly capability: X86ProjectFileSystem,
        private readonly activeSerial: () => string | null
    ) {
        const fs = module.FS
        // Emscripten performs O_CREAT and O_TRUNC ahead of stream.open. Defer both to the
        // capability's atomic open, so EMFILE/ENOSPC cannot leave a partial File.
        this.oldOpen = fs.open
        this.wrappedOpen = ((...args: Parameters<EmscriptenFS['open']>) => {
            this.opening++
            try {
                return this.oldOpen.apply(fs, args)
            } finally {
                if (--this.opening === 0) {
                    for (const node of this.pendingNodes) {
                        if (node.pendingCreate) fs.destroyNode(node)
                        node.pendingTruncate = false
                    }
                    this.pendingNodes.clear()
                }
            }
        }) as EmscriptenFS['open']
        fs.open = this.wrappedOpen
        this.oldWrite = fs.write
        this.wrappedWrite = ((stream, data, offset, length, position) => {
            // Emscripten seeks even positional O_APPEND writes before calling the stream. Linux
            // appends those bytes while leaving the shared offset unchanged.
            const shared = (stream as ProjectStream).shared
            const saved = shared?.position
            let succeeded = false
            try {
                const result = this.oldWrite.call(fs, stream, data, offset, length, position)
                succeeded = result > 0
                return result
            } finally {
                if (
                    (!succeeded || position !== undefined) &&
                    saved !== undefined &&
                    (stream as ProjectStream).node?.projectPath !== undefined
                )
                    shared.position = saved
            }
        }) as EmscriptenFS['write']
        fs.write = this.wrappedWrite
        this.oldRead = fs.read
        this.wrappedRead = ((stream, data, offset, length, position) => {
            const count = this.oldRead.call(fs, stream, data, offset, length, position)
            // Mark each offset advance as it happens, including earlier vectors of a later
            // failing readv. A positional pread is still a reversible memory-only query.
            if (
                position === undefined &&
                count > 0 &&
                (stream as ProjectStream).node?.projectPath !== undefined
            )
                this.module._blinkenlib_history_mark_irreversible?.()
            return count
        }) as EmscriptenFS['read']
        fs.read = this.wrappedRead
        fs.mount(
            { mount: () => this.makeNode(null, '/', 'directory', '') },
            {},
            X86_WORKING_DIRECTORY
        )
    }

    detach(): void {
        if (!this.attached) return
        this.attached = false
        const fs = this.module.FS
        fs.chdir('/')
        fs.unmount(X86_WORKING_DIRECTORY)
        if (fs.open === this.wrappedOpen) fs.open = this.oldOpen
        if (fs.write === this.wrappedWrite) fs.write = this.oldWrite
        if (fs.read === this.wrappedRead) fs.read = this.oldRead
        this.root = null
    }

    private error(code: string): never {
        throw new this.module.FS.ErrnoError(ERRNO[code] ?? ERRNO.EINVAL)
    }
    private translate<T>(action: () => T): T {
        this.ensureAttached()
        if (this.module.blinkHostError !== undefined) this.error('EIO')
        try {
            return action()
        } catch (error) {
            if (error instanceof this.module.FS.ErrnoError) throw error
            const code =
                error && typeof error === 'object' && 'code' in error ? String(error.code) : null
            if (code && code in ERRNO) this.error(code)
            // Return through libc and OpSyscall so native locks, insyscall and the pending
            // history packet finish normally. The runtime reports the original host failure.
            this.module.blinkHostError ??= error
            this.error('EIO')
        }
    }
    private ensureAttached(): void {
        if (!this.attached) this.error('EBADF')
    }
    private effect<T>(action: () => T, changed: (result: T) => boolean = () => true): T {
        this.ensureAttached()
        const serial = this.activeSerial()
        if (serial === null)
            throw new Error('x86 Project File operation has no active instruction serial')
        // FileSystemSession checks guest errors before changes. Mark a successful effect, or an
        // unexpected host failure which may have followed a partial effect, before control returns
        // to the native instruction and its history packet is finished.
        try {
            const result = this.translate(() => this.capability.performInstruction(serial, action))
            if (changed(result)) this.module._blinkenlib_history_mark_irreversible?.()
            return result
        } catch (error) {
            if (
                this.module.blinkHostError !== undefined ||
                !(error && typeof error === 'object' && 'errno' in error)
            )
                this.module._blinkenlib_history_mark_irreversible?.()
            throw error
        }
    }
    private path(node: ProjectNode, name: string): string {
        return node.projectPath ? `${node.projectPath}/${name}` : name
    }
    private makeNode(
        parent: ProjectNode | null,
        name: string,
        kind: 'file' | 'directory',
        path: string
    ): ProjectNode {
        const fs = this.module.FS
        const node = fs.createNode(
            parent,
            name,
            (kind === 'directory' ? S_IFDIR : S_IFREG) | 0o777,
            0
        ) as ProjectNode
        node.projectPath = path
        node.projectKind = kind
        const wrap = (ops: Record<string, (...args: any[]) => any>) =>
            Object.fromEntries(
                Object.entries(ops).map(([name, operation]) => [
                    name,
                    (...args: any[]) =>
                        name === 'close' && !this.attached
                            ? operation(...args)
                            : this.translate(() => operation(...args))
                ])
            )
        node.node_ops = wrap(kind === 'directory' ? this.directoryOps : this.fileOps)
        node.stream_ops = wrap(kind === 'directory' ? this.directoryStreamOps : this.fileStreamOps)
        if (!parent) this.root = node
        return node
    }
    private stat(node: ProjectNode) {
        const result = node.pendingCreate
            ? { kind: 'file' as const, size: 0 }
            : node.unlinked && node.openHandles?.size
              ? this.translate(() =>
                    this.capability.fstat(node.openHandles!.values().next().value!)
                )
              : this.translate(() => this.capability.stat(node.projectPath))
        if (!result) this.error('ENOENT')
        return result
    }
    private attributes(node: ProjectNode) {
        const stat = this.stat(node)
        const date = new Date(0)
        return {
            dev: 1,
            ino: node['id'] ?? 1,
            mode: node.mode,
            nlink: node.unlinked ? 0 : 1,
            uid: 0,
            gid: 0,
            rdev: 0,
            size: stat.kind === 'directory' ? 0 : stat.size,
            atime: date,
            mtime: date,
            ctime: date,
            blksize: 4096,
            blocks: Math.ceil(stat.size / 4096)
        }
    }
    private readonly directoryOps = {
        getattr: (node: ProjectNode) => this.attributes(node),
        lookup: (parent: ProjectNode, name: string) => {
            this.ensureAttached()
            const path = this.path(parent, name)
            const stat = this.translate(() => this.capability.stat(path))
            if (!stat) this.error('ENOENT')
            return this.makeNode(parent, name, stat.kind, path)
        },
        mknod: (parent: ProjectNode, name: string, mode: number) => {
            this.ensureAttached()
            if ((mode & 0o170000) !== S_IFREG) this.error('ENOTSUP')
            const node = this.makeNode(parent, name, 'file', this.path(parent, name))
            node.pendingCreate = true
            this.pendingNodes.add(node)
            return node
        },
        readdir: (node: ProjectNode) => {
            this.ensureAttached()
            return [
                '.',
                '..',
                ...this.translate(() => this.capability.list(node.projectPath)).map(
                    (entry) => entry.name
                )
            ]
        },
        rename: (node: ProjectNode, target: ProjectNode, name: string) => {
            if (node.projectKind === 'directory') this.error('EISDIR')
            const path = this.path(target, name)
            this.effect(() => this.capability.rename(node.projectPath, path))
            node.projectPath = path
            node.name = name
            this.invalidateMissingAncestors(node.parent as ProjectNode)
        },
        unlink: (parent: ProjectNode, name: string) => {
            const node = this.module.FS.lookupPath(
                `${X86_WORKING_DIRECTORY}/${this.path(parent, name)}`
            ).node as ProjectNode
            this.effect(() => this.capability.remove(node.projectPath))
            node.unlinked = true
            this.invalidateMissingAncestors(parent)
        },
        rmdir: () => this.error('ENOTSUP'),
        setattr: () => this.error('ENOTSUP')
    }
    private readonly fileOps = {
        getattr: (node: ProjectNode) => this.attributes(node),
        setattr: (node: ProjectNode, attrs: { size?: number; mode?: number }) => {
            if (attrs.size === undefined && attrs.mode === undefined) this.error('ENOTSUP')
            if (attrs.size !== undefined) {
                if (this.opening) {
                    node.pendingTruncate = true
                    this.pendingNodes.add(node)
                } else this.effect(() => this.capability.truncate(node.projectPath, attrs.size!))
            }
            // Emscripten chmods a newly created File after opening it. Mode is not persisted by
            // FileSystemSession; a later chmod has no truthful representation and is rejected.
            if (attrs.mode !== undefined) {
                if (!node.pendingCreate && !node.freshlyCreated) this.error('ENOTSUP')
                node.freshlyCreated = false
            }
        }
    }
    private readonly directoryStreamOps = {
        llseek: (stream: ProjectStream, offset: number, whence: number) => {
            const base = whence === 0 ? 0 : whence === 1 ? stream.position : 0
            const next = base + offset
            if (!Number.isSafeInteger(next) || next < 0) this.error('EINVAL')
            return next
        }
    }
    private readonly fileStreamOps = {
        open: (stream: ProjectStream) => {
            const node = stream.node
            try {
                const access =
                    (stream.flags & O_ACCMODE) === O_WRONLY
                        ? 'write'
                        : (stream.flags & O_ACCMODE) === O_RDWR
                          ? 'read-write'
                          : 'read'
                const fd = this.effect(() =>
                    this.capability.open(node.projectPath, {
                        access,
                        create: !!node.pendingCreate || !!(stream.flags & O_CREAT),
                        truncate: !!node.pendingTruncate,
                        append: !!(stream.flags & O_APPEND)
                    })
                )
                stream.shared.projectHandle = { fd, references: 1 }
                ;(node.openHandles ??= new Set()).add(fd)
                node.freshlyCreated = !!node.pendingCreate
                node.pendingCreate = false
                node.pendingTruncate = false
            } catch (error) {
                if (node.pendingCreate) this.module.FS.destroyNode(node)
                node.pendingTruncate = false
                this.module.FS.closeStream(stream.fd)
                throw error
            }
        },
        dup: (stream: ProjectStream) => {
            const handle = stream.shared.projectHandle
            if (!handle) this.error('EBADF')
            handle.references++
        },
        close: (stream: ProjectStream) => {
            const handle = stream.shared.projectHandle
            if (!handle || --handle.references !== 0) return
            stream.node.openHandles?.delete(handle.fd)
            if (this.attached) this.effect(() => this.capability.close(handle.fd))
        },
        read: (
            stream: ProjectStream,
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number
        ) => {
            const handle = stream.shared.projectHandle
            if (!handle) this.error('EBADF')
            const bytes = this.translate(() => this.capability.pread(handle.fd, position, length))
            if (!(bytes instanceof Uint8Array) || bytes.length > length)
                throw new Error('x86 Project FileSystem pread returned invalid bytes')
            buffer.set(bytes, offset)
            return bytes.length
        },
        write: (
            stream: ProjectStream,
            buffer: Uint8Array,
            offset: number,
            length: number,
            position: number
        ) => {
            const handle = stream.shared.projectHandle
            if (!handle) this.error('EBADF')
            const start =
                stream.flags & O_APPEND
                    ? this.translate(() => this.capability.fstat(handle.fd)).size
                    : position
            const bytes = buffer.slice(offset, offset + length)
            const written = length
                ? this.effect(
                      () => this.capability.pwrite(handle.fd, start, bytes),
                      (count) => count !== 0
                  )
                : 0
            if (!Number.isSafeInteger(written) || written < 0 || written > length)
                throw new Error('x86 Project FileSystem pwrite returned an invalid count')
            return written
        },
        llseek: (stream: ProjectStream, offset: number, whence: number) => {
            const handle = stream.shared.projectHandle
            if (!handle) this.error('EBADF')
            const base =
                whence === 0
                    ? 0
                    : whence === 1
                      ? stream.position
                      : this.translate(() => this.capability.fstat(handle.fd)).size
            const next = base + offset
            if (!Number.isSafeInteger(next) || next < 0) this.error('EINVAL')
            return next
        },
        setattr: (stream: ProjectStream, attrs: { size?: number }) => {
            const handle = stream.shared.projectHandle
            if (!handle) this.error('EBADF')
            if (attrs.size !== undefined)
                this.effect(() => this.capability.ftruncate(handle.fd, attrs.size!))
            else this.error('ENOTSUP')
        }
    }

    private invalidateMissingAncestors(node: ProjectNode): void {
        while (node !== this.root && !this.capability.stat(node.projectPath)) {
            const parent = node.parent as ProjectNode
            this.module.FS.destroyNode(node)
            node = parent
        }
    }
}
