// The guest's input devices through evdev (x86-devices-plan.md, M3): their identities and
// capabilities, every ioctl evdev answers, the packets a host report becomes (MSC_SCAN, the LEDs
// the lock keys light, REL_WHEEL_HI_RES, SYN_REPORT), event times on each reader's clock, readers
// and the grab, the overflow rule, waits and poll, writes, and Undo of what reads and flushes took
// (ADR 0069). The values are Linux 6.12's on the QEMU guest x86's devices follow (ADR 0067),
// provisional until it is booted, so these run in the Core only.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { BlinkState, type X86Environment, type X86InputEvent } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { X86_INPUT_DEVICES_FILE } from '../src/devices'
import { probeSource, quadwords } from './linux-probe'

const EAGAIN = -11n
const EBUSY = -16n
const ENODEV = -19n
const EINVAL = -22n
const ENOSYS = -38n

const O_RDWR = 2
const O_NONBLOCK = 0x800

const EV_SYN = 0
const EV_KEY = 1
const EV_REL = 2
const EV_ABS = 3
const EV_MSC = 4
const EV_LED = 0x11
const EV_SND = 0x12
const EV_REP = 0x14
const SYN_REPORT = 0
const SYN_DROPPED = 3
const MSC_SCAN = 4
const KEY_A = 30
const KEY_CAPSLOCK = 58
const KEY_RIGHTCTRL = 97
const KEY_SYSRQ = 99
const KEY_PAUSE = 119
const BTN_LEFT = 0x110
const BTN_RIGHT = 0x111
const ABS_X = 0
const ABS_Y = 1
const REL_WHEEL = 8
const REL_WHEEL_HI_RES = 11
const LED_CAPSL = 1
const SND_TONE = 2

/** _IOC(dir, 'E', nr, size) */
const ioc = (dir: number, nr: number, size: number) =>
    `0x${(((dir << 30) | (size << 16) | 0x4500 | nr) >>> 0).toString(16)}`
const READ = 2
const WRITE = 1
const EVIOCGBIT = (type: number, size: number) => ioc(READ, 0x20 + type, size)
const EVIOCGKEY = (size: number) => ioc(READ, 0x18, size)
const EVIOCGLED = (size: number) => ioc(READ, 0x19, size)
const EVIOCGSND = (size: number) => ioc(READ, 0x1a, size)
const EVIOCGSW = (size: number) => ioc(READ, 0x1b, size)
const EVIOCGPROP = (size: number) => ioc(READ, 0x09, size)
const EVIOCGABS = (axis: number) => ioc(READ, 0x40 + axis, 24)
const EVIOCSABS = (axis: number) => ioc(WRITE, 0xc0 + axis, 24)
const EVIOCGREP = ioc(READ, 0x03, 8)
const EVIOCSREP = ioc(WRITE, 0x03, 8)
const EVIOCGKEYCODE = ioc(READ, 0x04, 8)
const EVIOCGRAB = ioc(WRITE, 0x90, 4)
const EVIOCREVOKE = ioc(WRITE, 0x91, 4)
const EVIOCGMASK = ioc(READ, 0x92, 16)
const EVIOCSMASK = ioc(WRITE, 0x93, 16)
const EVIOCSCLOCKID = ioc(WRITE, 0xa0, 4)
const EVIOCGEFFECTS = ioc(READ, 0x84, 4)

const PATHS: Record<string, string> = {
    power: '/dev/input/event0',
    kbd: '/dev/input/by-path/platform-i8042-serio-0-event-kbd',
    psmouse: '/dev/input/event2',
    tablet: '/dev/input/by-id/usb-QEMU_QEMU_USB_Tablet_28754-0000:00:04.0-1-event-mouse',
    speaker: '/dev/input/by-path/platform-pcspkr-event-spkr',
    proc: X86_INPUT_DEVICES_FILE
}

const DATA = [
    'section .data',
    ...Object.entries(PATHS).map(([label, path]) => `${label}: db "${path}", 0`),
    'section .text'
]

type Event = { sec: bigint; usec: bigint; type: number; code: number; value: number }

function decodeEvents(bytes: Uint8Array): Event[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: Math.floor(bytes.byteLength / 24) }, (_, index) => ({
        sec: view.getBigInt64(index * 24, true),
        usec: view.getBigInt64(index * 24 + 8, true),
        type: view.getUint16(index * 24 + 16, true),
        code: view.getUint16(index * 24 + 18, true),
        value: view.getInt32(index * 24 + 20, true)
    }))
}

/** The events without their times, as [type, code, value]. */
const plain = (events: Event[]) => events.map(({ type, code, value }) => [type, code, value])

/** Program time the test sets, in milliseconds; the wall clock is a fixed day later. */
const WALL_CLOCK_MS = 1_790_000_000_000
function settableClock() {
    let ms = 0
    const environment: X86Environment = {
        now: (clock) => (clock === 0 ? WALL_CLOCK_MS + ms : ms),
        wait: async () => undefined
    }
    return { environment, set: (value: number) => void (ms = value) }
}

async function build(body: readonly string[], environment?: X86Environment) {
    const emulator = await createX86Emulator(environment ? { environment } : {})
    const result = await emulator.compile(probeSource([...body, 'finish', ...DATA]))
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(1000)
    return emulator
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

/** What the read just made returned, and the events it read into the buffer `rsi` names. */
function readEvents(emulator: X86Emulator): { rax: bigint; events: Event[] } {
    const rax = BigInt.asIntN(64, emulator.getRegisterValue('rax'))
    if (rax <= 0n) return { rax, events: [] }
    return {
        rax,
        events: decodeEvents(emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), rax))
    }
}

/** Undoes instructions until `count` system calls are undone: the last is next again. */
function undoSyscalls(emulator: X86Emulator, count = 1): void {
    for (let index = 0; index < 1000; index++) {
        emulator.undo()
        if (emulator.getNextInstruction()?.code.toLowerCase().includes('syscall') && --count === 0)
            return
    }
    throw new Error('Undo did not reach the syscall')
}

/** Steps to the next system call and jumps over it, so that it does not run. */
async function skipSyscall(emulator: X86Emulator): Promise<void> {
    for (let index = 0; index < 100; index++) {
        if (emulator.getNextInstruction()?.code.toLowerCase().includes('syscall')) {
            emulator.setRegisterValue('rip', emulator.getRegisterValue('rip') + 2n)
            return
        }
        await emulator.step()
    }
    throw new Error('the probe did not reach the syscall')
}

/** Runs the probe to its end and returns what it saved. */
async function finish(emulator: X86Emulator): Promise<bigint[]> {
    const stderr: number[] = []
    const stop = emulator.on('stderr', (bytes) => void stderr.push(...bytes))
    try {
        for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice++) {
            await emulator.run(1_000_000)
            if (emulator.state === BlinkState.ProgramWaitPause)
                throw new Error('the probe waited')
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return quadwords(Uint8Array.from(stderr))
    } finally {
        stop()
    }
}

async function probe(body: readonly string[], environment?: X86Environment) {
    const emulator = await build(body, environment)
    try {
        return await finish(emulator)
    } finally {
        emulator.dispose()
    }
}

const key = (code: number, value: number): X86InputEvent[] => [{ type: EV_KEY, code, value }]

/** A 96-byte EVIOCGBIT(EV_KEY) answer as its twelve longs. */
function keyWords(codes: number[]): bigint[] {
    const words = new Array<bigint>(12).fill(0n)
    for (const code of codes) words[code >> 6] |= 1n << BigInt(code & 63)
    return words.map((word) => BigInt.asIntN(64, word))
}

describe('the input devices', () => {
    // EVIOCGBIT for every type, EVIOCGPROP, EVIOCGVERSION, EVIOCGID: one probe per device
    const capabilities = (path: string) => [
        `sys 2, ${path}, ${O_RDWR}`,
        'mov r12, rax',
        'sys 16, r12, 0x80044501, buf', // EVIOCGVERSION
        'save',
        'saved buf',
        'sys 16, r12, 0x80084502, buf', // EVIOCGID
        'saveq buf',
        `sys 16, r12, ${EVIOCGPROP(8)}, buf`,
        'save',
        'saveq buf',
        `sys 16, r12, ${EVIOCGBIT(0, 8)}, buf`,
        'save',
        'saveq buf',
        `sys 16, r12, ${EVIOCGBIT(EV_KEY, 96)}, buf`,
        'save',
        ...Array.from({ length: 12 }, (_, word) => `saveq buf + ${word * 8}`),
        ...[EV_REL, EV_ABS, EV_MSC, 0x05, EV_LED, EV_SND].flatMap((type) => [
            'mov qword [buf], 0',
            `sys 16, r12, ${EVIOCGBIT(type, 8)}, buf`,
            'save',
            'saveq buf'
        ]),
        `sys 16, r12, ${EVIOCGBIT(0x15, 16)}, buf`, // EV_FF: two longs
        'save',
        `sys 16, r12, ${EVIOCGBIT(EV_REP, 8)}, buf`, // not a type EVIOCGBIT answers
        'save'
    ]
    const expected = (
        id: bigint,
        prop: bigint,
        ev: bigint,
        keys: number[],
        [rel, abs, msc, sw, led, snd]: bigint[]
    ) => [
        0n,
        0x010001n,
        BigInt.asIntN(64, id),
        8n,
        prop,
        8n,
        ev,
        96n,
        ...keyWords(keys),
        8n,
        rel,
        8n,
        abs,
        8n,
        msc,
        8n,
        sw,
        8n,
        led,
        8n,
        snd,
        16n,
        EINVAL
    ]

    it('have the identities and capabilities of their Linux drivers', async () => {
        // atkbd's translated set 2 table, as /proc/bus/input/devices prints it below
        const keyboardKeys: number[] = []
        ;['fffffffffffffffe', 'feffffdfffefffff', '3803078f800d001', '402000000'].forEach(
            (word, index) => {
                for (let bit = 0; bit < 64; bit++)
                    if ((BigInt(`0x${word}`) >> BigInt(bit)) & 1n)
                        keyboardKeys.push(index * 64 + bit)
            }
        )
        const cases: [string, bigint[]][] = [
            [
                'power',
                expected(0x0000_0001_0000_0019n, 0n, 0x3n, [116, 143], [0n, 0n, 0n, 0n, 0n, 0n])
            ],
            [
                'kbd',
                expected(0xab41_0001_0001_0011n, 0n, 0x120013n, keyboardKeys, [
                    0n,
                    0n,
                    0x10n,
                    0n,
                    0x7n,
                    0n
                ])
            ],
            [
                'psmouse',
                expected(
                    0x0000_0006_0002_0011n,
                    1n,
                    0x7n,
                    [0x110, 0x111, 0x112, 0x113, 0x114],
                    [0x143n, 0n, 0n, 0n, 0n, 0n]
                )
            ],
            [
                'tablet',
                expected(0x0001_0001_0627_0003n, 0n, 0x1fn, [0x110, 0x111, 0x112], [
                    0x900n,
                    0x3n,
                    0x10n,
                    0n,
                    0n,
                    0n
                ])
            ],
            [
                'speaker',
                expected(0x0100_0001_001f_0010n, 0n, 0x40001n, [], [0n, 0n, 0n, 0n, 0n, 0x6n])
            ]
        ]
        for (const [path, results] of cases) {
            expect(await probe(capabilities(path)), path).toEqual(results)
        }
    })

    it('are listed in /proc/bus/input/devices as the kernel prints them', async () => {
        const emulator = await build([
            'sys 2, proc, 0',
            'mov r12, rax',
            'sys 0, r12, buf2, 4096',
            'mov r13, rax',
            'sys 1, 1, buf2, r13'
        ])
        let text = ''
        emulator.on('stdout', (bytes) => void (text += new TextDecoder().decode(bytes)))
        try {
            await finish(emulator)
        } finally {
            emulator.dispose()
        }
        expect(text).toBe(
            [
                'I: Bus=0019 Vendor=0000 Product=0001 Version=0000',
                'N: Name="Power Button"',
                'P: Phys=LNXPWRBN/button/input0',
                'S: Sysfs=/devices/LNXSYSTM:00/LNXPWRBN:00/input/input0',
                'U: Uniq=',
                'H: Handlers=kbd event0 ',
                'B: PROP=0',
                'B: EV=3',
                'B: KEY=8000 10000000000000 0',
                '',
                'I: Bus=0011 Vendor=0001 Product=0001 Version=ab41',
                'N: Name="AT Translated Set 2 keyboard"',
                'P: Phys=isa0060/serio0/input0',
                'S: Sysfs=/devices/platform/i8042/serio0/input/input1',
                'U: Uniq=',
                'H: Handlers=sysrq kbd event1 leds ',
                'B: PROP=0',
                'B: EV=120013',
                'B: KEY=402000000 3803078f800d001 feffffdfffefffff fffffffffffffffe',
                'B: MSC=10',
                'B: LED=7',
                '',
                'I: Bus=0011 Vendor=0002 Product=0006 Version=0000',
                'N: Name="ImExPS/2 Generic Explorer Mouse"',
                'P: Phys=isa0060/serio1/input0',
                'S: Sysfs=/devices/platform/i8042/serio1/input/input2',
                'U: Uniq=',
                'H: Handlers=mouse0 event2 ',
                'B: PROP=1',
                'B: EV=7',
                'B: KEY=1f0000 0 0 0 0',
                'B: REL=143',
                '',
                'I: Bus=0003 Vendor=0627 Product=0001 Version=0001',
                'N: Name="QEMU QEMU USB Tablet"',
                'P: Phys=usb-0000:00:04.0-1/input0',
                'S: Sysfs=/devices/pci0000:00/0000:00:04.0/usb1/1-1/1-1:1.0/0003:0627:0001.0001/input/input3',
                'U: Uniq=28754-0000:00:04.0-1',
                'H: Handlers=mouse1 event3 ',
                'B: PROP=0',
                'B: EV=1f',
                'B: KEY=70000 0 0 0 0',
                'B: REL=900',
                'B: ABS=3',
                'B: MSC=10',
                '',
                'I: Bus=0010 Vendor=001f Product=0001 Version=0100',
                'N: Name="PC Speaker"',
                'P: Phys=isa0061/input0',
                'S: Sysfs=/devices/platform/pcspkr/input/input4',
                'U: Uniq=',
                'H: Handlers=kbd event4 ',
                'B: PROP=0',
                'B: EV=40001',
                'B: SND=6',
                '',
                ''
            ].join('\n')
        )
    })

    it('answer the state ioctls before any event, and EINVAL for what evdev does not know', async () => {
        const results = await probe([
            `sys 2, kbd, ${O_RDWR}`,
            'mov r12, rax',
            `sys 2, tablet, ${O_RDWR}`,
            'mov r13, rax',
            `sys 16, r12, ${EVIOCGREP}, buf`,
            'save',
            'saved buf',
            'saved buf + 4',
            `sys 16, r13, ${EVIOCGREP}, buf`, // the tablet has no repeat
            'save',
            `sys 16, r13, ${EVIOCGABS(ABS_X)}, buf`,
            'save',
            ...[0, 4, 8, 12, 16, 20].map((offset) => `saved buf + ${offset}`),
            `sys 16, r12, ${EVIOCGABS(ABS_X)}, buf`, // the keyboard has no axes
            'save',
            `sys 16, r12, ${EVIOCGKEY(96)}, buf`,
            'save',
            `sys 16, r12, ${EVIOCGLED(8)}, buf`,
            'save',
            'saveq buf',
            `sys 16, r12, ${EVIOCGSW(4)}, buf`, // cut to the size given
            'save',
            `sys 16, r12, ${EVIOCGSND(8)}, buf`,
            'save',
            `sys 16, r12, ${EVIOCGEFFECTS}, buf`,
            'save',
            'saved buf',
            'mov dword [buf], 0x1e',
            `sys 16, r12, ${EVIOCGKEYCODE}, buf`, // scan code 0x1e is KEY_A
            'save',
            'saved buf + 4',
            `sys 16, r13, ${EVIOCGKEYCODE}, buf`,
            'save',
            'sys 16, r12, 0x5401, buf', // TCGETS: not a terminal, and not a type evdev knows
            'save',
            'sys 16, r12, 0x541b, buf', // FIONREAD
            'save',
            `sys 16, r12, ${ioc(WRITE, 0x06, 64)}, buf`, // EVIOCGNAME's number, written
            'save',
            `sys 16, r12, ${ioc(READ, 0x0a, 64)}, buf`, // EVIOCGMTSLOTS: no slots
            'save'
        ])
        expect(results).toEqual([
            0n,
            250n,
            33n,
            ENOSYS,
            0n,
            ...[0n, 0n, 32767n, 0n, 0n, 0n],
            EINVAL,
            96n,
            8n,
            0n,
            4n,
            8n,
            0n,
            0n,
            0n,
            30n,
            EINVAL,
            EINVAL,
            EINVAL,
            EINVAL,
            EINVAL
        ])
    })

    it("set the tablet's absinfo with EVIOCSABS, and the keyboard's keymap with EVIOCSKEYCODE", async () => {
        const emulator = await build([
            `sys 2, tablet, ${O_RDWR}`,
            'mov r12, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            'mov dword [buf], 5',
            'mov dword [buf + 4], 10',
            'mov dword [buf + 8], 20',
            'mov dword [buf + 12], 0',
            'mov dword [buf + 16], 0',
            'mov dword [buf + 20], 7',
            `sys 16, r12, ${ioc(WRITE, 0xc0 + ABS_Y, 20)}, buf`, // no resolution: it becomes 0
            'save',
            `sys 16, r12, ${EVIOCGABS(ABS_Y)}, buf2`,
            ...[0, 4, 8, 20].map((offset) => `saved buf2 + ${offset}`),
            `sys 16, r12, ${EVIOCSABS(0x2f)}, buf`, // ABS_MT_SLOT
            'save',
            'mov dword [buf], 0x1e',
            'mov dword [buf + 4], 48', // KEY_B
            `sys 16, r13, ${ioc(WRITE, 0x04, 8)}, buf`, // EVIOCSKEYCODE
            'save',
            `sys 16, r13, ${EVIOCGKEYCODE}, buf`,
            'saved buf + 4',
            `sys 16, r13, ${EVIOCGBIT(EV_KEY, 8)}, buf2`, // KEY_A has no scan code now
            'saveq buf2',
            'sys 0, r13, buf, 4096',
            'save',
            'movzx eax, word [buf + 24 + 18]', // the key's code, after its MSC_SCAN
            'save'
        ])
        try {
            await throughSyscall(emulator, 8)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            expect(await finish(emulator)).toEqual([
                0n,
                5n,
                10n,
                20n,
                0n,
                EINVAL,
                0n,
                48n,
                BigInt.asIntN(64, 0xfffffffffffffffen & ~(1n << BigInt(KEY_A))),
                72n,
                48n
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('round EVIOCSREP to what the AT keyboard can do, which changes no repeat', async () => {
        const results = await probe([
            `sys 2, kbd, ${O_RDWR}`,
            'mov r12, rax',
            'mov dword [buf], 400',
            'mov dword [buf + 4], 40',
            `sys 16, r12, ${EVIOCSREP}, buf`,
            'save',
            `sys 16, r12, ${EVIOCGREP}, buf2`,
            'saved buf2',
            'saved buf2 + 4',
            'mov dword [buf], 2000',
            'mov dword [buf + 4], 0',
            `sys 16, r12, ${EVIOCSREP}, buf`,
            `sys 16, r12, ${EVIOCGREP}, buf2`,
            'saved buf2',
            'saved buf2 + 4'
        ])
        expect(results).toEqual([0n, 500n, 42n, 1000n, 33n])
    })
})

/** A probe that opens the keyboard without blocking and reads it each time it is stepped to. */
async function keyboardReader(environment?: X86Environment) {
    const emulator = await build(
        [
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            ...Array.from({ length: 8 }, () => 'sys 0, r12, buf, 4096')
        ],
        environment
    )
    await throughSyscall(emulator)
    return emulator
}

async function readAfter(emulator: X86Emulator, ...reports: [string, X86InputEvent[]][]) {
    for (const [device, events] of reports)
        emulator.sendInputReport(device as 'keyboard' | 'tablet', events)
    await throughSyscall(emulator)
    return readEvents(emulator)
}

describe('a keyboard report', () => {
    it('is the scan code, the key and SYN_REPORT, as atkbd reports what QEMU sends', async () => {
        const emulator = await keyboardReader(settableClock().environment)
        try {
            expect(plain((await readAfter(emulator, ['keyboard', key(KEY_A, 1)])).events)).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            // a repeat, an E0 key and its release, each its own packet
            expect(
                plain(
                    (
                        await readAfter(
                            emulator,
                            ['keyboard', key(KEY_A, 2)],
                            ['keyboard', key(KEY_A, 0)],
                            ['keyboard', key(KEY_RIGHTCTRL, 1)],
                            ['keyboard', key(KEY_RIGHTCTRL, 0)]
                        )
                    ).events
                )
            ).toEqual([
                // a make code this soon after is a double press to atkbd, value 1, which the
                // input core drops for a key already down
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 0],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x9d],
                [EV_KEY, KEY_RIGHTCTRL, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x9d],
                [EV_KEY, KEY_RIGHTCTRL, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('carries an atkbd repeat as value 2 once the first half delay has passed', async () => {
        const clock = settableClock()
        const emulator = await keyboardReader(clock.environment)
        try {
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            clock.set(200) // past 250 ms ÷ 2
            const { events } = await readAfter(emulator, ['keyboard', key(KEY_A, 2)])
            expect(plain(events).slice(3)).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 2],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('has Pause and Print Screen as QEMU sends them', async () => {
        const emulator = await keyboardReader()
        try {
            const { events } = await readAfter(
                emulator,
                ['keyboard', key(KEY_PAUSE, 1)],
                ['keyboard', key(KEY_PAUSE, 0)], // Pause sends nothing as it goes up
                ['keyboard', key(KEY_SYSRQ, 1)],
                ['keyboard', key(KEY_SYSRQ, 0)]
            )
            expect(plain(events)).toEqual([
                [EV_MSC, MSC_SCAN, 0xc5],
                [EV_KEY, KEY_PAUSE, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0xc5],
                [EV_KEY, KEY_PAUSE, 0],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0xb7],
                [EV_KEY, KEY_SYSRQ, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0xb7],
                [EV_KEY, KEY_SYSRQ, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('lights Caps Lock in a packet of its own, as the console does, and EVIOCGLED says so', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            'sys 0, r12, buf, 4096',
            `sys 16, r12, ${EVIOCGLED(8)}, buf2`,
            'saveq buf2'
        ])
        try {
            await throughSyscall(emulator)
            emulator.sendInputReport('keyboard', key(KEY_CAPSLOCK, 1))
            emulator.sendInputReport('keyboard', key(KEY_CAPSLOCK, 0))
            await throughSyscall(emulator)
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_MSC, MSC_SCAN, 0x3a],
                [EV_KEY, KEY_CAPSLOCK, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_LED, LED_CAPSL, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x3a],
                [EV_KEY, KEY_CAPSLOCK, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
            expect(await finish(emulator)).toEqual([1n << BigInt(LED_CAPSL)])
        } finally {
            emulator.dispose()
        }
    })

    it('ignores what the keyboard does not send, and changes the state with no reader', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'sys 3, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `sys 16, r12, ${EVIOCGKEY(96)}, buf`,
            'saveq buf'
        ])
        try {
            await throughSyscall(emulator, 2)
            // the device has no reader now
            emulator.sendInputReport('keyboard', [
                { type: EV_KEY, code: KEY_A, value: 1 },
                { type: EV_KEY, code: 0x2ff, value: 1 }, // a key it does not have
                { type: EV_MSC, code: MSC_SCAN, value: 5 }, // the Core adds these
                { type: EV_SYN, code: SYN_REPORT, value: 0 }
            ])
            expect(await finish(emulator)).toEqual([1n << BigInt(KEY_A)])
        } finally {
            emulator.dispose()
        }
    })
})

describe('a tablet report', () => {
    it('is one HID report: buttons with their usages, axes that moved, the wheel twice', async () => {
        const emulator = await build([
            `sys 2, tablet, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            'sys 0, r12, buf, 4096',
            'sys 0, r12, buf, 4096',
            `sys 16, r12, ${EVIOCGABS(ABS_X)}, buf2`,
            'saved buf2',
            `sys 16, r12, ${EVIOCGKEY(96)}, buf2`,
            'saveq buf2 + 32'
        ])
        try {
            await throughSyscall(emulator)
            emulator.sendInputReport('tablet', [
                { type: EV_ABS, code: ABS_X, value: 1000 },
                { type: EV_ABS, code: ABS_Y, value: 40000 } // clamped to the logical range
            ])
            // a button down where the pointer is: the button comes first, as in the descriptor
            emulator.sendInputReport('tablet', [
                { type: EV_ABS, code: ABS_X, value: 1000 },
                { type: EV_KEY, code: BTN_LEFT, value: 1 }
            ])
            await throughSyscall(emulator)
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_ABS, ABS_X, 1000],
                [EV_ABS, ABS_Y, 32767],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x90001],
                [EV_KEY, BTN_LEFT, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            emulator.sendInputReport('tablet', [{ type: EV_REL, code: REL_WHEEL, value: -1 }])
            emulator.sendInputReport('tablet', [
                { type: EV_KEY, code: BTN_LEFT, value: 0 },
                { type: EV_KEY, code: BTN_RIGHT, value: 1 }
            ])
            await throughSyscall(emulator)
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_REL, REL_WHEEL, -1],
                [EV_REL, REL_WHEEL_HI_RES, -120],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x90001],
                [EV_KEY, BTN_LEFT, 0],
                [EV_MSC, MSC_SCAN, 0x90002],
                [EV_KEY, BTN_RIGHT, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            expect(await finish(emulator)).toEqual([1000n, 1n << BigInt(BTN_RIGHT - 256)])
        } finally {
            emulator.dispose()
        }
    })
})

describe('event times', () => {
    it("are Program time on the reader's clock, the wall clock until EVIOCSCLOCKID", async () => {
        const clock = settableClock()
        const emulator = await build(
            [
                `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
                'mov r12, rax',
                'sys 0, r12, buf, 4096',
                'mov dword [buf2], 1', // CLOCK_MONOTONIC
                `sys 16, r12, ${EVIOCSCLOCKID}, buf2`,
                'sys 0, r12, buf, 4096',
                'sys 0, r12, buf, 4096',
                'mov dword [buf2], 5',
                `sys 16, r12, ${EVIOCSCLOCKID}, buf2`,
                'save'
            ],
            clock.environment
        )
        try {
            await throughSyscall(emulator)
            clock.set(1234.5678)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator)
            const wall = readEvents(emulator).events
            expect(wall.map(({ sec, usec }) => [sec, usec])).toEqual(
                new Array(3).fill([1_790_000_001n, 234567n])
            )
            // a reader with events queued that changes its clock finds a SYN_DROPPED instead
            emulator.sendInputReport('keyboard', key(KEY_A, 0))
            await throughSyscall(emulator, 2)
            expect(readEvents(emulator).rax).toBe(EAGAIN) // not readable until a packet ends
            clock.set(2000)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator)
            const events = readEvents(emulator).events
            expect(plain(events)).toEqual([
                [EV_SYN, SYN_DROPPED, 0],
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            // the SYN_DROPPED at the ioctl's time, which the next packet keeps, as Linux's
            // input_get_timestamp() leaves it
            expect(events.map(({ sec, usec }) => [sec, usec])).toEqual(
                new Array(4).fill([1n, 234567n])
            )
            expect(await finish(emulator)).toEqual([EINVAL])
        } finally {
            emulator.dispose()
        }
    })
})

describe('readers', () => {
    it('each get every event, unless one holds the grab', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            'sys 0, r12, buf, 4096',
            'save',
            'sys 0, r13, buf, 4096',
            'save',
            `sys 16, r12, ${EVIOCGRAB}, 1`,
            'save',
            `sys 16, r13, ${EVIOCGRAB}, 1`,
            'save',
            `sys 16, r13, ${EVIOCGRAB}, 0`, // not the holder's to let go
            'save',
            'sys 0, r12, buf, 4096',
            'save',
            'sys 0, r13, buf, 4096',
            'save',
            `sys 16, r12, ${EVIOCGLED(8)}, buf2`, // the console saw no Caps Lock
            'saveq buf2',
            `sys 16, r12, ${EVIOCGRAB}, 0`,
            'save',
            'sys 0, r13, buf, 4096',
            'save'
        ])
        try {
            await throughSyscall(emulator, 2)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator, 5)
            emulator.sendInputReport('keyboard', key(KEY_CAPSLOCK, 1))
            await throughSyscall(emulator, 4)
            emulator.sendInputReport('keyboard', key(KEY_A, 0))
            expect(await finish(emulator)).toEqual([
                72n,
                72n,
                0n,
                EBUSY,
                EINVAL,
                72n,
                EAGAIN,
                0n,
                0n,
                72n
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('can mask events out with EVIOCSMASK and read the mask back', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            'mov dword [buf2], 0', // the types
            'mov dword [buf2 + 4], 8',
            'mov qword [buf2 + 8], buf2 + 64',
            `mov qword [buf2 + 64], ${(1 << EV_SYN) | (1 << EV_KEY)}`,
            `sys 16, r12, ${EVIOCSMASK}, buf2`,
            'save',
            'sys 0, r12, buf, 4096',
            'mov dword [buf2], 1', // EV_KEY's codes: never set, so all
            'mov dword [buf2 + 4], 16',
            'mov qword [buf2 + 8], buf2 + 128',
            `sys 16, r12, ${EVIOCGMASK}, buf2`,
            'save',
            'saveq buf2 + 128',
            'saveq buf2 + 136'
        ])
        try {
            await throughSyscall(emulator, 2)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator)
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_KEY, KEY_A, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            expect(await finish(emulator)).toEqual([0n, 0n, -1n, -1n])
        } finally {
            emulator.dispose()
        }
    })

    it('that fall a whole queue behind get SYN_DROPPED and the newest events', async () => {
        const emulator = await keyboardReader()
        try {
            // 1,366 key packets of three events: the 4,096th event finds the queue full
            for (let index = 0; index < 1366; index++)
                emulator.sendInputReport('keyboard', key(KEY_A, index % 2 ? 0 : 1))
            await throughSyscall(emulator)
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_SYN, SYN_DROPPED, 0],
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('read whole events, EINVAL below one, EAGAIN with none, and ENODEV once revoked', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            'sys 0, r12, buf, 50', // two events fit
            'save',
            'sys 0, r12, buf, 23',
            'save',
            'sys 0, r12, buf, 24',
            'save',
            'sys 0, r12, buf, 24',
            'save',
            `sys 16, r12, ${EVIOCREVOKE}, 1`,
            'save',
            `sys 16, r12, ${EVIOCREVOKE}, 0`,
            'save',
            'sys 0, r12, buf, 24',
            'save',
            `sys 16, r12, ${EVIOCGLED(8)}, buf`,
            'save',
            'mov dword [buf], r12d',
            'mov word [buf + 4], 5', // POLLIN | POLLOUT
            'sys 7, buf, 1, 0',
            'movzx eax, word [buf + 6]',
            'save'
        ])
        try {
            await throughSyscall(emulator)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            expect(await finish(emulator)).toEqual([
                48n,
                EINVAL,
                24n,
                EAGAIN,
                EINVAL,
                0n,
                ENODEV,
                ENODEV,
                0x18n // POLLHUP | POLLERR
            ])
        } finally {
            emulator.dispose()
        }
    })
})

describe('a wait on an input device', () => {
    it('in a blocking read ends with the report that reaches it', async () => {
        const emulator = await build([
            `sys 2, kbd, 0`,
            'mov r12, rax',
            'sys 0, r12, buf, 4096',
            'save'
        ])
        try {
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            expect(emulator.getWaitRequest()?.wakeSources.inputDevices).toEqual(['keyboard'])
            // a report for another device does not end it
            emulator.sendInputReport('tablet', [{ type: EV_ABS, code: ABS_X, value: 5 }])
            expect(emulator.state).toBe(BlinkState.ProgramWaitPause)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            expect(emulator.state).not.toBe(BlinkState.ProgramWaitPause)
            expect(await finish(emulator)).toEqual([72n])
        } finally {
            emulator.dispose()
        }
    })

    it('in poll is ready for reading once a packet is queued', async () => {
        const emulator = await build([
            `sys 2, tablet, ${O_NONBLOCK}`,
            'mov dword [buf], eax',
            'mov word [buf + 4], 1', // POLLIN
            'sys 7, buf, 1, 0',
            'save',
            'sys 7, buf, 1, -1',
            'save',
            'movzx eax, word [buf + 6]',
            'save'
        ])
        try {
            expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
            expect(emulator.getWaitRequest()).toMatchObject({
                deadlineNanoseconds: null,
                wakeSources: { terminal: false, inputDevices: ['tablet'] }
            })
            emulator.sendInputReport('tablet', [{ type: EV_ABS, code: ABS_Y, value: 7 }])
            expect(await finish(emulator)).toEqual([0n, 1n, 1n])
        } finally {
            emulator.dispose()
        }
    })
})

describe('writes', () => {
    it('take whole events, which reach every reader and the device', async () => {
        const event = (offset: number, type: number, code: number, value: number) => [
            `mov word [buf + ${offset + 16}], ${type}`,
            `mov word [buf + ${offset + 18}], ${code}`,
            `mov dword [buf + ${offset + 20}], ${value}`
        ]
        const results = await probe([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `sys 2, speaker, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            ...event(0, EV_LED, LED_CAPSL, 1),
            ...event(24, EV_SYN, SYN_REPORT, 0),
            'sys 1, r12, buf, 23',
            'save',
            'sys 1, r12, buf, 50', // the two whole events of it
            'save',
            `sys 16, r12, ${EVIOCGLED(8)}, buf2`, // which throws the LED event away
            'saveq buf2',
            'sys 0, r12, buf2, 4096',
            'save',
            'saved buf2 + 16',
            ...event(0, EV_SND, SND_TONE, 440),
            'sys 1, r13, buf, 48',
            'save',
            `sys 16, r13, ${EVIOCGSND(8)}, buf2`,
            'saveq buf2',
            'sys 0, r13, buf2, 4096',
            'save',
            'sys 1, r13, buf, 0',
            'save'
        ])
        // EVIOCGLED and EVIOCGSND throw the LED and the tone away and keep the leading report
        expect(results).toEqual([EINVAL, 48n, 2n, 24n, 0n, 48n, 4n, 24n, 0n])
    })
})

describe('Undo', () => {
    it('puts the events a read took back at the front of its queue', async () => {
        const emulator = await keyboardReader()
        try {
            const first = await readAfter(emulator, ['keyboard', key(KEY_A, 1)])
            expect(first.rax).toBe(72n)
            emulator.sendInputReport('keyboard', key(KEY_A, 0))
            emulator.undo()
            await throughSyscall(emulator)
            const again = readEvents(emulator)
            expect(again.rax).toBe(144n)
            expect(again.events.slice(0, 3)).toEqual(first.events)
            expect(plain(again.events.slice(3))).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('of a read that waited for its events puts them back: it does not ask again', async () => {
        const emulator = await build([`sys 2, kbd, 0`, 'mov r12, rax', 'sys 0, r12, buf, 4096'])
        try {
            await throughSyscall(emulator)
            await throughSyscall(emulator)
            expect(emulator.getStatus()).toBe(EmulatorStatus.Waiting)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            const first = readEvents(emulator)
            expect(first.rax).toBe(72n)
            emulator.undo()
            await throughSyscall(emulator)
            expect(emulator.getStatus()).not.toBe(EmulatorStatus.Waiting)
            expect(readEvents(emulator)).toEqual(first)
        } finally {
            emulator.dispose()
        }
    })

    it('takes back what EVIOCSABS set', async () => {
        const emulator = await build([
            `sys 2, tablet, ${O_RDWR}`,
            'mov r12, rax',
            'mov dword [buf + 8], 100',
            `sys 16, r12, ${EVIOCSABS(ABS_X)}, buf`,
            `sys 16, r12, ${EVIOCGABS(ABS_X)}, buf2`
        ])
        try {
            await throughSyscall(emulator, 2)
            undoSyscalls(emulator)
            await skipSyscall(emulator)
            await throughSyscall(emulator)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('rdx') + 8n, 4n)).toEqual(
                new Uint8Array([0xff, 0x7f, 0, 0])
            )
        } finally {
            emulator.dispose()
        }
    })

    it('puts back the key events EVIOCGKEY threw away, and answers the keys held now', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            `sys 16, r12, ${EVIOCGKEY(96)}, buf2`,
            'sys 0, r12, buf, 4096'
        ])
        try {
            await throughSyscall(emulator, 2)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator, 2)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('rsi') + 4096n, 8n)).toEqual(
                new Uint8Array([0, 0, 0, 0x40, 0, 0, 0, 0])
            )
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_SYN, SYN_REPORT, 0]
            ])
            // the key goes up behind what the read and the flush took, which Undo puts back
            emulator.sendInputReport('keyboard', key(KEY_A, 0))
            undoSyscalls(emulator, 2)
            // EVIOCGKEY again, of the other reader: the key is up now
            emulator.setRegisterValue('rdi', emulator.getRegisterValue('r13'))
            await throughSyscall(emulator, 2)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('rsi') + 4096n, 8n)).toEqual(
                new Uint8Array(8)
            )
            expect(plain(readEvents(emulator).events)).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 1],
                [EV_SYN, SYN_REPORT, 0],
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 0],
                [EV_SYN, SYN_REPORT, 0]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('takes back a write: its events, and the LED it lit', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `mov word [buf + 16], ${EV_LED}`,
            `mov word [buf + 18], ${LED_CAPSL}`,
            'mov dword [buf + 20], 1',
            'sys 1, r12, buf, 48', // and a SYN_REPORT
            `sys 16, r12, ${EVIOCGLED(8)}, buf2`,
            'sys 0, r12, buf, 4096'
        ])
        try {
            await throughSyscall(emulator, 2)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            await skipSyscall(emulator)
            await throughSyscall(emulator)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('rdx'), 1n)[0]).toBe(0)
            await throughSyscall(emulator)
            expect(readEvents(emulator).rax).toBe(EAGAIN)
        } finally {
            emulator.dispose()
        }
    })

    it('takes back EVIOCSCLOCKID and the grab', async () => {
        const emulator = await build([
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            'mov dword [buf2], 1',
            `sys 16, r12, ${EVIOCSCLOCKID}, buf2`,
            `sys 16, r12, ${EVIOCGRAB}, 1`,
            `sys 16, r13, ${EVIOCGRAB}, 1`,
            'sys 0, r12, buf, 4096'
        ])
        try {
            await throughSyscall(emulator, 2)
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
            await throughSyscall(emulator, 2)
            undoSyscalls(emulator, 2)
            await skipSyscall(emulator)
            await skipSyscall(emulator)
            // the grab is free again, and r12 has its wall clock and its events
            await throughSyscall(emulator)
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(0n)
            emulator.sendInputReport('keyboard', key(KEY_A, 0)) // r13's alone
            await throughSyscall(emulator)
            const { events } = readEvents(emulator)
            expect(plain(events)).toEqual([
                [EV_MSC, MSC_SCAN, 0x1e],
                [EV_KEY, KEY_A, 1],
                [EV_SYN, SYN_REPORT, 0]
            ])
            expect(events[0].sec).toBeGreaterThan(1_000_000_000n)
        } finally {
            emulator.dispose()
        }
    })
})

describe('sendInputReport', () => {
    it('checks the device and the events', async () => {
        const emulator = await createX86Emulator()
        try {
            expect(() => emulator.sendInputReport('mouse' as 'tablet', [])).toThrow(TypeError)
            expect(() =>
                emulator.sendInputReport('keyboard', [{ type: 1, code: 0x10000, value: 1 }])
            ).toThrow(RangeError)
            expect(() =>
                emulator.sendInputReport('keyboard', [{ type: 1, code: 30, value: 2 ** 31 }])
            ).toThrow(RangeError)
            expect(() =>
                emulator.sendInputReport(
                    'keyboard',
                    Array.from({ length: 65 }, () => ({ type: 1, code: 30, value: 1 }))
                )
            ).toThrow(RangeError)
            // with no program, nothing happens
            emulator.sendInputReport('keyboard', key(KEY_A, 1))
        } finally {
            emulator.dispose()
        }
    })
})
