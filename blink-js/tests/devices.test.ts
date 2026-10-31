// The device framework (x86-devices-plan.md, M1): the nodes the wrapper makes from the Core's
// device table, matched by their device numbers; the open file description dup() shares; ENOTTY
// for an ioctl nothing knows; sized requests; the uncovered nodes; what can end a wait on a
// device; and a blocking write that keeps its progress while Blink starts it over. The values are
// those of the QEMU guest x86's devices follow (ADR 0067), provisional until it is booted, so
// these run in the Core only.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { BlinkState, type X86Environment, type X86WaitRequest } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { X86_INPUT_DEVICES_FILE } from '../src/devices'
import { expectLinux, probeSource, quadwords } from './linux-probe'

const ENOENT = -2n
const EAGAIN = -11n
const ENXIO = -6n
const ENODEV = -19n
const EINVAL = -22n
const ENOTTY = -25n

const O_WRONLY = 1
const O_RDWR = 2
const O_NONBLOCK = 0x800
const F_GETFL = 3
const F_SETFL = 4

/** EVIOCGNAME(len) and its relatives: _IOC(_IOC_READ, 'E', nr, len). */
const evdevString = (nr: number, length: number) =>
    `0x${(0x80000000 + length * 0x10000 + 0x4500 + nr).toString(16)}`

/** The device paths the probes name, as NUL-terminated strings in .data. */
const PATHS: Record<string, string> = {
    fb0: '/dev/fb0',
    tty0: '/dev/tty0',
    event0: '/dev/input/event0',
    event1: '/dev/input/event1',
    event3: '/dev/input/event3',
    kbd: '/dev/input/by-path/platform-i8042-serio-0-event-kbd',
    tablet: '/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-event-mouse',
    psmouse: '/dev/input/by-path/platform-i8042-serio-1-mouse',
    dsp: '/dev/dsp',
    mixer: '/dev/mixer',
    midi1: '/dev/midi1',
    midi: '/dev/snd/midiC1D0',
    card0: '/dev/dri/card0',
    pcm: '/dev/snd/pcmC0D0p',
    control: '/dev/snd/controlC0',
    mice: '/dev/input/mice',
    audio: '/dev/audio',
    sequencer: '/dev/sequencer',
    music: '/dev/music',
    proc: X86_INPUT_DEVICES_FILE,
    file: 'file'
}

const DATA = [
    'section .data',
    ...Object.entries(PATHS).map(([label, path]) => `${label}: db "${path}", 0`),
    'section .text'
]

type Run = {
    results: bigint[]
    stdout: string
    unsupported: string[]
    emulator: X86Emulator
}

async function build(body: readonly string[], environment?: X86Environment) {
    const emulator = await createX86Emulator(environment ? { environment } : {})
    const result = await emulator.compile(probeSource([...body, 'finish', ...DATA]))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

/** Runs the probe to its end, waits included, which the environment's clock and wait settle. */
async function runToEnd(emulator: X86Emulator): Promise<Omit<Run, 'emulator'>> {
    const stderr: number[] = []
    let stdout = ''
    const unsupported: string[] = []
    const stops = [
        emulator.on('stderr', (bytes) => void stderr.push(...bytes)),
        emulator.on('stdout', (bytes) => void (stdout += new TextDecoder().decode(bytes))),
        emulator.on('unsupportedDevice', ({ path }) => void unsupported.push(path))
    ]
    try {
        for (let slice = 0; slice < 1000 && !emulator.hasTerminated(); slice++) {
            await emulator.run(1_000_000)
            // the environment's wait resumes the program, which may wait again at once
            while (emulator.state === BlinkState.ProgramWaitPause) {
                await new Promise<void>((resolve) => {
                    const stop = emulator.on('stateChange', () => {
                        stop()
                        resolve()
                    })
                })
            }
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return { results: quadwords(Uint8Array.from(stderr)), stdout, unsupported }
    } finally {
        for (const stop of stops) stop()
    }
}

async function probe(body: readonly string[], environment?: X86Environment): Promise<Run> {
    const emulator = await build(body, environment)
    try {
        return { ...(await runToEnd(emulator)), emulator }
    } finally {
        emulator.dispose()
    }
}

/**
 * A clock of the program's own that only waits move, each to its deadline. It counts whole
 * nanoseconds and hands Blink half a nanosecond more, which Blink's conversion from milliseconds
 * truncates away, so a deadline is met exactly rather than a rounding short of it.
 */
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

describe('the device nodes', () => {
    it("are the guest's, at its device numbers, and udev's links reach them", async () => {
        const run = await probe([
            'sys 4, fb0, buf',
            'save',
            'saved buf + 24', // st_mode
            'saveq buf + 40', // st_rdev
            'sys 4, event1, buf',
            'saveq buf + 40',
            'sys 4, midi, buf',
            'saveq buf + 40',
            'sys 4, midi1, buf',
            'saveq buf + 40',
            'sys 4, dsp, buf',
            'saveq buf + 40',
            'sys 4, mixer, buf',
            'saveq buf + 40',
            'sys 4, tty0, buf',
            'saveq buf + 40',
            'sys 6, kbd, buf', // lstat: the link itself
            'saved buf + 24',
            'sys 4, kbd, buf', // stat: what it points at
            'saveq buf + 40',
            'sys 4, tablet, buf',
            'saveq buf + 40'
        ])
        expect(run.results).toEqual([
            0n,
            0o20660n, // a character device, root's and its group's
            0x1d00n, // 29:0
            0x0d41n, // 13:65
            0x7428n, // 116:40
            0x0e12n, // 14:18
            0x0e03n, // 14:3
            0x0e00n, // 14:0
            0x0400n, // 4:0
            0o120777n,
            0x0d41n,
            0x0d43n // 13:67
        ])
    })

    it('include /proc/bus/input/devices, generated from the input devices', async () => {
        const run = await probe([
            'sys 2, proc, 0',
            'mov r12, rax',
            'sys 0, r12, buf2, 4096',
            'mov r13, rax',
            'sys 1, 1, buf2, r13'
        ])
        const blocks = run.stdout.split('\n\n').filter(Boolean)
        expect(blocks.map((block) => /N: Name="(.*)"/.exec(block)?.[1])).toEqual([
            'Power Button',
            'AT Translated Set 2 keyboard',
            'ImExPS/2 Generic Explorer Mouse',
            'QEMU QEMU USB Tablet',
            'PC Speaker'
        ])
        expect(blocks[1]).toContain('I: Bus=0011 Vendor=0001 Product=0001 Version=ab41\n')
        expect(blocks[1]).toContain('H: Handlers=sysrq kbd event1 leds \n')
        expect(blocks[3]).toContain('U: Uniq=28754-0000:00:04.0-1\n')
    })

    it('come back for the next run after one removed them', async () => {
        const emulator = await build([
            'sys 4, fb0, buf',
            'save',
            'sys 4, kbd, buf',
            'save',
            'sys 2, proc, 0',
            'mov r12, rax',
            'sys 0, r12, buf, 8',
            'saveq buf',
            'sys 3, r12',
            // what a run may do to them
            'sys 87, fb0',
            'sys 87, kbd',
            'sys 90, proc, 0o666',
            `sys 2, proc, ${O_WRONLY | 0x200}`, // O_TRUNC
            'mov r12, rax',
            'sys 1, r12, buf, 1',
            'sys 3, r12'
        ])
        try {
            const first = await runToEnd(emulator)
            // the same build started again
            emulator.runtime.starti()
            const second = await runToEnd(emulator)
            expect(first.results).toEqual([0n, 0n, 0x303d737542203a49n]) // "I: Bus=0"
            expect(second.results).toEqual(first.results)
        } finally {
            emulator.dispose()
        }
    })

    it('the machine does not cover fail to open with ENODEV, and the host hears which', async () => {
        const run = await probe([
            ...['card0', 'pcm', 'control', 'mice', 'audio', 'psmouse'].flatMap((path) => [
                `sys 2, ${path}, ${O_RDWR}`,
                'save'
            ]),
            // the guest builds no OSS sequencer
            'sys 2, sequencer, 2',
            'save',
            'sys 2, music, 2',
            'save'
        ])
        expect(run.results).toEqual([...new Array(6).fill(ENODEV), ENOENT, ENOENT])
        expect(run.unsupported).toEqual([
            '/dev/dri/card0',
            '/dev/snd/pcmC0D0p',
            '/dev/snd/controlC0',
            '/dev/input/mice',
            '/dev/audio',
            '/dev/input/mouse0'
        ])
    })
})

describe('ioctl', () => {
    it('answers ENOTTY for a request nothing on the descriptor knows', async () => {
        await expectLinux(
            [
                'sys 22, buf2',
                'mov r12d, [buf2]',
                'sys 16, r12, 0x12345, buf',
                'save',
                "mov dword [buf2 + 64], 'file'",
                `sys 2, buf2 + 64, ${O_RDWR | 0x40}, 0o644`, // O_CREAT
                'mov r13, rax',
                'sys 16, r13, 0x12345, buf',
                'save',
                'sys 87, buf2 + 64'
            ],
            [ENOTTY, ENOTTY]
        )
    })

    it("answers what each device's driver answers for a request it does not know", async () => {
        const run = await probe(
            ['dsp', 'mixer', 'midi', 'tty0'].flatMap((path) => [
                `sys 2, ${path}, ${O_RDWR}`,
                'mov r12, rax',
                'sys 16, r12, 0x4600, buf', // FBIOGET_VSCREENINFO
                'save',
                'sys 16, r12, 0x4b2f, 440', // KIOCSOUND
                'save'
            ])
        )
        expect(run.results).toEqual([
            ...[EINVAL, EINVAL], // snd-pcm-oss answers EINVAL for anything not its own
            ...[ENXIO, ENXIO], // snd-mixer-oss: ENXIO for a request with no direction
            ...[ENOTTY, ENOTTY], // rawmidi: ENOTTY for anything not of type 'W'
            ...[ENOTTY, 0n] // the console sounds the speaker
        ])
    })

    it('matches a sized request on its type and number, with the size it names', async () => {
        const run = await probe([
            `sys 2, kbd, ${O_RDWR}`,
            'mov r12, rax',
            `sys 16, r12, ${evdevString(0x06, 256)}, buf`, // EVIOCGNAME(256)
            'save',
            'saveq buf',
            `sys 16, r12, ${evdevString(0x06, 4)}, buf2`, // EVIOCGNAME(4): cut, no NUL
            'save',
            'saveq buf2',
            'sys 16, r12, 0x80084502, buf', // EVIOCGID
            'save',
            'saveq buf',
            'sys 16, r12, 0x80044501, buf', // EVIOCGVERSION
            'saved buf',
            `sys 16, r12, ${evdevString(0x08, 64)}, buf`, // EVIOCGUNIQ: the keyboard has none
            'save',
            // the same type and number written rather than read is another request, which
            // evdev answers EINVAL, as it answers everything it does not know
            `sys 16, r12, 0x${(0x40000000 + 256 * 0x10000 + 0x4506).toString(16)}, buf`,
            'save',
            `sys 2, tablet, ${O_RDWR}`,
            'mov r13, rax',
            `sys 16, r13, ${evdevString(0x08, 64)}, buf2 + 64`,
            'save'
        ])
        expect(run.results).toEqual([
            29n,
            0x736e617254205441n, // "AT Trans"
            4n,
            0x54205441n, // "AT T"
            0n,
            BigInt.asIntN(64, 0xab41_0001_0001_0011n), // bus, vendor, product, version
            0x010001n,
            ENOENT,
            EINVAL,
            21n // "28754-0000:00:04.0-1" and its NUL
        ])
    })
})

describe('the open file description', () => {
    it("is shared by dup(): its O_NONBLOCK and its device's buffer", async () => {
        const run = await probe(
            [
                `sys 2, midi, ${O_WRONLY}`,
                'mov r12, rax',
                'sys 32, r12',
                'mov r13, rax',
                `sys 72, r12, ${F_SETFL}, ${O_NONBLOCK}`,
                'save',
                `sys 72, r13, ${F_GETFL}`,
                'save',
                'sys 1, r12, buf, 4096', // fills the port's buffer
                'save',
                'sys 1, r13, buf, 1',
                'save',
                'sys 3, r12',
                'sys 1, r13, buf, 1', // the description outlives the descriptor
                'save',
                // a second open is a description of its own
                `sys 2, midi, ${O_WRONLY}`,
                'mov r14, rax',
                `sys 72, r14, ${F_GETFL}`,
                'save'
            ],
            { now: () => 0 } // time stands still: nothing drains
        )
        expect(run.results).toEqual([
            0n,
            BigInt(O_WRONLY | O_NONBLOCK | 0x8000), // O_LARGEFILE
            4096n,
            EAGAIN,
            EAGAIN,
            BigInt(O_WRONLY | 0x8000)
        ])
    })
})

describe('a wait on a device', () => {
    it('names the input device that can end it', async () => {
        const emulator = await build([
            `sys 2, kbd, 0`,
            'mov r12, rax',
            'sys 0, r12, buf, 24' // waits for an event
        ])
        try {
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            expect(requests).toHaveLength(1)
            expect(requests[0]).toMatchObject({
                deadlineNanoseconds: null,
                wakeSources: { terminal: false, inputDevices: ['keyboard'] },
                acceptsInput: false
            })
            // input for the terminal is not for it
            emulator.provideInput('a\n')
            expect(emulator.state).toBe(BlinkState.ProgramWaitPause)
            emulator.cancelWait()
        } finally {
            emulator.dispose()
        }
    })

    it('reads EINVAL for a buffer smaller than an event, and EAGAIN without one', async () => {
        const run = await probe([
            `sys 2, kbd, 0`,
            'mov r12, rax',
            'sys 0, r12, buf, 16',
            'save',
            `sys 2, kbd, ${O_NONBLOCK}`,
            'mov r13, rax',
            'sys 0, r13, buf, 24',
            'save',
            // writable, never readable
            'mov dword [buf], r13d',
            'mov word [buf + 4], 5', // POLLIN | POLLOUT
            'sys 7, buf, 1, 0',
            'save',
            'movzx eax, word [buf + 6]',
            'save'
        ])
        expect(run.results).toEqual([EINVAL, EAGAIN, 1n, 4n])
    })

    it('in poll names the terminal and the tablet, and keeps its timeout', async () => {
        const emulator = await build([
            `sys 2, tablet, 0`,
            'mov dword [buf], 0', // standard input
            'mov word [buf + 4], 1',
            'mov dword [buf + 8], eax',
            'mov word [buf + 12], 1',
            'sys 7, buf, 2, 1500'
        ])
        try {
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            const request = emulator.getWaitRequest()!
            expect(request.wakeSources).toEqual({ terminal: true, inputDevices: ['tablet'] })
            expect(request.acceptsInput).toBe(true)
            expect(request.deadlineNanoseconds).not.toBeNull()
            expect(Math.round(request.remainingMilliseconds!)).toBe(1500)
            emulator.cancelWait()
        } finally {
            emulator.dispose()
        }
    })

    it('in poll for room on a port folds the moment it drains into the deadline', async () => {
        const clock = virtualClock()
        const emulator = await build(
            [
                `sys 2, midi, ${O_WRONLY | O_NONBLOCK}`,
                'mov r12, rax',
                'sys 1, r12, buf, 4096', // full
                'mov dword [buf], r12d',
                'mov word [buf + 4], 4', // POLLOUT
                'sys 7, buf, 1, -1', // no timeout of its own
                'save',
                'movzx eax, word [buf + 6]',
                'save',
                'sys 228, 1, buf2',
                'saveq buf2',
                'saveq buf2 + 8'
            ],
            clock
        )
        try {
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            const run = await runToEnd(emulator)
            // one byte drains in 320 µs at 31,250 baud
            expect(requests[0]).toMatchObject({
                deadlineNanoseconds: 320000n,
                wakeSources: { terminal: false, inputDevices: [] }
            })
            expect(run.results).toEqual([1n, 4n, 0n, 320000n])
        } finally {
            emulator.dispose()
        }
    })
})

describe('a blocking write to a device that keeps time', () => {
    it('queues all it was given, waiting for room, as one instruction', async () => {
        const clock = virtualClock()
        const emulator = await build(
            [
                `sys 2, midi, ${O_WRONLY}`,
                'mov r12, rax',
                'sys 1, r12, buf, 4096',
                'save',
                'sys 1, r12, buf2, 4096', // waits for the first to drain
                'save',
                'sys 228, 1, buf2',
                'saveq buf2',
                'saveq buf2 + 8'
            ],
            clock
        )
        try {
            emulator.initialize(1000)
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            const run = await runToEnd(emulator)
            // the second write's last byte enters once 4,096 have drained: 1.31072 s
            expect(run.results).toEqual([4096n, 4096n, 1n, 310720000n])
            expect(requests).toHaveLength(1)
        } finally {
            emulator.dispose()
        }
    })

    it('larger than the buffer, goes on from what it queued each time it starts over', async () => {
        const clock = virtualClock()
        const emulator = await build(
            [
                `sys 2, midi, ${O_WRONLY}`,
                'mov r12, rax',
                'sys 1, r12, results + 1024, 10000',
                'save',
                'sys 228, 1, buf2',
                'saveq buf2',
                'saveq buf2 + 8'
            ],
            clock
        )
        try {
            const requests: X86WaitRequest[] = []
            emulator.on('waitRequest', (request) => void requests.push(request))
            const run = await runToEnd(emulator)
            // 4,096 at once, 4,096 once the buffer is empty, and the last 1,808 once as many
            // have drained: 5,904 bytes at 3,125 a second
            expect(run.results).toEqual([10000n, 1n, 889280000n])
            expect(requests).toHaveLength(2)
            expect(new Set(requests.map((request) => request.instructionSerial)).size).toBe(1)
        } finally {
            emulator.dispose()
        }
    })

    it('ended by the host returns what it queued', async () => {
        const emulator = await build(
            [`sys 2, midi, ${O_WRONLY}`, 'mov r12, rax', 'sys 1, r12, results + 1024, 5000', 'save'],
            { now: () => 0 }
        )
        try {
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            const stderr: number[] = []
            emulator.on('stderr', (bytes) => void stderr.push(...bytes))
            expect(emulator.cancelWait()).toBe(true)
            await emulator.run(1_000_000)
            expect(emulator.stopReason?.kind).toBe('exit')
            expect(quadwords(Uint8Array.from(stderr))).toEqual([4096n])
        } finally {
            emulator.dispose()
        }
    })
})
