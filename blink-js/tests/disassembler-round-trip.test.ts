/**
 * Every instruction the decoder prints must assemble back to itself. Its text is what a Listing,
 * the History and the Call stack show, and a person may retype a Listing line while debugging,
 * when the editor assembles it with `assembleInstruction` and pokes the bytes where the
 * instruction was (padding a shorter encoding with nops, refusing a longer one).
 *
 * For every instruction of the executable sections of a few fixtures, of samples of the bundled
 * libc and libstdc++, and of a sweep of opcode forms, the text is assembled at its address through
 * `assembleInstructions`, which is `assembleInstruction`'s own code path for many lines at once,
 * and the bytes are decoded again at that address: the text must be the same, the encoding no
 * longer than the original, and NASM must accept it. A shorter encoding (NASM's choice of a
 * shorter displacement, or a prefix the instruction ignores left out) is not a difference.
 *
 * Instructions whose text and length do not depend on their address are assembled once:
 * everything but direct branches and RIP-relative operands, which are assembled at each address.
 *
 * The few differences allowed are listed in ALLOWED, each with why, and the counts are printed
 * (run with --disable-console-intercept to see them); ROUND_TRIP_REPORT=<path prefix> also writes
 * every allowed difference and failure to <prefix>.<corpus>.json, and ROUND_TRIP_ALL=1 assembles
 * all of libc and libstdc++ instead of a sample (about 30 seconds more).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { loadDisassembler, type DecodedInstruction } from '../src/disassembler'
import { readElfSymbolTable } from '../src/elf-symbols'
import { assembleInstructions, type AssembledInstruction } from '../src/wasm-assembler'

const { disassemble } = await loadDisassembler()

/** `key` is the text, and the address too when the encoding depends on where it is. */
type Case = { key: string; text: string; address: bigint; length: number; bytes: Uint8Array }

/** What came back: NASM's error, or the text the encoding decodes to and its length. */
type Outcome = { error?: string; got?: string; length?: number }

/** Each 64-bit general-purpose register's 32-bit name. */
const DWORD_OF: Record<string, string> = Object.fromEntries([
    ...['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp'].map((r) => [`r${r}`, `e${r}`]),
    ...[8, 9, 10, 11, 12, 13, 14, 15].map((n) => [`r${n}`, `r${n}d`])
])

/** The same text with its first operand, a 64-bit register, written as the 32-bit one. */
function withDwordDestination(text: string): string | undefined {
    const match = /^(\w+) (r\w+)(,.*)?$/.exec(text)
    const dword = match && DWORD_OF[match[2]!]
    return dword ? `${match[1]} ${dword}${match[3] ?? ''}` : undefined
}

/** The same text with every 64-bit register written as the 32-bit one. */
const withDwordRegisters = (text: string) =>
    text.replace(/\br(?:[abcd]x|[sd]i|[sb]p|\d+)\b/g, (register) => DWORD_OF[register] ?? register)

const mnemonic = (text: string) =>
    /^(?:(?:lock|bnd|notrack|rep|repne|\{vex\}) )*(\S+)/.exec(text)![1]!

/** The differences allowed, each with why; anything else fails the round trip. */
const ALLOWED: {
    name: string
    why: string
    allows(c: Case, outcome: Outcome): boolean
}[] = [
    {
        name: 'rex.w left out',
        why:
            "NASM's -Ox leaves out a REX.W that does not change the result: `mov rax, 0x4018bf` " +
            'becomes `mov eax, 0x4018bf` (an immediate below 2^31, which writing eax zero-extends to ' +
            'the same value), and likewise mov from a segment register, crc32 with a byte source, ' +
            'lar, lsl, sldt, str and smsw, whose 32-bit forms zero-extend into the same register.',
        allows: (c, { got }) =>
            /^(?:mov|crc32|lar|lsl|sldt|str|smsw)$/.test(mnemonic(c.text)) &&
            (got === withDwordDestination(c.text) ||
                (/^l(?:ar|sl) /.test(c.text) && got === withDwordRegisters(c.text))) &&
            (!/^mov r\w+, 0x/.test(c.text) || BigInt(c.text.split(', ')[1]!) < 2n ** 31n)
    },
    {
        name: 'xchg operands swapped',
        why:
            'NASM puts the first register of `xchg a, b` in ModRM.rm where a compiler often puts it in ' +
            'ModRM.reg, so the encoding decodes as `xchg b, a`: an exchange is symmetric, the same ' +
            'instruction.',
        allows: (c, { got }) => {
            const match = /^xchg (\w+), (\w+)$/.exec(c.text)
            return !!match && got === `xchg ${match[2]}, ${match[1]}`
        }
    },
    {
        name: 'vex register move one byte longer',
        why:
            'A register-to-register vector move encoded with the store opcode fits a 2-byte VEX ' +
            'prefix when only its source is xmm8-15/ymm8-15; NASM always encodes the load opcode, ' +
            'which then needs the 3-byte VEX, and has no way to ask for the other. The same ' +
            'instruction, one byte longer.',
        allows: (c, { got, length }) =>
            got === c.text &&
            length === c.length + 1 &&
            /^v?mov\w* [xy]mm\d+, [xy]mm\d+$/.test(c.text)
    },
    {
        name: 'no vex form in nasm',
        why:
            'NASM 3.00 encodes AVX-VNNI (vpdpbusd, vpdpbusds, vpdpwssd, vpdpwssds) only as EVEX, ' +
            'one byte longer than the VEX original: the same instruction, and an EVEX form the ' +
            'decoder prints the same way.',
        allows: (c, { got, length }) =>
            got === c.text &&
            length === c.length + 1 &&
            /^vpdp(?:busds?|wssds?)$/.test(mnemonic(c.text))
    },
    {
        name: 'rel16 branch',
        why: 'A 66-prefixed xbegin (rel16): NASM encodes only rel32, one byte longer, same target.',
        allows: (c, { got, length }) =>
            got === c.text && length === c.length + 1 && mnemonic(c.text) === 'xbegin'
    },
    {
        name: 'nasm cannot encode',
        why:
            'Forms NASM 3.00 has no encoding for, refused with an error rather than assembled as ' +
            'something else: movsxd and bswap with a 16-bit register; far call/jmp through ' +
            'm16:16; lgdt/lidt/sgdt/sidt in 64-bit mode; AMD XOP vpermil2ps/vpermil2pd; Knights ' +
            'Corner jkzd/jknzd/kconcath/kconcatl; AVX512-4FMAPS/4VNNIW; SM3; vgetmantsh; the ' +
            'undocumented fstpnce; pcommit, which NASM refuses as never implemented; senduipi, ' +
            'which Zydis prints with a 32-bit register; vdpbf16ps with a 512-bit broadcast; ' +
            'AVX-VNNI-INT16, which has no VEX form in NASM; and the forms assembleInstruction ' +
            'refuses because NASM 3.00 encodes them wrongly (kunpckbw, kunpckwd, bswap and smsw ' +
            'with a 16-bit register).',
        allows: (c, { error }) =>
            error !== undefined &&
            (/^(?:movsxd|bswap|smsw) (?:[abcd]x|[sd]i|[sb]p|r\d+w)\b/.test(c.text) ||
                /^(?:call|jmp) far word /.test(c.text) ||
                /^(?:lgdt|lidt|sgdt|sidt|vpermil2p[sd]|jkn?zd|kconcat[hl]|v4fn?madd[sp]s|vp4dpwssds?|vsm3\w+|vgetmantsh|fstpnce|pcommit|senduipi|kunpck(?:bw|wd))$/.test(
                    mnemonic(c.text)
                ) ||
                (/^vdpbf16ps zmm/.test(c.text) && c.text.endsWith('{1to16}')) ||
                /^\{vex\} vpdpw(?:su|us|uu)ds?\b/.test(c.text))
    }
]

type Report = {
    name: string
    decoded: number
    instructions: number
    unique: number
    failures: number
    allowed: Record<string, number>
    milliseconds: number
}

async function roundTrip(name: string, cases: Case[], decoded: number, instructions: number) {
    const started = performance.now()
    const unique = new Map<string, Case>()
    for (const c of cases) {
        const known = unique.get(c.key)
        if (!known || c.length < known.length) unique.set(c.key, c)
    }
    const distinct = [...unique.values()]
    const results = await assembleInstructions(distinct)
    const failures: (Case & Outcome)[] = []
    const allowed: Record<string, (Case & Outcome)[]> = {}
    distinct.forEach((c, i) => {
        const result: AssembledInstruction = results[i]!
        let outcome: Outcome
        if ('error' in result) outcome = { error: result.error }
        else {
            const again: DecodedInstruction[] = disassemble(result.bytes, c.address)
            outcome = { got: again.map((d) => d.text).join(' ; '), length: result.bytes.length }
            if (again.length === 1 && outcome.got === c.text && result.bytes.length <= c.length)
                return
        }
        const allowance = ALLOWED.find((a) => a.allows(c, outcome))
        if (allowance) (allowed[allowance.name] ??= []).push({ ...c, ...outcome })
        else failures.push({ ...c, ...outcome })
    })
    const report: Report = {
        name,
        decoded,
        instructions,
        unique: distinct.length,
        failures: failures.length,
        allowed: Object.fromEntries(Object.entries(allowed).map(([k, v]) => [k, v.length])),
        milliseconds: Math.round(performance.now() - started)
    }
    console.log(JSON.stringify(report))
    if (process.env.ROUND_TRIP_REPORT) {
        const show = (c: Case & Outcome) => ({
            text: c.text,
            address: `0x${c.address.toString(16)}`,
            bytes: [...c.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '),
            error: c.error,
            got: c.got,
            length: c.length
        })
        writeFileSync(
            `${process.env.ROUND_TRIP_REPORT}.${name}.json`,
            JSON.stringify(
                {
                    ...report,
                    failures: failures.map(show),
                    allowed: Object.fromEntries(
                        Object.entries(allowed).map(([k, v]) => [k, v.map(show)])
                    )
                },
                null,
                1
            )
        )
    }
    return failures
}

/** A case keyed by its text, and by its address too when its encoding depends on where it is. */
function keyed(instruction: DecodedInstruction, bytes: Uint8Array): Case {
    const addressed = instruction.operands.some(
        (o) => o.branchTarget !== undefined || o.memoryTarget !== undefined
    )
    return {
        key: addressed ? `${instruction.text}@${instruction.address}` : instruction.text,
        text: instruction.text,
        address: instruction.address,
        length: instruction.length,
        bytes
    }
}

function executableInstructions(file: Uint8Array) {
    const { sections } = readElfSymbolTable(file)
    return sections
        .filter((s) => s.flags & 0x4n && s.type !== 8 && s.size)
        .flatMap((s) => {
            const bytes = file.subarray(s.offset, s.offset + s.size)
            return disassemble(bytes, s.address).map((instruction) => {
                const at = Number(instruction.address - s.address)
                return { instruction, bytes: bytes.subarray(at, at + instruction.length) }
            })
        })
}

/** `count` of `items` chosen by a seeded generator (mulberry32), in their original order. */
function sample<T>(items: readonly T[], count: number, seed: number): T[] {
    if (count >= items.length) return [...items]
    const order = items.map((_, i) => i)
    let state = seed >>> 0
    const random = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let i = 0; i < count; ++i) {
        const j = i + Math.floor(random() * (order.length - i))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    return order
        .slice(0, count)
        .sort((a, b) => a - b)
        .map((i) => items[i]!)
}

const read = (path: string) => new Uint8Array(readFileSync(new URL(path, import.meta.url)))

for (const [name, path, limit] of [
    ['crackme', './fixtures/elf/crackme'],
    ['cpp', './fixtures/elf/cpp'],
    ['hello-atexit-static', './fixtures/elf/hello-atexit-static'],
    ['libc', '../src/assets/linux/libc.so.6', 20_000],
    ['libstdc++', '../src/assets/linux/libstdc++.so.6', 10_000]
] as const) {
    it(`assembles every instruction of ${name} back to itself`, { timeout: 120_000 }, async () => {
        const all = executableInstructions(read(path))
        const chosen =
            limit === undefined || process.env.ROUND_TRIP_ALL ? all : sample(all, limit, 0x5eed)
        const failures = await roundTrip(
            name,
            chosen.map(({ instruction, bytes }) => keyed(instruction, bytes)),
            all.length,
            chosen.length
        )
        expect(failures).toEqual([])
    })
}

it('assembles a sweep of opcode forms back to themselves', { timeout: 120_000 }, async () => {
    const address = 0x401000n
    // Displacement, SIB and immediate bytes for whatever the opcode takes.
    const tail = [0x24, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x08, 0x09, 0x0a, 0x0b, 0x0c]
    const sequences: number[][] = []
    const modrms = [0x00, 0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38, 0x44, 0x05]
    const registers = [0xc1, 0xca, 0xd3, 0xdc, 0xe5, 0xee, 0xf7, 0xf8]
    const prefixes = [
        [],
        [0x66],
        [0xf2],
        [0xf3],
        [0x48],
        [0x41],
        [0x44],
        [0x66, 0x48],
        [0xf0],
        [0xf3, 0x48],
        [0xf2, 0x48],
        [0x66, 0x41]
    ]
    for (const prefix of prefixes)
        for (const map of [[], [0x0f], [0x0f, 0x38], [0x0f, 0x3a]])
            for (let opcode = 0; opcode < 256; ++opcode)
                for (const modrm of [...modrms, ...registers])
                    sequences.push([...prefix, ...map, opcode, modrm, ...tail])
    // VEX: maps 0F, 0F38, 0F3A, W0/W1, L0/L1, every pp, vvvv = xmm1/ymm1.
    for (const map of [1, 2, 3])
        for (const w of [0, 1])
            for (const l of [0, 1])
                for (const pp of [0, 1, 2, 3])
                    for (let opcode = 0; opcode < 256; ++opcode)
                        for (const modrm of [0x00, 0x10, 0xc1, 0xd3])
                            sequences.push([
                                0xc4,
                                0xe0 | map,
                                (w << 7) | (0xe << 3) | (l << 2) | pp,
                                opcode,
                                modrm,
                                ...tail.slice(1)
                            ])
    // EVEX: the same maps, 128 and 512 bits, with and without EVEX.b, masked by k1.
    for (const map of [1, 2, 3])
        for (const w of [0, 1])
            for (const ll of [0, 2])
                for (const pp of [0, 1, 2, 3])
                    for (const b of [0, 1])
                        for (let opcode = 0; opcode < 256; ++opcode)
                            for (const modrm of [0x00, 0xc1])
                                sequences.push([
                                    0x62,
                                    0xf0 | map,
                                    (w << 7) | (0xe << 3) | 0x4 | pp,
                                    (ll << 5) | (b << 4) | 0x08 | 1,
                                    opcode,
                                    modrm,
                                    ...tail.slice(1)
                                ])
    const cases: Case[] = []
    for (const sequence of sequences) {
        const [first] = disassemble(Uint8Array.from(sequence), address)
        if (first && !first.isInvalid)
            cases.push(keyed(first, Uint8Array.from(sequence.slice(0, first.length))))
    }
    const failures = await roundTrip('sweep', cases, sequences.length, cases.length)
    expect(failures).toEqual([])
})
