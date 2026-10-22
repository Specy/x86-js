// The upper halves of the vector registers through the JavaScript API: reading them, the register
// writes a step reports, undo, and presetting them.
import { describe, expect, it } from 'vitest'
import { RegisterSize, type MutationOperation } from '../../src/interface'
import { createX86Emulator } from '../../src/x86-emulator'

const PROGRAM = `
bits 64
global _start
section .data
align 32
v: dq 1, 2, 3, 4
section .text
_start:
vmovdqu ymm0, [rel v]
vpaddq ymm1, ymm0, ymm0
vzeroupper
mov eax, 60
xor edi, edi
syscall
`
const WIDE = (4n << 192n) | (3n << 128n) | (2n << 64n) | 1n

function writes(mutations: MutationOperation[]): Map<string, { old: bigint; new: bigint; size: RegisterSize }> {
    const result = new Map<string, { old: bigint; new: bigint; size: RegisterSize }>()
    for (const mutation of mutations) {
        if (mutation.type === 'WriteRegister') result.set(mutation.value.register, mutation.value)
    }
    return result
}

describe('ymm registers', () => {
    it('reads, records, undoes and presets the upper halves', async () => {
        const emulator = await createX86Emulator()
        try {
            const result = await emulator.compile(PROGRAM)
            expect(result.ok, result.report).toBe(true)
            emulator.initialize(8)

            await emulator.step()
            expect(emulator.getFpuState().ymm[0]).toBe(WIDE)
            expect(emulator.getFpuState().xmm[0]).toBe((2n << 64n) | 1n)
            const load = writes(emulator.getUndoHistory(1)[0]!.mutations).get('ymm0')
            expect(load).toEqual({ register: 'ymm0', old: 0n, new: WIDE, size: RegisterSize.Oct })

            await emulator.step()
            expect(emulator.getFpuState().ymm[1]).toBe(WIDE * 2n)
            expect(writes(emulator.getUndoHistory(1)[0]!.mutations).get('ymm1')?.new).toBe(WIDE * 2n)

            await emulator.step()
            expect(emulator.getFpuState().ymm[0]).toBe(WIDE & ((1n << 128n) - 1n))
            expect(emulator.getFpuState().ymm[1]).toBe((WIDE * 2n) & ((1n << 128n) - 1n))

            emulator.undo()
            expect(emulator.getFpuState().ymm[0]).toBe(WIDE)
            expect(emulator.getFpuState().ymm[1]).toBe(WIDE * 2n)
            emulator.undo()
            expect(emulator.getFpuState().ymm[1]).toBe(0n)
            emulator.undo()
            expect(emulator.getFpuState().ymm[0]).toBe(0n)

            await emulator.step()
            const state = emulator.getFpuState()
            state.ymm[5] = WIDE ^ (0xffn << 200n)
            emulator.setFpuState(state)
            expect(emulator.getFpuState().ymm[5]).toBe(WIDE ^ (0xffn << 200n))
            expect(emulator.getFpuState().xmm[5]).toBe(WIDE & ((1n << 128n) - 1n))

            // a preset of the low half alone keeps the upper half
            const low = emulator.getFpuState()
            low.xmm[5] = 7n
            low.ymm[5] = emulator.getFpuState().ymm[5]!
            emulator.setFpuState(low)
            expect(emulator.getFpuState().xmm[5]).toBe(7n)
            expect(emulator.getFpuState().ymm[5]).toBe((((WIDE ^ (0xffn << 200n)) >> 128n) << 128n) | 7n)
        } finally {
            emulator.dispose()
        }
    })

    it('records aligned 128-bit stores, so undo puts the bytes back', async () => {
        const emulator = await createX86Emulator()
        try {
            const result = await emulator.compile(`
bits 64
global _start
section .bss
alignb 32
buffer: resb 64
section .text
_start:
lea rbx, [rel buffer]
vpcmpeqd ymm1, ymm1, ymm1
movdqa [rbx], xmm1
vmovdqa [rbx + 16], xmm1
vmovntdq [rbx + 32], ymm1
mov eax, 60
xor edi, edi
syscall
`)
            expect(result.ok, result.report).toBe(true)
            emulator.initialize(8)
            await emulator.step()
            await emulator.step()
            const buffer = emulator.getRegisterValue('rbx')
            for (const [offset, size] of [[0, 16], [16, 16], [32, 32]] as const) {
                await emulator.step()
                const stores = emulator.getUndoHistory(1)[0]!.mutations.filter((m) => m.type !== 'WriteRegister')
                expect(stores.length, `the store at +${offset}`).toBeGreaterThan(0)
                expect([...emulator.readMemoryBytes(buffer + BigInt(offset), BigInt(size))].every((b) => b === 0xff)).toBe(true)
            }
            emulator.undo()
            emulator.undo()
            emulator.undo()
            expect([...emulator.readMemoryBytes(buffer, 64n)].every((b) => b === 0)).toBe(true)
        } finally {
            emulator.dispose()
        }
    })
})
