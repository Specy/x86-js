// The framebuffer, the input devices and the sound devices in one machine (x86-devices-plan.md,
// M2 to M4): the PC Speaker that both the evdev device and the console's tone ioctls reach, the
// reads and writes each device journals rather than making an Undo barrier, the raw MIDI port's
// four devices, one program using every family with Undo across them, and a start after a run
// that left every device in use finding none of it. The values are Linux 6.12's on the QEMU guest
// x86's devices follow (ADR 0067), provisional until it is booted, so these run in the Core only.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import {
    BlinkState,
    type X86Environment,
    type X86MidiEvent,
    type X86MixerEvent,
    type X86PcmEvent,
    type X86SoundCutEvent,
    type X86ToneEvent
} from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { probeSource, quadwords } from './linux-probe'

const EAGAIN = -11n

const O_WRONLY = 1
const O_RDWR = 2
const O_NONBLOCK = 0x800

const EV_SYN = 0
const EV_KEY = 1
const EV_MSC = 4
const EV_LED = 0x11
const EV_SND = 0x12
const SYN_REPORT = 0
const MSC_SCAN = 4
const KEY_A = 30
const LED_CAPSL = 1
const SND_BELL = 1
const SND_TONE = 2

const READ = 2
const WRITE = 1
const ioc = (dir: number, type: number, nr: number, size: number) =>
    `0x${(((dir << 30) | (size << 16) | (type << 8) | nr) >>> 0).toString(16)}`
const EVIOCGLED = ioc(READ, 0x45, 0x19, 8)
const EVIOCGSND = ioc(READ, 0x45, 0x1a, 8)
const EVIOCGRAB = ioc(WRITE, 0x45, 0x90, 4)

const FBIOGET_VSCREENINFO = 0x4600
const FBIOPAN_DISPLAY = 0x4606
const VAR_YOFFSET = 20
const SMEM_LEN = 320 * 4 * 480
const LINE = 320 * 4

const KIOCSOUND = 0x4b2f
const KDMKTONE = 0x4b30
const TCGETS = 0x5401
const TCSETS = 0x5402
const SOUND_PCM_READ_RATE = 0x80045002
const SNDCTL_DSP_SPEED = 0xc0045002
const SOUND_MIXER_READ_VOLUME = 0x80044d00
const SOUND_MIXER_WRITE_VOLUME = 0xc0044d00
const RAWMIDI_INFO = 0x810c5701
const RAWMIDI_STATUS = 0xc0385720

const PIT = 1193182
const MIDI_BYTE = 320000n // ten bits at 31,250 baud, in nanoseconds

const hex = (value: number) => `0x${value.toString(16)}`

const PATHS: Record<string, string> = {
    fb0: '/dev/fb0',
    kbd: '/dev/input/event1',
    speaker: '/dev/input/event4',
    dsp: '/dev/dsp',
    mixer: '/dev/mixer',
    midi: '/dev/snd/midiC1D0',
    midi1d1: '/dev/snd/midiC1D1',
    midi1d2: '/dev/snd/midiC1D2',
    midi1d3: '/dev/snd/midiC1D3',
    oss: '/dev/midi1',
    tty0: '/dev/tty0',
    file: '/project/scratch'
}

const DATA = [
    'section .data',
    ...Object.entries(PATHS).map(([label, path]) => `${label}: db "${path}", 0`),
    'section .text'
]

/** One `struct input_event` at buf + 24 × `index`, its time left as it is. */
const event = (index: number, type: number, code: number, value: number) => [
    `mov word [buf + ${index * 24 + 16}], ${type}`,
    `mov word [buf + ${index * 24 + 18}], ${code}`,
    `mov dword [buf + ${index * 24 + 20}], ${value}`
]

type Heard = {
    pcm: X86PcmEvent[]
    midi: X86MidiEvent[]
    tone: X86ToneEvent[]
    mixer: X86MixerEvent[]
    cuts: X86SoundCutEvent[]
    presents: number[]
    order: string[]
}

function listen(emulator: X86Emulator): Heard {
    const heard: Heard = {
        pcm: [],
        midi: [],
        tone: [],
        mixer: [],
        cuts: [],
        presents: [],
        order: []
    }
    emulator.on('pcm', (e) => void (heard.pcm.push(e), heard.order.push('pcm')))
    emulator.on('midi', (e) => void (heard.midi.push(e), heard.order.push('midi')))
    emulator.on('tone', (e) => void (heard.tone.push(e), heard.order.push('tone')))
    emulator.on('mixer', (e) => void (heard.mixer.push(e), heard.order.push('mixer')))
    emulator.on('soundCut', (e) => void (heard.cuts.push(e), heard.order.push('cut')))
    emulator.on('framebufferPresent', ({ yoffset }) => {
        heard.presents.push(yoffset)
        heard.order.push('present')
    })
    return heard
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

async function build(body: readonly string[], environment: X86Environment = virtualClock()) {
    const emulator = await createX86Emulator({ environment })
    const result = await emulator.compile(probeSource([...body, 'finish', ...DATA]))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

/** Runs the probe to its end, its timed waits included, and returns what it saved. */
async function runToEnd(emulator: X86Emulator): Promise<bigint[]> {
    const stderr: number[] = []
    const stop = emulator.on('stderr', (bytes) => void stderr.push(...bytes))
    try {
        for (let slice = 0; slice < 1000 && !emulator.hasTerminated(); slice++) {
            await emulator.run(1_000_000)
            while (emulator.state === BlinkState.ProgramWaitPause) {
                await new Promise<void>((resolve) => {
                    const done = emulator.on('stateChange', () => {
                        done()
                        resolve()
                    })
                })
            }
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return quadwords(Uint8Array.from(stderr))
    } finally {
        stop()
    }
}

async function probe(body: readonly string[]) {
    const emulator = await build(body)
    try {
        const heard = listen(emulator)
        return { results: await runToEnd(emulator), heard }
    } finally {
        emulator.dispose()
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

type Event = [type: number, code: number, value: number]

/** The events, without their times, a read made just now put in the buffer `rsi` names. */
function readEvents(emulator: X86Emulator): { rax: bigint; events: Event[] } {
    const rax = BigInt.asIntN(64, emulator.getRegisterValue('rax'))
    if (rax <= 0n) return { rax, events: [] }
    const bytes = emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), rax)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
        rax,
        events: Array.from({ length: bytes.byteLength / 24 }, (_, i) => [
            view.getUint16(i * 24 + 16, true),
            view.getUint16(i * 24 + 18, true),
            view.getInt32(i * 24 + 20, true)
        ])
    }
}

/** The events a probe's read saved with `saveEvents`: [type, code, value] each. */
function eventsOf(results: bigint[]): Event[] {
    return results.map((word) => {
        const bytes = new DataView(new ArrayBuffer(8))
        bytes.setBigInt64(0, word, true)
        return [bytes.getUint16(0, true), bytes.getUint16(2, true), bytes.getInt32(4, true)]
    })
}

/** After a read into buf, saves the read's result and the type, code and value of `count` events. */
const saveEvents = (count: number) => [
    'save',
    ...Array.from({ length: count }, (_, i) => `saveq buf + ${i * 24 + 16}`)
]

describe('the PC speaker', () => {
    it('sounds for EV_SND written to /dev/input/event4, through the sound devices’ driver', async () => {
        const { results, heard } = await probe([
            `sys 2, speaker, ${O_RDWR | O_NONBLOCK}`,
            'mov r12, rax',
            ...event(0, EV_SND, SND_TONE, 440),
            ...event(1, EV_SYN, SYN_REPORT, 0),
            'sys 1, r12, buf, 48',
            'save',
            ...event(0, EV_SND, SND_BELL, 1),
            'sys 1, r12, buf, 48',
            'save',
            ...event(0, EV_SND, SND_BELL, 0),
            ...event(1, EV_SND, SND_TONE, 0),
            'sys 1, r12, buf, 48',
            'save'
        ])
        expect(results).toEqual([48n, 48n, 48n])
        // pcspkr_event(): the tone at the PIT's frequency, the bell at 1000 Hz, then silence
        expect(heard.tone.map(({ hz }) => hz)).toEqual([PIT / 2711, PIT / 1193, 0])
    })

    it('hears KIOCSOUND and KDMKTONE through the input core, as the device’s readers do', async () => {
        const { results, heard } = await probe([
            `sys 2, speaker, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            `sys 2, tty0, ${O_RDWR}`,
            'mov r12, rax',
            // kd_mksound() injects SND_TONE, and SND_BELL 0 after a silence, with no SYN_REPORT:
            // they wait in the packet being built until a full one (eight values) is passed on
            `sys 16, r12, ${KIOCSOUND}, 2711`,
            'sys 0, r13, buf, 4096',
            'save',
            `sys 16, r13, ${EVIOCGSND}, buf2`,
            'saveq buf2',
            ...[0, 2711, 0, 2711, 0].map((count) => `sys 16, r12, ${KIOCSOUND}, ${count}`),
            'sys 0, r13, buf, 4096',
            ...saveEvents(9),
            `sys 16, r13, ${EVIOCGSND}, buf2`,
            'saveq buf2',
            // a reader's grab keeps the console out: no tone, and the device unchanged
            `sys 16, r13, ${EVIOCGRAB}, 1`,
            'save',
            `sys 16, r12, ${KIOCSOUND}, 2711`,
            'save',
            `sys 16, r13, ${EVIOCGSND}, buf2`,
            'saveq buf2',
            `sys 16, r13, ${EVIOCGRAB}, 0`,
            // 10 ms, which ends at the next jiffy, 12 ms on: its timer injects the silence
            `sys 16, r12, ${KDMKTONE}, ${(10 << 16) | 2711}`,
            `sys 16, r13, ${EVIOCGSND}, buf2`,
            'saveq buf2',
            'mov qword [buf2], 0',
            'mov qword [buf2 + 8], 50000000',
            'sys 35, buf2, 0',
            `sys 16, r13, ${EVIOCGSND}, buf2`,
            'saveq buf2'
        ])
        expect(results.slice(0, 3)).toEqual([EAGAIN, 4n, 216n]) // SND_TONE held
        expect(eventsOf(results.slice(3, 12))).toEqual([
            [EV_SND, SND_TONE, 440],
            [EV_SND, SND_TONE, 0],
            [EV_SND, SND_BELL, 0],
            [EV_SND, SND_TONE, 440],
            [EV_SND, SND_TONE, 0],
            [EV_SND, SND_BELL, 0],
            [EV_SND, SND_TONE, 440],
            [EV_SND, SND_TONE, 0],
            [EV_SYN, SYN_REPORT, 0] // the input core closed the full packet
        ])
        expect(results.slice(12)).toEqual([0n, 0n, 0n, 0n, 4n, 0n])
        const tone = PIT / 2711
        expect(heard.tone).toEqual([
            ...[tone, 0, tone, 0, tone, 0].map((hz) => ({ at: 0n, hz })),
            { at: 0n, hz: tone },
            { at: 12000000n, hz: 0 }
        ])
    })

    it('takes back what KIOCSOUND gave the device’s readers, and the tone', async () => {
        const emulator = await build([
            `sys 2, speaker, ${O_RDWR | O_NONBLOCK}`,
            'mov r13, rax',
            `sys 2, tty0, ${O_RDWR}`,
            'mov r12, rax',
            ...[2711, 0, 2711, 0, 2711, 0].map((count) => `sys 16, r12, ${KIOCSOUND}, ${count}`),
            'sys 0, r13, buf, 4096',
            `sys 16, r13, ${EVIOCGSND}, buf2`
        ])
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 9)
            expect(readEvents(emulator).rax).toBe(216n)
            // the read, then the KIOCSOUND that completed the packet
            for (let undone = 0; undone < 2; ) {
                emulator.undo()
                if (emulator.getNextInstruction()?.code.toLowerCase().includes('syscall'))
                    undone++
            }
            expect(heard.cuts.at(-1)).toEqual({ after: 0n, device: 'speaker' })
            expect(heard.tone.at(-1)).toEqual({ at: 0n, hz: PIT / 2711 })
            // skip the KIOCSOUND 0: the packet stays unfinished, the tone bit set
            emulator.setRegisterValue('rip', emulator.getRegisterValue('rip') + 2n)
            await throughSyscall(emulator)
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBe(EAGAIN)
            await throughSyscall(emulator)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('rdx'), 1n)[0]).toBe(4)
        } finally {
            emulator.dispose()
        }
    })
})

describe('Undo', () => {
    // each body's last system call, which must succeed
    it.each([
        [
            'a read of an input device',
            [
                `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
                'mov r12, rax',
                ...event(0, EV_LED, LED_CAPSL, 1),
                ...event(1, EV_SYN, SYN_REPORT, 0),
                'sys 1, r12, buf, 48',
                'sys 0, r12, buf2, 4096'
            ],
            3
        ],
        [
            'a write to an input device',
            [`sys 2, speaker, ${O_RDWR}`, 'mov r12, rax', ...event(0, EV_SND, SND_TONE, 440)].concat(
                ['sys 1, r12, buf, 24']
            ),
            2
        ],
        ['a write to /dev/dsp', [`sys 2, dsp, ${O_WRONLY}`, 'mov r12, rax', 'sys 1, r12, buf, 100'], 2],
        [
            'a writev to /dev/dsp',
            [
                `sys 2, dsp, ${O_WRONLY}`,
                'mov r12, rax',
                'mov qword [buf2], buf',
                'mov qword [buf2 + 8], 100',
                'sys 20, r12, buf2, 1'
            ],
            2
        ],
        [
            'a write to a raw MIDI port',
            [
                `sys 2, midi1d2, ${O_WRONLY}`,
                'mov r12, rax',
                'mov dword [buf], 0x643c90',
                'sys 1, r12, buf, 3'
            ],
            2
        ],
        [
            'a pwritev2 to a raw MIDI port at the current offset',
            [
                `sys 2, midi, ${O_WRONLY}`,
                'mov r12, rax',
                'mov dword [buf], 0x643c90',
                'mov qword [buf2], buf',
                'mov qword [buf2 + 8], 3',
                'sys 328, r12, buf2, 1, -1, 0, 0'
            ],
            2
        ],
        ['a read of /dev/fb0', ['sys 2, fb0, 2', 'mov r12, rax', 'sys 0, r12, buf, 64'], 2],
        ['a write to /dev/fb0', ['sys 2, fb0, 2', 'mov r12, rax', 'sys 1, r12, buf, 64'], 2],
        ['an lseek of /dev/fb0', ['sys 2, fb0, 2', 'mov r12, rax', 'sys 8, r12, 64, 0'], 2],
        ['a pwrite64 to /dev/fb0', ['sys 2, fb0, 2', 'mov r12, rax', 'sys 18, r12, buf, 64, 8'], 2]
    ] as const)('takes back %s, which is no barrier', async (_name, body, count) => {
        const emulator = await build(body)
        try {
            emulator.initialize(100)
            await throughSyscall(emulator, count)
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBeGreaterThan(0n)
            expect(emulator.getUndoHistory(1)[0]!.undoable).toBe(true)
            expect(emulator.canUndo()).toBe(true)
        } finally {
            emulator.dispose()
        }
    })

    it.each([
        ['a write to /dev/tty0', [`sys 2, tty0, ${O_RDWR}`, 'mov r12, rax', 'sys 1, r12, buf, 4'], 2],
        [
            'a pwritev2 at an offset of a File',
            [
                `sys 2, file, ${O_RDWR | 0x40}, 0o644`, // O_CREAT
                'mov r12, rax',
                'mov qword [buf2], buf',
                'mov qword [buf2 + 8], 4',
                'sys 328, r12, buf2, 1, 0, 0, 0'
            ],
            2
        ],
        [
            'a write to a File',
            [`sys 2, file, ${O_RDWR | 0x40}, 0o644`, 'mov r12, rax', 'sys 1, r12, buf, 4'],
            2
        ]
    ] as const)('keeps %s a barrier, as before', async (_name, body, count) => {
        const emulator = await build(body)
        try {
            emulator.initialize(100)
            await throughSyscall(emulator, count)
            expect(BigInt.asIntN(64, emulator.getRegisterValue('rax'))).toBeGreaterThan(0n)
            expect(emulator.getUndoHistory(1)[0]!.undoable).toBe(false)
        } finally {
            emulator.dispose()
        }
    })
})

describe('the raw MIDI port', () => {
    it('has snd-virmidi’s four devices, each playing what is written to it', async () => {
        const nodes = ['midi', 'midi1d1', 'midi1d2', 'midi1d3', 'oss']
        const { results, heard } = await probe([
            ...nodes.flatMap((node) => [`sys 4, ${node}, buf2`, 'saveq buf2 + 40']), // st_rdev
            ...nodes.flatMap((node, index) => [
                `sys 2, ${node}, ${O_WRONLY | O_NONBLOCK}`,
                'mov r12, rax',
                'mov dword [buf2 + 8], 0', // the output stream
                `sys 16, r12, ${hex(RAWMIDI_INFO)}, buf2`,
                'saved buf2', // device
                'saved buf2 + 12', // card
                `mov dword [buf], ${0x643c90 + index}`, // a note on, each its own
                'sys 1, r12, buf, 3',
                'save',
                'sys 3, r12'
            ])
        ])
        expect(results.slice(0, 5)).toEqual([0x7428n, 0x7429n, 0x742an, 0x742bn, 0x0e12n])
        expect(results.slice(5)).toEqual(
            [0n, 1n, 2n, 3n, 0n].flatMap((device) => [device, 1n, 3n])
        )
        // the one synthesizer hears them all, each after the last has left the port
        expect(heard.midi.map(({ at, message }) => [at, [...message]])).toEqual(
            nodes.map((_, index) => [3n * MIDI_BYTE * BigInt(index + 1), [0x90 + index, 0x3c, 0x64]])
        )
    })
})

describe('every device family at once', () => {
    it('draws, reads keys, plays samples, MIDI and a beep, and Undo takes it all back', async () => {
        const emulator = await build([
            'sys 2, fb0, 2',
            'mov r12, rax',
            `sys 9, 0, ${SMEM_LEN}, 3, 1, r12, 0`, // MAP_SHARED
            'mov r13, rax',
            `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
            'mov r14, rax',
            `sys 2, dsp, ${O_WRONLY}`,
            'mov r15, rax',
            `sys 2, midi, ${O_WRONLY}`,
            'mov rbx, rax',
            `sys 2, tty0, ${O_RDWR}`,
            'mov rbp, rax',
            // what Undo takes back from here
            'mov dword [r13], 0x00ff8000',
            'sys 0, r14, buf, 4096',
            'mov r8, rax', // what the read took, kept for the end
            'mov [buf2 + 3072], r8',
            'mov dword [buf2], 0x643c90',
            'sys 1, rbx, buf2, 3',
            'sys 1, r15, buf2 + 1024, 2048', // one whole fragment at the defaults
            `sys 16, rbp, ${KIOCSOUND}, 2711`,
            `sys 16, r12, ${FBIOGET_VSCREENINFO}, buf2 + 512`,
            `mov dword [buf2 + 512 + ${VAR_YOFFSET}], 240`,
            `sys 16, r12, ${FBIOPAN_DISPLAY}, buf2 + 512`,
            'mov qword [buf2 + 4000], 0x112233',
            `sys 18, r12, buf2 + 4000, 4, ${LINE}`, // pwrite64 the first pixel of line 1
            'saveq buf2 + 3072',
            'mov eax, [r13]',
            'save',
            `mov eax, [r13 + ${LINE}]`,
            'save'
        ])
        try {
            const heard = listen(emulator)
            emulator.initialize(1000)
            await throughSyscall(emulator, 6)
            emulator.sendInputReport('keyboard', [{ type: EV_KEY, code: KEY_A, value: 1 }])
            const start = emulator.getPc()
            const mapped = emulator.getRegisterValue('r13')
            await throughSyscall(emulator, 1)
            const read = readEvents(emulator)
            expect(read).toEqual({
                rax: 72n,
                events: [
                    [EV_MSC, MSC_SCAN, 0x1e],
                    [EV_KEY, KEY_A, 1],
                    [EV_SYN, SYN_REPORT, 0]
                ]
            })
            await throughSyscall(emulator, 6)
            const framebuffer = emulator.getFramebuffer()!
            expect(framebuffer.yoffset).toBe(240)
            expect(emulator.readMemoryBytes(mapped, 4n)).toEqual(Uint8Array.of(0, 0x80, 0xff, 0))
            expect(emulator.readMemoryBytes(mapped + BigInt(LINE), 4n)).toEqual(
                Uint8Array.of(0x33, 0x22, 0x11, 0)
            )
            expect(heard.midi.map(({ message }) => [...message])).toEqual([[0x90, 0x3c, 0x64]])
            expect(heard.pcm).toHaveLength(1)
            expect(heard.tone).toEqual([{ at: 0n, hz: PIT / 2711 }])
            expect(heard.presents).toEqual([240])

            // every step since the keyboard's report is undoable: none of them is a barrier
            const steps = emulator.getUndoDepth()
            while (emulator.getPc() !== start) emulator.undo()
            expect(steps - emulator.getUndoDepth()).toBeGreaterThan(10)
            expect(framebuffer.yoffset).toBe(0)
            expect(heard.presents).toEqual([240, 0])
            expect(emulator.readMemoryBytes(mapped, 4n)).toEqual(new Uint8Array(4))
            expect(emulator.readMemoryBytes(mapped + BigInt(LINE), 4n)).toEqual(new Uint8Array(4))
            expect(heard.cuts).toEqual(
                expect.arrayContaining([
                    { after: 0n, device: 'speaker' },
                    { after: 0n, device: 'dsp' },
                    { after: 0n, device: 'midi' }
                ])
            )
            expect(heard.tone.at(-1)).toEqual({ at: 0n, hz: 0 })

            // the program goes on as if none of it had happened: the key is read again
            const results = await runToEnd(emulator)
            expect(results).toEqual([72n, 0xff8000n, 0x112233n])
            expect(heard.midi).toHaveLength(2)
            expect(heard.tone.at(-1)).toEqual({ at: 0n, hz: PIT / 2711 })
            expect(framebuffer.yoffset).toBe(240)
        } finally {
            emulator.dispose()
        }
    })
})

describe('a start after a run', () => {
    // What a program finds at its start, then everything it changes and leaves so: the pixel and
    // the pan, a grab and an LED, a tone on the speaker's device and a long KDMKTONE, samples, the
    // mixer, MIDI, the console's termios. It ends waiting on the keyboard, so the next start
    // abandons it mid-run, and the same program then runs again.
    const program = [
        'sys 2, fb0, 2',
        'mov r12, rax',
        `sys 9, 0, ${SMEM_LEN}, 3, 1, r12, 0`,
        'mov r13, rax',
        'mov eax, [r13]',
        'save',
        `sys 16, r12, ${FBIOGET_VSCREENINFO}, buf2`,
        `saved buf2 + ${VAR_YOFFSET}`,
        `sys 2, kbd, ${O_RDWR | O_NONBLOCK}`,
        'mov r14, rax',
        `sys 16, r14, ${EVIOCGRAB}, 1`,
        'save',
        `sys 16, r14, ${EVIOCGLED}, buf2`,
        'saveq buf2',
        'sys 0, r14, buf, 4096',
        'save',
        `sys 2, speaker, ${O_RDWR | O_NONBLOCK}`,
        'mov r15, rax',
        `sys 16, r15, ${EVIOCGSND}, buf2`,
        'saveq buf2',
        'sys 0, r15, buf, 4096',
        'save',
        `sys 2, dsp, ${O_WRONLY}`,
        'mov rbx, rax',
        'save',
        `sys 16, rbx, ${hex(SOUND_PCM_READ_RATE)}, buf2`,
        'saved buf2',
        `sys 2, mixer, ${O_RDWR}`,
        'mov rbp, rax',
        `sys 16, rbp, ${hex(SOUND_MIXER_READ_VOLUME)}, buf2`,
        'saved buf2',
        `sys 2, midi, ${O_WRONLY}`,
        'mov [buf2 + 3000], rax',
        'mov dword [buf2], 0',
        'mov rdi, [buf2 + 3000]',
        `sys 16, rdi, ${hex(RAWMIDI_STATUS)}, buf2`,
        'saveq buf2 + 24', // avail
        `sys 2, tty0, ${O_RDWR}`,
        'mov [buf2 + 3008], rax',
        'mov rdi, [buf2 + 3008]',
        `sys 16, rdi, ${TCGETS}, buf2`,
        'saved buf2 + 12', // c_lflag
        // and what it changes
        'mov dword [r13], 0x00ffffff',
        `sys 16, r12, ${FBIOGET_VSCREENINFO}, buf2`,
        `mov dword [buf2 + ${VAR_YOFFSET}], 240`,
        `sys 16, r12, ${FBIOPAN_DISPLAY}, buf2`,
        ...event(0, EV_LED, LED_CAPSL, 1),
        ...event(1, EV_SYN, SYN_REPORT, 0),
        'sys 1, r14, buf, 48',
        ...event(0, EV_SND, SND_TONE, 440),
        'sys 1, r15, buf, 48',
        'mov dword [buf2], 44100',
        `sys 16, rbx, ${hex(SNDCTL_DSP_SPEED)}, buf2`,
        'sys 1, rbx, buf + 1024, 3000',
        'mov dword [buf2], 0x6464',
        `sys 16, rbp, ${hex(SOUND_MIXER_WRITE_VOLUME)}, buf2`,
        'mov dword [buf2], 0x643c90',
        'mov rdi, [buf2 + 3000]',
        'sys 1, rdi, buf2, 3',
        'mov rdi, [buf2 + 3008]',
        `sys 16, rdi, ${KDMKTONE}, ${(10000 << 16) | 2711}`,
        `sys 16, rdi, ${TCGETS}, buf2`,
        'mov dword [buf2 + 12], 0',
        `sys 16, rdi, ${TCSETS}, buf2`,
        // the results so far, then a wait nothing ends
        'sys 1, 2, results, slot * 8',
        'sys 2, kbd, 0',
        'mov r12, rax',
        'sys 0, r12, buf, 4096'
    ]

    it('finds every device as the machine boots it, whatever the last run left', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(probeSource([...program, 'finish', ...DATA]))
        expect(result.ok, result.report).toBe(true)
        try {
            const heard = listen(emulator)
            const runOnce = async () => {
                const stderr: number[] = []
                const stop = emulator.on('stderr', (bytes) => void stderr.push(...bytes))
                try {
                    expect(await emulator.run(1_000_000)).toBe(EmulatorStatus.Waiting)
                    expect(emulator.getWaitRequest()?.wakeSources.inputDevices).toEqual([
                        'keyboard'
                    ])
                    return quadwords(Uint8Array.from(stderr))
                } finally {
                    stop()
                }
            }
            const first = await runOnce()
            expect(first).toEqual([
                0n, // a black framebuffer
                0n, // at the first page
                0n, // the keyboard not grabbed
                0n, // no LED lit
                EAGAIN, // nothing queued
                0n, // the speaker silent
                EAGAIN,
                first[7], // /dev/dsp opens
                8000n,
                0x4949n, // the mixer at 73
                4096n, // the MIDI port empty
                first[11] // the console's own lflag
            ])
            expect(first[7]).toBeGreaterThanOrEqual(0n)
            expect(heard.tone.length).toBeGreaterThan(0)
            expect(heard.midi).toHaveLength(1)
            const mixers = heard.mixer.length
            const cuts = heard.cuts.length

            // the same build started again, abandoning the run that waits
            const tones = heard.tone.length
            emulator.runtime.starti()
            expect(heard.cuts.slice(cuts)).toContainEqual({ after: expect.any(BigInt) })
            expect(heard.mixer.slice(mixers)).toEqual([{ volume: [73, 73], pcm: [100, 100] }])
            expect(emulator.getFramebuffer()).toBeNull()
            const second = await runOnce()
            expect(second).toEqual(first)
            // nothing the first run left sounding came back
            expect(heard.tone.slice(tones).map(({ hz }) => hz)).toEqual([PIT / 2711, 0])
        } finally {
            emulator.dispose()
        }
    })
})
