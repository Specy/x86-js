// The RFLAGS word a program sees, against a native run.
//
// Every expected word below is what the same instructions produced natively
// (the same ELF, run on an Intel Core i7-10750H under Linux): bit 1 set, bits
// 3, 5 and 15 clear, IOPL 0 and IF 1, since a Linux program runs at an I/O
// privilege level of zero and so can neither see one nor clear IF. Blink used
// to push bit 3 and bit 12 (a SetFlag() of IOPL with a boolean), let POPF
// clear IF, start programs with PF set, compute AF wrongly for INC and NEG,
// leave AF set after the SSE compares, and give signal handlers its own
// internal word, which rt_sigreturn then took back whole.
import { describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

type Case = { name: string; lines: string[]; expected: number; lahf?: boolean; atEntry?: boolean }

// Each case but the first starts from POPF of 0x202, the word a program starts with.
const CASES: Case[] = [
    { name: 'at entry', lines: [], expected: 0x202, atEntry: true },
    { name: 'popf 0x202', lines: [], expected: 0x202 },
    { name: 'xor eax, eax', lines: ['xor eax, eax'], expected: 0x246 },
    { name: '0x7f + 1 in al', lines: ['mov al, 0x7f', 'add al, 1'], expected: 0xa92 },
    { name: '0xff + 1 in al', lines: ['mov al, 0xff', 'add al, 1'], expected: 0x257 },
    { name: '2 - 3', lines: ['mov eax, 2', 'sub eax, 3'], expected: 0x297 },
    { name: 'inc of 0x0f in al', lines: ['mov al, 0x0f', 'inc al'], expected: 0x212 },
    { name: 'inc of 0x7f in al', lines: ['mov al, 0x7f', 'inc al'], expected: 0xa92 },
    { name: 'inc of -1 in eax', lines: ['mov eax, -1', 'inc eax'], expected: 0x256 },
    { name: 'neg of 0x10 in al', lines: ['mov al, 0x10', 'neg al'], expected: 0x287 },
    { name: 'neg of 0x80 in al', lines: ['mov al, 0x80', 'neg al'], expected: 0xa83 },
    { name: 'neg of 0x80000000 in eax', lines: ['mov eax, 0x80000000', 'neg eax'], expected: 0xa87 },
    { name: 'neg of 1 in rax', lines: ['mov rax, 1', 'neg rax'], expected: 0x297 },
    { name: 'stc', lines: ['stc'], expected: 0x203 },
    { name: 'stc, cmc', lines: ['stc', 'cmc'], expected: 0x202 },
    { name: 'clc, cmc', lines: ['clc', 'cmc'], expected: 0x203 },
    { name: 'std', lines: ['std'], expected: 0x602 },
    { name: 'std, cld', lines: ['std', 'cld'], expected: 0x202 },
    { name: 'popf 0', lines: ['push 0', 'popfq'], expected: 0x202 },
    { name: 'popf 0x8d7', lines: ['push 0x8d7', 'popfq'], expected: 0xad7 },
    { name: 'popf 0x38d5: IOPL 3, IF 0', lines: ['push 0x38d5', 'popfq'], expected: 0xad7 },
    { name: 'popf 0xd5: IF 0', lines: ['push 0xd5', 'popfq'], expected: 0x2d7 },
    { name: 'popf 0x8028: bits 3, 5 and 15', lines: ['push 0x8028', 'popfq'], expected: 0x202 },
    { name: 'popf 0x200000: ID', lines: ['push 0x200000', 'popfq'], expected: 0x200202 },
    { name: 'popf 0x200cd5: ID, DF and the arithmetic flags', lines: ['push 0x200cd5', 'popfq'], expected: 0x200ed7 },
    { name: 'popf 0x1b0000: RF, VM, VIF and VIP', lines: ['push 0x1b0000', 'popfq'], expected: 0x202 },
    { name: 'popf 0xfffbbeff: every bit but TF, NT and AC', lines: ['mov eax, 0xfffbbeff', 'push rax', 'popfq'], expected: 0x200ed7 },
    { name: 'popf 0x8d7, then pushf and popf', lines: ['push 0x8d7', 'popfq', 'pushfq', 'popfq'], expected: 0xad7 },
    { name: 'sahf of 0xff', lines: ['mov ah, 0xff', 'sahf'], expected: 0x2d7 },
    { name: 'sahf of 0x00', lines: ['mov ah, 0x00', 'sahf'], expected: 0x202 },
    { name: 'lahf after xor eax, eax', lines: ['xor eax, eax'], expected: 0x46, lahf: true },
    { name: 'lahf after 0x7f + 1 in al', lines: ['mov al, 0x7f', 'add al, 1'], expected: 0x92, lahf: true },
    { name: 'lahf after popf 0x8d7', lines: ['push 0x8d7', 'popfq'], expected: 0xd7, lahf: true },
    { name: 'lahf after popf 0', lines: ['push 0', 'popfq'], expected: 0x02, lahf: true },
    { name: 'lahf after stc', lines: ['stc'], expected: 0x03, lahf: true },
    // the SSE compares also clear OF, SF and AF, whatever the outcome
    { name: 'comiss 1 < 2', lines: ['movss xmm0, [rel one_f]', 'movss xmm1, [rel two_f]', 'push 0x8d7', 'popfq', 'comiss xmm0, xmm1'], expected: 0x203 },
    { name: 'ucomiss 2 > 1', lines: ['movss xmm0, [rel two_f]', 'movss xmm1, [rel one_f]', 'push 0x8d7', 'popfq', 'ucomiss xmm0, xmm1'], expected: 0x202 },
    { name: 'comisd 2 = 2', lines: ['movsd xmm0, [rel two_d]', 'movsd xmm1, [rel two_d]', 'push 0x8d7', 'popfq', 'comisd xmm0, xmm1'], expected: 0x242 },
    { name: 'ucomisd NaN, 2: unordered', lines: ['movsd xmm0, [rel nan_d]', 'movsd xmm1, [rel two_d]', 'push 0x8d7', 'popfq', 'ucomisd xmm0, xmm1'], expected: 0x247 },
]

function hex(value: bigint | number): string {
    return `0x${value.toString(16)}`
}

function qwords(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: bytes.length / 8 }, (_, index) => view.getBigUint64(index * 8, true))
}

async function compiled(lines: string[]): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(lines.join('\n'))
    if (!result.ok) throw new Error(`the program did not assemble:\n${result.report}`)
    return emulator
}

/** Runs to the line holding `marker`, through any signals the program handles itself. */
async function runTo(emulator: X86Emulator, lines: string[], marker: string): Promise<void> {
    const line = lines.findIndex((text) => text.includes(marker))
    for (let slice = 0; slice < 100 && emulator.stopReason?.kind !== 'breakpoint'; slice++) {
        await emulator.run(undefined, [line])
        if (emulator.hasTerminated()) break
    }
    expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('breakpoint')
}

describe('the RFLAGS word programs see', () => {
    it('is what PUSHFQ and LAHF store natively, across arithmetic, compares, POPF, SAHF and the flag instructions', async () => {
        const lines = [
            'bits 64',
            'global _start',
            'section .data',
            'one_f: dd 1.0',
            'two_f: dd 2.0',
            'two_d: dq 2.0',
            'nan_d: dq 0x7ff8000000000000',
            'section .bss',
            `results: resq ${CASES.length}`,
            'section .text',
            '_start:',
        ]
        lines.push('  lea rbx, [rel results]')
        CASES.forEach((entry, index) => {
            if (!entry.atEntry) lines.push('  push 0x202', '  popfq')
            lines.push(...entry.lines.map((line) => `  ${line}`))
            if (entry.lahf) lines.push('  lahf', '  movzx eax, ah', `  mov [rbx + ${index * 8}], rax`)
            else lines.push('  pushfq', '  pop rax', `  mov [rbx + ${index * 8}], rax`)
        })
        lines.push('  push 0x202', '  popfq', '  nop ; done', '  mov eax, 60', '  xor edi, edi', '  syscall')

        const emulator = await compiled(lines)
        await runTo(emulator, lines, 'nop ; done')
        const results = qwords(emulator.readMemoryBytes(emulator.getRegisterValue('rbx'), BigInt(CASES.length * 8)))
        expect(CASES.map((entry, index) => `${entry.name}: ${hex(results[index]!)}`)).toEqual(
            CASES.map((entry) => `${entry.name}: ${hex(entry.expected)}`),
        )
        emulator.dispose()
    })

    it('is what the bridge reports, from the program’s first instruction on', async () => {
        const lines = ['bits 64', 'global _start', 'section .text', '_start:', '  nop', '  mov eax, 60', '  xor edi, edi', '  syscall']
        const emulator = await compiled(lines)
        await emulator.step()
        expect(hex(emulator.runtime.getFlags())).toBe('0x202')
        expect(hex(emulator.runtime.getRegisterSnapshot().flags)).toBe('0x202')
        emulator.dispose()
    })
})

// A handler for the SIGTRAP an int3 raises reads uc_mcontext.gregs[REG_EFL]
// (offset 176 in the ucontext), records it, edits it, and returns through
// rt_sigreturn; the program then records the word PUSHFQ shows. Linux takes
// only the flags in its FIX_EFLAGS from the frame (arch/x86/include/asm/sighandling.h,
// used by restore_sigcontext() in arch/x86/kernel/signal_64.c:
// AC, OF, DF, TF, SF, ZF, AF, PF, CF and RF), so the reserved bits, IOPL, NT,
// VM, VIF, VIP, ID and IF a handler writes there are ignored.
const SIGNAL_CASES = [
    { name: 'POPF 0x8d7, frame untouched', setup: ['push 0x8d7', 'popfq'], or: 0n, clear: 0n, frame: 0xad7n, after: 0xad7n },
    { name: 'ADD leaving PF set', setup: ['mov eax, 3', 'add eax, 0'], or: 0n, clear: 0n, frame: 0x206n, after: 0x206n },
    { name: 'XOR leaving ZF and PF set', setup: ['xor eax, eax'], or: 0n, clear: 0n, frame: 0x246n, after: 0x246n },
    {
        name: 'frame given every bit Linux ignores, IF cleared, and CF, DF and OF set',
        setup: [],
        or: 0x8n | 0x20n | 0x8000n | 0x3000n | 0x4000n | 0x10000n | 0x20000n | 0x180000n | 0x200000n | 0xffc00000n | 0x1n | 0x400n | 0x800n,
        clear: 0x200n,
        frame: 0x202n,
        after: 0xe03n,
    },
    { name: 'frame cleared of the arithmetic flags', setup: ['push 0x8d7', 'popfq'], or: 0n, clear: 0x8d5n, frame: 0xad7n, after: 0x202n },
    { name: 'frame given PF only', setup: [], or: 0x4n, clear: 0n, frame: 0x202n, after: 0x206n },
]

describe('a signal handler’s frame', () => {
    it('holds the word the program saw, and rt_sigreturn takes back only what Linux does', async () => {
        const count = SIGNAL_CASES.length
        const lines = [
            'bits 64',
            'global _start',
            'section .data',
            'act: dq handler, 0x04000004, restorer, 0', // SA_SIGINFO | SA_RESTORER
            'edits:',
            ...SIGNAL_CASES.map((entry) => `  dq ${hex(entry.or)}, ${hex(~entry.clear & 0xffffffffffffffffn)}`),
            'current: dq 0',
            'section .bss',
            `results: resq ${2 * count}`,
            'section .text',
            '_start:',
            '  lea rbx, [rel results]',
            '  mov eax, 13', // rt_sigaction(SIGTRAP, &act, 0, 8)
            '  mov edi, 5',
            '  lea rsi, [rel act]',
            '  xor edx, edx',
            '  mov r10d, 8',
            '  syscall',
        ]
        SIGNAL_CASES.forEach((entry, index) => {
            lines.push(
                `  mov qword [rel current], ${index}`,
                '  push 0x202',
                '  popfq',
                ...entry.setup.map((line) => `  ${line}`),
                '  int3',
                '  pushfq',
                '  pop rax',
                `  mov [rbx + ${(2 * index + 1) * 8}], rax`,
                '  cld',
            )
        })
        lines.push(
            '  nop ; done',
            '  mov eax, 60',
            '  xor edi, edi',
            '  syscall',
            'handler:', // rdi = signal, rsi = siginfo, rdx = ucontext
            '  mov rcx, [rel current]',
            '  shl rcx, 4',
            '  mov rax, [rdx + 176]',
            '  lea r8, [rel results]',
            '  mov [r8 + rcx], rax',
            '  lea r9, [rel edits]',
            '  or rax, [r9 + rcx]',
            '  and rax, [r9 + rcx + 8]',
            '  mov [rdx + 176], rax',
            '  ret',
            'restorer:',
            '  mov eax, 15',
            '  syscall',
        )

        const emulator = await compiled(lines)
        await runTo(emulator, lines, 'nop ; done')
        const words = qwords(emulator.readMemoryBytes(emulator.getRegisterValue('rbx'), BigInt(2 * count * 8)))
        expect(
            SIGNAL_CASES.map((entry, index) => `${entry.name}: frame ${hex(words[2 * index]!)}, after ${hex(words[2 * index + 1]!)}`),
        ).toEqual(SIGNAL_CASES.map((entry) => `${entry.name}: frame ${hex(entry.frame)}, after ${hex(entry.after)}`))
        emulator.dispose()
    })
})
