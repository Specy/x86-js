// Checking wants diagnostics, not a runnable program, so it assembles without
// linking. For NASM - which assembles in its own wasm module rather than inside
// blink - that means a check never touches the emulator at all, and so cannot
// disturb a program that is loaded, running, or paused in the debugger.
import { describe, expect, it } from 'vitest'
import { BlinkState } from '../src/types'
import { createX86Emulator } from '../src/x86-emulator'

const EXIT_PROGRAM = [
    'global _start',
    'section .text',
    '_start:',
    '  mov rax, 60',
    '  xor rdi, rdi',
    '  syscall',
].join('\n')

const BROKEN_PROGRAM = [
    'global _start',
    'section .text',
    '_start:',
    '  mov rax, nope nonsense',
].join('\n')

describe('checking without linking', () => {
    it('reports diagnostics on the line they belong to', async () => {
        const emulator = await createX86Emulator()

        const diagnostics = await emulator.checkCode(BROKEN_PROGRAM)

        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]?.lineIndex).toBe(3)
        expect(diagnostics[0]?.line.line).toContain('nope')
        emulator.dispose()
    })

    it('reports nothing for a program that assembles', async () => {
        const emulator = await createX86Emulator()

        expect(await emulator.checkCode(EXIT_PROGRAM)).toEqual([])
        emulator.dispose()
    })

    it('leaves no program loaded, because it never linked one', async () => {
        const emulator = await createX86Emulator()

        await emulator.checkCode(EXIT_PROGRAM)

        expect(emulator.runtime.state).toBe(BlinkState.Ready)
        emulator.dispose()
    })

    it('leaves a compiled program loaded and runnable', async () => {
        const emulator = await createX86Emulator()
        const compiled = await emulator.compile(EXIT_PROGRAM)
        expect(compiled.ok).toBe(true)

        // A check between compiling and running used to rebuild the program,
        // which meant checking while paused threw the debugger's state away.
        await emulator.checkCode(BROKEN_PROGRAM)

        expect(emulator.runtime.state).toBe(BlinkState.ProgramLoaded)
        expect(emulator.getNextInstruction()?.code).toContain('mov')
        emulator.dispose()
    })

    it('does not disturb a program paused at a breakpoint', async () => {
        const emulator = await createX86Emulator()
        await emulator.compile(EXIT_PROGRAM)
        await emulator.run(undefined, [{ path: 'assembly.s', line: 4 }])
        const pausedAt = emulator.stopReason

        expect(pausedAt?.kind).toBe('breakpoint')

        const diagnostics = await emulator.checkCode(BROKEN_PROGRAM)

        expect(diagnostics.length).toBeGreaterThan(0)
        expect(emulator.runtime.state).toBe(BlinkState.ProgramPaused)
        expect(emulator.stopReason).toEqual(pausedAt)
        emulator.dispose()
    })

    it('checks a Project of several files', async () => {
        const emulator = await createX86Emulator()

        const clean = await emulator.checkProject({
            entry: 'src/main.asm',
            files: {
                'src/main.asm': ['global _start', 'section .text', '%include "parts/exit.asm"'].join('\n'),
                'src/parts/exit.asm': ['_start:', '  mov rax, 60', '  syscall'].join('\n'),
            },
        })
        expect(clean).toEqual([])

        // A mistake in an included File is reported against that File, not the Entry.
        const broken = await emulator.checkProject({
            entry: 'src/main.asm',
            files: {
                'src/main.asm': ['global _start', 'section .text', '%include "parts/exit.asm"'].join('\n'),
                'src/parts/exit.asm': ['_start:', '  mov rax, nope nonsense'].join('\n'),
            },
        })
        expect(broken).toHaveLength(1)
        expect(broken[0]?.file).toBe('src/parts/exit.asm')
        expect(broken[0]?.lineIndex).toBe(1)
        emulator.dispose()
    })

    it('checks without linking for a blink-hosted assembler too', async () => {
        const emulator = await createX86Emulator({ mode: 'GNU_trunk' })

        const diagnostics = await emulator.checkCode(['.global _start', '.text', '_start:', '  nope %rax'].join('\n'))

        expect(diagnostics.length).toBeGreaterThan(0)
        expect(emulator.runtime.state).toBe(BlinkState.Ready)

        // And a clean check of a GNU program still links nothing.
        expect(await emulator.checkCode(['.global _start', '.text', '_start:', '  mov $60, %rax', '  syscall'].join('\n'))).toEqual([])
        expect(emulator.runtime.state).toBe(BlinkState.Ready)
        emulator.dispose()
    })
})
