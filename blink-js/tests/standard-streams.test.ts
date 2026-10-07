// Descriptors 0 to 2 are a terminal, as for a Linux process started from a shell: one tty open
// for reading and writing, whose input the host gives through provideInput() and whose output
// reaches it a write at a time. Natively the probes here would read a pipe, not a tty, so they run
// in the Core only; the values they expect are what a Linux pseudo-terminal gives, checked on
// Linux 6.18 with a program run under one.
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { END_OF_INPUT, type X86Input } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { probeSource, quadwords } from './linux-probe'

const EINVAL = -22
const ENOTTY = -25
const ESPIPE = -29
const ESRCH = -3

/** `text` as the little-endian quadword a probe saves from a buffer holding it. */
function le(text: string): bigint {
    const bytes = new TextEncoder().encode(text)
    return bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n)
}

type Chunk = { channel: 'stdout' | 'stderr'; text: string }

type ProbeRun = {
    results: bigint[]
    /** Every write the host heard of, in order, but the results `finish` writes. */
    output: Chunk[]
    /** The `maxBytes` of each read that waited for input. */
    requests: bigint[]
}

async function build(body: readonly string[]): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(probeSource(body))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

/**
 * Runs a built probe to its end, answering each read that waits with the next of `answers`, all
 * of its inputs given at once.
 */
async function drive(emulator: X86Emulator, answers: X86Input[][] = []): Promise<ProbeRun> {
    const pending = [...answers]
    const output: Chunk[] = []
    const requests: bigint[] = []
    const stderr: number[] = []
    const stops = [
        emulator.on(
            'stdout',
            (bytes) => void output.push({ channel: 'stdout', text: decode(bytes) })
        ),
        emulator.on('stderr', (bytes) => {
            output.push({ channel: 'stderr', text: decode(bytes) })
            stderr.push(...bytes)
        }),
        emulator.on('inputRequest', ({ maxBytes }) => void requests.push(maxBytes))
    ]
    try {
        for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice += 1) {
            if ((await emulator.run(1_000_000)) !== EmulatorStatus.WaitingForInput) continue
            const answer = pending.shift()
            if (!answer)
                throw new Error(`read ${requests.length} waited for input nobody planned to give`)
            for (const input of answer) emulator.provideInput(input)
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        expect(pending, 'answers no read took').toEqual([])
        // `finish` writes the results last, in one write: a probe must save something
        const finish = output.pop()
        expect(finish?.channel).toBe('stderr')
        return {
            results: quadwords(Uint8Array.from(stderr.slice(stderr.length - finish!.text.length))),
            output,
            requests
        }
    } finally {
        for (const stop of stops) stop()
    }
}

function decode(bytes: Uint8Array): string {
    return String.fromCharCode(...bytes)
}

async function probe(
    body: readonly string[],
    answers: X86Input[][] = [],
    before: X86Input[] = []
): Promise<ProbeRun> {
    const emulator = await build([...body, 'finish'])
    try {
        for (const input of before) emulator.provideInput(input)
        return await drive(emulator, answers)
    } finally {
        emulator.dispose()
    }
}

/** buf2 as an iovec array: buf for 2 bytes, then buf + 64 for 64. */
const TWO_VECTORS = [
    'lea rax, [buf]',
    'mov [buf2], rax',
    'mov qword [buf2 + 8], 2',
    'lea rax, [buf + 64]',
    'mov [buf2 + 16], rax',
    'mov qword [buf2 + 24], 64'
]

describe('standard input', () => {
    it('gives a read at most what it asks for, and the rest to the next read without asking again', async () => {
        const run = await probe(
            [
                'sys 0, 0, buf, 3',
                'save',
                'saveq buf',
                'sys 0, 0, buf + 64, 64',
                'save',
                'saveq buf + 64'
            ],
            [['hello\n']]
        )
        expect(run.results).toEqual([3n, le('hel'), 3n, le('lo\n')])
        expect(run.requests).toEqual([3n])
    })

    it('ends a read after a line feed, as a canonical read does, whatever it asked for', async () => {
        const run = await probe(
            [
                'sys 0, 0, buf, 64',
                'save',
                'saveq buf',
                'sys 0, 0, buf + 64, 64',
                'save',
                'saveq buf + 64'
            ],
            [['ab\ncd\n']]
        )
        expect(run.results).toEqual([3n, le('ab\n'), 3n, le('cd\n')])
        expect(run.requests).toEqual([64n])
    })

    it("serves readv and a descriptor dup'd from 0 from the same input, and asks when it is empty", async () => {
        const run = await probe(
            [
                ...TWO_VECTORS,
                'sys 19, 0, buf2, 2',
                'save',
                'saveq buf',
                'saveq buf + 64',
                'sys 32, 0',
                'save',
                'mov r12, rax',
                'sys 0, r12, buf + 128, 64',
                'save',
                'saveq buf + 128'
            ],
            [['abc\n'], ['x\n']]
        )
        expect(run.results).toEqual([4n, le('ab'), le('c\n'), 3n, 2n, le('x\n')])
        // a readv waits for what its vectors hold in all
        expect(run.requests).toEqual([66n, 64n])
    })

    it('returns 0 for a read of nothing, without asking for input', async () => {
        const run = await probe([
            'sys 0, 0, buf, 0',
            'save',
            'lea rax, [buf]',
            'mov [buf2], rax',
            'mov qword [buf2 + 8], 0',
            'sys 19, 0, buf2, 1',
            'save', // vectors of no length
            'sys 19, 0, buf2, 0',
            'save' // no vectors
        ])
        expect(run.results).toEqual([0n, 0n, 0n])
        expect(run.requests).toEqual([])
    })

    it('ends exactly one read with End of input, and the next read waits again', async () => {
        const run = await probe(
            ['sys 0, 0, buf, 64', 'save', 'sys 0, 0, buf, 64', 'save', 'saveq buf'],
            [[END_OF_INPUT], ['z\n']]
        )
        expect(run.results).toEqual([0n, 2n, le('z\n')])
        expect(run.requests).toEqual([64n, 64n])
    })

    it('keeps bytes and End of input in the order they were given, and waits only when nothing is left', async () => {
        const run = await probe(
            [
                'sys 0, 0, buf, 64',
                'save',
                'sys 0, 0, buf, 64',
                'save',
                'sys 0, 0, buf, 64',
                'save',
                'saveq buf'
            ],
            [],
            ['ab', END_OF_INPUT, new TextEncoder().encode('cd\n')]
        )
        // what came before the token is a read of its own, as Ctrl+D on a line that has text
        expect(run.results).toEqual([2n, 0n, 3n, le('cd\n')])
        expect(run.requests).toEqual([])
    })

    it('splits a UTF-8 character where the read stops, keeping the rest', async () => {
        const run = await probe(
            ['sys 0, 0, buf, 1', 'save', 'saveq buf', 'sys 0, 0, buf, 64', 'save', 'saved buf'],
            [['é\n']]
        )
        expect(run.results).toEqual([1n, 0xc3n, 2n, 0x0aa9n])
    })

    it('has no position: pread, preadv, pwrite, pwritev and lseek answer ESPIPE, and preadv2 at the current position reads', async () => {
        const run = await probe(
            [
                'sys 17, 0, buf, 1, 0',
                'save', // pread64
                'lea rax, [buf]',
                'mov [buf2], rax',
                'mov qword [buf2 + 8], 1',
                'sys 295, 0, buf2, 1, 0',
                'save', // preadv at 0
                'sys 18, 1, buf, 1, 0',
                'save', // pwrite64
                'sys 296, 1, buf2, 1, 0',
                'save', // pwritev at 0
                'sys 8, 0, 0, 1',
                'save', // lseek(0, 0, SEEK_CUR)
                'sys 8, 1, 0, 1',
                'save',
                'sys 327, 0, buf2, 1, -1, 0, 0',
                'save',
                'saveq buf' // preadv2 at -1
            ],
            [['q\n']]
        )
        expect(run.results).toEqual([
            BigInt(ESPIPE),
            BigInt(ESPIPE),
            BigInt(ESPIPE),
            BigInt(ESPIPE),
            BigInt(ESPIPE),
            BigInt(ESPIPE),
            1n,
            le('q')
        ])
    })

    it('is no source for sendfile, which Linux splices only from files', async () => {
        const run = await probe([
            'sys 40, 1, 0, 0, 1',
            'save',
            'sys 40, 1, 0, buf2 + 64, 1',
            'save' // with an offset
        ])
        expect(run.results).toEqual([BigInt(EINVAL), BigInt(ESPIPE)])
        expect(run.requests).toEqual([])
    })

    it('counts with FIONREAD what no read took, and drops it with TCFLSH', async () => {
        const run = await probe(
            [
                'sys 0, 0, buf, 1',
                'save',
                'sys 16, 0, 0x541b, buf + 8',
                'save',
                'saved buf + 8', // FIONREAD
                'sys 16, 0, 0x540b, 0',
                'save', // TCFLSH TCIFLUSH
                'sys 16, 0, 0x541b, buf + 8',
                'save',
                'saved buf + 8',
                'sys 0, 0, buf, 64',
                'save',
                'saveq buf'
            ],
            [['abc\n'], ['z\n']]
        )
        expect(run.results).toEqual([1n, 0n, 3n, 0n, 0n, 0n, 2n, le('z\n')])
    })
})

describe('a read that waits, in the history', () => {
    it('records one read with memory mutations and refuses Undo across consumed input', async () => {
        const emulator = await build(['sys 0, 0, buf, 64', 'save', 'finish'])
        try {
            emulator.initialize(64)
            expect(await emulator.run()).toBe(EmulatorStatus.WaitingForInput)
            const buffer = emulator.getRegisterValue('rsi')
            const before = emulator.getRecordedEntryCount()
            emulator.provideInput('ab\ncd\n')
            expect(emulator.getRecordedEntryCount() - before).toBe(1)
            expect(emulator.getRegisterValue('rax')).toBe(3n)
            expect(Array.from(emulator.readMemoryBytes(buffer, 3n))).toEqual([0x61, 0x62, 0x0a])
            expect(emulator.getUndoHistory(1)[0].undoable).toBe(false)
            expect(emulator.canUndo()).toBe(false)
            expect(() => emulator.undo()).toThrow('cannot be undone')
            expect(emulator.getRegisterValue('rax')).toBe(3n)
            expect(Array.from(emulator.readMemoryBytes(buffer, 3n))).toEqual([0x61, 0x62, 0x0a])
        } finally {
            emulator.dispose()
        }
    })

    it('retains every vector a readv wrote while refusing Undo across consumed input', async () => {
        const emulator = await build([...TWO_VECTORS, 'sys 19, 0, buf2, 2', 'save', 'finish'])
        try {
            emulator.initialize(64)
            expect(await emulator.run()).toBe(EmulatorStatus.WaitingForInput)
            const first = emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), 32n)
            const base = new DataView(first.buffer, first.byteOffset).getBigUint64(0, true)
            const before = emulator.getRecordedEntryCount()
            emulator.provideInput('abc\n')
            expect(emulator.getRecordedEntryCount() - before).toBe(1)
            expect(emulator.getRegisterValue('rax')).toBe(4n)
            const writes = emulator
                .getUndoHistory(1)[0]!
                .mutations.filter((mutation) => mutation.type === 'WriteMemoryBytes')
            expect(writes.map((write) => write.value)).toEqual([
                { address: base, old: [0, 0], new: [0x61, 0x62] },
                { address: base + 64n, old: [0, 0], new: [0x63, 0x0a] }
            ])
            expect(emulator.canUndo()).toBe(false)
            expect(() => emulator.undo()).toThrow('cannot be undone')
            expect(Array.from(emulator.readMemoryBytes(base, 2n))).toEqual([0x61, 0x62])
            expect(Array.from(emulator.readMemoryBytes(base + 64n, 2n))).toEqual([0x63, 0x0a])
        } finally {
            emulator.dispose()
        }
    })
})

describe('the terminal', () => {
    it('answers TCGETS and TIOCGWINSZ on 0, 1 and 2, so isatty() is true', async () => {
        const run = await probe([
            'sys 16, 0, 0x5401, buf',
            'save', // TCGETS
            'saved buf',
            'saved buf + 4',
            'saved buf + 8',
            'saved buf + 12',
            'saveq buf + 16',
            'saveq buf + 24',
            'saved buf + 32',
            'sys 16, 1, 0x5401, buf2',
            'save',
            'sys 16, 2, 0x5401, buf2',
            'save',
            'sys 16, 2, 0x5413, buf + 64',
            'save',
            'saveq buf + 64' // TIOCGWINSZ
        ])
        expect(run.results).toEqual([
            0n,
            0x4500n, // ICRNL | IXON | IUTF8
            0x5n, // OPOST | ONLCR
            0xbfn, // B38400 | CS8 | CREAD
            0x8a3bn, // ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN
            // the line discipline, N_TTY, then Linux's control characters: ^C ^\ DEL ^U ^D, VTIME 0,
            // VMIN 1, VSWTC 0, ^Q ^S ^Z, VEOL 0, ^R ^O ^W ^V, VEOL2 0
            0x0100_0415_7f1c_0300n,
            0x170f_1200_1a13_1100n,
            0x16n,
            0n,
            0n,
            0n,
            24n | (80n << 16n) // 24 rows of 80 columns
        ])
    })

    it('accepts TCSETS, TCSETSW, TCSETSF and TIOCSWINSZ and changes nothing', async () => {
        const run = await probe([
            'sys 16, 0, 0x5401, buf',
            'mov dword [buf + 12], 0', // raw mode, asked for
            'sys 16, 0, 0x5402, buf',
            'save',
            'sys 16, 0, 0x5403, buf',
            'save',
            'sys 16, 0, 0x5404, buf',
            'save',
            'mov dword [buf + 64], 0x00100010',
            'sys 16, 0, 0x5414, buf + 64',
            'save',
            'sys 16, 0, 0x5401, buf2',
            'saved buf2 + 12',
            'sys 16, 0, 0x5413, buf2 + 64',
            'saveq buf2 + 64'
        ])
        expect(run.results).toEqual([0n, 0n, 0n, 0n, 0x8a3bn, 24n | (80n << 16n)])
    })

    it("leads the process's group and session, and refuses a group it has not", async () => {
        const run = await probe([
            'sys 16, 0, 0x540f, buf',
            'save',
            'saved buf',
            'sys 111',
            'save', // TIOCGPGRP, getpgrp
            'sys 16, 1, 0x5429, buf + 8',
            'save',
            'saved buf + 8',
            'sys 124, 0',
            'save', // TIOCGSID, getsid
            'sys 16, 2, 0x5410, buf',
            'save', // TIOCSPGRP to its own group
            'mov dword [buf + 16], 12345',
            'sys 16, 2, 0x5410, buf + 16',
            'save'
        ])
        const [pgrpOk, pgrp, getpgrp, sidOk, sid, getsid, ...rest] = run.results
        expect([pgrpOk, sidOk]).toEqual([0n, 0n])
        expect(pgrp).toBe(getpgrp)
        expect(sid).toBe(getsid)
        expect(rest).toEqual([0n, BigInt(ESRCH)])
    })

    it('is open for reading and writing on 0, 1 and 2, as a terminal a shell hands on', async () => {
        const run = await probe([
            'sys 72, 0, 3',
            'save',
            'sys 72, 1, 3',
            'save',
            'sys 72, 2, 3',
            'save'
        ])
        // O_RDWR, and O_LARGEFILE, which an x86-64 kernel gives every open file
        expect(run.results).toEqual([0x8002n, 0x8002n, 0x8002n])
    })

    it('answers ENOTTY to a request it does not know, and still takes FIONBIO', async () => {
        const run = await probe([
            'sys 16, 0, 0x5499, buf',
            'save',
            'mov dword [buf], 1',
            'sys 16, 0, 0x5421, buf',
            'save',
            'sys 72, 0, 3',
            'save', // FIONBIO on
            'mov dword [buf], 0',
            'sys 16, 0, 0x5421, buf',
            'save',
            'sys 72, 0, 3',
            'save'
        ])
        expect(run.results).toEqual([BigInt(ENOTTY), 0n, 0x8802n, 0n, 0x8002n])
    })

    it('is what /dev/tty, /dev/stdin and /dev/stderr open', async () => {
        const run = await probe(
            [
                'mov rax, "/dev/tty"',
                'mov [buf], rax',
                'sys 2, buf, 2',
                'save',
                'mov r12, rax', // O_RDWR
                'mov dword [buf + 64], "tty"',
                'sys 1, r12, buf + 64, 3',
                'save',
                'sys 0, r12, buf + 128, 64',
                'save',
                'saveq buf + 128',
                'sys 16, r12, 0x5401, buf2',
                'save',
                'mov rax, "/dev/std"',
                'mov [buf + 192], rax',
                'mov dword [buf + 200], "err"',
                'sys 2, buf + 192, 1',
                'save',
                'mov r13, rax', // O_WRONLY
                'mov dword [buf + 64], "err"',
                'sys 1, r13, buf + 64, 3',
                'save',
                'mov dword [buf + 200], "in"',
                'sys 2, buf + 192, 0',
                'save',
                'mov r14, rax',
                'sys 0, r14, buf + 256, 64',
                'save',
                'saveq buf + 256'
            ],
            [['t\n'], ['i\n']]
        )
        expect(run.results).toEqual([3n, 3n, 2n, le('t\n'), 0n, 4n, 3n, 5n, 2n, le('i\n')])
        expect(run.output).toEqual([
            { channel: 'stdout', text: 'tty' },
            { channel: 'stderr', text: 'err' }
        ])
    })
})

describe('standard output and standard error', () => {
    it('reach the host a write at a time, in the order the program wrote them', async () => {
        const run = await probe([
            'mov word [buf], "ab"',
            'sys 1, 1, buf, 2',
            'mov word [buf + 8], "cd"',
            'sys 1, 2, buf + 8, 2',
            'mov byte [buf + 16], "e"',
            'mov byte [buf + 24], "f"',
            'lea rax, [buf + 16]',
            'mov [buf2], rax',
            'mov qword [buf2 + 8], 1',
            'lea rax, [buf + 24]',
            'mov [buf2 + 16], rax',
            'mov qword [buf2 + 24], 1',
            'sys 20, 1, buf2, 2',
            'save', // writev: one write
            'sys 1, 1, buf, 0',
            'save', // nothing to hear of
            'mov word [buf + 32], "hi"',
            'sys 1, 0, buf + 32, 2',
            'save', // the terminal, through 0
            'sys 32, 2',
            'mov r12, rax', // standard error, kept
            'sys 33, 1, 2', // 2>&1
            'sys 1, 2, buf + 8, 2',
            'sys 33, r12, 2' // back, for the results
        ])
        expect(run.results).toEqual([2n, 0n, 2n])
        expect(run.output).toEqual([
            { channel: 'stdout', text: 'ab' },
            { channel: 'stderr', text: 'cd' },
            { channel: 'stdout', text: 'ef' },
            { channel: 'stdout', text: 'hi' },
            { channel: 'stdout', text: 'cd' }
        ])
    })

    it('hand each write over as bytes, a UTF-8 character split between writes included', async () => {
        const run = await probe([
            'mov word [buf], 0xa9c3',
            'sys 1, 1, buf, 1',
            'sys 1, 1, buf + 1, 1',
            'save'
        ])
        expect(run.results).toEqual([1n])
        expect(run.output.map((chunk) => chunk.text)).toEqual(['\xc3', '\xa9'])
    })

    it('reach the host through sendfile as writes', async () => {
        const emulator = await build([
            'mov rax, "/tmp/f"',
            'mov [buf], rax',
            'sys 2, buf, 0x42, 420',
            'mov r12, rax', // O_RDWR | O_CREAT
            'mov rax, "12345"',
            'mov [buf + 64], rax',
            'sys 1, r12, buf + 64, 5',
            'mov qword [buf2], 1',
            'sys 40, 1, r12, buf2, 3',
            'save',
            'finish'
        ])
        try {
            const run = await drive(emulator)
            expect(run.results).toEqual([3n])
            expect(run.output).toEqual([{ channel: 'stdout', text: '234' }])
        } finally {
            emulator.dispose()
        }
    })
})

describe('provideInput', () => {
    it('resumes only a read that waits, and otherwise queues the input for the next read', async () => {
        const emulator = await build(['sys 0, 0, buf, 64', 'save', 'saveq buf', 'finish'])
        try {
            // between the build and the start: the run's
            emulator.provideInput('a')
            expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
            emulator.provideInput(new TextEncoder().encode('b\n'))
            const run = await drive(emulator)
            expect(run.results).toEqual([3n, le('ab\n')])
            expect(run.requests).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it('refuses anything but bytes, a string or END_OF_INPUT', async () => {
        const emulator = await build(['finish'])
        try {
            expect(() => emulator.provideInput([1, 2] as unknown as Uint8Array)).toThrow(TypeError)
        } finally {
            emulator.dispose()
        }
    })
})
