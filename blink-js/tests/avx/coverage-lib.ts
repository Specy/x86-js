export type Slot = { map: number; pp: number; opcode: number; l: number; w: number; form: 'reg' | 'mem'; reg: number }

/** Opcodes whose ModRM.reg field picks a different instruction. */
const GROUPS = new Set([0x171, 0x172, 0x173, 0x1ae, 0x2f3])

export function slots(map: number): Slot[] {
    const result: Slot[] = []
    for (let pp = 0; pp < 4; pp++) {
        for (let opcode = 0; opcode < 256; opcode++) {
            // gathers and the other VSIB forms need an index register: tested on their own
            const regs = GROUPS.has(map << 8 | opcode) ? [0, 1, 2, 3, 4, 5, 6, 7] : [1]
            for (const reg of regs) {
                for (const l of [0, 1]) {
                    for (const w of [0, 1]) {
                        // vzeroupper takes no ModRM byte: one form
                        for (const form of map === 1 && opcode === 0x77 ? (['reg'] as const) : (['reg', 'mem'] as const)) {
                            result.push({ map, pp, opcode, l, w, form, reg })
                        }
                    }
                }
            }
        }
    }
    return result
}

function encode(slot: Slot): number[] {
    const modrm = slot.form === 'reg' ? 0xc0 | slot.reg << 3 | 2 : slot.reg << 3
    const prefix = [0xc4, 0xe0 | slot.map, slot.w << 7 | 0b1111 << 3 | slot.l << 2 | slot.pp, slot.opcode]
    return slot.map === 1 && slot.opcode === 0x77 ? [...prefix, 0x90, 0x90] : [...prefix, modrm, 0x90]
}

export function source(list: Slot[]): string {
    const lines = ['bits 64', 'global _start', 'section .data', 'act: dq handler, 0x04000004, restorer, 0',
        'section .bss', 'align 64', 'mem: resb 256', `results: resb ${list.length}`, 'section .text', '_start:',
        'mov eax, 13', 'mov edi, 4', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'mov eax, 13', 'mov edi, 11', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'mov eax, 13', 'mov edi, 8', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'lea r15, [rel results]', 'vzeroall', 'xor ecx, ecx', 'xor edx, edx', 'jmp slots', 'align 16', 'slots:']
    for (const slot of list) {
        lines.push('lea rax, [rel mem]', `db ${encode(slot).join(', ')}`, 'times 3 db 0x90')
    }
    lines.push('mov eax, 1', 'mov edi, 1', 'lea rsi, [rel results]', `mov edx, ${list.length}`, 'syscall',
        'mov eax, 60', 'xor edi, edi', 'syscall',
        // rdi = signal, rdx = ucontext; the program counter is at +168
        'handler:', 'mov rax, [rdx + 168]', 'lea rcx, [rel slots]', 'sub rax, rcx', 'shr rax, 4',
        'cmp edi, 4', 'mov r8d, 1', 'mov r9d, 2', 'cmovne r8d, r9d', 'mov [r15 + rax], r8b',
        'inc rax', 'shl rax, 4', 'add rax, rcx', 'mov [rdx + 168], rax', 'ret',
        'restorer:', 'mov eax, 15', 'syscall')
    return lines.join('\n')
}

