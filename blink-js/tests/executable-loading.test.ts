import { expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { X86_PROGRAM_ENVIRONMENT } from '../src/linux-runtime'
import { elfFixture, swappedLoadsFixture } from './elf-fixtures'

it('preserves UTF-8, empty and spaced words and supplies the fixed environment', async () => {
    const emulator = await createX86Emulator()
    try {
        await emulator.loadExecutable(elfFixture('argv-env'))
        const words = ['./argv-env', '', 'two words', 'café 猫', 'a'.repeat(500)]
        emulator.setProgramArguments(words[0], words.slice(1))
        let output = ''
        emulator.on('stdout', (bytes) => {
            output += new TextDecoder().decode(bytes)
        })
        emulator.initialize(0)
        await emulator.run(1_000_000)
        expect(output).toBe(
            words.map((word, i) => `argv[${i}]=${word}\n`).join('') +
                X86_PROGRAM_ENVIRONMENT.map((word, i) => `env[${i}]=${word}\n`).join('')
        )
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
    } finally {
        emulator.dispose()
    }
})

it('validates Arguments and clears stale assembly when loading an Executable', async () => {
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.compile('global _start\nsection .text\n_start: nop')).ok).toBe(true)
        expect(emulator.getCompiledCode().code).not.toBe('')
        await emulator.loadExecutable(elfFixture('crackme'))
        expect(emulator.getCompiledCode().code).toBe('')
        expect(emulator.getMemoryLayout().sections).toContain('.data')
        expect(emulator.resolveMemoryLabel('main')).toBeDefined()
        expect(() => emulator.setProgramArguments('a', ['bad\0word'])).toThrow(/NUL/)
        expect(() => emulator.setProgramArguments('a', Array(1025).fill(''))).toThrow(/1,024/)
        expect(() => emulator.setProgramArguments('a', ['a'.repeat(128 * 1024)])).toThrow(/128 KiB/)
        expect(() => emulator.setProtectedPath('/tmp/program')).toThrow(/project/)
    } finally {
        emulator.dispose()
    }
})

it('follows C++ dependencies and retains libraries after a fresh start', async () => {
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.loadExecutable(elfFixture('cpp'))).missing).toEqual([])
        let output = ''
        emulator.on('stdout', (bytes) => {
            output += new TextDecoder().decode(bytes)
        })
        emulator.initialize(0)
        for (let run = 0; run < 2; ++run) {
            if (run) emulator.runtime.pauseAtEntry()
            emulator.initialize(0)
            await emulator.run(2_000_000)
            expect(emulator.stopReason, `run ${run}, output ${output}`).toMatchObject({
                kind: 'exit',
                exitCode: 0
            })
        }
        expect(output).toBe('hello\nC++\ncaught exception\n'.repeat(2))
    } finally {
        emulator.dispose()
    }
})

it('reports a missing library and preserves the dynamic linker message', async () => {
    const bytes = elfFixture('crackme').slice()
    const name = new TextEncoder().encode('libc.so.6')
    const offset = bytes.findIndex((_, i) => name.every((byte, j) => bytes[i + j] === byte))
    expect(offset).toBeGreaterThan(0)
    bytes.set(new TextEncoder().encode('libx.so.6'), offset)
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.loadExecutable(bytes)).missing).toEqual(['libx.so.6'])
        let stderr = ''
        emulator.on('stderr', (bytes) => {
            stderr += new TextDecoder().decode(bytes)
        })
        emulator.initialize(0)
        await emulator.run(1_000_000)
        expect(stderr).toContain('libx.so.6')
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 127 })
    } finally {
        emulator.dispose()
    }
})

it("copies a caller's Node Buffer, and hands out library bytes nobody else shares", async () => {
    const buffer = Buffer.from(elfFixture('crackme'))
    const first = await createX86Emulator()
    const second = await createX86Emulator()
    try {
        await first.loadExecutable(buffer)
        // Buffer#slice aliases: the program must not change with the caller's Buffer.
        buffer.fill(0)
        expect(first.getExecutable()![0]).toBe(0x7f)
        first.initialize(0)
        first.provideInput('hunter2\n')
        await first.run(2_000_000)
        expect(first.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
        // Mutating libc as handed out must not reach the module-wide cache another emulator loads.
        const libc = first.getLoadedObjects().find((object) => object.soname === 'libc.so.6')!
        const bytes = first.getLoadedObjectBytes(libc.path)!
        expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype)
        bytes.fill(0)
        expect(first.getLoadedObjectBytes(libc.path)![0]).toBe(0x7f)
        await second.loadExecutable(elfFixture('crackme'))
        second.initialize(0)
        second.provideInput('hunter2\n')
        let output = ''
        second.on('stdout', (chunk) => {
            output += new TextDecoder().decode(chunk)
        })
        await second.run(2_000_000)
        expect(output).toBe('Enter password: Correct!\n')
    } finally {
        first.dispose()
        second.dispose()
    }
})

it('names the main program among the loaded objects', async () => {
    const emulator = await createX86Emulator()
    try {
        await emulator.loadExecutable(elfFixture('crackme'))
        emulator.initialize(0)
        // Stopped in main, reading the password: every library is mapped.
        await emulator.run(2_000_000)
        expect(emulator.stopReason?.kind).toBe('input')
        const objects = emulator.getLoadedObjects()
        expect(objects.filter((object) => object.main)).toEqual([
            expect.objectContaining({ path: '/program', base: 0x555555554000n, main: true })
        ])
        expect(objects.filter((object) => !object.main).map((object) => object.soname)).toEqual(
            expect.arrayContaining(['libc.so.6', 'ld-linux-x86-64.so.2'])
        )
    } finally {
        emulator.dispose()
    }
})

it('lets the latest of overlapping loads win, and fails the superseded one', async () => {
    const emulator = await createX86Emulator()
    try {
        const cpp = emulator.loadExecutable(elfFixture('cpp'))
        const crackme = emulator.loadExecutable(elfFixture('crackme'))
        const [first, second] = await Promise.allSettled([cpp, crackme])
        expect(first).toMatchObject({ status: 'rejected' })
        expect(String((first as PromiseRejectedResult).reason)).toMatch(/superseded/)
        expect(second).toMatchObject({ status: 'fulfilled' })
        expect(emulator.getExecutable()).toEqual(elfFixture('crackme'))
        // A build started while a load fetches its libraries supersedes it too.
        const superseded = expect(emulator.loadExecutable(elfFixture('math'))).rejects.toThrow(
            /superseded/
        )
        expect((await emulator.compile('global _start\nsection .text\n_start: nop')).ok).toBe(true)
        await superseded
        expect(emulator.getCompiledCode().code).toContain('_start')
    } finally {
        emulator.dispose()
    }
})

it('lets a load started during a build win, and fails the superseded build', async () => {
    const emulator = await createX86Emulator()
    try {
        const build = emulator.compile('global _start\nsection .text\n_start: nop')
        const settled = Promise.allSettled([build])
        await emulator.loadExecutable(elfFixture('crackme'))
        const [result] = await settled
        expect(result).toMatchObject({ status: 'rejected' })
        expect(String((result as PromiseRejectedResult).reason)).toMatch(
            /This build was superseded/
        )
        expect(emulator.getExecutable()).toEqual(elfFixture('crackme'))
        expect(emulator.getCompiledCode().code).toBe('')
        emulator.initialize(0)
        await emulator.run(2_000_000)
        expect(emulator.stopReason?.kind).toBe('input')
    } finally {
        emulator.dispose()
    }
})

it('lets a load or build refused by its own checks leave one in flight alone', async () => {
    const emulator = await createX86Emulator()
    try {
        const crackme = emulator.loadExecutable(elfFixture('crackme'))
        await expect(
            emulator.loadExecutable(elfFixture('cpp'), { protectedPath: '/tmp/cpp' })
        ).rejects.toThrow(/project/)
        await expect(
            emulator.loadExecutable(elfFixture('cpp'), { arguments: ['bad\0word'] })
        ).rejects.toThrow(/NUL/)
        await expect(emulator.loadExecutable(new Uint8Array(16))).rejects.toThrow()
        await expect(emulator.compileProject({ entry: 'missing.asm', files: {} })).rejects.toThrow(
            /not found/
        )
        await crackme
        expect(emulator.getExecutable()).toEqual(elfFixture('crackme'))
    } finally {
        emulator.dispose()
    }
})

it("reports why Blink's loader refused a program, with exit status 127", async () => {
    const emulator = await createX86Emulator()
    try {
        await expect(emulator.loadExecutable(swappedLoadsFixture())).rejects.toThrow(
            'an ELF program whose load segments are out of address order'
        )
        // loadElf takes the bytes as they are, and the loader ends the process with exit(127).
        emulator.loadElf(swappedLoadsFixture())
        emulator.initialize(0)
        await emulator.run(1_000_000)
        expect(emulator.stopReason).toMatchObject({
            kind: 'load-fail',
            exitCode: 127,
            details:
                "The emulator could not load the program: program headers aren't ordered, expected 555555556000 >= 555555557000 (native exit 127)"
        })
        await emulator.loadExecutable(elfFixture('crackme'))
        emulator.initialize(0)
        await emulator.run(2_000_000)
        expect(emulator.stopReason?.kind).toBe('input')
    } finally {
        emulator.dispose()
    }
})

it('refuses an invalid protected path before replacing the program', async () => {
    const emulator = await createX86Emulator()
    try {
        await emulator.loadExecutable(elfFixture('crackme'))
        await expect(
            emulator.loadExecutable(elfFixture('cpp'), { protectedPath: '/tmp/cpp' })
        ).rejects.toThrow(/project/)
        expect(emulator.getExecutable()).toEqual(elfFixture('crackme'))
        await emulator.loadExecutable(elfFixture('cpp'), { protectedPath: '/project/./cpp' }).then(
            () => {
                throw new Error('a dot segment is not a protected path')
            },
            (error: Error) => expect(error.message).toMatch(/project/)
        )
        expect(emulator.getExecutable()).toEqual(elfFixture('crackme'))
    } finally {
        emulator.dispose()
    }
})

it('accepts an empty environment from the native argument API', async () => {
    const emulator = await createX86Emulator()
    try {
        expect(emulator.module.blinkenlibSetProgramArguments(['./x'], [])).toBe(true)
        expect(emulator.module.blinkenlibSetProgramArguments([], [])).toBe(true)
    } finally {
        emulator.dispose()
    }
})

it('keeps running a program whose unimplementedSyscall listener throws', async () => {
    const emulator = await createX86Emulator()
    const deferred: (() => void)[] = []
    const realSetTimeout = globalThis.setTimeout
    try {
        emulator.on('unimplementedSyscall', () => {
            throw new Error('listener failed')
        })
        const source =
            'global _start\nsection .text\n_start:\nmov eax,309\nsyscall\nmov rdi,rax\nneg rdi\nmov eax,60\nsyscall'
        expect((await emulator.compile(source)).ok).toBe(true)
        emulator.initialize(0)
        // The hook rethrows on a task of its own; catch that task here instead of in vitest.
        globalThis.setTimeout = ((callback: () => void, delay?: number) => {
            if (!delay) {
                deferred.push(callback)
                return 0 as unknown as ReturnType<typeof setTimeout>
            }
            return realSetTimeout(callback, delay)
        }) as typeof setTimeout
        await emulator.run(1000)
        globalThis.setTimeout = realSetTimeout
        // ENOSYS reached the program, which exited with it.
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 38 })
        expect(() => deferred.forEach((callback) => callback())).toThrow('listener failed')
    } finally {
        globalThis.setTimeout = realSetTimeout
        emulator.dispose()
    }
})

it('turns a native exit inside an instruction into a stop and starts afresh', async () => {
    const emulator = await createX86Emulator()
    const exitCode = process.exitCode
    try {
        const source =
            'global _start\nsection .text\n_start:\nnop\nnop\nmov eax,60\nmov edi,4\nsyscall'
        expect((await emulator.compile(source)).ok).toBe(true)
        emulator.initialize(10)
        await emulator.step()
        const step = emulator.module._blinkenlib_stepi
        // What Emscripten throws out of the wasm for a native exit(250).
        emulator.module._blinkenlib_stepi = () => {
            emulator.module._blinkenlib_stepi = step
            step.call(emulator.module)
            throw Object.assign(new Error('Program terminated with exit(250)'), {
                name: 'ExitStatus',
                status: 250
            })
        }
        await emulator.step()
        expect(emulator.stopReason).toMatchObject({ kind: 'host-error', exitCode: 250 })
        expect(emulator.hasTerminated()).toBe(true)
        expect(process.exitCode).toBe(exitCode)
        emulator.clearExecution()
        expect((await emulator.compile(source)).ok).toBe(true)
        emulator.initialize(10)
        await emulator.run(1000)
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 4 })
    } finally {
        emulator.dispose()
    }
})

it("resolves an assembled program's labels by their exact names, @ included", async () => {
    const emulator = await createX86Emulator()
    try {
        const source = [
            'global _start',
            'section .text',
            '_start:',
            'foo@bar: nop',
            'foo@@GLIBC_2.2.5: nop',
            'section .data',
            'data@v1: dq 0'
        ].join('\n')
        expect((await emulator.compile(source)).ok).toBe(true)
        const start = emulator.resolveMemoryLabel('_start')!
        expect(emulator.resolveMemoryLabel('foo@bar')).toBe(start)
        expect(emulator.resolveMemoryLabel('foo@@GLIBC_2.2.5')).toBe(start + 1n)
        expect(emulator.resolveMemoryLabel('foo')).toBeUndefined()
        expect(emulator.resolveMemoryLabel('data@v1')).toBeDefined()
    } finally {
        emulator.dispose()
    }
})
