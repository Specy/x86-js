// The sound devices (x86-devices-plan.md, M4): /dev/dsp and /dev/mixer as snd-pcm-oss and
// snd-mixer-oss have them on the guest's HDA card, the raw MIDI port, the PC speaker and the
// console's tone ioctls, the timeline they hand the host on Program time, and Undo. The values are
// those of the QEMU guest x86's devices follow (ADR 0067), worked out from Linux 6.12's and QEMU
// 10.0's sources and provisional until it is booted, so these run in the Core only.
import { describe, expect, it } from 'vitest'
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

const EPERM = -1n
const EIO = -5n
const ENXIO = -6n
const EAGAIN = -11n
const ENODEV = -19n
const EINVAL = -22n
const ENOTTY = -25n

const O_WRONLY = 1
const O_RDWR = 2
const O_APPEND = 0x400
const O_NONBLOCK = 0x800

const SNDCTL_DSP_RESET = 0x5000
const SNDCTL_DSP_SYNC = 0x5001
const SNDCTL_DSP_SPEED = 0xc0045002
const SNDCTL_DSP_STEREO = 0xc0045003
const SNDCTL_DSP_GETBLKSIZE = 0xc0045004
const SNDCTL_DSP_SETFMT = 0xc0045005
const SNDCTL_DSP_CHANNELS = 0xc0045006
const SNDCTL_DSP_SETFRAGMENT = 0xc004500a
const SNDCTL_DSP_GETFMTS = 0x8004500b
const SNDCTL_DSP_GETOSPACE = 0x8010500c
const SNDCTL_DSP_GETCAPS = 0x8004500f
const SNDCTL_DSP_GETODELAY = 0x80045017
const SOUND_PCM_READ_RATE = 0x80045002
const SOUND_PCM_READ_BITS = 0x80045005
const SOUND_PCM_READ_CHANNELS = 0x80045006
const OSS_GETVERSION = 0x80044d76
const SOUND_MIXER_READ_VOLUME = 0x80044d00
const SOUND_MIXER_WRITE_VOLUME = 0xc0044d00
const SOUND_MIXER_READ_PCM = 0x80044d04
const SOUND_MIXER_WRITE_PCM = 0xc0044d04
const SOUND_MIXER_READ_DEVMASK = 0x80044dfe
const SOUND_MIXER_READ_STEREODEVS = 0x80044dfb
const SOUND_MIXER_READ_RECMASK = 0x80044dfd
const SOUND_MIXER_INFO = 0x805c4d65
const RAWMIDI_PVERSION = 0x80045700
const RAWMIDI_INFO = 0x810c5701
const RAWMIDI_PARAMS = 0xc0305710
const RAWMIDI_STATUS = 0xc0385720
const RAWMIDI_DROP = 0x40045730
const RAWMIDI_DRAIN = 0x40045731
const KIOCSOUND = 0x4b2f
const KDMKTONE = 0x4b30
const TCGETS = 0x5401

const AFMT_MU_LAW = 0x1
const AFMT_A_LAW = 0x2
const AFMT_U8 = 0x8
const AFMT_S16_LE = 0x10

const MIDI_BYTE = 320000n // ten bits at 31,250 baud, in nanoseconds
const PIT = 1193182

const hex = (value: number) => `0x${value.toString(16)}`

const PATHS: Record<string, string> = {
    dsp: '/dev/dsp',
    mixer: '/dev/mixer',
    midi: '/dev/snd/midiC1D0',
    midi1: '/dev/midi1',
    tty0: '/dev/tty0',
    speaker: '/dev/input/event4'
}

const DATA = [
    'section .data',
    ...Object.entries(PATHS).map(([label, path]) => `${label}: db "${path}", 0`),
    'section .text'
]

/** An ioctl whose argument is an int at buf: `value` in, what it wrote back saved. */
const intIoctl = (fd: string, request: number, value?: number) => [
    ...(value === undefined ? [] : [`mov dword [buf], ${value}`]),
    `sys 16, ${fd}, ${hex(request)}, buf`,
    'save',
    'saved buf'
]

/** The bytes `values` at buf, a dword at a time from the given offset. */
const bytesAt = (label: string, values: readonly number[]) =>
    values.map((value, index) => `mov byte [${label} + ${index}], ${value}`)

type Heard = {
    pcm: X86PcmEvent[]
    midi: X86MidiEvent[]
    tone: X86ToneEvent[]
    mixer: X86MixerEvent[]
    cuts: X86SoundCutEvent[]
    /** Every event in the order it came, by kind. */
    order: string[]
}

function listen(emulator: X86Emulator): Heard {
    const heard: Heard = { pcm: [], midi: [], tone: [], mixer: [], cuts: [], order: [] }
    emulator.on('pcm', (event) => void (heard.pcm.push(event), heard.order.push('pcm')))
    emulator.on('midi', (event) => void (heard.midi.push(event), heard.order.push('midi')))
    emulator.on('tone', (event) => void (heard.tone.push(event), heard.order.push('tone')))
    emulator.on('mixer', (event) => void (heard.mixer.push(event), heard.order.push('mixer')))
    emulator.on('soundCut', (event) => void (heard.cuts.push(event), heard.order.push('cut')))
    return heard
}

/** A clock that only waits move, each to its deadline, in whole nanoseconds (see devices.test). */
function virtualClock(): X86Environment & { set(ns: bigint): void } {
    let now = 0n
    return {
        now: () => (Number(now) + 0.5) / 1e6,
        wait: async (request) => {
            if (request.deadlineNanoseconds === null)
                throw new Error('a wait with nothing to end it')
            if (request.deadlineNanoseconds > now) now = request.deadlineNanoseconds
        },
        set: (ns) => void (now = ns)
    }
}

async function build(body: readonly string[], environment: X86Environment = virtualClock()) {
    const emulator = await createX86Emulator({ environment })
    const result = await emulator.compile(probeSource([...body, 'finish', ...DATA]))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

/** Runs the probe to its end, waits included, which the environment's clock settles. */
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
        return quadwords(Uint8Array.from(stderr))
    } finally {
        stop()
    }
}

async function probe(body: readonly string[], environment?: X86Environment) {
    const emulator = await build(body, environment)
    try {
        const heard = listen(emulator)
        const results = await runToEnd(emulator)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return { results, heard }
    } finally {
        emulator.dispose()
    }
}

/** Undoes instructions until the system call before them is undone too. */
function undoSyscall(emulator: X86Emulator): void {
    for (let index = 0; index < 100; index++) {
        emulator.undo()
        if (emulator.getNextInstruction()?.code.toLowerCase().includes('syscall')) return
    }
    throw new Error('no system call to undo')
}

/** Steps through `count` system calls. */
async function throughSyscall(emulator: X86Emulator, count = 1): Promise<void> {
    for (let index = 0; index < 1000; index++) {
        const isCall = emulator.getNextInstruction()?.code.toLowerCase().includes('syscall')
        await emulator.step()
        if (isCall && --count === 0) return
    }
    throw new Error('the probe did not reach the syscall')
}

const openDsp = (flags = O_WRONLY) => [`sys 2, dsp, ${flags}`, 'mov r12, rax']

/** /dev/dsp at 16 kHz, a rate the card plays, with `count` fragments of 2^`shift` bytes. */
const dspAt16k = (count = 4, shift = 10) => [
    ...openDsp(),
    'mov dword [buf], 16000',
    `sys 16, r12, ${hex(SNDCTL_DSP_SPEED)}, buf`,
    `mov dword [buf], ${count * 0x10000 + shift}`,
    `sys 16, r12, ${hex(SNDCTL_DSP_SETFRAGMENT)}, buf`
]

const getOspace = (fd = 'r12') => [
    `sys 16, ${fd}, ${hex(SNDCTL_DSP_GETOSPACE)}, buf2`,
    'saved buf2', // fragments
    'saved buf2 + 4', // fragstotal
    'saved buf2 + 8', // fragsize
    'saved buf2 + 12' // bytes
]

describe('/dev/dsp', () => {
    it('opens at 8000 Hz, unsigned 8-bit, mono, and writes back what each setting gets', async () => {
        const { results } = await probe([
            ...openDsp(),
            ...intIoctl('r12', SOUND_PCM_READ_RATE),
            ...intIoctl('r12', SOUND_PCM_READ_BITS),
            ...intIoctl('r12', SOUND_PCM_READ_CHANNELS),
            ...intIoctl('r12', SNDCTL_DSP_GETFMTS),
            ...intIoctl('r12', SNDCTL_DSP_SETFMT, AFMT_A_LAW), // not in the mask: U8
            ...intIoctl('r12', SNDCTL_DSP_SETFMT, AFMT_S16_LE),
            ...intIoctl('r12', SNDCTL_DSP_SPEED, 500),
            ...intIoctl('r12', SNDCTL_DSP_SPEED, 400000),
            ...intIoctl('r12', SNDCTL_DSP_SPEED, 44100),
            ...intIoctl('r12', SNDCTL_DSP_CHANNELS, 0),
            ...intIoctl('r12', SNDCTL_DSP_CHANNELS, 6),
            `mov dword [buf], 129`,
            `sys 16, r12, ${hex(SNDCTL_DSP_CHANNELS)}, buf`,
            'save',
            ...intIoctl('r12', SNDCTL_DSP_STEREO, 1),
            ...intIoctl('r12', SNDCTL_DSP_GETCAPS),
            ...intIoctl('r12', OSS_GETVERSION),
            // what snd-pcm-oss does not know answers EINVAL, its own answer
            `sys 16, r12, 0x50ff, buf`,
            'save',
            `sys 16, r12, ${KIOCSOUND}, 440`,
            'save'
        ])
        expect(results).toEqual([
            ...[0n, 8000n],
            ...[0n, BigInt(AFMT_U8)],
            ...[0n, 1n],
            ...[0n, 0x5b1f9n], // μ-law, U8, S8, S16, U16, S24, packed S24, S32; no A-law
            ...[0n, BigInt(AFMT_U8)],
            ...[0n, BigInt(AFMT_S16_LE)],
            ...[0n, 1000n],
            ...[0n, 192000n],
            ...[0n, 44100n],
            ...[0n, 1n],
            ...[0n, 6n],
            EINVAL,
            ...[0n, 1n], // STEREO answers channels - 1
            ...[0n, 0x1201n], // TRIGGER | REALTIME, revision 1; no MMAP, no DUPLEX
            ...[0n, 0x030810n],
            EINVAL,
            EINVAL
        ])
    })

    it("has snd-pcm-oss's buffer on the HDA card, whose fragment depends on the order of the settings", async () => {
        const settings = (order: number[][]) => [
            ...openDsp(),
            ...order.flatMap(([request, value]) => intIoctl('r12', request, value).slice(0, 2)),
            ...intIoctl('r12', SNDCTL_DSP_GETBLKSIZE),
            ...getOspace(),
            'sys 3, r12'
        ]
        const { results } = await probe([
            ...settings([]),
            ...settings([
                [SNDCTL_DSP_SPEED, 44100],
                [SNDCTL_DSP_SETFMT, AFMT_S16_LE],
                [SNDCTL_DSP_CHANNELS, 2]
            ]),
            ...settings([
                [SNDCTL_DSP_SETFMT, AFMT_S16_LE],
                [SNDCTL_DSP_CHANNELS, 2],
                [SNDCTL_DSP_SPEED, 44100]
            ])
        ])
        expect(results).toEqual([
            // 8 kHz goes through the rate plugin to the card's 16 kHz, which halves the 4 KiB
            // fragment snd_pcm_oss_period_size() chose
            ...[0n, 2048n, 32n, 32n, 2048n, 65536n],
            ...[0n, 16384n, 32n, 32n, 16384n, 524288n],
            // set last, the rate is applied with the 8 kHz plugin still in the chain
            ...[0n, 32768n, 32n, 32n, 32768n, 1048576n]
        ])
    })

    it('takes SETFRAGMENT once', async () => {
        const { results } = await probe([
            ...openDsp(),
            ...intIoctl('r12', SNDCTL_DSP_SPEED, 16000),
            `mov dword [buf], ${0x4000a}`,
            `sys 16, r12, ${hex(SNDCTL_DSP_SETFRAGMENT)}, buf`,
            'save',
            `sys 16, r12, ${hex(SNDCTL_DSP_SETFRAGMENT)}, buf`,
            'save',
            ...getOspace()
        ])
        expect(results).toEqual([0n, 16000n, 0n, EINVAL, 4n, 4n, 1024n, 4096n])
    })

    it('keeps a short write silent until SYNC pads its fragment and plays it out', async () => {
        const { results, heard } = await probe([
            ...dspAt16k(),
            ...bytesAt('buf2 + 64', [0x00, 0x80, 0xff, 0x40]),
            'sys 1, r12, buf2 + 64, 4',
            'save',
            ...intIoctl('r12', SNDCTL_DSP_GETODELAY),
            ...getOspace(),
            `sys 16, r12, ${SNDCTL_DSP_SYNC}, 0`,
            'save',
            'sys 228, 1, buf2',
            'saveq buf2',
            'saveq buf2 + 8'
        ])
        expect(results).toEqual([4n, 0n, 0n, 3n, 4n, 1024n, 4092n, 0n, 0n, 64000000n])
        expect(heard.pcm).toHaveLength(1)
        const [pcm] = heard.pcm
        expect(pcm.start).toBe(0n)
        expect(pcm.rate).toBe(16000)
        expect(pcm.frames).toHaveLength(2048)
        expect([...pcm.frames.slice(0, 8)]).toEqual([-1, -1, 0, 0, 127 / 128, 127 / 128, -0.5, -0.5])
        expect(pcm.frames.slice(8).every((sample) => sample === 0)).toBe(true)
    })

    it('paces a blocking write by the card, fragment by fragment, on Program time', async () => {
        const { results, heard } = await probe([
            ...dspAt16k(),
            'sys 1, r12, buf, 8192',
            'save',
            'sys 228, 1, buf2',
            'saveq buf2',
            'saveq buf2 + 8'
        ])
        // four fragments at once, then one each time one has played: 64 ms a fragment
        expect(results).toEqual([8192n, 0n, 256000000n])
        expect(heard.pcm.map((pcm) => pcm.start)).toEqual(
            [0, 64, 128, 192, 256, 320, 384, 448].map((ms) => BigInt(ms) * 1000000n)
        )
    })

    it('answers a non-blocking write with what fits, and poll waits for a fragment', async () => {
        const { results } = await probe([
            ...openDsp(O_WRONLY | O_NONBLOCK),
            ...intIoctl('r12', SNDCTL_DSP_SPEED, 16000),
            `mov dword [buf], ${0x4000a}`,
            `sys 16, r12, ${hex(SNDCTL_DSP_SETFRAGMENT)}, buf`,
            'sys 1, r12, buf, 8192',
            'save',
            ...intIoctl('r12', SNDCTL_DSP_GETODELAY),
            'sys 1, r12, buf, 1024',
            'save',
            'sys 1, r12, buf, 10', // staged
            'save',
            'mov dword [buf2], r12d',
            'mov word [buf2 + 4], 4', // POLLOUT
            'sys 7, buf2, 1, -1',
            'save',
            'sys 228, 1, buf2',
            'saveq buf2 + 8'
        ])
        expect(results).toEqual([0n, 16000n, 4096n, 0n, 4096n, EAGAIN, 10n, 1n, 64000000n])
    })

    it('hands the host stereo floats, whatever the format and the channels', async () => {
        const { heard } = await probe([
            // S16_LE, four channels: the first two are kept, as the route plugin keeps them
            ...dspAt16k(4, 8),
            ...intIoctl('r12', SNDCTL_DSP_SETFMT, AFMT_S16_LE).slice(0, 2),
            ...intIoctl('r12', SNDCTL_DSP_CHANNELS, 4).slice(0, 2),
            ...bytesAt('buf2', [0x00, 0x80, 0xff, 0x7f, 0x00, 0x40, 0x11, 0x11]),
            'sys 1, r12, buf2, 256',
            'sys 3, r12',
            // μ-law, mono
            ...dspAt16k(4, 8),
            ...intIoctl('r12', SNDCTL_DSP_SETFMT, AFMT_MU_LAW).slice(0, 2),
            ...bytesAt('buf2 + 512', [0x00, 0xff, 0x80, 0x7f]),
            'sys 1, r12, buf2 + 512, 256',
            'sys 3, r12'
        ])
        expect(heard.pcm).toHaveLength(2)
        const [s16, ulaw] = heard.pcm
        expect(s16.frames).toHaveLength(32 * 2) // 256 bytes of 8-byte frames
        expect([...s16.frames.slice(0, 2)]).toEqual([-1, 32767 / 32768])
        expect([...ulaw.frames.slice(0, 8)]).toEqual([
            ...[-32124 / 32768, -32124 / 32768],
            ...[0, 0],
            ...[32124 / 32768, 32124 / 32768],
            ...[0, 0]
        ])
    })

    it('plays its buffer out at close, the last fragment padded', async () => {
        const { results, heard } = await probe([
            ...dspAt16k(),
            'sys 1, r12, buf, 1500',
            'save',
            'sys 3, r12',
            'save',
            'sys 228, 1, buf2',
            'saveq buf2 + 8'
        ])
        expect(results).toEqual([1500n, 0n, 128000000n])
        expect(heard.pcm.map((pcm) => [pcm.start, pcm.frames.length])).toEqual([
            [0n, 2048],
            [64000000n, 2048]
        ])
    })

    it('drops what it holds at RESET, cutting it', async () => {
        const { results, heard } = await probe([
            ...dspAt16k(),
            'sys 1, r12, buf, 4096',
            `sys 16, r12, ${SNDCTL_DSP_RESET}, 0`,
            'save',
            ...intIoctl('r12', SNDCTL_DSP_GETODELAY),
            ...getOspace()
        ])
        expect(results).toEqual([0n, 0n, 0n, 4n, 4n, 1024n, 4096n])
        expect(heard.cuts).toContainEqual({ after: 0n, device: 'dsp' })
    })

    it('is held by one description: a second open for writing answers EBUSY', async () => {
        const { results } = await probe([
            ...openDsp(),
            `sys 2, dsp, ${O_WRONLY}`,
            'save',
            'sys 3, r12',
            `sys 2, dsp, ${O_WRONLY}`,
            'save'
        ])
        expect(results).toEqual([-16n, 3n])
    })

    it('plays the staged fragment out when the program exits, without waiting', async () => {
        const { heard } = await probe([...dspAt16k(), 'sys 1, r12, buf, 100'])
        expect(heard.pcm.map((pcm) => [pcm.start, pcm.frames.length])).toEqual([[0n, 2048]])
    })

    it('stops at once when a signal ends the program', async () => {
        const emulator = await build([
            ...dspAt16k(),
            'sys 1, r12, buf, 4096',
            'sys 39',
            'mov r13, rax',
            'sys 62, r13, 15' // SIGTERM
        ])
        try {
            const heard = listen(emulator)
            await runToEnd(emulator)
            expect(emulator.stopReason?.kind).toBe('signal')
            expect(heard.cuts).toContainEqual({ after: 0n, device: 'dsp' })
        } finally {
            emulator.dispose()
        }
    })
})

describe('/dev/mixer', () => {
    it("has the HDA card's channels and levels, kept as written, and reports VOLUME", async () => {
        const { results, heard } = await probe([
            `sys 2, mixer, ${O_RDWR}`,
            'mov r13, rax',
            ...intIoctl('r13', SOUND_MIXER_READ_DEVMASK),
            ...intIoctl('r13', SOUND_MIXER_READ_STEREODEVS),
            ...intIoctl('r13', SOUND_MIXER_READ_RECMASK),
            ...intIoctl('r13', SOUND_MIXER_READ_VOLUME),
            ...intIoctl('r13', SOUND_MIXER_READ_PCM),
            ...intIoctl('r13', SOUND_MIXER_WRITE_VOLUME, 0x3264),
            ...intIoctl('r13', SOUND_MIXER_WRITE_VOLUME, 0x00c8),
            // the card has no PCM control: the channel keeps what it was given, mono
            ...intIoctl('r13', SOUND_MIXER_WRITE_PCM, 0x1020),
            ...intIoctl('r13', SOUND_MIXER_READ_PCM),
            `sys 16, r13, ${hex(0x80044d1f)}, buf`, // channel 31
            'save',
            `sys 16, r13, ${KIOCSOUND}, 0`,
            'save',
            `sys 16, r13, ${hex(SOUND_MIXER_INFO)}, buf2`,
            'save',
            'saveq buf2',
            'saveq buf2 + 16',
            'saved buf2 + 48',
            // and on /dev/dsp, as OSS allows
            ...openDsp(),
            ...intIoctl('r12', SOUND_MIXER_READ_VOLUME)
        ])
        expect(results).toEqual([
            ...[0n, 0x1001n], // VOLUME and IGAIN: "Master" and "Capture"
            ...[0n, 0x1001n],
            ...[0n, 0n],
            ...[0n, 0x4949n], // 73 each, alsactl init's -20 dB on 74 steps
            ...[0n, 0n],
            ...[0n, 0x3264n],
            ...[0n, 0x0064n],
            ...[0n, 0x2020n],
            ...[0n, 0x2020n],
            EIO,
            ENXIO,
            0n,
            0x65746e492d414448n, // "HDA-Inte"
            0x20444920554d4551n, // "QEMU ID "
            3n, // the volume control twice and the switch once
            ...[0n, 0x0064n]
        ])
        expect(heard.mixer).toEqual([
            { volume: [73, 73], pcm: [100, 100] },
            { volume: [100, 50], pcm: [100, 100] },
            { volume: [100, 0], pcm: [100, 100] }
        ])
    })
})

describe('the raw MIDI port', () => {
    it('sends at 31,250 baud and hands the host whole messages', async () => {
        const bytes = [
            ...[0x90, 0x3c, 0x64],
            ...[0x3e, 0x64], // running status
            0xf8, // a real-time byte: its time on the cable, nothing for the synthesizer
            ...[0x80, 0x3c, 0x00],
            ...[0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7] // GM System On
        ]
        const { results, heard } = await probe([
            `sys 2, midi, ${O_WRONLY}`,
            'mov r12, rax',
            ...bytesAt('buf2', bytes),
            `sys 1, r12, buf2, ${bytes.length}`,
            'save',
            'mov dword [buf], 0',
            `sys 16, r12, ${hex(RAWMIDI_STATUS)}, buf`,
            'save',
            'saveq buf + 24', // avail
            `sys 16, r12, ${hex(RAWMIDI_DRAIN)}, buf`,
            'save',
            'sys 228, 1, buf2 + 512',
            'saveq buf2 + 512 + 8'
        ])
        expect(results).toEqual([15n, 0n, 4096n - 15n, 0n, 15n * MIDI_BYTE])
        expect(heard.midi.map(({ at, message }) => [at, [...message]])).toEqual([
            [3n * MIDI_BYTE, [0x90, 0x3c, 0x64]],
            [5n * MIDI_BYTE, [0x90, 0x3e, 0x64]],
            [9n * MIDI_BYTE, [0x80, 0x3c, 0x00]],
            [15n * MIDI_BYTE, [0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7]]
        ])
    })

    it('answers its ioctls as the virtual card does', async () => {
        const { results } = await probe([
            `sys 2, midi, ${O_WRONLY}`,
            'mov r12, rax',
            ...intIoctl('r12', RAWMIDI_PVERSION),
            'mov dword [buf2 + 8], 0', // the output stream
            `sys 16, r12, ${hex(RAWMIDI_INFO)}, buf2`,
            'save',
            'saved buf2 + 12', // card
            'saved buf2 + 16', // flags
            'saveq buf2 + 20', // id
            'saveq buf2 + 84', // name
            'saved buf2 + 196', // subdevices
            'mov dword [buf2 + 8], 1', // the input stream, which a write-only open lacks
            `sys 16, r12, ${hex(RAWMIDI_INFO)}, buf2`,
            'save',
            // a 64-byte buffer, which drains first
            'mov qword [buf2], 0',
            'mov qword [buf2 + 8], 64',
            'mov qword [buf2 + 16], 1',
            'mov dword [buf2 + 24], 1',
            `sys 16, r12, ${hex(RAWMIDI_PARAMS)}, buf2`,
            'save',
            'mov qword [buf2 + 8], 16',
            `sys 16, r12, ${hex(RAWMIDI_PARAMS)}, buf2`,
            'save',
            'mov dword [buf], 0',
            `sys 16, r12, ${hex(RAWMIDI_STATUS)}, buf`,
            'saveq buf + 24',
            'sys 1, r12, buf2, 64',
            ...intIoctl('r12', RAWMIDI_DROP, 0).slice(0, 3),
            `sys 16, r12, ${hex(0x5401)}, buf`, // not 'W'
            'save',
            // O_APPEND needs O_NONBLOCK
            `sys 2, midi, ${O_WRONLY | O_APPEND}`,
            'save'
        ])
        expect(results).toEqual([
            ...[0n, 0x20004n],
            0n,
            1n,
            7n,
            0x6964694d726956n, // "VirMidi"
            0x206c617574726956n, // "Virtual "
            16n,
            ENODEV,
            0n,
            EINVAL,
            64n,
            0n,
            ENOTTY,
            EINVAL
        ])
    })

    it('is one substream for every open: one buffer, one running status', async () => {
        const { results, heard } = await probe([
            `sys 2, midi1, ${O_WRONLY}`, // OSS's path: append mode, atomic writes
            'mov r12, rax',
            `sys 2, midi, ${O_WRONLY | O_NONBLOCK}`,
            'mov r13, rax',
            ...bytesAt('buf2', [0x90, 0x3c, 0x64, 0x3e, 0x64]),
            'sys 1, r12, buf2, 3',
            'sys 1, r13, buf2 + 3, 2',
            'sys 1, r12, buf, 4091', // fills it
            'sys 1, r13, buf, 1',
            'save',
            'sys 1, r12, results + 1024, 5000', // larger than the buffer, atomic
            'save'
        ])
        expect(results).toEqual([EAGAIN, EIO])
        expect(heard.midi.slice(0, 2).map(({ message }) => [...message])).toEqual([
            [0x90, 0x3c, 0x64],
            [0x90, 0x3e, 0x64]
        ])
    })

    it('drains at close', async () => {
        const { results } = await probe([
            `sys 2, midi, ${O_WRONLY}`,
            'mov r12, rax',
            'sys 1, r12, buf, 100',
            'sys 3, r12',
            'sys 228, 1, buf2',
            'saveq buf2 + 8'
        ])
        expect(results).toEqual([100n * MIDI_BYTE])
    })

    it('drops its queue at DROP, cutting what had not left', async () => {
        const { heard } = await probe([
            `sys 2, midi, ${O_WRONLY}`,
            'mov r12, rax',
            ...bytesAt('buf2', [0x90, 0x3c, 0x64]),
            'sys 1, r12, buf2, 3',
            ...intIoctl('r12', RAWMIDI_DROP, 0).slice(0, 2)
        ])
        expect(heard.cuts).toContainEqual({ after: 0n, device: 'midi' })
    })
})

describe('the PC speaker', () => {
    it('sounds what KIOCSOUND and KDMKTONE ask on /dev/tty0, at the timer’s frequency', async () => {
        const clock = virtualClock()
        const { results, heard } = await probe(
            [
                `sys 2, tty0, ${O_RDWR}`,
                'mov r12, rax',
                // a tty: isatty() holds
                `sys 16, r12, ${TCGETS}, buf`,
                'save',
                'saved buf + 8', // c_cflag
                'saved buf + 12', // c_lflag
                `sys 16, r12, ${KIOCSOUND}, ${Math.floor(PIT / 440)}`,
                'save',
                `sys 16, r12, ${KIOCSOUND}, 0`,
                // 100 ms of 440 Hz, then 10 ms, which ends at the next jiffy: 12 ms
                `sys 16, r12, ${KDMKTONE}, ${(100 << 16) | 2711}`,
                'mov qword [buf2], 0',
                'mov qword [buf2 + 8], 50000000',
                'sys 35, buf2, 0',
                `sys 16, r12, ${KDMKTONE}, ${(10 << 16) | 2711}`,
                // a divisor too small for the speaker is silence
                'mov qword [buf2 + 8], 50000000',
                'sys 35, buf2, 0',
                `sys 16, r12, ${KIOCSOUND}, 1`,
                // only root may
                'sys 105, 1000',
                `sys 16, r12, ${KIOCSOUND}, 2711`,
                'save'
            ],
            clock
        )
        expect(results).toEqual([0n, 0x4bfn, 0x8a3bn, 0n, EPERM])
        const tone = PIT / 2711
        expect(heard.tone).toEqual([
            { at: 0n, hz: tone },
            { at: 0n, hz: 0 },
            { at: 0n, hz: tone },
            { at: 100000000n, hz: 0 },
            // 50 ms on, the second KDMKTONE cancels the first's end for its own
            { at: 62000000n, hz: 0 }
        ])
        expect(heard.cuts).toContainEqual({ after: 50000000n, device: 'speaker' })
    })

    it("takes the pcspkr driver's EV_SND events, written to /dev/input/event4", async () => {
        const events: [number, number, number][] = [
            [0x12, 2, 440], // SND_TONE
            [0x12, 2, 20], // too low: silence
            [0x12, 1, 5], // SND_BELL: 1000 Hz
            [0x12, 1, 0],
            [0x12, 2, 32766],
            [0x12, 2, 32767], // too high
            [0x01, 2, 440], // not EV_SND, which the speaker lacks
            [0x12, 0, 1] // SND_CLICK, which the speaker lacks too
        ]
        const { results, heard } = await probe([
            `sys 2, speaker, ${O_WRONLY}`,
            'mov r12, rax',
            ...events.flatMap(([type, code, value], index) => [
                `mov word [buf + ${index * 24 + 16}], ${type}`,
                `mov word [buf + ${index * 24 + 18}], ${code}`,
                `mov dword [buf + ${index * 24 + 20}], ${value}`
            ]),
            `sys 1, r12, buf, ${events.length * 24}`,
            'save'
        ])
        expect(results).toEqual([BigInt(events.length * 24)])
        expect(heard.tone.map(({ hz }) => hz)).toEqual([
            PIT / 2711,
            0,
            PIT / 1193,
            0,
            PIT / 36,
            0
        ])
    })
})

describe('Undo', () => {
    it('takes back the samples a write gave the card and puts the staged ones back', async () => {
        const clock = virtualClock()
        const emulator = await build(
            [...dspAt16k(), 'sys 1, r12, buf, 100', 'sys 1, r12, buf, 1000', 'save', ...getOspace()],
            clock
        )
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 5)
            expect(heard.pcm).toHaveLength(1)
            const frames = [...heard.pcm[0].frames]
            clock.set(10000000n)
            emulator.undo()
            expect(heard.cuts.at(-1)).toEqual({ after: 10000000n, device: 'dsp' })
            // the write runs again from the same staged bytes
            await throughSyscall(emulator)
            expect(heard.pcm).toHaveLength(2)
            expect([...heard.pcm[1].frames]).toEqual(frames)
            expect(heard.pcm[1].start).toBe(10000000n)
            const results = await runToEnd(emulator)
            // a fragment queued at 10 ms, 76 bytes staged
            expect(results).toEqual([1000n, 2n, 4n, 1024n, 4096n - 1024n - 76n])
        } finally {
            emulator.dispose()
        }
    })

    it('takes back what a write that waited queued, and keeps what was heard', async () => {
        const clock = virtualClock()
        const emulator = await build([...dspAt16k(), 'sys 1, r12, buf, 8192', 'save'], clock)
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 3)
            // the write waits four times, as one instruction
            while (!emulator.getNextInstruction()?.code.toLowerCase().includes('syscall'))
                await emulator.step()
            await emulator.step()
            for (let index = 0; index < 100 && emulator.runtime.isWaiting(); index++) {
                await new Promise<void>((resolve) => {
                    const done = emulator.on('stateChange', () => {
                        done()
                        resolve()
                    })
                })
            }
            expect(heard.pcm).toHaveLength(8)
            expect(emulator.getRegisterValue('rax')).toBe(8192n)
            const cuts = heard.cuts.length
            emulator.undo()
            // at 256 ms the first four fragments have played: the rest is cut, each time the
            // write ran from the last fragment it queued back
            expect(heard.cuts.slice(cuts).map(({ after }) => after / 1000000n)).toEqual([
                448n,
                384n,
                320n,
                256n,
                256n
            ])
            // and the write runs again from nothing it queued: the ring is empty, so four
            // fragments go at once and it waits again
            await throughSyscall(emulator)
            expect(heard.pcm.slice(8).map((pcm) => pcm.start / 1000000n)).toEqual([
                256n,
                320n,
                384n,
                448n
            ])
        } finally {
            emulator.dispose()
        }
    })

    it('puts the settings back: SETFRAGMENT works again', async () => {
        const emulator = await build([
            ...openDsp(),
            `mov dword [buf], ${0x4000a}`,
            `sys 16, r12, ${hex(SNDCTL_DSP_SETFRAGMENT)}, buf`,
            'save'
        ])
        try {
            emulator.initialize(100)
            await throughSyscall(emulator, 2)
            expect(emulator.getRegisterValue('rax')).toBe(0n)
            emulator.undo()
            await throughSyscall(emulator)
            expect(emulator.getRegisterValue('rax')).toBe(0n)
        } finally {
            emulator.dispose()
        }
    })

    it('puts the mixer back and tells the host', async () => {
        const emulator = await build([
            `sys 2, mixer, ${O_RDWR}`,
            'mov r13, rax',
            ...intIoctl('r13', SOUND_MIXER_WRITE_VOLUME, 0x1010)
        ])
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 2)
            expect(heard.mixer.at(-1)).toEqual({ volume: [16, 16], pcm: [100, 100] })
            emulator.undo()
            expect(heard.mixer.at(-1)).toEqual({ volume: [73, 73], pcm: [100, 100] })
        } finally {
            emulator.dispose()
        }
    })

    it("takes back a MIDI write's bytes and restores the channels it changed", async () => {
        const clock = virtualClock()
        const emulator = await build(
            [
                `sys 2, midi, ${O_WRONLY}`,
                'mov r12, rax',
                ...bytesAt('buf2', [0xc0, 0x05, 0xb0, 0x07, 0x50, 0x90, 0x3c, 0x64]),
                'sys 1, r12, buf2, 2', // program 5
                'sys 1, r12, buf2 + 2, 3', // volume 80
                'sys 1, r12, buf2 + 5, 3', // a note
                'nop'
            ],
            clock
        )
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 4)
            expect(heard.midi).toHaveLength(3)
            // nothing has left yet: the note is cut and nothing else needs saying
            emulator.undo()
            expect(heard.cuts.at(-1)).toEqual({ after: 5n * MIDI_BYTE, device: 'midi' })
            expect(heard.midi).toHaveLength(3)
            await throughSyscall(emulator)
            expect(heard.midi).toHaveLength(4)
            // once everything has reached the synthesizer, Undo stops the note and sets the
            // volume and the program back
            clock.set(10000000n)
            emulator.undo()
            expect(heard.midi.slice(4).map(({ at, message }) => [at, [...message]])).toEqual([
                [10000000n, [0x80, 0x3c, 0x00]]
            ])
            undoSyscall(emulator)
            undoSyscall(emulator)
            expect(heard.midi.slice(5).map(({ at, message }) => [at, [...message]])).toEqual([
                [10000000n, [0xb0, 0x07, 100]],
                [10000000n, [0xc0, 0x00]]
            ])
        } finally {
            emulator.dispose()
        }
    })

    it("puts the speaker's tone back", async () => {
        const emulator = await build([
            `sys 2, tty0, ${O_RDWR}`,
            'mov r12, rax',
            `sys 16, r12, ${KIOCSOUND}, 2711`,
            `sys 16, r12, ${KIOCSOUND}, 0`
        ])
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 3)
            expect(heard.tone.map(({ hz }) => hz)).toEqual([PIT / 2711, 0])
            emulator.undo()
            expect(heard.cuts.at(-1)).toEqual({ after: 0n, device: 'speaker' })
            expect(heard.tone.at(-1)).toEqual({ at: 0n, hz: PIT / 2711 })
            undoSyscall(emulator)
            expect(heard.tone.at(-1)).toEqual({ at: 0n, hz: 0 })
        } finally {
            emulator.dispose()
        }
    })
})

describe('the end of the machine', () => {
    it('cuts every sound device', async () => {
        const emulator = await build([...dspAt16k(), 'sys 1, r12, buf, 4096', 'nop'])
        try {
            const heard = listen(emulator)
            emulator.initialize(100)
            await throughSyscall(emulator, 4)
            emulator.clearExecution()
            expect(heard.cuts.at(-1)).toEqual({ after: 0n })
        } finally {
            emulator.dispose()
        }
    })
})
