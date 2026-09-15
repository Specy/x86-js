import { describe, expect, it } from 'vitest'
import { RegisterSize, type ExecutionStep, type PokeWrite } from '../src/interface'
import {
    createX86Emulator as createDefaultX86Emulator,
    type X86Emulator,
    type X86EmulatorOptions,
} from '../src/x86-emulator'

const createX86Emulator = (options: X86EmulatorOptions = {}) =>
    createDefaultX86Emulator({ ...options, mode: 'GNU_trunk' })

const COUNTING_PROGRAM = `
.global _start
.text
_start:
  mov $1, %rax
  mov $2, %rax
  mov $3, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`

/** A built emulator paused after `steps` instructions, with a history of `undoSize`. */
async function startedEmulator(
    source = COUNTING_PROGRAM,
    undoSize = 16,
    steps = 1,
): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok).toBe(true)
    emulator.initialize(undoSize)
    for (let step = 0; step < steps; step += 1) await emulator.step()
    return emulator
}

function registerWrites(writes: PokeWrite[] | undefined): Map<string, { old: bigint; new: bigint }> {
    const byName = new Map<string, { old: bigint; new: bigint }>()
    for (const write of writes ?? []) {
        if (write.type === 'register') byName.set(write.name, { old: write.old, new: write.new })
    }
    return byName
}

function memoryWrites(writes: PokeWrite[] | undefined) {
    return (writes ?? []).flatMap((write) => (write.type === 'memory' ? [write] : []))
}

/** The state a Poke must leave alone, so an undo can be checked against it. */
function surroundings(emulator: X86Emulator) {
    return {
        pc: emulator.getPc(),
        flags: emulator.getFlags().map((flag) => `${flag.name}=${flag.value}`).join(','),
        callStack: emulator.getCallStack().map((frame) => frame.name),
        nextInstruction: emulator.getNextInstruction()?.code,
    }
}

describe('x86 poke transactions', () => {
    it('refuses to open a second poke and to end one that was never opened', async () => {
        const emulator = await startedEmulator()

        expect(() => emulator.endPoke()).toThrow(/no poke is open/i)
        emulator.beginPoke()
        expect(() => emulator.beginPoke()).toThrow(/already open/i)
        expect(emulator.isPokeOpen()).toBe(true)
        expect(emulator.endPoke()).toBe(false)
        expect(emulator.isPokeOpen()).toBe(false)
        expect(() => emulator.endPoke()).toThrow(/no poke is open/i)
        emulator.dispose()
    })

    it('refuses to open a poke while an instruction is executing', async () => {
        let thrown: unknown = null
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $1, %rdi
  lea msg(%rip), %rsi
  mov $3, %rdx
  syscall
  mov $60, %rax
  xor %rdi, %rdi
  syscall
msg:
  .ascii "ok\\n"
`)

        expect(result.ok).toBe(true)
        emulator.initialize(16)
        // The write syscall calls back into the host from inside the running
        // instruction, which is exactly the moment a poke must refuse to open.
        emulator.on('stdout', () => {
            try {
                emulator.beginPoke()
            } catch (error) {
                thrown = error
            }
        })

        await emulator.run()

        expect(emulator.stringifyError(thrown)).toMatch(/while an instruction is executing/i)
        expect(emulator.isPokeOpen()).toBe(false)
        emulator.dispose()
    })

    it('leaves the setters direct outside a transaction, as Testcase presets need', async () => {
        const emulator = await startedEmulator()
        const historyBefore = emulator.getUndoHistory(16).length
        const stackPointer = emulator.getSp()
        const originalBytes = emulator.readMemoryBytes(stackPointer, 4n)

        emulator.setRegisterValue('rbx', 0x1234n)
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([1, 2, 3, 4]))
        const state = emulator.getFpuState()
        state.xmm[2] = 7n
        emulator.setFpuState(state)

        expect(emulator.getRegisterValue('rbx')).toBe(0x1234n)
        expect(Array.from(emulator.readMemoryBytes(stackPointer, 4n))).toEqual([1, 2, 3, 4])
        expect(emulator.getFpuState().xmm[2]).toBe(7n)
        expect(emulator.getUndoHistory(16)).toHaveLength(historyBefore)

        emulator.writeMemoryBytes(stackPointer, originalBytes)
        emulator.dispose()
    })

    it('records nothing for a transaction whose writes change no value', async () => {
        const emulator = await startedEmulator()
        const historyBefore = emulator.getUndoHistory(16).length
        const stackPointer = emulator.getSp()
        const currentBytes = emulator.readMemoryBytes(stackPointer, 4n)

        emulator.beginPoke()
        emulator.setRegisterValue('rax', emulator.getRegisterValue('rax'))
        emulator.writeMemoryBytes(stackPointer, currentBytes)
        emulator.setFpuState(emulator.getFpuState())
        expect(emulator.endPoke()).toBe(false)

        expect(emulator.getUndoHistory(16)).toHaveLength(historyBefore)

        // A value written away and back again is the same case.
        const original = emulator.getRegisterValue('rbx')
        emulator.beginPoke()
        emulator.setRegisterValue('rbx', original + 1n)
        emulator.setRegisterValue('rbx', original)
        expect(emulator.endPoke()).toBe(false)
        expect(emulator.getUndoHistory(16)).toHaveLength(historyBefore)
        emulator.dispose()
    })

    it('records nothing for a memory range written away and back inside one poke', async () => {
        const emulator = await startedEmulator()
        const historyBefore = emulator.getUndoHistory(16)
        const stackPointer = emulator.getSp()
        const originalBytes = [...emulator.readMemoryBytes(stackPointer, 4n)]

        emulator.beginPoke()
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]))
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from(originalBytes))
        // The second write is diffed against what memory held BEFORE the poke,
        // not against the bytes the first write left.
        expect(emulator.endPoke()).toBe(false)

        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual(originalBytes)
        expect(emulator.getUndoHistory(16)).toEqual(historyBefore)

        // Nothing was recorded, so the only thing left to undo is the
        // instruction underneath: undoing must never write back a value the
        // machine held only inside the transaction.
        emulator.undo()
        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual(originalBytes)
        emulator.dispose()
    })

    it('records one memory write for two differing writes to the same range', async () => {
        const emulator = await startedEmulator()
        const stackPointer = emulator.getSp()
        const originalBytes = [...emulator.readMemoryBytes(stackPointer, 4n)]

        emulator.beginPoke()
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([1, 1, 1, 1]))
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([2, 2, 2, 2]))
        expect(emulator.endPoke()).toBe(true)

        const entry = emulator.getUndoHistory(16)[0]!
        expect(entry.kind).toBe('poke')
        // One entry for the range, carrying the value the machine really had
        // before the poke - never the [1,1,1,1] that existed only inside it.
        expect(memoryWrites(entry.writes)).toEqual([
            { type: 'memory', address: stackPointer, old: originalBytes, new: [2, 2, 2, 2] },
        ])
        expect(
            entry.mutations.filter((mutation) => mutation.type === 'WriteMemoryBytes'),
        ).toHaveLength(1)

        emulator.undo()
        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual(originalBytes)
        emulator.dispose()
    })

    it('records one entry for a transaction however many writes it holds', async () => {
        const emulator = await startedEmulator()
        const historyBefore = emulator.getUndoHistory(16).length
        const stackPointer = emulator.getSp()
        const originalBytes = [...emulator.readMemoryBytes(stackPointer, 4n)]

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 0x1234n)
        emulator.setRegisterValue('rcx', 0x5678n)
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
        expect(emulator.endPoke()).toBe(true)

        const history = emulator.getUndoHistory(16)
        expect(history).toHaveLength(historyBefore + 1)
        const entry = history[0]!
        expect(entry.kind).toBe('poke')

        const written = registerWrites(entry.writes)
        expect(written.get('rbx')).toEqual({ old: 0n, new: 0x1234n })
        expect(written.get('rcx')).toEqual({ old: 0n, new: 0x5678n })
        expect(memoryWrites(entry.writes)).toEqual([
            { type: 'memory', address: stackPointer, old: originalBytes, new: [0xde, 0xad, 0xbe, 0xef] },
        ])
        emulator.dispose()
    })

    it('names only the FPU registers a setFpuState poke changed', async () => {
        const emulator = await startedEmulator()

        emulator.beginPoke()
        const state = emulator.getFpuState()
        const previous = state.xmm[3]!
        state.xmm[3] = (1n << 100n) | 42n
        emulator.setFpuState(state)
        expect(emulator.endPoke()).toBe(true)

        const entry = emulator.getUndoHistory(1)[0]!
        const written = registerWrites(entry.writes)
        expect([...written.keys()]).toEqual(['xmm3'])
        expect(written.get('xmm3')).toEqual({ old: previous, new: (1n << 100n) | 42n })
        expect(
            entry.mutations.some(
                (mutation) =>
                    mutation.type === 'WriteRegister' &&
                    mutation.value.register === 'xmm3' &&
                    mutation.value.size === RegisterSize.Quad,
            ),
        ).toBe(true)

        emulator.undo()
        expect(emulator.getFpuState().xmm[3]).toBe(previous)
        emulator.dispose()
    })

    it('tags instruction entries and poke entries so the two are never ambiguous', async () => {
        const emulator = await startedEmulator()

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 9n)
        expect(emulator.endPoke()).toBe(true)
        await emulator.step()

        const history = emulator.getUndoHistory(16)
        // Newest first, exactly as instruction entries are ordered.
        expect(history.map((entry: ExecutionStep) => entry.kind)).toEqual([
            'instruction',
            'poke',
            'instruction',
        ])
        expect(history.every((entry) => entry.kind !== undefined)).toBe(true)
        expect(history[0]?.writes).toBeUndefined()
        expect(history[1]?.writes).toBeDefined()
        emulator.dispose()
    })

    it('takes one slot of the history capacity, like an instruction', async () => {
        const emulator = await startedEmulator(COUNTING_PROGRAM, 2, 1)

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 1n)
        expect(emulator.endPoke()).toBe(true)
        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 2n)
        expect(emulator.endPoke()).toBe(true)

        const history = emulator.getUndoHistory(16)
        expect(history).toHaveLength(2)
        expect(history.map((entry) => entry.kind)).toEqual(['poke', 'poke'])
        emulator.dispose()
    })

    it('applies with a zero-capacity history but keeps nothing to undo', async () => {
        const emulator = await startedEmulator(COUNTING_PROGRAM, 0, 1)

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 0x42n)
        // The write landed, so the transaction says so; the history keeps a
        // poke no more than it keeps an instruction at this setting.
        expect(emulator.endPoke()).toBe(true)

        expect(emulator.getRegisterValue('rbx')).toBe(0x42n)
        expect(emulator.getUndoHistory(16)).toHaveLength(0)
        expect(emulator.canUndo()).toBe(false)
        emulator.dispose()
    })

    it('undoes a poke like any other entry, restoring only what it wrote', async () => {
        const emulator = await startedEmulator()
        const stackPointer = emulator.getSp()
        const originalBytes = [...emulator.readMemoryBytes(stackPointer, 4n)]
        const registersBefore = emulator.getRegisterValuesRecord()
        const before = surroundings(emulator)

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 0x1234n)
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([0xde, 0xad, 0xbe, 0xef]))
        expect(emulator.endPoke()).toBe(true)

        expect(emulator.canUndo()).toBe(true)
        emulator.undo()

        expect(emulator.getRegisterValuesRecord()).toEqual(registersBefore)
        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual(originalBytes)
        expect(surroundings(emulator)).toEqual(before)
        expect(emulator.getUndoHistory(16).map((entry) => entry.kind)).toEqual(['instruction'])
        emulator.dispose()
    })

    it('does not disturb the call stack or the instruction under it', async () => {
        const emulator = await startedEmulator(
            `
.global _start
.text
_start:
  call target
  mov $60, %rax
  xor %rdi, %rdi
  syscall
target:
  mov $3, %rax
  ret
`,
            16,
            1,
        )

        expect(emulator.getCallStack()).toHaveLength(1)
        const callEntry = emulator.getUndoHistory(1)[0]!
        const before = surroundings(emulator)

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 0x99n)
        expect(emulator.endPoke()).toBe(true)

        // The poke is its own entry: it never takes the instruction's place,
        // and undoing it leaves that instruction's entry exactly as it was.
        const history = emulator.getUndoHistory(16)
        expect(history[0]!.kind).toBe('poke')
        expect(history[1]).toEqual(callEntry)
        expect(emulator.getCallStack()).toHaveLength(1)

        emulator.undo()
        expect(emulator.getCallStack()).toHaveLength(1)
        expect(emulator.getRegisterValue('rbx')).toBe(0n)
        expect(surroundings(emulator)).toEqual(before)
        expect(emulator.getUndoHistory(16)[0]).toEqual(callEntry)

        // The callee still runs, so the undo left the machine steppable.
        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(3n)
        emulator.dispose()
    })

    it('undoes two consecutive pokes one at a time', async () => {
        const emulator = await startedEmulator()

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 1n)
        expect(emulator.endPoke()).toBe(true)
        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 2n)
        expect(emulator.endPoke()).toBe(true)

        expect(emulator.getUndoHistory(16).map((entry) => entry.kind)).toEqual([
            'poke',
            'poke',
            'instruction',
        ])

        emulator.undo()
        expect(emulator.getRegisterValue('rbx')).toBe(1n)
        emulator.undo()
        expect(emulator.getRegisterValue('rbx')).toBe(0n)
        expect(emulator.getUndoHistory(16).map((entry) => entry.kind)).toEqual(['instruction'])
        emulator.dispose()
    })

    it('reverts an instruction before the poke that came before it', async () => {
        const emulator = await startedEmulator()
        const stackPointer = emulator.getSp()
        const originalBytes = [...emulator.readMemoryBytes(stackPointer, 4n)]
        const registersBefore = emulator.getRegisterValuesRecord()
        const before = surroundings(emulator)

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 0x1234n)
        emulator.writeMemoryBytes(stackPointer, Uint8Array.from([1, 2, 3, 4]))
        expect(emulator.endPoke()).toBe(true)

        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(2n)
        expect(emulator.getRegisterValue('rbx')).toBe(0x1234n)

        emulator.undo()
        // The instruction goes first: the poke is still in force.
        expect(emulator.getRegisterValue('rax')).toBe(1n)
        expect(emulator.getRegisterValue('rbx')).toBe(0x1234n)
        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual([1, 2, 3, 4])

        emulator.undo()
        expect(emulator.getRegisterValuesRecord()).toEqual(registersBefore)
        expect([...emulator.readMemoryBytes(stackPointer, 4n)]).toEqual(originalBytes)
        expect(surroundings(emulator)).toEqual(before)

        // And the program runs on from exactly where it was.
        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(2n)
        emulator.dispose()
    })

    it('lets a step follow a poke and a poke undo', async () => {
        const emulator = await startedEmulator()

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 5n)
        expect(emulator.endPoke()).toBe(true)

        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(2n)

        emulator.undo()
        emulator.undo()
        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(2n)
        expect(emulator.getRegisterValue('rbx')).toBe(0n)
        emulator.dispose()
    })

    it('refuses to step or run while a poke is open', async () => {
        const emulator = await startedEmulator()

        emulator.beginPoke()
        emulator.setRegisterValue('rbx', 1n)
        await expect(emulator.step()).rejects.toThrow(/poke is open/i)
        await expect(emulator.run()).rejects.toThrow(/poke is open/i)
        expect(emulator.endPoke()).toBe(true)

        await emulator.step()
        expect(emulator.getRegisterValue('rax')).toBe(2n)
        emulator.dispose()
    })
})
