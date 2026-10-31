// A rep string instruction whose writes outgrow the 64 KiB of old bytes the write journal keeps
// for one instruction stops between iterations for the history and goes on at once
// (x86-devices-plan.md, decision 6). Its parts are one Step, one History row and one instruction
// in the count, and Undo of the row restores every part: clearing a framebuffer page stays
// reversible.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const CLEAR_BYTES = 300 * 1024
const EXIT = ['  mov eax, 60', '  xor edi, edi', '  syscall']

function program(body: string[], sections: { data?: string[]; bss?: string[] } = {}): string[] {
    return [
        'bits 64',
        'global _start',
        ...(sections.data ? ['section .data', ...sections.data] : []),
        ...(sections.bss ? ['section .bss', ...sections.bss] : []),
        'section .text',
        '_start:',
        ...body,
        '  nop ; <-- after',
        ...EXIT
    ]
}

async function start(lines: string[], capacity = 64): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(lines.join('\n'))
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    return emulator
}

function lineOf(lines: string[], marker: string): number {
    const index = lines.findIndex((line) => line.includes(marker))
    if (index < 0) throw new Error(`no line holds ${marker}`)
    return index
}

async function stepToMarked(emulator: X86Emulator, lines: string[]): Promise<void> {
    const line = lineOf(lines, '; <-- step')
    for (let step = 0; step < 100; step += 1) {
        if (emulator.getInstructionAt(emulator.getPc())?.lineNumber === line) return
        await emulator.step()
    }
    throw new Error('the marked instruction never came up')
}

function bytes(emulator: X86Emulator, address: bigint, length: number): Uint8Array {
    return emulator.readMemoryBytes(address, BigInt(length))
}

function every(values: Uint8Array, value: (index: number) => number): boolean {
    return values.every((byte, index) => byte === value(index))
}

/** `rep stosd` storing 0x12345678 over 300 KB of .bss, upward or downward. */
function clear(down: boolean): string[] {
    const count = CLEAR_BYTES / 4
    return program(
        [
            `  lea rdi, [rel page${down ? ` + ${CLEAR_BYTES - 4}` : ''}]`,
            `  mov ecx, ${count}`,
            '  mov eax, 0x12345678',
            ...(down ? ['  std'] : []),
            '  rep stosd ; <-- step',
            '  cld'
        ],
        { bss: [`page: resb ${CLEAR_BYTES}`] }
    )
}

const PATTERN = [0x78, 0x56, 0x34, 0x12]

describe('a rep string instruction that writes more than 64 KiB', () => {
    it.each([false, true])(
        'clears 300 KB with rep stosd as one step, one row and one instruction (downward: %s)',
        async (down) => {
            const lines = clear(down)
            const emulator = await start(lines)
            try {
                await stepToMarked(emulator, lines)
                const page =
                    emulator.getRegisterValue('rdi') - (down ? BigInt(CLEAR_BYTES - 4) : 0n)
                const registers = emulator.runtime.getRegisterSnapshot()
                const rows = emulator.getUndoDepth()
                const executed = emulator.getInstructionsExecuted()
                const recorded = emulator.getRecordedEntryCount()
                await emulator.step()
                expect(emulator.getRegisterValue('rcx')).toBe(0n)
                expect(every(bytes(emulator, page, CLEAR_BYTES), (i) => PATTERN[i % 4]!)).toBe(
                    true
                )
                expect(emulator.getInstructionsExecuted()).toBe(executed + 1n)
                expect(emulator.getRecordedEntryCount()).toBe(recorded + 1)
                expect(emulator.getUndoDepth()).toBe(rows + 1)
                const [row] = emulator.getUndoHistory(1)
                expect(row!.undoable).toBe(true)
                const written = row!.mutations.flatMap((mutation) =>
                    mutation.type === 'WriteMemoryBytes' ? [mutation.value] : []
                )
                expect(written.reduce((sum, write) => sum + write.new.length, 0)).toBe(
                    CLEAR_BYTES
                )
                expect(row!.mutations.some((mutation) => mutation.type === 'Other')).toBe(false)
                if (!down) expect(written).toHaveLength(1)
                emulator.undo()
                expect(every(bytes(emulator, page, CLEAR_BYTES), () => 0)).toBe(true)
                expect(emulator.runtime.getRegisterSnapshot()).toEqual(registers)
                expect(emulator.getInstructionsExecuted()).toBe(executed)
                expect(emulator.getUndoDepth()).toBe(rows)
                // and the step taken again leaves what the first left
                await emulator.step()
                expect(every(bytes(emulator, page, CLEAR_BYTES), (i) => PATTERN[i % 4]!)).toBe(
                    true
                )
            } finally {
                emulator.dispose()
            }
        }
    )

    it.each([false, true])(
        'copies 200 KB with rep movsb, which Undo restores (downward: %s)',
        async (down) => {
            const size = 200 * 1024
            const lines = program(
                [
                    // a source that is not all zeros, so the copy shows
                    '  lea rdi, [rel source]',
                    `  mov ecx, ${size / 8}`,
                    '  mov rax, 0x0102030405060708',
                    '  rep stosq',
                    `  lea rsi, [rel source${down ? ` + ${size - 1}` : ''}]`,
                    `  lea rdi, [rel target${down ? ` + ${size - 1}` : ''}]`,
                    `  mov ecx, ${size}`,
                    ...(down ? ['  std'] : []),
                    '  rep movsb ; <-- step',
                    '  cld'
                ],
                { bss: [`source: resb ${size}`, `target: resb ${size}`] }
            )
            const emulator = await start(lines)
            try {
                await stepToMarked(emulator, lines)
                const target = emulator.getRegisterValue('rdi') - (down ? BigInt(size - 1) : 0n)
                const registers = emulator.runtime.getRegisterSnapshot()
                const executed = emulator.getInstructionsExecuted()
                await emulator.step()
                expect(emulator.getRegisterValue('rcx')).toBe(0n)
                expect(every(bytes(emulator, target, size), (i) => 8 - (i % 8))).toBe(true)
                expect(emulator.getInstructionsExecuted()).toBe(executed + 1n)
                expect(emulator.canUndo()).toBe(true)
                emulator.undo()
                expect(every(bytes(emulator, target, size), () => 0)).toBe(true)
                expect(emulator.runtime.getRegisterSnapshot()).toEqual(registers)
            } finally {
                emulator.dispose()
            }
        }
    )

    it('runs whole within a run, without stopping at its own breakpoint or counting its parts', async () => {
        const lines = clear(false)
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const executed = emulator.getInstructionsExecuted()
            // a limit of one instruction runs the whole of it
            expect(await emulator.run(1, [lineOf(lines, '<-- step')])).toBe(
                EmulatorStatus.Running
            )
            expect(emulator.getRegisterValue('rcx')).toBe(0n)
            expect(emulator.getInstructionsExecuted()).toBe(executed + 1n)
            emulator.undo()
            expect(emulator.getRegisterValue('rcx')).toBe(BigInt(CLEAR_BYTES / 4))
            // continuing from its breakpoint runs it whole and stops at the next one
            expect(
                await emulator.run(100, [lineOf(lines, '<-- step'), lineOf(lines, '<-- after')])
            ).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason?.kind).toBe('breakpoint')
            expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(
                lineOf(lines, '<-- after') - 0
            )
            expect(emulator.getRegisterValue('rcx')).toBe(0n)
        } finally {
            emulator.dispose()
        }
    })

    it('runs whole and unrecorded without a history', async () => {
        const lines = clear(false)
        const emulator = await start(lines, 0)
        try {
            await stepToMarked(emulator, lines)
            const executed = emulator.getInstructionsExecuted()
            await emulator.step()
            expect(emulator.getRegisterValue('rcx')).toBe(0n)
            expect(emulator.getInstructionsExecuted()).toBe(executed + 1n)
            expect(emulator.canUndo()).toBe(false)
        } finally {
            emulator.dispose()
        }
    })
})
