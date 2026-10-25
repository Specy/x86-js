import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    readResourceBytes,
    RESOURCE_STALL_TIMEOUT_MS,
    ResourceDownloadError
} from '../src/resources'
import type { X86Progress } from '../src/types'

const LIBRARY_URL = 'https://assets.test/assets/linux/libstdc%2B%2B.so.6'

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

/** A response whose body sends `chunks`, each after the delay before it, and then ends or stalls. */
function trickle(chunks: { after: number; bytes: number[] }[], end: 'close' | 'stall') {
    return new Response(
        new ReadableStream<Uint8Array>({
            async start(controller) {
                for (const chunk of chunks) {
                    await new Promise((resolve) => setTimeout(resolve, chunk.after))
                    controller.enqueue(Uint8Array.from(chunk.bytes))
                }
                if (end === 'close') controller.close()
            }
        })
    )
}

/** Settles `promise` as far as the fake clock lets it, and says how it settled, if it did. */
function observe<T>(promise: Promise<T>) {
    const seen: { value?: T; error?: unknown; settled: boolean } = { settled: false }
    promise.then(
        (value) => Object.assign(seen, { value, settled: true }),
        (error: unknown) => Object.assign(seen, { error, settled: true })
    )
    return seen
}

describe('a download', () => {
    it('ends when no response comes for 20 s, naming the resource', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined))
        const read = observe(readResourceBytes(LIBRARY_URL, { name: 'libstdc++.so.6' }))
        await vi.advanceTimersByTimeAsync(RESOURCE_STALL_TIMEOUT_MS - 1)
        expect(read.settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(read.error).toBeInstanceOf(ResourceDownloadError)
        expect(read.error).toMatchObject({
            message: 'Could not download libstdc++.so.6: no data for 20 s',
            resource: 'libstdc++.so.6'
        })
    })

    it('ends when its body stops for 20 s, and aborts the request', async () => {
        vi.useFakeTimers()
        let signal: AbortSignal | undefined
        vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
            signal = init.signal ?? undefined
            return trickle([{ after: 5_000, bytes: [1, 2] }], 'stall')
        })
        const read = observe(readResourceBytes(LIBRARY_URL, { name: 'libstdc++.so.6' }))
        //the 20 s count from the last bytes, not from the start
        await vi.advanceTimersByTimeAsync(5_000 + RESOURCE_STALL_TIMEOUT_MS - 1)
        expect(read.settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect((read.error as Error).message).toBe(
            'Could not download libstdc++.so.6: no data for 20 s'
        )
        expect(signal?.aborted).toBe(true)
    })

    it('goes on for as long as bytes keep coming, however long it takes', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('fetch', async () =>
            trickle(
                [
                    { after: 15_000, bytes: [1] },
                    { after: 15_000, bytes: [2, 3] },
                    { after: 15_000, bytes: [4] }
                ],
                'close'
            )
        )
        const read = observe(readResourceBytes(LIBRARY_URL))
        await vi.advanceTimersByTimeAsync(45_000)
        expect(read.error).toBeUndefined()
        expect(read.value).toEqual(Uint8Array.from([1, 2, 3, 4]))
    })

    it("names the resource with the network's error, or the server's status", async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('Failed to fetch')
        })
        const failed = readResourceBytes(LIBRARY_URL, { name: 'libstdc++.so.6' })
        await expect(failed).rejects.toThrow('Could not download libstdc++.so.6: Failed to fetch')
        await expect(failed).rejects.toMatchObject({
            cause: expect.any(TypeError),
            status: undefined
        })

        vi.stubGlobal('fetch', async () => new Response('', { status: 404, statusText: 'Not Found' }))
        //without a name, the URL's last part names it
        const refused = readResourceBytes(LIBRARY_URL)
        await expect(refused).rejects.toThrow('Could not download libstdc++.so.6: 404 Not Found')
        //the status says it was the server, which a retry on the same URL will not change
        await expect(refused).rejects.toMatchObject({ status: 404 })
    })
})

/** The Core's modules with `readResourceBytes` failing for the resources `failing` names. */
async function withFailingDownloads(failing: Set<string>) {
    const reads: string[] = []
    vi.resetModules()
    vi.doMock('../src/resources', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../src/resources')>()
        return {
            ...actual,
            readResourceBytes: async (
                source: Parameters<typeof actual.readResourceBytes>[0],
                options: Parameters<typeof actual.readResourceBytes>[1] = {}
            ) => {
                const name = options.name ?? String(source)
                reads.push(name)
                if (failing.has(name))
                    throw new actual.ResourceDownloadError(name, 'no data for 20 s')
                return actual.readResourceBytes(source, options)
            }
        }
    })
    return reads
}

/** The Core's modules with the downloads `held` names waiting until their release is called. */
async function withHeldDownloads(held: Set<string>) {
    const waiting = new Map<string, () => void>()
    vi.resetModules()
    vi.doMock('../src/resources', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../src/resources')>()
        return {
            ...actual,
            readResourceBytes: async (
                source: Parameters<typeof actual.readResourceBytes>[0],
                options: Parameters<typeof actual.readResourceBytes>[1] = {}
            ) => {
                const name = options.name ?? String(source)
                if (held.has(name)) await new Promise<void>((resolve) => waiting.set(name, resolve))
                return actual.readResourceBytes(source, options)
            }
        }
    })
    return waiting
}

describe("a build's tools", () => {
    //the same unmock as 'a failed download', for the same reason
    afterEach(async () => {
        vi.doUnmock('../src/resources')
        await import('../src/resources')
        vi.resetModules()
    })

    const nasmProject = {
        entry: 'main.asm',
        files: { 'main.asm': 'global _start\nsection .text\n_start: nop' }
    }
    const gnuProject = {
        entry: 'main.s',
        files: { 'main.s': '.globl _start\n.text\n_start: nop' }
    }

    it('download when a build first needs them, not when a runtime is made or checks', async () => {
        const failing = new Set(['the linker'])
        const reads = await withFailingDownloads(failing)
        const { createX86Emulator } = await import('../src/x86-emulator')
        const emulators = [
            await createX86Emulator(),
            await createX86Emulator({ mode: 'GNU_trunk' }),
            await createX86Emulator({ mode: 'FASM_trunk' })
        ]
        const [nasm, gnu] = emulators
        const broken = { entry: 'main.asm', files: { 'main.asm': 'mov rax, nope nonsense' } }
        try {
            expect(reads).toEqual([])

            //checking never links, so it never needs the linker, whichever assembler checks
            expect(await nasm!.checkProject(nasmProject)).toEqual([])
            expect(await gnu!.checkProject(gnuProject)).toEqual([])
            expect(reads).not.toContain('the linker')
            //with NASM, a program that does not assemble has nothing to link either
            expect((await nasm!.compileProject(broken)).ok).toBe(false)
            expect(reads).not.toContain('the linker')

            //the first build that links downloads it, and one that failed to is downloaded again
            await expect(gnu!.compileProject(gnuProject)).rejects.toThrow(
                'Could not download the linker: no data for 20 s'
            )
            failing.clear()
            const progress: X86Progress[] = []
            const onProgress = (event: X86Progress) => progress.push(event)
            expect((await gnu!.compileProject(gnuProject, { onProgress })).ok).toBe(true)
            //GNU as came with the check; the link starts as it exits, so ld comes before it runs
            expect(progress).toEqual([
                { phase: 'download', resource: 'the linker' },
                { phase: 'assemble' },
                { phase: 'link' }
            ])

            //the modes that link with GNU ld share the download
            progress.length = 0
            expect((await nasm!.compileProject(nasmProject, { onProgress })).ok).toBe(true)
            expect(progress).toEqual([{ phase: 'assemble' }, { phase: 'link' }])
            expect(reads.filter((name) => name === 'the linker')).toHaveLength(2)
        } finally {
            for (const emulator of emulators) emulator.dispose()
        }
    })

    it('let a superseding build assemble from its own directory', async () => {
        const held = new Set<string>()
        const waiting = await withHeldDownloads(held)
        const { createX86Emulator } = await import('../src/x86-emulator')
        const nasm = await createX86Emulator()
        const gnu = await createX86Emulator({ mode: 'GNU_trunk' })
        //resolved from the Entry's directory, which the build enters when it stages the Project
        const including = {
            entry: 'main.s',
            files: { 'main.s': '.include "lib.s"\n' + gnuProject.files['main.s'], 'lib.s': '' }
        }
        try {
            expect((await nasm.compileProject(nasmProject)).ok).toBe(true)
            const program = nasm.getExecutable()!

            held.add('the assembler')
            const superseded = gnu.compileProject(including)
            await vi.waitFor(() => expect(waiting.has('the assembler')).toBe(true))
            gnu.loadElf(program)
            const current = gnu.compileProject(including)
            waiting.get('the assembler')!()

            await expect(superseded).rejects.toThrow('This build was superseded')
            const result = await current
            expect(result.diagnostics).toEqual([])
            expect(result.ok).toBe(true)
        } finally {
            nasm.dispose()
            gnu.dispose()
        }
    })

    it('keep their mode while a build waits on one', async () => {
        const waiting = await withHeldDownloads(new Set(['the assembler']))
        const { createX86Emulator } = await import('../src/x86-emulator')
        const gnu = await createX86Emulator({ mode: 'GNU_trunk' })
        try {
            const build = gnu.compileProject(gnuProject)
            await vi.waitFor(() => expect(waiting.has('the assembler')).toBe(true))
            await expect(gnu.setMode('NASM_trunk')).rejects.toThrow(
                'Cannot change the assembler while emulator is ASSEMBLING'
            )
            waiting.get('the assembler')!()
            expect((await build).ok).toBe(true)
        } finally {
            gnu.dispose()
        }
    })
})

describe('a failed download', () => {
    //the unmock waits for the next import, as the mock does: made there, it would race the next
    //test's mock at that import and could undo it, so it is made now
    afterEach(async () => {
        vi.doUnmock('../src/resources')
        await import('../src/resources')
        vi.resetModules()
    })

    it("ends a load, and the next load of the library downloads it again", async () => {
        const failing = new Set(['libc.so.6'])
        const reads = await withFailingDownloads(failing)
        const { createX86Emulator } = await import('../src/x86-emulator')
        const program = await readFile(new URL('./fixtures/elf/crackme', import.meta.url))
        const emulator = await createX86Emulator()
        try {
            const progress: X86Progress[] = []
            const onProgress = (event: X86Progress) => progress.push(event)
            await expect(emulator.loadExecutable(program, { onProgress })).rejects.toThrow(
                'Could not download libc.so.6: no data for 20 s'
            )
            expect(progress).toEqual([
                { phase: 'download', resource: 'ld-linux-x86-64.so.2' },
                { phase: 'download', resource: 'libc.so.6' }
            ])

            failing.clear()
            progress.length = 0
            await emulator.loadExecutable(program, { onProgress })
            expect(reads.filter((name) => name === 'libc.so.6')).toHaveLength(2)
            //the interpreter came the first time and is kept
            expect(reads.filter((name) => name === 'ld-linux-x86-64.so.2')).toHaveLength(1)
            expect(progress).toEqual([
                { phase: 'download', resource: 'libc.so.6' },
                { phase: 'load' }
            ])

            progress.length = 0
            await emulator.loadExecutable(program, { onProgress })
            expect(progress).toEqual([{ phase: 'load' }])
        } finally {
            emulator.dispose()
        }
    })

    it('ends a build, which the next build downloads again and completes', async () => {
        const failing = new Set(['the assembler'])
        const reads = await withFailingDownloads(failing)
        const { createX86Emulator } = await import('../src/x86-emulator')
        const emulator = await createX86Emulator()
        const project = {
            entry: 'main.asm',
            files: { 'main.asm': 'global _start\nsection .text\n_start: nop' }
        }
        try {
            const progress: X86Progress[] = []
            const onProgress = (event: X86Progress) => progress.push(event)
            await expect(emulator.compileProject(project, { onProgress })).rejects.toThrow(
                'Could not download the assembler: no data for 20 s'
            )
            expect(progress).toEqual([{ phase: 'download', resource: 'the assembler' }])

            //the failed build leaves the runtime ready for the next
            failing.clear()
            progress.length = 0
            expect((await emulator.compileProject(project, { onProgress })).ok).toBe(true)
            expect(reads.filter((name) => name === 'the assembler')).toHaveLength(2)
            expect(progress).toEqual([
                { phase: 'download', resource: 'the assembler' },
                { phase: 'assemble' },
                { phase: 'download', resource: 'the linker' },
                { phase: 'link' }
            ])

            progress.length = 0
            expect((await emulator.compileProject(project, { onProgress })).ok).toBe(true)
            expect(progress).toEqual([{ phase: 'assemble' }, { phase: 'link' }])
        } finally {
            emulator.dispose()
        }
    })
})
