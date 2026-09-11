import { describe, expect, it } from 'vitest'
import { fasmDiagnostics, gnuDiagnostics, nasmDiagnostics } from '../src/assemblers'

describe('assembler diagnostics', () => {
    it('parses GNU assembler errors', () => {
        expect(gnuDiagnostics('/assembly.s:4: Error: operand type mismatch for `mov`')).toEqual([
            { file: '/assembly.s', line: 4, error: 'Error: operand type mismatch for `mov`' },
        ])
    })

    it('parses NASM errors and warnings', () => {
        expect(nasmDiagnostics('/assembly.s:7: error: symbol `main` not defined')).toEqual([
            { file: '/assembly.s', line: 7, error: 'symbol `main` not defined' },
        ])
    })

    it('parses FASM line/error pairs', () => {
        const log = '/assembly.s [12]:\nmov rax, nope\nerror: invalid argument.'
        expect(fasmDiagnostics(log)).toEqual([
            { file: '/assembly.s', line: 12, error: 'error: invalid argument.' },
        ])
    })
})
