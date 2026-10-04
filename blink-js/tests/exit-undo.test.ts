import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EmulatorStatus } from '../src/interface'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const SOURCE = `bits 64
global _start
section .text
_start:
    inc rbx
    lea r12, [rel cell]
    mov [r12], rbx
    fld1
    pcmpeqd xmm0, xmm0
    mov edi, 42
    mov eax, 60
exit_here:
    syscall
    inc rbx
section .data
cell: dq 0
`

const EXIT_LINE = SOURCE.split('\n').findIndex((line) => line.trim() === 'syscall')
const INSTRUCTIONS = 8

async function build(source = SOURCE, capacity = 16): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(capacity)
    return emulator
}

function expectExit(emulator: X86Emulator, code = 42): void {
    expect(emulator.getStatus()).toBe(EmulatorStatus.Terminated)
    expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: code })
}

function snapshot(emulator: X86Emulator) {
    return {
        registers: emulator.getRegisterValuesRecord(),
        flags: emulator.getFlags(),
        fpu: emulator.getFpuState(),
        memory: emulator.readMemoryBytes(emulator.getRegisterValue('r12'), 8n),
        history: emulator.getUndoHistory(16),
    }
}

describe('undo of a trapped exit', () => {
    it('releases syscall page locks before memory access and munmap after undo', async () => {
        // A regressed page lock can block inside synchronous wasm. Run this
        // case in a child with a process timeout so the suite still settles.
        if (process.env.X86_EXIT_UNDO_CHILD !== '1') {
            const child = spawnSync(process.execPath, [
                fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
                'run', fileURLToPath(import.meta.url), '-t', 'releases syscall page locks',
            ], {
                env: { ...process.env, X86_EXIT_UNDO_CHILD: '1' },
                timeout: 15_000,
                encoding: 'utf8',
            })
            expect(child.error, child.stdout + child.stderr).toBeUndefined()
            expect(child.status, child.stdout + child.stderr).toBe(0)
            return
        }
        const source = `bits 64
global _start
section .text
_start:
    mov eax, 9
    mov edi, 0x10000000
    mov esi, 4096
    mov edx, 3
    mov r10d, 0x32
    mov r8, -1
    xor r9d, r9d
    syscall
    mov r12, rax
    mov rax, [r12]
    mov qword [r12], 41
    mov edi, 42
    mov eax, 60
    syscall
unmap:
    mov eax, 11
    mov rdi, r12
    mov esi, 4096
    syscall
    mov rbx, rax
    mov edi, eax
    mov eax, 60
    syscall
`
        const emulator = await build(source, 32)
        try {
            await emulator.run()
            expectExit(emulator)
            const address = emulator.getRegisterValue('r12')
            expect(emulator.readMemoryBytes(address, 8n)[0]).toBe(41)
            for (let i = 0; i < 4; i++) emulator.undo()
            expect(emulator.readMemoryBytes(address, 8n)).toEqual(new Uint8Array(8))
            expect(await emulator.step()).toEqual({ terminated: false })
            expect(emulator.readMemoryBytes(address, 8n)[0]).toBe(41)
            const unmapLine = source.split('\n').findIndex((line) => line.trim() === 'mov eax, 11')
            const unmap = emulator.runtime.getAddressesForSourceLine(unmapLine)[0]
            expect(unmap).toBeDefined()
            emulator.setRegisterValue('rip', unmap!)
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expectExit(emulator, 0)
            expect(emulator.getRegisterValue('rbx')).toBe(0n)
            expect(() => emulator.readMemoryBytes(address, 1n)).toThrow()
        } finally {
            emulator.dispose()
        }
    })

    it.each(['step', 'run'] as const)('replays the exit through %s repeatedly without restarting or losing state', async (drive) => {
        const emulator = await build()
        try {
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expectExit(emulator)
            const exited = snapshot(emulator)
            expect(exited.registers.rbx).toBe(1n)
            expect(exited.memory).toEqual(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))
            expect(exited.history).toHaveLength(INSTRUCTIONS)

            for (let replay = 0; replay < 3; replay++) {
                emulator.undo()
                expect(emulator.getStatus()).toBe(EmulatorStatus.Running)
                expect(emulator.stopReason).toBeNull()
                expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(EXIT_LINE)
                expect(emulator.getUndoHistory(16)).toHaveLength(INSTRUCTIONS - 1)
                if (drive === 'step') expect(await emulator.step()).toEqual({ terminated: true })
                else expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
                expectExit(emulator)
                expect(snapshot(emulator)).toEqual(exited)
            }

            // Undo past the exit's setup too: replaying those instructions
            // must restore the argument even after a host edit changes it.
            emulator.undo()
            emulator.undo()
            emulator.undo()
            emulator.setRegisterValue('rdi', 7n)
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expectExit(emulator)
            const replayed = snapshot(emulator)
            expect(replayed.registers).toEqual(exited.registers)
            expect(replayed.flags).toEqual(exited.flags)
            expect(replayed.fpu).toEqual(exited.fpu)
            expect(replayed.memory).toEqual(exited.memory)
            expect(replayed.history).toHaveLength(INSTRUCTIONS)
        } finally {
            emulator.dispose()
        }
    })

    it.each([60, 231])('uses edited arguments when syscall %i is undone and replayed', async (syscall) => {
        const emulator = await build(SOURCE.replace('mov eax, 60', `mov eax, ${syscall}`))
        try {
            await emulator.run()
            expectExit(emulator)
            emulator.undo()
            emulator.setRegisterValue('rdi', 19n)
            expect(await emulator.step()).toEqual({ terminated: true })
            expectExit(emulator, 19)
            emulator.undo()
            emulator.setRegisterValue('rdi', 23n)
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expectExit(emulator, 23)
            expect(emulator.getRegisterValue('rbx')).toBe(1n)
        } finally {
            emulator.dispose()
        }
    })

    it.each([1, 16])('undoing a Poke after exit leaves the machine exited with capacity %i', async (capacity) => {
        const emulator = await build(SOURCE, capacity)
        try {
            await emulator.run()
            expectExit(emulator)
            const exited = snapshot(emulator)
            emulator.beginPoke()
            emulator.setRegisterValue('rdi', 99n)
            emulator.setRegisterValue('rip', emulator.getPc() + 2n)
            emulator.writeMemoryBytes(emulator.getRegisterValue('r12'), Uint8Array.of(99))
            expect(emulator.endPoke()).toBe(true)

            emulator.undo()
            expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
            expectExit(emulator)
            expect(emulator.getRegisterValuesRecord()).toEqual(exited.registers)
            expect(emulator.readMemoryBytes(emulator.getRegisterValue('r12'), 8n)).toEqual(exited.memory)
            expect(emulator.getUndoHistory(16)).toHaveLength(capacity === 1 ? 0 : INSTRUCTIONS)

            if (capacity > 1) {
                emulator.undo()
                emulator.setRegisterValue('rdi', 17n)
                expect(await emulator.run()).toBe(EmulatorStatus.Terminated)
                expectExit(emulator, 17)
            }
        } finally {
            emulator.dispose()
        }
    })
})

const RESUME_CALLS: Array<[string, (emulator: X86Emulator) => void]> = [
    ['stepi', (emulator) => emulator.module._blinkenlib_stepi()],
    ['run_slice', (emulator) => emulator.module._blinkenlib_run_slice!(10, false)],
    ['continue', (emulator) => emulator.module._blinkenlib_continue()],
    ['preempt_resume', (emulator) => emulator.module._blinkenlib_preempt_resume()],
    ['faketty_resume', (emulator) => emulator.module._blinkenlib_faketty_resume()],
]

describe.each([0, 16])('native resume after exit with history capacity %i', (capacity) => {
    it.each(RESUME_CALLS)('%s reports the retained exit without executing another instruction', async (_, resume) => {
        const emulator = await build(SOURCE, capacity)
        try {
            await emulator.run()
            expectExit(emulator)
            const exited = snapshot(emulator)
            emulator.runtime.resumeAfterStateMutation()
            resume(emulator)
            expectExit(emulator)
            expect(snapshot(emulator)).toEqual(exited)
            // A second callback is equally safe, including the fake-TTY API
            // whose normal input invariant does not apply to an exited guest.
            emulator.runtime.resumeAfterStateMutation()
            resume(emulator)
            expectExit(emulator)
            expect(snapshot(emulator)).toEqual(exited)
        } finally {
            emulator.dispose()
        }
    })
})
