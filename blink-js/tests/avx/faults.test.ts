// Vector instructions that fault: nothing may be left half done, the fault must name the same
// address as the host, and accesses that straddle a page must work when both pages are mapped.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../../src/x86-emulator'
import { linkedProgram } from '../compiler-output/helpers'
import { NATIVE_AVX } from './harness'

/**
 * Each case runs with ymm0-ymm3 holding known patterns, rbx pointing at the last bytes of a mapped
 * page whose successor is unmapped (`edge`) and rsi at the start of a two-page mapping (`pair`).
 */
const CASES: string[] = [
    'vaddps ymm0, ymm1, [rbx - 16]',
    'vaddps ymm0, ymm1, [rbx - 15]',
    'vaddps xmm0, xmm1, [rbx - 16]',
    'vaddss xmm0, xmm1, [rbx - 4]',
    'vaddss xmm0, xmm1, [rbx]',
    'vpaddd ymm0, ymm1, [rbx + 100]',
    'vmovdqu ymm0, [rbx - 16]',
    'vmovdqu ymm0, [rbx - 17]',
    'vmovdqu [rbx - 16], ymm1',
    'vmovdqu [rbx - 17], ymm1',
    'vmovdqu [rbx], xmm1',
    'vmovaps ymm0, [rbx - 31]',
    'vmovaps xmm0, [rbx - 15]',
    'vmovdqa [rbx - 31], ymm1',
    'vmovntdq [rbx - 31], ymm1',
    'vpmovzxbw ymm0, [rbx - 15]',
    'vpmovzxbw ymm0, [rbx - 16]',
    'vbroadcastss ymm0, [rbx - 3]',
    'vbroadcastss ymm0, [rbx]',
    'vpermq ymm0, [rbx - 31], 27',
    'vmaskmovps ymm0, ymm2, [rbx - 16]',
    'vmaskmovps [rbx - 16], ymm2, ymm1',
    'vaddps ymm0, ymm1, [rsi + 4096 - 16]',
    'vaddps ymm0, ymm1, [rsi + 4096 - 17]',
    'vmovdqu ymm0, [rsi + 4096 - 7]',
    'vmovdqu [rsi + 4096 - 7], ymm1\nvmovdqu ymm0, [rsi + 4096 - 7]',
    'vmovdqu [rsi + 4096 - 7], ymm1\nvmovdqu ymm0, [rsi + 4096 - 23]',
    'vpblendvb ymm0, ymm1, [rsi + 4096 - 9], ymm2',
    'vfmadd231ps ymm0, ymm1, [rsi + 4096 - 11]',
    'vcvtdq2pd ymm0, [rsi + 4096 - 9]',
    'vcvtpd2ps xmm0, yword [rsi + 4096 - 9]',
    'vcvtpd2ps xmm0, yword [rbx - 9]',
    'vcvtps2pd ymm0, [rbx - 15]',
    'vpsllw ymm0, ymm1, [rbx - 15]',
    'vpsllw ymm0, ymm1, [rbx - 16]',
    'vbroadcasti128 ymm0, [rbx - 15]',
    'vinsertf128 ymm0, ymm1, [rbx - 15], 1',
    'vextractf128 [rbx - 15], ymm1, 1',
    'vptest ymm0, [rbx - 31]',
    'vpcmpeqb ymm0, ymm1, [rbx - 31]',
    'vpinsrd xmm0, xmm1, [rbx - 3], 2',
    'vpextrd [rbx - 3], xmm1, 2',
    'vmovups [rbx - 16], ymm1',
]

const RECORD = 4 * 32 + 8 * 4

function source(): string {
    const lines = ['bits 64', 'global _start', 'section .data',
        'act: dq handler, 0x04000004, restorer, 0', 'resume: dq 0',
        'align 32', 'pattern: db ' + Array.from({ length: 128 }, (_, i) => (i * 37 + 11) & 255).join(', '),
        'section .bss', 'results: resb ' + CASES.length * RECORD, 'section .text', '_start:',
        'mov eax, 13', 'mov edi, 11', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        // edge: two pages, the second unmapped again
        'mov eax, 9', 'xor edi, edi', 'mov esi, 8192', 'mov edx, 3', 'mov r10d, 0x22', 'mov r8, -1', 'xor r9d, r9d', 'syscall',
        'mov r12, rax', 'lea rbx, [rax + 4096]',
        'mov eax, 11', 'lea rdi, [r12 + 4096]', 'mov esi, 4096', 'syscall',
        // pair: two mapped pages
        'mov eax, 9', 'xor edi, edi', 'mov esi, 8192', 'mov edx, 3', 'mov r10d, 0x22', 'mov r8, -1', 'xor r9d, r9d', 'syscall',
        'mov r13, rax', 'lea r14, [rel results]']
    CASES.forEach((asm, index) => {
        lines.push(
            'vmovdqu ymm0, [rel pattern]', 'vmovdqu ymm1, [rel pattern + 32]', 'vmovdqu ymm2, [rel pattern + 64]',
            'vmovdqu ymm3, [rel pattern + 96]', 'mov rsi, r13',
            `lea rax, [rel after_${index}]`, 'mov [rel resume], rax',
            'push 0x202', 'popfq', 'xor r15d, r15d', 'xor r11d, r11d',
            asm, `after_${index}:`,
            'vmovdqu [r14], ymm0', 'vmovdqu [r14 + 32], ymm1', 'vmovdqu [r14 + 64], ymm2', 'vmovdqu [r14 + 96], ymm3',
            'mov [r14 + 128], r15', 'mov [r14 + 136], r11',
            'pushfq', 'pop rax', 'and eax, 0x8d5', 'mov [r14 + 144], rax',
            'mov rax, [rbx - 64]', 'mov [r14 + 152], rax',
            `add r14, ${RECORD}`)
    })
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${CASES.length * RECORD}`, 'syscall',
        'mov eax, 60', 'xor edi, edi', 'syscall',
        // rsi = siginfo (address at +16), rdx = ucontext (rip at +168)
        'handler:', 'mov r11, [rsi + 16]', 'mov r15d, edi', 'mov rax, [rel resume]', 'mov [rdx + 168], rax', 'ret',
        'restorer:', 'mov eax, 15', 'syscall')
    return lines.join('\n')
}

async function inBlink(src: string): Promise<{ program: Uint8Array; output: Uint8Array }> {
    const bytes: number[] = []
    const emulator = await createX86Emulator({ callbacks: { stdout: (chunk) => void bytes.push(...chunk) } })
    try {
        const result = await emulator.compile(src)
        expect(result.ok, result.report).toBe(true)
        const program = linkedProgram(emulator)
        emulator.getCompiledInstructions()
        bytes.length = 0
        for (let i = 0; i < 10_000 && emulator.stopReason?.kind !== 'exit'; i++) await emulator.run(10_000_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return { program, output: Uint8Array.from(bytes) }
    } finally {
        emulator.dispose()
    }
}

function natively(program: Uint8Array): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), 'avx-faults-'))
    const path = join(directory, 'probe.elf')
    try {
        writeFileSync(path, program)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
        if (run.error) throw run.error
        expect(run.status, run.stderr.toString()).toBe(0)
        return new Uint8Array(run.stdout)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

describe.skipIf(!NATIVE_AVX)('faulting vector instructions', () => {
    it('leave the machine as the host leaves it', async () => {
        const { program, output } = await inBlink(source())
        const host = natively(program)
        expect(output.length).toBe(CASES.length * RECORD)
        const bad: string[] = []
        CASES.forEach((asm, i) => {
            const mine = output.slice(i * RECORD, (i + 1) * RECORD)
            const theirs = host.slice(i * RECORD, (i + 1) * RECORD)
            if (hex(mine) !== hex(theirs)) {
                bad.push(`${asm}\\n  host:  ${hex(theirs.slice(0, 128))}\\n         sig/addr/flags/mem ${hex(theirs.slice(128))}\\n  blink: ${hex(mine.slice(0, 128))}\\n         sig/addr/flags/mem ${hex(mine.slice(128))}`)
            }
        })
        expect(bad.slice(0, 6).join('\n'), `${bad.length} of ${CASES.length} cases differ`).toBe('')
    })
})
