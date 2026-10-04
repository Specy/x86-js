// Masked x87 operand rules within Blink's binary64 representation, checked with
// the same Core-linked ELF on a Linux x86-64 host. Intel SDM 093 Vol.1 Table 4-8
// and §8.3.13; Vol.2A FADD/FSUB/FMUL/FDIV, FUCOM*, FCOMI* and FXCH.
// Extended precision, extended denormals and general unmasked x87 arithmetic
// are outside this test's scope. NaN payloads here fit exactly in binary64.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { linkedProgram, NATIVE } from './compiler-output/helpers'
import { createX86Emulator } from '../src/x86-emulator'

const SIGN = 1n << 63n
const QUIET = 1n << 51n
const INDEFINITE = 0xfff8000000000000n
const VALUES: Record<string, bigint> = {
    one: 0x3ff0000000000000n,
    minusOne: 0xbff0000000000000n,
    zero: 0n,
    minusZero: SIGN,
    infinity: 0x7ff0000000000000n,
    minusInfinity: 0xfff0000000000000n,
    qSmall: 0x7ff8000000000001n,
    qSmallNegative: 0xfff8000000000001n,
    qLargeNegative: 0xfff8000000000003n,
    sSmall: 0x7ff0000000000001n,
    sLargeNegative: 0xfff0000000000003n,
    q32Positive: 0x7ff8000060000000n,
    q32Negative: 0xfff8000060000000n,
    s32Positive: 0x7ff0000060000000n,
    s32Negative: 0xfff0000060000000n,
}

type Case = {
    name: string
    x: string
    y?: string
    /** Real memory formats convert on FLD; tword loads retain signaling NaNs. */
    load?: 'dword' | 'qword'
    yMemory?: 'dword' | 'qword'
    setup?: string[]
    operation: string
    result?: bigint
    otherResult?: bigint
    status: number
    mask?: number
    pops?: number
    flags?: number
    swap?: boolean
    pointerProbe?: boolean
    /** Intel silicon may retain C1 here despite the SDM's explicit clearing rule. */
    nativeC1Difference?: boolean
}

function nan(bits: bigint): boolean {
    return (bits & ~SIGN) > VALUES.infinity!
}

function signaling(bits: bigint): boolean {
    return nan(bits) && !(bits & QUIET)
}

function number(bits: bigint): number {
    const bytes = new ArrayBuffer(8)
    new DataView(bytes).setBigUint64(0, bits, true)
    return new DataView(bytes).getFloat64(0, true)
}

function bits(value: number): bigint {
    const bytes = new ArrayBuffer(8)
    new DataView(bytes).setFloat64(0, value, true)
    return new DataView(bytes).getBigUint64(0, true)
}

function tag(value: bigint): number {
    if (!(value & ~SIGN)) return 1
    return (value & ~SIGN) >= VALUES.infinity! ? 2 : 0
}

/** The exact extended encoding of the representable operands used here. */
function extended(value: bigint): [bigint, bigint] {
    const exponent = Number((value >> 52n) & 0x7ffn)
    const fraction = (value & 0x000fffffffffffffn) << 11n
    const significand = fraction | ((value & ~SIGN) ? SIGN : 0n)
    const adjusted = exponent === 0 ? 0 : exponent === 0x7ff ? 0x7fff : exponent - 0x3ff + 0x3fff
    return [significand, BigInt(adjusted) | ((value >> 63n) << 15n)]
}

// Expected results use the SDM's operand table and exact ordinary operations;
// the separate native test independently checks every expectation.
function arithmetic(op: string, x: bigint, y: bigint): { result: bigint; status: number } {
    const sx = signaling(x), sy = signaling(y)
    if (nan(x) || nan(y)) {
        let result: bigint
        if (!nan(x) || (sx && nan(y) && !sy)) result = y
        else if (!nan(y) || (sy && !sx)) result = x
        else result = (x & ~SIGN) > (y & ~SIGN) || ((x & ~SIGN) === (y & ~SIGN) && x < y) ? x : y
        return { result: result | QUIET, status: sx || sy ? 1 : 0 }
    }
    const a = number(x), b = number(y)
    const value = op === 'fadd' ? a + b : op === 'fsub' ? a - b : op === 'fmul' ? a * b : a / b
    if (Number.isNaN(value)) return { result: INDEFINITE, status: 1 }
    return { result: bits(value), status: op === 'fdiv' && b === 0 && Number.isFinite(a) ? 4 : 0 }
}

const ARITHMETIC: Case[] = []
const FINITE_AND_INFINITY = ['one', 'minusOne', 'zero', 'minusZero', 'infinity', 'minusInfinity']
const NAN_PAIRS = [
    ['qSmall', 'one'], ['one', 'qLargeNegative'], ['qSmall', 'qLargeNegative'],
    ['qSmall', 'qSmallNegative'], ['qSmallNegative', 'qSmall'],
    ['sSmall', 'one'], ['one', 'sLargeNegative'], ['sSmall', 'sLargeNegative'],
    ['sLargeNegative', 'qSmall'], ['qSmall', 'sLargeNegative'],
]
for (const op of ['fadd', 'fsub', 'fmul', 'fdiv']) {
    for (const [x, y] of [...FINITE_AND_INFINITY.flatMap((x) => FINITE_AND_INFINITY.map((y) => [x, y])), ...NAN_PAIRS]) {
        ARITHMETIC.push({ name: `${op}: ${x}, ${y}`, x: x!, y: y!, operation: `${op} st1`, ...arithmetic(op, VALUES[x!]!, VALUES[y!]!) })
    }
    ARITHMETIC.push({ name: `${op}: empty source`, x: 'one', operation: `${op} st1`, result: INDEFINITE, status: 0x41 })
}
// Reverse and ST(i)-destination forms exercise sign handling through both
// operand orders; finite form tests already cover their ordinary encodings.
for (const [operation, result, status] of [
    ['fsubr st1', VALUES.minusInfinity!, 0],
    ['fsub to st1', VALUES.minusInfinity!, 0],
    ['fsubp st1', VALUES.minusInfinity!, 0],
    ['fdivr st1', 0n, 0],
    ['fdiv to st1', 0n, 0],
    ['fdivp st1', 0n, 0],
] as const) {
    const destinationOther = operation.includes('to ') || operation.includes('p ')
    ARITHMETIC.push({ name: `${operation}: infinity, one`, x: 'infinity', y: 'one', operation,
        result: destinationOther && !operation.includes('p ') ? VALUES.infinity : result,
        otherResult: destinationOther && !operation.includes('p ') ? result : undefined,
        status, pops: operation.includes('p ') ? 1 : 0 })
}

const COMPARISONS: Case[] = []
for (const operation of ['fcom st1', 'fcomp st1', 'fcompp', 'fucom st1', 'fucomp st1', 'fucompp', 'fcomi st1', 'fcomip st1', 'fucomi st1', 'fucomip st1']) {
    for (const [x, y] of [['qSmall', 'one'], ['one', 'qLargeNegative'], ['sSmall', 'one'], ['one', 'sLargeNegative']]) {
        const quiet = operation.startsWith('fu')
        const eflags = operation.includes('i')
        const invalid = !quiet || signaling(VALUES[x!]!) || signaling(VALUES[y!]!)
        COMPARISONS.push({ name: `${operation}: ${x}, ${y}`, x: x!, y: y!, operation,
            status: (invalid ? 1 : 0) | (eflags ? 0 : 0x4500), mask: 0x4741,
            flags: eflags ? 0x45 : 0x8d5,
            pops: operation.endsWith('pp') ? 2 : operation.startsWith('fcomp') || operation.startsWith('fucomp') || operation.includes('ip') ? 1 : 0,
            setup: ['push 0x8d7', 'popfq'] })
    }
}
const C1_SETUP = ['fnstenv [rel env]', 'or word [rel env + 4], 0x200', 'fldenv [rel env]']
const OTHER: Case[] = [
    { name: 'FXCH clears C1', x: 'minusOne', y: 'one', setup: C1_SETUP, operation: 'fxch st1', result: VALUES.one, status: 0, swap: true },
    { name: 'FCOMI clears C1 per SDM', x: 'minusOne', y: 'one', setup: ['fxam'], operation: 'fcomi st1', status: 0x400, mask: 0x745, flags: 1, nativeC1Difference: true },
    { name: 'FUCOMI clears C1 per SDM', x: 'minusOne', y: 'one', setup: ['fxam'], operation: 'fucomi st1', status: 0x400, mask: 0x745, flags: 1, nativeC1Difference: true },
    ...[0xe0, 0xe1, 0xe4].map((opcode): Case => ({ name: `obsolete no-op DB ${opcode.toString(16)}`, x: 'one',
        operation: `db 0xdb, 0x${opcode.toString(16)}`, status: 0, pointerProbe: true })),
]
const MEMORY: Case[] = []
for (const width of ['dword', 'qword'] as const) {
    const names = width === 'dword' ? ['q32Positive', 'q32Negative', 's32Positive', 's32Negative'] : ['qSmall', 'qLargeNegative', 'sSmall', 'sLargeNegative']
    for (const name of names) {
        const value = VALUES[name]!
        MEMORY.push({ name: `FLD ${width} ${name}`, x: name, load: width, operation: 'fnop',
            result: value | QUIET, status: signaling(value) ? 1 : 0 })
        MEMORY.push({ name: `FLD ${width} ${name} quiets before FUCOMI`, x: name, load: width,
            setup: ['fnclex'], operation: 'fucomi st0', status: 0, flags: 0x45 })
        for (const op of ['fadd', 'fsub', 'fmul', 'fdiv']) {
            MEMORY.push({ name: `${op} ${width} ${name}`, x: 'one', y: name, yMemory: width,
                operation: `${op} ${width} [rel ${name}_${width}]`, ...arithmetic(op, VALUES.one!, value) })
        }
    }
    // Mixed QNaN/SNaN arbitration must happen after memory-format expansion.
    for (const op of ['fadd', 'fsub', 'fmul', 'fdiv']) {
        const y = width === 'dword' ? 's32Negative' : 'sLargeNegative'
        MEMORY.push({ name: `${op}: QNaN ST(0), SNaN ${width}`, x: 'qSmall', y, yMemory: width,
            operation: `${op} ${width} [rel ${y}_${width}]`, ...arithmetic(op, VALUES.qSmall!, VALUES[y]!) })
    }
}
const CASES = [...ARITHMETIC, ...COMPARISONS, ...OTHER, ...MEMORY]
const RECORD_SIZE = 40

function expected(entry: Case): bigint[] {
    if (entry.pointerProbe) return [0n, 0n, 0n, 0n, 0n]
    const x = entry.result ?? VALUES[entry.x]!
    const y = entry.y && !entry.yMemory ? VALUES[entry.y]! : undefined
    const pops = entry.pops ?? 0
    const originalTop = y === undefined ? 7 : 6
    // The probe observes ST(0); arithmetic to ST(1) leaves ST(0) alone.
    const resultWords = entry.result === undefined ? [0n, 0n] : extended(entry.result)
    let tags = 0xffff
    if (pops < 1) tags = (tags & ~(3 << (originalTop * 2))) | (tag(x) << (originalTop * 2))
    if (y !== undefined && pops < 2) {
        const other = entry.otherResult ?? (entry.swap ? VALUES[entry.x]! : entry.result !== undefined && pops === 1 ? entry.result : y)
        tags = (tags & ~(3 << 14)) | (tag(other) << 14)
    }
    return [...resultWords, BigInt(entry.status), BigInt(tags), BigInt(entry.flags ?? 0)]
}

function source(): string[] {
    const lines = ['bits 64', 'global _start', 'section .data']
    for (const [name, value] of Object.entries(VALUES)) {
        const [significand, exponent] = extended(value)
        lines.push(`${name}: dq 0x${significand.toString(16)}`, `dw 0x${exponent.toString(16)}`)
        lines.push(`${name}_qword: dq 0x${value.toString(16)}`)
        if (name.includes('32')) {
            const narrow = 0x7f800000n | ((value & 0x000fffffffffffffn) >> 29n) | ((value >> 63n) << 31n)
            lines.push(`${name}_dword: dd 0x${narrow.toString(16)}`)
        }
    }
    lines.push('section .bss', `results: resb ${CASES.length * RECORD_SIZE}`, 'env: resb 28',
        'align 16', 'before: resb 512', 'after: resb 512', 'section .text', '_start:', 'lea rbx, [rel results]')
    for (const entry of CASES) {
        lines.push('fninit')
        if (entry.y && !entry.yMemory) lines.push(`fld tword [rel ${entry.y}]`)
        lines.push(entry.load ? `fld ${entry.load} [rel ${entry.x}_${entry.load}]` : `fld tword [rel ${entry.x}]`, ...(entry.setup ?? []))
        if (entry.pointerProbe) {
            lines.push('fxsave [rel before]', entry.operation, 'fxsave [rel after]',
                'mov eax, [rel before + 8]', 'xor eax, [rel after + 8]', 'mov [rbx], rax',
                'movzx eax, word [rel before + 6]', 'xor ax, [rel after + 6]', 'mov [rbx + 8], rax')
        } else {
            lines.push(entry.operation, 'pushfq', 'pop rax', `and eax, ${entry.flags === undefined ? 0 : 0x8d5}`, 'mov [rbx + 32], rax',
                'fnstenv [rel env]', 'movzx eax, word [rel env + 4]', `and eax, ${entry.mask ?? 0x245}`, 'mov [rbx + 16], rax',
                'movzx eax, word [rel env + 8]', 'mov [rbx + 24], rax')
            if (entry.result !== undefined) lines.push('fstp tword [rbx]', 'movzx eax, word [rbx + 8]', 'mov [rbx + 8], rax')
        }
        lines.push(`add rbx, ${RECORD_SIZE}`)
    }
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${CASES.length * RECORD_SIZE}`, 'syscall',
        'mov eax, 60', 'xor edi, edi', 'syscall')
    return lines
}

function qwords(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: bytes.length / 8 }, (_, i) => view.getBigUint64(i * 8, true))
}

function nativeOutput(program: Uint8Array): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), 'x87-exceptions-'))
    const path = join(directory, 'probe.elf')
    try {
        writeFileSync(path, program)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
        if (run.error) throw run.error
        expect(run.signal, run.stderr.toString()).toBeNull()
        expect(run.status, run.stderr.toString()).toBe(0)
        return run.stdout
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

let program: Uint8Array
let observed: bigint[]
beforeAll(async () => {
    const bytes: number[] = []
    const emulator = await createX86Emulator({ callbacks: { stdout: (code) => { bytes.push(code) } } })
    try {
        const result = await emulator.compile(source().join('\n'))
        expect(result.ok, result.report).toBe(true)
        program = linkedProgram(emulator)
        emulator.getCompiledInstructions() // Load and pause at entry, before the output probe starts.
        bytes.length = 0
        await emulator.run(1_000_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        observed = qwords(Uint8Array.from(bytes))
        expect(observed.length).toBe(CASES.length * 5)
    } finally { emulator.dispose() }
})

describe('x87 exceptional operands', () => {
    it.each(CASES.map((entry, index) => [entry.name, entry, index] as const))('%s', (_, entry, index) => {
        expect(observed.slice(index * 5, index * 5 + 5)).toEqual(expected(entry))
    })

    it.skipIf(!NATIVE)('matches the same executable on native x86-64 for results, exception flags, tags, EFLAGS and obsolete no-op pointers', () => {
        const native = qwords(nativeOutput(program))
        expect(native.length).toBe(CASES.length * 5)
        CASES.forEach((entry, index) => {
            const words = native.slice(index * 5, index * 5 + 5)
            // SDM 093 Vol.2A p.3-328 requires C1=0. The Intel i7-10750H
            // preserves C1, also reproduced with FXAM (rather than FLDENV)
            // establishing it. Compare every other bit and retain a separate
            // emulator assertion of the documentation's C1 requirement.
            if (entry.nativeC1Difference) {
                expect([BigInt(entry.status), BigInt(entry.status) | 0x200n], `${entry.name}: native status differs only in C1`).toContain(words[2])
                words[2] = words[2]! & ~0x200n
            }
            expect(words, entry.name).toEqual(expected(entry))
        })
        CASES.forEach((entry, index) => {
            const words = native.slice(index * 5, index * 5 + 5)
            if (entry.nativeC1Difference) words[2] = words[2]! & ~0x200n
            expect(observed.slice(index * 5, index * 5 + 5), entry.name).toEqual(words)
        })
    })
})
