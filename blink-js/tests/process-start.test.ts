import { expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { X86_PROGRAM_ENVIRONMENT } from '../src/linux-runtime'
import { readProcessStart } from '../src/process-start'
import type { X86ProcessStartBytes } from '../src/types'
import { elfFixture } from './elf-fixtures'

const STACK_TOP = 0x7ffffffff000n

const text = (emulator: X86Emulator, part: X86ProcessStartBytes | undefined) =>
    part
        ? new TextDecoder().decode(emulator.readMemoryBytes(part.address, BigInt(part.length - 1)))
        : undefined
const qword = (emulator: X86Emulator, address: bigint) => {
    const bytes = emulator.readMemoryBytes(address, 8n)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
}

it('reads the process-start block an assembled program starts with, as the loader wrote it', async () => {
    const emulator = await createX86Emulator()
    try {
        const result = await emulator.compile(`global _start
section .text
_start:
    mov rsi, [rsp+16]
    mov byte [rsi], 'X'
    mov qword [rsp+8], 0
    mov eax, 60
    xor edi, edi
    syscall`)
        expect(result.ok).toBe(true)
        expect(emulator.getProcessStart(), 'none before the first start').toBeNull()
        emulator.setProgramArguments('./main', ['hello', 'two words'])
        emulator.initialize(100)
        emulator.getNextInstruction()
        const start = emulator.getProcessStart()!
        expect(start).not.toBeNull()
        expect(start.start).toBe(emulator.getSp())
        expect(start.end).toBe(STACK_TOP)
        expect(qword(emulator, start.start)).toBe(3n)
        expect(start.argc).toBe(3)
        expect(start.argv).toBe(start.start + 8n)
        expect(start.envp).toBe(start.argv + 4n * 8n)
        expect(start.auxv).toBe(start.envp + BigInt(X86_PROGRAM_ENVIRONMENT.length + 1) * 8n)
        expect(start.auxvEnd).toBeGreaterThan(start.auxv)
        expect(qword(emulator, start.auxvEnd - 16n)).toBe(0n)
        expect(start.arguments.map((part) => text(emulator, part))).toEqual([
            './main',
            'hello',
            'two words'
        ])
        expect(
            start.arguments.map((part, i) => qword(emulator, start.argv + 8n * BigInt(i)))
        ).toEqual(start.arguments.map((part) => part.address))
        expect(start.environment.map((part) => text(emulator, part))).toEqual(
            X86_PROGRAM_ENVIRONMENT
        )
        expect(text(emulator, start.execfn)).toBe('/program')
        expect(start.random?.length).toBe(16)
        expect(text(emulator, start.path)).toBe('/program')
        expect(start.path!.address + BigInt(start.path!.length)).toBe(STACK_TOP)
        // the strings follow one another from argv[0] up, the vectors below them
        const parts = [
            ...start.arguments,
            ...start.environment,
            start.execfn!,
            start.random!,
            start.path!
        ]
        expect(parts[0].address).toBeGreaterThanOrEqual(start.auxvEnd)
        expect(parts[0].address - start.auxvEnd).toBeLessThan(16n)
        for (let i = 1; i < parts.length; i++)
            expect(parts[i].address).toBe(parts[i - 1].address + BigInt(parts[i - 1].length))

        // what the program writes there afterwards changes the memory, not the facts
        const before = structuredClone(start)
        await emulator.run(100)
        expect(emulator.hasTerminated()).toBe(true)
        expect(text(emulator, start.arguments[1])).toBe('Xello')
        expect(qword(emulator, start.argv)).toBe(0n)
        expect(emulator.getProcessStart(), 'kept after the program ends').toEqual(before)

        // a new build replaces the program and forgets it until the next start
        expect((await emulator.compile('global _start\n_start: jmp _start')).ok).toBe(true)
        expect(emulator.getProcessStart()).toBeNull()
        emulator.setProgramArguments('./main', [])
        emulator.initialize(0)
        emulator.getNextInstruction()
        expect(emulator.getProcessStart()?.argc).toBe(1)
        emulator.clearExecution()
        expect(emulator.getProcessStart()).toBeNull()
    } finally {
        emulator.dispose()
    }
})

it('reads the block an Executable starts with, before the dynamic loader runs', async () => {
    const emulator = await createX86Emulator()
    try {
        await emulator.loadExecutable(elfFixture('argv-env'), {
            argv0: './argv-env',
            arguments: ['', 'café 猫']
        })
        expect(emulator.getProcessStart()).toBeNull()
        emulator.initialize(0)
        emulator.getNextInstruction()
        const start = emulator.getProcessStart()!
        expect(start.start).toBe(emulator.getSp())
        expect(start.arguments.map((part) => text(emulator, part))).toEqual([
            './argv-env',
            '',
            'café 猫'
        ])
        expect(start.arguments[1].length).toBe(1)
        expect(start.environment).toHaveLength(X86_PROGRAM_ENVIRONMENT.length)
        expect(start.end).toBe(STACK_TOP)
        let output = ''
        emulator.on('stdout', (bytes) => {
            output += new TextDecoder().decode(bytes)
        })
        await emulator.run(1_000_000)
        expect(output).toContain('argv[2]=café 猫\n')
        expect(emulator.getProcessStart()?.start).toBe(start.start)
    } finally {
        emulator.dispose()
    }
})

it('refuses memory that does not read as a block', () => {
    const memory = (bytes: number[], base: bigint) => (address: bigint, length: number) => {
        const offset = Number(address - base)
        if (offset < 0 || offset >= bytes.length) throw new Error('unmapped')
        return Uint8Array.from(bytes.slice(offset, offset + length))
    }
    const block = (values: bigint[]) =>
        values.flatMap((value) =>
            Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn))
        )
    // argc 1, a pointer and a NULL, no environment, and an auxiliary vector that never ends
    expect(() =>
        readProcessStart(0x1000n, memory(block([1n, 0x1100n, 0n, 0n, 6n, 4096n]), 0x1000n))
    ).toThrow()
    // argc 2 with a single pointer
    expect(() =>
        readProcessStart(0x1000n, memory(block([2n, 0x1100n, 0n, 0n, 0n, 0n]), 0x1000n))
    ).toThrow(/argv holds 1/)
    // a complete block: one argument ending at the top, nothing above it
    const bytes = [
        ...block([1n, 0x1030n, 0n, 0n, 0n, 0n]),
        ...Array.from('./a\0', (c) => c.charCodeAt(0))
    ]
    expect(readProcessStart(0x1000n, memory(bytes, 0x1000n))).toMatchObject({
        start: 0x1000n,
        end: 0x1034n,
        argc: 1,
        argv: 0x1008n,
        envp: 0x1018n,
        auxv: 0x1020n,
        auxvEnd: 0x1030n,
        arguments: [{ address: 0x1030n, length: 4 }],
        environment: []
    })
})
