import { describe, expect, it } from 'vitest'
import { fixtureEmulator } from './elf-fixtures'
import { expectCore, EINVAL, EPERM, ESRCH } from './linux-probe'

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
    it('reports the faulting address for unsupported AVX', async () => {
        const { stop } = await runFixture('avx', ['1', '2', '3', '4', '5'])
        expect(stop).toMatchObject({ kind: 'signal', signal: { name: 'SIGILL' } })
        expect(stop?.address).toBeTypeOf('bigint')
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
