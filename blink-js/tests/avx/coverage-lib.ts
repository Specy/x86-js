export type Slot = {
    map: number
    pp: number
    opcode: number
    l: number
    w: number
    form: 'reg' | 'mem'
    reg: number
    /** The register VEX.vvvv names; 0, encoded as 1111, is also what an instruction without one requires. */
    vvvv?: number
    /** A LOCK prefix before the VEX prefix. */
    lock?: boolean
}

/** Opcodes whose ModRM.reg field picks a different instruction. */
const GROUPS = new Set([0x171, 0x172, 0x173, 0x1ae, 0x2f3])

export function slots(map: number, vvvv = 0): Slot[] {
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
                            result.push({ map, pp, opcode, l, w, form, reg, vvvv })
                        }
                    }
                }
            }
        }
    }
    return result
}

/**
 * Maps VEX does not define, and a LOCK prefix before VEX: every one is undefined, so both machines
 * must raise SIGILL for all of them. Map 7 with an immediate-taking opcode once ran as map 3 and
 * then decoded its immediate as the next instruction.
 */
export function undefinedSlots(): Slot[] {
    const result: Slot[] = []
    for (const map of [0, 4, 5, 6, 7, 8, 13, 17, 21, 29, 31]) {
        for (const opcode of [0x00, 0x0f, 0x10, 0x58, 0x77, 0xc2, 0xf7]) {
            for (let pp = 0; pp < 4; pp++) {
                for (const l of [0, 1]) {
                    for (const w of [0, 1]) {
                        for (const form of ['reg', 'mem'] as const) {
                            result.push({ map, pp, opcode, l, w, form, reg: 1 })
                        }
                    }
                }
            }
        }
    }
    for (const opcode of [0x10, 0x58, 0x5f, 0xef]) {
        for (let pp = 0; pp < 4; pp++) {
            for (const l of [0, 1]) {
                for (const form of ['reg', 'mem'] as const) {
                    result.push({ map: 1, pp, opcode, l, w: 0, form, reg: 1, lock: true })
                }
            }
        }
    }
    return result
}

/**
 * Encodings of extensions Blink leaves out on purpose (VAES, 256-bit VPCLMULQDQ, GFNI, AVX-VNNI,
 * AVX-IFMA, AVX-NE-CONVERT, SHA512, SM3 and SM4, CMPccXADD, AMX, and the AVX-512 mask
 * instructions, which are VEX-encoded). A host that has one runs it and Blink does not.
 */
export function deliberatelyMissing(slot: Slot): boolean {
    const { map, pp, opcode: op, l } = slot
    if (map === 1) return (op >= 0x41 && op <= 0x4b) || (op >= 0x90 && op <= 0x93) || op === 0x98 || op === 0x99
    if (map === 2) {
        return (
            (pp === 1 && op >= 0xdc && op <= 0xdf && l === 1) ||
            (op >= 0x49 && op <= 0x4b) ||
            (op >= 0x50 && op <= 0x53) ||
            (op >= 0x5c && op <= 0x5f) ||
            (op >= 0x6b && op <= 0x6f) ||
            op === 0x72 ||
            (op >= 0xb0 && op <= 0xb5) ||
            (op >= 0xcb && op <= 0xcd) ||
            op === 0xcf ||
            (op >= 0xd2 && op <= 0xd3) ||
            op === 0xda ||
            (op >= 0xe0 && op <= 0xef)
        )
    }
    if (map === 3) return (pp === 1 && op === 0x44 && l === 1) || (op >= 0x30 && op <= 0x33) || op === 0xce || op === 0xcf || op === 0xde
    return false
}

/**
 * Encodings the processor makers disagree on. Intel requires VEX.W1 for vpermq and vpermpd and AMD
 * ignores W, so an AMD host runs the W0 forms Blink refuses as Intel does.
 */
export function vendorDependent(slot: Slot): boolean {
    return slot.map === 3 && slot.pp === 1 && (slot.opcode === 0x00 || slot.opcode === 0x01) && slot.w === 0
}

function encode(slot: Slot): number[] {
    const modrm = slot.form === 'reg' ? 0xc0 | slot.reg << 3 | 2 : slot.reg << 3
    const vvvv = ~(slot.vvvv ?? 0) & 15
    const prefix = [0xc4, 0xe0 | slot.map, slot.w << 7 | vvvv << 3 | slot.l << 2 | slot.pp, slot.opcode]
    const lock = slot.lock ? [0xf0] : []
    return slot.map === 1 && slot.opcode === 0x77 ? [...lock, ...prefix, 0x90, 0x90] : [...lock, ...prefix, modrm, 0x90]
}

export function source(list: Slot[]): string {
    const lines = ['bits 64', 'global _start', 'section .data', 'act: dq handler, 0x04000004, restorer, 0',
        'section .bss', 'align 64', 'mem: resb 256', `results: resb ${list.length}`, 'section .text', '_start:',
        'mov eax, 13', 'mov edi, 4', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'mov eax, 13', 'mov edi, 11', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'mov eax, 13', 'mov edi, 8', 'lea rsi, [rel act]', 'xor edx, edx', 'mov r10d, 8', 'syscall',
        'lea r15, [rel results]', 'vzeroall', 'xor ecx, ecx', 'xor edx, edx', 'jmp slots', 'align 16', 'slots:']
    for (const slot of list) {
        const bytes = encode(slot)
        lines.push('lea rax, [rel mem]', `db ${bytes.join(', ')}`, `times ${9 - bytes.length} db 0x90`)
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

