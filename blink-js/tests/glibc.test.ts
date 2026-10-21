import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { BlinkState } from '../src/types'
import { elfFixture, fixtureEmulator } from './elf-fixtures'
import { expectCore, expectLinux, EINVAL, EPERM, ESRCH } from './linux-probe'

const EAGAIN = -11
const EFAULT = -14
const ENOSYS = -38
const ETIMEDOUT = -110

async function runFixture(name: string, args: string[] = []) {
    const emulator = await fixtureEmulator(name, args)
    const before = emulator.module.wasmExports!.memory!.buffer.byteLength
    let output = ''
    emulator.on('stdout', (bytes) => {
        output += new TextDecoder().decode(bytes)
    })
    emulator.on('stderr', (bytes) => {
        output += new TextDecoder().decode(bytes)
    })
    try {
        await emulator.run(2_000_000)
        if (emulator.stopReason?.kind === 'input') {
            await emulator.provideInput('hunter2\n')
            await emulator.run(2_000_000)
        }
        return {
            output,
            stop: emulator.stopReason,
            growth: emulator.module.wasmExports!.memory!.buffer.byteLength - before
        }
    } finally {
        emulator.dispose()
    }
}

describe('glibc executables', () => {
    for (const name of ['hello-atexit-static', 'hello-atexit-static-pie', 'hello-atexit']) {
        it(`${name} runs its exit handler and exits 3`, async () => {
            const { output, stop } = await runFixture(name)
            expect(output).toBe('hello /program argc=1\natexit handler\n')
            expect(stop).toMatchObject({ kind: 'exit', exitCode: 3 })
        })
    }
    for (const name of ['crackme-static', 'crackme-static-pie', 'crackme']) {
        it(`${name} reads input and exits cleanly`, async () => {
            const { output, stop } = await runFixture(name)
            expect(output).toBe('Enter password: Correct!\n')
            expect(stop).toMatchObject({ kind: 'exit', exitCode: 0 })
        })
    }
    // A Linux process on a tty: glibc line-buffers standard output, and flushes it before a read
    // of standard input waits, so a prompt without a newline comes before the input request.
    it("writes crackme's prompt before the read that waits for the password", async () => {
        const emulator = await fixtureEmulator('crackme')
        const writes: string[] = []
        emulator.on('stdout', (bytes) => {
            writes.push(new TextDecoder().decode(bytes))
        })
        try {
            await emulator.run(2_000_000)
            expect(emulator.stopReason?.kind).toBe('input')
            expect(writes).toEqual(['Enter password: '])
            await emulator.provideInput('hunter2\n')
            await emulator.run(2_000_000)
            expect(writes).toEqual(['Enter password: ', 'Correct!\n'])
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
        } finally {
            emulator.dispose()
        }
    })
    it('answers isatty() for 0, 1 and 2, waiting for input or given it beforehand', async () => {
        for (const beforehand of [false, true]) {
            const emulator = await fixtureEmulator('isatty')
            const writes: string[] = []
            emulator.on('stdout', (bytes) => {
                writes.push(new TextDecoder().decode(bytes))
            })
            try {
                if (beforehand) await emulator.provideInput('bob\n')
                await emulator.run(2_000_000)
                if (!beforehand) {
                    expect(emulator.stopReason?.kind).toBe('input')
                    expect(writes).toEqual(['1 1 1\n', 'name? '])
                    await emulator.provideInput('bob\n')
                    await emulator.run(2_000_000)
                }
                expect(writes).toEqual(['1 1 1\n', 'name? ', 'hi bob\n'])
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            } finally {
                emulator.dispose()
            }
        }
    })
    it('maps libm without aborting on a page past the file end', async () => {
        const { output, stop } = await runFixture('math', ['0'])
        expect(output).toBe('cos=1.000000\n')
        expect(stop).toMatchObject({ kind: 'exit', exitCode: 0 })
    })
    it('maps C++ libraries in bounded memory and catches an exception', async () => {
        const { output, stop, growth } = await runFixture('cpp')
        expect(output).toBe('hello\nC++\ncaught exception\n')
        expect(stop).toMatchObject({ kind: 'exit', exitCode: 0 })
        expect(growth).toBeLessThan(48 * 1024 * 1024)
    })
    it('answers TRACEME once as an untraced Linux process', async () => {
        const { output, stop } = await runFixture('ptrace')
        expect(output).toBe('ptrace=0 errno=0\nptrace=-1 errno=1\n')
        expect(stop?.kind).toBe('exit')
    })
    it('runs AVX2 code', async () => {
        const { output, stop } = await runFixture('avx', ['1', '2', '3', '4', '5'])
        expect(output).toBe('value=12\n')
        expect(stop).toMatchObject({ kind: 'exit', exitCode: 0 })
    })
})

describe('single-thread startup syscalls', () => {
    it('records robust lists and validates their length', async () => {
        await expectCore(
            [
                'sys 273, buf, 24',
                'save',
                'sys 274, 0, buf2, buf2 + 8',
                'save',
                'saveq buf2 + 8',
                'sys 273, buf, 23',
                'save'
            ],
            [0, 0, 24, EINVAL]
        )
    })
    it('registers CPU 0, refuses duplicate registrations and unregisters', async () => {
        await expectCore(
            [
                'mov dword [buf], -1',
                'mov dword [buf + 4], -1',
                'sys 334, buf, 32, 0, 0x53053053',
                'save',
                'saved buf',
                'saved buf + 4',
                'saved buf + 20',
                'saved buf + 24',
                'sys 334, buf, 32, 0, 0x53053053',
                'save',
                'sys 334, buf, 32, 1, 0x53053053',
                'save',
                'sys 334, buf, 32, 0, 0x53053053',
                'save',
                'sys 334, buf, 31, 0, 0x53053053',
                'save'
            ],
            [0, 0, 0, 0, 0, -16, 0, 0, EINVAL]
        )
    })
    it('fails get_robust_list with EFAULT and stores any set_robust_list pointer', async () => {
        await expectLinux(
            [
                'sys 274, 0, 8, buf2',
                'save',
                'sys 274, 0, buf2, 8',
                'save',
                'sys 273, 0x10, 24',
                'save',
                'sys 274, 0, buf2, buf2 + 8',
                'save',
                'saveq buf2',
                'saveq buf2 + 8'
            ],
            [EFAULT, EFAULT, 0, 0, 0x10, 24]
        )
    })
    it('unregisters rseq as Linux resets it, and refuses to unregister nothing', async () => {
        await expectLinux(
            [
                'sys 334, 0, 0, 1, 0',
                'save',
                'sys 334, buf, 32, 1, 0x53053053',
                'save',
                'mov rax, 0x5555555555555555',
                'mov [buf], rax',
                'mov [buf + 8], rax',
                'mov [buf + 16], rax',
                'mov [buf + 24], rax',
                'mov qword [buf + 8], 0',
                'mov dword [buf + 16], 0',
                'sys 334, buf, 32, 0, 0x53053053',
                'save',
                'sys 334, buf, 32, 1, 0x12345678',
                'save',
                'sys 334, buf, 32, 1, 0x53053053',
                'save',
                'saved buf',
                'saved buf + 4',
                'saved buf + 20',
                'saved buf + 24',
                'sys 334, buf, 32, 1, 0x53053053',
                'save'
            ],
            [EINVAL, EINVAL, 0, EPERM, 0, 0, 0xffffffff, 0, 0, EINVAL]
        )
    })
    it('refuses to attach to itself with EPERM and finds no other process', async () => {
        await expectLinux(
            [
                'sys 39',
                'mov r12, rax',
                'sys 186',
                'mov r13, rax',
                'sys 101, 16, r12, 0, 0',
                'save',
                'sys 101, 0x4206, r12, 0, 0',
                'save',
                'sys 101, 16, r13, 0, 0',
                'save',
                'sys 101, 2, r12, 0, 0',
                'save',
                'sys 101, 16, 0x7fffffff, 0, 0',
                'save',
                'sys 101, 16, 0, 0, 0',
                'save'
            ],
            [EPERM, EPERM, EPERM, ESRCH, ESRCH, ESRCH]
        )
    })
    it('rejects ptrace requests without a tracee', async () => {
        await expectCore(
            [
                'sys 101, 0, 0, 0, 0',
                'save',
                'sys 101, 0, 0, 0, 0',
                'save',
                'sys 101, 1, 123, 0, 0',
                'save'
            ],
            [0, EPERM, ESRCH]
        )
    })
})

describe('count zero bits', () => {
    for (const [size, register, source] of [
        [16, 'ax', 'bx'],
        [32, 'eax', 'ebx'],
        [64, 'rax', 'rbx']
    ] as const) {
        for (const [op, value, count, carry, zero] of [
            ['lzcnt', 0, size, 1, 0],
            ['lzcnt', 1, size - 1, 0, 0],
            ['lzcnt', -1, 0, 0, 1],
            ['tzcnt', 0, size, 1, 0],
            ['tzcnt', 8, 3, 0, 0],
            ['tzcnt', -1, 0, 0, 1]
        ] as const) {
            it(`${op} ${size} bits, ${value}`, async () => {
                await expectCore(
                    [
                        `mov ${source}, ${value}`,
                        `xor eax, eax`,
                        `${op} ${register}, ${source}`,
                        'setc cl',
                        'setz dl',
                        'save',
                        'movzx eax, cl',
                        'save',
                        'movzx eax, dl',
                        'save'
                    ],
                    [count, carry, zero]
                )
            })
        }
    }
})

describe('timed futex waits', () => {
    it('times out, mismatches and validates as Linux does', async () => {
        await expectLinux(
            [
                // FUTEX_WAIT for 50 ms, relative
                'mov qword [buf + 64], 0',
                'mov qword [buf + 72], 50000000',
                'sys 202, buf, 0, 0, buf + 64, 0, 0',
                'save',
                'sys 202, buf, 0x80, 0, buf + 64, 0, 0',
                'save',
                'sys 202, buf, 0, 1, buf + 64, 0, 0',
                'save',
                // FUTEX_CLOCK_REALTIME is for the absolute waits only
                'sys 202, buf, 0x100, 0, buf + 64, 0, 0',
                'save',
                'sys 202, buf, 0x101, 1, 0, 0, 0',
                'save',
                // FUTEX_WAIT_BITSET until an absolute time already past, on both clocks
                'mov qword [buf + 64], 1',
                'mov qword [buf + 72], 0',
                'sys 202, buf, 9, 0, buf + 64, 0, -1',
                'save',
                'sys 202, buf, 0x189, 0, buf + 64, 0, -1',
                'save',
                'sys 202, buf, 9, 0, buf + 64, 0, 0',
                'save',
                // FUTEX_WAIT_BITSET until 50 ms from now on CLOCK_MONOTONIC
                'sys 228, 1, buf + 64',
                'add qword [buf + 72], 50000000',
                'cmp qword [buf + 72], 1000000000',
                'jb .monotonic',
                'sub qword [buf + 72], 1000000000',
                'inc qword [buf + 64]',
                '.monotonic:',
                'sys 202, buf, 9, 0, buf + 64, 0, -1',
                'save',
                // invalid timeouts, addresses and alignment
                'mov qword [buf + 64], 0',
                'mov qword [buf + 72], 1000000000',
                'sys 202, buf, 0, 0, buf + 64, 0, 0',
                'save',
                'mov qword [buf + 64], -1',
                'mov qword [buf + 72], 0',
                'sys 202, buf, 0, 0, buf + 64, 0, 0',
                'save',
                'sys 202, buf, 0, 0, 8, 0, 0',
                'save',
                'sys 202, 8, 0, 0, 0, 0, 0',
                'save',
                'sys 202, buf + 1, 0, 0, 0, 0, 0',
                'save',
                'sys 202, buf, 1, 1, 0, 0, 0',
                'save'
            ],
            [
                ETIMEDOUT,
                ETIMEDOUT,
                EAGAIN,
                ENOSYS,
                ENOSYS,
                ETIMEDOUT,
                ETIMEDOUT,
                EINVAL,
                ETIMEDOUT,
                EINVAL,
                EINVAL,
                EFAULT,
                EFAULT,
                EINVAL,
                0
            ]
        )
    })
    it('returns at once from an untimed wait nothing could end', async () => {
        // On Linux the only thread would sleep forever; here it wakes as from a spurious wakeup.
        await expectCore(['sys 202, buf, 0, 0, 0, 0, 0', 'save'], [0])
    })

    const TIMED_OUT =
        'sem_timedwait=-1 ETIMEDOUT, at least 100 ms\n' +
        'pthread_cond_timedwait=ETIMEDOUT, at least 100 ms\n'

    it('lets glibc sem_timedwait and pthread_cond_timedwait time out on host time', async () => {
        const emulator = await fixtureEmulator('timedwait')
        let output = ''
        emulator.on('stdout', (bytes) => {
            output += new TextDecoder().decode(bytes)
        })
        try {
            const started = performance.now()
            for (let slice = 0; slice < 50 && !emulator.hasTerminated(); slice++) {
                await emulator.run(2_000_000)
                await waitUntilAwake(emulator)
            }
            expect(output).toBe(TIMED_OUT)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            expect(performance.now() - started).toBeGreaterThanOrEqual(200)
        } finally {
            emulator.dispose()
        }
    })

    it('waits on a Testcase-style virtual clock, which advances only through the waits', async () => {
        let now = 1_000_000
        const waits: { clock: number; remainingMilliseconds: number | null }[] = []
        const emulator = await createX86Emulator({
            environment: {
                now: () => now,
                wait: async (request) => {
                    waits.push({
                        clock: request.clock,
                        remainingMilliseconds: request.remainingMilliseconds
                    })
                    now += request.remainingMilliseconds!
                }
            }
        })
        let output = ''
        emulator.on('stdout', (bytes) => {
            output += new TextDecoder().decode(bytes)
        })
        try {
            await emulator.loadExecutable(elfFixture('timedwait'))
            emulator.initialize(0)
            const started = performance.now()
            for (let slice = 0; slice < 50 && !emulator.hasTerminated(); slice++) {
                await emulator.run(2_000_000)
                await waitUntilAwake(emulator)
            }
            expect(output).toBe(TIMED_OUT)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            // Both waits were on CLOCK_REALTIME, for the whole 100 ms each, on virtual time.
            expect(waits).toEqual([
                { clock: 0, remainingMilliseconds: 100 },
                { clock: 0, remainingMilliseconds: 100 }
            ])
            expect(now).toBe(1_000_200)
            expect(performance.now() - started).toBeLessThan(5_000)
        } finally {
            emulator.dispose()
        }
    })
})

/** Waits for a wait the runtime is resolving on its own to end. */
async function waitUntilAwake(emulator: Awaited<ReturnType<typeof createX86Emulator>>) {
    const deadline = Date.now() + 5000
    while (emulator.state === BlinkState.ProgramWaitPause && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
}
