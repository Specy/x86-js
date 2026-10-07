// Intel SDM 093 COMIS*/UCOMIS*: QNaN vs SNaN invalid exceptions, sticky IE,
// and suppression of every EFLAGS update when invalid is unmasked. The same
// ELF records its Linux SIGFPE frame and runs natively on supported hosts.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { linkedProgram, NATIVE } from './compiler-output/helpers'
import { createX86Emulator } from '../src/x86-emulator'

const VALUES = {
    ss: { one: 0x3f800000n, two: 0x40000000n, qnan: 0x7fc00003n, snan: 0x7f800003n },
    sd: { one: 0x3ff0000000000000n, two: 0x4000000000000000n, qnan: 0x7ff8000000000003n, snan: 0x7ff0000000000003n },
}
type Operand = keyof typeof VALUES.ss
type Case = {
    name: string
    width: 'ss' | 'sd'
    operation: string
    x: Operand
    y: Operand
    mxcsr: number
    memory: boolean
    invalid: boolean
    flags: number
}
const CASES: Case[] = []
for (const width of ['ss', 'sd'] as const) {
    for (const ordered of [true, false]) {
        const operation = `${ordered ? 'comi' : 'ucomi'}${width}`
        for (const memory of [false, true]) {
            for (const [x, y, mxcsr] of [
                ['one', 'two', 0x1f80], ['two', 'one', 0x1f81], ['one', 'one', 0x1f01],
                ['qnan', 'one', 0x1f80], ['one', 'qnan', 0x1f80],
                ['snan', 'one', 0x1f80], ['one', 'snan', 0x1f80],
                ['qnan', 'one', 0x1f00], ['one', 'qnan', 0x1f00],
                ['snan', 'one', 0x1f00], ['one', 'snan', 0x1f00],
            ] as const) {
                const unordered = x.includes('nan') || y.includes('nan')
                const invalid = x === 'snan' || y === 'snan' || (ordered && unordered)
                const flags = unordered ? 0x45 : x === y ? 0x40 : x === 'one' ? 1 : 0
                CASES.push({ name: `${operation} ${x}, ${y} (${memory ? 'memory' : 'register'}, MXCSR ${mxcsr.toString(16)})`,
                    width, operation, x, y, mxcsr, memory, invalid, flags })
            }
        }
    }
}
const RECORD_SIZE = 48

function expected(entry: Case): bigint[] {
    const fault = entry.invalid && !(entry.mxcsr & 0x80)
    return [
        BigInt(fault ? 0x8d5 : entry.flags),
        BigInt(fault ? 0x1f80 : entry.mxcsr | (entry.invalid ? 1 : 0)),
        BigInt(fault ? 0x8d5 : 0),
        0n,
        BigInt(fault ? 1 : 0),
        VALUES[entry.width][entry.x],
    ]
}

function source(): string[] {
    const lines = ['bits 64', 'global _start', 'section .data',
        'act: dq handler, 0x04000004, restorer, 0', // SA_SIGINFO | SA_RESTORER
        'current: dq 0', 'length: dq 0']
    for (const width of ['ss', 'sd'] as const) {
        for (const [name, value] of Object.entries(VALUES[width])) {
            lines.push(`${width}_${name}: ${width === 'ss' ? 'dd' : 'dq'} 0x${value.toString(16)}`)
        }
    }
    for (const csr of [...new Set(CASES.map((entry) => entry.mxcsr))]) lines.push(`csr_${csr}: dd ${csr}`)
    lines.push('section .bss', `results: resb ${CASES.length * RECORD_SIZE}`, 'section .text', '_start:',
        'mov eax, 13', 'mov edi, 8', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'lea rbx, [rel results]')
    CASES.forEach((entry, index) => {
        const load = entry.width === 'ss' ? 'movd' : 'movq'
        const source = entry.memory ? `[rel ${entry.width}_${entry.y}]` : 'xmm1'
        const length = (entry.width === 'sd' ? 4 : 3) + (entry.memory ? 4 : 0)
        lines.push(`mov qword [rel current], ${index * RECORD_SIZE}`, `mov qword [rel length], ${length}`,
            `ldmxcsr [rel csr_${entry.mxcsr}]`, `${load} xmm0, [rel ${entry.width}_${entry.x}]`, `${load} xmm1, [rel ${entry.width}_${entry.y}]`,
            'push 0x8d7', 'popfq', `${entry.operation} xmm0, ${source}`,
            'pushfq', 'pop rax', 'and eax, 0x8d5', 'mov [rbx], rax',
            'stmxcsr [rbx + 8]', 'movq [rbx + 40], xmm0', `add rbx, ${RECORD_SIZE}`)
    })
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${CASES.length * RECORD_SIZE}`, 'syscall',
        'mov eax, 60', 'xor edi, edi', 'syscall',
        'handler:', // rdx = ucontext; mcontext.gregs[REG_EFL] at +176, fpregs at +224
        'mov rcx, [rel current]', 'lea r8, [rel results]', 'add r8, rcx',
        'mov rax, [rdx + 176]', 'and eax, 0x8d5', 'mov [r8 + 16], rax',
        'mov r9, [rdx + 224]',
        // Linux restores MXCSR from its saved frame; Blink currently omits it.
        // Reset the live register too, so recovery exercises the compare itself.
        'inc qword [r8 + 32]', 'mov dword [r9 + 24], 0x1f80', 'ldmxcsr [rel csr_8064]',
        'mov rax, [rel length]', 'add [rdx + 168], rax', 'ret',
        'restorer:', 'mov eax, 15', 'syscall')
    return lines
}

function qwords(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: bytes.length / 8 }, (_, i) => view.getBigUint64(i * 8, true))
}
function nativeOutput(program: Uint8Array): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), 'sse-compare-'))
    const path = join(directory, 'probe.elf')
    try {
        writeFileSync(path, program)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
        if (run.error) throw run.error
        expect(run.signal, run.stderr.toString()).toBeNull()
        expect(run.status, run.stderr.toString()).toBe(0)
        return run.stdout
    } finally { rmSync(directory, { recursive: true, force: true }) }
}

let program: Uint8Array
let observed: bigint[]
beforeAll(async () => {
    const bytes: number[] = []
    const emulator = await createX86Emulator({ callbacks: { stdout: (chunk) => { bytes.push(...chunk) } } })
    try {
        const result = await emulator.compile(source().join('\n'))
        expect(result.ok, result.report).toBe(true)
        program = linkedProgram(emulator)
        emulator.getCompiledInstructions()
        bytes.length = 0
        // Handled signals pause the debugger; resume them until the probe exits.
        for (let i = 0; i < CASES.length + 1 && emulator.stopReason?.kind !== 'exit'; i++) await emulator.run(1_000_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        observed = qwords(Uint8Array.from(bytes))
        expect(observed.length).toBe(CASES.length * 6)
    } finally { emulator.dispose() }
})

describe('SSE compare exceptions', () => {
    it.each(CASES.map((entry, index) => [entry.name, entry, index] as const))('%s', (_, entry, index) => {
        expect(observed.slice(index * 6, index * 6 + 6)).toEqual(expected(entry))
    })
    it.skipIf(!NATIVE)('matches the same executable natively, including unmasked SIGFPE frames before EFLAGS change', () => {
        const native = qwords(nativeOutput(program))
        expect(native.length).toBe(CASES.length * 6)
        CASES.forEach((entry, index) => {
            expect(native.slice(index * 6, index * 6 + 6), entry.name).toEqual(expected(entry))
        })
        CASES.forEach((entry, index) => {
            expect(observed.slice(index * 6, index * 6 + 6), entry.name).toEqual(native.slice(index * 6, index * 6 + 6))
        })
    })
})
