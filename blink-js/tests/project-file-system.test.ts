import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import type { X86ProjectFileSystem } from '../src/project-file-system'
import { probeSource, quadwords, NATIVE, runNatively } from './linux-probe'
import { BlinkState } from '../src/types'
import { EmulatorStatus } from '../src/interface'

const SOURCE = `bits 64
global _start
section .text
_start:
  mov eax, 2
  lea rdi, [rel path]
  mov esi, 66
  mov edx, 438
  syscall
  mov r12, rax
  mov eax, 1
  mov rdi, r12
  lea rsi, [rel payload]
  mov edx, 3
  syscall
  mov eax, 8
  mov rdi, r12
  xor esi, esi
  xor edx, edx
  syscall
  mov eax, 0
  mov rdi, r12
  lea rsi, [rel buffer]
  mov edx, 3
  syscall
  mov eax, 1
  mov edi, 1
  lea rsi, [rel buffer]
  mov edx, 3
  syscall
  mov eax, 60
  xor edi, edi
  syscall
section .data
path: db '/project/data.txt', 0
payload: db 'abc'
buffer: times 4 db 0
`

class GuestError extends Error {
    constructor(readonly code: string) {
        super(code)
    }
}

class Session implements X86ProjectFileSystem {
    files = new Map<string, Uint8Array>()
    handles = new Map<number, { bytes: Uint8Array; readable: boolean; writable: boolean }>()
    serials: string[] = []
    ended = false
    nextFd = 3
    maxOpen = 4096
    active: string | null = null
    effects: { serial: string; operation: string }[] = []
    private effect(operation: string) {
        if (!this.active) throw new Error('capability effect occurred outside performInstruction')
        this.effects.push({ serial: this.active, operation })
    }
    performInstruction<T>(serial: string, operation: () => T): T {
        if (this.ended) throw new Error('ended capability was called')
        this.serials.push(serial)
        this.active = serial
        try {
            return operation()
        } finally {
            this.active = null
        }
    }
    private live() {
        if (this.ended) throw new Error('ended capability was called')
    }
    private handle(fd: number) {
        this.live()
        const handle = this.handles.get(fd)
        if (!handle) throw new GuestError('EBADF')
        return handle
    }
    open(path: string, flags: Parameters<X86ProjectFileSystem['open']>[1]): number {
        this.live()
        if (this.handles.size >= this.maxOpen) throw new GuestError('EMFILE')
        if (this.stat(path)?.kind === 'directory') throw new GuestError('EISDIR')
        const old = this.files.get(path)
        if (!old && !flags.create) throw new GuestError('ENOENT')
        if (old && flags.exclusive && flags.create) throw new GuestError('EEXIST')
        if (!old && this.files.size >= 4096) throw new GuestError('ENOSPC')
        this.effect('open')
        const bytes = flags.truncate ? new Uint8Array() : (old ?? new Uint8Array())
        this.files.set(path, bytes)
        const fd = this.nextFd++
        this.handles.set(fd, {
            bytes,
            readable: flags.access !== 'write',
            writable: flags.access !== 'read'
        })
        return fd
    }
    close(fd: number): void {
        this.handle(fd)
        this.effect('close')
        this.handles.delete(fd)
    }
    pread(fd: number, position: number, length: number): Uint8Array {
        const h = this.handle(fd)
        if (!h.readable) throw new GuestError('EBADF')
        return h.bytes.slice(position, position + length)
    }
    pwrite(fd: number, position: number, bytes: Uint8Array): number {
        const h = this.handle(fd)
        if (!h.writable) throw new GuestError('EBADF')
        if (position + bytes.length > 16 * 1024 * 1024) throw new GuestError('EFBIG')
        const total = [
            ...new Set([...this.files.values(), ...[...this.handles.values()].map((h) => h.bytes)])
        ].reduce(
            (size, value) =>
                size +
                (value === h.bytes
                    ? Math.max(value.length, position + bytes.length)
                    : value.length),
            0
        )
        if (total > 16 * 1024 * 1024) throw new GuestError('ENOSPC')
        this.effect('pwrite')
        const next = new Uint8Array(Math.max(h.bytes.length, position + bytes.length))
        next.set(h.bytes)
        next.set(bytes, position)
        const previous = h.bytes
        for (const handle of this.handles.values())
            if (handle.bytes === previous) handle.bytes = next
        for (const [path, value] of this.files) if (value === previous) this.files.set(path, next)
        return bytes.length
    }
    truncate(path: string, length: number): void {
        const fd = this.open(path, { access: 'read-write' })
        this.ftruncate(fd, length)
        this.close(fd)
    }
    ftruncate(fd: number, length: number): void {
        const h = this.handle(fd)
        if (!h.writable) throw new GuestError('EINVAL')
        if (length > 16 * 1024 * 1024) throw new GuestError('EFBIG')
        this.effect('ftruncate')
        const next = new Uint8Array(length)
        next.set(h.bytes.subarray(0, length))
        const previous = h.bytes
        for (const handle of this.handles.values())
            if (handle.bytes === previous) handle.bytes = next
        for (const [path, value] of this.files) if (value === previous) this.files.set(path, next)
    }
    stat(path: string) {
        this.live()
        if (path === '') return { kind: 'directory' as const, size: 0 }
        const bytes = this.files.get(path)
        if (bytes) return { kind: 'file' as const, size: bytes.length }
        if ([...this.files.keys()].some((key) => key.startsWith(`${path}/`)))
            return { kind: 'directory' as const, size: 0 }
        return undefined
    }
    fstat(fd: number) {
        return { kind: 'file' as const, size: this.handle(fd).bytes.length }
    }
    list(path: string) {
        if (this.stat(path)?.kind !== 'directory') throw new GuestError('ENOTDIR')
        const prefix = path ? `${path}/` : ''
        const children = new Map<string, 'file' | 'directory'>()
        for (const name of this.files.keys()) {
            if (!name.startsWith(prefix)) continue
            const suffix = name.slice(prefix.length)
            const slash = suffix.indexOf('/')
            children.set(
                slash < 0 ? suffix : suffix.slice(0, slash),
                slash < 0 ? 'file' : 'directory'
            )
        }
        return [...children].map(([name, kind]) => ({ name, kind }))
    }
    rename(from: string, to: string): void {
        const value = this.files.get(from)
        if (!value) throw new GuestError('ENOENT')
        if (this.stat(to)) throw new GuestError('EEXIST')
        this.effect('rename')
        this.files.delete(from)
        this.files.set(to, value)
    }
    remove(path: string): void {
        if (!this.files.has(path)) throw new GuestError('ENOENT')
        this.effect('remove')
        this.files.delete(path)
    }
}

describe('mounted Project FileSystem', () => {
    it('runs Linux open/write/seek/read through a positional capability with one active serial per effect', async () => {
        const emulator = await createX86Emulator()
        const session = new Session()
        const output: Uint8Array[] = []
        emulator.on('stdout', (bytes) => {
            output.push(bytes)
        })
        try {
            const result = await emulator.compile(SOURCE)
            expect(result.ok, result.report).toBe(true)
            emulator.initialize(100)
            emulator.mountProjectFileSystem(session)
            await emulator.run(100)
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abc')
            expect(
                new TextDecoder().decode(Uint8Array.from(output.flatMap((bytes) => [...bytes])))
            ).toBe('abc')
            expect(session.serials.length).toBeGreaterThan(0)
            expect(session.serials.every((serial) => /^\d+$/.test(serial))).toBe(true)
            expect(new Set(session.serials).size).toBe(session.serials.length)
        } finally {
            emulator.dispose()
        }
    })

    it('does not call an ended capability while replacing and rebuilding a program', async () => {
        const emulator = await createX86Emulator()
        const session = new Session()
        try {
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.initialize(100)
            emulator.mountProjectFileSystem(session)
            await emulator.run(100)
            session.ended = true
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
        } finally {
            emulator.dispose()
        }
    })
})

async function mounted(body: string[], session = new Session(), history = 500) {
    const emulator = await createX86Emulator()
    const bytes: number[] = []
    emulator.on('stderr', (chunk) => {
        bytes.push(...chunk)
    })
    const result = await emulator.compile(probeSource(body))
    expect(result.ok, result.report).toBe(true)
    const executable = emulator.getExecutable()!
    emulator.initialize(history)
    emulator.mountProjectFileSystem(session)
    return { emulator, session, bytes, executable }
}
const PATHS = [
    'section .data',
    "path: db 'data.txt',0",
    "other: db 'renamed.txt',0",
    "directory: db '.',0",
    "payload: db 'abcXYZ'",
    'section .text'
]

describe('Project FileSystem guest contracts', () => {
    it('detaches old loaded capabilities before loadElf cleanup and isolates the replacement run', async () => {
        const { emulator, session, executable } = await mounted([
            'sys 2,path,66,438',
            'mov r12,rax',
            'sys 1,r12,payload,3',
            'finish',
            ...PATHS
        ])
        try {
            await emulator.run(1000)
            session.ended = true
            emulator.loadElf(executable)
            const replacement = new Session()
            emulator.mountProjectFileSystem(replacement)
            await emulator.run(1000)
            expect(new TextDecoder().decode(replacement.files.get('data.txt'))).toBe('abc')
            replacement.ended = true
        } finally {
            emulator.dispose()
        }
    })

    it('stops an asynchronous Run between slices and prevents its scheduled continuation', async () => {
        const { emulator } = await mounted(['inc r12', 'jmp _start'])
        try {
            const running = emulator.run(1000000)
            // run() reaches its first host yield before returning this promise.
            emulator.clearExecution()
            const count = emulator.getInstructionsExecuted()
            await running
            expect(emulator.state).toBe(BlinkState.Ready)
            expect(emulator.getInstructionsExecuted()).toBe(count)
            expect(emulator.getUndoDepth()).toBe(0)
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.mountProjectFileSystem(new Session())
            await emulator.run(1000)
            expect(emulator.stopReason?.kind).toBe('exit')
        } finally {
            emulator.dispose()
        }
    })
    it('refuses mounted File mmap before MAP_FIXED can destroy an anonymous mapping', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new Uint8Array(4096))
        const { emulator, bytes } = await mounted(
            [
                'sys 9,0,4096,3,34,-1,0',
                'mov r12,rax',
                'mov qword [r12],123',
                'sys 2,path,2,0',
                'mov r13,rax',
                'sys 9,r12,4096,3,18,r13,0',
                'save',
                'saveq r12',
                'finish',
                ...PATHS
            ],
            initial
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-19n, 123n])
        } finally {
            emulator.dispose()
        }
    })
    it('refuses capability mutations without an active serial and guards mounts after loading', async () => {
        const { emulator, session } = await mounted(['nop', 'finish'])
        try {
            expect(() =>
                emulator.module.FS.writeFile('/project/illegal', new Uint8Array([65]))
            ).toThrow()
            expect(String(emulator.module.blinkHostError)).toContain('no active instruction serial')
            expect(session.effects).toEqual([])
            expect(session.files.size).toBe(0)
            emulator.clearExecution()
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.mountProjectFileSystem(session)
            emulator.getNextInstruction()
            expect(() => emulator.mountProjectFileSystem(null)).toThrow('while a program is active')
        } finally {
            emulator.dispose()
        }
    })

    it('checks File-count and aggregate-byte capacity and preserves an append cursor on failure', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new TextEncoder().encode('abc'))
        initial.files.set('padding', new Uint8Array(16 * 1024 * 1024 - 3))
        for (let i = 0; i < 4094; i++) initial.files.set(`empty-${i}`, new Uint8Array())
        const { emulator, session, bytes } = await mounted(
            [
                'sys 2,other,66,438',
                'save',
                'sys 2,path,1026,438',
                'mov r12,rax',
                'sys 8,r12,1,0',
                'save',
                'sys 1,r12,payload,1',
                'save',
                'sys 8,r12,0,1',
                'save',
                'finish',
                ...PATHS
            ],
            initial
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-28n, 1n, -28n, 1n])
            expect(session.files.has('renamed.txt')).toBe(false)
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abc')
            expect(session.files.size).toBe(4096)
        } finally {
            emulator.dispose()
        }
    })

    it('marks a readv offset advance even when a later vector returns guest EIO', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new TextEncoder().encode('abcdef'))
        const read = initial.pread.bind(initial)
        let calls = 0
        initial.pread = (...args) => {
            if (++calls === 2) throw new GuestError('EIO')
            return read(...args)
        }
        const { emulator, bytes } = await mounted(
            [
                'sys 2,path,0,0',
                'mov r12,rax',
                'mov qword [buf2],buf',
                'mov qword [buf2+8],3',
                'mov qword [buf2+16],buf+8',
                'mov qword [buf2+24],3',
                'sys 19,r12,buf2,2',
                'save',
                'sys 8,r12,0,1',
                'save',
                'saveq buf',
                'finish',
                ...PATHS
            ],
            initial
        )
        try {
            // Stop immediately after readv so its partial effect cannot hide beneath later rows.
            for (let count = 0, index = 0; index < 100; index++) {
                const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                await emulator.step()
                if (syscall && ++count === 2) break
            }
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(-5n)
            expect(emulator.canUndo()).toBe(false)
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-5n, 3n, 0x636261n])
        } finally {
            emulator.dispose()
        }
    })

    it('checks the gathered writev capacity before changing any bytes or cursor', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new Uint8Array(16 * 1024 * 1024 - 1))
        const { emulator, session, bytes } = await mounted(
            [
                'sys 2,path,1026,0',
                'mov r12,rax',
                'sys 20,r12,iov,2',
                'save',
                'sys 8,r12,0,1',
                'save',
                'finish',
                'section .data',
                // Blink coalesces adjacent guest buffers; keep these vectors separate.
                'iov: dq payload,1,payload+3,1',
                ...PATHS
            ],
            initial
        )
        try {
            for (let count = 0, index = 0; index < 100; index++) {
                const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                await emulator.step()
                if (syscall && ++count === 2) break
            }
            // Emscripten gathers writev into one positional capability write.
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(-27n)
            expect(emulator.canUndo()).toBe(true)
            expect(session.files.get('data.txt')).toHaveLength(16 * 1024 * 1024 - 1)
            expect(session.files.get('data.txt')!.at(-1)).toBe(0)
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-27n, 0n])
        } finally {
            emulator.dispose()
        }
    })

    it.each([false, true])(
        'keeps a rejected sendfile free of source-offset effects (explicit=%s)',
        async (explicit) => {
            const initial = new Session()
            initial.pwrite = () => {
                throw new GuestError('ENOSPC')
            }
            const { emulator, session, bytes } = await mounted(
                [
                    'sys 2,temporary,66,438',
                    'mov r12,rax',
                    'sys 1,r12,payload,3',
                    'sys 8,r12,0,0',
                    'sys 2,path,66,438',
                    'mov r13,rax',
                    `sys 40,r13,r12,${explicit ? 'offset' : '0'},3`,
                    'save',
                    'sys 8,r12,0,1',
                    'save',
                    'saveq offset',
                    'finish',
                    'section .data',
                    "temporary: db '/tmp/input',0",
                    'offset: dq 0',
                    ...PATHS
                ],
                initial
            )
            try {
                for (let count = 0, index = 0; index < 100; index++) {
                    const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                    await emulator.step()
                    if (syscall && ++count === 5) break
                }
                expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(-28n)
                expect(session.files.get('data.txt')).toHaveLength(0)
                expect(emulator.canUndo()).toBe(true)
                emulator.undo()
                await emulator.step()
                await emulator.run(10000)
                expect(quadwords(Uint8Array.from(bytes))).toEqual([-28n, 0n, 0n])
            } finally {
                emulator.dispose()
            }
        }
    )

    it.each([false, true])(
        'commits only transferred sendfile bytes before a later error (explicit=%s)',
        async (explicit) => {
            const initial = new Session()
            initial.files.set('source.txt', new Uint8Array(20000).fill(97))
            const write = initial.pwrite.bind(initial)
            let calls = 0
            initial.pwrite = (...args) => {
                if (++calls === 2) throw new GuestError('ENOSPC')
                return write(...args)
            }
            const { emulator, session, bytes } = await mounted(
                [
                    'sys 2,source,0,0',
                    'mov r12,rax',
                    'sys 2,path,66,438',
                    'mov r13,rax',
                    `sys 40,r13,r12,${explicit ? 'offset' : '0'},20000`,
                    'save',
                    'sys 8,r12,0,1',
                    'save',
                    'saveq offset',
                    'finish',
                    'section .data',
                    "source: db 'source.txt',0",
                    'offset: dq 0',
                    ...PATHS
                ],
                initial
            )
            try {
                for (let count = 0, index = 0; index < 100; index++) {
                    const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                    await emulator.step()
                    if (syscall && ++count === 3) break
                }
                expect(emulator.getRegisterValue('rax')).toBe(16384n)
                expect(emulator.canUndo()).toBe(false)
                expect(session.files.get('data.txt')).toHaveLength(16384)
                await emulator.run(10000)
                expect(quadwords(Uint8Array.from(bytes))).toEqual([
                    16384n,
                    explicit ? 0n : 16384n,
                    explicit ? 16384n : 0n
                ])
            } finally {
                emulator.dispose()
            }
        }
    )

    it('returns from sendfile on a zero-byte destination write without consuming its source', async () => {
        const initial = new Session()
        initial.files.set('source.txt', new Uint8Array([97]))
        initial.pwrite = () => 0
        const { emulator, bytes } = await mounted(
            [
                'sys 2,source,0,0',
                'mov r12,rax',
                'sys 2,path,66,438',
                'mov r13,rax',
                'sys 40,r13,r12,0,1',
                'save',
                'sys 8,r12,0,1',
                'save',
                'finish',
                'section .data',
                "source: db 'source.txt',0",
                ...PATHS
            ],
            initial
        )
        try {
            for (let count = 0, index = 0; index < 100; index++) {
                const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                await emulator.step()
                if (syscall && ++count === 3) break
            }
            expect(emulator.getRegisterValue('rax')).toBe(0n)
            expect(emulator.canUndo()).toBe(true)
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([0n, 0n])
        } finally {
            emulator.dispose()
        }
    })

    it('journals an explicit sendfile offset to deferred stdout while leaving its source cursor unchanged', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new TextEncoder().encode('abc'))
        const { emulator, bytes } = await mounted(
            [
                'sys 2,path,0,0',
                'mov r12,rax',
                'lea r14,[rel offset]',
                'sys 40,1,r12,r14,3',
                'saveq offset',
                'sys 8,r12,0,1',
                'save',
                'finish',
                'section .data',
                'offset: dq 0',
                ...PATHS
            ],
            initial
        )
        try {
            for (let count = 0, index = 0; index < 100; index++) {
                const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                await emulator.step()
                if (syscall && ++count === 2) break
            }
            const address = emulator.getRegisterValue('r14')
            expect(emulator.readMemoryBytes(address, 8n)[0]).toBe(3)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(emulator.readMemoryBytes(address, 8n)[0]).toBe(0)
            await emulator.step()
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([3n, 0n])
        } finally {
            emulator.dispose()
        }
    })

    it.each([false, true])(
        'restores the preliminary RWF_APPEND seek after a no-effect write (zero=%s)',
        async (zero) => {
            const initial = new Session()
            initial.files.set('data.txt', new TextEncoder().encode('abc'))
            initial.pwrite = () => {
                if (zero) return 0
                throw new GuestError('ENOSPC')
            }
            const { emulator, session, bytes } = await mounted(
                [
                    'sys 2,path,2,0',
                    'mov r12,rax',
                    'sys 328,r12,iov,1,-1,0,0x10',
                    'save',
                    'sys 8,r12,0,1',
                    'save',
                    'finish',
                    'section .data',
                    'iov: dq payload,3',
                    ...PATHS
                ],
                initial
            )
            try {
                for (let count = 0, index = 0; index < 100; index++) {
                    const syscall = emulator.getNextInstruction()?.code.includes('syscall')
                    await emulator.step()
                    if (syscall && ++count === 2) break
                }
                expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(zero ? 0n : -28n)
                expect(emulator.canUndo()).toBe(true)
                emulator.undo()
                await emulator.step()
                await emulator.run(10000)
                expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abc')
                expect(quadwords(Uint8Array.from(bytes))).toEqual([zero ? 0n : -28n, 0n])
            } finally {
                emulator.dispose()
            }
        }
    )

    it('clears a pending terminal read and armed timer without leaving a native machine or stale callback', async () => {
        const { emulator, session } = await mounted(['sys 37,1', 'sys 0,0,buf,8', 'finish'])
        try {
            expect(await emulator.run(1000)).toBe(EmulatorStatus.WaitingForInput)
            expect(() => emulator.mountProjectFileSystem(null)).toThrow('while a program is active')
            session.ended = true
            emulator.clearExecution()
            expect(emulator.module._blinkenlib_timer_deadline()).toBe(-1n)
            expect(emulator.getPc()).toBe(0n)
            emulator.provideInput('unused')
            expect(emulator.getCurrentInstructionSerial()).toBeNull()
            emulator.clearExecution()
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.mountProjectFileSystem(new Session())
            await emulator.run(1000)
            expect(emulator.stopReason?.kind).toBe('exit')
        } finally {
            emulator.dispose()
        }
    })
    it('preserves open identities across rejected rename replacement and unlink/recreate', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new TextEncoder().encode('old'))
        initial.files.set('renamed.txt', new TextEncoder().encode('target'))
        const { emulator, session, bytes } = await mounted(
            [
                'sys 2,path,2,0',
                'mov r12,rax',
                'sys 2,other,2,0',
                'mov r13,rax',
                'sys 82,path,other',
                'save',
                'sys 17,r13,buf,8,0',
                'save',
                'saveq buf',
                'sys 87,path',
                'save',
                'sys 2,path,66,438',
                'mov r14,rax',
                'sys 1,r14,payload,3',
                'save',
                'sys 5,r12,buf2',
                'save',
                'saveq buf2+16',
                'saveq buf2+48',
                'mov qword [buf],0',
                'sys 17,r12,buf,8,0',
                'save',
                'saveq buf',
                'sys 18,r12,payload+3,3,0',
                'save',
                'sys 77,r13,3',
                'save',
                'finish',
                ...PATHS
            ],
            initial
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                -17n,
                6n,
                0x746567726174n,
                0n,
                3n,
                0n,
                0n,
                3n,
                3n,
                0x646c6fn,
                3n,
                0n
            ])
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abc')
            expect(new TextDecoder().decode(session.files.get('renamed.txt'))).toBe('tar')
        } finally {
            emulator.dispose()
        }
    })

    it('invalidates implicit parent caches after rename and unlink without losing open File metadata', async () => {
        const initial = new Session()
        initial.files.set('a/file', new Uint8Array([65]))
        initial.files.set('b/keep', new Uint8Array([66]))
        const { emulator, session, bytes } = await mounted(
            [
                'sys 4,oldparent,buf',
                'save',
                'sys 2,oldpath,2,0',
                'mov r12,rax',
                'sys 82,oldpath,newpath',
                'save',
                'sys 4,oldparent,buf',
                'save',
                'sys 5,r12,buf',
                'save',
                'saveq buf+48',
                'sys 87,newpath',
                'save',
                'sys 5,r12,buf',
                'save',
                'saveq buf+16',
                'finish',
                'section .data',
                "oldparent: db 'a',0",
                "oldpath: db 'a/file',0",
                "newpath: db 'b/file',0",
                'section .text'
            ],
            initial
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([0n, 0n, -2n, 0n, 1n, 0n, 0n, 0n])
            expect([...session.files.keys()]).toEqual(['b/keep'])
        } finally {
            emulator.dispose()
        }
    })

    it('checks native descriptor limits before create/truncate and removes failed-open placeholder nodes', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new TextEncoder().encode('original'))
        const { emulator, session, bytes } = await mounted(
            [
                'sys 2,other,65602,438',
                'save',
                'sys 4,other,buf',
                'save',
                'mov qword [buf],3',
                'mov qword [buf+8],3',
                'sys 160,7,buf',
                'save',
                'sys 2,path,514,438',
                'save',
                'sys 2,other,66,438',
                'save',
                'finish',
                ...PATHS
            ],
            initial
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-20n, -2n, 0n, -24n, -24n])
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('original')
            expect(session.files.has('renamed.txt')).toBe(false)
            expect(session.effects).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it.each(['bytes', 'count', 'read failure'] as const)(
        'reports malformed capability %s through clean host-error termination',
        async (kind) => {
            const initial = new Session()
            initial.files.set('data.txt', new Uint8Array([65]))
            if (kind === 'bytes') initial.pread = () => [65] as unknown as Uint8Array
            if (kind === 'read failure')
                initial.pread = () => {
                    throw new Error('read transport broken')
                }
            if (kind === 'count') initial.pwrite = () => 99
            const { emulator } = await mounted(
                [
                    'sys 2,path,2,0',
                    'mov r12,rax',
                    kind === 'count' ? 'sys 1,r12,payload,1' : 'sys 17,r12,buf,1,0',
                    'mov r14,999',
                    'finish',
                    ...PATHS
                ],
                initial
            )
            try {
                await expect(emulator.run(10000)).rejects.toThrow(
                    kind === 'read failure'
                        ? 'read transport broken'
                        : kind === 'count'
                          ? 'invalid count'
                          : 'invalid bytes'
                )
                expect(emulator.getRegisterValue('r14')).toBe(0n)
                expect(emulator.stopReason?.kind).toBe('host-error')
                expect(emulator.getCurrentInstructionSerial()).toBeNull()
            } finally {
                emulator.dispose()
            }
        }
    )

    it('detaches before ended-session cleanup on Stop, cancels late waits, and preserves callbacks for rebuilding', async () => {
        let completeWait: (() => void) | undefined
        let signal: AbortSignal | undefined
        const emulator = await createX86Emulator({
            environment: {
                now: () => 1000,
                wait: (_request, abort) => {
                    signal = abort
                    return new Promise<void>((resolve) => {
                        completeWait = resolve
                    })
                }
            }
        })
        const session = new Session()
        const output: number[] = []
        emulator.on('stdout', (chunk) => {
            output.push(...chunk)
        })
        try {
            expect(
                (
                    await emulator.compile(
                        probeSource([
                            'sys 2,path,66,438',
                            'mov r12,rax',
                            'sys 1,r12,payload,3',
                            'mov qword [buf],10',
                            'sys 35,buf,0',
                            'finish',
                            ...PATHS
                        ])
                    )
                ).ok
            ).toBe(true)
            emulator.initialize(100)
            emulator.mountProjectFileSystem(session)
            expect(await emulator.run(1000)).toBe(EmulatorStatus.Waiting)
            await Promise.resolve()
            expect(signal?.aborted).toBe(false)
            const count = emulator.getInstructionsExecuted()
            session.ended = true
            emulator.clearExecution()
            expect(signal?.aborted).toBe(true)
            expect(emulator.state).toBe(BlinkState.Ready)
            expect(emulator.getCurrentInstructionSerial()).toBeNull()
            expect(emulator.getUndoDepth()).toBe(0)
            completeWait?.()
            await new Promise((resolve) => setTimeout(resolve, 5))
            expect(emulator.getInstructionsExecuted()).toBe(count)
            expect(emulator.getWaitRequest()).toBeNull()
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            const replacement = new Session()
            emulator.mountProjectFileSystem(replacement)
            await emulator.run(1000)
            expect(new TextDecoder().decode(Uint8Array.from(output))).toBe('abc')
            expect(new TextDecoder().decode(replacement.files.get('data.txt'))).toBe('abc')
            replacement.ended = true
            emulator.clearExecution()
            emulator.clearExecution()
        } finally {
            emulator.dispose()
        }
    })
    it('shares dup offsets and retains the capability handle until the last close, matching Linux', async () => {
        const body = [
            'sys 2,path,66,438',
            'mov r12,rax',
            'sys 1,r12,payload,3',
            'save',
            'sys 8,r12,0,0',
            'save',
            'sys 32,r12',
            'mov r13,rax',
            'sys 0,r13,buf,1',
            'save',
            'sys 8,r12,0,1',
            'save',
            'sys 3,r12',
            'save',
            'sys 0,r13,buf+1,2',
            'save',
            'mov eax,[buf]',
            'save',
            'sys 3,r13',
            'save',
            'finish',
            ...PATHS
        ]
        const { emulator, session, bytes, executable } = await mounted(body)
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                3n,
                0n,
                1n,
                1n,
                0n,
                2n,
                0x636261n,
                0n
            ])
            expect(session.effects.filter((e) => e.operation === 'close')).toHaveLength(1)
            expect(session.handles.size).toBe(0)
            if (NATIVE)
                expect(runNatively(executable).results).toEqual(quadwords(Uint8Array.from(bytes)))
        } finally {
            emulator.dispose()
        }
    })

    it('keeps positional append writes at EOF without moving the shared offset, matching Linux', async () => {
        const body = [
            'sys 2,path,1090,438',
            'mov r12,rax',
            'sys 1,r12,payload,3',
            'save',
            'sys 8,r12,1,0',
            'save',
            'sys 18,r12,payload+3,3,0',
            'save',
            'sys 8,r12,0,1',
            'save',
            'sys 17,r12,buf,6,0',
            'save',
            'saveq buf',
            'sys 8,r12,0,1',
            'save',
            'finish',
            ...PATHS
        ]
        const { emulator, session, bytes, executable } = await mounted(body)
        try {
            await emulator.run(10000)
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abcXYZ')
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                3n,
                1n,
                3n,
                1n,
                6n,
                0x5a5958636261n,
                1n
            ])
            if (NATIVE)
                expect(runNatively(executable).results).toEqual(quadwords(Uint8Array.from(bytes)))
        } finally {
            emulator.dispose()
        }
    })

    it('suppresses append for RWF_NOAPPEND and restores shared flags and errno after success and failure', async () => {
        // RWF_NOAPPEND is a newer Linux flag, unavailable on some native reference kernels.
        const { emulator, session, bytes } = await mounted([
            'sys 2,path,1090,438',
            'mov r12,rax',
            'sys 1,r12,payload,6',
            'sys 32,r12',
            'mov r13,rax',
            'sys 8,r12,2,0',
            'sys 328,r12,iov,1,1,0,0x20',
            'save',
            'sys 8,r13,0,1',
            'save',
            'sys 72,r13,3',
            'and eax,1024',
            'save',
            'lea rax,[rel payload+4]',
            'mov [iov],rax',
            'sys 328,r13,iov,1,-1,0,0x20',
            'save',
            'sys 8,r12,0,1',
            'save',
            'sys 328,r12,iov,1,17825792,0,0x20',
            'save',
            'sys 72,r12,3',
            'and eax,1024',
            'save',
            'sys 72,r13,3',
            'and eax,1024',
            'save',
            'sys 8,r13,0,1',
            'save',
            'sys 1,r13,payload+5,1',
            'save',
            'sys 8,r12,0,1',
            'save',
            'sys 17,r12,buf,7,0',
            'save',
            'saveq buf',
            'finish',
            'section .data',
            'iov: dq payload+3,1',
            ...PATHS
        ])
        try {
            await emulator.run(10000)
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('aXYXYZZ')
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                1n,
                2n,
                1024n,
                1n,
                3n,
                -27n,
                1024n,
                1024n,
                3n,
                1n,
                7n,
                7n,
                0x5a5a5958595861n
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('keeps renamed and unlinked open Files usable for fstat, pwrite and ftruncate, matching Linux', async () => {
        const body = [
            'sys 2,path,66,438',
            'mov r12,rax',
            'sys 1,r12,payload,3',
            'sys 82,path,other',
            'save',
            'sys 4,path,buf2',
            'save',
            'sys 87,other',
            'save',
            'sys 5,r12,buf2',
            'save',
            'saveq buf2+16',
            'saveq buf2+48',
            'sys 18,r12,payload+3,3,1',
            'save',
            'sys 77,r12,2',
            'save',
            'sys 17,r12,buf,8,0',
            'save',
            'saveq buf',
            'sys 3,r12',
            'save',
            'finish',
            ...PATHS
        ]
        const { emulator, session, bytes, executable } = await mounted(body)
        try {
            await emulator.run(10000)
            expect(session.files.size).toBe(0)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                0n,
                -2n,
                0n,
                0n,
                0n,
                3n,
                3n,
                0n,
                2n,
                0x5861n,
                0n
            ])
            if (NATIVE)
                expect(runNatively(executable).results).toEqual(quadwords(Uint8Array.from(bytes)))
        } finally {
            emulator.dispose()
        }
    })

    it('writes sparse bytes and rejects content capacity only when writing beyond it', async () => {
        const { emulator, session, bytes } = await mounted([
            'sys 2,path,66,438',
            'mov r12,rax',
            'sys 8,r12,5,0',
            'save',
            'sys 1,r12,payload,1',
            'save',
            'sys 17,r12,buf,8,0',
            'save',
            'saveq buf',
            'sys 8,r12,16777217,0',
            'save',
            'sys 1,r12,payload,1',
            'save',
            'sys 8,r12,0,1',
            'save',
            'finish',
            ...PATHS
        ])
        try {
            await emulator.run(10000)
            expect([...session.files.get('data.txt')!]).toEqual([0, 0, 0, 0, 0, 97])
            expect(quadwords(Uint8Array.from(bytes))).toEqual([
                5n,
                1n,
                6n,
                97n << 40n,
                16777217n,
                -27n,
                16777217n
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('coalesces callbacks of sendfile under one exact serial even without native history', async () => {
        const initial = new Session()
        initial.files.set('data.txt', new Uint8Array(20000).fill(65))
        const { emulator, session } = await mounted(
            [
                'sys 2,path,0,0',
                'mov r12,rax',
                'sys 2,other,66,438',
                'mov r13,rax',
                'sys 40,r13,r12,0,20000',
                'finish',
                ...PATHS
            ],
            initial,
            0
        )
        try {
            await emulator.run(10000)
            expect(session.files.get('renamed.txt')).toEqual(session.files.get('data.txt'))
            const writes = session.effects.filter((e) => e.operation === 'pwrite')
            expect(writes).toHaveLength(2)
            expect(writes[0].serial).toBe(writes[1].serial)
            expect(writes[0].serial).toMatch(/^\d+$/)
            expect(emulator.getUndoDepth()).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('preserves Files on EMFILE failed create and truncate and maps capacity failures', async () => {
        const session = new Session()
        session.files.set('data.txt', new TextEncoder().encode('original'))
        session.maxOpen = 0
        const { emulator, bytes } = await mounted(
            ['sys 2,path,514,438', 'save', 'sys 2,other,66,438', 'save', 'finish', ...PATHS],
            session
        )
        try {
            await emulator.run(10000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-24n, -24n])
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('original')
            expect(session.files.has('renamed.txt')).toBe(false)
            expect(session.handles.size).toBe(0)
            expect(session.effects).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it('returns truthful implicit-directory getdents types and rejects unsupported metadata operations', async () => {
        const session = new Session()
        session.files.set('data.txt', new Uint8Array([97]))
        session.files.set('folder/nested.txt', new Uint8Array([98]))
        const { emulator, bytes } = await mounted(
            [
                'sys 2,directory,65536,0',
                'mov r12,rax',
                'sys 217,r12,buf,4096',
                'mov r13,rax',
                'sys 1,2,buf,r13',
                'sys 83,other,511',
                'save',
                'sys 90,path,0',
                'save',
                'finish',
                ...PATHS
            ],
            session
        )
        try {
            await emulator.run(10000)
            const entries: { name: string; type: number }[] = []
            let position = 0
            const data = Uint8Array.from(bytes)
            while (position + 19 < data.length - 16) {
                const view = new DataView(data.buffer)
                const length = view.getUint16(position + 16, true)
                const nameEnd = data.indexOf(0, position + 19)
                entries.push({
                    name: new TextDecoder().decode(data.subarray(position + 19, nameEnd)),
                    type: data[position + 18]
                })
                position += length
            }
            expect(entries).toEqual([
                { name: '.', type: 4 },
                { name: '..', type: 4 },
                { name: 'data.txt', type: 8 },
                { name: 'folder', type: 4 }
            ])
            expect(quadwords(data.subarray(position))).toEqual([-95n, -95n])
        } finally {
            emulator.dispose()
        }
    })

    it('surfaces partial host failure with its original message, clean native state and an Undo barrier', async () => {
        const session = new Session()
        const write = session.pwrite.bind(session)
        session.pwrite = (...args) => {
            write(...args)
            throw new Error('store failed after its write')
        }
        const { emulator } = await mounted(
            [
                'sys 2,path,66,438',
                'mov r12,rax',
                'sys 1,r12,payload,3',
                'mov r14,123',
                'finish',
                ...PATHS
            ],
            session
        )
        try {
            await expect(emulator.run(10000)).rejects.toThrow('store failed after its write')
            expect(emulator.stopReason).toMatchObject({ kind: 'host-error' })
            expect(emulator.getCurrentInstructionSerial()).toBeNull()
            expect(new TextDecoder().decode(session.files.get('data.txt'))).toBe('abc')
            expect(emulator.getRegisterValue('r14')).toBe(0n)
            expect(emulator.canUndo()).toBe(false)
            expect(() => emulator.undo()).toThrow('cannot be undone')
            session.ended = true
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.mountProjectFileSystem(new Session())
            await emulator.run(100)
            expect(emulator.stopReason?.kind).toBe('exit')
        } finally {
            emulator.dispose()
        }
    })
})
