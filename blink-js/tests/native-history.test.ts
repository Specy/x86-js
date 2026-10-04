import { describe, expect, it, vi } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { BlinkRuntime } from '../src/blink-runtime'
import { EmulatorStatus, RegisterSize, type ExecutionStep } from '../src/interface'

async function build(source: string, capacity = 100): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    emulator.getNextInstruction()
    return emulator
}
const PREFIX = 'bits 64\nglobal _start\nsection .text\n_start:\n'

describe('native undo recording', () => {
    it('records the same history, CPU, FPU, memory and calls in batches as step by step, through undo', async () => {
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
        // A batch runs in a native slice and a step on its own: the two record
        // through the same journal, and have to leave the same trace.
        const batched = await build(source)
        const stepped = await build(source)
        const check = () => {
            expect(batched.runtime.getRegisterSnapshot()).toEqual(
                stepped.runtime.getRegisterSnapshot()
            )
            expect(batched.runtime.getFpuStateRaw()).toEqual(stepped.runtime.getFpuStateRaw())
            expect(batched.getCallStack()).toEqual(stepped.getCallStack())
            expect(batched.getUndoHistory(100)).toEqual(stepped.getUndoHistory(100))
            expect(batched.getFlags()).toEqual(stepped.getFlags())
        }
        try {
            for (const instructions of [3, 1, 7, 1, 25]) {
                await batched.run(instructions)
                for (let i = 0; i < instructions; i++) await stepped.step()
                check()
            }
            // Two set-up instructions and nine a loop: four calls made and
            // returned from, stopped on the `jmp` that closes the fourth loop.
            expect(batched.getUndoHistory(100)).toHaveLength(37)
            expect(batched.getRegisterValue('rbx')).toBe(4n)
            expect(batched.getCallStack()).toEqual([])
            expect(batched.getNextInstruction()?.code).toContain('jmp')
            // Six undone - fchs, paddq, both movs, inc and the ret - and the
            // program is back inside the worker's frame, before its `ret`.
            for (let i = 0; i < 6; i++) {
                batched.undo()
                stepped.undo()
                check()
            }
            expect(batched.getCallStack().map((frame) => frame.name)).toEqual(['worker'])
            expect(batched.getNextInstruction()?.code).toContain('ret')
            for (let i = 0; i < 31; i++) {
                batched.undo()
                stepped.undo()
                check()
            }
            expect(batched.canUndo()).toBe(false)
            expect(batched.getRegisterValue('rbx')).toBe(0n)
            expect(batched.getFpuState().xmm[1]).toBe(0n)
        } finally {
            batched.dispose()
            stepped.dispose()
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
            expect(await emulator.run(4)).toBe(EmulatorStatus.Running)
            // Save the state before SYSCALL starts: the paused read already
            // contains its architectural RCX/R11 clobbers, which undo restores.
            const before = emulator.runtime.getRegisterSnapshot()
            expect(await emulator.run(20, [source.split('\n').indexOf('inc rbx')])).toBe(
                EmulatorStatus.WaitingForInput
            )
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
        const emulator = await build(source, 8)
        const word = (value: bigint) => {
            const bytes = new Uint8Array(8)
            new DataView(bytes.buffer).setBigUint64(0, value, true)
            return [...bytes]
        }
        try {
            const initialSp = emulator.getSp()
            // A thousand pushes, eight bytes apiece: the stack grows down two
            // pages, each faulted in by a push after an earlier one was recorded.
            await emulator.run(3000)
            expect(emulator.getSp()).toBe(initialSp - 8000n)
            expect(emulator.getRegisterValue('rbx')).toBe(1000n)
            expect([...emulator.readMemoryBytes(initialSp - 8000n, 8n)]).toEqual(word(999n))
            expect(emulator.getUndoHistory(8)).toHaveLength(8)
            for (let i = 0; i < 8; i++) emulator.undo()
            // Back before the last three loops' `inc`, `jmp` and `push`: the two
            // newest pushes undone, the one before them kept.
            expect(emulator.getRegisterValue('rbx')).toBe(997n)
            expect(emulator.getSp()).toBe(initialSp - 7984n)
            expect([...emulator.readMemoryBytes(initialSp - 8000n, 16n)]).toEqual(Array(16).fill(0))
            expect([...emulator.readMemoryBytes(initialSp - 7984n, 8n)]).toEqual(word(997n))
            expect(emulator.canUndo()).toBe(false)
        } finally {
            emulator.dispose()
        }
    })

    it('reports and undoes an MXCSR Poke, naming mxcsr once', async () => {
        const emulator = await build(PREFIX + 'nop\njmp _start\n', 10)
        try {
            const before = emulator.getFpuState()
            emulator.beginPoke()
            emulator.setFpuState({ ...before, mxcsr: before.mxcsr ^ 0x2000 })
            expect(emulator.endPoke()).toBe(true)
            const [poke] = emulator.getUndoHistory(1)
            expect(poke?.writes).toEqual([
                {
                    type: 'register',
                    name: 'mxcsr',
                    old: BigInt(before.mxcsr),
                    new: BigInt(before.mxcsr ^ 0x2000)
                }
            ])
            expect(mxcsrWrites(poke)).toHaveLength(1)
            emulator.undo()
            expect(emulator.getFpuState()).toEqual(before)
        } finally {
            emulator.dispose()
        }
    })

    it('reports an instruction that loads MXCSR as one write of mxcsr', async () => {
        const emulator = await build(PREFIX + 'push 0x9fc0\nldmxcsr [rsp]\nnop\n', 10)
        try {
            const before = emulator.getFpuState().mxcsr
            await emulator.step() // push
            await emulator.step() // ldmxcsr
            expect(mxcsrWrites(emulator.getUndoHistory(1)[0])).toEqual([
                {
                    type: 'WriteRegister',
                    value: { register: 'mxcsr', old: BigInt(before), new: 0x9fc0n, size: RegisterSize.Long }
                }
            ])
            emulator.undo()
            expect(emulator.getFpuState().mxcsr).toBe(before)
        } finally {
            emulator.dispose()
        }
    })

    it.each([
        ['no history at all', undefined, 'records no undo history'],
        ['history of another version', 2, 'records undo history version 2'],
    ])('refuses a wasm with %s when the emulator is created', async (_, version, message) => {
        const create = BlinkRuntime.create.bind(BlinkRuntime)
        vi.spyOn(BlinkRuntime, 'create').mockImplementationOnce(async (options) => {
            const runtime = await create(options)
            runtime.module._blinkenlib_history_version =
                version === undefined ? undefined : () => version
            return runtime
        })
        try {
            // An emulator that was created anyway is disposed, not formatted:
            // printing one drags the whole wasm heap into the failure message.
            const outcome = await createX86Emulator().then(
                (emulator) => {
                    emulator.dispose()
                    return 'created'
                },
                (error: unknown) => String(error)
            )
            expect(outcome).toContain(message)
        } finally {
            vi.restoreAllMocks()
        }
    })
})

/** The writes of mxcsr a history entry reports, as mutations. */
function mxcsrWrites(step: ExecutionStep | undefined) {
    return (step?.mutations ?? []).filter(
        (mutation) => mutation.type === 'WriteRegister' && mutation.value.register === 'mxcsr'
    )
}
