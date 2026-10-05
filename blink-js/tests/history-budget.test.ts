// The undo history's byte budget.
//
// A step's history packet holds the bytes its writes replaced and the bytes
// they left, up to 64 KiB of each, and the editor keeps 200,000 steps. A loop
// clearing a 64 KiB array with `rep stosq`, as GCC compiles `int a[16384] =
// {0}`, used to fill the 2 GiB wasm heap and abort it. The packets of the
// newest entries now share a budget of 256 MiB. Over it, the oldest entries are
// hollowed: cut down to their header and marked irreversible, so undo stops at
// them as at any write it could not capture. They stay in the ring, which
// still counts one entry per step until it is full: the editor reads how many
// instructions a run executed off the history's depth.
//
// `blinkenlib_history_budget` is a test-only export of the wasm, reached through
// `wasmExports` because the package's glue does not bind it: it sets the budget
// (0 leaves it) and returns the bytes the packets hold.
import { describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const MiB = 2 ** 20
const QWORDS = 8192 // 64 KiB
/** Steps a program of `passes` passes records: two to set up, six a pass, three to exit. */
const stepsOf = (passes: number) => 2 + 6 * passes + 3

/** Each pass fills a 64 KiB area, at rbx, with its own count, from `passes` down to 1. */
function clears(passes: number): string {
    return [
        'bits 64',
        'global _start',
        'section .bss',
        `area: resq ${QWORDS}`,
        'section .text',
        '_start:',
        '  lea rbx, [rel area]',
        `  mov r12d, ${passes}`,
        'again:',
        '  lea rdi, [rel area]',
        `  mov ecx, ${QWORDS}`,
        '  mov eax, r12d',
        '  rep stosq',
        '  dec r12d',
        '  jnz again',
        '  mov eax, 60',
        '  xor edi, edi',
        '  syscall',
    ].join('\n')
}

async function start(source: string, capacity: number, budget?: number): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    if (budget) held(emulator, budget)
    return emulator
}

/** The test-only export: sets the budget when given one, and returns the bytes the packets hold. */
function held(emulator: X86Emulator, budget = 0): number {
    const exports = emulator.module.wasmExports as unknown as Record<string, (bytes: number) => number>
    return exports.blinkenlib_history_budget!(budget) >>> 0
}

async function runToExit(emulator: X86Emulator): Promise<void> {
    for (let slice = 0; slice < 1000 && !emulator.hasTerminated(); slice += 1) await emulator.run(1_000_000)
    expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
}

/** The first and last qwords of the area, which a pass fills whole. */
function areaValues(emulator: X86Emulator, area: bigint): bigint[] {
    const bytes = emulator.readMemoryBytes(area, BigInt(QWORDS * 8))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return [view.getBigUint64(0, true), view.getBigUint64(QWORDS * 8 - 8, true)]
}

/** Undoes until undo can go no further; returns how many steps that took back. */
function undoAll(emulator: X86Emulator): number {
    let undone = 0
    while (emulator.canUndo()) {
        emulator.undo()
        undone += 1
    }
    return undone
}

/** Whether the newest entry is a hollow one: still listed, with nothing left to undo. */
function newestIsHollow(emulator: X86Emulator): boolean {
    const [newest] = emulator.getUndoHistory(1)
    return !!newest && !newest.mutations.some((m) => m.type === 'WriteRegister' || m.type === 'WriteMemoryBytes')
}

describe('the undo history under its byte budget', () => {
    it("runs 3,000 clears of 64 KiB to the end with the editor's 200,000-entry history", async () => {
        const passes = 3000
        const emulator = await start(clears(passes), 200_000)
        try {
            await runToExit(emulator)
            const area = emulator.getRegisterValue('rbx')
            // Every step is still in the ring, which is how the editor counts what a run executed.
            expect(emulator.getUndoDepth()).toBe(stepsOf(passes))
            // The packets stay within the budget, so the heap stays bounded: all 3,000 passes
            // would need some 560 MiB.
            expect(held(emulator)).toBeLessThanOrEqual(256 * MiB)
            expect(emulator.module.wasmExports!.memory!.buffer.byteLength).toBeLessThan(384 * MiB)

            // The newest steps undo exactly: the exit, then a hundred whole passes.
            for (let step = 0; step < 3 + 6 * 100; step += 1) emulator.undo()
            expect(emulator.getRegisterValue('r12')).toBe(100n)
            expect(areaValues(emulator, area)).toEqual([101n, 101n])

            // Further back, undo stops at the newest hollow entry: after well over a thousand
            // passes, as many as 256 MiB of 192 KiB packets hold, but short of all of them.
            const undone = 3 + 6 * 100 + undoAll(emulator)
            expect(undone).toBeGreaterThan(6 * 1000)
            expect(undone).toBeLessThan(stepsOf(passes))
            expect(newestIsHollow(emulator)).toBe(true)
            expect(() => emulator.undo()).toThrow(/cannot be undone/)
            expect(held(emulator)).toBe(0)
        } finally {
            emulator.dispose()
        }
    }, 60_000)

    it('hollows the oldest entries first, and stops undo at the newest of them', async () => {
        // Room for two 64 KiB clears and the small steps around them, not three.
        const emulator = await start(clears(10), 1000, 512 * 1024)
        try {
            await runToExit(emulator)
            const area = emulator.getRegisterValue('rbx')
            expect(emulator.getUndoDepth()).toBe(stepsOf(10))
            expect(held(emulator)).toBeLessThanOrEqual(512 * 1024)

            // The exit, the last two passes and the end of the third: down to the third clear
            // from the end, which fit no more and was hollowed with all before it.
            expect(undoAll(emulator)).toBe(3 + 6 + 6 + 2)
            expect(emulator.getRegisterValue('r12')).toBe(3n)
            expect(areaValues(emulator, area)).toEqual([3n, 3n])
            expect(newestIsHollow(emulator)).toBe(true)
            expect(emulator.getUndoDepth()).toBe(stepsOf(10) - 17)
            expect(held(emulator)).toBe(0)

            // Steps run after that are recorded and undone as ever.
            await emulator.step()
            await emulator.step()
            expect(emulator.getRegisterValue('r12')).toBe(2n)
            expect(held(emulator)).toBeGreaterThan(0)
            emulator.undo()
            emulator.undo()
            expect(emulator.getRegisterValue('r12')).toBe(3n)
            expect(held(emulator)).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('keeps an entry larger than the whole budget, alone, until the next step', async () => {
        const emulator = await start(clears(2), 1000, 4096)
        try {
            for (let step = 0; step < 5; step += 1) await emulator.step() // up to the first rep stosq
            const area = emulator.getRegisterValue('rbx')
            await emulator.step()
            expect(held(emulator)).toBeGreaterThan(128 * 1024)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(areaValues(emulator, area)).toEqual([0n, 0n])
            // The steps before it were hollowed to make room for it.
            expect(emulator.canUndo()).toBe(false)
            expect(newestIsHollow(emulator)).toBe(true)

            await emulator.step()
            expect(areaValues(emulator, area)).toEqual([2n, 2n])
            // The next step needs room too, so the clear is hollowed in its turn.
            await emulator.step()
            expect(held(emulator)).toBeLessThanOrEqual(4096)
            emulator.undo()
            expect(emulator.canUndo()).toBe(false)
            expect(areaValues(emulator, area)).toEqual([2n, 2n])
        } finally {
            emulator.dispose()
        }
    })

    it('lists a row hollowed since it was last listed without the writes it no longer holds', async () => {
        const emulator = await start(clears(2), 1000, 4096)
        try {
            for (let step = 0; step < 6; step += 1) await emulator.step() // through the first rep stosq
            const [clear] = emulator.getUndoHistory(1)
            expect(clear!.mutations.some((mutation) => mutation.type === 'WriteMemoryBytes')).toBe(true)
            // The next step needs the room, so the clear is hollowed under the same serial.
            await emulator.step()
            const [, hollowed] = emulator.getUndoHistory(2)
            expect(hollowed!.pc).toBe(clear!.pc)
            expect(hollowed!.mutations).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it('wraps a small ring through hollow entries without losing the newest', async () => {
        // A ring of eight entries with room for one clear: every slot is reused many times,
        // some from hollow entries and some from clears' 192 KiB buffers.
        const emulator = await start(clears(20), 8, 300 * 1024)
        try {
            await runToExit(emulator)
            const area = emulator.getRegisterValue('rbx')
            expect(emulator.getUndoDepth()).toBe(8)
            expect(held(emulator)).toBeLessThanOrEqual(300 * 1024)
            // The newest eight are whole: the exit, and the last pass from its second step.
            expect(undoAll(emulator)).toBe(8)
            expect(emulator.getUndoDepth()).toBe(0)
            expect(emulator.getRegisterValue('r12')).toBe(1n)
            expect(areaValues(emulator, area)).toEqual([2n, 2n])
            expect(held(emulator)).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('frees what it holds on initialize and on a new build', async () => {
        const emulator = await start(clears(3), 1000)
        try {
            await runToExit(emulator)
            expect(held(emulator)).toBeGreaterThan(3 * 128 * 1024)
            emulator.initialize(1000)
            expect(held(emulator)).toBe(0)

            expect((await emulator.compile(clears(3))).ok).toBe(true)
            emulator.initialize(1000)
            await runToExit(emulator)
            expect(held(emulator)).toBeGreaterThan(3 * 128 * 1024)
            expect((await emulator.compile(clears(1))).ok).toBe(true)
            expect(held(emulator)).toBe(0)
        } finally {
            emulator.dispose()
        }
    })
})
