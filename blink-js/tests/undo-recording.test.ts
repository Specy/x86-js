import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import type { X86Project } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

/**
 * A program linked the way a C toolchain links one: start code in a unit of its own, which calls
 * `main` in another. A debugger runs the start code with undo off and turns it back on at `main`,
 * so that nothing before the program's own first instruction can be undone.
 */
const COMPILED: X86Project = {
    entry: 'src/main.c.asm',
    files: {
        'src/main.c.asm': [
            'bits 64',
            'global main',
            'section .text',
            'main:',
            '    mov eax, 7',
            '    call add_five',
            '    ret',
            'add_five:',
            '    add eax, 5',
            '    ret',
        ].join('\n'),
        '@runtime/start.asm': [
            'bits 64',
            'global _start',
            'extern main',
            'section .text',
            '_start:',
            '    and rsp, -16',
            '    xor edi, edi',
            '    xor esi, esi',
            '    call main',
            '    mov edi, eax',
            '    mov eax, 60',
            '    syscall',
        ].join('\n'),
    },
}

/** From `main`'s first instruction to the exit: five in `main` and `add_five`, three after. */
const MAIN_TO_EXIT = 8
/** What `main` returns, which the start code exits with. */
const MAIN_RESULT = 12

const program = (...lines: string[]): X86Project => ({
    entry: 'main.asm',
    files: { 'main.asm': ['bits 64', 'global _start', 'section .text', '_start:', ...lines].join('\n') },
})

/** Never ends: every step records one entry. */
const LOOP = program('    inc rbx', '    jmp _start')
/** Four instructions, then the exit. */
const EXITS = program('    mov ebx, 1', '    mov eax, 60', '    xor edi, edi', '    syscall')
/** One call into a function and back. */
const CALLS = program(
    '    call outer',
    '    mov eax, 60',
    '    xor edi, edi',
    '    syscall',
    'outer:',
    '    nop',
    '    ret',
)

async function build(project: X86Project, undoSize: number): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compileProject(project)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(undoSize)
    return emulator
}

/** Steps the start code until `main` is the next instruction, and says which addresses it ran. */
async function stepIntoMain(emulator: X86Emulator): Promise<number[]> {
    const ran: number[] = []
    for (let step = 0; step < 20 && emulator.getNextInstruction()?.file !== COMPILED.entry; step++) {
        ran.push(Number(emulator.getPc()))
        await emulator.step()
    }
    expect(emulator.getNextInstruction()?.file).toBe(COMPILED.entry)
    return ran
}

/** The history as a debugger shows it. */
function history(emulator: X86Emulator) {
    return {
        depth: emulator.getUndoDepth(),
        canUndo: emulator.canUndo(),
        entries: emulator.getUndoHistory(100).length,
        frames: emulator.getCallStack().map((frame) => frame.name),
    }
}

/** Nothing undo can reach, outside any function. */
const NONE = { depth: 0, canUndo: false, entries: 0, frames: [] }
/** Nothing undo can reach, inside `main`. */
const IN_MAIN = { ...NONE, frames: ['main'] }

describe('turning undo off and back on', () => {
    it('starts undo at main, keeping the frame the call into it pushed', async () => {
        const emulator = await build(COMPILED, 100)
        try {
            emulator.setUndoEnabled(false)
            await stepIntoMain(emulator)
            // The call into `main` ran with undo off and was recorded all the same.
            expect(history(emulator)).toEqual(IN_MAIN)

            emulator.setUndoEnabled(true)
            expect(history(emulator)).toEqual(IN_MAIN)

            const resumedAt = emulator.getPc()
            const registers = emulator.getRegisterValuesRecord()
            await emulator.step()
            expect(history(emulator)).toEqual({ depth: 1, canUndo: true, entries: 1, frames: ['main'] })
            expect(emulator.getUndoHistory(1)[0]).toMatchObject({ kind: 'instruction', file: COMPILED.entry })

            emulator.undo()
            expect(emulator.getPc()).toBe(resumedAt)
            expect(emulator.getRegisterValuesRecord()).toEqual(registers)
            expect(history(emulator)).toEqual(IN_MAIN)
            // Undo stops where undo was turned on, as it stops at an empty history.
            emulator.undo()
            expect(emulator.getPc()).toBe(resumedAt)
            expect(emulator.getRegisterValuesRecord()).toEqual(registers)
            expect(history(emulator)).toEqual(IN_MAIN)
        } finally {
            emulator.dispose()
        }
    })

    it('tracks the calls main makes, and undoes back into main', async () => {
        const emulator = await build(COMPILED, 100)
        try {
            emulator.setUndoEnabled(false)
            await stepIntoMain(emulator)
            emulator.setUndoEnabled(true)
            const resumedAt = emulator.getPc()

            await emulator.step() // mov eax, 7
            await emulator.step() // call add_five
            expect(history(emulator)).toEqual({ depth: 2, canUndo: true, entries: 2, frames: ['main', 'add_five'] })
            await emulator.step() // add eax, 5
            await emulator.step() // ret
            expect(emulator.getCallStack().map((frame) => frame.name)).toEqual(['main'])
            await emulator.step() // ret, out of `main`
            expect(history(emulator)).toEqual({ depth: 5, canUndo: true, entries: 5, frames: [] })
            expect(emulator.getNextInstruction()?.file).toBe('@runtime/start.asm')

            for (let entry = 0; entry < 5; entry++) emulator.undo()
            expect(emulator.getPc()).toBe(resumedAt)
            expect(history(emulator)).toEqual(IN_MAIN)
        } finally {
            emulator.dispose()
        }
    })

    it('never lists what ran while undo was off', async () => {
        const emulator = await build(COMPILED, 100)
        try {
            emulator.setUndoEnabled(false)
            const startCode = await stepIntoMain(emulator)
            expect(emulator.getUndoHistory(100)).toEqual([])
            emulator.setUndoEnabled(true)

            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            const listed = emulator.getUndoHistory(100)
            expect(listed).toHaveLength(MAIN_TO_EXIT)
            expect(listed.filter((entry) => startCode.includes(entry.pc))).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it.each(['step', 'run'] as const)(
        'runs to the exit once undo is back on, and replays the exit through %s',
        async (drive) => {
            const emulator = await build(COMPILED, 100)
            try {
                emulator.setUndoEnabled(false)
                await stepIntoMain(emulator)
                emulator.setUndoEnabled(true)
                const resumedAt = emulator.getPc()

                expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: MAIN_RESULT })
                expect(history(emulator)).toEqual({
                    depth: MAIN_TO_EXIT,
                    canUndo: true,
                    entries: MAIN_TO_EXIT,
                    frames: [],
                })

                emulator.undo()
                expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
                expect(emulator.stopReason).toBeNull()
                expect(emulator.getNextInstruction()?.code).toContain('syscall')
                if (drive === 'step') expect(await emulator.step()).toEqual({ terminated: true })
                else expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: MAIN_RESULT })
                expect(emulator.getUndoDepth()).toBe(MAIN_TO_EXIT)

                for (let entry = 0; entry < MAIN_TO_EXIT; entry++) emulator.undo()
                expect(emulator.getPc()).toBe(resumedAt)
                expect(history(emulator)).toEqual(IN_MAIN)
            } finally {
                emulator.dispose()
            }
        },
    )

    it('puts what ran before undo was turned off out of reach as well', async () => {
        const emulator = await build(CALLS, 16)
        try {
            await emulator.step() // call outer
            expect(history(emulator)).toEqual({ depth: 1, canUndo: true, entries: 1, frames: ['outer'] })

            emulator.setUndoEnabled(false)
            expect(history(emulator)).toEqual({ ...NONE, frames: ['outer'] })
            emulator.undo()
            expect(emulator.getNextInstruction()?.code).toContain('nop')
            // The call could be undone before undo went off, and is below where it came back on.
            emulator.setUndoEnabled(true)
            expect(history(emulator)).toEqual({ ...NONE, frames: ['outer'] })

            await emulator.step() // nop
            await emulator.step() // ret
            expect(history(emulator)).toEqual({ depth: 2, canUndo: true, entries: 2, frames: [] })
            emulator.undo()
            emulator.undo()
            expect(emulator.getNextInstruction()?.code).toContain('nop')
            expect(history(emulator)).toEqual({ ...NONE, frames: ['outer'] })
        } finally {
            emulator.dispose()
        }
    })

    it('undoes nothing that ran while undo was off, however the program ran', async () => {
        const emulator = await build(EXITS, 16)
        try {
            emulator.setUndoEnabled(false)
            await emulator.step()
            expect(await emulator.run(1)).toBe(EmulatorStatus.Running)
            expect(await emulator.runUntilBlocked()).toBe(EmulatorStatus.Terminated)
            expect(history(emulator)).toEqual(NONE)
            emulator.setUndoEnabled(true)
            expect(history(emulator)).toEqual(NONE)

            // The exit ran with undo off, so undo leaves the program ended, as with nothing to undo.
            emulator.undo()
            expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
            expect(emulator.getRegisterValue('rbx')).toBe(1n)
        } finally {
            emulator.dispose()
        }
    })

    it('changes nothing when asked for the state it is already in', async () => {
        const emulator = await build(LOOP, 16)
        try {
            await emulator.run(3)
            emulator.setUndoEnabled(true)
            expect(emulator.getUndoDepth()).toBe(3)

            emulator.setUndoEnabled(false)
            await emulator.step()
            emulator.setUndoEnabled(false)
            expect(history(emulator)).toEqual(NONE)
            emulator.setUndoEnabled(true)
            await emulator.step()
            // Already on, so asking again must not put the step just taken out of reach.
            emulator.setUndoEnabled(true)
            expect(emulator.getUndoDepth()).toBe(1)
            expect(emulator.canUndo()).toBe(true)
        } finally {
            emulator.dispose()
        }
    })

    it('records nothing after initialize(0), and keeps no call stack, as before', async () => {
        const emulator = await build(COMPILED, 0)
        try {
            emulator.setUndoEnabled(false)
            await stepIntoMain(emulator)
            emulator.setUndoEnabled(true)
            await emulator.step()
            expect(history(emulator)).toEqual(NONE)
            await emulator.run(2)
            expect(history(emulator)).toEqual(NONE)
        } finally {
            emulator.dispose()
        }
    })

    it('is turned back on by initialize(), from which everything can be undone', async () => {
        const emulator = await build(LOOP, 16)
        try {
            emulator.setUndoEnabled(false)
            await emulator.run(3)
            emulator.initialize(4)
            await emulator.run(6)
            expect(emulator.getUndoDepth()).toBe(4)
            // Already on, so asking for it again keeps what was recorded.
            emulator.setUndoEnabled(true)
            expect(emulator.getUndoDepth()).toBe(4)
        } finally {
            emulator.dispose()
        }
    })

    it('refuses to turn undo off or on while a Poke is open', async () => {
        const emulator = await build(LOOP, 16)
        try {
            await emulator.step()
            emulator.beginPoke()
            expect(() => emulator.setUndoEnabled(false)).toThrow(/while a poke is open/i)
            // Asking for the state it is in is no change, so there is nothing to refuse.
            emulator.setUndoEnabled(true)
            emulator.setRegisterValue('rbx', 99n)
            expect(emulator.endPoke()).toBe(true)
            expect(emulator.getUndoDepth()).toBe(2)

            emulator.setUndoEnabled(false)
            emulator.beginPoke()
            expect(() => emulator.setUndoEnabled(true)).toThrow(/while a poke is open/i)
            expect(emulator.endPoke()).toBe(false)
            emulator.setUndoEnabled(true)
            await emulator.step()
            expect(emulator.getUndoDepth()).toBe(1)
        } finally {
            emulator.dispose()
        }
    })

    it('refuses to turn undo off while an instruction is executing', async () => {
        const emulator = await build(
            program(
                '    mov eax, 1',
                '    mov edi, 1',
                '    lea rsi, [rel message]',
                '    mov edx, 3',
                '    syscall',
                '    mov eax, 60',
                '    xor edi, edi',
                '    syscall',
                'section .data',
                'message: db "ok", 10',
            ),
            16,
        )
        const thrown: unknown[] = []
        // The write calls back into the host from inside the running instruction, which is
        // exactly when undo must not change under it.
        emulator.on('stdout', () => {
            try {
                emulator.setUndoEnabled(false)
            } catch (error) {
                thrown.push(error)
            }
        })
        try {
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            // the host hears of the write once, with its three bytes
            expect(thrown.length).toBe(1)
            for (const error of thrown) {
                expect(emulator.stringifyError(error)).toMatch(/while an instruction is executing/i)
            }
            expect(emulator.getUndoDepth()).toBe(8)
            expect(emulator.canUndo()).toBe(true)
        } finally {
            emulator.dispose()
        }
    })

    it('refuses to turn undo off or on while an instruction waits for input', async () => {
        const emulator = await build(
            program(
                '    xor eax, eax',
                '    xor edi, edi',
                '    lea rsi, [rel buffer]',
                '    mov edx, 8',
                '    syscall',
                '    mov eax, 60',
                '    xor edi, edi',
                '    syscall',
                'section .bss',
                'buffer: resb 8',
            ),
            16,
        )
        try {
            // The read is paused half way: it began with undo on and must end with it on, or
            // the entry it finishes would land on the other side of the change.
            expect(await emulator.run()).toBe(EmulatorStatus.WaitingForInput)
            expect(() => emulator.setUndoEnabled(false)).toThrow(/waiting for input/i)
            emulator.provideInput('ab\n')
            expect(emulator.getUndoDepth()).toBe(5)
            emulator.setUndoEnabled(false)
            expect(emulator.getUndoDepth()).toBe(0)
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
        } finally {
            emulator.dispose()
        }
    })
})

describe('the undo depth', () => {
    it('counts exactly what undo can reach when undo and new steps interleave', async () => {
        const emulator = await build(LOOP, 8)
        try {
            emulator.setUndoEnabled(false)
            await emulator.run(3)
            emulator.setUndoEnabled(true)
            const resumedAt = emulator.getPc()
            await emulator.step()
            await emulator.step()
            emulator.undo()
            await emulator.step()
            // The undone step's serial is never handed out again, so the newest entry is three
            // serials past where undo came back on while only two entries are.
            expect(history(emulator)).toEqual({ depth: 2, canUndo: true, entries: 2, frames: [] })

            emulator.undo()
            emulator.undo()
            expect(emulator.getPc()).toBe(resumedAt)
            expect(history(emulator)).toEqual(NONE)
        } finally {
            emulator.dispose()
        }
    })

    it.each([2, 10])(
        'stays exact as a history of 3 wraps over %i entries recorded with undo off',
        async (paused) => {
            const emulator = await build(LOOP, 3)
            try {
                emulator.setUndoEnabled(false)
                await emulator.run(paused)
                emulator.setUndoEnabled(true)
                expect(history(emulator)).toEqual(NONE)
                // The entries recorded with undo off hold slots until the new ones push them out.
                for (const depth of [1, 2, 3, 3, 3]) {
                    await emulator.step()
                    expect(emulator.getUndoDepth()).toBe(depth)
                    expect(emulator.getUndoHistory(10)).toHaveLength(depth)
                }
                for (let entry = 0; entry < 3; entry++) emulator.undo()
                expect(history(emulator)).toEqual(NONE)
            } finally {
                emulator.dispose()
            }
        },
    )

    it('counts the Pokes made since undo was turned on, and never undoes one made while it was off', async () => {
        const emulator = await build(LOOP, 16)
        try {
            await emulator.step() // inc rbx
            emulator.setUndoEnabled(false)
            emulator.beginPoke()
            emulator.setRegisterValue('rbx', 42n)
            // It applies, and is recorded, but undo can never reach it.
            expect(emulator.endPoke()).toBe(true)
            expect(history(emulator)).toEqual(NONE)
            emulator.setUndoEnabled(true)
            expect(history(emulator)).toEqual(NONE)

            emulator.beginPoke()
            emulator.setRegisterValue('rbx', 99n)
            expect(emulator.endPoke()).toBe(true)
            expect(emulator.getUndoDepth()).toBe(1)
            expect(emulator.getUndoHistory(1)[0]?.kind).toBe('poke')
            await emulator.step() // jmp _start
            expect(emulator.getUndoDepth()).toBe(2)

            emulator.undo()
            emulator.undo()
            expect(emulator.getRegisterValue('rbx')).toBe(42n)
            expect(history(emulator)).toEqual(NONE)
        } finally {
            emulator.dispose()
        }
    })
})
