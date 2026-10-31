// The terminal follows the termios the program sets (x86-devices-plan.md, decision 12): Blink
// stores it and reports it, reads raw mode's bytes as VMIN and VTIME say on Program time, keeps
// type-ahead, shapes output under OPOST and ONLCR, turns a typed carriage return into a line feed
// under ICRNL, and takes SIGINT and SIGQUIT from the host. What each read takes, and each change
// of the termios, is journaled, so Undo follows ADR 0069: a read that waited asks again, and
// type-ahead goes back. The values are a Linux tty's; natively the probes would read a pipe, so
// they run in the Core only.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import {
    BlinkState,
    END_OF_INPUT,
    type X86Environment,
    type X86TerminalMode,
    type X86WaitRequest
} from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { probeSource, quadwords } from './linux-probe'

const EAGAIN = -11n
const O_NONBLOCK = 0x800

const CANONICAL: X86TerminalMode = {
    canonical: true,
    echo: true,
    signals: true,
    crToNl: true,
    outputProcessing: true,
    nlToCrNl: true
}

/** Turns ICANON, ECHO and ISIG off, as a game does, with VMIN and VTIME as given. */
const raw = (vmin: number, vtime: number) => [
    'sys 16, 0, 0x5401, buf2 + 1024', // TCGETS
    'and dword [buf2 + 1024 + 12], ~0xb',
    `mov byte [buf2 + 1024 + 17 + 5], ${vtime}`,
    `mov byte [buf2 + 1024 + 17 + 6], ${vmin}`,
    'sys 16, 0, 0x5402, buf2 + 1024' // TCSETS
]

async function build(
    body: readonly string[],
    environment?: X86Environment,
    tail: readonly string[] = []
): Promise<X86Emulator> {
    const emulator = await createX86Emulator(environment ? { environment } : {})
    const result = await emulator.compile(probeSource([...body, 'finish', ...tail]))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

function nextStateChange(emulator: X86Emulator): Promise<void> {
    return new Promise((resolve) => {
        const stop = emulator.on('stateChange', () => {
            stop()
            resolve()
        })
    })
}

/**
 * Runs until the program ends or a read waits for input with nothing else to end it; a wait the
 * environment settles is waited out.
 */
async function settle(emulator: X86Emulator): Promise<EmulatorStatus> {
    for (let slice = 0; slice < 100; slice++) {
        await emulator.run(1_000_000)
        while (emulator.state === BlinkState.ProgramWaitPause && !waitsForTerminalOnly(emulator))
            await nextStateChange(emulator)
        if (emulator.hasTerminated() || emulator.state !== BlinkState.ProgramRunning)
            return emulator.getStatus()
    }
    throw new Error('the probe never settled')
}

function waitsForTerminalOnly(emulator: X86Emulator): boolean {
    const request = emulator.getWaitRequest()
    return request !== null && request.deadlineNanoseconds === null && request.wakeSources.terminal
}

/** Collects what the probe wrote and the results `finish` wrote last. */
function record(emulator: X86Emulator) {
    const stdout: string[] = []
    const stderr: number[] = []
    emulator.on('stdout', (bytes) => void stdout.push(new TextDecoder().decode(bytes)))
    emulator.on('stderr', (bytes) => void stderr.push(...bytes))
    return { stdout, results: () => quadwords(Uint8Array.from(stderr)) }
}

/** A clock that only waits move, each to its deadline, in whole nanoseconds (see devices.test). */
function virtualClock(): X86Environment {
    let now = 0n
    return {
        now: () => (Number(now) + 0.5) / 1e6,
        wait: async (request) => {
            if (request.deadlineNanoseconds === null)
                throw new Error('a wait with nothing to end it')
            if (request.deadlineNanoseconds > now) now = request.deadlineNanoseconds
        }
    }
}

/** Steps until the instruction after the `count`th syscall from here is next. */
async function throughSyscall(emulator: X86Emulator, count = 1): Promise<void> {
    for (let index = 0; index < 1000; index++) {
        const isCall = emulator.getNextInstruction()?.code.toLowerCase().includes('syscall')
        await emulator.step()
        if (isCall && --count === 0) return
    }
    throw new Error('the probe did not reach the syscall')
}

describe('the termios', () => {
    it('is reported at start and at each change, and Undo puts it back', async () => {
        const emulator = await build([...raw(1, 0), 'nop'])
        try {
            const modes: X86TerminalMode[] = []
            emulator.on('terminalMode', (mode) => void modes.push(mode))
            emulator.initialize(100)
            expect(emulator.getTerminalMode()).toEqual(CANONICAL)
            await throughSyscall(emulator, 2)
            const rawMode = { ...CANONICAL, canonical: false, echo: false, signals: false }
            expect(modes).toEqual([CANONICAL, rawMode])
            expect(emulator.getTerminalMode()).toEqual(rawMode)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(emulator.getTerminalMode()).toEqual(CANONICAL)
            expect(modes.at(-1)).toEqual(CANONICAL)
            // and the next program starts canonical, whatever this one left
            await throughSyscall(emulator)
            expect(emulator.getTerminalMode()).toEqual(rawMode)
            emulator.runtime.starti()
            expect(emulator.getTerminalMode()).toEqual(CANONICAL)
            expect(modes.at(-1)).toEqual(CANONICAL)
        } finally {
            emulator.dispose()
        }
    })
})

describe('a read in raw mode', () => {
    it('takes what is queued, across lines, without waiting', async () => {
        const emulator = await build([...raw(1, 0), 'sys 0, 0, buf, 8', 'save', 'saveq buf'])
        try {
            const out = record(emulator)
            let requests = 0
            emulator.on('inputRequest', () => void requests++)
            emulator.provideInput('a\nb')
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([3n, 0x620a61n])
            expect(requests).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('with VMIN and VTIME 0 returns 0 at once on nothing, O_NONBLOCK or not', async () => {
        const emulator = await build([
            ...raw(0, 0),
            'sys 0, 0, buf, 8',
            'save',
            `sys 72, 0, 4, ${O_NONBLOCK}`,
            'sys 0, 0, buf, 8',
            'save',
            ...raw(1, 0),
            'sys 0, 0, buf, 8', // O_NONBLOCK with VMIN: EAGAIN
            'save'
        ])
        try {
            const out = record(emulator)
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([0n, 0n, EAGAIN])
        } finally {
            emulator.dispose()
        }
    })

    it('with VTIME alone waits that many tenths on Program time, then returns 0', async () => {
        const emulator = await build(
            [...raw(0, 5), 'sys 0, 0, buf, 8', 'save', 'sys 228, 1, buf2', 'saveq buf2 + 8'],
            virtualClock()
        )
        try {
            const out = record(emulator)
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([0n, 500000000n])
            expect(requests).toHaveLength(1)
            expect(requests[0]).toMatchObject({
                deadlineNanoseconds: 500000000n,
                wakeSources: { terminal: true, inputDevices: [] },
                acceptsInput: true
            })
        } finally {
            emulator.dispose()
        }
    })

    it('with VTIME alone takes a key typed while it waits', async () => {
        const emulator = await build([...raw(0, 5), 'sys 0, 0, buf, 8', 'save', 'saveq buf'], {
            now: () => 0,
            wait: () => new Promise(() => {})
        })
        try {
            const out = record(emulator)
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            emulator.provideInput('x')
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([1n, 0x78n])
        } finally {
            emulator.dispose()
        }
    })

    it('with VMIN waits for that many bytes', async () => {
        const emulator = await build([...raw(3, 0), 'sys 0, 0, buf, 8', 'save', 'saveq buf'])
        try {
            const out = record(emulator)
            emulator.provideInput('a')
            expect(await settle(emulator)).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('bc')
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([3n, 0x636261n])
        } finally {
            emulator.dispose()
        }
    })

    it('with VMIN and VTIME returns what came once VTIME passes after the last byte', async () => {
        const emulator = await build(
            [...raw(3, 2), 'sys 0, 0, buf, 8', 'save', 'sys 228, 1, buf2', 'saveq buf2 + 8'],
            virtualClock()
        )
        try {
            const out = record(emulator)
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            emulator.provideInput('a')
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([1n, 200000000n])
            expect(requests.map((request) => request.deadlineNanoseconds)).toEqual([200000000n])
        } finally {
            emulator.dispose()
        }
    })
})

describe('Undo of a read', () => {
    it('puts back the type-ahead a raw read took', async () => {
        const emulator = await build([...raw(1, 0), 'sys 0, 0, buf, 2', 'save'])
        try {
            emulator.initialize(100)
            emulator.provideInput('xyz')
            await throughSyscall(emulator, 3)
            expect(emulator.getRegisterValue('rax')).toBe(2n)
            emulator.undo()
            await throughSyscall(emulator)
            expect(emulator.getStatus()).not.toBe(EmulatorStatus.WaitingForInput)
            expect(emulator.getRegisterValue('rax')).toBe(2n)
            expect([...emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), 2n)]).toEqual([
                0x78, 0x79
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('that waited asks again, without the rest of the line it waited for', async () => {
        const emulator = await build(['sys 0, 0, buf, 2', 'save', 'sys 0, 0, buf, 8', 'save'])
        try {
            emulator.initialize(100)
            await throughSyscall(emulator)
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('hello\n')
            expect(emulator.getRegisterValue('rax')).toBe(2n)
            emulator.undo()
            await throughSyscall(emulator)
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('x\n')
            expect(emulator.getRegisterValue('rax')).toBe(2n)
            // and the next read waits too: nothing of "hello" is left
            await throughSyscall(emulator)
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
        } finally {
            emulator.dispose()
        }
    })

    it('that waited puts back only what it found queued', async () => {
        const emulator = await build([...raw(3, 0), 'sys 0, 0, buf, 8', 'save'])
        try {
            emulator.initialize(100)
            emulator.provideInput('a')
            await throughSyscall(emulator, 3)
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('bcd')
            expect(emulator.getRegisterValue('rax')).toBe(4n)
            emulator.undo()
            await throughSyscall(emulator)
            // "a" is back, short of VMIN
            expect(emulator.getStatus()).toBe(EmulatorStatus.WaitingForInput)
            emulator.provideInput('ef')
            expect(emulator.getRegisterValue('rax')).toBe(3n)
            expect([...emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), 3n)]).toEqual([
                0x61, 0x65, 0x66
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('that took End of input it found queued puts it back', async () => {
        const emulator = await build(['sys 0, 0, buf, 8', 'save'])
        try {
            emulator.initialize(100)
            emulator.provideInput(END_OF_INPUT)
            await throughSyscall(emulator)
            expect(emulator.getRegisterValue('rax')).toBe(0n)
            emulator.undo()
            await throughSyscall(emulator)
            expect(emulator.getStatus()).not.toBe(EmulatorStatus.WaitingForInput)
            expect(emulator.getRegisterValue('rax')).toBe(0n)
        } finally {
            emulator.dispose()
        }
    })
})

describe('output processing', () => {
    const lines = [
        "mov dword [buf], 0x0a620a61", // "a\nb\n"
        'sys 1, 1, buf, 4',
        'save',
        'sys 16, 0, 0x5401, buf2',
        'mov dword [buf2 + 4], 0', // OPOST off, as cfmakeraw() does
        'sys 16, 0, 0x5402, buf2',
        'sys 1, 1, buf, 4',
        'save'
    ]

    it('sends a line feed as a carriage return and a line feed under OPOST and ONLCR', async () => {
        const emulator = await build(lines)
        try {
            emulator.setTerminalProcessing({ output: true })
            const out = record(emulator)
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.stdout).toEqual(['a\r\nb\r\n', 'a\nb\n'])
            // a write returns what the program wrote
            expect(out.results()).toEqual([4n, 4n])
        } finally {
            emulator.dispose()
        }
    })

    it('leaves output as the program wrote it unless the host asks', async () => {
        const emulator = await build(lines)
        try {
            const out = record(emulator)
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.stdout).toEqual(['a\nb\n', 'a\nb\n'])
        } finally {
            emulator.dispose()
        }
    })
})

describe('input processing', () => {
    it.each([
        [true, 3n, 0x0a6261n],
        [false, 3n, 0x0d6261n]
    ])(
        'reads a typed carriage return as a line feed under ICRNL (processing: %s)',
        async (processing, count, line) => {
            const emulator = await build(['sys 0, 0, buf, 8', 'save', 'saveq buf'])
            try {
                emulator.setTerminalProcessing({ input: processing })
                const out = record(emulator)
                emulator.provideInput('ab\r')
                expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
                expect(out.results()).toEqual([count, line])
            } finally {
                emulator.dispose()
            }
        }
    )
})

describe('a signal from the terminal', () => {
    it('ends a read that waits, as SIGINT does by default', async () => {
        const emulator = await build(['sys 0, 0, buf, 8', 'save'])
        try {
            expect(await settle(emulator)).toBe(EmulatorStatus.WaitingForInput)
            emulator.sendSignal(2)
            expect(emulator.stopReason).toMatchObject({
                kind: 'signal',
                exitCode: 130,
                signal: { name: 'SIGINT' }
            })
        } finally {
            emulator.dispose()
        }
    })

    it('reaches a running program, discarding the input no read took', async () => {
        // a handler for SIGQUIT that sets a flag the program spins on
        const emulator = await build(
            [
                'mov qword [buf], handler',
                'mov qword [buf + 8], 0x04000000', // SA_RESTORER
                'mov qword [buf + 16], restorer',
                'mov qword [buf + 24], 0',
                'sys 13, 3, buf, 0, 8',
                'spin:',
                '  cmp byte [buf2], 0',
                '  je spin',
                'sys 16, 0, 0x541b, buf2 + 8', // FIONREAD
                'saved buf2 + 8'
            ],
            undefined,
            ['handler:', '  mov byte [buf2], 1', '  ret', 'restorer:', '  mov eax, 15', '  syscall']
        )
        try {
            const out = record(emulator)
            emulator.provideInput('typed ahead')
            expect(await emulator.run(10_000)).toBe(EmulatorStatus.Running)
            emulator.sendSignal(3)
            expect(await settle(emulator)).toBe(EmulatorStatus.Terminated)
            expect(out.results()).toEqual([0n])
        } finally {
            emulator.dispose()
        }
    })
})
