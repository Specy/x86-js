import { describe, expect, it } from 'vitest'
import { fasmDiagnostics, gnuDiagnostics, nasmDiagnostics } from '../src/assemblers'

describe('assembler diagnostics', () => {
    it('parses GNU assembler errors', () => {
        expect(gnuDiagnostics('/assembly.s:4: Error: operand type mismatch for `mov`')).toEqual([
            {
                file: '/assembly.s',
                line: 4,
                error: 'Error: operand type mismatch for `mov`',
                severity: 'error',
            },
        ])
    })

    it('parses GNU assembler warnings', () => {
        expect(gnuDiagnostics('/assembly.s:9: Warning: end of file not at end of a line')).toEqual([
            {
                file: '/assembly.s',
                line: 9,
                error: 'Warning: end of file not at end of a line',
                severity: 'warning',
            },
        ])
    })

    it('parses NASM errors and warnings', () => {
        expect(nasmDiagnostics('/assembly.s:7: error: symbol `main` not defined')).toEqual([
            {
                file: '/assembly.s',
                line: 7,
                error: 'symbol `main` not defined',
                severity: 'error',
            },
        ])
    })

    it('keeps the class NASM names a warning by, out of the message', () => {
        expect(
            nasmDiagnostics(
                '/assembly.s:4: warning: label alone on a line without a colon might be in error [-w+label-orphan]',
            ),
        ).toEqual([
            {
                file: '/assembly.s',
                line: 4,
                error: 'label alone on a line without a colon might be in error',
                severity: 'warning',
                warningClass: 'label-orphan',
            },
        ])
    })

    it('reads a whole NASM run, warnings and errors together', () => {
        const log = [
            '/assembly.s:4: warning: byte exceeds bounds [-w+number-overflow]',
            '/assembly.s:7: error: symbol `msg` not defined',
        ].join('\n')

        expect(nasmDiagnostics(log)).toEqual([
            expect.objectContaining({ line: 4, severity: 'warning', warningClass: 'number-overflow' }),
            expect.objectContaining({ line: 7, severity: 'error' }),
        ])
    })

    it('parses FASM line/error pairs', () => {
        const log = '/assembly.s [12]:\nmov rax, nope\nerror: invalid argument.'
        expect(fasmDiagnostics(log)).toEqual([
            {
                file: '/assembly.s',
                line: 12,
                error: 'error: invalid argument.',
                severity: 'error',
            },
        ])
    })
})
