// What the checker tells someone learning x86. NASM already reports most of
// these; the value is in them reaching the editor at all, with the severity and
// the class NASM gave them, on the column the mistake is written at.
import { describe, expect, it } from 'vitest'
import { locateDiagnosticColumn } from '../src/assemblers'
import { findNearestSymbol, readDefinedGlobalSymbols } from '../src/elf-symbols'
import { nasmWasmAssembler } from '../src/wasm-assembler'
import { createX86Emulator } from '../src/x86-emulator'

const program = (...lines: string[]) => lines.join('\n')

describe('warnings from a program that assembles', () => {
    it.each([
        {
            what: 'a label without its colon',
            code: program('bits 64', 'global _start', 'section .text', '_start', '  mov rax, 60', '  syscall'),
            line: 4,
            class: 'label-orphan',
        },
        {
            what: 'a constant too big for the register',
            code: program('bits 64', 'global _start', 'section .text', '_start:', '  mov al, 300', '  syscall'),
            line: 5,
            class: 'number-overflow',
        },
        {
            what: 'reserved space in an initialized section',
            code: program('bits 64', 'global _start', 'section .data', 'buf: resb 8', 'section .text', '_start:', '  syscall'),
            line: 4,
            class: 'zeroing',
        },
        {
            what: 'a segment prefix that 64-bit mode ignores',
            code: program('bits 64', 'global _start', 'section .text', '_start:', '  es mov rax, 60', '  syscall'),
            line: 5,
            class: 'prefix-seg',
        },
    ])('reports $what as a warning, not silence', async ({ code, line, class: warningClass }) => {
        const emulator = await createX86Emulator()

        const diagnostics = await emulator.checkCode(code)

        expect(diagnostics).toHaveLength(1)
        expect(diagnostics[0]).toMatchObject({
            severity: 'warning',
            lineIndex: line - 1,
            code: warningClass,
        })
        emulator.dispose()
    })

    it('keeps a warning from failing the build', async () => {
        const emulator = await createX86Emulator()

        const result = await emulator.compile(
            program('bits 64', 'global _start', 'section .text', '_start', '  mov rax, 60', '  syscall'),
        )

        expect(result.ok).toBe(true)
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ severity: 'warning', warningClass: 'label-orphan' }),
        ])
        emulator.dispose()
    })

    it('says nothing about a program with nothing wrong with it', async () => {
        const emulator = await createX86Emulator()

        expect(
            await emulator.checkCode(
                program('bits 64', 'global _start', 'section .text', '_start:', '  mov rax, 60', '  xor rdi, rdi', '  syscall'),
            ),
        ).toEqual([])
        emulator.dispose()
    })
})

describe('the entry point', () => {
    it('reports a program the linker has no entry symbol for', async () => {
        const emulator = await createX86Emulator()

        const diagnostics = await emulator.checkCode(
            program('bits 64', 'section .text', 'main:', '  mov rax, 60', '  syscall'),
        )

        expect(diagnostics).toEqual([
            expect.objectContaining({ severity: 'error', code: 'entry-point' }),
        ])
        emulator.dispose()
    })

    it('names the symbol a misspelling was probably meant to be', async () => {
        const emulator = await createX86Emulator()

        const diagnostics = await emulator.checkCode(
            program('bits 64', 'global _strat', 'section .text', '_strat:', '  mov rax, 60', '  syscall'),
        )

        expect(diagnostics[0]?.message).toContain('_strat')
        expect(diagnostics[0]?.message).toContain('_start')
        emulator.dispose()
    })

    it('says a label alone is not exported', async () => {
        const emulator = await createX86Emulator()

        const diagnostics = await emulator.checkCode(
            program('bits 64', 'section .text', '_start:', '  mov rax, 60', '  syscall'),
        )

        expect(diagnostics[0]?.message).toContain('global _start')
        emulator.dispose()
    })

    it('is silent when the entry point is defined and exported', async () => {
        const emulator = await createX86Emulator()

        expect(
            await emulator.checkCode(
                program('bits 64', 'global _start', 'section .text', '_start:', '  mov rax, 60', '  syscall'),
            ),
        ).toEqual([])
        emulator.dispose()
    })
})

describe('reading an object file', () => {
    it('names the symbols a Project exports, and not the ones it only uses', async () => {
        const assembled = await nasmWasmAssembler.assemble({
            entry: 'assembly.s',
            files: {
                'assembly.s': program(
                    'bits 64',
                    'global _start',
                    'global helper',
                    'extern outside',
                    'section .text',
                    '_start:',
                    '  call helper',
                    '  call outside',
                    'helper:',
                    '  ret',
                    'local_only:',
                    '  ret',
                ),
            },
        })

        const globals = readDefinedGlobalSymbols(assembled.object!)

        expect(globals).toContain('_start')
        expect(globals).toContain('helper')
        // Declared but defined elsewhere, so it is not this object's to export.
        expect(globals).not.toContain('outside')
        // A label with no `global` directive is invisible to the linker.
        expect(globals).not.toContain('local_only')
    })

    it('suggests a near miss, and only a near one', () => {
        expect(findNearestSymbol('_start', ['_strat', 'main'])).toBe('_strat')
        expect(findNearestSymbol('_start', ['_start'])).toBeNull()
        expect(findNearestSymbol('_start', ['completely_different'])).toBeNull()
        expect(findNearestSymbol('_start', [])).toBeNull()
    })
})

describe('where a diagnostic points', () => {
    it('points at the symbol the message names', () => {
        expect(locateDiagnosticColumn("symbol `msg' not defined", '  mov rsi, msg')).toBe(12)
    })

    it('points at the label when the whole line is the mistake', () => {
        expect(locateDiagnosticColumn('label alone on a line', '    _start', 'label-orphan')).toBe(5)
    })

    it('does not match a name inside a longer one', () => {
        expect(locateDiagnosticColumn("symbol `msg' not defined", '  mov rsi, msg_length')).toBe(1)
    })

    it('falls back to the first column when the message names nothing', () => {
        expect(locateDiagnosticColumn('byte exceeds bounds', '  mov al, 300')).toBe(1)
    })
})
