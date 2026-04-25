import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator } from '../src/x86-emulator'

describe('wasm runtime integration', () => {
    it('initializes the emulator runtime', async () => {
        const emulator = await createX86Emulator()
        expect(emulator.state).toBe('READY')
        emulator.dispose()
    })

    it('compiles and runs an exit syscall program', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  mov $7, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        expect(emulator.state).toBe('PROGRAM_LOADED')

        await emulator.runUntilBlocked()
        expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
        expect(emulator.stopReason?.exitCode).toBe(7)
        emulator.dispose()
    })

    it('returns real results from BaseEmulator compile and check methods', async () => {
        const emulator = await createX86Emulator()

        const valid = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)
        expect(valid.ok).toBe(true)

        const diagnostics = await emulator.checkCode(`
.global _start
.text
_start:
  nope %rax
`)
        expect(diagnostics.length).toBeGreaterThan(0)
        expect(diagnostics[0]?.line.line).toContain('nope')
        emulator.dispose()
    })

    it('pauses execution after an instruction limit', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  jmp _start
`)

        expect(result.ok).toBe(true)
        const status = await emulator.run(5)
        expect(status).toBe(EmulatorStatus.Running)
        expect(emulator.stopReason?.kind).toBe('limit')
        expect(emulator.stopReason?.executedInstructions).toBe(5n)
        emulator.dispose()
    })

    it('pauses on source-line breakpoints and can continue', async () => {
        const emulator = await createX86Emulator()
        const source = [
            '.global _start',
            '.text',
            '_start:',
            '  mov $1, %rax',
            '  mov $2, %rbx',
            '  mov $60, %rax',
            '  xor %rdi, %rdi',
            '  syscall',
        ].join('\n')
        const result = await emulator.compile(source)

        expect(result.ok).toBe(true)
        const status = await emulator.run(undefined, [4])
        expect(status).toBe(EmulatorStatus.Running)
        expect(emulator.stopReason?.kind).toBe('breakpoint')
        expect(emulator.stopReason?.lineNumber).toBe(4)

        const instruction = emulator.getInstructionAt(emulator.getPc())
        expect(instruction?.lineNumber).toBe(4)
        expect(instruction?.code).toContain('mov')

        const finalStatus = await emulator.run(undefined, [])
        expect(finalStatus).toBe(EmulatorStatus.Terminated)
        expect(emulator.stopReason?.exitCode).toBe(0)
        emulator.dispose()
    })

    it('captures stdout from a running program', async () => {
        let stdout = ''
        const emulator = await createX86Emulator({
            callbacks: {
                stdout: (charCode) => {
                    stdout += String.fromCharCode(charCode)
                },
            },
        })

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
        await emulator.runUntilBlocked()
        expect(stdout).toContain('ok\n')
        emulator.dispose()
    })

    it('steps from a loaded program and exposes copied state snapshots', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        await emulator.step()
        expect(emulator.getPc()).toBeGreaterThan(0n)
        expect(emulator.getRegisterValuesRecord().rax).toBe(60n)
        expect(emulator.getFlags().map((flag) => flag.name)).toContain('ZF')

        emulator.setRegisterValue('rax', 0x1234n)
        expect(emulator.getRegisterValue('rax')).toBe(0x1234n)

        const nextInstruction = emulator.getNextInstruction()
        expect(nextInstruction?.address).toBeGreaterThan(0n)
        expect(nextInstruction?.code.length).toBeGreaterThan(0)
        emulator.dispose()
    })

    it('reads and writes mapped memory through copied byte arrays', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        await emulator.step()

        const stackPointer = emulator.getSp()
        const original = emulator.readMemoryBytes(stackPointer, 4n)
        const replacement = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd])

        emulator.writeMemoryBytes(stackPointer, replacement)
        expect(Array.from(emulator.readMemoryBytes(stackPointer, 4n))).toEqual(Array.from(replacement))

        emulator.writeMemoryBytes(stackPointer, original)
        expect(() => emulator.readMemoryBytes(0xdeadbeefn, 4n)).toThrow(/not mapped/i)
        emulator.dispose()
    })

    it('reads chunks from a larger mapped memory write', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        await emulator.step()

        const stackPointer = emulator.getSp()
        const original = emulator.readMemoryBytes(stackPointer, 32n)
        const bytes = Uint8Array.from(Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff))

        emulator.writeMemoryBytes(stackPointer, bytes)
        expect(Array.from(emulator.readMemoryBytes(stackPointer, 5n))).toEqual(Array.from(bytes.slice(0, 5)))
        expect(Array.from(emulator.readMemoryBytes(stackPointer + 9n, 11n))).toEqual(Array.from(bytes.slice(9, 20)))
        expect(Array.from(emulator.readMemoryBytes(stackPointer + 28n, 4n))).toEqual(Array.from(bytes.slice(28, 32)))

        emulator.writeMemoryBytes(stackPointer, original)
        emulator.dispose()
    })

    it('writes chunks without clobbering adjacent memory', async () => {
        const emulator = await createX86Emulator()
        const result = await emulator.compile(`
.global _start
.text
_start:
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`)

        expect(result.ok).toBe(true)
        await emulator.step()

        const stackPointer = emulator.getSp()
        const original = emulator.readMemoryBytes(stackPointer, 24n)
        const base = Uint8Array.from(Array.from({ length: 24 }, (_, index) => index + 1))
        const patch = Uint8Array.from([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5])
        const expected = Uint8Array.from(base)
        expected.set(patch, 8)

        emulator.writeMemoryBytes(stackPointer, base)
        emulator.writeMemoryBytes(stackPointer + 8n, patch)

        expect(Array.from(emulator.readMemoryBytes(stackPointer, 24n))).toEqual(Array.from(expected))
        expect(Array.from(emulator.readMemoryBytes(stackPointer + 6n, 4n))).toEqual(Array.from(expected.slice(6, 10)))
        expect(Array.from(emulator.readMemoryBytes(stackPointer + 14n, 4n))).toEqual(Array.from(expected.slice(14, 18)))

        emulator.writeMemoryBytes(stackPointer, original)
        emulator.dispose()
    })
})