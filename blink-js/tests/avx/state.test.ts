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
            expect(emulator.getFpuState().ymm[5]! >> 128n).toBe((WIDE ^ (0xffn << 200n)) >> 128n)
        } finally {
            emulator.dispose()
        }
    })
})
