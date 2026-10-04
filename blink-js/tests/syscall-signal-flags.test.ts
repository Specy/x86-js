// Same NASM-linked ELF in the Core and on x86-64 Linux. Intel SDM 093 Vol. 2B
// SYSCALL; Vol. 3B 20.3.1.1/20.3.1.4; Linux handle_signal() in signal.c.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'

const NATIVE = process.platform === 'linux' && process.arch === 'x64'
let scratch: string | undefined
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }) })

function native(program: Uint8Array): Uint8Array {
    scratch ??= mkdtempSync(join(tmpdir(), 'x86-signal-flags-'))
    const path = join(scratch, 'program')
    writeFileSync(path, program)
    chmodSync(path, 0o755)
    const result = spawnSync(path, [], { timeout: 5000 })
    if (result.error) throw result.error
    expect(result.signal, result.stderr.toString()).toBeNull()
    expect(result.status, result.stderr.toString()).toBe(0)
    return Uint8Array.from(result.stdout)
}

async function compare(lines: string[], expected: bigint[], nativeRfMayClear: readonly number[] = []): Promise<void> {
    const emulator = await createX86Emulator()
    try {
        const build = await emulator.compile(lines.join('\n'))
        expect(build.ok, build.report).toBe(true)
        const executable = Uint8Array.from(emulator.module.FS.readFile('/program') as Uint8Array)
        const reference = NATIVE ? native(executable) : undefined
        const words = (data: Uint8Array) => {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
            return Array.from({ length: data.length / 8 }, (_, i) => view.getBigUint64(i * 8, true))
        }
        const referenceWords = reference ? words(reference) : undefined
        if (referenceWords) {
            // SDM Vol.3B 20.3.1.1 requires RF for an intermediate REP trap.
            // CI run 37244320730 returned RF=0 for those two frames, while
            // earlier hosts returned RF=1. Permit only that observed native
            // difference; the Core must still satisfy the exact SDM word.
            for (const index of nativeRfMayClear) {
                expect([expected[index], expected[index]! & ~0x10000n], `native RF at word ${index}`).toContain(referenceWords[index])
                referenceWords[index] = referenceWords[index]! | 0x10000n
            }
            expect(referenceWords, 'native reference').toEqual(expected)
        }
        const actual: number[] = []
        emulator.on('stdout', (byte) => { actual.push(byte) })
        // Handled synchronous signals yield to JavaScript between instructions.
        for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice++) await emulator.run(100_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        expect(emulator.stopReason?.kind === 'exit' && emulator.stopReason.exitCode).toBe(0)
        // The runtime echoes the program command before its binary stdout.
        const bytes = Uint8Array.from(actual.slice(-expected.length * 8))
        expect(words(bytes), 'Core architectural expectation').toEqual(expected)
        if (referenceWords) expect(words(bytes), 'Core versus native').toEqual(referenceWords)
    } finally {
        emulator.dispose()
    }
}

const FINISH = [
    'mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', 'mov edx, results_size', 'syscall',
    'mov eax, 60', 'xor edi, edi', 'syscall',
]

describe('SYSCALL architectural registers', () => {
    it.each([
        { name: 'ordinary syscall', number: 39, args: [] },
        { name: 'unknown syscall', number: 0x400, args: [] },
        { name: 'clock_gettime fast path', number: 228, args: ['xor edi, edi', 'lea rsi, [rel timespec]'] },
    ])('saves RFLAGS in R11 and the next RIP in RCX for $name', async ({ number, args }) => {
        const flags = [0x202, 0xad7, 0x246, 0x602, 0x200ed7]
        const lines = [
            'bits 64', 'global _start', 'section .bss', 'timespec: resq 2',
            `results: resq ${flags.length * 2}`, `results_size equ ${flags.length * 16}`,
            'section .text', '_start:',
        ]
        flags.forEach((word, i) => lines.push(
            ...args, `mov eax, ${number}`, 'mov r11, -1', 'mov rcx, -1',
            `push ${word}`, 'popfq', 'syscall', `next_${i}:`,
            `mov [rel results + ${i * 16}], r11`, `lea rax, [rel next_${i}]`,
            'sub rcx, rax', `mov [rel results + ${i * 16 + 8}], rcx`,
        ))
        lines.push('cld', ...FINISH)
        await compare(lines, flags.flatMap((word) => [BigInt(word), 0n]))
    })
})

const FAULTS: Array<{ instruction: string; signal: number; code: number; rf: boolean; flags?: number }> = [
    { instruction: 'cli', signal: 11, code: 128, rf: true },
    { instruction: 'sti', signal: 11, code: 128, rf: true },
    { instruction: 'hlt', signal: 11, code: 128, rf: true },
    ...['in al, 0x80', 'in ax, 0x80', 'in eax, 0x80', 'in al, dx', 'in ax, dx', 'in eax, dx',
        'out 0x80, al', 'out 0x80, ax', 'out 0x80, eax', 'out dx, al', 'out dx, ax', 'out dx, eax',
        'insb', 'insw', 'insd', 'outsb', 'outsw', 'outsd', 'rep insb', 'rep outsb']
        .map((instruction) => ({ instruction, signal: 11, code: 128, rf: true })),
    { instruction: 'ud2', signal: 4, code: 2, rf: true },
    { instruction: 'ud2', signal: 4, code: 2, rf: true, flags: 0x702 },
    { instruction: 'div ecx', signal: 8, code: 1, rf: true },
    { instruction: 'mov eax, [rcx]', signal: 11, code: 1, rf: true },
    { instruction: 'int3', signal: 5, code: 128, rf: false },
]

describe('Linux signal flags and privileged instructions', () => {
    it.each(FAULTS)('$instruction saves fault RF and enters its handler with DF/RF/TF clear', async (entry) => {
        const flagWord = BigInt(entry.flags ?? 0x602)
        await compare([
            'bits 64', 'global _start', 'section .data',
            'act: dq handler, 0x04000004, restorer, 0',
            'section .bss', 'results: resq 6', 'results_size equ 48', 'section .text', '_start:',
            'mov eax, 13', `mov edi, ${entry.signal}`, 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
            'xor ecx, ecx', `push ${flagWord}`, 'popfq',
            'fault:', entry.instruction, 'after_fault:', 'cld', ...FINISH,
            'handler:',
            // Read entry flags before the handler itself changes arithmetic flags.
            'pushfq', 'pop rax', 'mov [rel results + 24], rax',
            'mov [rel results], rdi', 'movsxd rax, dword [rsi + 8]', 'mov [rel results + 8], rax',
            'mov rax, [rdx + 176]', 'mov [rel results + 16], rax',
            `lea rax, [rel ${entry.rf ? 'fault' : 'after_fault'}]`, 'sub rax, [rdx + 168]',
            'mov [rel results + 32], rax',
            // #GP has si_addr == NULL; other faults report the faulting address.
            ...(entry.code === 128 && entry.rf ? ['mov rax, [rsi + 16]', 'mov [rel results + 40], rax'] : []),
            'lea rax, [rel after_fault]', 'mov [rdx + 168], rax', 'and qword [rdx + 176], ~0x100', 'ret',
            'restorer:', 'mov eax, 15', 'syscall',
        ], [BigInt(entry.signal), BigInt(entry.code), flagWord | (entry.rf ? 0x10000n : 0n), 0x202n, 0n, 0n])
    })
})

describe('TF single stepping in the interpreter', () => {
    it.each([
        { name: 'POPF enabling TF takes effect after the next NOP', setup: ['push 0x302', 'popfq'], instruction: 'nop', flags: 0x302n },
        { name: 'POPF clearing TF still traps after that POPF', setup: ['push 0x202', 'push 0x302', 'popfq'], instruction: 'popfq', flags: 0x202n },
        { name: 'handler entry clears both DF and TF', setup: ['push 0x702', 'popfq'], instruction: 'nop', flags: 0x702n },
        { name: 'rt_sigreturn enabling TF steps the resumed instruction', setup: ['push 0x202', 'popfq', 'int3'], instruction: 'nop', flags: 0x302n },
        { name: 'SYSCALL under TF steps the first instruction after its return', setup: ['mov eax, 0x400', 'push 0x302', 'popfq', 'syscall'], instruction: 'nop', flags: 0x302n },
    ])('$name', async (entry) => {
        await compare([
            'bits 64', 'global _start', 'section .data', 'act: dq handler, 0x04000004, restorer, 0',
            'section .bss', 'results: resq 6', 'results_size equ 48', 'section .text', '_start:',
            'mov eax, 13', 'mov edi, 5', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
            ...entry.setup, entry.instruction, 'after_step:', 'cld', ...FINISH,
            'handler:', 'pushfq', 'pop rax',
            ...(entry.name.startsWith('rt_sigreturn') ? [
                'cmp dword [rsi + 8], 128', 'jne record',
                'or qword [rdx + 176], 0x100', 'ret', 'record:',
            ] : []),
            'mov [rel results + 24], rax', 'mov [rel results], rdi',
            'movsxd rax, dword [rsi + 8]', 'mov [rel results + 8], rax',
            'mov rax, [rdx + 176]', 'mov [rel results + 16], rax',
            'lea rax, [rel after_step]', 'sub rax, [rdx + 168]', 'mov [rel results + 32], rax',
            'mov rax, [rdx + 200]', 'mov [rel results + 40], rax',
            'and qword [rdx + 176], ~0x100', 'ret', 'restorer:', 'mov eax, 15', 'syscall',
        ], [5n, 2n, entry.flags, 0x202n, 0n, 1n])
    })

    it.each(['rep movsb', 'rep stosb'])('%s traps after each iteration, retaining RIP and RF until the last', async (instruction) => {
        await compare([
            'bits 64', 'global _start', 'section .data', 'act: dq handler, 0x04000004, restorer, 0',
            'source: db 1, 2, 3', 'count: dq 0',
            'section .bss', 'destination: resb 3', 'results: resq 15', 'results_size equ 120',
            'section .text', '_start:',
            'mov eax, 13', 'mov edi, 5', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
            'lea rsi, [rel source]', 'lea rdi, [rel destination]', 'mov ecx, 3',
            'push 0x302', 'popfq', 'string_step:', instruction, 'after_step:', ...FINISH,
            'handler:', 'pushfq', 'pop rax', 'mov r8, [rel count]', 'imul r8, 40', 'lea r9, [rel results]',
            'mov [r9 + r8 + 16], rax', 'mov rax, [rdx + 176]', 'mov [r9 + r8], rax',
            // First two traps point back to REP; last one points to after_step.
            'lea rax, [rel string_step]', 'cmp qword [rel count], 2', 'jne have_pc',
            'lea rax, [rel after_step]', 'have_pc:', 'sub rax, [rdx + 168]', 'mov [r9 + r8 + 8], rax',
            'mov rax, [rdx + 152]', 'mov [r9 + r8 + 24], rax', // saved RCX
            'movsxd rax, dword [rsi + 8]', 'mov [r9 + r8 + 32], rax',
            'inc qword [rel count]', 'cmp qword [rel count], 3', 'jne keep_tf',
            'and qword [rdx + 176], ~0x100', 'keep_tf:', 'ret', 'restorer:', 'mov eax, 15', 'syscall',
        ], [0x10302n, 0n, 0x202n, 2n, 2n, 0x10302n, 0n, 0x202n, 1n, 2n, 0x302n, 0n, 0x202n, 0n, 2n], [0, 5])
    })
})
