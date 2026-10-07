// x87 register forms, checked against the Intel SDM.
//
// FADD, FSUB, FSUBR, FMUL, FDIV and FDIVR each have three register forms
// (Intel SDM Vol. 2A, the opcode column of each instruction):
//
//   D8 /r  OP  ST(0), ST(i)   ST(0) <- ST(0) op ST(i)         NASM `fsub st1`
//   DC /r  OP  ST(i), ST(0)   ST(i) <- ST(i) op ST(0)         NASM `fsub to st1`
//   DE /r  OPP ST(i), ST(0)   ST(i) <- ST(i) op ST(0), pop    NASM `fsubp st1`
//
// where op is DEST + SRC, DEST - SRC, DEST * SRC and DEST / SRC for FADD, FSUB,
// FMUL and FDIV, and SRC - DEST and SRC / DEST for FSUBR and FDIVR. The AT&T
// mnemonics (GNU as in AT&T syntax, and the names of Blink's handlers) swap
// FSUB with FSUBR and FDIV with FDIVR in the forms whose destination is ST(i);
// Intel's table, GNU as in Intel syntax and NASM do not. Blink ran DC F0+i and
// DC F8+i (FDIVR and FDIV ST(i), ST(0)) as each other, and DE E8+i (FSUBP
// ST(i), ST(0)) wrote its result to ST(1) whatever i was.
//
// Every form runs from the same stack, chosen so that each result is exact in
// binary, is not a value already on the stack, and differs from the result of
// the other operand order: a swapped order, a wrong destination and a missing
// or extra pop each leave a stack that cannot match.
//
// One NASM program holds every form, each starting from FNINIT and a freshly
// loaded stack and followed by a `nop` the run stops on to read the x87 state,
// because assembling is what costs time here and running is nearly free.
import { readdirSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { readLogicalStBits, readLogicalStTags } from '../src/fpu-state'
import type { StopReason } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

/** ST(0) through ST(3) before every instruction under test. */
const STACK = [48, 3, 6, 12]

const EMPTY_TAG = 3
/** IE, DE, ZE, OE, UE, PE and SF: none may be raised by a form with valid operands. */
const EXCEPTION_FLAGS = 0x7f
/** IE and SF: the stack underflow reading an empty register raises. */
const STACK_UNDERFLOW = 0x41
/** The QNaN floating-point indefinite, as the 64-bit double Blink keeps. */
const INDEFINITE = 0xfff8000000000000n

type Operation = {
    mnemonic: string
    /** DEST <- DEST op SRC, as the operation section of the SDM states it. */
    apply: (destination: number, source: number) => number
    commutative: boolean
    /** The ModR/M byte of the D8 form for i = 0. */
    d8: number
    /** The ModR/M byte of the DC and DE forms for i = 0. */
    dcde: number
}

// The ModR/M bytes are the SDM's opcode column. FSUB is D8 E0+i but DC and DE
// E8+i, FSUBR the other way round, and the same holds for FDIV and FDIVR.
const OPERATIONS: Operation[] = [
    { mnemonic: 'fadd', d8: 0xc0, dcde: 0xc0, commutative: true, apply: (destination, source) => destination + source },
    { mnemonic: 'fsub', d8: 0xe0, dcde: 0xe8, commutative: false, apply: (destination, source) => destination - source },
    { mnemonic: 'fsubr', d8: 0xe8, dcde: 0xe0, commutative: false, apply: (destination, source) => source - destination },
    { mnemonic: 'fmul', d8: 0xc8, dcde: 0xc8, commutative: true, apply: (destination, source) => destination * source },
    { mnemonic: 'fdiv', d8: 0xf0, dcde: 0xf8, commutative: false, apply: (destination, source) => destination / source },
    { mnemonic: 'fdivr', d8: 0xf8, dcde: 0xf0, commutative: false, apply: (destination, source) => source / destination },
]

type Case = {
    /** Intel's spelling of the instruction under test. */
    intel: string
    /** NASM lines run after the stack is loaded; the instruction under test is the last. */
    nasm: string[]
    /** The encoding the SDM gives the instruction under test. */
    bytes: number[]
    /** The stack afterwards from ST(0), `null` for an empty register; missing registers are empty. */
    stack: (number | null)[]
    /** Values pushed minus values popped, counting the four the stack starts with. */
    depth: number
    /** C3, C2 and C0 afterwards, for a comparison. */
    conditionCodes?: { c3: number; c2: number; c0: number }
    /** The exception flags afterwards, when the form raises any. */
    exceptions?: number
    /** The RFLAGS word afterwards, as PUSHFQ would push it. */
    flags?: number
    /** The registers, from ST(0), that must hold the QNaN floating-point indefinite. */
    indefinite?: number[]
}

type Observation = {
    bytes: number[]
    /** ST(0) through ST(7), `null` where the tag says empty. */
    slots: (number | null)[]
    top: number
    statusWord: number
    flags: bigint
    bits: bigint[]
}

type Run = { observations: Map<Case, Observation>; stop: StopReason | null }

function arithmeticCases(): Case[] {
    const cases: Case[] = []
    for (const operation of OPERATIONS) {
        const name = operation.mnemonic.toUpperCase()
        for (const i of [1, 2, 3]) {
            const top = STACK[0]!
            const other = STACK[i]!
            cases.push(
                {
                    intel: `${name} ST(0), ST(${i})`,
                    nasm: [`${operation.mnemonic} st${i}`],
                    bytes: [0xd8, operation.d8 + i],
                    stack: replaced(STACK, 0, operation.apply(top, other)),
                    depth: 4,
                },
                {
                    intel: `${name} ST(${i}), ST(0)`,
                    nasm: [`${operation.mnemonic} to st${i}`],
                    bytes: [0xdc, operation.dcde + i],
                    stack: replaced(STACK, i, operation.apply(other, top)),
                    depth: 4,
                },
                {
                    intel: `${name}P ST(${i}), ST(0)`,
                    nasm: [`${operation.mnemonic}p st${i}`],
                    bytes: [0xde, operation.dcde + i],
                    stack: replaced(STACK, i, operation.apply(other, top)).slice(1),
                    depth: 3,
                },
            )
        }
    }
    return cases
}

const GREATER = { c3: 0, c2: 0, c0: 0 }
const LESS = { c3: 0, c2: 0, c0: 1 }
const EQUAL = { c3: 1, c2: 0, c0: 0 }

// Register forms beside the arithmetic that Blink also got wrong: FST and FSTP
// left an empty destination tagged empty, and FUCOMPP (DA E9) was not decoded
// at all. The first two store into registers that already hold values, which
// was right before and must stay right. The FUCOMPP cases come last, because
// on a Blink without it the program ends there.
const OTHER_CASES: Case[] = [
    { intel: 'FST ST(2)', nasm: ['fst st2'], bytes: [0xdd, 0xd2], stack: [48, 3, 48, 12], depth: 4 },
    { intel: 'FSTP ST(1)', nasm: ['fstp st1'], bytes: [0xdd, 0xd9], stack: [48, 6, 12], depth: 3 },
    {
        intel: 'FST ST(5), an empty register',
        nasm: ['fst st5'],
        bytes: [0xdd, 0xd5],
        stack: [48, 3, 6, 12, null, 48],
        depth: 4,
    },
    {
        intel: 'FSTP ST(5), an empty register',
        nasm: ['fstp st5'],
        bytes: [0xdd, 0xdd],
        stack: [3, 6, 12, null, 48],
        depth: 3,
    },
    {
        intel: 'FUCOMPP, ST(0) > ST(1)',
        nasm: ['fucompp'],
        bytes: [0xda, 0xe9],
        stack: [6, 12],
        depth: 2,
        conditionCodes: GREATER,
    },
    {
        intel: 'FUCOMPP, ST(0) < ST(1)',
        nasm: ['fxch st1', 'fucompp'],
        bytes: [0xda, 0xe9],
        stack: [6, 12],
        depth: 2,
        conditionCodes: LESS,
    },
    {
        intel: 'FUCOMPP, ST(0) = ST(1)',
        nasm: ['fld st0', 'fucompp'],
        bytes: [0xda, 0xe9],
        stack: [3, 6, 12],
        depth: 3,
        conditionCodes: EQUAL,
    },
]

const UNORDERED = { c3: 1, c2: 1, c0: 1 }

// FCOMI, FCOMIP, FUCOMI and FUCOMIP set ZF, PF and CF and clear OF, SF and AF
// (SDM, "FCOMI/FCOMIP/FUCOMI/FUCOMIP"), so each runs with every arithmetic
// flag set first; the words are the ones PUSHFQ shows natively: 0x202 plus
// ZF (0x40), PF (0x4) and CF (0x1) as the comparison sets them.
//
// Reading an empty register is a stack underflow: IE and SF are set, and the
// masked response puts the QNaN floating-point indefinite in place of the
// operand, so a load or exchange yields it and a comparison is unordered
// (SDM 8.5.1.1). Each such case first stores ST(0) into ST(5) and frees it,
// so the empty register still holds a number the old reads returned.
const FCOMI_AND_EMPTY_REGISTER_CASES: Case[] = [
    {
        intel: 'FCOMI ST(0), ST(1), ST(0) > ST(1)',
        nasm: ['push 0x8d7', 'popfq', 'fcomi st1'],
        bytes: [0xdb, 0xf1],
        stack: [48, 3, 6, 12],
        depth: 4,
        flags: 0x202,
    },
    {
        intel: 'FCOMIP ST(0), ST(1), ST(0) > ST(1)',
        nasm: ['push 0x8d7', 'popfq', 'fcomip st1'],
        bytes: [0xdf, 0xf1],
        stack: [3, 6, 12],
        depth: 3,
        flags: 0x202,
    },
    {
        intel: 'FUCOMI ST(0), ST(1), ST(0) < ST(1)',
        nasm: ['fxch st1', 'push 0x8d7', 'popfq', 'fucomi st1'],
        bytes: [0xdb, 0xe9],
        stack: [3, 48, 6, 12],
        depth: 4,
        flags: 0x203,
    },
    {
        intel: 'FUCOMIP ST(0), ST(0)',
        nasm: ['push 0x8d7', 'popfq', 'fucomip st0'],
        bytes: [0xdf, 0xe8],
        stack: [3, 6, 12],
        depth: 3,
        flags: 0x242,
    },
    {
        intel: 'FLD ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'fld st5'],
        bytes: [0xd9, 0xc5],
        stack: [NaN, 48, 3, 6, 12],
        depth: 5,
        exceptions: STACK_UNDERFLOW,
        indefinite: [0],
    },
    {
        intel: 'FXCH ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'fxch st5'],
        bytes: [0xd9, 0xcd],
        stack: [NaN, 3, 6, 12, null, 48],
        depth: 4,
        exceptions: STACK_UNDERFLOW,
        indefinite: [0],
    },
    {
        // a NaN, though not the indefinite itself: Blink's arithmetic returns a
        // positive QNaN for any NaN operand, where hardware passes the operand on
        intel: 'FADD ST(0), ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'fadd st5'],
        bytes: [0xd8, 0xc5],
        stack: [NaN, 3, 6, 12],
        depth: 4,
        exceptions: STACK_UNDERFLOW,
    },
    {
        intel: 'FCOM ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'fcom st5'],
        bytes: [0xd8, 0xd5],
        stack: [48, 3, 6, 12],
        depth: 4,
        exceptions: STACK_UNDERFLOW,
        conditionCodes: UNORDERED,
    },
    {
        intel: 'FUCOMP ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'fucomp st5'],
        bytes: [0xdd, 0xed],
        stack: [3, 6, 12],
        depth: 3,
        exceptions: STACK_UNDERFLOW,
        conditionCodes: UNORDERED,
    },
    {
        intel: 'FCOMI ST(0), ST(5), an empty register',
        nasm: ['fst st5', 'ffree st5', 'push 0x8d7', 'popfq', 'fcomi st5'],
        bytes: [0xdb, 0xf5],
        stack: [48, 3, 6, 12],
        depth: 4,
        exceptions: STACK_UNDERFLOW,
        flags: 0x247,
    },
]

function replaced(stack: number[], slot: number, value: number): number[] {
    return stack.map((current, index) => (index === slot ? value : current))
}

function padded(stack: (number | null)[]): (number | null)[] {
    return Array.from({ length: 8 }, (_, slot) => stack[slot] ?? null)
}

function hex(bytes: number[]): string {
    return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function describeCase(entry: Case): string {
    return `${entry.intel} (${hex(entry.bytes)}, NASM \`${entry.nasm.join('; ')}\`)`
}

function observe(emulator: X86Emulator, bytes: number[]): Observation {
    const state = emulator.getFpuState()
    const tags = readLogicalStTags(emulator.runtime.getFpuStateRaw())
    return {
        bytes,
        slots: state.st.map((value, slot) => (tags[slot] === EMPTY_TAG ? null : value)),
        top: (state.fstat >> 11) & 7,
        statusWord: state.fstat,
        flags: emulator.runtime.getFlags(),
        bits: readLogicalStBits(emulator.runtime.getFpuStateRaw()),
    }
}

/**
 * Assembles one program that runs every case from a fresh stack and reads the
 * machine at the `nop` after each, through a breakpoint on that line.
 */
async function runCases(cases: Case[]): Promise<Run> {
    const lines = [
        'bits 64',
        'global _start',
        'section .data',
        ...STACK.map((value, index) => `value${index}: dq ${value.toFixed(1)}`),
        'section .text',
        '_start:',
    ]
    const instructionLines = new Map<Case, number>()
    const probes = new Map<number, Case>()
    for (const entry of cases) {
        lines.push('  fninit', ...[3, 2, 1, 0].map((index) => `  fld qword [rel value${index}]`))
        lines.push(...entry.nasm.map((line) => `  ${line}`))
        instructionLines.set(entry, lines.length - 1)
        probes.set(lines.length, entry)
        lines.push('  nop')
    }
    lines.push('  mov eax, 60', '  xor edi, edi', '  syscall')

    const emulator = await createX86Emulator()
    try {
        const result = await emulator.compile(lines.join('\n'))
        if (!result.ok) throw new Error(`the program did not assemble:\n${result.report}`)
        const bytesAt = new Map(
            emulator.getCompiledInstructions().map((instruction) => [instruction.lineNumber, [...(instruction.bytes ?? [])]]),
        )

        const observations = new Map<Case, Observation>()
        const breakpoints = [...probes.keys()]
        await emulator.run(undefined, breakpoints)
        while (emulator.stopReason?.kind === 'breakpoint') {
            const entry = probes.get(emulator.stopReason.lineNumber ?? -1)
            if (entry) observations.set(entry, observe(emulator, bytesAt.get(instructionLines.get(entry)!) ?? []))
            await emulator.run(undefined, breakpoints)
        }
        return { observations, stop: emulator.stopReason }
    } finally {
        emulator.dispose()
    }
}

function expectCase(run: Run, entry: Case): void {
    const observation = run.observations.get(entry)
    expect(observation, `the run stopped before reaching this form: ${run.stop?.details}`).toBeDefined()
    expect(hex(observation!.bytes), 'NASM encoded the instruction the SDM gives').toBe(hex(entry.bytes))
    expect(observation!.slots, 'the stack afterwards, ST(0) first').toEqual(padded(entry.stack))
    expect(observation!.top, 'TOP, which counts the pushes and pops').toBe((8 - entry.depth) & 7)
    expect(observation!.statusWord & EXCEPTION_FLAGS, 'the exception flags').toBe(entry.exceptions ?? 0)
    for (const slot of entry.indefinite ?? []) {
        expect(observation!.bits[slot], `ST(${slot}) holds the QNaN indefinite`).toBe(INDEFINITE)
    }
    if (entry.flags !== undefined) {
        expect(`0x${observation!.flags.toString(16)}`, 'RFLAGS').toBe(`0x${entry.flags.toString(16)}`)
    }
    if (entry.conditionCodes) {
        const statusWord = observation!.statusWord
        expect({
            c3: (statusWord >> 14) & 1,
            c2: (statusWord >> 10) & 1,
            c1: (statusWord >> 9) & 1,
            c0: (statusWord >> 8) & 1,
        }).toEqual({ ...entry.conditionCodes, c1: 0 })
    }
}

describe('x87 register arithmetic, against the Intel SDM', () => {
    const cases = arithmeticCases()
    let run: Run
    beforeAll(async () => {
        run = await runCases(cases)
    })

    it('uses operands that tell every operand order and destination apart', () => {
        for (const operation of OPERATIONS) {
            for (const i of [1, 2, 3]) {
                const forward = operation.apply(STACK[0]!, STACK[i]!)
                const backward = operation.apply(STACK[i]!, STACK[0]!)
                expect(STACK).not.toContain(forward)
                expect(STACK).not.toContain(backward)
                if (!operation.commutative) expect(forward).not.toBe(backward)
            }
        }
    })

    it('covers the six operations in all three encodings for ST(1) to ST(3)', () => {
        expect(cases).toHaveLength(6 * 3 * 3)
        expect(new Set(cases.map((entry) => hex(entry.bytes))).size).toBe(cases.length)
    })

    it('runs every form through to the exit', () => {
        expect(run.stop?.kind, run.stop?.details).toBe('exit')
        expect(run.stop?.exitCode).toBe(0)
    })

    for (const entry of cases) {
        it(describeCase(entry), () => expectCase(run, entry))
    }
})

describe('x87 register stores and FUCOMPP, against the Intel SDM', () => {
    let run: Run
    beforeAll(async () => {
        run = await runCases(OTHER_CASES)
    })

    it('runs every form through to the exit', () => {
        expect(run.stop?.kind, run.stop?.details).toBe('exit')
        expect(run.stop?.exitCode).toBe(0)
    })

    for (const entry of OTHER_CASES) {
        it(describeCase(entry), () => expectCase(run, entry))
    }
})

describe('x87 FCOMI flags and reads of empty registers, against the Intel SDM', () => {
    let run: Run
    beforeAll(async () => {
        run = await runCases(FCOMI_AND_EMPTY_REGISTER_CASES)
    })

    it('runs every form through to the exit', () => {
        expect(run.stop?.kind, run.stop?.details).toBe('exit')
        expect(run.stop?.exitCode).toBe(0)
    })

    for (const entry of FCOMI_AND_EMPTY_REGISTER_CASES) {
        it(describeCase(entry), () => expectCase(run, entry))
    }
})

/**
 * The register encodings of D8 to DF that raise #UD, by opcode and ModR/M
 * byte: the reserved entries of the SDM's x87 escape-opcode maps (Vol. 2,
 * appendix A.4), the same 92 a native run raises SIGILL for. FENI, FDISI and
 * FSETPM (DB E0, E1, E4) run as no-ops.
 */
const UNDEFINED_ENCODINGS: Record<number, [number, number][]> = {
    0xd9: [[0xd1, 0xd7], [0xe2, 0xe3], [0xe6, 0xe7], [0xef, 0xef]],
    0xda: [[0xe0, 0xe8], [0xea, 0xff]],
    0xdb: [[0xe5, 0xe7], [0xf8, 0xff]],
    0xdd: [[0xf0, 0xff]],
    0xde: [[0xd8, 0xd8], [0xda, 0xdf]],
    0xdf: [[0xe1, 0xe7], [0xf8, 0xff]],
}

function isUndefinedEncoding(opcode: number, modrm: number): boolean {
    return (UNDEFINED_ENCODINGS[opcode] ?? []).some(([first, last]) => first <= modrm && modrm <= last)
}

describe('x87 register encodings the processor leaves undefined', () => {
    it('raise #UD, and only they do', async () => {
        // One program runs all 512 register encodings, each from a fresh
        // four-deep stack, behind a SIGILL handler that marks the encoding
        // and steps over its two bytes; it writes the marks to stdout.
        const lines = [
            'bits 64',
            'global _start',
            'section .data',
            'act: dq handler, 0x04000004, restorer, 0', // SA_SIGINFO | SA_RESTORER
            'one: dq 1.0',
            'current: dq 0',
            'section .bss',
            'faulted: resb 512',
            'section .text',
            '_start:',
            '  mov eax, 13', // rt_sigaction(SIGILL, &act, 0, 8)
            '  mov edi, 4',
            '  lea rsi, [rel act]',
            '  xor edx, edx',
            '  mov r10d, 8',
            '  syscall',
        ]
        for (let index = 0; index < 512; index++) {
            lines.push(
                `  mov qword [rel current], ${index}`,
                '  fninit',
                ...Array.from({ length: 4 }, () => '  fld qword [rel one]'),
                `  db 0x${(0xd8 + (index >> 6)).toString(16)}, 0x${(0xc0 + (index & 63)).toString(16)}`,
            )
        }
        lines.push(
            '  mov eax, 1',
            '  mov edi, 1',
            '  lea rsi, [rel faulted]',
            '  mov edx, 512',
            '  syscall',
            '  mov eax, 60',
            '  xor edi, edi',
            '  syscall',
            'handler:',
            '  mov rcx, [rel current]',
            '  lea r8, [rel faulted]',
            '  mov byte [r8 + rcx], 1',
            '  add qword [rdx + 168], 2', // uc_mcontext.gregs[REG_RIP]
            '  ret',
            'restorer:',
            '  mov eax, 15',
            '  syscall',
        )
        const output: number[] = []
        const emulator = await createX86Emulator({ callbacks: { stdout: (chunk) => void output.push(...chunk) } })
        try {
            const result = await emulator.compile(lines.join('\n'))
            if (!result.ok) throw new Error(`the program did not assemble:\n${result.report}`)
            // each signal hands control back to JavaScript; run on to the exit
            for (let slice = 0; slice < 1000 && !emulator.hasTerminated(); slice++) await emulator.run()
            expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
            const marks = output.slice(-512)
            const differ: string[] = []
            for (let index = 0; index < 512; index++) {
                const opcode = 0xd8 + (index >> 6)
                const modrm = 0xc0 + (index & 63)
                if (Boolean(marks[index]) !== isUndefinedEncoding(opcode, modrm)) {
                    differ.push(`${hex([opcode, modrm])} ${marks[index] ? 'raised #UD' : 'ran'}`)
                }
            }
            expect(differ).toEqual([])
        } finally {
            emulator.dispose()
        }
    })
})

/**
 * One form captured through GNU as: the input program, the ELF GNU as and ld
 * built from it, and what that ELF returned when run natively. The program
 * exits with 64 plus four times the destination's value, rounded.
 */
type GnuReferenceFixture = {
    instruction: string
    stack: number[]
    destination: string
    pops: boolean
    intelOpcode: string
    result: number
    intended: number
    reference: { encoding: string; elf: string; native: { status: number } }
}

const FIXTURE_DIRECTORY = new URL('./fixtures/gcc-intel-v1/x87/', import.meta.url)

function readFixtures(): GnuReferenceFixture[] {
    return readdirSync(FIXTURE_DIRECTORY)
        .filter((file) => file.endsWith('.json.gz'))
        .sort()
        .map((file) => JSON.parse(gunzipSync(readFileSync(new URL(file, FIXTURE_DIRECTORY))).toString('utf8')))
}

/** What the SDM table above says the fixture's opcode does to the fixture's stack. */
function intelSemantics(fixture: GnuReferenceFixture): { destination: string; pops: boolean; result: number } {
    const [opcode, modrm] = fixture.intelOpcode.split(' ').map((byte) => Number.parseInt(byte, 16)) as [number, number]
    const i = modrm & 7
    const operation = OPERATIONS.find((candidate) => (opcode === 0xd8 ? candidate.d8 : candidate.dcde) === (modrm & 0xf8))
    if (!operation) throw new Error(`${fixture.intelOpcode} is not an arithmetic register form`)
    const [top, other] = [fixture.stack[0]!, fixture.stack[i]!]
    return opcode === 0xd8
        ? { destination: 'st(0)', pops: false, result: operation.apply(top, other) }
        : { destination: `st(${i})`, pops: opcode === 0xde, result: operation.apply(other, top) }
}

describe('the GNU-reference x87 fixtures', () => {
    const fixtures = readFixtures()

    it('are all here', () => {
        expect(fixtures).toHaveLength(36)
    })

    for (const fixture of fixtures) {
        it(`${fixture.instruction} (${fixture.intelOpcode}) exits with ${fixture.intended}`, async () => {
            // The capture's own evidence: GNU as emitted the Intel opcode, and
            // native hardware returned the intended value.
            expect(fixture.reference.encoding).toBe(fixture.intelOpcode)
            expect(fixture.reference.native.status).toBe(fixture.intended)
            // The table the NASM forms are checked against agrees with it.
            expect(intelSemantics(fixture)).toEqual({
                destination: fixture.destination,
                pops: fixture.pops,
                result: fixture.result,
            })

            const emulator = await createX86Emulator()
            try {
                emulator.loadElf(Buffer.from(fixture.reference.elf, 'base64'))
                await emulator.runUntilBlocked()
                expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
                expect(emulator.stopReason?.exitCode).toBe(fixture.intended)
            } finally {
                emulator.dispose()
            }
        })
    }
})
