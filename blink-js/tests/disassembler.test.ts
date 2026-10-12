import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { loadDisassembler } from '../src/disassembler'
import { analyze } from '../src/elf'
import { assembleInstruction } from '../src/wasm-assembler'

const { disassemble } = await loadDisassembler()

const hex = (text: string) => Uint8Array.from(text.split(' ').map((b) => parseInt(b, 16)))
const textOf = (bytes: string, address = 0x401000n) =>
    disassemble(hex(bytes), address).map((i) => i.text)

it('decodes CET, SSE, AVX2 and AVX-512 with NASM spelling without losing instruction boundaries', () => {
    const bytes = Uint8Array.of(
        0xf3,
        0x0f,
        0x1e,
        0xfa,
        0x0f,
        0x29,
        0x45,
        0x80,
        0xc4,
        0xe2,
        0x7d,
        0x78,
        0xc0,
        0x62,
        0xe2,
        0x7d,
        0x48,
        0x7a,
        0xce
    )
    const instructions = disassemble(bytes, 0x401000n)
    expect(instructions.map((i) => i.text)).toEqual([
        'endbr64',
        'movaps [rbp-0x80], xmm0',
        'vpbroadcastb ymm0, xmm0',
        'vpbroadcastb zmm17, esi'
    ])
    expect(instructions.reduce((size, i) => size + i.length, 0)).toBe(bytes.length)
    expect(instructions.every((i) => !i.isInvalid)).toBe(true)
})

it('exposes direct branch and RIP-relative targets and exact replacement spans', () => {
    const [load, branch] = disassemble(
        Uint8Array.of(0x48, 0x8d, 0x3d, 0x10, 0, 0, 0, 0x75, 0x03),
        0x401000n
    )
    expect(load.text).toBe('lea rdi, [rel 0x401017]')
    expect(load.operands[0]).toMatchObject({ memoryTarget: 0x401017n })
    expect(load.text.slice(load.operands[0].textStart, load.operands[0].textEnd)).toBe(
        '[rel 0x401017]'
    )
    expect(branch).toMatchObject({
        isJump: true,
        isConditional: true,
        mnemonic: 'jne',
        text: 'jne 0x40100c'
    })
    expect(disassemble(Uint8Array.of(0x74, 0), 0n)[0].text).toBe('je 0x2')
    expect(branch.operands[0].branchTarget).toBe(0x40100cn)
    expect(disassemble(Uint8Array.of(0x0f), 0n)[0]).toMatchObject({
        length: 1,
        text: 'db 0x0f',
        isInvalid: true
    })
})

it('tells bytes that ran out before the instruction ended from bytes that are invalid', () => {
    const whole = hex('8b 04 25 00 10 40 00')
    expect(disassemble(whole, 0n)).toMatchObject([
        { length: 7, text: 'mov eax, [0x401000]', isInvalid: false, isTruncated: false }
    ])
    const [cut] = disassemble(whole.subarray(0, 3), 0n)
    expect(cut).toMatchObject({
        length: 1,
        mnemonic: 'db',
        text: 'db 0x8b',
        isInvalid: true,
        isTruncated: true
    })
    // push es does not exist in 64-bit mode, however many bytes follow it.
    expect(disassemble(hex('06 90'), 0n)[0]).toMatchObject({
        text: 'db 0x06',
        isInvalid: true,
        isTruncated: false
    })
})

it('spells every condition as NASM does, in the mnemonic and in the text', () => {
    const conditions = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a']
    conditions.push('s', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g')
    conditions.forEach((condition, code) => {
        const [jump, set, move] = [
            disassemble(Uint8Array.of(0x70 + code, 0), 0x401000n)[0]!,
            disassemble(Uint8Array.of(0x0f, 0x90 + code, 0xc0), 0n)[0]!,
            disassemble(Uint8Array.of(0x0f, 0x40 + code, 0xc1), 0n)[0]!
        ]
        expect([jump.mnemonic, jump.text]).toEqual([`j${condition}`, `j${condition} 0x401002`])
        expect([set.mnemonic, set.text]).toEqual([`set${condition}`, `set${condition} al`])
        expect([move.mnemonic, move.text]).toEqual([
            `cmov${condition}`,
            `cmov${condition} eax, ecx`
        ])
        expect(disassemble(Uint8Array.of(0x0f, 0x80 + code, 0, 0, 0, 0), 0n)[0]!.mnemonic).toBe(
            `j${condition}`
        )
    })
    // Loops and jrcxz/jecxz keep their one spelling.
    expect(textOf('e2 00 e1 00 e0 00 e3 00 67 e3 00', 0n)).toEqual([
        'loop 0x2',
        'loope 0x4',
        'loopne 0x6',
        'jrcxz 0x8',
        'jecxz 0xb'
    ])
})

it('prints a size on every memory operand whose size no other operand implies', () => {
    expect(
        textOf(
            '48 f7 7d f8 d9 00 dd 00 db 28 df 00 db 00 df 28 ff 00 48 ff 08 f6 18 48 f7 10 f7 20 ' +
                '8f 00 ff 30 ff 10 ff 20 f0 ff 00 dd 18 db 18 df 38 0f 94 00 f2 0f 38 f1 00 ' +
                'f2 48 0f 2a 00 48 0f b6 00'
        )
    ).toEqual([
        'idiv qword [rbp-0x08]',
        'fld dword [rax]',
        'fld qword [rax]',
        'fld tword [rax]',
        'fild word [rax]',
        'fild dword [rax]',
        'fild qword [rax]',
        'inc dword [rax]',
        'dec qword [rax]',
        'neg byte [rax]',
        'not qword [rax]',
        'mul dword [rax]',
        'pop qword [rax]',
        'push qword [rax]',
        'call qword [rax]',
        'jmp qword [rax]',
        'lock inc dword [rax]',
        'fstp qword [rax]',
        'fistp dword [rax]',
        'fistp qword [rax]',
        'sete byte [rax]',
        'crc32 eax, dword [rax]',
        'cvtsi2sd xmm0, qword [rax]',
        'movzx rax, byte [rax]'
    ])
    // Implied by the other operand, or an address rather than an access.
    expect(textOf('48 8b 00 0f 29 45 80 48 8d 04 08 0f 1f 00')).toEqual([
        'mov rax, [rax]',
        'movaps [rbp-0x80], xmm0',
        'lea rax, [rax+rcx*1]',
        'nop dword [rax]'
    ])
})

it('prints NASM text for forms Zydis spells differently', () => {
    expect(
        textOf(
            '0f 1f 40 00 66 0f 1f 44 00 00 66 2e 0f 1f 84 00 00 00 00 00 0f 1f c0 ' +
                'ff 18 48 ff 18 ff 28 ca 08 00 cb 48 cb 66 6a 10 6a 10 66 9c 66 cf ' +
                'd8 c1 dc c1 de c1 dc e9 df e9 da c1 dd e9 ' +
                '62 f1 74 18 58 c2 62 f1 74 19 c2 c2 01 c4 e2 70 50 00 ' +
                '48 a1 00 10 00 80 00 00 00 00 64 48 8b 04 25 28 00 00 00'
        )
    ).toEqual([
        // nop's register operand is the reg field NASM leaves at 0; an ignored cs: stays.
        'nop dword [rax]',
        'nop word [rax+rax*1]',
        'nop word cs:[rax+rax*1]',
        'nop eax',
        // Far pointers are sized by their offset, m16:32 and m16:64.
        'call far dword [rax]',
        'call far qword [rax]',
        'jmp far dword [rax]',
        'retf 0x08',
        'retf',
        'retfq',
        // The 16-bit push and flags forms, which NASM's plain names would make 64-bit.
        'push word 0x10',
        'push 0x10',
        'pushfw',
        'iretw',
        // x87 register forms name the register the instruction encodes.
        'fadd st1',
        'fadd to st1',
        'faddp st1',
        'fsub to st1',
        'fucomip st1',
        'fcmovb st1',
        'fucomp st1',
        // Rounding and {sae} are an operand of their own; AVX-VNNI-INT8 asks for VEX.
        'vaddps zmm0, zmm1, zmm2, {rn-sae}',
        'vcmpps k0 {k1}, zmm1, zmm2, {sae}, 0x01',
        '{vex} vpdpbuud xmm0, xmm1, [rax]',
        // A moffs address a sign-extended dword cannot hold is written as a qword.
        'mov rax, [qword 0x80001000]',
        'mov rax, fs:[0x28]'
    ])
})

it('prints NASM memory sizes without ptr and decodes all of libc text', () => {
    expect(disassemble(Uint8Array.of(0x80, 0x38, 0x01), 0n)[0].text).toBe('cmp byte [rax], 0x01')
    const bytes = new Uint8Array(
        readFileSync(new URL('../src/assets/linux/libc.so.6', import.meta.url))
    )
    const section = analyze(bytes).sections.find((s) => s.name === '.text')!
    const start = performance.now()
    const instructions = disassemble(
        bytes.subarray(section.offset, section.offset + section.size),
        section.address
    )
    console.log(
        `libc decode: ${instructions.length} instructions, ${(performance.now() - start).toFixed(1)} ms`
    )
    expect(instructions.reduce((total, i) => total + i.length, 0)).toBe(section.size)
    expect(instructions.filter((i) => i.isInvalid)).toEqual([])
})

it('assembles a short branch at a 47-bit address and gives a useful assembly error', async () => {
    const result = await assembleInstruction('je 0x555555555170', 0x555555555160n)
    expect(result).toEqual({ bytes: Uint8Array.of(0x74, 0x0e) })
    expect(await assembleInstruction('not_an_instruction', 0n)).toHaveProperty('error')
})
