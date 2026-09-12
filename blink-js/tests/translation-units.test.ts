import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'

const EXIT_SYSCALL = ['  mov rax, 60', '  xor rdi, rdi', '  syscall'].join('\n')

describe('translation units', () => {
  it('links a `global` in one File to an `extern` in another', async () => {
    const emulator = await createX86Emulator()
    const result = await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': [
          'global _start',
          'extern answer',
          'section .text',
          '_start:',
          '  call answer',
          '  mov rdi, rax',
          '  mov rax, 60',
          '  syscall',
        ].join('\n'),
        'answer.asm': ['global answer', 'section .text', 'answer:', '  mov rax, 42', '  ret'].join('\n'),
      },
    })

    expect(result.ok).toBe(true)
    await emulator.run()
    expect(emulator.stopReason?.exitCode).toBe(42)
    emulator.dispose()
  })

  it('steps into the File the callee was written in', async () => {
    const emulator = await createX86Emulator()
    await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': ['global _start', 'extern helper', 'section .text', '_start:', '  call helper', EXIT_SYSCALL].join(
          '\n',
        ),
        'helper.asm': ['global helper', 'section .text', 'helper:', '  nop', '  ret'].join('\n'),
      },
    })

    expect(emulator.getNextInstruction()?.file).toBe('main.asm')
    await emulator.step() // into `helper`
    const inCallee = emulator.getNextInstruction()
    expect(inCallee?.file).toBe('helper.asm')
    expect(inCallee?.code).toContain('nop')
    emulator.dispose()
  })

  it('reports a symbol no File defines, rather than a build that quietly produced nothing', async () => {
    const emulator = await createX86Emulator()
    const result = await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': ['global _start', 'extern missing', 'section .text', '_start:', '  call missing', EXIT_SYSCALL].join(
          '\n',
        ),
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((error) => error.error.includes('undefined reference to `missing'))).toBe(true)
    expect(result.errors.every((error) => error.file === 'main.asm')).toBe(true)
    // The state a failed link leaves behind is what `step` used to fail on with a message about
    // the emulator instead of the mistake.
    expect(emulator.state).toBe('READY')
    emulator.dispose()
  })

  it('finds the entry point when another File exports it', async () => {
    const emulator = await createX86Emulator()
    const result = await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': ['section .text', 'nothing_here:', '  ret'].join('\n'),
        'start.asm': ['global _start', 'section .text', '_start:', EXIT_SYSCALL].join('\n'),
      },
    })

    expect(result.ok).toBe(true)
    emulator.dispose()
  })

  it('assembles an included File as part of its includer and never on its own', async () => {
    const emulator = await createX86Emulator()
    // `shared.asm` carries a label: assembling it as a unit of its own as well would define that
    // label twice and the link would fail on the duplicate.
    const result = await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': ['global _start', '%include "shared.asm"', 'section .text', '_start:', '  call shared', EXIT_SYSCALL].join(
          '\n',
        ),
        'shared.asm': ['section .text', 'shared:', '  ret'].join('\n'),
      },
    })

    expect(result.ok).toBe(true)
    emulator.dispose()
  })

  it('names the File an error was written in, for every unit', async () => {
    const emulator = await createX86Emulator()
    const errors = await emulator.checkProject({
      entry: 'main.asm',
      files: {
        'main.asm': ['global _start', 'section .text', '_start:', EXIT_SYSCALL].join('\n'),
        'broken.asm': ['section .text', 'broken:', '  mov rax, rbx, rcx'].join('\n'),
      },
    })

    expect(errors.length).toBeGreaterThan(0)
    expect(errors.every((error) => error.file === 'broken.asm')).toBe(true)
    emulator.dispose()
  })

  it('leaves data Files out of the assembly', async () => {
    const emulator = await createX86Emulator()
    const result = await emulator.compileProject({
      entry: 'main.asm',
      files: {
        'main.asm': [
          'global _start',
          'section .data',
          'blob: incbin "blob.bin"',
          'section .text',
          '_start:',
          EXIT_SYSCALL,
        ].join('\n'),
        'blob.bin': new Uint8Array([1, 2, 3]),
        'notes.txt': 'not assembly',
      },
    })

    expect(result.ok).toBe(true)
    emulator.dispose()
  })
})
