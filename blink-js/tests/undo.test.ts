import { describe, expect, it } from 'vitest'
import { EmulatorStatus, RegisterSize, type MutationOperation } from '../src/interface'
import { createX86Emulator as createDefaultX86Emulator, type X86Emulator, type X86EmulatorOptions } from '../src/x86-emulator'

const createX86Emulator = (options: X86EmulatorOptions = {}) =>
  createDefaultX86Emulator({ ...options, mode: 'GNU_trunk' })

async function stepUntil(emulator: X86Emulator, predicate: () => boolean, maxSteps = 100): Promise<void> {
    for (let step = 0; step < maxSteps && !predicate(); step += 1) {
        await emulator.step()
    }
    expect(predicate()).toBe(true)
}


/** The WriteRegister mutations of a step, by register name. */
function registerWrites(mutations: MutationOperation[]): Map<string, { old: bigint; size: RegisterSize }> {
    const writes = new Map<string, { old: bigint; size: RegisterSize }>()
    for (const mutation of mutations) {
        if (mutation.type === 'WriteRegister') writes.set(mutation.value.register, mutation.value)
    }
    return writes
}

/** The IEEE-754 binary64 bit pattern of a double, which is what an st mutation carries. */
function doubleBits(value: number): bigint {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value, true)
    return view.getBigUint64(0, true)
}

describe('x86 undo history', () => {
    it('records register history and undoes the latest instruction', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $2, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await emulator.step()
        await emulator.step()

        expect(emulator.getRegisterValue('rax')).toBe(2n)
        expect(emulator.canUndo()).toBe(true)
        expect(emulator.getUndoHistory(2)[0]?.mutations.some((mutation) => mutation.type === 'WriteRegister')).toBe(true)

        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(1n)
        expect(emulator.getNextInstruction()?.code).toContain('mov')
        emulator.dispose()
    })

    it('keeps undo history in a fixed-size circular buffer', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $2, %rax
  mov $3, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(2)
        await emulator.step()
        await emulator.step()
        await emulator.step()

        expect(emulator.getRegisterValue('rax')).toBe(3n)
        expect(emulator.getUndoHistory(10)).toHaveLength(2)

        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(2n)
        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(1n)
        expect(emulator.canUndo()).toBe(false)
        expect(emulator.getUndoHistory(10)).toHaveLength(0)
        expect(emulator.getNextInstruction()?.code).toContain('mov')
        emulator.dispose()
    })

    it('records memory writes and restores old bytes during undo', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $0x1122334455667788, %rax
  push %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await emulator.step()
        const stackPointerBeforePush = emulator.getSp()
        await emulator.step()
        const stackPointerAfterPush = emulator.getSp()

        expect(stackPointerAfterPush).toBe(stackPointerBeforePush - 8n)
        expect(Array.from(emulator.readMemoryBytes(stackPointerAfterPush, 8n))).toEqual([
            0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        ])
        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'WriteMemoryBytes')).toBe(true)

        emulator.undo()
        expect(emulator.getSp()).toBe(stackPointerBeforePush)
        expect(emulator.getNextInstruction()?.code).toContain('push')
        emulator.dispose()
    })

    it('tracks calls and returns in the call stack history', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
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
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await emulator.step()

        expect(emulator.getCallStack()).toHaveLength(1)
        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'PushCallStack')).toBe(true)

        await emulator.step()
        await emulator.step()
        expect(emulator.getCallStack()).toHaveLength(0)
        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'PopCallStack')).toBe(true)
        emulator.dispose()
    })

    it('undoes a function call and can execute the callee after redoing it', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $40, %rdi
  call add_two
  mov %rax, %rdi
  mov $60, %rax
  syscall
add_two:
  lea 2(%rdi), %rax
  ret
`)

        expect(result.ok).toBe(true)
        emulator.initialize(16)
        await emulator.step()
        const stackPointerBeforeCall = emulator.getSp()
        await emulator.step()
        const stackPointerInCallee = emulator.getSp()

        expect(stackPointerInCallee).toBe(stackPointerBeforeCall - 8n)
        expect(emulator.getCallStack()).toHaveLength(1)
        expect(emulator.getNextInstruction()?.code).toContain('lea')
        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'PushCallStack')).toBe(true)
        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'WriteMemoryBytes')).toBe(true)

        emulator.undo()
        expect(emulator.getSp()).toBe(stackPointerBeforeCall)
        expect(emulator.getCallStack()).toHaveLength(0)
        expect(emulator.getNextInstruction()?.code).toContain('call')

        await emulator.step()
        await emulator.step()
        await emulator.step()
        expect(emulator.getCallStack()).toHaveLength(0)
        expect(emulator.getRegisterValue('rax')).toBe(42n)
        expect(emulator.getNextInstruction()?.code).toContain('mov')
        emulator.dispose()
    })

    it('undoes nested recursive calls and returns while preserving final execution', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $3, %rdi
  call sum_to
  mov %rax, %rdi
  mov $60, %rax
  syscall
sum_to:
  cmp $0, %rdi
  je base
  push %rdi
  dec %rdi
  call sum_to
  pop %rcx
  add %rcx, %rax
  ret
base:
  xor %rax, %rax
  ret
`)

        expect(result.ok).toBe(true)
        emulator.initialize(96)
        await emulator.step()
        await stepUntil(emulator, () => emulator.getCallStack().length === 3)
        const stackPointerAfterThirdCall = emulator.getSp()

        expect(emulator.getUndoHistory(1)[0]?.mutations.some((mutation) => mutation.type === 'PushCallStack')).toBe(true)
        emulator.undo()
        expect(emulator.getCallStack()).toHaveLength(2)
        expect(emulator.getSp()).toBe(stackPointerAfterThirdCall + 8n)
        expect(emulator.getNextInstruction()?.code).toContain('call')

        await emulator.step()
        expect(emulator.getCallStack()).toHaveLength(3)
        expect(emulator.getSp()).toBe(stackPointerAfterThirdCall)

        await stepUntil(emulator, () => emulator.getCallStack().length === 4)
        const stackPointerAtBaseFrame = emulator.getSp()
        await stepUntil(
            emulator,
            () =>
                emulator.getCallStack().length === 3 &&
                Boolean(
                    emulator
                        .getUndoHistory(1)[0]
                        ?.mutations.some((mutation) => mutation.type === 'PopCallStack'),
                ),
        )

        emulator.undo()
        expect(emulator.getCallStack()).toHaveLength(4)
        expect(emulator.getSp()).toBe(stackPointerAtBaseFrame)
        expect(emulator.getNextInstruction()?.code).toContain('ret')

        await emulator.step()
        expect(emulator.getCallStack()).toHaveLength(3)
        expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
        expect(emulator.stopReason?.exitCode).toBe(6)
        emulator.dispose()
    })

    it('uses traced stepping for run limits when history is enabled', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $2, %rbx
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        const status = await emulator.run(2)

        expect(status).toBe(EmulatorStatus.Running)
        expect(emulator.stopReason?.kind).toBe('limit')
        expect(emulator.stopReason?.executedInstructions).toBe(2n)
        expect(emulator.getUndoHistory(8)).toHaveLength(2)

        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(1n)
        expect(emulator.getRegisterValue('rbx')).not.toBe(2n)
        emulator.dispose()
    })

    it('can undo the terminating syscall step', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  mov $9, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
        expect(emulator.stopReason?.exitCode).toBe(9)

        emulator.undo()
        expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
        expect(emulator.stopReason).toBeNull()
        expect(emulator.getNextInstruction()?.code).toContain('syscall')
        emulator.dispose()
    })
})

describe('x86 SSE and x87 register files', () => {
    it('reads xmm0 after an SSE instruction, records the write and undoes it', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  movabs $0x4010000000000000, %rax
  movq %rax, %xmm0
  addsd %xmm0, %xmm0
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)

        // movabs is an integer move: it must leave the SSE file alone.
        await emulator.step()
        expect(registerWrites(emulator.getUndoHistory(1)[0]!.mutations).has('xmm0')).toBe(false)
        expect(emulator.getFpuState().xmm[0]).toBe(0n)

        // movq %rax, %xmm0 writes 4.0 into lane 0 and zeroes the upper half.
        await emulator.step()
        expect(emulator.getFpuState().xmm[0]).toBe(0x4010000000000000n)
        const movqWrite = registerWrites(emulator.getUndoHistory(1)[0]!.mutations).get('xmm0')
        expect(movqWrite).toBeDefined()
        expect(movqWrite!.old).toBe(0n)
        expect(movqWrite!.size).toBe(RegisterSize.Quad)

        // addsd %xmm0, %xmm0 doubles it to 8.0.
        await emulator.step()
        expect(emulator.getFpuState().xmm[0]).toBe(0x4020000000000000n)
        const addWrite = registerWrites(emulator.getUndoHistory(1)[0]!.mutations).get('xmm0')
        expect(addWrite).toBeDefined()
        expect(addWrite!.old).toBe(0x4010000000000000n)
        expect(addWrite!.size).toBe(RegisterSize.Quad)

        emulator.undo()
        expect(emulator.getFpuState().xmm[0]).toBe(0x4010000000000000n)
        expect(emulator.getNextInstruction()?.code).toContain('addsd')

        emulator.undo()
        expect(emulator.getFpuState().xmm[0]).toBe(0n)
        expect(emulator.getNextInstruction()?.code).toContain('movq')
        emulator.dispose()
    })

    it('reads the x87 stack in logical order and undoes a faddp', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  fld1
  fld1
  faddp
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)

        await emulator.step()
        expect(emulator.getFpuState().st[0]).toBe(1)
        await emulator.step()
        // Both pushes put 1.0 on top; the stack is now 1.0 over 1.0, and the
        // second push moved TOP, so reading st(0) needs the rotation.
        expect(emulator.getFpuState().st[0]).toBe(1)
        expect(emulator.getFpuState().st[1]).toBe(1)
        const stateBeforeAdd = emulator.getFpuState()

        await emulator.step()
        const afterAdd = emulator.getFpuState()
        expect(afterAdd.st[0]).toBe(2)
        // faddp pops, so TOP moved back up by one.
        expect((afterAdd.fstat >> 11) & 7).toBe(((stateBeforeAdd.fstat >> 11) & 7) + 1)

        const writes = registerWrites(emulator.getUndoHistory(1)[0]!.mutations)
        const st0Write = writes.get('st0')
        expect(st0Write).toBeDefined()
        expect(st0Write!.old).toBe(doubleBits(1))
        expect(st0Write!.size).toBe(RegisterSize.Double)
        // The pop changes TOP, which lives in the status word.
        const statusWrite = writes.get('fstat')
        expect(statusWrite).toBeDefined()
        expect(statusWrite!.old).toBe(BigInt(stateBeforeAdd.fstat))
        expect(statusWrite!.size).toBe(RegisterSize.Word)

        emulator.undo()
        const restored = emulator.getFpuState()
        expect(restored.st[0]).toBe(1)
        expect(restored.st[1]).toBe(1)
        expect(restored.fstat).toBe(stateBeforeAdd.fstat)
        expect(restored.ftag).toBe(stateBeforeAdd.ftag)
        expect(emulator.getNextInstruction()?.code).toContain('faddp')

        // Re-running the popped instruction gets the same answer, which it
        // could not if undo had restored the stack but not the tag word.
        await emulator.step()
        expect(emulator.getFpuState().st[0]).toBe(2)
        emulator.dispose()
    })

    it('round trips a preset FPU state and records no undo entry for it', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await emulator.step()
        const historyBefore = emulator.getUndoHistory(8).length

        const state = emulator.getFpuState()
        state.xmm[5] = (0x0123456789abcdefn << 64n) | 0xfedcba9876543210n
        state.xmm[15] = 1n
        state.mxcsr = 0x9fc0
        state.st[2] = 3.5
        state.fctrl = 0x027f
        state.ftag = 0x5555
        emulator.setFpuState(state)

        const readBack = emulator.getFpuState()
        expect(readBack.xmm[5]).toBe((0x0123456789abcdefn << 64n) | 0xfedcba9876543210n)
        expect(readBack.xmm[15]).toBe(1n)
        expect(readBack.mxcsr).toBe(0x9fc0)
        expect(readBack.st[2]).toBe(3.5)
        expect(readBack.fctrl).toBe(0x027f)
        expect(readBack.ftag).toBe(0x5555)

        // A preset is not an instruction: it must not become something to undo.
        expect(emulator.getUndoHistory(8)).toHaveLength(historyBefore)
        emulator.dispose()
    })

    it('loses an FPU preset made before the first step, exactly as a register preset is lost', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)

        // The first step starts the program, which builds the machine afresh,
        // so anything preset beforehand is wiped. Pinned here because a
        // Testcase that presets values before running depends on knowing it.
        const state = emulator.getFpuState()
        state.xmm[0] = 123n
        state.st[0] = 3.5
        emulator.setFpuState(state)
        emulator.setRegisterValue('rbx', 0x1234n)
        expect(emulator.getFpuState().xmm[0]).toBe(123n)

        await emulator.step()

        expect(emulator.getFpuState().xmm[0]).toBe(0n)
        expect(emulator.getRegisterValue('rbx')).toBe(0n)
        emulator.dispose()
    })

    it('does not resurrect a terminated program when the FPU state is preset', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  mov $3, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await stepUntil(emulator, () => emulator.hasTerminated())
        expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)

        // A setter presets state; it must not clear the reason the program
        // stopped, exactly as setRegisterValue does not.
        emulator.setRegisterValue('rbx', 1n)
        expect(emulator.hasTerminated()).toBe(true)
        expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)

        const state = emulator.getFpuState()
        state.xmm[0] = 7n
        emulator.setFpuState(state)
        expect(emulator.getFpuState().xmm[0]).toBe(7n)
        expect(emulator.hasTerminated()).toBe(true)
        expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
        emulator.dispose()
    })

    it('records no FPU mutations for a step that touches no FPU state', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $1, %rax
  add $2, %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        emulator.initialize(8)
        await emulator.step()
        await emulator.step()

        expect(emulator.getRegisterValue('rax')).toBe(3n)
        const fpuNames = new Set([
            ...Array.from({ length: 16 }, (_, index) => `xmm${index}`),
            'mxcsr',
            ...Array.from({ length: 8 }, (_, index) => `st${index}`),
            'fctrl',
            'fstat',
            'ftag',
        ])
        for (const entry of emulator.getUndoHistory(8)) {
            for (const register of registerWrites(entry.mutations).keys()) {
                expect(fpuNames.has(register)).toBe(false)
            }
        }
        emulator.dispose()
    })
})
