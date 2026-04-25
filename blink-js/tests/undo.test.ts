import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

async function stepUntil(emulator: X86Emulator, predicate: () => boolean, maxSteps = 100): Promise<void> {
    for (let step = 0; step < maxSteps && !predicate(); step += 1) {
        await emulator.step()
    }
    expect(predicate()).toBe(true)
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