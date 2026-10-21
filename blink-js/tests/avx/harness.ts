// Differential testing of vector instructions: one program holds many cases, each loads random
// register and memory contents, runs a single instruction, and records the registers, the memory
// and the flags afterwards. The same executable runs in Blink and on the host, and the records
// must agree byte for byte.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createX86Emulator } from '../../src/x86-emulator'
import { linkedProgram } from '../compiler-output/helpers'

/**
 * What the random operands look like. `f32` and `f64` hold no NaNs: which NaN comes out of
 * arithmetic depends on how the host orders the operands, which no instruction set promises.
 * `f32n` and `f64n` add them for the instructions that treat them by rule.
 */
export type DataKind = 'bytes' | 'f32' | 'f64' | 'f32n' | 'f64n' | 'i32' | 'i64'

export type VectorCase = {
    /** The instruction, using ymm0-ymm3, `[rel mem]` (64 bytes) and rax, rcx, rdx. */
    asm: string
    kind?: DataKind
    /** Overrides a case's seed so that a retry sees the same inputs. */
    seed?: number
    /** The flags the instruction defines; the others are left out of the comparison. */
    flags?: number
}

/** Bytes of one case's inputs: four registers, 64 bytes of memory, three general registers. */
const INPUT_SIZE = 4 * 32 + 64 + 3 * 8
/** Bytes of one case's record: the inputs' shape again, then the flags. */
const RECORD_SIZE = 4 * 32 + 64 + 3 * 8 + 8

export const NATIVE_AVX = (() => {
    if (process.platform !== 'linux' || process.arch !== 'x64') return false
    try {
        const info = spawnSync('grep', ['-m1', '^flags', '/proc/cpuinfo']).stdout.toString()
        return /\bavx2\b/.test(info) && /\bfma\b/.test(info)
    } catch {
        return false
    }
})()

function generator(seed: number): () => number {
    let state = (seed ^ 0x9e3779b9) >>> 0 || 1
    return () => {
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        return state
    }
}

const F32 = [
    0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x40000000, 0x7f800000, 0xff800000, 0x7fc00000,
    0x7f800001, 0x00000001, 0x007fffff, 0x7f7fffff, 0x3f000000, 0x40490fdb, 0xc2c80000, 0x4b000000,
    0x3effffff, 0x3f000001, 0x41200000, 0xc1200000,
]
const F64 = [
    [0x00000000, 0x00000000], [0x80000000, 0x00000000], [0x3ff00000, 0x00000000], [0xbff00000, 0x00000000],
    [0x40000000, 0x00000000], [0x7ff00000, 0x00000000], [0xfff00000, 0x00000000], [0x7ff80000, 0x00000000],
    [0x7ff00000, 0x00000001], [0x00000000, 0x00000001], [0x000fffff, 0xffffffff], [0x7fefffff, 0xffffffff],
    [0x3fe00000, 0x00000000], [0x400921fb, 0x54442d18], [0xc0590000, 0x00000000], [0x43300000, 0x00000000],
]
const INTERESTING = [0, 1, 2, 0x7f, 0x80, 0x81, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff]

function fill(buffer: Uint8Array, kind: DataKind, next: () => number): void {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    switch (kind) {
        case 'f32':
        case 'f32n': {
            const nans = kind === 'f32n'
            for (let i = 0; i < buffer.length; i += 4) {
                let bits = next() % 4 === 0 ? next() : F32[next() % F32.length]!
                if (!nans && (bits & 0x7f800000) === 0x7f800000 && bits & 0x7fffff) bits ^= 0x40000000
                if (!nans && (bits & 0x7fffffff) === 0x7fc00000) bits = 0x3f800000
                view.setUint32(i, bits >>> 0, true)
            }
            break
        }
        case 'f64':
        case 'f64n': {
            const nans = kind === 'f64n'
            for (let i = 0; i < buffer.length; i += 8) {
                let high: number
                let low: number
                if (next() % 4 === 0) {
                    high = next()
                    low = next()
                } else {
                    ;[high, low] = F64[next() % F64.length]! as [number, number]
                }
                const isNan = (high & 0x7ff00000) === 0x7ff00000 && ((high & 0xfffff) !== 0 || low !== 0)
                if (!nans && isNan) high = 0x3ff00000
                view.setUint32(i, low >>> 0, true)
                view.setUint32(i + 4, high >>> 0, true)
            }
            break
        }
        case 'i32':
            for (let i = 0; i < buffer.length; i += 4)
                view.setUint32(i, next() % 3 === 0 ? INTERESTING[next() % INTERESTING.length]! : next(), true)
            break
        case 'i64':
            for (let i = 0; i < buffer.length; i += 8) {
                view.setUint32(i, next() % 3 === 0 ? INTERESTING[next() % INTERESTING.length]! : next(), true)
                view.setUint32(i + 4, next() % 3 === 0 ? INTERESTING[next() % INTERESTING.length]! : next(), true)
            }
            break
        default:
            for (let i = 0; i < buffer.length; i++) {
                const roll = next() % 8
                buffer[i] = roll === 0 ? 0 : roll === 1 ? 0xff : roll === 2 ? 0x80 : roll === 3 ? 0x7f : next() & 0xff
            }
    }
}

function inputs(cases: readonly VectorCase[], seed: number): Uint8Array {
    const table = new Uint8Array(cases.length * INPUT_SIZE)
    cases.forEach((entry, index) => {
        const next = generator(entry.seed ?? seed * 7919 + index * 104729 + 1)
        fill(table.subarray(index * INPUT_SIZE, index * INPUT_SIZE + 4 * 32 + 64), entry.kind ?? 'bytes', next)
        const general = new DataView(table.buffer, index * INPUT_SIZE + 4 * 32 + 64, 24)
        for (let r = 0; r < 3; r++) {
            general.setUint32(r * 8, next(), true)
            general.setUint32(r * 8 + 4, next(), true)
        }
    })
    return table
}

function dataLines(table: Uint8Array): string[] {
    const lines: string[] = []
    for (let offset = 0; offset < table.length; offset += 16) {
        lines.push(`db ${Array.from(table.subarray(offset, offset + 16), (b) => `0x${b.toString(16)}`).join(', ')}`)
    }
    return lines
}

function source(cases: readonly VectorCase[], table: Uint8Array): string {
    const lines = ['bits 64', 'global _start', 'section .data', 'align 32', 'table:', ...dataLines(table),
        'section .bss', 'align 32', 'mem: resb 96', `results: resb ${cases.length * RECORD_SIZE}`,
        'section .text', '_start:', 'lea rsi, [rel table]', 'lea rdi, [rel results]']
    cases.forEach((entry) => {
        lines.push(
            'vmovdqu ymm0, [rsi]', 'vmovdqu ymm1, [rsi + 32]', 'vmovdqu ymm2, [rsi + 64]', 'vmovdqu ymm3, [rsi + 96]',
            'vmovdqu ymm4, [rsi + 128]', 'vmovdqu [rel mem], ymm4',
            'vmovdqu ymm4, [rsi + 160]', 'vmovdqu [rel mem + 32], ymm4',
            'mov rax, [rsi + 192]', 'mov rcx, [rsi + 200]', 'mov rdx, [rsi + 208]',
            'push 0x202', 'popfq',
            entry.asm,
            'pushfq', 'pop r8', `and r8d, ${entry.flags ?? 0x8d5}`,
            'vmovdqu [rdi], ymm0', 'vmovdqu [rdi + 32], ymm1', 'vmovdqu [rdi + 64], ymm2', 'vmovdqu [rdi + 96], ymm3',
            'vmovdqu ymm4, [rel mem]', 'vmovdqu [rdi + 128], ymm4',
            'vmovdqu ymm4, [rel mem + 32]', 'vmovdqu [rdi + 160], ymm4',
            'mov [rdi + 192], rax', 'mov [rdi + 200], rcx', 'mov [rdi + 208], rdx', 'mov [rdi + 216], r8',
            `add rsi, ${INPUT_SIZE}`, `add rdi, ${RECORD_SIZE}`,
        )
    })
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${cases.length * RECORD_SIZE}`,
        'syscall', 'mov eax, 60', 'xor edi, edi', 'syscall')
    return lines.join('\n')
}

function nativeOutput(program: Uint8Array): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), 'avx-'))
    const path = join(directory, 'probe.elf')
    try {
        writeFileSync(path, program)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
        if (run.error) throw run.error
        expect(run.signal, run.stderr.toString()).toBeNull()
        expect(run.status, run.stderr.toString()).toBe(0)
        return new Uint8Array(run.stdout)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

async function blinkOutput(src: string, count: number): Promise<{ program: Uint8Array; output: Uint8Array }> {
    const bytes: number[] = []
    const emulator = await createX86Emulator({ callbacks: { stdout: (chunk) => void bytes.push(...chunk) } })
    try {
        const result = await emulator.compile(src)
        expect(result.ok, result.report).toBe(true)
        const program = linkedProgram(emulator)
        emulator.getCompiledInstructions()
        bytes.length = 0
        for (let i = 0; i < 1000 && emulator.stopReason?.kind !== 'exit'; i++) await emulator.run(50_000_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        expect(bytes.length).toBe(count * RECORD_SIZE)
        return { program, output: Uint8Array.from(bytes) }
    } finally {
        emulator.dispose()
    }
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function describe(record: Uint8Array): string {
    const parts = ['ymm0', 'ymm1', 'ymm2', 'ymm3', 'mem0', 'mem1'].map(
        (name, i) => `${name}=${hex(record.subarray(i * 32, i * 32 + 32))}`,
    )
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength)
    parts.push(`rax=${view.getBigUint64(192, true).toString(16)}`, `rcx=${view.getBigUint64(200, true).toString(16)}`,
        `rdx=${view.getBigUint64(208, true).toString(16)}`, `flags=${view.getBigUint64(216, true).toString(16)}`)
    return parts.join('\n    ')
}

export type VectorResult = { blink: Uint8Array[]; native: Uint8Array[] | null }

/** The most cases one program holds: a single write of much more than this never reaches standard output. */
const CHUNK = 256

/** Runs the cases in Blink and, where the host has AVX2, natively. */
export async function runVectorCases(cases: readonly VectorCase[], seed = 1): Promise<VectorResult> {
    const blink: Uint8Array[] = []
    const native: Uint8Array[] = []
    for (let start = 0; start < cases.length; start += CHUNK) {
        const chunk = cases.slice(start, start + CHUNK)
        const table = inputs(chunk, seed + start)
        const { program, output } = await blinkOutput(source(chunk, table), chunk.length)
        const split = (all: Uint8Array) => chunk.map((_, i) => all.slice(i * RECORD_SIZE, (i + 1) * RECORD_SIZE))
        blink.push(...split(output))
        if (NATIVE_AVX) native.push(...split(nativeOutput(program)))
    }
    return { blink, native: NATIVE_AVX ? native : null }
}

/** Fails with the first few cases whose records differ, in a form that can be pasted into a bug report. */
export function expectSameAsNative(cases: readonly VectorCase[], result: VectorResult): void {
    if (!result.native) return
    const bad: string[] = []
    cases.forEach((entry, i) => {
        if (hex(result.blink[i]!) === hex(result.native![i]!)) return
        bad.push(`${entry.asm}\n  native:\n    ${describe(result.native![i]!)}\n  blink:\n    ${describe(result.blink[i]!)}`)
    })
    expect(bad.slice(0, 3).join('\n\n'), `${bad.length} of ${cases.length} cases differ`).toBe('')
}

/** Runs and compares in one step, for the common case. */
export async function checkAgainstNative(cases: readonly VectorCase[], seed = 1): Promise<void> {
    expectSameAsNative(cases, await runVectorCases(cases, seed))
}
