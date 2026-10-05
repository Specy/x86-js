// getRecordedEntryCount(): every entry the history records, counted once.
//
// The undo depth says how many entries undo can reach, which stops growing once
// the history is full and falls back on undo, on the undo floor and as the
// history hollows its oldest entries. A debugger that wants to know how many
// instructions a run executed takes the difference of this count instead: the
// wasm hands every entry a serial one higher than the last, and nothing ever
// takes one back.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

async function start(lines: string[], capacity = 100): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(lines.join('\n'))
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    return emulator
}

const lineOf = (lines: string[], text: string) => lines.findIndex((line) => line.trim() === text)

/** 1 + 2 × 10 + 3 = 24 instructions to the exit. */
const COUNTDOWN = [
    'bits 64',
    'global _start',
    'section .text',
    '_start:',
    '    mov ecx, 10',
    'again:',
    '    dec ecx',
    '    jnz again',
    '    mov eax, 60',
    '    xor edi, edi',
    '    syscall',
]

/** Four instructions, a read of a line, then three that exit with its first byte. */
const READ_THEN_EXIT = [
    'bits 64',
    'global _start',
    'section .text',
    '_start:',
    '    xor eax, eax',
    '    xor edi, edi',
    '    lea rsi, [rel buffer]',
    '    mov edx, 8',
    '    syscall',
    '    movzx edi, byte [rel buffer]',
    '    mov eax, 60',
    '    syscall',
    'section .bss',
    'buffer: resb 8',
]

/**
 * Installs a SIGTRAP handler and traps into it with int3: six instructions to
 * set up, the int3, the handler's two, the restorer's two (rt_sigreturn), and
 * three that exit with what the handler counted in memory (rt_sigreturn puts
 * the registers back): 14 in all.
 */
const TRAP = [
    'bits 64',
    'global _start',
    'section .data',
    'act: dq handler, 0x04000004, restorer, 0',
    'hits: dq 0',
    'section .text',
    '_start:',
    '    mov eax, 13',
    '    mov edi, 5',
    '    lea rsi, [rel act]',
    '    xor edx, edx',
    '    mov r10d, 8',
    '    syscall',
    '    int3',
    '    mov eax, 60',
    '    mov edi, [rel hits]',
    '    syscall',
    'handler:',
    '    inc qword [rel hits]',
    '    ret',
    'restorer:',
    '    mov eax, 15',
    '    syscall',
]

/** Runs `emulator` the way a debugger does, returning how many entries each `run()` recorded. */
async function runRecording(emulator: X86Emulator): Promise<number[]> {
    const counts: number[] = []
    for (let call = 0; call < 50 && !emulator.hasTerminated(); call += 1) {
        const before = emulator.getRecordedEntryCount()
        await emulator.run()
        counts.push(emulator.getRecordedEntryCount() - before)
    }
    return counts
}

/** Single-steps `twin`, the same program, to the state `target` is in; returns the steps it took. */
async function stepsTo(twin: X86Emulator, target: X86Emulator): Promise<number> {
    const state = (emulator: X86Emulator) =>
        JSON.stringify([emulator.runtime.getRegisterSnapshot(), emulator.hasTerminated()], (_, value) =>
            typeof value === 'bigint' ? value.toString() : value,
        )
    let steps = 0
    while (state(twin) !== state(target)) {
        if (steps++ > 1000) throw new Error('the twin never reached the state')
        await twin.step()
    }
    return steps
}

describe('the recorded entry count', () => {
    it('counts each instruction once, and undo takes nothing back', async () => {
        const emulator = await start(COUNTDOWN)
        try {
            const start = emulator.getRecordedEntryCount()
            for (let step = 0; step < 5; step += 1) await emulator.step()
            expect(emulator.getRecordedEntryCount()).toBe(start + 5)
            emulator.undo()
            emulator.undo()
            emulator.undo()
            expect(emulator.getUndoDepth()).toBe(2)
            expect(emulator.getRecordedEntryCount()).toBe(start + 5)
            await emulator.step()
            expect(emulator.getRecordedEntryCount()).toBe(start + 6)
        } finally {
            emulator.dispose()
        }
    })

    it('goes on counting once the history is full', async () => {
        const emulator = await start(COUNTDOWN, 4)
        try {
            const start = emulator.getRecordedEntryCount()
            expect(await runRecording(emulator)).toEqual([24])
            expect(emulator.getUndoDepth()).toBe(4)
            expect(emulator.getRecordedEntryCount()).toBe(start + 24)
        } finally {
            emulator.dispose()
        }
    })

    it('goes on counting while the history hollows entries to keep its byte budget', async () => {
        const emulator = await start([
            'bits 64',
            'global _start',
            'section .bss',
            'area: resq 8192',
            'section .text',
            '_start:',
            '    mov r12d, 5',
            'again:',
            '    lea rdi, [rel area]',
            '    mov ecx, 8192',
            '    mov rax, r12',
            '    rep stosq',
            '    dec r12d',
            '    jnz again',
            '    mov eax, 60',
            '    xor edi, edi',
            '    syscall',
        ])
        try {
            // The test-only export: a 300 KiB budget holds one 64 KiB clear's packet, not two.
            const exports = emulator.module.wasmExports as unknown as Record<string, (bytes: number) => number>
            exports.blinkenlib_history_budget!(300 * 1024)
            const start = emulator.getRecordedEntryCount()
            expect(await runRecording(emulator)).toEqual([1 + 6 * 5 + 3])
            expect(emulator.getUndoDepth()).toBe(1 + 6 * 5 + 3)
            expect(emulator.getRecordedEntryCount()).toBe(start + 34)
        } finally {
            emulator.dispose()
        }
    })

    it('goes on counting while undo is off, and does not start over when it is turned back on', async () => {
        const emulator = await start(COUNTDOWN)
        try {
            const start = emulator.getRecordedEntryCount()
            emulator.setUndoEnabled(false)
            for (let step = 0; step < 3; step += 1) await emulator.step()
            expect(emulator.getUndoDepth()).toBe(0)
            expect(emulator.getRecordedEntryCount()).toBe(start + 3)
            emulator.setUndoEnabled(true)
            await emulator.step()
            expect(emulator.getUndoDepth()).toBe(1)
            expect(emulator.getRecordedEntryCount()).toBe(start + 4)
        } finally {
            emulator.dispose()
        }
    })

    it('counts a Poke that changes something once, and one that changes nothing not at all', async () => {
        const emulator = await start(COUNTDOWN)
        try {
            await emulator.step()
            const cell = emulator.getRegisterValue('rsp') // the stack page the program runs on
            const start = emulator.getRecordedEntryCount()

            emulator.beginPoke()
            emulator.writeMemoryBytes(cell, Uint8Array.of(1, 2, 3))
            emulator.writeMemoryBytes(cell + 8n, Uint8Array.of(4))
            expect(emulator.endPoke()).toBe(true)
            expect(emulator.getRecordedEntryCount()).toBe(start + 1)

            emulator.beginPoke()
            expect(emulator.endPoke()).toBe(false)
            emulator.beginPoke()
            emulator.writeMemoryBytes(cell, Uint8Array.of(1, 2, 3))
            expect(emulator.endPoke()).toBe(false)
            expect(emulator.getRecordedEntryCount()).toBe(start + 1)
        } finally {
            emulator.dispose()
        }
    })

    it('stands still while initialize(0) records nothing, and survives initialize() and a new build', async () => {
        const emulator = await start(COUNTDOWN)
        try {
            for (let step = 0; step < 3; step += 1) await emulator.step()
            const recorded = emulator.getRecordedEntryCount()
            expect(recorded).toBeGreaterThanOrEqual(3)

            emulator.initialize(0)
            await emulator.step()
            await emulator.run()
            expect(emulator.hasTerminated()).toBe(true)
            expect(emulator.getRecordedEntryCount()).toBe(recorded)

            expect((await emulator.compile(COUNTDOWN.join('\n'))).ok).toBe(true)
            emulator.initialize(100)
            expect(emulator.getRecordedEntryCount()).toBe(recorded)
            await emulator.step()
            expect(emulator.getRecordedEntryCount()).toBe(recorded + 1)
        } finally {
            emulator.dispose()
        }
    })
})

describe('the count across a run', () => {
    it('is the instructions a run executed up to its limit, a breakpoint and the exit', async () => {
        const emulator = await start(COUNTDOWN)
        try {
            const count = () => emulator.getRecordedEntryCount()
            let before = count()
            expect(await emulator.run(7)).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason?.kind).toBe('limit')
            expect(count() - before).toBe(7)

            before = count()
            await emulator.run(undefined, [lineOf(COUNTDOWN, 'mov eax, 60')], { skipBreakpointAtPc: false })
            expect(emulator.stopReason?.kind).toBe('breakpoint')
            expect(count() - before).toBe(1 + 2 * 10 - 7)

            before = count()
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            expect(count() - before).toBe(3)
        } finally {
            emulator.dispose()
        }
    })

    it('counts a read that waited for input once, when the input finishes it', async () => {
        const emulator = await start(READ_THEN_EXIT)
        try {
            const count = () => emulator.getRecordedEntryCount()
            let before = count()
            expect(await emulator.run()).toBe(EmulatorStatus.WaitingForInput)
            expect(count() - before).toBe(4)

            before = count()
            emulator.provideInput('A\n')
            expect(count() - before).toBe(1)

            before = count()
            expect(await emulator.run(undefined, [], { skipBreakpointAtPc: false })).toBe(EmulatorStatus.Terminated)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 65 })
            expect(count() - before).toBe(3)
        } finally {
            emulator.dispose()
        }
    })

    it('counts what a run executed when it hands a signal to a handler and comes back early', async () => {
        const emulator = await start(TRAP)
        const twin = await start(TRAP)
        try {
            const calls: Array<{ recorded: number; stepped: number; status: EmulatorStatus }> = []
            for (let call = 0; call < 50 && !emulator.hasTerminated(); call += 1) {
                const before = emulator.getRecordedEntryCount()
                const status = await emulator.run()
                const recorded = emulator.getRecordedEntryCount() - before
                calls.push({ recorded, stepped: await stepsTo(twin, emulator), status })
            }
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 1 })
            // A run comes back as soon as it has handed the signal over, still running, with
            // nothing to say why; the next goes on from the handler.
            expect(calls.length).toBeGreaterThan(1)
            expect(calls[0]).toMatchObject({ status: EmulatorStatus.Running })
            for (const call of calls) expect(call.recorded).toBe(call.stepped)
            expect(calls.reduce((total, call) => total + call.recorded, 0)).toBe(14)
        } finally {
            emulator.dispose()
            twin.dispose()
        }
    })
})
