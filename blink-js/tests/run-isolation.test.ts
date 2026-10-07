// Every start of a program is a fresh process on a fresh file system: what one run opened,
// closed, created, removed or was given as input is not there for the next, whether it is the
// same build started again or the next build. The toolchain's files are never there at all.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { X86_WORKING_DIRECTORY } from '../src/file-system'
import type { X86Input } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { probeSource, quadwords } from './linux-probe'

const ENOENT = -2

type Run = { results: bigint[]; stdout: string; requests: number }

/**
 * Runs the program built last from its start to its end, answering each read that waits with
 * the next of `answers`.
 */
async function runOnce(emulator: X86Emulator, answers: X86Input[] = []): Promise<Run> {
    const pending = [...answers]
    const stderr: number[] = []
    let stdout = ''
    let requests = 0
    const stops = [
        emulator.on('stderr', (bytes) => void stderr.push(...bytes)),
        emulator.on('stdout', (bytes) => void (stdout += String.fromCharCode(...bytes))),
        emulator.on('inputRequest', () => void (requests += 1)),
    ]
    try {
        // a new run, whether or not the last one ended
        emulator.runtime.starti()
        for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice += 1) {
            if ((await emulator.run(1_000_000)) !== EmulatorStatus.WaitingForInput) continue
            const answer = pending.shift()
            if (answer === undefined) throw new Error('a read waited for input nobody planned to give')
            emulator.provideInput(answer)
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return { results: quadwords(Uint8Array.from(stderr)), stdout, requests }
    } finally {
        for (const stop of stops) stop()
    }
}

async function build(emulator: X86Emulator, body: readonly string[]): Promise<void> {
    const result = await emulator.compile(probeSource(body))
    expect(result.ok, result.report).toBe(true)
}

/** Runs `body` twice in one build, then builds it again and runs it once more. */
async function threeRuns(body: readonly string[]): Promise<Run[]> {
    const emulator = await createX86Emulator()
    try {
        await build(emulator, body)
        const runs = [await runOnce(emulator), await runOnce(emulator)]
        await build(emulator, body)
        runs.push(await runOnce(emulator))
        return runs
    } finally {
        emulator.dispose()
    }
}

/** NUL-terminated strings at the end of the program, after `finish`. */
function strings(entries: Record<string, string>): string[] {
    const bytes = (text: string) => [...new TextEncoder().encode(text), 0].join(', ')
    return ['section .data', ...Object.entries(entries).map(([label, text]) => `${label}: db ${bytes(text)}`)]
}

describe('a run', () => {
    it('finds no descriptor an earlier run left open, so the first open is 3 every time', async () => {
        const runs = await threeRuns([
            'sys 2, file, 0x41, 420', 'save', // creat, never closed
            'sys 2, file, 0, 0', 'save',
            'finish',
            ...strings({ file: '/tmp/left-open' }),
        ])
        for (const run of runs) expect(run.results).toEqual([3n, 4n])
    })

    it('starts with 0, 1 and 2 the terminal, whatever the run before it closed', async () => {
        const runs = await threeRuns([
            'sys 72, 1, 1', 'save', // F_GETFD: open
            'sys 1, 1, ok, 3', 'save',
            'sys 3, 1', 'save',
            'sys 3, 0', 'save',
            'sys 2, file, 0x41, 420', 'save', // takes the lowest free number
            'finish',
            ...strings({ ok: 'ok\n', file: '/tmp/out' }),
        ])
        for (const run of runs) {
            expect(run.results).toEqual([0n, 3n, 0n, 0n, 0n])
            expect(run.stdout).toBe('ok\n')
        }
    })

    it('finds none of the files an earlier run made, wherever it made them', async () => {
        const created = ['/tmp/scratch', 'note', '/top', '/dev/shm/tmp/shared', '/proc/self/made']
        const labels = created.map((_, index) => `path${index}`)
        const runs = await threeRuns([
            ...labels.flatMap((label) => [`sys 21, ${label}, 0`, 'save']), // access(F_OK)
            ...labels.flatMap((label) => [`sys 2, ${label}, 0x41, 420`, 'save', 'mov r12, rax', 'sys 3, r12']),
            'sys 83, dir, 448', 'save', // mkdir
            'finish',
            ...strings({ ...Object.fromEntries(labels.map((label, index) => [label, created[index]!])), dir: '/made' }),
        ])
        for (const run of runs) {
            expect(run.results).toEqual([...created.map(() => BigInt(ENOENT)), ...created.map(() => 3n), 0n])
        }
    })

    it('finds /dev and /tmp as the module started with them, whatever the run before it did to them', async () => {
        const runs = await threeRuns([
            'sys 21, tmp, 2', 'save', // access(W_OK)
            'sys 2, null, 2, 0', 'save', 'mov r12, rax', 'sys 3, r12',
            'sys 87, null', 'save', // unlink
            'sys 90, tmp, 0', 'save', // chmod
            'sys 90, root, 0', 'save',
            'finish',
            ...strings({ tmp: '/tmp', null: '/dev/null', root: '/' }),
        ])
        for (const run of runs) expect(run.results).toEqual([0n, 3n, 0n, 0n, 0n])
    })

    it(`starts in an empty ${X86_WORKING_DIRECTORY}, wherever the run before it went`, async () => {
        const runs = await threeRuns([
            'sys 79, buf, 64', 'save', 'saveq buf',
            'sys 2, dot, 0x10000, 0', 'mov r12, rax', // O_DIRECTORY
            'sys 217, r12, buf2, 4096', 'save', // getdents64: only . and ..
            'sys 80, tmp', 'save', // chdir
            'finish',
            ...strings({ dot: '.', tmp: '/tmp' }),
        ])
        const name = new TextEncoder().encode(X86_WORKING_DIRECTORY.padEnd(8, '\0'))
        const path = new DataView(name.buffer).getBigInt64(0, true)
        for (const run of runs) expect(run.results).toEqual([BigInt(X86_WORKING_DIRECTORY.length + 1), path, 48n, 0n])
    })

    it('never sees the toolchain: not the executable, the objects, the linker or the staged Files', async () => {
        const tools = ['/program', '/program.o', '/program.a', '/linker', '/assembly.s', '/__x86_project']
        const labels = tools.map((_, index) => `tool${index}`)
        const emulator = await createX86Emulator()
        try {
            const result = await emulator.compileProject({
                entry: 'main.asm',
                files: {
                    'main.asm': probeSource([
                        ...labels.flatMap((label) => [`sys 21, ${label}, 0`, 'save']), // access(F_OK)
                        'extern helper', 'call helper', // linked from the archive, /program.a
                        'finish',
                        ...strings(Object.fromEntries(labels.map((label, index) => [label, tools[index]!]))),
                    ]),
                    'lib/helper.asm': ['global helper', 'section .text', 'helper:', '    ret'].join('\n'),
                },
            })
            expect(result.ok, result.report).toBe(true)
            expect((await runOnce(emulator)).results).toEqual(tools.map(() => BigInt(ENOENT)))
            // the executable the program never saw is the host's to read
            expect(Array.from(emulator.getExecutable()!.subarray(0, 4))).toEqual([0x7f, 0x45, 0x4c, 0x46])
        } finally {
            emulator.dispose()
        }
    })

    it('never sees an assembler that runs in blink', async () => {
        const emulator = await createX86Emulator({ mode: 'GNU_trunk' })
        try {
            const result = await emulator.compile(
                [
                    '.intel_syntax noprefix',
                    '.globl _start',
                    '.text',
                    '_start:',
                    '    mov eax, 21', // access(F_OK)
                    '    lea rdi, [rip + assembler]',
                    '    xor esi, esi',
                    '    syscall',
                    '    mov edi, eax',
                    '    mov eax, 60',
                    '    syscall',
                    '.data',
                    'assembler: .asciz "/assembler"',
                ].join('\n'),
            )
            expect(result.ok, result.report).toBe(true)
            await emulator.runUntilBlocked()
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 256 + ENOENT })
        } finally {
            emulator.dispose()
        }
    })

    it('cannot leave a file the next build would take for the linker', async () => {
        const emulator = await createX86Emulator()
        try {
            await build(emulator, [
                'sys 2, linker, 0x241, 493', 'save', 'mov r12, rax', // O_WRONLY | O_CREAT | O_TRUNC, 0755
                'sys 1, r12, linker, 4', 'save',
                'finish',
                ...strings({ linker: '/linker' }),
            ])
            expect((await runOnce(emulator)).results).toEqual([3n, 4n])
            await build(emulator, ['sys 39', 'finish'])
            expect((await runOnce(emulator)).results).toHaveLength(0)
        } finally {
            emulator.dispose()
        }
    })

    it('reads none of the input an earlier run was given and did not read', async () => {
        const emulator = await createX86Emulator()
        try {
            await build(emulator, ['sys 0, 0, buf, 1', 'save', 'saveq buf', 'finish'])
            const first = await runOnce(emulator, ['abc\n'])
            expect(first.results).toEqual([1n, 0x61n])
            const second = await runOnce(emulator, ['z\n'])
            expect(second.results).toEqual([1n, 0x7an])
            expect(second.requests).toBe(1)
        } finally {
            emulator.dispose()
        }
    })

    it('forgets the input of a run started over before it ended', async () => {
        const emulator = await createX86Emulator()
        try {
            await build(emulator, ['sys 0, 0, buf, 1', 'save', 'sys 0, 0, buf, 1', 'save', 'saveq buf', 'finish'])
            emulator.runtime.starti()
            expect(await emulator.run()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('ab\n')
            expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
            // started over with "b\n" still unread
            const run = await runOnce(emulator, ['x', 'y'])
            expect(run.results).toEqual([1n, 1n, 0x79n])
            expect(run.requests).toBe(2)
        } finally {
            emulator.dispose()
        }
    })
})
