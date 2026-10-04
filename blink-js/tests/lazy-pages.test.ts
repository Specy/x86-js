// Debugger reads of pages the program has not touched yet.
//
// Blink maps a page lazily: until the program first touches it, a page of
// .rodata, .data, .bss, the heap or the stack is only reserved, and the bridge
// used to refuse it as unmapped. The editor shows a refused read as zeros, so
// the memory view showed 00 for every whole page the program had not touched
// yet, and a Poke into such a page failed. The bridge now faults a reserved
// page in exactly as the program's first access would, so the debugger sees
// the bytes the program will find there, and the program finds them too.
import { describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const PAGE = 4096n
const MiB = 0x100000n
/** Blink reserves 8 MiB of stack for a program; nothing is mapped below it. */
const STACK_SIZE = 8n * MiB

const PROGRAM = [
    'bits 64',
    'global _start',
    'section .rodata',
    'table: times 8192 db 0x41',
    'section .data',
    'values: times 8192 db 0x42',
    'untouched: times 16384 db 0x43', // the program never reads a byte of it
    'section .bss',
    'scratch: resb 12288',
    'scratch_end:',
    'output: resb 8',
    'section .text',
    '_start:',
    '  lea r12, [rel table]',
    '  lea r13, [rel values]',
    '  lea r14, [rel scratch]',
    '  lea r15, [rel untouched]',
    '  lea rbp, [rel scratch_end]',
    '  nop ; at entry',
    '  movzx eax, byte [r12]', // the first page of .rodata, .data and .bss
    '  movzx eax, byte [r13]',
    '  movzx eax, byte [r14]',
    '  nop ; first pages touched',
    '  mov byte [r14 + 8192], 0x77 ; first write into the third page of scratch',
    '  mov byte [r13 + 4096], 0x99 ; first write into the second page of values',
    '  nop ; after the writes',
    '  mov byte [rsp - 0x100000], 0x5a ; a megabyte below rsp, inside the stack',
    // What the program reads from pages it had not touched: the output and the
    // exit status both depend on them.
    '  lea rdi, [rel output]',
    '  mov al, [r12 + 4096 + 5]',
    '  mov [rdi], al',
    '  mov al, [r13 + 4096 + 7]',
    '  mov [rdi + 1], al',
    '  mov al, [r15 + 12000]',
    '  mov [rdi + 2], al',
    '  mov al, [r14 + 4096 + 3]',
    '  mov [rdi + 3], al',
    '  mov al, [r14 + 8192]',
    '  mov [rdi + 4], al',
    '  mov al, [rsp - 0x100000]',
    '  mov [rdi + 5], al',
    '  mov al, [rsp - 0x200000]',
    '  mov [rdi + 6], al',
    '  mov eax, 1',
    '  mov edi, 1',
    '  lea rsi, [rel output]',
    '  mov edx, 7',
    '  syscall',
    '  movzx edi, byte [rel output]',
    '  movzx eax, byte [rel output + 2]',
    '  add edi, eax',
    '  movzx eax, byte [rel output + 4]',
    '  add edi, eax',
    '  and edi, 0xff',
    '  mov eax, 60',
    '  syscall',
]

/**
 * What the program writes, all from pages it had not touched before: 0x41 from
 * .rodata, 0x42 from .data, 0x43 from the .data it never otherwise reads, 0 from
 * .bss, the byte it wrote into .bss and the one it wrote a megabyte down the
 * stack, then 0 from two megabytes down. It exits with the sum of the first,
 * third and fifth.
 */
const EXPECTED_OUTPUT = [0x41, 0x42, 0x43, 0x00, 0x77, 0x5a, 0x00]
const EXPECTED_EXIT = (0x41 + 0x43 + 0x77) & 0xff

function lineOf(marker: string): number {
    const index = PROGRAM.findIndex((line) => line.includes(marker))
    if (index < 0) throw new Error(`no line holds ${marker}`)
    return index
}

type Layout = { table: bigint; values: bigint; untouched: bigint; scratch: bigint; scratchEnd: bigint; rsp: bigint }

async function started(): Promise<{ emulator: X86Emulator; output: number[] }> {
    const output: number[] = []
    const emulator = await createX86Emulator({
        callbacks: { stdout: (charCode) => void output.push(charCode) },
    })
    const result = await emulator.compile(PROGRAM.join('\n'))
    if (!result.ok) throw new Error(`the program did not assemble:\n${result.report}`)
    return { emulator, output }
}

/** What the program itself wrote: the runtime echoes `$ /program` on stdout before it starts. */
function programOutput(output: number[]): number[] {
    const echo = Array.from('$ /program\n', (character) => character.charCodeAt(0))
    for (let start = output.length - echo.length; start >= 0; start -= 1) {
        if (echo.every((code, index) => output[start + index] === code)) return output.slice(start + echo.length)
    }
    throw new Error('the program never started')
}

async function runTo(emulator: X86Emulator, marker: string): Promise<void> {
    await emulator.run(undefined, [lineOf(marker)])
    expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('breakpoint')
}

function layoutOf(emulator: X86Emulator): Layout {
    return {
        table: emulator.getRegisterValue('r12'),
        values: emulator.getRegisterValue('r13'),
        scratch: emulator.getRegisterValue('r14'),
        untouched: emulator.getRegisterValue('r15'),
        scratchEnd: emulator.getRegisterValue('rbp'),
        rsp: emulator.getSp(),
    }
}

function read(emulator: X86Emulator, address: bigint, length: number): number[] {
    return Array.from(emulator.readMemoryBytes(address, BigInt(length)))
}

function filled(length: number, value: number): number[] {
    return new Array<number>(length).fill(value)
}

function roundUp(value: bigint): bigint {
    return (value + PAGE - 1n) & ~(PAGE - 1n)
}

/** Every byte of the four regions, through both of the bridge's read paths. */
function expectRegions(emulator: X86Emulator, layout: Layout, overrides: Map<bigint, number> = new Map()): void {
    const regions: [string, bigint, number, number][] = [
        ['.rodata table', layout.table, 8192, 0x41],
        ['.data values', layout.values, 8192, 0x42],
        ['.data untouched', layout.untouched, 16384, 0x43],
        ['.bss scratch', layout.scratch, 12288, 0x00],
    ]
    for (const [name, address, length, value] of regions) {
        const expected = filled(length, value)
        for (const [at, byte] of overrides) {
            if (at >= address && at < address + BigInt(length)) expected[Number(at - address)] = byte
        }
        expect(read(emulator, address, length), `${name}, read byte by byte`).toEqual(expected)
        expect(Array.from(emulator.runtime.spyMemoryBytes(address, length) ?? []), `${name}, read page by page`).toEqual(
            expected,
        )
    }
}

function expectUnmapped(emulator: X86Emulator, address: bigint, what: string): void {
    expect(() => emulator.readMemoryBytes(address, 1n), what).toThrow(/not mapped/)
    expect(emulator.runtime.spyMemoryBytes(address, 1), what).toBeNull()
}

describe('memory the program has not touched yet', () => {
    it('reads with the bytes the program will find there, at entry and once it touches some pages', async () => {
        const { emulator } = await started()
        await runTo(emulator, 'nop ; at entry')
        const layout = layoutOf(emulator)
        expectRegions(emulator, layout)

        await runTo(emulator, 'nop ; first pages touched')
        expectRegions(emulator, layout)

        await runTo(emulator, 'nop ; after the writes')
        expectRegions(
            emulator,
            layout,
            new Map([
                [layout.scratch + 8192n, 0x77],
                [layout.values + 4096n, 0x99],
            ]),
        )
        emulator.dispose()
    })

    it('still refuses addresses nothing is mapped at', async () => {
        const { emulator } = await started()
        await runTo(emulator, 'nop ; at entry')
        const layout = layoutOf(emulator)
        expectUnmapped(emulator, 0x10000000n, '0x10000000')
        // .bss ends on a page of its own, and nothing is mapped after that page.
        const pastBss = roundUp(layout.scratchEnd + 8n)
        expect(read(emulator, pastBss - 1n, 1), 'the last byte of the page .bss ends in').toEqual([0])
        expectUnmapped(emulator, pastBss, 'the page after .bss')
        emulator.dispose()
    })

    it('reads the stack far below rsp without growing it', async () => {
        const { emulator } = await started()
        await runTo(emulator, 'nop ; at entry')
        const { rsp } = layoutOf(emulator)
        // The stack ends where the first unmapped page above rsp begins.
        let stackTop = (rsp & ~(PAGE - 1n)) + PAGE
        while (emulator.runtime.spyMemoryBytes(stackTop, 1)) stackTop += PAGE
        const stackBottom = stackTop - STACK_SIZE
        expect(read(emulator, rsp - MiB, 16)).toEqual(filled(16, 0))
        expect(read(emulator, stackBottom, 16), 'the lowest stack page').toEqual(filled(16, 0))
        expectUnmapped(emulator, stackBottom - 1n, 'the byte below the stack')
        expectUnmapped(emulator, rsp - 9n * MiB, '9 MiB below rsp')

        // The program's own access a megabyte down works as it would have, and
        // the stack still ends where it did.
        await emulator.run()
        expect(emulator.stopReason?.exitCode).toBe(EXPECTED_EXIT)
        expectUnmapped(emulator, stackBottom - 1n, 'the byte below the stack, at exit')
        emulator.dispose()
    })

    it('changes nothing the program reads or does', async () => {
        const plain = await started()
        await plain.emulator.run()
        expect(plain.emulator.stopReason?.kind).toBe('exit')

        const watched = await started()
        await runTo(watched.emulator, 'nop ; at entry')
        const layout = layoutOf(watched.emulator)
        expectRegions(watched.emulator, layout)
        read(watched.emulator, layout.rsp - MiB, 64)
        read(watched.emulator, layout.rsp - 2n * MiB, 64)
        await runTo(watched.emulator, 'nop ; first pages touched')
        expectRegions(watched.emulator, layout)
        await watched.emulator.run()

        expect(programOutput(plain.output)).toEqual(EXPECTED_OUTPUT)
        expect(plain.emulator.stopReason?.exitCode).toBe(EXPECTED_EXIT)
        expect(programOutput(watched.output)).toEqual(programOutput(plain.output))
        expect(watched.emulator.stopReason?.exitCode).toBe(plain.emulator.stopReason?.exitCode)
        plain.emulator.dispose()
        watched.emulator.dispose()
    })
})

describe('with native history', () => {
    it('undoes a first write into a page the debugger read before it', async () => {
        // The read faulted the page in, so the step finds bytes to record as
        // the ones it replaced. (A step that is the very first to touch a
        // page still records no old bytes, and stays out of undo: see
        // write-values.test.ts.)
        const { emulator, output } = await started()
        emulator.initialize(64)
        await runTo(emulator, 'nop ; first pages touched')
        const layout = layoutOf(emulator)
        expect(read(emulator, layout.scratch + 8192n, 4), 'the .bss page before the write').toEqual([0, 0, 0, 0])
        expect(read(emulator, layout.values + 4096n, 4), 'the .data page before the write').toEqual(filled(4, 0x42))

        await emulator.step() // nop
        await emulator.step() // mov byte [r14 + 8192], 0x77
        await emulator.step() // mov byte [r13 + 4096], 0x99
        expect(read(emulator, layout.scratch + 8192n, 2)).toEqual([0x77, 0])
        expect(read(emulator, layout.values + 4096n, 2)).toEqual([0x99, 0x42])

        emulator.undo()
        expect(read(emulator, layout.values + 4096n, 2), 'the .data page restored').toEqual([0x42, 0x42])
        emulator.undo()
        expect(read(emulator, layout.scratch + 8192n, 2), 'the .bss page restored').toEqual([0, 0])
        expectRegions(emulator, layout)

        // Run on from the undone state: the program writes and reads as before.
        await emulator.run()
        expect(programOutput(output)).toEqual(EXPECTED_OUTPUT)
        expect(emulator.stopReason?.exitCode).toBe(EXPECTED_EXIT)
        emulator.dispose()
    })

    it('lets a Poke write into pages the program has not touched, and undoes it', async () => {
        const { emulator, output } = await started()
        emulator.initialize(64)
        await runTo(emulator, 'nop ; at entry')
        const layout = layoutOf(emulator)

        emulator.beginPoke()
        emulator.writeMemoryBytes(layout.scratch + 4096n + 3n, Uint8Array.of(0x33))
        emulator.writeMemoryBytes(layout.untouched + 12000n, Uint8Array.of(0x44))
        expect(emulator.endPoke()).toBe(true)
        expect(read(emulator, layout.scratch + 4096n + 2n, 3)).toEqual([0, 0x33, 0])
        expect(read(emulator, layout.untouched + 12000n, 2)).toEqual([0x44, 0x43])

        emulator.undo()
        expectRegions(emulator, layout)

        // Poked again, the program reads the poked bytes.
        emulator.beginPoke()
        emulator.writeMemoryBytes(layout.scratch + 4096n + 3n, Uint8Array.of(0x33))
        emulator.writeMemoryBytes(layout.untouched + 12000n, Uint8Array.of(0x44))
        emulator.endPoke()
        await emulator.run()
        expect(programOutput(output)).toEqual([0x41, 0x42, 0x44, 0x33, 0x77, 0x5a, 0x00])
        expect(emulator.stopReason?.exitCode).toBe((0x41 + 0x44 + 0x77) & 0xff)
        emulator.dispose()
    })
})
