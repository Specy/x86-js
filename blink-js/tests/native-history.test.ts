import { describe, expect, it, vi } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { EmulatorStatus } from '../src/interface'

async function build(source: string, capacity = 100, nativeHistory = true): Promise<X86Emulator> {
    const emulator = await createX86Emulator({ nativeHistory })
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    emulator.getNextInstruction()
    return emulator
}
const PREFIX = 'bits 64\nglobal _start\nsection .text\n_start:\n'

describe('native undo recording', () => {
    it('matches JavaScript history, CPU, FPU, memory and calls through batches and undo', async () => {
        const source =
            PREFIX +
            `
pcmpeqd xmm1, xmm1
fld1
loop:
call worker
inc rbx
mov [rel cell], rbx
mov rdx, [rel cell]
paddq xmm0, xmm1
fchs
jmp loop
worker:
pxor xmm2, xmm0
ret
section .data
cell: dq 0
`
        const native = await build(source)
        const legacy = await build(source, 100, false)
        const check = () => {
            expect(native.runtime.getRegisterSnapshot()).toEqual(
                legacy.runtime.getRegisterSnapshot()
            )
            expect(native.runtime.getFpuStateRaw()).toEqual(legacy.runtime.getFpuStateRaw())
            expect(native.getCallStack()).toEqual(legacy.getCallStack())
            expect(native.getUndoHistory(100)).toEqual(legacy.getUndoHistory(100))
            expect(native.getFlags()).toEqual(legacy.getFlags())
        }
        try {
            for (const instructions of [3, 1, 7, 1, 25]) {
                await native.run(instructions)
                await legacy.run(instructions)
                check()
            }
            for (let i = 0; i < 37; i++) {
                native.undo()
                legacy.undo()
                check()
            }
            expect(native.canUndo()).toBe(false)
        } finally {
            native.dispose()
            legacy.dispose()
        }
    })

    it('records inside WASM without JavaScript snapshots, disassembly or per-instruction bridge calls', async () => {
        const emulator = await build(PREFIX + 'inc rbx\njmp _start\n', 3)
        const methods = [
            'getRegisterSnapshot',
            'getFpuStateRaw',
            'getInstructionAt',
            'getLastStepInfo',
            'step'
        ] as const
        const spies = methods.map((method) => vi.spyOn(emulator.runtime, method))
        const slices = vi.spyOn(emulator.runtime, 'runSlice')
        try {
            await emulator.run(100005)
            for (const spy of spies) expect(spy).not.toHaveBeenCalled()
            expect(slices).toHaveBeenCalledTimes(3)
            expect(emulator.stopReason?.executedInstructions).toBe(100005n)
            expect(emulator.getRegisterValue('rbx')).toBe(50003n)
            expect(emulator.getUndoHistory(10)).toHaveLength(3)
            for (let i = 0; i < 3; i++) emulator.undo()
            expect(emulator.getRegisterValue('rbx')).toBe(50001n)
            expect(emulator.canUndo()).toBe(false)
            await emulator.step()
            expect(emulator.getRegisterValue('rbx')).toBe(50002n)
        } finally {
            vi.restoreAllMocks()
            emulator.dispose()
        }
    })

    it('preserves caller frames after history eviction and restores returned frames on undo', async () => {
        const emulator = await build(
            PREFIX + 'call outer\nnop\nouter:\ncall inner\nret\ninner:\nnop\nnop\nret\n',
            2
        )
        try {
            await emulator.run(4)
            expect(emulator.getCallStack().map((frame) => frame.name)).toEqual(['outer', 'inner'])
            const frames = emulator.getCallStack()
            await emulator.step()
            expect(emulator.getCallStack().map((frame) => frame.name)).toEqual(['outer'])
            emulator.undo()
            expect(emulator.getCallStack()).toEqual(frames)
            emulator.undo()
            expect(emulator.getCallStack()).toEqual(frames)
        } finally {
            emulator.dispose()
        }
    })

    it('keeps postimages from the instruction that wrote them and refreshes heap views after growth', async () => {
        const emulator = await build(
            PREFIX +
                'lea rbx, [rel cell]\nmov byte [rbx], 42\nmov byte [rbx], 99\njmp _start\nsection .data\ncell: db 1\n'
        )
        try {
            await emulator.run(3)
            const exports = emulator.module.wasmExports as unknown as {
                memory: WebAssembly.Memory
                malloc(size: number): number
                free(p: number): void
            }
            const originalBuffer = exports.memory.buffer
            const pointer = exports.malloc(originalBuffer.byteLength)
            expect(pointer).not.toBe(0)
            try {
                expect(exports.memory.buffer).not.toBe(originalBuffer)
                const history = emulator.getUndoHistory(3)
                expect(history[0]?.mutations).toContainEqual({
                    type: 'WriteMemoryBytes',
                    value: { address: emulator.getRegisterValue('rbx'), old: [42], new: [99] }
                })
                expect(history[1]?.mutations).toContainEqual({
                    type: 'WriteMemoryBytes',
                    value: { address: emulator.getRegisterValue('rbx'), old: [1], new: [42] }
                })
                emulator.undo()
                expect([...emulator.readMemoryBytes(emulator.getRegisterValue('rbx'), 1n)]).toEqual(
                    [42]
                )
            } finally {
                exports.free(pointer)
            }
        } finally {
            emulator.dispose()
        }
    })

    it('finishes a paused read as one undoable instruction and checks the next breakpoint', async () => {
        const source =
            PREFIX +
            'xor eax, eax\nxor edi, edi\nlea rsi, [rel buffer]\nmov edx, 8\nsyscall\ninc rbx\njmp _start\nsection .data\nbuffer: dq 0x0102030405060708\n'
        const emulator = await build(source)
        try {
            expect(await emulator.run(20, [source.split('\n').indexOf('inc rbx')])).toBe(
                EmulatorStatus.WaitingForInput
            )
            const before = emulator.runtime.getRegisterSnapshot()
            const address = emulator.getRegisterValue('rsi')
            const old = [...emulator.readMemoryBytes(address, 8n)]
            expect(emulator.getUndoHistory(100)).toHaveLength(4)
            emulator.provideInput('ab\n')
            expect(emulator.getRegisterValue('rax')).toBe(3n)
            expect(emulator.getRegisterValue('rbx')).toBe(0n)
            expect(emulator.getUndoHistory(100)).toHaveLength(5)
            await emulator.run(20, [source.split('\n').indexOf('inc rbx')], {
                skipBreakpointAtPc: false
            })
            expect(emulator.stopReason?.kind).toBe('breakpoint')
            expect(emulator.getRegisterValue('rbx')).toBe(0n)
            emulator.undo()
            expect(emulator.runtime.getRegisterSnapshot()).toEqual(before)
            expect([...emulator.readMemoryBytes(address, 8n)]).toEqual(old)
        } finally {
            emulator.dispose()
        }
    })

    it('retains arbitrary host Pokes including more than sixteen disjoint memory ranges', async () => {
        const emulator = await build(PREFIX + 'nop\njmp _start\n')
        try {
            const address = emulator.getSp()
            const original = emulator.readMemoryBytes(address, 64n)
            emulator.beginPoke()
            for (let i = 0; i < 20; i++)
                emulator.writeMemoryBytes(
                    address + BigInt(i * 2),
                    Uint8Array.of(original[i * 2]! ^ 255)
                )
            expect(emulator.endPoke()).toBe(true)
            expect(emulator.getUndoHistory(1)[0]?.writes).toHaveLength(20)
            emulator.undo()
            expect(emulator.readMemoryBytes(address, 64n)).toEqual(original)
        } finally {
            emulator.dispose()
        }
    })

    it('clears a native trace on reinitialize and rebuild', async () => {
        const emulator = await build(PREFIX + 'inc rbx\njmp _start\n')
        try {
            await emulator.run(20)
            emulator.initialize(2)
            expect(emulator.canUndo()).toBe(false)
            await emulator.run(20)
            expect(emulator.getUndoHistory(100)).toHaveLength(2)
            expect((await emulator.compile(PREFIX + 'inc rcx\njmp _start\n')).ok).toBe(true)
            expect(emulator.getUndoHistory(100)).toEqual([])
            await emulator.step()
            expect(emulator.getRegisterValue('rcx')).toBe(1n)
        } finally {
            emulator.dispose()
        }
    })

    it('allows later instructions to fault in new pages after recording a store', async () => {
        const source = PREFIX + 'push rbx\ninc rbx\njmp _start\n'
        const native = await build(source, 8)
        const legacy = await build(source, 8, false)
        try {
            const initialSp = native.getSp()
            await native.run(3000)
            await legacy.run(3000)
            expect(native.getSp()).toBe(initialSp - 8000n)
            expect(native.runtime.getRegisterSnapshot()).toEqual(
                legacy.runtime.getRegisterSnapshot()
            )
            expect(native.getUndoHistory(8)).toEqual(legacy.getUndoHistory(8))
            for (let i = 0; i < 8; i++) {
                native.undo()
                legacy.undo()
            }
            expect(native.runtime.getRegisterSnapshot()).toEqual(
                legacy.runtime.getRegisterSnapshot()
            )
        } finally {
            native.dispose()
            legacy.dispose()
        }
    })

    it.each([true, false])(
        'reports and undoes an MXCSR Poke (native=%s)',
        async (nativeHistory) => {
            const emulator = await build(PREFIX + 'nop\njmp _start\n', 10, nativeHistory)
            try {
                const before = emulator.getFpuState()
                emulator.beginPoke()
                emulator.setFpuState({ ...before, mxcsr: before.mxcsr ^ 0x2000 })
                expect(emulator.endPoke()).toBe(true)
                expect(emulator.getUndoHistory(1)[0]?.writes).toContainEqual({
                    type: 'register',
                    name: 'mxcsr',
                    old: BigInt(before.mxcsr),
                    new: BigInt(before.mxcsr ^ 0x2000)
                })
                emulator.undo()
                expect(emulator.getFpuState()).toEqual(before)
            } finally {
                emulator.dispose()
            }
        }
    )
})
