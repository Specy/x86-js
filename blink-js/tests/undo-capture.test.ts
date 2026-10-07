// Undo of the writes the native journal used to give up on.
//
// A step's writes are journaled before they happen: the bytes each one is
// about to replace are copied aside, and undo puts them back. Two kinds of
// write defeated that, and with them Undo stopped in ordinary compiled C:
//
// - The first write into a page the program had not touched yet. Blink maps a
//   page lazily, and until its first access it is only reserved, so there was
//   nothing to copy the replaced bytes out of: the record came back short and
//   the whole step irreversible. That hit the first store into each page of
//   .bss or .data (a global array, the start unit's __cxa_atexit table), each
//   page the stack grew into, and syscalls writing into such pages. The journal
//   now pages it in exactly as the write is about to, and so captures the bytes
//   the write replaces: zeros, or for .data the file's.
// - String instructions over more than sixteen elements. REP STOS and REP MOVS
//   write element by element (bar the byte forms Blink runs in bulk), and a
//   step holds sixteen records, so the `rep stosq` GCC emits for
//   `int a[100] = {0}` could not be undone. An element continuing the last
//   record, upward or downward, now extends it: the string is one record.
//
// A step still captures at most 64 KiB of replaced bytes.
//
// Reading memory through the debugger pages it in too, so a region the program
// has not touched is read only after the step under test: its bytes before are
// known, zeros in .bss.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const PAGE = 4096
const KiB64 = 65536
const EXIT = ['  mov eax, 60', '  xor edi, edi', '  syscall']

/** A NASM program: `body` runs from _start, then the program exits. */
function program(body: string[], sections: { data?: string[]; bss?: string[] } = {}): string[] {
    return [
        'bits 64',
        'global _start',
        ...(sections.data ? ['section .data', ...sections.data] : []),
        ...(sections.bss ? ['section .bss', ...sections.bss] : []),
        'section .text',
        '_start:',
        ...body,
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

/** Steps until the instruction on the line marked `; <-- step` is the next to run. */
async function stepToMarked(emulator: X86Emulator, lines: string[]): Promise<void> {
    const line = lineOf(lines, '; <-- step')
    for (let step = 0; step < 100; step += 1) {
        if (emulator.getInstructionAt(emulator.getPc())?.lineNumber === line) return
        await emulator.step()
    }
    throw new Error('the marked instruction never came up')
}

function read(emulator: X86Emulator, address: bigint, length: number): number[] {
    return Array.from(emulator.readMemoryBytes(address, BigInt(length)))
}

function filled(length: number, value: number): number[] {
    return new Array<number>(length).fill(value)
}

function qwords(values: bigint[]): number[] {
    const bytes = new Uint8Array(values.length * 8)
    const view = new DataView(bytes.buffer)
    values.forEach((value, index) => view.setBigUint64(index * 8, value, true))
    return Array.from(bytes)
}

/** The newest entry's memory mutations, in the shape the history hands out. */
function memoryMutations(emulator: X86Emulator) {
    const mutations = emulator.getUndoHistory(1)[0]?.mutations ?? []
    return mutations.flatMap((mutation) =>
        mutation.type === 'WriteMemoryBytes' || mutation.type === 'Other' ? [mutation] : []
    )
}

/**
 * Steps the marked instruction, which must write `before.length` bytes from
 * `address` (holding `before` until then), and checks that it is one undoable
 * record: undo restores every byte and register, and stepping again leaves
 * exactly what the first step left. Returns those bytes.
 */
async function expectUndoableWrite(
    emulator: X86Emulator,
    address: bigint,
    before: number[]
): Promise<number[]> {
    const registers = emulator.runtime.getRegisterSnapshot()
    await emulator.step()
    expect(emulator.canUndo()).toBe(true)
    const after = read(emulator, address, before.length)
    const registersAfter = emulator.runtime.getRegisterSnapshot()
    expect(memoryMutations(emulator)).toEqual([
        { type: 'WriteMemoryBytes', value: { address, old: before, new: after } }
    ])

    emulator.undo()
    expect(read(emulator, address, before.length)).toEqual(before)
    expect(emulator.runtime.getRegisterSnapshot()).toEqual(registers)

    await emulator.step()
    expect(read(emulator, address, before.length)).toEqual(after)
    expect(emulator.runtime.getRegisterSnapshot()).toEqual(registersAfter)
    return after
}

describe('the first write into a page the program has not touched', () => {
    it('undoes a store into an untouched .bss page, which reads back zero', async () => {
        const lines = program(
            [
                '  lea rbx, [rel area + 4096]',
                '  and rbx, -4096 ; a page wholly inside area',
                '  mov rax, 0x1122334455667788',
                '  mov [rbx + 8], rax ; <-- step'
            ],
            { bss: ['area: resb 3 * 4096'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const page = emulator.getRegisterValue('rbx')
            const after = await expectUndoableWrite(emulator, page + 8n, filled(8, 0))
            expect(after).toEqual([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])

            emulator.undo()
            expect(read(emulator, page, PAGE)).toEqual(filled(PAGE, 0))
        } finally {
            emulator.dispose()
        }
    })

    it('captures the file bytes a store replaces in an untouched page of .data', async () => {
        const lines = program(
            [
                '  lea rbx, [rel values + 2 * 4096]',
                '  and rbx, -4096',
                '  mov qword [rbx + 16], -1 ; <-- step'
            ],
            { data: ['values: times 4 * 4096 db 0x42'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const page = emulator.getRegisterValue('rbx')
            expect(await expectUndoableWrite(emulator, page + 16n, filled(8, 0x42))).toEqual(
                filled(8, 0xff)
            )
            emulator.undo()
            expect(read(emulator, page, PAGE)).toEqual(filled(PAGE, 0x42))
        } finally {
            emulator.dispose()
        }
    })

    it.each([
        ['rep stosb', ['  mov al, 0x5a', '  rep stosb ; <-- step'], filled(100, 0x5a)],
        [
            'rep movsb',
            ['  lea rsi, [rel source]', '  rep movsb ; <-- step'],
            Array.from({ length: 100 }, (_, i) => i)
        ]
    ])(
        'undoes %s across a page boundary into two untouched pages',
        async (_, instruction, expected) => {
            const lines = program(
                [
                    '  lea rdi, [rel area + 4096]',
                    '  and rdi, -4096',
                    '  sub rdi, 50 ; 50 bytes before a page boundary, 50 after',
                    '  mov rbx, rdi',
                    '  mov ecx, 100',
                    ...instruction
                ],
                {
                    data: [`source: db ${Array.from({ length: 100 }, (_, i) => i).join(', ')}`],
                    bss: ['area: resb 3 * 4096']
                }
            )
            const emulator = await start(lines)
            try {
                await stepToMarked(emulator, lines)
                const first = emulator.getRegisterValue('rbx')
                expect(await expectUndoableWrite(emulator, first, filled(100, 0))).toEqual(expected)
            } finally {
                emulator.dispose()
            }
        }
    )

    it('undoes a push into a page the stack has just grown into', async () => {
        const lines = program([
            '  sub rsp, 0x20000',
            '  and rsp, -4096 ; the push lands in the page below',
            '  mov rax, 0x0123456789abcdef',
            '  push rax ; <-- step'
        ])
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const slot = emulator.getSp() - 8n
            expect(await expectUndoableWrite(emulator, slot, filled(8, 0))).toEqual(
                qwords([0x0123456789abcdefn])
            )
        } finally {
            emulator.dispose()
        }
    })

    it('undoes a store far below the stack pointer', async () => {
        const lines = program(['  mov rax, -2', '  mov [rsp - 0x40000], rax ; <-- step'])
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const slot = emulator.getSp() - 0x40000n
            expect(await expectUndoableWrite(emulator, slot, filled(8, 0))).toEqual(
                qwords([-2n & 0xffffffffffffffffn])
            )
        } finally {
            emulator.dispose()
        }
    })

    it('undoes a system call that writes a structure into an untouched page', async () => {
        const lines = program(
            [
                '  mov eax, 228 ; clock_gettime',
                '  mov edi, 1 ; CLOCK_MONOTONIC',
                '  lea rsi, [rel time]',
                '  syscall ; <-- step'
            ],
            { bss: ['time: resq 2'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const time = emulator.getRegisterValue('rsi')
            const registers = emulator.runtime.getRegisterSnapshot()
            await emulator.step()
            expect(emulator.canUndo()).toBe(true)
            const written = read(emulator, time, 16)
            expect(written).not.toEqual(filled(16, 0))
            expect(memoryMutations(emulator)).toEqual([
                {
                    type: 'WriteMemoryBytes',
                    value: { address: time, old: filled(16, 0), new: written }
                }
            ])
            emulator.undo()
            expect(read(emulator, time, 16)).toEqual(filled(16, 0))
            expect(emulator.runtime.getRegisterSnapshot()).toEqual(registers)
        } finally {
            emulator.dispose()
        }
    })

    it('captures a read into untouched .bss as one irreversible instruction', async () => {
        const lines = program(
            [
                '  xor eax, eax',
                '  xor edi, edi',
                '  lea rsi, [rel line]',
                '  mov edx, 16',
                '  syscall ; <-- step'
            ],
            { bss: ['line: resb 3 * 4096'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const buffer = emulator.getRegisterValue('rsi')
            const registers = emulator.runtime.getRegisterSnapshot()
            const depth = emulator.getUndoHistory(100).length
            await emulator.step()
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('hello\n')
            expect(emulator.getRegisterValue('rax')).toBe(6n)
            expect(emulator.getUndoHistory(100)).toHaveLength(depth + 1)
            expect(emulator.canUndo()).toBe(false)
            expect(memoryMutations(emulator)).toEqual([
                {
                    type: 'WriteMemoryBytes',
                    value: {
                        address: buffer,
                        old: filled(6, 0),
                        new: Array.from('hello\n', (c) => c.charCodeAt(0))
                    }
                }
            ])
            const after = emulator.runtime.getRegisterSnapshot()
            expect(after).not.toEqual(registers)
            expect(() => emulator.undo()).toThrow('cannot be undone')
            expect(read(emulator, buffer, 16)).toEqual([
                ...Array.from('hello\n', (c) => c.charCodeAt(0)),
                ...filled(10, 0)
            ])
            expect(emulator.runtime.getRegisterSnapshot()).toEqual(after)
        } finally {
            emulator.dispose()
        }
    })
})

describe('string instructions over more than sixteen elements', () => {
    /** 1000 distinct qwords in .data, and 1000 more after them. */
    const DATA = [
        `values: dq ${Array.from({ length: 1000 }, (_, i) => `0x${(0x1000 + i).toString(16)}`).join(', ')}`,
        'more: times 1000 dq 7'
    ]
    const original = (count: number, offset = 0) =>
        qwords(Array.from({ length: count }, (_, i) => BigInt(0x1000 + offset + i)))

    it.each([17, 50, 1000])('undoes rep stosq over %i qwords of .data', async (count) => {
        const lines = program(
            [
                '  lea rdi, [rel values]',
                `  mov ecx, ${count}`,
                '  mov rax, -1',
                '  rep stosq ; <-- step'
            ],
            { data: DATA }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const values = emulator.getRegisterValue('rdi')
            // .data is read first, which is what a debugger showing it does.
            expect(read(emulator, values, count * 8)).toEqual(original(count))
            expect(await expectUndoableWrite(emulator, values, original(count))).toEqual(
                filled(count * 8, 0xff)
            )
            expect(emulator.getRegisterValue('rcx')).toBe(0n)
            expect(emulator.getRegisterValue('rdi')).toBe(values + BigInt(count * 8))
        } finally {
            emulator.dispose()
        }
    })

    it.each([17, 50, 1000])('undoes rep stosq over %i qwords of untouched .bss', async (count) => {
        const lines = program(
            [
                '  lea rdi, [rel area]',
                `  mov ecx, ${count}`,
                '  mov rax, 0x5555aaaa5555aaaa',
                '  rep stosq ; <-- step'
            ],
            { bss: ['area: resq 1000'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const area = emulator.getRegisterValue('rdi')
            const after = await expectUndoableWrite(emulator, area, filled(count * 8, 0))
            expect(after).toEqual(qwords(new Array<bigint>(count).fill(0x5555aaaa5555aaaan)))
        } finally {
            emulator.dispose()
        }
    })

    it('undoes rep movsq over 1000 qwords from .data into untouched .bss', async () => {
        const lines = program(
            [
                '  lea rsi, [rel values]',
                '  lea rdi, [rel area]',
                '  mov ecx, 1000',
                '  rep movsq ; <-- step'
            ],
            { data: DATA, bss: ['area: resq 1000'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const area = emulator.getRegisterValue('rdi')
            expect(await expectUndoableWrite(emulator, area, filled(8000, 0))).toEqual(
                original(1000)
            )
        } finally {
            emulator.dispose()
        }
    })

    it.each([
        ['stosw', 2],
        ['stosd', 4]
    ])('undoes rep %s over 300 elements', async (instruction, width) => {
        const lines = program(
            [
                '  lea rdi, [rel values]',
                '  mov ecx, 300',
                '  mov rax, -1',
                `  rep ${instruction} ; <-- step`
            ],
            { data: DATA }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const values = emulator.getRegisterValue('rdi')
            const before = read(emulator, values, 300 * width)
            expect(await expectUndoableWrite(emulator, values, before)).toEqual(
                filled(300 * width, 0xff)
            )
        } finally {
            emulator.dispose()
        }
    })

    it('undoes rep movsq copying upward over its own source, as an overlapping copy smears', async () => {
        const lines = program(
            [
                '  lea rsi, [rel values]',
                '  lea rdi, [rel values + 8]',
                '  mov ecx, 100',
                '  rep movsq ; <-- step'
            ],
            { data: DATA }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const destination = emulator.getRegisterValue('rdi')
            const before = read(emulator, destination, 800)
            // Each element copies the one it wrote last: the first value, a hundred times.
            expect(await expectUndoableWrite(emulator, destination, before)).toEqual(
                qwords(new Array<bigint>(100).fill(0x1000n))
            )
        } finally {
            emulator.dispose()
        }
    })

    it('undoes std; rep movsq copying downward over its own source, as memmove does', async () => {
        const lines = program(
            [
                '  lea rsi, [rel values + 8 * 99] ; the last of 100 qwords',
                '  lea rdi, [rel values + 8 * 149] ; 50 qwords higher',
                '  mov ecx, 100',
                '  std',
                '  rep movsq ; <-- step',
                '  cld'
            ],
            { data: DATA }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const lowest = emulator.getRegisterValue('rdi') - 99n * 8n
            const before = read(emulator, lowest, 800)
            expect(before).toEqual(original(100, 50))
            // values[50..149] = the old values[0..99]: memmove's result.
            expect(await expectUndoableWrite(emulator, lowest, before)).toEqual(original(100))
            expect(emulator.getRegisterValue('rdi')).toBe(lowest - 8n)
        } finally {
            emulator.dispose()
        }
    })

    it.each([
        ['zeros of untouched .bss', false],
        ['the file bytes of untouched .data', true]
    ])('undoes std; rep stosq downward across a page boundary, over %s', async (_, data) => {
        const lines = program(
            [
                `  lea rbx, [rel ${data ? 'values' : 'area'}]`,
                '  lea rdi, [rbx + 4096 + 1024]',
                '  and rdi, -4096',
                '  add rdi, 8 * 10 ; ten qwords above a page boundary, ninety below',
                '  mov ecx, 100',
                '  mov rax, 0x0102030405060708',
                '  std',
                '  rep stosq ; <-- step',
                '  cld'
            ],
            data ? { data: DATA } : { bss: ['area: resb 4 * 4096'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const lowest = emulator.getRegisterValue('rdi') - 99n * 8n
            const offset = Number(lowest - emulator.getRegisterValue('rbx'))
            const before = data ? original(1000).slice(offset, offset + 800) : filled(800, 0)
            expect(await expectUndoableWrite(emulator, lowest, before)).toEqual(
                qwords(new Array<bigint>(100).fill(0x0102030405060708n))
            )
        } finally {
            emulator.dispose()
        }
    })

    it('undoes std; rep stosb, which Blink stores a byte at a time', async () => {
        const bytes = Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff)
        const lines = program(
            [
                '  lea rdi, [rel area + 299]',
                '  mov ecx, 300',
                '  mov al, 0xee',
                '  std',
                '  rep stosb ; <-- step',
                '  cld'
            ],
            { data: [`area: db ${bytes.join(', ')}`] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const area = emulator.getRegisterValue('rdi') - 299n
            expect(await expectUndoableWrite(emulator, area, bytes)).toEqual(filled(300, 0xee))
        } finally {
            emulator.dispose()
        }
    })
})

describe('memory the debugger cannot read back', () => {
    // Blink's own mmap() puts anonymous pages at 0x80000000, inside the range the bridge refuses
    // as ASan shadow memory. A store there is captured, but what it left cannot be read back, and
    // undo would write back through the same refused lookup, so the step must report itself
    // irreversible: offered as undoable, its undo threw, and a debugger counts on canUndo().
    it("leaves stores into mmap'd memory irreversible, the first and later ones, and other pages undoable", async () => {
        const lines = program(
            [
                '  mov eax, 9 ; mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS)',
                '  xor edi, edi',
                '  mov esi, 4096',
                '  mov edx, 3',
                '  mov r10d, 0x22',
                '  mov r8, -1',
                '  xor r9d, r9d',
                '  syscall',
                '  mov rbx, rax',
                '  mov qword [rbx], 1 ; <-- step',
                '  mov qword [rbx + 8], 2',
                '  lea rcx, [rel cell]',
                '  mov qword [rcx], 3'
            ],
            { bss: ['cell: resq 1'] }
        )
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            expect(emulator.getRegisterValue('rbx')).toBeGreaterThanOrEqual(0x7fff8000n)
            await emulator.step()
            expect(emulator.canUndo()).toBe(false)
            await emulator.step()
            expect(emulator.canUndo()).toBe(false)
            await emulator.step()
            await emulator.step()
            expect(emulator.canUndo()).toBe(true)
            const cell = emulator.getRegisterValue('rcx')
            expect(read(emulator, cell, 8)).toEqual([3, 0, 0, 0, 0, 0, 0, 0])

            // Undo while canUndo() allows takes back the lea and the store into .bss, and stops
            // at the store into the mmap'd page without throwing.
            let undone = 0
            expect(() => {
                while (emulator.canUndo()) {
                    emulator.undo()
                    undone += 1
                }
            }).not.toThrow()
            expect(undone).toBe(2)
            expect(read(emulator, cell, 8)).toEqual(filled(8, 0))
        } finally {
            emulator.dispose()
        }
    })
})

describe('a string instruction that faults part way', () => {
    it('lists what it wrote before the fault, with the bytes it replaced, and stays irreversible', async () => {
        // A downward run grows its record in place at the end of the journal;
        // the faulting element's record then moves it back beside the others.
        const values = Array.from({ length: 10 }, (_, i) => 0x1111111111111111n * BigInt(i + 1))
        const lines = [
            'bits 64',
            'global _start',
            'section .data',
            'act: dq handler, 0x04000004, restorer, 0',
            `values: dq ${values.map((value) => `0x${value.toString(16)}`).join(', ')}`,
            'section .bss align=4096',
            'pages: resb 3 * 4096',
            'section .text',
            '_start:',
            '  mov eax, 13 ; rt_sigaction(SIGSEGV, &act, NULL, 8)',
            '  mov edi, 11',
            '  lea rsi, [rel act]',
            '  xor edx, edx',
            '  mov r10d, 8',
            '  syscall',
            '  lea rbx, [rel pages + 4096] ; the middle page',
            '  mov eax, 11 ; munmap(the page below it)',
            '  lea rdi, [rbx - 4096]',
            '  mov esi, 4096',
            '  syscall',
            '  mov rdi, rbx',
            '  lea rsi, [rel values]',
            '  mov ecx, 10',
            '  rep movsq',
            '  lea rdi, [rbx + 8 * 9] ; down over the ten values, then into the unmapped page',
            '  mov ecx, 20',
            '  mov rax, -1',
            '  std',
            '  rep stosq ; <-- step',
            'after:',
            '  cld',
            ...EXIT,
            'handler:',
            '  lea rax, [rel after]',
            '  mov [rdx + 40 + 16 * 8], rax',
            '  ret',
            'restorer:',
            '  mov eax, 15',
            '  syscall'
        ]
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const page = emulator.getRegisterValue('rbx')
            await emulator.step()
            expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(
                lineOf(lines, 'handler:') + 1
            )
            expect(emulator.canUndo()).toBe(false)
            const [run, fault] = memoryMutations(emulator)
            expect(run).toEqual({
                type: 'WriteMemoryBytes',
                value: { address: page, old: qwords(values), new: filled(80, 0xff) }
            })
            expect(fault).toEqual({
                type: 'Other',
                value: `Wrote 8 bytes to 0x${(page - 8n).toString(16)}`
            })
        } finally {
            emulator.dispose()
        }
    })
})

describe('the 64 KiB a step can capture', () => {
    const stosq = (count: number, down: boolean) =>
        program(
            [
                `  lea rdi, [rel area${down ? ` + 8 * ${count - 1}` : ''}]`,
                `  mov ecx, ${count}`,
                '  mov rax, -1',
                ...(down ? ['  std'] : []),
                '  rep stosq ; <-- step',
                '  cld'
            ],
            { bss: ['area: resq 9000'] }
        )

    it.each([false, true])('undoes exactly 64 KiB of rep stosq (downward: %s)', async (down) => {
        const lines = stosq(KiB64 / 8, down)
        const emulator = await start(lines)
        try {
            await stepToMarked(emulator, lines)
            const area = emulator.getRegisterValue('rdi') - (down ? BigInt(KiB64 - 8) : 0n)
            expect(await expectUndoableWrite(emulator, area, filled(KiB64, 0))).toEqual(
                filled(KiB64, 0xff)
            )
        } finally {
            emulator.dispose()
        }
    })

    it.each([false, true])(
        'leaves rep stosq over more than 64 KiB irreversible (downward: %s)',
        async (down) => {
            const count = KiB64 / 8 + 1
            const lines = stosq(count, down)
            const emulator = await start(lines)
            try {
                await stepToMarked(emulator, lines)
                const area =
                    emulator.getRegisterValue('rdi') - (down ? BigInt((count - 1) * 8) : 0n)
                const depth = emulator.getUndoHistory(100).length
                await emulator.step()
                expect(emulator.getRegisterValue('rcx')).toBe(0n)
                expect(read(emulator, area, count * 8)).toEqual(filled(count * 8, 0xff))
                expect(emulator.getUndoHistory(100)).toHaveLength(depth + 1)
                expect(emulator.canUndo()).toBe(false)
                expect(() => emulator.undo()).toThrow(/cannot be undone/)
                // The first 64 KiB, in the direction of the string, are one record
                // with both sides; the rest is only counted.
                const captured = down ? area + 8n : area
                const rest = down ? area : area + BigInt(KiB64)
                expect(memoryMutations(emulator)).toEqual([
                    {
                        type: 'WriteMemoryBytes',
                        value: {
                            address: captured,
                            old: filled(KiB64, 0),
                            new: filled(KiB64, 0xff)
                        }
                    },
                    { type: 'Other', value: `Wrote 8 bytes to 0x${rest.toString(16)}` }
                ])
                // The refused undo changed nothing.
                expect(read(emulator, area, count * 8)).toEqual(filled(count * 8, 0xff))
                expect(emulator.getRegisterValue('rcx')).toBe(0n)
            } finally {
                emulator.dispose()
            }
        }
    )
})

// The journal pages memory in before the write it records, so the write meets
// a page that is already resident. Faults must not notice: a store into a
// read-only page still raises SEGV_ACCERR, a store to nothing SEGV_MAPERR,
// each at the address and REP count the hardware reports.
const NATIVE = process.platform === 'linux' && process.arch === 'x64'
let scratch: string | undefined
afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
})

function runNatively(executable: Uint8Array): Uint8Array {
    scratch ??= mkdtempSync(join(tmpdir(), 'x86-undo-capture-'))
    const path = join(scratch, 'program')
    writeFileSync(path, executable)
    chmodSync(path, 0o755)
    const result = spawnSync(path, [], { timeout: 5000 })
    if (result.error) throw result.error
    expect(result.signal, result.stderr.toString()).toBeNull()
    expect(result.status, result.stderr.toString()).toBe(0)
    return Uint8Array.from(result.stdout)
}

function words(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: bytes.length / 8 }, (_, index) =>
        view.getBigUint64(index * 8, true)
    )
}

/**
 * Four faulting stores, each into memory never touched before: an anonymous
 * page made read-only, an unmapped page, .rodata, and a `rep stosq` running
 * from a writable page into an unmapped one. The SIGSEGV handler records the
 * signal, si_code, si_addr less the address expected, and RCX, then resumes
 * after the store. (A string store into a read-only page is left out: Blink
 * checks write permission only for ModRM stores, so STOS, MOVS and PUSH write
 * read-only pages without faulting, with or without this journal.)
 */
const FAULTS = [
    'bits 64',
    'global _start',
    'section .rodata',
    'constants: times 2 * 4096 db 0x11',
    'section .data',
    'act: dq handler, 0x04000004, restorer, 0 ; SA_SIGINFO | SA_RESTORER',
    'section .bss',
    'results: resq 16',
    'section .text',
    '_start:',
    '  mov eax, 13 ; rt_sigaction(SIGSEGV, &act, NULL, 8)',
    '  mov edi, 11',
    '  lea rsi, [rel act]',
    '  xor edx, edx',
    '  mov r10d, 8',
    '  syscall',
    '  mov eax, 9 ; mmap(NULL, 4 pages, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS)',
    '  xor edi, edi',
    '  mov esi, 4 * 4096',
    '  mov edx, 3',
    '  mov r10d, 0x22',
    '  mov r8, -1',
    '  xor r9d, r9d',
    '  syscall',
    '  mov r15, rax',
    '  mov eax, 10 ; mprotect(the second page, PROT_READ)',
    '  lea rdi, [r15 + 4096]',
    '  mov esi, 4096',
    '  mov edx, 1',
    '  syscall',
    '  mov eax, 11 ; munmap(the fourth page)',
    '  lea rdi, [r15 + 3 * 4096]',
    '  mov esi, 4096',
    '  syscall',
    '  xor r13d, r13d ; the fault being recorded',
    '  lea r14, [r15 + 4096 + 16]',
    '  lea r12, [rel after_readonly]',
    '  mov ecx, 1',
    '  mov qword [r14], 1',
    'after_readonly:',
    '  lea r14, [r15 + 3 * 4096 + 24]',
    '  lea r12, [rel after_unmapped]',
    '  mov ecx, 2',
    '  mov qword [r14], 2',
    'after_unmapped:',
    '  lea r14, [rel constants + 4096 + 8]',
    '  lea r12, [rel after_rodata]',
    '  mov ecx, 3',
    '  mov qword [r14], 3',
    'after_rodata:',
    '  lea rdi, [r15 + 3 * 4096 - 8 * 5] ; five qwords before the unmapped page',
    '  lea r14, [r15 + 3 * 4096]',
    '  lea r12, [rel after_string]',
    '  mov ecx, 20',
    '  xor eax, eax',
    '  rep stosq',
    'after_string:',
    '  mov eax, 1',
    '  mov edi, 1',
    '  lea rsi, [rel results]',
    '  mov edx, 16 * 8',
    '  syscall',
    ...EXIT,
    'handler: ; (signal, siginfo, ucontext)',
    '  mov r8, [rdx + 40 + 5 * 8] ; the saved r13',
    '  shl r8, 5',
    '  lea r9, [rel results]',
    '  add r9, r8',
    '  mov [r9], rdi',
    '  movsxd rax, dword [rsi + 8]',
    '  mov [r9 + 8], rax',
    '  mov rax, [rsi + 16]',
    '  sub rax, [rdx + 40 + 6 * 8] ; less the saved r14',
    '  mov [r9 + 16], rax',
    '  mov rax, [rdx + 40 + 14 * 8] ; the saved rcx',
    '  mov [r9 + 24], rax',
    '  inc qword [rdx + 40 + 5 * 8]',
    '  mov rax, [rdx + 40 + 4 * 8] ; resume at the saved r12',
    '  mov [rdx + 40 + 16 * 8], rax',
    '  ret',
    'restorer:',
    '  mov eax, 15',
    '  syscall'
]

const SIGSEGV = 11n
const SEGV_MAPERR = 1n
const SEGV_ACCERR = 2n

describe('faults on memory the journal paged in', () => {
    it('raise what they raise natively, at the same address and REP count', async () => {
        const expected = [
            [SIGSEGV, SEGV_ACCERR, 0n, 1n],
            [SIGSEGV, SEGV_MAPERR, 0n, 2n],
            [SIGSEGV, SEGV_ACCERR, 0n, 3n],
            [SIGSEGV, SEGV_MAPERR, 0n, 15n] // the sixth of twenty qwords faulted
        ].flat()
        const output: number[] = []
        const emulator = await createX86Emulator({
            callbacks: { stdout: (chunk) => void output.push(...chunk) }
        })
        try {
            const build = await emulator.compile(FAULTS.join('\n'))
            expect(build.ok, build.report).toBe(true)
            if (NATIVE) {
                const executable = Uint8Array.from(
                    emulator.module.FS.readFile('/program') as Uint8Array
                )
                expect(words(runNatively(executable)), 'natively').toEqual(expected)
            }
            emulator.initialize(64)
            for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice += 1)
                await emulator.run(100_000)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            expect(
                words(Uint8Array.from(output.slice(-expected.length * 8))),
                'in the Core'
            ).toEqual(expected)
        } finally {
            emulator.dispose()
        }
    })
})
