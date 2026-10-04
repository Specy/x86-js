import { describe, expect, it, vi } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import type { StopReason, X86RegisterName } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

/**
 * Runs, breakpoints, steps and undo in the orders a debugger issues them, at
 * an undo size of 0 and of 16. With no history, `runUntilBlocked()` hands the
 * run to the runtime's own loop, which used to wait for ever on a program a
 * step or an undo had left running.
 */
const SOURCE = [
    'bits 64',
    'global _start',
    'section .text',
    '_start:',
    '    xor ebx, ebx',
    '    mov ecx, 3',
    'again:',
    '    call bump',
    '    dec ecx',
    '    jnz again',
    '    mov eax, 60',
    '    mov edi, ebx',
    '    syscall',
    'bump:',
    '    inc ebx',
    '    ret',
].join('\n')

function lineOf(source: string, text: string): number {
    const line = source.split('\n').findIndex((candidate) => candidate.trim() === text)
    if (line < 0) throw new Error(`No line reads ${text}`)
    return line
}

const MOV_ECX = lineOf(SOURCE, 'mov ecx, 3')
const CALL = lineOf(SOURCE, 'call bump')
const DEC = lineOf(SOURCE, 'dec ecx')
const BUMP = lineOf(SOURCE, 'inc ebx')
const RET = lineOf(SOURCE, 'ret')
/** Two instructions before the loop, five a pass through it, three to exit. */
const TO_EXIT = 20

async function build(source: string, undoSize: number, output?: number[]): Promise<X86Emulator> {
    const emulator = await createX86Emulator(
        output ? { callbacks: { stdout: (charCode) => void output.push(charCode) } } : {},
    )
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(undoSize)
    return emulator
}

/** Awaits one call, failing in seconds rather than at the suite's timeout when it never settles. */
async function settle<T>(promise: Promise<T>, what: string, ms = 10_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}

type Expected = {
    status: EmulatorStatus
    /** Matched field by field; null when nothing stopped the program. */
    stop: Partial<StopReason> | null
    line?: number
    registers?: Partial<Record<X86RegisterName, bigint>>
    /** Instructions a history would hold: all executed, less those undone. */
    recorded: number
    /** The frames a recording history tracks; there are none without one. */
    frames: string[]
}

function expectAt(emulator: X86Emulator, undoSize: number, expected: Expected): void {
    expect(emulator.getStatus()).toBe(expected.status)
    if (expected.stop === null) expect(emulator.stopReason).toBeNull()
    else expect(emulator.stopReason).toMatchObject(expected.stop)
    if (expected.line !== undefined) {
        expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(expected.line)
    }
    for (const [register, value] of Object.entries(expected.registers ?? {})) {
        expect(emulator.getRegisterValue(register as X86RegisterName), register).toBe(value)
    }
    const recorded = Math.min(expected.recorded, undoSize)
    expect(emulator.getUndoHistory(100)).toHaveLength(recorded)
    expect(emulator.canUndo()).toBe(recorded > 0)
    expect(emulator.getCallStack().map((frame) => frame.name)).toEqual(undoSize ? expected.frames : [])
}

type Drive = { emulator: X86Emulator; undoSize: number }

async function stopAtBump({ emulator, undoSize }: Drive, rbx: bigint, rcx: bigint, recorded: number) {
    expect(await settle(emulator.run(undefined, [BUMP]), 'run to the breakpoint')).toBe(EmulatorStatus.Running)
    expectAt(emulator, undoSize, {
        status: EmulatorStatus.Running,
        stop: { kind: 'breakpoint', lineNumber: BUMP },
        line: BUMP,
        registers: { rbx, rcx },
        recorded,
        frames: ['bump'],
    })
}

async function stepOnce(drive: Drive, expected: Omit<Expected, 'status' | 'stop'>) {
    expect(await settle(drive.emulator.step(), 'step()')).toEqual({ terminated: false })
    expectAt(drive.emulator, drive.undoSize, { status: EmulatorStatus.Running, stop: null, ...expected })
}

async function runToExit({ emulator, undoSize }: Drive, run = () => emulator.run()) {
    expect(await settle(run(), 'run to the exit')).toBe(EmulatorStatus.Terminated)
    expectAt(emulator, undoSize, {
        status: EmulatorStatus.Terminated,
        stop: { kind: 'exit', exitCode: 3 },
        registers: { rbx: 3n, rcx: emulator.getPc() + 2n },
        recorded: TO_EXIT,
        frames: [],
    })
}

const SCENARIOS: Array<[string, (drive: Drive) => Promise<void>]> = [
    ['runs to the exit straight after initialize', (drive) => runToExit(drive)],
    [
        'runs to the exit after a breakpoint and a step',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stepOnce(drive, { line: RET, registers: { rbx: 1n }, recorded: 4, frames: ['bump'] })
            await runToExit(drive)
        },
    ],
    [
        'reaches the next breakpoint after a breakpoint and a step',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stepOnce(drive, { line: RET, registers: { rbx: 1n }, recorded: 4, frames: ['bump'] })
            await stopAtBump(drive, 1n, 2n, 8)
            await runToExit(drive)
        },
    ],
    [
        'continues from a breakpoint to the same breakpoint again',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stopAtBump(drive, 1n, 2n, 8)
            await stopAtBump(drive, 2n, 1n, 13)
            await runToExit(drive, () => drive.emulator.run(undefined, [BUMP]))
        },
    ],
    [
        'runs to the exit after a breakpoint, steps and an undo',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stepOnce(drive, { line: RET, registers: { rbx: 1n }, recorded: 4, frames: ['bump'] })
            await stepOnce(drive, { line: DEC, registers: { rbx: 1n }, recorded: 5, frames: [] })
            drive.emulator.undo()
            // Without a history there is nothing to undo, and nothing moves.
            expectAt(drive.emulator, drive.undoSize, {
                status: EmulatorStatus.Running,
                stop: null,
                line: drive.undoSize ? RET : DEC,
                registers: { rbx: 1n },
                recorded: 4,
                frames: ['bump'],
            })
            await runToExit(drive)
        },
    ],
    [
        'runs to the exit after steps from the entry and an undo',
        async (drive) => {
            await stepOnce(drive, { line: MOV_ECX, recorded: 1, frames: [] })
            await stepOnce(drive, { line: CALL, registers: { rcx: 3n }, recorded: 2, frames: [] })
            drive.emulator.undo()
            expectAt(drive.emulator, drive.undoSize, {
                status: EmulatorStatus.Running,
                stop: null,
                line: drive.undoSize ? MOV_ECX : CALL,
                registers: { rcx: drive.undoSize ? 0n : 3n },
                recorded: 1,
                frames: [],
            })
            await runToExit(drive)
        },
    ],
    [
        'stops for an instruction limit after a breakpoint and a step',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stepOnce(drive, { line: RET, registers: { rbx: 1n }, recorded: 4, frames: ['bump'] })
            // ret, dec ecx, jnz again: stopped before the second call.
            expect(await settle(drive.emulator.run(3), 'run(3)')).toBe(EmulatorStatus.Running)
            expectAt(drive.emulator, drive.undoSize, {
                status: EmulatorStatus.Running,
                stop: { kind: 'limit', executedInstructions: 3n, lineNumber: CALL },
                line: CALL,
                registers: { rbx: 1n, rcx: 2n },
                recorded: 7,
                frames: [],
            })
            await runToExit(drive)
        },
    ],
    [
        'runUntilBlocked reaches the exit after a breakpoint and a step',
        async (drive) => {
            await stopAtBump(drive, 0n, 3n, 3)
            await stepOnce(drive, { line: RET, registers: { rbx: 1n }, recorded: 4, frames: ['bump'] })
            await runToExit(drive, () => drive.emulator.runUntilBlocked())
        },
    ],
]

describe.each([0, 16])('with an undo size of %i', (undoSize) => {
    it.each(SCENARIOS)('%s', async (_, drive) => {
        const emulator = await build(SOURCE, undoSize)
        try {
            await drive({ emulator, undoSize })
        } finally {
            emulator.dispose()
        }
    })
})

/** Prints a prompt, reads a line and exits with its first byte, all within a few instructions. */
const READ_THEN_EXIT = [
    'bits 64',
    'global _start',
    'section .text',
    '_start:',
    '    mov eax, 1',
    '    mov edi, 1',
    '    lea rsi, [rel prompt]',
    '    mov edx, 2',
    '    syscall',
    '    xor eax, eax',
    '    xor edi, edi',
    '    lea rsi, [rel buffer]',
    '    mov edx, 8',
    '    syscall',
    '    movzx edi, byte [rel buffer]',
    '    mov eax, 60',
    '    syscall',
    'section .data',
    "prompt: db '?', 10",
    'section .bss',
    'buffer: resb 8',
].join('\n')

/**
 * Reads a byte, then spins past MAX_CYCLES before exiting with it, so the
 * runtime loop that input resumes yields to the host and is still in flight
 * when the next call comes.
 */
const READ_THEN_SPIN = [
    'bits 64',
    'global _start',
    'section .text',
    '_start:',
    '    xor eax, eax',
    '    xor edi, edi',
    '    lea rsi, [rel buffer]',
    '    mov edx, 8',
    '    syscall',
    '    mov ecx, 200000',
    'spin:',
    '    dec ecx',
    '    jnz spin',
    '    movzx edi, byte [rel buffer]',
    '    mov eax, 60',
    '    syscall',
    'section .bss',
    'buffer: resb 8',
].join('\n')

const promptsIn = (output: number[]) => String.fromCharCode(...output).split('?\n').length - 1

type NextCall = (emulator: X86Emulator) => Promise<EmulatorStatus | { terminated: boolean }>

/** The next call a debugger makes once the program has its input. */
const NEXT_CALLS: Array<[string, NextCall]> = [
    ['run', (emulator) => emulator.run(undefined, [], { skipBreakpointAtPc: false })],
    ['runUntilBlocked', (emulator) => emulator.runUntilBlocked()],
    ['step', (emulator) => emulator.step()],
]

describe('input handed to a program the runtime loop is running', () => {
    // With no history, runUntilBlocked() runs the program in the runtime's own
    // loop, and provideInput() goes on with that loop past the read.
    it.each(NEXT_CALLS)(
        'reports an exit made inside provideInput to the next %s, instead of starting the program again',
        async (_, next) => {
            const output: number[] = []
            const emulator = await build(READ_THEN_EXIT, 0, output)
            try {
                expect(await settle(emulator.runUntilBlocked(), 'run to the read')).toBe(
                    EmulatorStatus.WaitingForInput,
                )
                emulator.provideInput('A\n')
                expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 65 })

                const started = vi.spyOn(emulator.module, '_blinkenlib_starti').mockName('_blinkenlib_starti')
                const ran = vi.spyOn(emulator.module, '_blinkenlib_run').mockName('_blinkenlib_run')
                const result = await settle(next(emulator), 'the call after the input')
                expect(result).toEqual(typeof result === 'object' ? { terminated: true } : EmulatorStatus.Terminated)
                expect(started).not.toHaveBeenCalled()
                expect(ran).not.toHaveBeenCalled()
                expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 65 })
                expect(promptsIn(output)).toBe(1)
            } finally {
                vi.restoreAllMocks()
                emulator.dispose()
            }
        },
    )

    it.each(NEXT_CALLS)(
        'waits for the loop that input resumed before %s drives the program, rather than starting a second one',
        async (_, next) => {
            const emulator = await build(READ_THEN_SPIN, 0)
            try {
                expect(await settle(emulator.runUntilBlocked(), 'run to the read')).toBe(
                    EmulatorStatus.WaitingForInput,
                )
                emulator.provideInput('A\n')
                // Preempted mid-spin: the loop resumes on its own.
                expect(emulator.getStatus()).toBe(EmulatorStatus.Running)

                const continued = vi.spyOn(emulator.module, '_blinkenlib_continue').mockName('_blinkenlib_continue')
                const sliced = vi.spyOn(emulator.runtime, 'runSlice').mockName('runSlice')
                const stepped = vi.spyOn(emulator.module, '_blinkenlib_stepi').mockName('_blinkenlib_stepi')
                const resumed = vi
                    .spyOn(emulator.module, '_blinkenlib_preempt_resume')
                    .mockName('_blinkenlib_preempt_resume')
                const result = await settle(next(emulator), 'the call after the input')
                expect(result).toEqual(typeof result === 'object' ? { terminated: true } : EmulatorStatus.Terminated)
                expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 65 })
                expect(resumed).toHaveBeenCalled()
                expect(continued).not.toHaveBeenCalled()
                expect(sliced).not.toHaveBeenCalled()
                expect(stepped).not.toHaveBeenCalled()
            } finally {
                vi.restoreAllMocks()
                emulator.dispose()
            }
        },
    )
})

describe.each([0, 16])('input handed to a program run in slices, with an undo size of %i', (undoSize) => {
    it('finishes only the read, and the next run goes on to the exit', async () => {
        const output: number[] = []
        const emulator = await build(READ_THEN_EXIT, undoSize, output)
        try {
            expect(await settle(emulator.run(), 'run to the read')).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('A\n')
            expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
            expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(
                lineOf(READ_THEN_EXIT, 'movzx edi, byte [rel buffer]'),
            )
            expect(await settle(emulator.run(undefined, [], { skipBreakpointAtPc: false }), 'run on')).toBe(
                EmulatorStatus.Terminated,
            )
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 65 })
            expect(promptsIn(output)).toBe(1)
        } finally {
            emulator.dispose()
        }
    })
})
