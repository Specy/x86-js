import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { analyze, disassemble } from '../src/disassembler'
import { assembleInstruction } from '../src/wasm-assembler'

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
