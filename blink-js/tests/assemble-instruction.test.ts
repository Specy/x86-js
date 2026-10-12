import { describe, expect, it } from 'vitest'
import { loadDisassembler } from '../src/disassembler'
import { assembleInstruction, assembleInstructions } from '../src/wasm-assembler'

const { disassemble } = await loadDisassembler()

const hex = (text: string) => Uint8Array.from(text.split(' ').map((b) => parseInt(b, 16)))

async function bytesOf(text: string, address: bigint) {
    const result = await assembleInstruction(text, address)
    if ('error' in result) throw new Error(`${text}: ${result.error}`)
    return result.bytes
}

async function errorOf(text: string, address = 0x401000n) {
    const result = await assembleInstruction(text, address)
    if (!('error' in result)) throw new Error(`${text} assembled`)
    // Read in a UI: no NASM file, line, severity or warning class.
    expect(result.error).not.toMatch(/instructions\.asm|^(?:error|warning|fatal|panic):|\[-w/)
    return result.error
}

describe('RIP-relative operands', () => {
    it('encode [rel <absolute target>] relative to the instruction, as the decoder prints it', async () => {
        const bytes = await bytesOf('cmp byte [rel 0x4018], 0x00', 0x1000n)
        expect(bytes).toEqual(hex('80 3d 11 30 00 00 00'))
        expect(disassemble(bytes, 0x1000n)[0]!.text).toBe('cmp byte [rel 0x4018], 0x00')
        expect(await bytesOf('lea rdi, [rel 0x401017]', 0x401000n)).toEqual(
            hex('48 8d 3d 10 00 00 00')
        )
    })

    it('take a target written as an address plus or minus an offset, in hex or decimal', async () => {
        const at = 0x401000n
        const expected = await bytesOf('mov eax, [rel 0x404018]', at)
        for (const text of [
            'mov eax, [rel 0x404000+0x18]',
            'mov eax, [rel 0x404020 - 0x8]',
            'mov eax, [rel 4210712]',
            'mov eax, [rel 4210688+24]'
        ])
            expect(await bytesOf(text, at)).toEqual(expected)
    })

    it('keep a segment written before the bracket or inside it', async () => {
        const at = 0x401000n
        const bytes = await bytesOf('mov rax, fs:[rel 0x401100]', at)
        expect(bytes).toEqual(hex('64 48 8b 05 f8 00 00 00'))
        expect(await bytesOf('mov rax, [fs:rel 0x401100]', at)).toEqual(bytes)
        expect(disassemble(bytes, at)[0]!.text).toBe('mov rax, fs:[rel 0x401100]')
        const store = await bytesOf('mov qword gs:[rel 0x401100], 0x00', at)
        expect(disassemble(store, at)[0]!.text).toBe('mov qword gs:[rel 0x401100], 0x00')
        // 64-bit mode ignores cs:, but the bytes keep it, and so do the text and the encoding.
        const ignored = await bytesOf('mov eax, cs:[rel 0x401100]', at)
        expect(ignored).toEqual(hex('2e 8b 05 f9 00 00 00'))
        expect(disassemble(ignored, at)[0]!.text).toBe('mov eax, cs:[rel 0x401100]')
    })

    it('refuse a name, which the caller resolves, and a target out of reach', async () => {
        expect(await errorOf('mov rax, [rel counter]')).toBe(
            'Write the target of [rel counter] as an address, such as [rel 0x404010] or [rel 0x404010+0x8]'
        )
        expect(await errorOf('lea rax, [rel 0x7ffff7c80000]', 0x555555555000n)).toBe(
            '0x7ffff7c80000 is out of reach of a 32-bit displacement from 0x555555555000'
        )
    })
})

describe('direct branches', () => {
    it('are short whenever the target is in reach of one, also at 47-bit addresses', async () => {
        expect(await bytesOf('je 0x555555555170', 0x555555555160n)).toEqual(hex('74 0e'))
        expect(await bytesOf('jmp 0x401081', 0x401000n)).toEqual(hex('eb 7f'))
        expect(await bytesOf('jmp 0x401082', 0x401000n)).toEqual(hex('e9 7d 00 00 00'))
        expect(await bytesOf('jne 0x401000-0x10', 0x401000n)).toEqual(hex('75 ee'))
        expect(await bytesOf('call 0x401000', 0x401000n)).toEqual(hex('e8 fb ff ff ff'))
    })

    it('refuse a target out of reach instead of truncating its displacement', async () => {
        expect(await errorOf('call 0x7ffff7c80000', 0x555555555000n)).toBe(
            '0x7ffff7c80000 is out of reach of a 32-bit displacement from 0x555555555000'
        )
        expect(await errorOf('loop 0x401200')).toBe(
            '0x401200 is out of reach of a short jump from 0x401000'
        )
    })
})

describe('values NASM would truncate', () => {
    it('are errors, not warnings', async () => {
        expect(await errorOf('add eax, 0x100000000')).toBe('The value does not fit in a dword')
        expect(await errorOf('mov rax, [0x1122334455667788]')).toBe(
            'The displacement does not fit in a dword'
        )
        expect(await errorOf('mov eax, [rax+0xffffffff]')).toBe(
            'The displacement 0xffffffff does not fit in 32 bits'
        )
        expect(await errorOf('mov eax, [rax+rbx*4-0x80000001]')).toBe(
            'The displacement -0x80000001 does not fit in 32 bits'
        )
    })

    it('leave in range values alone', async () => {
        expect(await bytesOf('mov rax, [qword 0x1122334455667788]', 0n)).toEqual(
            hex('48 a1 88 77 66 55 44 33 22 11')
        )
        expect(await bytesOf('mov eax, [rax-0x80000000]', 0n)).toEqual(hex('8b 80 00 00 00 80'))
        expect(await bytesOf('mov eax, [0xffffffff80001000]', 0n)).toEqual(
            hex('8b 04 25 00 10 00 80')
        )
    })
})

describe('a memory operand without a size', () => {
    it('is refused when NASM 3.00 would guess one', async () => {
        expect(await errorOf('add [rax], 1')).toBe(
            'The operation size is not specified: write byte, word, dword or qword before the memory operand'
        )
        expect(await errorOf('fld [rax]')).toBe(
            'The operation size is not specified: write dword, qword or tword before the memory operand'
        )
        expect(await errorOf('push [rax]')).toBe(
            'The operation size is not specified: write word or qword before the memory operand'
        )
        expect(await bytesOf('idiv qword [rbp-0x08]', 0n)).toEqual(hex('48 f7 7d f8'))
    })

    it('is fine when another operand or the instruction gives the size', async () => {
        expect(await bytesOf('mov [rax], eax', 0n)).toEqual(hex('89 00'))
        expect(await bytesOf('sete [rax]', 0n)).toEqual(hex('0f 94 00'))
        expect(await bytesOf('fnstcw [rax]', 0n)).toEqual(hex('d9 38'))
        expect(await bytesOf('call [rax]', 0n)).toEqual(hex('ff 10'))
        expect(await bytesOf('clflush [rax]', 0n)).toEqual(hex('0f ae 38'))
    })
})

describe('text NASM reads differently from what it means', () => {
    it('encodes notrack, which NASM 3.00 accepts and drops', async () => {
        expect(await bytesOf('notrack jmp rax', 0n)).toEqual(hex('3e ff e0'))
        const bytes = await bytesOf('notrack jmp qword [rax*8+0x401000]', 0n)
        expect(disassemble(bytes, 0n)[0]!.text).toBe('notrack jmp qword [rax*8+0x401000]')
    })

    it("encodes cmpxchg's 64-bit and 16-bit forms, which NASM 3.00 encodes as 32-bit", async () => {
        expect(await bytesOf('lock cmpxchg [rdx], rbx', 0n)).toEqual(hex('f0 48 0f b1 1a'))
        expect(await bytesOf('cmpxchg r8w, r9w', 0n)).toEqual(hex('66 45 0f b1 c8'))
        expect(await bytesOf('cmpxchg [rdx], ebx', 0n)).toEqual(hex('0f b1 1a'))
    })

    it('refuses what NASM 3.00 encodes wrongly', async () => {
        expect(await errorOf('kunpckbw k0, k1, k2')).toBe(
            'NASM encodes kunpckbw and kunpckwd wrongly'
        )
        expect(await errorOf('bswap ax')).toBe(
            'bswap of a 16-bit register is undefined, and NASM encodes it as xchg'
        )
    })

    it('keeps an ignored segment prefix written on a nop', async () => {
        const bytes = await bytesOf('nop word cs:[rax+rax*1]', 0n)
        expect(bytes).toEqual(hex('2e 66 0f 1f 04 00'))
        expect(disassemble(bytes, 0n)[0]!.text).toBe('nop word cs:[rax+rax*1]')
    })
})

describe('the text', () => {
    it('is one instruction', async () => {
        expect(await errorOf('')).toBe('Enter one instruction')
        expect(await errorOf('nop\nnop')).toBe('Enter one instruction')
        expect(await errorOf('section .data')).toBe(
            'Enter an instruction, not an assembler directive'
        )
        expect(await errorOf('%define x 1')).toBe(
            'Enter an instruction, not an assembler directive'
        )
        expect(await errorOf('times 16 nop')).toBe(
            'The text encodes more than 15 bytes, the most one instruction can have'
        )
        expect(await errorOf('not_an_instruction')).toBe('not_an_instruction is not an instruction')
        expect(await errorOf('mov eax, ebx, ecx')).toBe(
            'Invalid combination of opcode and operands'
        )
        expect(await bytesOf('nop ; [rel counter]', 0n)).toEqual(hex('90'))
    })
})

it('assembles a batch exactly as it assembles each line alone', async () => {
    const requests = [
        { text: 'je 0x555555555170', address: 0x555555555160n },
        { text: 'add eax, 0x100000000', address: 0x401000n },
        { text: 'cmp byte [rel 0x4018], 0x00', address: 0x1000n },
        { text: 'not_an_instruction', address: 0n },
        { text: 'call 0x7ffff7c80000', address: 0x555555555000n },
        { text: 'nop word cs:[rax+rax*1]', address: 0n },
        { text: 'lock cmpxchg [rdx], rbx', address: 0n }
    ]
    const alone = await Promise.all(requests.map((r) => assembleInstruction(r.text, r.address)))
    expect(await assembleInstructions(requests)).toEqual(alone)
    expect(alone.map((r) => 'bytes' in r)).toEqual([true, false, true, false, false, true, true])
})
