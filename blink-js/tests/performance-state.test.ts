import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'

const SOURCE = `bits 64
global _start
section .text
_start:
    mov rbx, 1
    inc rbx
    mov rax, 60
    xor rdi, rdi
    syscall
`

describe('fast debugger state transfers', () => {
    it('agrees with the bridge across stepping, poking, undo and fallback reads', async () => {
        const emulator = await createX86Emulator()
        try {
            const { module, runtime } = emulator
            expect(module._blinkenlib_get_register_snapshot).toBeTypeOf('function')
            expect(module._blinkenlib_get_fpu_snapshot).toBeTypeOf('function')
            expect(runtime.getRegisterSnapshot()).toEqual(module.blinkenlibGetRegisterSnapshot())
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.initialize(16)
            emulator.getNextInstruction()
            const check = () => {
                expect(runtime.getRegisterSnapshot()).toEqual(
                    module.blinkenlibGetRegisterSnapshot()
                )
                expect(runtime.getFpuStateRaw()).toEqual(module.blinkenlibGetFpuState())
                expect(runtime.getPc()).toBe(module.blinkenlibGetRegisterSnapshot().pc)
                expect(runtime.getFlags()).toBe(
                    BigInt(module.blinkenlibGetRegisterSnapshot().flags)
                )
            }
            check()
            await emulator.step()
            check()
            const before = runtime.getRegisterSnapshot()
            const fpuBefore = runtime.getFpuStateRaw()
            emulator.beginPoke()
            emulator.setRegisterValue('r8', 0xfedcba9876543210n)
            const fpu = emulator.getFpuState()
            fpu.xmm[0] = 0x123456789abcdef0123456789abcdef0n
            emulator.setFpuState(fpu)
            emulator.endPoke()
            check()
            expect(before.registers.r8).toBe(0n)
            expect(fpuBefore).not.toEqual(runtime.getFpuStateRaw())
            emulator.undo()
            check()
            expect(runtime.getRegisterSnapshot()).toEqual(before)
            expect(runtime.getFpuStateRaw()).toEqual(fpuBefore)

            const exports = [
                module._blinkenlib_get_register_snapshot,
                module._blinkenlib_get_fpu_snapshot,
                module._blinkenlib_get_pc,
                module._blinkenlib_get_flags
            ] as const
            try {
                module._blinkenlib_get_register_snapshot = undefined
                module._blinkenlib_get_fpu_snapshot = undefined
                module._blinkenlib_get_pc = undefined
                module._blinkenlib_get_flags = undefined
                check()
                await emulator.step()
                check()
                emulator.undo()
                expect(runtime.getRegisterSnapshot()).toEqual(before)
            } finally {
                ;[
                    module._blinkenlib_get_register_snapshot,
                    module._blinkenlib_get_fpu_snapshot,
                    module._blinkenlib_get_pc,
                    module._blinkenlib_get_flags
                ] = exports
            }
        } finally {
            emulator.dispose()
        }
    })

    it('reacquires the heap after growth and keeps prior snapshots independent', async () => {
        const emulator = await createX86Emulator()
        try {
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.initialize(16)
            await emulator.step()
            const before = emulator.runtime.getRegisterSnapshot()
            const fpuBefore = emulator.runtime.getFpuStateRaw()
            const native = emulator.module.wasmExports as unknown as {
                memory: WebAssembly.Memory
                malloc(size: number): number
                free(pointer: number): void
            }
            const buffer = native.memory.buffer
            // Use the allocator so Emscripten also refreshes its own heap views.
            const pointer = native.malloc(buffer.byteLength)
            expect(pointer).not.toBe(0)
            expect(native.memory.buffer).not.toBe(buffer)
            try {
                expect(emulator.runtime.getRegisterSnapshot()).toEqual(before)
                expect(emulator.runtime.getFpuStateRaw()).toEqual(fpuBefore)
                await emulator.step()
                expect(emulator.runtime.getRegisterSnapshot()).toEqual(
                    emulator.module.blinkenlibGetRegisterSnapshot()
                )
                emulator.undo()
                expect(emulator.runtime.getRegisterSnapshot()).toEqual(before)
                expect(emulator.runtime.getFpuStateRaw()).toEqual(fpuBefore)
            } finally {
                native.free(pointer)
            }
        } finally {
            emulator.dispose()
        }
    })

    it('returns the same disassembly on demand as the eager legacy listing after steps and undo', async () => {
        const emulator = await createX86Emulator()
        try {
            const deferred = emulator.module._blinkenlib_set_deferred_disassembly!
            expect(deferred).toBeTypeOf('function')
            expect((await emulator.compile(SOURCE)).ok).toBe(true)
            emulator.initialize(16)
            emulator.getNextInstruction()
            for (let i = 0; i < 3; i++) {
                deferred(true)
                await emulator.step()
                const lazy = emulator.module.blinkenlibGetDisassembly()
                deferred(false)
                expect(emulator.module.blinkenlibGetDisassembly()).toEqual(lazy)
            }
            deferred(true)
            emulator.undo()
            const afterUndo = emulator.module.blinkenlibGetDisassembly()
            deferred(false)
            expect(emulator.module.blinkenlibGetDisassembly()).toEqual(afterUndo)
        } finally {
            emulator.dispose()
        }
    })
})
