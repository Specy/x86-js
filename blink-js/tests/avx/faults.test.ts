// Vector instructions that fault: nothing may be left half done, the signal must carry the same
// code and address as the host's, and accesses that straddle a page must work when both pages are
// mapped.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../../src/x86-emulator'
import { linkedProgram } from '../compiler-output/helpers'
import { NATIVE_AVX } from './harness'

/**
 * Each case runs with ymm0-ymm3 holding known patterns, rbx pointing just past a mapped page whose
 * successor is unmapped (`edge`), rsi at the start of a two-page mapping (`pair`) and rbp at a
 * read-only page. The last 64 bytes of the edge page and the first 16 of the read-only one hold
 * known bytes before each case and are recorded after it.
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
    // a store that faults on its second page writes nothing to the first, even when an earlier
    // straddling access left other bytes staged for it
    'vmovdqu [rsi + 4096 - 7], ymm3\nvmovdqu [rbx - 16], ymm2',
    'vmovdqu [rsi + 4096 - 7], ymm3\nvmovdqu [rbx - 4], xmm2',
    'vmovdqu ymm0, [rsi + 4096 - 7]\nmov qword [rbx - 4], 0',
    'vmovdqu [rsi + 4096 - 7], ymm3\nmovdqu [rbx - 8], xmm2',
    'vmovdqu [rsi + 4096 - 7], ymm3\nvmaskmovps [rbx - 2], ymm2, ymm1',
    // the narrowing conversions write their first half before they read the second
    'vcvtpd2ps xmm0, yword [rbx - 16]',
    'vcvttpd2dq xmm0, yword [rbx - 16]',
    'vcvtpd2dq xmm0, yword [rbx - 16]',
    // a 256-bit load faults on any of its bytes, even when it uses only some
    'vmovddup ymm0, [rbx - 24]',
    // scalar instructions ignore VEX.L: vaddss and vmovss with L=1 touch four bytes
    'db 0xc5, 0xf6, 0x58, 0x43, 0xfc',
    'db 0xc5, 0xfe, 0x10, 0x43, 0xfc',
    'db 0xc5, 0xfe, 0x11, 0x43, 0xfc',
    // stores to a read-only page
    'vmovdqa [rbp], xmm1',
    'vmovntdq [rbp], xmm1',
    'vmovntps [rbp], xmm1',
    'movdqa [rbp], xmm1',
    'vmovdqu [rbp], ymm1',
    // misaligned operands of the aligned moves are #GP, reported without an address
    'movaps xmm0, [rsi + 8]',
    'movdqa [rsi + 8], xmm1',
    'vmovaps ymm0, [rsi + 16]',
    'vmovdqa xmm0, [rsi + 8]',
    'vmovntdqa ymm0, [rsi + 16]',
    'vmovaps [rsi + 16], ymm1',
    // a gather that faults keeps the elements before the fault, and its mask is all ones or all
    // zeros per element and cleared past the last element from the start
    'vmovdqu xmm1, [rel indices]\nvpgatherdd xmm0, [rbx + xmm1*4 - 8], xmm2',
    'vmovdqu ymm1, [rel indices]\nvpgatherdd ymm0, [rbx + ymm1*4 - 8], ymm2',
    'vmovdqu xmm1, [rel indices + 32]\nvpgatherqq xmm0, [rbx + xmm1*8 - 8], xmm2',
    'vmovdqu xmm1, [rel indices]\nvpgatherdq ymm0, [rbx + xmm1*8 - 8], ymm2',
    // 8f /1 is not a pop; once AMD's XOP prefix, today undefined
    'db 0x8f, 0xc8',
]

/** The cases whose fault address differs between processors: a masked store or load reports a byte
 * of the faulting element, which byte depends on the processor. */
const ADDRESS_VARIES = /maskmov/

/** Each record: ymm0-ymm3, the signal, its code, its address less rbx, the flags, the 64 bytes
 * below the edge and the 16 at the start of the read-only page. */
const RECORD = 4 * 32 + 8 * 4 + 64 + 16
const SIGNAL = 128

function source(): string {
    const lines = ['bits 64', 'global _start', 'section .data',
        'act: dq handler, 0x04000004, restorer, 0', 'resume: dq 0',
        'fault: dq 0, 0, 0',
        'align 32', 'pattern: db ' + Array.from({ length: 128 }, (_, i) => (i * 37 + 11) & 255).join(', '),
        'guard: times 64 db 0x5a',
        'indices: dd 0, 1, 2, 3, 4, 5, 6, 7, 0, 0, 1, 0, 2, 0, 3, 0',
        'section .bss', 'results: resb ' + CASES.length * RECORD, 'section .text', '_start:',
        'mov eax, 13', 'mov edi, 11', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'mov eax, 13', 'mov edi, 4', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        // edge: two pages, the second unmapped again
        'mov eax, 9', 'xor edi, edi', 'mov esi, 8192', 'mov edx, 3', 'mov r10d, 0x22', 'mov r8, -1', 'xor r9d, r9d', 'syscall',
        'mov r12, rax', 'lea rbx, [rax + 4096]',
        'mov eax, 11', 'lea rdi, [r12 + 4096]', 'mov esi, 4096', 'syscall',
        // pair: two mapped pages
        'mov eax, 9', 'xor edi, edi', 'mov esi, 8192', 'mov edx, 3', 'mov r10d, 0x22', 'mov r8, -1', 'xor r9d, r9d', 'syscall',
        'mov r13, rax',
        // a read-only page
        'mov eax, 9', 'xor edi, edi', 'mov esi, 4096', 'mov edx, 3', 'mov r10d, 0x22', 'mov r8, -1', 'xor r9d, r9d', 'syscall',
        'mov rbp, rax', 'vmovdqu xmm0, [rel guard]', 'vmovdqu [rbp], xmm0',
        'mov eax, 10', 'mov rdi, rbp', 'mov esi, 4096', 'mov edx, 1', 'syscall',
        'lea r14, [rel results]']
    CASES.forEach((asm, index) => {
        lines.push(
            'vmovdqu ymm0, [rel guard]', 'vmovdqu [rbx - 64], ymm0', 'vmovdqu [rbx - 32], ymm0',
            'vmovdqu ymm0, [rel pattern]', 'vmovdqu ymm1, [rel pattern + 32]', 'vmovdqu ymm2, [rel pattern + 64]',
            'vmovdqu ymm3, [rel pattern + 96]', 'mov rsi, r13',
            'xor eax, eax', 'mov [rel fault], rax', 'mov [rel fault + 8], rax', 'mov [rel fault + 16], rax',
            `lea rax, [rel after_${index}]`, 'mov [rel resume], rax',
            'push 0x202', 'popfq',
            asm, `after_${index}:`,
            'vmovdqu [r14], ymm0', 'vmovdqu [r14 + 32], ymm1', 'vmovdqu [r14 + 64], ymm2', 'vmovdqu [r14 + 96], ymm3',
            'pushfq', 'pop rax', 'and eax, 0x8d5', 'mov [r14 + 152], rax',
            'mov rax, [rel fault]', 'mov [r14 + 128], rax', 'mov rax, [rel fault + 8]', 'mov [r14 + 136], rax',
            'mov rax, [rel fault + 16]', 'mov [r14 + 144], rax',
            'vmovdqu ymm0, [rbx - 64]', 'vmovdqu [r14 + 160], ymm0', 'vmovdqu ymm0, [rbx - 32]', 'vmovdqu [r14 + 192], ymm0',
            'vmovdqu xmm0, [rbp]', 'vmovdqu [r14 + 224], xmm0',
            `add r14, ${RECORD}`)
    })
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${CASES.length * RECORD}`, 'syscall',
        'mov eax, 60', 'xor edi, edi', 'syscall',
        // rdi = signal, rsi = siginfo (code at +8, address at +16), rdx = ucontext (rbx at +128, rip at
        // +168), read before the handler moves rip on. Registers are restored from the ucontext on return, so the handler leaves its
        // findings in memory.
        'handler:', 'mov [rel fault], rdi', 'mov eax, [rsi + 8]', 'mov [rel fault + 8], rax',
        // a SIGSEGV's address relative to rbx, a SIGILL's to the instruction (rip at +168)
        'mov rax, [rsi + 16]', 'test rax, rax', 'jz .zero', 'cmp edi, 11', 'jne .code',
        'sub rax, [rdx + 128]', 'jmp .zero', '.code:', 'sub rax, [rdx + 168]', '.zero:', 'mov [rel fault + 16], rax',
        'mov rax, [rel resume]', 'mov [rdx + 168], rax', 'ret',
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
            if (ADDRESS_VARIES.test(asm)) mine.set(theirs.subarray(SIGNAL + 16, SIGNAL + 24), SIGNAL + 16)
            if (hex(mine) !== hex(theirs)) {
                bad.push(`${asm}\n  host:  ${hex(theirs.slice(0, 128))}\n         sig/code/addr/flags ${hex(theirs.slice(128, 160))}\n         edge ${hex(theirs.slice(160, 224))} ro ${hex(theirs.slice(224))}\n  blink: ${hex(mine.slice(0, 128))}\n         sig/code/addr/flags ${hex(mine.slice(128, 160))}\n         edge ${hex(mine.slice(160, 224))} ro ${hex(mine.slice(224))}`)
            }
        })
        // the cases that fault must fault: a handler that never ran would leave zeros on both sides
        const faulted = CASES.filter((_, i) => new DataView(host.buffer, i * RECORD + SIGNAL, 8).getUint32(0, true) !== 0)
        expect(faulted.length).toBeGreaterThan(20)
        expect(bad.slice(0, 6).join('\n'), `${bad.length} of ${CASES.length} cases differ`).toBe('')
    })
})
