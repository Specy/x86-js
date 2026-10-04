// Unit tests for the compiler-output translator: small GCC-shaped inputs, one rule at a time. The
// corpus, the GNU reference and the x87 matrix are oracles of their own, in their own files.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
    GCC_INTEL_V1,
    translateCompilerOutput,
    type TranslationDiagnostic,
    type TranslationResult,
} from '../../src/compiler-output'
import { NASM_RESERVED_NAMES } from '../../src/compiler-output/nasm-reserved'
import { translateWithRules } from '../../src/compiler-output/translate'

const IDENT = '\t.ident\t"GCC: (Compiler-Explorer-Build-gcc--binutils-2.42) 14.2.0"'

/** GCC-shaped input: the given lines after GCC's opening lines and before its closing ones. */
function unit(...lines: string[]): string[] {
    return ['\t.intel_syntax noprefix', '\t.text', ...lines, IDENT, '\t.section\t.note.GNU-stack,"",@progbits']
}

function translate(input: readonly string[]): TranslationResult {
    return translateCompilerOutput(input, { profile: 'gcc-intel-v1' })
}

function translated(input: readonly string[]): Extract<TranslationResult, { ok: true }> {
    const result = translate(input)
    if (!result.ok) {
        throw new Error(result.diagnostics.map((d) => `${d.inputLine}: ${d.code}: ${d.message}`).join('\n'))
    }
    return result
}

/** The statement and synthesized lines, without the header, trimmed. */
function body(input: readonly string[]): string[] {
    return translated(input)
        .lines.filter((line) => line.inputLine !== null)
        .map((line) => line.text.trim())
}

/** The header lines, trimmed. */
function header(input: readonly string[]): string[] {
    return translated(input)
        .lines.filter((line) => line.inputLine === null)
        .map((line) => line.text.trim())
}

function errors(input: readonly string[]): TranslationDiagnostic[] {
    const result = translate(input)
    expect(result.ok).toBe(false)
    return result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
}

/** The error codes of an input, with the input line of each. */
function errorCodes(input: readonly string[]): [string, number][] {
    return errors(input).map((diagnostic) => [diagnostic.code, diagnostic.inputLine])
}

/** One instruction inside `main`, translated; it is input line 4. */
function instruction(text: string, ...after: string[]): string {
    const result = translated(unit('\t.globl\tmain', 'main:', `\t${text}`, '\tret', ...after))
    return result.lines.find((line) => line.inputLine === 4)!.text.trim()
}

/** The errors of one instruction inside `main`. */
function instructionErrors(text: string, ...after: string[]): TranslationDiagnostic[] {
    return errors(unit('\t.globl\tmain', 'main:', `\t${text}`, '\tret', ...after))
}

describe('the profile and the API', () => {
    it('exports the gcc-intel-v1 profile with its flag groups', () => {
        expect(GCC_INTEL_V1).toEqual({
            id: 'gcc-intel-v1',
            compiler: { name: 'GCC', version: '14.2', target: 'x86-64' },
            flags: {
                translation: [
                    '-masm=intel',
                    '-fno-pie',
                    '-fno-stack-protector',
                    '-fcf-protection=none',
                    '-fno-verbose-asm',
                ],
                locations: ['-g1'],
                target: ['-march=x86-64', '-mtune=generic'],
                language: { c: ['-std=c17'], cpp: ['-std=c++17', '-fno-exceptions', '-fno-rtti'] },
            },
            optimizations: ['0', '1', '2', '3', 's'],
        })
        expect(Object.isFrozen(GCC_INTEL_V1)).toBe(true)
        expect(Object.isFrozen(GCC_INTEL_V1.flags.language.cpp)).toBe(true)
    })

    it('throws for an unknown profile id and for nothing about the input', () => {
        expect(() => translateCompilerOutput([], { profile: 'gcc-intel-v2' as never })).toThrow(
            /Unknown compiler-output translation profile/,
        )
        expect(() => translateCompilerOutput([], undefined as never)).toThrow(/Unknown/)
        expect(() => translate(['\u0000', '"', '[[[', 'mov eax,', '.section', '#APP'])).not.toThrow()
        expect(translate(['garbage here']).ok).toBe(false)

        // Each is one line inside `main`, input line 4, and its first error is the one expected.
        const lineSeparator = String.fromCharCode(0x2028)
        const cases: [string, string][] = [
            // Words that name a property every object has, looked up (lowercased) in the
            // translator's tables of mnemonics and operand sizes.
            ['\tconstructor', 'unsupported-instruction'],
            ['\tcall\t[constructor PTR [rbx]]', 'unsupported-operand'],
            ['\tjmp\t[__proto__ PTR [rbx]]', 'unsupported-operand'],
            ['\tmov\teax, constructor PTR [rbx]', 'unsupported-operand'],
            ['\tmov\teax, __proto__ PTR [rbx]', 'unsupported-operand'],
            ['\t__proto__', 'unsupported-directive'],
            // Line breaks a regular expression's `.` stops at, inside the line.
            ['\tmov\teax,\r1', 'unreadable-line'],
            [`\tmov\teax,${lineSeparator}1`, 'unreadable-line'],
            // Thousands of labels on one line.
            ['a:'.repeat(5000), 'unsupported-directive'],
        ]
        for (const [text, code] of cases) {
            const input = unit('\t.globl\tmain', 'main:', text, '\tret')
            let result: TranslationResult | undefined
            expect(() => (result = translate(input)), text.slice(0, 40)).not.toThrow()
            expect(result!.ok, text.slice(0, 40)).toBe(false)
            expect('text' in result!).toBe(false)
            const [first] = result!.diagnostics.filter((d) => d.severity === 'error')
            expect(first, text.slice(0, 40)).toMatchObject({ code, inputLine: 4 })
            expect(first!.message).not.toMatch(/native code|\[object/)
        }
        expect(errors(unit('\tmov\teax,\r1'))[0]).toMatchObject({
            code: 'unreadable-line',
            column: 10,
            message: expect.stringContaining('U+000D'),
        })
    })

    it('translates symbols named like the properties every object has', () => {
        const output = body(
            unit(
                '\t.globl\tconstructor',
                'constructor:',
                '\tcall\t__proto__',
                '\tmov\teax, DWORD PTR toString[rip]',
                '\tret',
                '\t.data',
                'hasOwnProperty:',
                '\t.quad\tvalueOf',
            ),
        )
        expect(output).toEqual([
            'section .text',
            'global constructor',
            'constructor:',
            'call __proto__',
            'mov eax, dword [rel toString]',
            'ret',
            'section .data',
            'hasOwnProperty:',
            'dq valueOf',
        ])
    })

    it('reads any line, of printable and control characters alike, into output or Diagnostics', () => {
        // A seeded generator (mulberry32), so that a failure reproduces.
        let seed = 0x5eed
        const random = () => {
            seed = (seed + 0x6d2b79f5) | 0
            let t = Math.imul(seed ^ (seed >>> 15), seed | 1)
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
        const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
        const controls = [0, 1, 8, 10, 11, 12, 13, 27, 0x7f, 0x85, 0x9b, 0x2028, 0x2029].map((code) =>
            String.fromCharCode(code),
        )
        const printable = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index))
        const characters = [...printable, ...printable, '\t', ...controls]
        const noise = () => Array.from({ length: Math.floor(random() * 24) }, () => pick(characters)).join('')
        const shapes = [
            () => noise(),
            () => `\t${pick(['mov', 'call', 'jmp', 'lea', 'fadd', 'rep', 'constructor'])}\t${noise()}`,
            () => `\tmov\teax, ${pick(['DWORD', 'constructor', '__proto__', 'XMMWORD'])} PTR ${noise()}`,
            () =>
                `\t${pick(['.align', '.p2align', '.section', '.string', '.quad', '.loc', '.file', '.set', '.comm'])}\t${noise()}`,
            () => `${pick(['main', '.L3', '__proto__', '1', '"q"'])}:${noise()}`,
            () => `\t.string\t"${noise()}"`,
        ]
        for (let round = 0; round < 300; round += 1) {
            const lines = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(shapes)())
            const input = unit(pick(['\t.text', '\t.data', '\t.section\t.rodata']), ...lines)
            let result: TranslationResult | undefined
            expect(() => (result = translate(input)), JSON.stringify(lines)).not.toThrow()
            for (const diagnostic of result!.diagnostics) {
                expect(diagnostic.inputLine).toBeGreaterThanOrEqual(0)
                expect(diagnostic.inputLine).toBeLessThan(Math.max(input.length, 1))
                if (diagnostic.column !== undefined) expect(diagnostic.column).toBeGreaterThanOrEqual(1)
            }
            if (result!.ok) expect(result!.text.endsWith('\n')).toBe(true)
            else expect(result!.diagnostics.some((d) => d.severity === 'error')).toBe(true)
        }
    })

    it('translates nothing to just the header, with a warning that no compiler is named', () => {
        const result = translated([])
        expect(result.text).toBe('    default rel\n')
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ severity: 'warning', code: 'unverified-compiler', inputLine: 0, location: null }),
        ])
    })

    it('is byte-identical across runs', () => {
        const input = unit(
            '\t.globl\tadd',
            'add:',
            '\tlea\teax, [rdi+rsi]',
            '\tret',
            '\t.local\tn.0',
            '\t.comm\tn.0,4,4',
            '\t.section\t.rodata',
            '.LC0:',
            '\t.string\t"a`b"',
        )
        const first = translate(input)
        const second = translate([...input])
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    })

    it('imports nothing outside its own directory, so it never loads WebAssembly', () => {
        const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/compiler-output')
        const files = readdirSync(directory).filter((file) => file.endsWith('.ts'))
        expect(files).toContain('index.ts')
        for (const file of files) {
            const source = readFileSync(join(directory, file), 'utf8')
            const specifiers = [
                ...source.matchAll(/^\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/gm),
                ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
            ].map((m) => m[1]!)
            expect(source).not.toMatch(/\bimport\s*\(/)
            expect(source).not.toMatch(/\brequire\s*\(/)
            for (const specifier of specifiers) {
                expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\/[\w-]+$/)
                expect(files, `${file} imports ${specifier}`).toContain(`${specifier.slice(2)}.ts`)
            }
        }
    })
})

describe('the output contract', () => {
    it('writes the header in order: default rel, dollarhex, then externs by first appearance', () => {
        const input = unit(
            '\t.globl\tmain',
            'main:',
            '\tcall\tlater',
            '\tcall\tabs',
            '\tmov\teax, DWORD PTR si[rip]',
            '\tcall\tlater',
            '\tcall\thelper',
            '\tret',
            '\t.weak\thelper',
        )
        expect(header(input)).toEqual([
            'default rel',
            '[dollarhex off]',
            'extern later',
            'extern $abs',
            'extern $si',
            'extern helper:weak',
        ])
    })

    it('leaves dollarhex out when no name is escaped', () => {
        expect(header(unit('\t.globl\tmain', 'main:', '\tcall\tother', '\tret'))).toEqual([
            'default rel',
            'extern other',
        ])
    })

    it('puts labels at column 0 and indents everything else four spaces', () => {
        const result = translated(unit('\t.globl\tmain', 'main:', '\tret', '\t.local\tn.0', '\t.comm\tn.0,4,4'))
        expect(result.text).toBe(
            [
                '    default rel',
                '    section .text',
                '    global main',
                'main:',
                '    ret',
                '    section .bss',
                '    alignb 4',
                'n.0: resb 4',
                '    section .text',
                '',
            ].join('\n'),
        )
        expect(result.text).toBe(`${result.lines.map((line) => line.text).join('\n')}\n`)
    })

    it('gives every statement line its input line, header lines none and synthesized lines the line that needed them', () => {
        const result = translated(
            unit('\t.globl\tmain', 'main:', '\tcall\tother', '\tret', '\t.local\tn.0', '\t.comm\tn.0,4,4'),
        )
        expect(result.lines.map((line) => [line.text.trim(), line.inputLine, line.synthesized])).toEqual([
            ['default rel', null, true],
            ['extern other', null, true],
            ['section .text', 1, false],
            ['global main', 2, false],
            ['main:', 3, false],
            ['call other', 4, false],
            ['ret', 5, false],
            ['section .bss', 7, true],
            ['alignb 4', 7, true],
            ['n.0: resb 4', 7, false],
            ['section .text', 7, true],
        ])
    })

    it('collects every error in one pass, sorted by input line, with no output', () => {
        const input = unit(
            '\t.globl\tmain',
            'main:',
            '\tmov\teax, DWORD PTR fs:40',
            '\t.rept 3',
            '\tcall\tprintf@PLT',
            '\t.section\t.tbss,"awT",@nobits',
        )
        const result = translate(input)
        expect(result).toEqual({ ok: false, diagnostics: expect.any(Array) })
        expect('text' in result).toBe(false)
        expect(result.diagnostics.map((d) => [d.code, d.inputLine])).toEqual([
            ['unsupported-operand', 4],
            ['unsupported-directive', 5],
            ['unsupported-operand', 6],
            ['unsupported-section', 7],
        ])
    })

    it('gives a Diagnostic a one-based column and the location in effect', () => {
        const input = unit('\t.file 1 "src/main.c"', 'main:', '\t.loc 1 7 3', '\tcall\tputs@PLT')
        const [diagnostic] = errors(input)
        expect(diagnostic).toEqual({
            severity: 'error',
            code: 'unsupported-operand',
            message: expect.stringContaining('`@PLT`'),
            inputLine: 5,
            column: 11,
            location: { file: 'src/main.c', line: 7, column: 3 },
        })
    })

    it('keeps translating after a warning', () => {
        const result = translate([
            '\t.intel_syntax noprefix',
            '\t.text',
            'main:',
            '\tret',
            '\t.ident\t"clang version 18.1.0"',
        ])
        expect(result.ok).toBe(true)
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ severity: 'warning', code: 'unverified-compiler', inputLine: 4, column: 2 }),
        ])
    })
})

describe('operands', () => {
    it('spells sizes the NASM way', () => {
        expect(instruction('movzx\teax, BYTE PTR [rax]')).toBe('movzx eax, byte [rax]')
        expect(instruction('fnstcw\tWORD PTR [rbp-130]')).toBe('fnstcw word [rbp-130]')
        expect(instruction('mov\tDWORD PTR [rbp-4], edi')).toBe('mov dword [rbp-4], edi')
        expect(instruction('mov\trax, QWORD PTR [rbp-8]')).toBe('mov rax, qword [rbp-8]')
        expect(instruction('fld\tTBYTE PTR [rbp-16]')).toBe('fld tword [rbp-16]')
        expect(instruction('movaps\tXMMWORD PTR [rax-16], xmm0')).toBe('movaps oword [rax-16], xmm0')
    })

    it('makes RIP-relative symbols `rel` and moves a displacement symbol inside the brackets', () => {
        expect(instruction('mov\teax, DWORD PTR total[rip]')).toBe('mov eax, dword [rel total]')
        expect(instruction('mov\teax, DWORD PTR big_aligned[rip+28]')).toBe('mov eax, dword [rel big_aligned+28]')
        expect(instruction('mov\teax, DWORD PTR values[rip-8]')).toBe('mov eax, dword [rel values-8]')
        expect(instruction('mov\teax, DWORD PTR values[0+rax*4]')).toBe('mov eax, dword [values+rax*4]')
        expect(instruction('movd\txmm0, DWORD PTR table[8+rax*4]')).toBe('movd xmm0, dword [table+8+rax*4]')
        expect(instruction('movdqa\txmm0, XMMWORD PTR other[rax]')).toBe('movdqa xmm0, oword [other+rax]')
        expect(instruction('cmp\tBYTE PTR message[rax-1], 0')).toBe('cmp byte [message+rax-1], 0')
        expect(instruction('mov\trax, QWORD PTR .L8[0+rax*8]', '.L8:')).toBe('mov rax, qword [L8+rax*8]')
    })

    it('keeps base, offset, index and scale as GCC orders them', () => {
        expect(instruction('lea\teax, [rdx+9+rax]')).toBe('lea eax, [rdx+9+rax]')
        expect(instruction('lea\teax, [rax-1252+rcx]')).toBe('lea eax, [rax-1252+rcx]')
        expect(instruction('mov\tDWORD PTR [rbp-8016+rax*4], edx')).toBe('mov dword [rbp-8016+rax*4], edx')
        expect(instruction('lea\trdx, [0+rax*8]')).toBe('lea rdx, [0+rax*8]')
        expect(instruction('lea\tedx, [rdx+5+rdx*4]')).toBe('lea edx, [rdx+5+rdx*4]')
        expect(instruction('lea\tesi, [rdx+rax]')).toBe('lea esi, [rdx+rax]')
    })

    it('turns OFFSET FLAT: into the bare address, and unwraps an indirect call', () => {
        expect(instruction('mov\tedi, OFFSET FLAT:a')).toBe('mov edi, a')
        expect(instruction('mov\tedx, OFFSET FLAT:_ZTV5Shape+16')).toBe('mov edx, _ZTV5Shape+16')
        expect(instruction('mov\tQWORD PTR [rbp-16], OFFSET FLAT:text')).toBe('mov qword [rbp-16], text')
        expect(instruction('call\t[QWORD PTR [rbx]]')).toBe('call qword [rbx]')
        expect(instruction('jmp\t[QWORD PTR .L4[0+rdi*8]]', '.L4:')).toBe('jmp qword [L4+rdi*8]')
        expect(instruction('call\trdx')).toBe('call rdx')
    })

    it('reads a token before `[` or after OFFSET FLAT: as a symbol, whatever its spelling (note 1)', () => {
        expect(instruction('mov\teax, DWORD PTR si[rip]')).toBe('mov eax, dword [rel $si]')
        expect(instruction('mov\tedi, OFFSET FLAT:rax')).toBe('mov edi, $rax')
        expect(instruction('movzx\teax, BYTE PTR byte[rip]')).toBe('movzx eax, byte [rel $byte]')
    })

    it('adds the count to a one-operand shift or rotate', () => {
        expect(instruction('sar\tedx')).toBe('sar edx, 1')
        expect(instruction('sal\tDWORD PTR [rbp-4]')).toBe('sal dword [rbp-4], 1')
        expect(instruction('shr\trax, 33')).toBe('shr rax, 33')
        expect(instruction('rol\teax, cl')).toBe('rol eax, cl')
    })

    it('passes through what NASM 3.00 spells like GNU as', () => {
        expect(instruction('movabs\trdi, 1152921504606846975')).toBe('movabs rdi, 1152921504606846975')
        expect(instruction('movsx\trdx, eax')).toBe('movsx rdx, eax')
        expect(instruction('rep movsq')).toBe('rep movsq')
        expect(instruction('rep stosq')).toBe('rep stosq')
        expect(instruction('rep bsf\teax, eax')).toBe('rep bsf eax, eax')
        expect(instruction('lock xadd\tDWORD PTR [rax], edx')).toBe('lock xadd dword [rax], edx')
        expect(instruction('cvtsi2sd\txmm0, rax')).toBe('cvtsi2sd xmm0, rax')
        expect(instruction('imul\trdx, rdx, -2104705089')).toBe('imul rdx, rdx, -2104705089')
        expect(instruction('cdqe')).toBe('cdqe')
        expect(instruction('endbr64')).toBe('endbr64')
    })

    it('rejects a bare symbol outside a branch, which GNU as reads as memory and NASM as an address', () => {
        expect(instructionErrors('mov\teax, counter').map((d) => d.code)).toEqual(['unsupported-operand'])
        expect(instruction('call\tcounter')).toBe('call counter')
        expect(instruction('jne\t.L5', '.L5:')).toBe('jne L5')
    })

    it('rejects operand shapes the corpus did not show', () => {
        for (const operand of [
            'DWORD PTR values',
            'DWORD PTR [eax]',
            'DWORD PTR [rip+8]',
            'DWORD PTR [8]',
            'DWORD PTR values+8[rax]',
            'DWORD PTR [rax+rsp*2]',
            'DWORD PTR [rax*3]',
            'QWORD PTR values[rip+rax]',
            'FWORD PTR [rax]',
            'eax+1',
            'OFFSET FLAT:a+b',
            '017',
        ]) {
            expect(
                instructionErrors(`mov\teax, ${operand}`).map((d) => d.code),
                operand,
            ).toEqual(['unsupported-operand'])
        }
    })

    it('rejects relocation operators and fs: or gs: operands', () => {
        expect(instructionErrors('call\tprintf@PLT')[0]).toMatchObject({ code: 'unsupported-operand', column: 13 })
        expect(instructionErrors('mov\trax, QWORD PTR foo@GOTPCREL[rip]')[0]!.code).toBe('unsupported-operand')
        expect(instructionErrors('mov\teax, DWORD PTR fs:x@TPOFF')[0]!.message).toContain('@TPOFF')
        expect(instructionErrors('mov\trax, QWORD PTR fs:40')[0]).toMatchObject({
            code: 'unsupported-operand',
            message: expect.stringContaining('fs:'),
        })
        expect(instructionErrors('mov\trax, QWORD PTR gs:0')[0]!.code).toBe('unsupported-operand')
    })

    it('rejects expressions in operands and numeric label references', () => {
        expect(instructionErrors('mov\teax, OFFSET FLAT:a-b')[0]!.code).toBe('unsupported-operand')
        expect(instructionErrors('jmp\t1f')[0]!.code).toBe('unsupported-symbol')
    })
})

describe('x87 register forms (note 2)', () => {
    const forms: [string, string][] = [
        ['fadd\tst, st(1)', 'fadd st1'],
        ['fsub\tst, st(2)', 'fsub st2'],
        ['fsubr\tst, st(5)', 'fsubr st5'],
        ['fmul\tst, st(3)', 'fmul st3'],
        ['fdiv\tst, st(4)', 'fdiv st4'],
        ['fdivr\tst, st(1)', 'fdivr st1'],
        ['fadd\tst(1), st', 'fadd to st1'],
        ['fsub\tst(1), st', 'fsub to st1'],
        ['fsubr\tst(2), st', 'fsubr to st2'],
        ['fmul\tst(2), st', 'fmul to st2'],
        ['fdiv\tst(1), st', 'fdiv to st1'],
        ['fdivr\tst(1), st', 'fdivr to st1'],
        ['faddp\tst(1), st', 'faddp st1'],
        ['fsubp\tst(1), st', 'fsubp st1'],
        ['fsubrp\tst(2), st', 'fsubrp st2'],
        ['fmulp\tst(1), st', 'fmulp st1'],
        ['fdivp\tst(1), st', 'fdivp st1'],
        ['fdivrp\tst(1), st', 'fdivrp st1'],
        ['fcomip\tst, st(1)', 'fcomip st1'],
        ['fcomi\tst, st(5)', 'fcomi st5'],
        ['fucomip\tst, st(0)', 'fucomip st0'],
        ['fucomi\tst, st(1)', 'fucomi st1'],
        ['fxch\tst(2)', 'fxch st2'],
        ['fld\tst(3)', 'fld st3'],
        ['fstp\tst(0)', 'fstp st0'],
        ['fstp\tst(1)', 'fstp st1'],
        ['fld\tTBYTE PTR third[rip]', 'fld tword [rel third]'],
        ['fmul\tDWORD PTR .LC0[rip]', 'fmul dword [rel LC0]'],
        ['fistp\tDWORD PTR [rsp-72]', 'fistp dword [rsp-72]'],
        ['fxch', 'fxch'],
        ['fucompp', 'fucompp'],
        ['fnstsw\tax', 'fnstsw ax'],
        ['fchs', 'fchs'],
    ]
    for (const [gnu, nasm] of forms) {
        it(`${gnu.replace('\t', ' ')} becomes ${nasm}`, () => {
            expect(instruction(gnu, '.LC0:')).toBe(nasm)
        })
    }

    it('rejects every other register form, the matrix covering none of them', () => {
        for (const form of [
            'faddp',
            'fsubrp',
            'fadd\tst(1)',
            'fsubp\tst, st(1)',
            'fsub\tst(1), st(2)',
            'fcomi\tst(1), st',
            'fcomip\tst(1)',
            'fcmove\tst, st(1)',
            'fxch\tst(1), st',
            'call\tst',
        ]) {
            expect(
                instructionErrors(form).map((d) => d.code),
                form,
            ).toEqual(['unsupported-instruction'])
        }
    })
})

describe('labels and names', () => {
    it('renames .L labels, which NASM would scope to the previous label (note 3)', () => {
        expect(
            body(
                unit(
                    'main:',
                    '\tjmp\t.L4',
                    '.L4:',
                    '\tmovsd\txmm0, QWORD PTR .LC0[rip]',
                    '\tret',
                    '\t.section\t.rodata',
                    '.LC0:',
                    '\t.long\t1',
                ),
            ),
        ).toEqual([
            'section .text',
            'main:',
            'jmp L4',
            'L4:',
            'movsd xmm0, qword [rel LC0]',
            'ret',
            'section .rodata',
            'LC0:',
            'dd 1',
        ])
    })

    it('prepends `_` until a renamed label differs from every name of the unit', () => {
        const lines = body(
            unit(
                '\t.globl\tL4',
                'L4:',
                '\tret',
                '\t.globl\t_L4',
                '_L4:',
                '\tjmp\t.L4',
                '.L4:',
                '\tcall\t__L4x',
                '\tret',
            ),
        )
        expect(lines).toContain('__L4:')
        expect(lines).toContain('jmp __L4')
        expect(lines).toContain('L4:')
        expect(lines).toContain('_L4:')
    })

    it('drops the debug labels GCC writes for DWARF and call frames', () => {
        expect(
            body(
                unit(
                    '.Ltext0:',
                    'main:',
                    '.LFB0:',
                    '\tnop',
                    '.LBB2:',
                    '.LVL0:',
                    '\tnop',
                    '.LBE2:',
                    '\tret',
                    '.LFE0:',
                    '.Letext0:',
                    '\t.section\t.debug_info,"",@progbits',
                    '.Ldebug_info0:',
                    '\t.long\t0x7f',
                    '\t.quad\t.Ltext0',
                    '.LASF0:',
                    '\t.string\t"main"',
                ),
            ),
        ).toEqual(['section .text', 'main:', 'nop', 'nop', 'ret'])
    })

    it('escapes the C names NASM reserves (note 4)', () => {
        const names = ['add', 'div', 'abs', 'byte', 'rel', 'si', 'ptr', 'section', 'times', 'st0', 'xmm16']
        // GNU as reads `si` and `xmm16` alone as registers, so GCC only ever names them before `[`.
        const registers = new Set(['si', 'xmm16'])
        const lines = names.flatMap((name) => [`\t.globl\t${name}`, `${name}:`, '\tret'])
        const uses = names.map((name) => (registers.has(name) ? `\tlea\trax, ${name}[rip]` : `\tcall\t${name}`))
        const output = body(unit(...lines, '\t.globl\tmain', 'main:', ...uses, '\tret'))
        for (const name of names) {
            expect(output).toContain(`global $${name}`)
            expect(output).toContain(`$${name}:`)
            expect(output).toContain(registers.has(name) ? `lea rax, [rel $${name}]` : `call $${name}`)
        }
        expect(header(unit(...lines))).toEqual(['default rel', '[dollarhex off]'])
    })

    it('escapes from a table generated from NASM 3.00 itself', () => {
        expect(NASM_RESERVED_NAMES).toEqual([...NASM_RESERVED_NAMES].sort())
        for (const name of [
            'add',
            'movabs',
            'rax',
            'st7',
            'xmm31',
            'rel',
            'wrt',
            'ptr',
            'dup',
            'global',
            'section',
            'db',
            'osabi',
            '__sect__',
        ]) {
            expect(NASM_RESERVED_NAMES, name).toContain(name)
        }
        for (const name of ['main', 'count', 'z', 'sae', 'limit', 'st'])
            expect(NASM_RESERVED_NAMES, name).not.toContain(name)
    })

    it('escapes names in data, memory operands and the header alike', () => {
        const result = translated(
            unit(
                '\t.globl\tmain',
                'main:',
                '\tmov\teax, DWORD PTR rel[rip]',
                '\tcall\tabs',
                '\tret',
                '\t.section\t.rodata',
                'table:',
                '\t.quad\tdiv+8',
            ),
        )
        expect(result.text).toContain('extern $rel\n')
        expect(result.text).toContain('mov eax, dword [rel $rel]')
        expect(result.text).toContain('dq $div+8')
        expect(result.symbols.external).toEqual([
            { name: 'rel', nasmName: '$rel', weak: false },
            { name: 'abs', nasmName: '$abs', weak: false },
            { name: 'div', nasmName: '$div', weak: false },
        ])
    })

    it('rejects a register-spelled operand when the unit has a symbol of that name', () => {
        const input = unit('\t.globl\tsi', 'si:', '\tret', '\t.globl\tmain', 'main:', '\tcall\tsi', '\tret')
        expect(errors(input)).toEqual([
            expect.objectContaining({
                code: 'ambiguous-register-name',
                inputLine: 7,
                column: 7,
                message: expect.stringContaining('`si`'),
            }),
        ])
        expect(errorCodes(unit('main:', '\tmov\tax, si', '\tret', '\t.data', 'si:', '\t.long\t3'))).toEqual([
            ['ambiguous-register-name', 3],
        ])
        expect(instruction('mov\tax, si')).toBe('mov ax, si')
        // A register the translator rejects anyway is still an ambiguity first, when a symbol has its name.
        expect(errorCodes(unit('main:', '\tcall\tk1', '\tret', '\t.globl\tk1', 'k1:', '\tret'))).toEqual([
            ['ambiguous-register-name', 3],
        ])
        expect(errorCodes(unit('main:', '\tcall\tk1', '\tret'))).toEqual([['unsupported-instruction', 3]])
    })

    it('rejects numeric labels and names NASM would read differently', () => {
        expect(errorCodes(unit('1:', '\tjmp\t1b'))).toEqual([
            ['unsupported-symbol', 2],
            ['unsupported-symbol', 3],
        ])
        expect(errorCodes(unit('.Lok:', '.weird:', '\tret'))).toEqual([['unsupported-symbol', 3]])
        expect(errorCodes(unit('"quoted name":'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('main:', '\tjmp\t.L9'))).toEqual([['unsupported-symbol', 3]])
        expect(errorCodes(unit('main:', '\tcall\t$foo', '\tcall\t.weird', '\tlea\trax, .odd[rip]'))).toEqual([
            ['unsupported-symbol', 3],
            ['unsupported-symbol', 4],
            ['unsupported-symbol', 5],
        ])
        expect(errorCodes(unit('dup:', 'dup:'))).toEqual([['unsupported-symbol', 3]])
    })

    it('rejects a reference to a label the translation drops', () => {
        expect(errorCodes(unit('main:', '.LFB0:', '\tmov\tedi, OFFSET FLAT:.LFB0', '\tret'))).toEqual([
            ['unsupported-symbol', 4],
        ])
    })
})

describe('directives that only describe', () => {
    it('drops .file, .loc, .ident, .cfi_*, .intel_syntax, .size, .type, .hidden and the GNU-stack note', () => {
        expect(
            body([
                '\t.file\t"example.c"',
                '\t.intel_syntax noprefix',
                '\t.text',
                '\t.file 0 "/app" "/app/example.c"',
                '\t.globl\tmain',
                '\t.hidden\tmain',
                '\t.type\tmain, @function',
                'main:',
                '\t.file 1 "src/main.c"',
                '\t.loc 1 4 16',
                '\t.cfi_startproc',
                '\tpush\trbp',
                '\t.cfi_def_cfa_offset 16',
                '\t.cfi_offset 6, -16',
                '\tpop\trbp',
                '\t.cfi_def_cfa 7, 8',
                '\tret',
                '\t.cfi_endproc',
                '\t.size\tmain, .-main',
                '\t.data',
                '\t.type\tcount, @object',
                '\t.size\tcount, 4',
                'count:',
                '\t.long\t1',
                IDENT,
                '\t.section\t.note.GNU-stack,"",@progbits',
            ]),
        ).toEqual([
            'section .text',
            'global main',
            'main:',
            'push rbp',
            'pop rbp',
            'ret',
            'section .data',
            'count:',
            'dd 1',
        ])
    })

    it('drops debug sections and .note.gnu.property whole, numeric labels and expressions included', () => {
        const input = unit(
            'main:',
            '\tendbr64',
            '\tret',
            '\t.section\t.debug_abbrev,"",@progbits',
            '\t.uleb128 0x1',
            '\t.sleb128 -8',
            '\t.section\t.note.gnu.property,"a"',
            '\t.align 8',
            '\t.long\t1f - 0f',
            '\t.long\t4f - 1f',
            '\t.long\t5',
            '0:',
            '\t.string\t"GNU"',
            '1:',
            '\t.align 8',
            '\t.long\t0xc0000002',
            '\t.long\t3f - 2f',
            '2:',
            '\t.long\t0x3',
            '3:',
            '\t.align 8',
            '4:',
        )
        expect(body(input)).toEqual(['section .text', 'main:', 'endbr64', 'ret'])
    })

    it('warns when .ident is missing or names anything but GCC 14.2', () => {
        const warning = (input: string[]) =>
            translated(input).diagnostics.filter((d) => d.code === 'unverified-compiler')
        expect(warning(['\t.text', 'main:', '\tret'])).toHaveLength(1)
        expect(warning(['\t.text', '\t.ident\t"GCC: (GNU) 13.2.0"'])[0]).toMatchObject({
            inputLine: 1,
            severity: 'warning',
        })
        expect(warning(['\t.text', '\t.ident\t"GCC: (Ubuntu 14.2.0-4ubuntu2~24.04) 14.2.0"'])).toEqual([])
        expect(warning(['\t.text', '\t.ident\t"GCC: (GNU) 14.2.1 20240910"'])).toEqual([])
        expect(warning(['\t.text', '\t.ident\t"GCC: (GNU) 14.20.0"'])).toHaveLength(1)
        expect(warning(['\t.text', '\t.ident\t"Ubuntu clang version 18.1.3"'])).toHaveLength(1)
    })

    it('rejects syntax and directives outside the rules', () => {
        expect(errorCodes(['\t.intel_syntax prefix'])).toEqual([['unsupported-directive', 0]])
        expect(errorCodes(['\t.att_syntax'])).toEqual([['unsupported-directive', 0]])
        for (const directive of [
            '.rept 4',
            '.org 16',
            '.symver foo,foo@VER_1',
            '.uleb128 1',
            '.balign 8',
            '.previous',
            '.pushsection .data',
            '.equ x, 1',
            '.lcomm x,4',
            '.weakref a, b',
            '.bogus',
        ]) {
            expect(errorCodes(unit(`\t${directive}`)), directive).toEqual([['unsupported-directive', 2]])
        }
        expect(errorCodes(unit('x = 4'))).toEqual([['unsupported-directive', 2]])
    })

    it('rejects comments, which -fno-verbose-asm leaves out, and several statements on a line', () => {
        expect(errors(unit('main:', '\tret\t# done'))[0]).toMatchObject({
            code: 'unsupported-directive',
            inputLine: 3,
            column: 6,
        })
        expect(errorCodes(unit('# tmp123'))).toEqual([['unsupported-directive', 2]])
        expect(errors(unit('main:', '\tnop; ret'))[0]).toMatchObject({
            code: 'unsupported-directive',
            inputLine: 3,
            column: 5,
        })
        expect(errorCodes(unit('main: ret'))).toEqual([['unsupported-directive', 2]])
        expect(body(unit('\t.section\t.rodata', 'text:', '\t.string\t"a;b#c"'))).toContain('db `a;b#c`, 0')
    })

    it('rejects a line with a control character or line break inside it, at that character', () => {
        for (const code of [0x00, 0x01, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) {
            const character = String.fromCharCode(code)
            const [diagnostic, ...others] = errors(unit('main:', `\tmov\teax, ${character}1`, '\tret'))
            expect(others, code.toString(16)).toEqual([])
            expect(diagnostic, code.toString(16)).toMatchObject({
                code: 'unreadable-line',
                inputLine: 3,
                column: 11,
                message: expect.stringContaining(`U+${code.toString(16).toUpperCase().padStart(4, '0')}`),
            })
        }
        // A tab is read anywhere, and a carriage return that ends the line is a CRLF line ending.
        expect(body(unit('main:\r', '\tmov\teax,\t1\r', '\tret\r'))).toEqual([
            'section .text',
            'main:',
            'mov eax, 1',
            'ret',
        ])
    })

    it('rejects inline assembly between #APP and #NO_APP at the #APP line', () => {
        const input = unit(
            'main:',
            '#APP',
            '# 5 "src/main.c" 1',
            '\tsyscall',
            '\t.bogus',
            '# 0 "" 2',
            '#NO_APP',
            '\tret',
        )
        expect(errors(input)).toEqual([expect.objectContaining({ code: 'inline-assembly', inputLine: 3, column: 1 })])
    })
})

describe('sections', () => {
    it('flattens section families into the four NASM sections', () => {
        expect(
            body(
                unit(
                    '\t.section\t.text.startup,"ax",@progbits',
                    '\t.section\t.text.unlikely,"ax",@progbits',
                    '\t.section\t.text._ZN5ShapeD2Ev,"axG",@progbits,_ZN5ShapeD5Ev,comdat',
                    '\t.section\t.rodata',
                    '\t.section\t.rodata.str1.1,"aMS",@progbits,1',
                    '\t.section\t.rodata.cst16,"aM",@progbits,16',
                    '\t.section\t.rodata._ZTV4Rect,"aG",@progbits,_ZTV4Rect,comdat',
                    '\t.section\t.data.rel.ro.local,"aw"',
                    '\t.section\t.data.counter,"aw"',
                    '\t.section\t.data._ZN8RegistryIiE5countE,"awG",@progbits,_ZN8RegistryIiE5countE,comdat',
                    '\t.section\t.bss.big,"aw",@nobits',
                    '\t.data',
                    '\t.bss',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .text',
            'section .text',
            'section .text',
            'section .rodata',
            'section .rodata',
            'section .rodata',
            'section .rodata',
            'section .rodata',
            'section .data',
            'section .data',
            'section .bss',
            'section .data',
            'section .bss',
        ])
    })

    it('keeps .init_array as a section and lists its constructors (note 6)', () => {
        const result = translated(
            unit(
                '_GLOBAL__sub_I_seven:',
                '.Lctor:',
                '\tret',
                '\t.section\t.init_array,"aw"',
                '\t.align 8',
                '\t.quad\t_GLOBAL__sub_I_seven',
                '\t.quad\t.Lctor',
            ),
        )
        expect(result.text).toContain(
            '    section .init_array\n    align 8, db 0\n    dq _GLOBAL__sub_I_seven\n    dq Lctor\n',
        )
        expect(result.symbols.constructors).toEqual([
            { name: '_GLOBAL__sub_I_seven', nasmName: '_GLOBAL__sub_I_seven' },
            { name: '.Lctor', nasmName: 'Lctor' },
        ])
        expect(errorCodes(unit('\t.section\t.init_array,"aw"', '\t.quad\t0'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.section\t.init_array,"aw"', '\t.long\tctor'))).toEqual([['unsupported-section', 3]])
    })

    it('rejects the sections version 1 has no rules for', () => {
        for (const section of [
            '.tdata,"awT",@progbits',
            '.tbss,"awT",@nobits',
            '.fini_array,"aw"',
            '.preinit_array,"aw"',
            '.init_array.00101,"aw"',
            '.ctors,"aw",@progbits',
            '.dtors,"aw",@progbits',
            '.comment',
            '.eh_frame,"a",@progbits',
            '.lbss,"aw",@nobits',
            '.text.hot,"awx",@progbits',
            '.rodata.x,"aw",@progbits',
            '.bss.x,"aw",@progbits',
            '".text.quoted"',
        ]) {
            expect(errorCodes(unit(`\t.section\t${section}`)), section).toEqual([['unsupported-section', 2]])
        }
        expect(errorCodes(unit('\t.text 1'))).toEqual([['unsupported-directive', 2]])
    })

    it('rejects a .note.GNU-stack asking for an executable stack, and drops the ordinary one', () => {
        // GCC writes "x" when a nested function's trampoline runs on the stack.
        const [diagnostic] = errors(unit('\t.section\t.note.GNU-stack,"x",@progbits'))
        expect(diagnostic).toMatchObject({
            code: 'unsupported-section',
            inputLine: 2,
            column: 27,
            message: expect.stringContaining('executable stack'),
        })
        expect(body(unit('main:', '\tret', '\t.section\t.note.GNU-stack,"",@progbits'))).toEqual([
            'section .text',
            'main:',
            'ret',
        ])
    })

    it('rejects instructions outside code and data inside it', () => {
        expect(errorCodes(unit('\t.data', '\tret'))).toEqual([['unsupported-section', 3]])
        expect(errorCodes(unit('\t.long\t1'))).toEqual([['unsupported-section', 2]])
        expect(errorCodes(unit('\t.bss', '\t.long\t1'))).toEqual([['unsupported-section', 3]])
    })

    it('declares the largest alignment of a section on its first declaration only', () => {
        expect(
            body(
                unit(
                    '\t.data',
                    '\t.align 4',
                    'a:',
                    '\t.long\t1',
                    '\t.text',
                    '\t.data',
                    '\t.align 64',
                    'b:',
                    '\t.long\t2',
                    '\t.section\t.rodata',
                    '\t.align 4',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .data align=64',
            'align 4, db 0',
            'a:',
            'dd 1',
            'section .text',
            'section .data',
            'align 64, db 0',
            'b:',
            'dd 2',
            'section .rodata',
            'align 4, db 0',
        ])
    })
})

describe('data', () => {
    it('translates each data directive to its NASM width', () => {
        expect(
            body(
                unit(
                    '\t.data',
                    '\t.byte\t1, -1, 255',
                    '\t.value\t-32768',
                    '\t.short\t65535',
                    '\t.word\t2',
                    '\t.long\t1078530011, -5',
                    '\t.int\t7',
                    '\t.quad\t1234567890123',
                    '\t.quad\t-1',
                    '\t.long\t0x7f',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .data',
            'db 1, -1, 255',
            'dw -32768',
            'dw 65535',
            'dw 2',
            'dd 1078530011, -5',
            'dd 7',
            'dq 1234567890123',
            'dq -1',
            'dd 0x7f',
        ])
    })

    it('translates symbols plus or minus an integer, and nothing more complex', () => {
        expect(
            body(
                unit(
                    '\t.section\t.rodata',
                    '\t.align 8',
                    '.L4:',
                    '\t.quad\t.L12',
                    '\t.quad\t_ZTV4Rect+16',
                    '\t.quad\tbase-8',
                    '.L12:',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .rodata align=8',
            'align 8, db 0',
            'L4:',
            'dq L12',
            'dq _ZTV4Rect+16',
            'dq base-8',
            'L12:',
        ])
        expect(errorCodes(unit('\t.section\t.rodata', '\t.long\t.L5-.L4'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.data', '\t.long\t1+2'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.data', '\t.long\t010'))).toEqual([['unsupported-operand', 3]])
    })

    it('rejects a value that does not fit the width', () => {
        expect(errorCodes(unit('\t.data', '\t.byte\t256'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.data', '\t.byte\t-129'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.data', '\t.value\t65536'))).toEqual([['unsupported-operand', 3]])
        expect(errorCodes(unit('\t.data', '\t.long\t4294967296'))).toEqual([['unsupported-operand', 3]])
        expect(body(unit('\t.data', '\t.quad\t18446744073709551615'))).toContain('dq 18446744073709551615')
    })

    it('reserves zeroes in .bss and writes them elsewhere', () => {
        expect(body(unit('\t.bss', '\t.zero\t64', '\t.data', '\t.zero\t3'))).toEqual([
            'section .text',
            'section .bss',
            'resb 64',
            'section .data',
            'times 3 db 0',
        ])
    })

    it('writes strings as backquote strings with the same bytes (note 7)', () => {
        expect(
            body(
                unit(
                    '\t.section\t.rodata',
                    '\t.string\t"tab\\there\\nquote\\"back\\\\slash`tick\\001\\377"',
                    '\t.asciz\t"z"',
                    '\t.ascii\t"no terminator"',
                    '\t.ascii\t"a\\0b"',
                    '\t.string\t""',
                    '\t.ascii\t""',
                    '\t.string\t"one", "two"',
                    '\t.string\t"\\x41\\b\\f\\r\\101%d$"',
                    '\t.string\t"café"',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .rodata',
            'db `tab\\there\\nquote"back\\\\slash\\`tick\\001\\377`, 0',
            'db `z`, 0',
            'db `no terminator`',
            'db `a\\000b`',
            'db ``, 0',
            'db ``',
            'db `one`, 0, `two`, 0',
            'db `A\\b\\f\\rA%d$`, 0',
            'db `caf\\303\\251`, 0',
        ])
    })

    it('encodes a character outside the BMP, two UTF-16 units, as its four UTF-8 bytes', () => {
        const grinning = String.fromCodePoint(0x1f600)
        expect(body(unit('\t.section\t.rodata', `\t.string\t"${grinning}"`, `\t.ascii\t"a${grinning}b"`))).toEqual([
            'section .text',
            'section .rodata',
            'db `\\360\\237\\230\\200`, 0',
            'db `a\\360\\237\\230\\200b`',
        ])
    })

    it('rejects strings GNU as and NASM could read differently', () => {
        for (const string of ['"\\q"', '"\\x123"', '"\\18"', '"\\400"', 'abc', '"unterminated']) {
            expect(errorCodes(unit('\t.section\t.rodata', `\t.string\t${string}`)), string).toEqual([
                ['unsupported-directive', 3],
            ])
        }
    })

    it('rejects data where only zeroes or constructors belong', () => {
        expect(errorCodes(unit('\t.bss', '\t.string\t"x"'))).toEqual([['unsupported-section', 3]])
        expect(errorCodes(unit('\t.string\t"x"'))).toEqual([['unsupported-section', 2]])
    })
})

describe('alignment (note 8)', () => {
    it('writes .align N and .p2align N as 2^N bytes, with alignb in .bss', () => {
        expect(body(unit('\t.data', '\t.p2align 3', '\t.align 2', '\t.bss', '\t.align 32', '\t.p2align 2'))).toEqual([
            'section .text',
            'section .data align=8',
            'align 8, db 0',
            'align 2, db 0',
            'section .bss align=32',
            'alignb 32',
            'alignb 4',
        ])
    })

    it('keeps code alignment before a function, padded with NOPs, as GCC writes it at -O2', () => {
        const lines = translated(
            unit(
                '\t.p2align 4',
                '\t.globl\tmain',
                '\t.type\tmain, @function',
                'main:',
                '.LFB0:',
                '\tret',
                '\t.section\t.text._ZN7Counter3addEi,"axG",@progbits,_ZN7Counter3addEi,comdat',
                '\t.align 2',
                '\t.p2align 4',
                '\t.weak\t_ZN7Counter3addEi',
                '\t.type\t_ZN7Counter3addEi, @function',
                '_ZN7Counter3addEi:',
                '\tmov\teax, esi',
                '\tret',
            ),
        ).lines.filter((line) => line.inputLine !== null)
        expect(lines.map((line) => [line.text.trim(), line.inputLine])).toEqual([
            ['section .text', 1],
            ['align 16', 2],
            ['global main', 3],
            ['main:', 5],
            ['ret', 7],
            ['section .text', 8],
            ['align 2', 9],
            ['align 16', 10],
            ['global _ZN7Counter3addEi:weak', 11],
            ['_ZN7Counter3addEi:', 13],
            ['mov eax, esi', 14],
            ['ret', 15],
        ])
        // An alignment line is a statement line of its own, not a synthesized one, with no location.
        expect(lines.filter((line) => line.text.trim().startsWith('align')).every((line) => !line.synthesized)).toBe(
            true,
        )
    })

    it('keeps the alignment of an aligned(N) function, with the code section aligned to match', () => {
        expect(body(unit('before:', '\tret', '\t.align 64', '\t.globl\tsixty_four', 'sixty_four:', '\tret'))).toEqual([
            'section .text align=64',
            'before:',
            'ret',
            'align 64',
            'global sixty_four',
            'sixty_four:',
            'ret',
        ])
        // Up to 16, NASM's own alignment of `.text`, the section needs no attribute.
        expect(body(unit('\t.p2align 4', 'f:', '\tret'))).toEqual(['section .text', 'align 16', 'f:', 'ret'])
    })

    it('drops loop and jump-target alignment: a maximum skip, or only .L labels before the next instruction', () => {
        expect(
            body(
                unit(
                    'sum:',
                    '\txor\teax, eax',
                    '\t.p2align 5',
                    '\t.p2align 4',
                    '\t.p2align 3',
                    '.L5:',
                    '\tadd\teax, DWORD PTR [rdi]',
                    '\tjne\t.L5',
                    '\t.p2align 4,,10',
                    '\t.p2align 3',
                    '.L6:',
                    '.LBE9:',
                    '\tret',
                    '\t.p2align 4,,15',
                    '\t.globl\tskipped',
                    'skipped:',
                    '\tret',
                    '\t.p2align 4',
                    '\tnop',
                    '\t.p2align 4',
                ),
            ),
        ).toEqual([
            'section .text',
            'sum:',
            'xor eax, eax',
            'L5:',
            'add eax, dword [rdi]',
            'jne L5',
            'L6:',
            'ret',
            'global skipped',
            'skipped:',
            'ret',
            'nop',
        ])
    })

    it("keeps a function's alignment across GCC's hot and cold partitioning", () => {
        // GCC 15.2 at -O2: a member function with a cold path. Its `.p2align 4` and its label have a
        // switch to `.text.unlikely`, a `.L` label there and a switch back between them, and every
        // code section flattens into one, so the label still lands where the alignment pads to.
        expect(
            body(
                unit(
                    '\t.section\t.text.unlikely,"ax",@progbits',
                    '\t.globl\t_Z4faili',
                    '\t.type\t_Z4faili, @function',
                    '_Z4faili:',
                    '\tud2',
                    '\t.size\t_Z4faili, .-_Z4faili',
                    '\t.align 2',
                    '.LCOLDB0:',
                    '\t.text',
                    '.LHOTB0:',
                    '\t.align 2',
                    '\t.p2align 4',
                    '\t.section\t.text.unlikely',
                    '.Ltext_cold0:',
                    '\t.text',
                    '\t.globl\t_ZN7Checker5checkEPii',
                    '\t.type\t_ZN7Checker5checkEPii, @function',
                    '_ZN7Checker5checkEPii:',
                    '.LFB2:',
                    '\tmov\trcx, rdi',
                    '\tret',
                ),
            ),
        ).toEqual([
            'section .text',
            'section .text',
            'global _Z4faili',
            '_Z4faili:',
            'ud2',
            'align 2',
            'LCOLDB0:',
            'section .text',
            'LHOTB0:',
            'align 2',
            'align 16',
            'section .text',
            'Ltext_cold0:',
            'section .text',
            'global _ZN7Checker5checkEPii',
            '_ZN7Checker5checkEPii:',
            'mov rcx, rdi',
            'ret',
        ])
    })

    it('pads with a fill value given in code, which must fit in a byte', () => {
        expect(body(unit('\t.p2align 4,0x90', 'f:', '\tret'))).toEqual([
            'section .text',
            'align 16, db 0x90',
            'f:',
            'ret',
        ])
        expect(errorCodes(unit('\t.p2align 4,256', 'f:', '\tret'))).toEqual([['unsupported-directive', 2]])
    })

    it('rejects maximum skips and fills outside code, and alignments that are not powers of two', () => {
        expect(errorCodes(unit('\t.data', '\t.p2align 4,,10'))).toEqual([['unsupported-directive', 3]])
        expect(errorCodes(unit('\t.data', '\t.align 8,0'))).toEqual([['unsupported-directive', 3]])
        expect(errorCodes(unit('\t.data', '\t.align 12'))).toEqual([['unsupported-directive', 3]])
        expect(errorCodes(unit('\t.align 3'))).toEqual([['unsupported-directive', 2]])
        expect(errorCodes(unit('\t.p2align x'))).toEqual([['unsupported-directive', 2]])
    })
})

describe('symbols', () => {
    it('reserves a local common in .bss around it, and declares a global one common', () => {
        expect(
            body(
                unit(
                    'main:',
                    '\tret',
                    '\t.local\tn.0',
                    '\t.comm\tn.0,4,4',
                    '\t.comm\tcalls,8,8',
                    '\t.section\t.rodata',
                    '\t.local\tbig',
                    '\t.comm\tbig,64,32',
                ),
            ),
        ).toEqual([
            'section .text',
            'main:',
            'ret',
            'section .bss align=32',
            'alignb 4',
            'n.0: resb 4',
            'section .text',
            'common calls 8:8',
            'section .rodata',
            'section .bss',
            'alignb 32',
            'big: resb 64',
            'section .rodata',
        ])
        const result = translated(unit('\t.local\tx', '\t.comm\tx,4,4', '\t.comm\tsi,4,4'))
        expect(result.symbols.common).toEqual([{ name: 'si', nasmName: '$si' }])
        expect(result.text).toContain('    common $si 4:4\n')
        expect(header(unit('\t.comm\tsi,4,4'))).toEqual(['default rel', '[dollarhex off]'])
    })

    it('rejects a common symbol without a size and power-of-two alignment, or with a binding', () => {
        expect(errorCodes(unit('\t.comm\tx,4'))).toEqual([['unsupported-directive', 2]])
        expect(errorCodes(unit('\t.comm\tx,4,3'))).toEqual([['unsupported-directive', 2]])
        expect(errorCodes(unit('\t.weak\tx', '\t.comm\tx,4,4'))).toEqual([['unsupported-symbol', 3]])
        expect(errorCodes(unit('x:', '\t.comm\tx,4,4'))).toEqual([['unsupported-symbol', 3]])
        expect(errorCodes(unit('\t.local\tx', '\t.globl\tx', 'x:'))).toEqual([['unsupported-symbol', 3]])
    })

    it('makes .globl and .weak definitions global, and weak ones weak', () => {
        const result = translated(
            unit(
                '\t.globl\tmain',
                'main:',
                '\tret',
                '\t.weak\t_ZN5ShapeD2Ev',
                '_ZN5ShapeD2Ev:',
                '\tret',
                'local:',
                '\tret',
            ),
        )
        expect(body(unit('\t.globl\tmain', 'main:', '\t.weak\tw', 'w:'))).toEqual([
            'section .text',
            'global main',
            'main:',
            'global w:weak',
            'w:',
        ])
        expect(result.symbols.defined).toEqual([
            { name: 'main', nasmName: 'main', binding: 'global' },
            { name: '_ZN5ShapeD2Ev', nasmName: '_ZN5ShapeD2Ev', binding: 'weak' },
        ])
    })

    it('makes an undefined .weak an `extern :weak` and an undefined .globl an `extern`, even in a debug section (note 9)', () => {
        const input = unit(
            'main:',
            '\tcall\t__divti3',
            '\tret',
            '\t.section\t.rodata',
            '\t.quad\t__cxa_pure_virtual',
            '\t.weak\t__cxa_pure_virtual',
            '\t.weak\tunused',
            '\t.section\t.debug_line_str,"MS",@progbits,1',
            '\t.string\t"/app"',
            '\t.globl\t__divti3',
            '\t.globl\t__modti3',
        )
        const result = translated(input)
        expect(header(input)).toEqual([
            'default rel',
            'extern __divti3',
            'extern __cxa_pure_virtual:weak',
            'extern unused:weak',
            'extern __modti3',
        ])
        expect(result.lines.filter((line) => line.text.includes('global'))).toEqual([])
        expect(result.symbols.external).toEqual([
            { name: '__divti3', nasmName: '__divti3', weak: false },
            { name: '__cxa_pure_virtual', nasmName: '__cxa_pure_virtual', weak: true },
        ])
    })

    it('rejects a .globl of an assembler-local label and of a label only a dropped section defines', () => {
        expect(errorCodes(unit('\t.globl\t.L3', '.L3:'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.globl\tinfo', '\t.section\t.debug_info,"",@progbits', 'info:'))).toEqual([
            ['unsupported-symbol', 2],
        ])
        expect(errorCodes(unit('\t.globl\ta, b'))).toEqual([['unsupported-directive', 2]])
    })

    it('puts an alias label right after its target label', () => {
        const input = unit(
            '\t.section\t.text._ZN7CounterC2Ei,"axG",@progbits,_ZN7CounterC5Ei,comdat',
            '\t.align 2',
            '\t.weak\t_ZN7CounterC2Ei',
            '_ZN7CounterC2Ei:',
            '\tmov\tDWORD PTR [rdi], esi',
            '\tret',
            '\t.weak\t_ZN7CounterC1Ei',
            '\t.set\t_ZN7CounterC1Ei,_ZN7CounterC2Ei',
            '\t.set\tchained,_ZN7CounterC1Ei',
            '\t.globl\tmain',
            'main:',
            '\tcall\t_ZN7CounterC1Ei',
            '\tret',
        )
        const result = translated(input)
        expect(
            result.lines.filter((line) => line.inputLine !== null).map((line) => [line.text.trim(), line.inputLine]),
        ).toEqual([
            ['section .text', 1],
            ['section .text', 2],
            ['align 2', 3],
            ['global _ZN7CounterC2Ei:weak', 4],
            ['_ZN7CounterC2Ei:', 5],
            ['_ZN7CounterC1Ei:', 9],
            ['chained:', 10],
            ['mov dword [rdi], esi', 6],
            ['ret', 7],
            ['global _ZN7CounterC1Ei:weak', 8],
            ['global main', 11],
            ['main:', 12],
            ['call _ZN7CounterC1Ei', 13],
            ['ret', 14],
        ])
        expect(result.symbols.defined.map((symbol) => [symbol.name, symbol.binding])).toEqual([
            ['_ZN7CounterC2Ei', 'weak'],
            ['_ZN7CounterC1Ei', 'weak'],
            ['main', 'global'],
        ])
    })

    it('rejects a .set that is not an alias of a label in the same output', () => {
        expect(errorCodes(unit('\t.set\ta, 5'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.set\ta, b+8', 'b:'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.set\ta, elsewhere'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.set\ta, b', '\t.set\tb, a'))).toEqual([
            ['unsupported-symbol', 2],
            ['unsupported-symbol', 3],
        ])
        expect(errorCodes(unit('\t.set\ta, x', '\t.local\tx', '\t.comm\tx,4,4'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('a:', '\t.set\ta, b', 'b:'))).toEqual([['unsupported-symbol', 3]])
    })

    it('rejects .type forms other than @function and @object, and visibility other than .hidden', () => {
        expect(errorCodes(unit('\t.type\tadder, @gnu_indirect_function'))).toEqual([['unsupported-symbol', 2]])
        expect(errors(unit('\t.type\tadder, @gnu_indirect_function'))[0]!.message).toContain('resolver')
        expect(errorCodes(unit('\t.type\tx, @tls_object'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.type\tx, %function'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.protected\tx'))).toEqual([['unsupported-symbol', 2]])
        expect(errorCodes(unit('\t.internal\tx'))).toEqual([['unsupported-symbol', 2]])
    })

    it('translates a weak @gnu_unique_object as a weak object (gate 7)', () => {
        const input = unit(
            '\t.weak\t_ZN8RegistryIiE5countE',
            '\t.section\t.data._ZN8RegistryIiE5countE,"awG",@progbits,_ZN8RegistryIiE5countE,comdat',
            '\t.align 4',
            '\t.type\t_ZN8RegistryIiE5countE, @gnu_unique_object',
            '\t.size\t_ZN8RegistryIiE5countE, 4',
            '_ZN8RegistryIiE5countE:',
            '\t.long\t3',
        )
        const result = translated(input)
        expect(body(input)).toEqual([
            'section .text',
            'global _ZN8RegistryIiE5countE:weak',
            'section .data',
            'align 4, db 0',
            '_ZN8RegistryIiE5countE:',
            'dd 3',
        ])
        expect(result.symbols.defined).toEqual([
            { name: '_ZN8RegistryIiE5countE', nasmName: '_ZN8RegistryIiE5countE', binding: 'weak' },
        ])
    })

    it('rejects a @gnu_unique_object that is not weak, and every one under the rejecting rule', () => {
        expect(
            errorCodes(unit('\t.globl\tx', '\t.data', '\t.type\tx, @gnu_unique_object', 'x:', '\t.long\t1')),
        ).toEqual([['unsupported-symbol', 4]])
        const weak = unit('\t.weak\tx', '\t.data', '\t.type\tx, @gnu_unique_object', 'x:', '\t.long\t1')
        const rejected = translateWithRules(weak, GCC_INTEL_V1, { gnuUniqueObject: 'reject' })
        expect(rejected.ok).toBe(false)
        expect(rejected.diagnostics.map((d) => [d.code, d.inputLine])).toEqual([['unsupported-symbol', 4]])
    })
})

describe('the instruction set (gate 8)', () => {
    it('lets through the x86-64 baseline, x87, SSE, SSE2 and SSE3, and endbr64', () => {
        for (const text of [
            'cmovne\teax, edx',
            'bswap\teax',
            'sete\tal',
            'cmpxchg16b\tXMMWORD PTR [rdi]',
            'paddb\txmm0, xmm1',
            'pshufd\txmm0, xmm0, 85',
            'pextrw\teax, xmm0, 1',
            'haddpd\txmm0, xmm1',
            'lddqu\txmm0, XMMWORD PTR [rax]',
            'fisttp\tDWORD PTR [rsp-8]',
            'movq\trax, xmm0',
            'ud2',
            'pause',
            'rdtsc',
            'lfence',
            'nop\tDWORD PTR [rax+rax]',
            'endbr64',
        ]) {
            expect(() => instruction(text), text).not.toThrow()
        }
    })

    it('rejects extensions, naming them', () => {
        const rejected: [string, RegExp][] = [
            ['pshufb\txmm0, xmm1', /SSSE3/],
            ['pmulld\txmm0, xmm1', /SSE4\.1/],
            ['crc32\teax, ecx', /SSE4\.2/],
            ['lzcnt\teax, ecx', /LZCNT/],
            ['tzcnt\teax, ecx', /BMI1/],
            ['popcnt\teax, ecx', /Nehalem/],
            ['vaddps\txmm0, xmm1, xmm2', /AVX \(VEX-encoded\)/],
            ['vaddps\tymm0, ymm1, ymm2', /AVX register/],
            ['vaddps\tzmm0, zmm1, zmm2', /AVX-512 register/],
            ['addps\txmm16, xmm1', /AVX-512 register/],
            ['kmovw\tk1, eax', /mask register/],
            ['paddb\tmm0, mm1', /MMX/],
            ['emms', /MMX/],
            ['pextrw\tWORD PTR [rax], xmm0, 1', /SSE4\.1/],
            ['andn\teax, ecx, edx', /BMI1/],
            ['adcx\teax, ecx', /ADX/],
            ['pclmulqdq\txmm0, xmm1, 0', /Westmere/],
            ['rdrand\teax', /RDRAND/],
            ['hlt', /privileged/],
            ['syscall', /system instruction/],
            ['cpuid', /system instruction/],
            ['int3', /system instruction/],
            ['in\tal, dx', /system instruction/],
            ['mov\trax, cr0', /system register/],
            ['mov\tax, ds', /segment register/],
            ['mov\tr16, rax', /APX/],
            ['vmovdqa\tYMMWORD PTR [rax], ymm0', /AVX/],
            ['db\t1', /pseudo-instruction/],
            ['notanop', /NASM 3\.00 has no instruction/],
        ]
        for (const [text, reason] of rejected) {
            const [diagnostic] = instructionErrors(text)
            expect(diagnostic?.code, text).toBe('unsupported-instruction')
            expect(diagnostic?.message, text).toMatch(reason)
        }
    })

    it('rejects `notrack`, which NASM 3.00 would read as a label', () => {
        const [diagnostic] = instructionErrors('notrack jmp\t[QWORD PTR .L7[0+rdi*8]]', '.L7:')
        expect(diagnostic).toMatchObject({
            code: 'unsupported-instruction',
            column: 2,
            message: expect.stringContaining('notrack'),
        })
        for (const prefix of ['data16', 'addr32', 'rex64', 'cs', 'xacquire']) {
            expect(
                instructionErrors(`${prefix} nop`).map((d) => d.code),
                prefix,
            ).toEqual(['unsupported-instruction'])
        }
        expect(instructionErrors('rep lock movsb').map((d) => d.code)).toEqual(['unsupported-instruction'])
        expect(instructionErrors('rep').map((d) => d.code)).toEqual(['unsupported-instruction'])
    })
})

describe('locations', () => {
    const located = (input: string[]) =>
        translated(input)
            .lines.filter((line) => line.inputLine !== null)
            .map((line) => [line.text.trim(), line.location])

    it('gives instructions the last .loc, through .file, and nothing else a location', () => {
        const input = [
            '\t.file\t"example.c"',
            '\t.intel_syntax noprefix',
            '\t.text',
            '\t.file 0 "/app" "/app/example.c"',
            'twice:',
            '\t.file 1 "/app/values.h"',
            '\t.loc 1 1 36',
            '\tpush\trbp',
            '\t.loc 1 1 51 is_stmt 0 discriminator 3 view .LVU4',
            '\tadd\teax, eax',
            '\t.loc 0 9 2',
            '\tret',
            '\t.cfi_endproc',
            '\tnop',
            '\t.file 2 "src/main.c"',
            '\t.loc 2 4 16',
            'main:',
            '\tnop',
            '\t.data',
            '\t.loc 2 5 1',
            'x:',
            '\t.long\t1',
            '\t.text',
            '\tret',
        ]
        expect(located(input)).toEqual([
            ['section .text', null],
            ['twice:', null],
            ['push rbp', { file: '/app/values.h', line: 1, column: 36 }],
            ['add eax, eax', { file: '/app/values.h', line: 1, column: 51 }],
            ['ret', { file: '/app/example.c', line: 9, column: 2 }],
            ['nop', null],
            ['main:', null],
            ['nop', { file: 'src/main.c', line: 4, column: 16 }],
            ['section .data', null],
            ['x:', null],
            ['dd 1', null],
            ['section .text', null],
            ['ret', null],
        ])
    })

    it('carries no location on synthesized lines', () => {
        const input = unit('\t.file 1 "src/main.c"', 'main:', '\t.loc 1 3 1', '\tret', '\t.local\tn', '\t.comm\tn,4,4')
        expect(
            translated(input)
                .lines.filter((line) => line.synthesized)
                .every((line) => line.location === null),
        ).toBe(true)
    })

    it('warns about a .loc it cannot read, and leaves no location', () => {
        const input = unit(
            '\t.file 1 "src/main.c"',
            'main:',
            '\t.loc 1 3 1',
            '\tnop',
            '\t.loc 2 4 1',
            '\tnop',
            '\t.loc 1 5 1 prologue_end',
            '\tnop',
            '\t.loc x',
            '\tnop',
        )
        const result = translated(input)
        expect(result.diagnostics.map((d) => [d.code, d.severity, d.inputLine, d.location])).toEqual([
            ['unreadable-location', 'warning', 6, null],
            ['unreadable-location', 'warning', 8, null],
            ['unreadable-location', 'warning', 10, null],
        ])
        expect(
            located(input)
                .filter(([text]) => text === 'nop')
                .map(([, location]) => location),
        ).toEqual([{ file: 'src/main.c', line: 3, column: 1 }, null, null, null])
    })

    it('warns about a .file it cannot read, and a file number declared twice', () => {
        const result = translated(
            unit('\t.file 1 "a.c" md5 0x00', '\t.file 1 "a.c"', '\t.file 1 "b.c"', '\t.file "\\q"'),
        )
        expect(result.diagnostics.map((d) => [d.code, d.inputLine])).toEqual([
            ['unreadable-location', 2],
            ['unreadable-location', 4],
        ])
    })

    it('resolves escapes in file names', () => {
        const input = unit('\t.file 1 "dir\\\\with \\"quotes\\".c"', 'main:', '\t.loc 1 2 3', '\tret')
        expect(located(input).find(([text]) => text === 'ret')![1]).toEqual({
            file: 'dir\\with "quotes".c',
            line: 2,
            column: 3,
        })
    })
})
