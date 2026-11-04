// How a Project of several units becomes one program: the Entry's unit linked as an object, and
// every other unit, the library's first, as a member of an archive that `ld` takes a member from
// only for a symbol the program still needs, which is found from what each unit declares before
// it is assembled, so a unit nothing needs is never assembled.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readElfSymbolTable } from '../src/elf-symbols'
import { BlinkState, type X86Project } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const exit = (code: number) => [`    mov edi, ${code}`, '    mov eax, 60', '    syscall']

/** Start code as a library supplies it: run the constructors in order, call `main`, exit with its result. */
const START = [
    'default rel',
    'global _start',
    'extern main',
    'extern __init_array_start',
    'extern __init_array_end',
    'section .text',
    '_start:',
    '    lea rbx, [__init_array_start]',
    '.next:',
    '    lea rax, [__init_array_end]',
    '    cmp rbx, rax',
    '    jae .done',
    '    call [rbx]',
    '    add rbx, 8',
    '    jmp .next',
    '.done:',
    '    call main',
    '    mov edi, eax',
    '    mov eax, 60',
    '    syscall',
].join('\n')
const START_PATH = '@runtime/start.asm'

/** A compiled program's Entry: a `main` that returns 42. */
const MAIN = ['global main', 'section .text', 'main:', '    mov eax, 42', '    ret'].join('\n')

/** The zero-based line of the first line of `source` that is `text`, trimmed. */
const lineOf = (source: string, text: string) => source.split('\n').findIndex((line) => line.trim() === text)

let emulator: X86Emulator

beforeEach(async () => {
    emulator = await createX86Emulator()
})

afterEach(() => {
    emulator.dispose()
})

async function build(project: X86Project): Promise<void> {
    const result = await emulator.compileProject(project)
    expect(result.ok, result.report).toBe(true)
}

/** Runs the program to its end and returns its exit code. */
async function exitCode(): Promise<number> {
    await emulator.run(100_000)
    expect(emulator.stopReason?.kind).toBe('exit')
    return emulator.stopReason!.exitCode
}

/** The Files the linked program has instructions from. */
function linkedFiles(): string[] {
    return [...new Set(emulator.getCompiledInstructions().map((instruction) => instruction.file ?? '?'))].sort()
}

function linkedSymbols(): string[] {
    const program = emulator.getExecutable()
    if (!program) throw new Error('nothing was linked')
    return readElfSymbolTable(program).symbols.map((symbol) => symbol.name)
}

describe('linking a Project', () => {
    it('says it links from an archive', () => {
        expect(emulator.projectLinking).toBe('archive')
    })

    it('leaves out a File with a second strong `_start` that nothing needs, as `ld` does', async () => {
        const project = { entry: 'main.asm', files: {
            'main.asm': ['global _start', 'section .text', '_start:', ...exit(42)].join('\n'),
            'other.asm': ['global _start', 'section .text', '_start:', ...exit(7)].join('\n')
        } }
        expect(await emulator.checkProject(project)).toEqual([
            expect.objectContaining({
                file: 'other.asm',
                severity: 'hint',
                code: 'not-linked',
                message: "The program doesn't use this File, so it is left out."
            }),
        ])
        expect(emulator.getProjectUnits()).toEqual({ needed: [], leftOut: ['other.asm'] })
        const result = await emulator.compileProject(project)
        expect(result.ok, result.report).toBe(true)
        expect(result.diagnostics).toEqual([
            expect.objectContaining({ file: 'other.asm', severity: 'hint', warningClass: 'not-linked' }),
        ])
        expect(await exitCode()).toBe(42)
        expect(linkedFiles()).toEqual(['main.asm'])
    })

    it('builds each of two programs that both define `main`, the Entry choosing which runs', async () => {
        const main = (code: number) => ['global main', 'section .text', 'main:', `    mov eax, ${code}`, '    ret'].join('\n')
        const files = { 'a.c.asm': main(1), 'b.c.asm': main(2) }
        for (const [entry, code, other] of [['a.c.asm', 1, 'b.c.asm'], ['b.c.asm', 2, 'a.c.asm']] as const) {
            const project = { entry, files, startUnits: { [START_PATH]: START } }
            expect(await emulator.checkProject(project)).toEqual([
                expect.objectContaining({ file: other, severity: 'hint', code: 'not-linked' }),
            ])
            const result = await emulator.compileProject(project)
            expect(result.ok, result.report).toBe(true)
            expect(result.diagnostics).toEqual([
                expect.objectContaining({ file: other, severity: 'hint', warningClass: 'not-linked' }),
            ])
            expect(await exitCode()).toBe(code)
            expect(linkedFiles()).toEqual([START_PATH, entry])
        }
    })

    it('neither assembles nor checks a File nothing needs, and leaves it out of the program', async () => {
        const unused = [
            'global unused_function',
            'global unused_data',
            'section .text',
            'unused_function:',
            '    ret',
            'section .data',
            'unused_data: dq 1',
        ].join('\n')
        await build({
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'section .text', '_start:', ...exit(0)].join('\n'),
                'unused.asm': unused,
            },
        })

        expect(linkedSymbols()).toContain('_start')
        expect(linkedSymbols()).not.toContain('unused_function')
        expect(linkedSymbols()).not.toContain('unused_data')
        expect(linkedFiles()).toEqual(['main.asm'])
        // A breakpoint on one of its lines has no instruction to stop on.
        await emulator.run(undefined, [{ path: 'unused.asm', line: lineOf(unused, 'ret') }])
        expect(emulator.stopReason?.kind).toBe('exit')

        // A mistake in it, or a whole File in another assembler's syntax, fails nothing, though it
        // declares a global: the program does not need it.
        const broken = {
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'section .text', '_start:', ...exit(0)].join('\n'),
                'unused.asm': ['global unused_function', 'section .text', 'unused_function:', '    mov rax, rbx, rcx'].join('\n'),
                'gas.s': ['.globl helper', '.text', 'helper:', '    movq %rax, %rbx', '    ret'].join('\n'),
                'mips.asm': ['.globl main', 'main:', '    li $v0, 10', '    syscall'].join('\n'),
                // the preprocessor gives up on it, so it is read as it is written
                'stops.asm': ['%error not finished', 'global stopping', 'stopping:', '    ret'].join('\n'),
            },
        }
        expect(await emulator.checkProject(broken)).toEqual(
            ['gas.s', 'mips.asm', 'stops.asm', 'unused.asm'].map((file) => expect.objectContaining({ file, severity: 'hint', code: 'not-linked' })),
        )
        await build(broken)
        expect(await exitCode()).toBe(0)

        // Once the program needs it, it is assembled, and its mistake fails the Build.
        const needed = {
            entry: 'main.asm',
            files: {
                ...broken.files,
                'main.asm': ['global _start', 'extern unused_function', 'section .text', '_start:', '    call unused_function', ...exit(0)].join('\n'),
            },
        }
        for (const result of [await emulator.compileProject(needed), await emulator.compileProject(needed)]) {
            expect(result.ok).toBe(false)
            if (result.ok) return
            expect(result.errors.length).toBeGreaterThan(0)
            expect(result.errors.every((error) => error.file === 'unused.asm' && error.line === 4)).toBe(true)
            expect(result.diagnostics.some((diagnostic) => diagnostic.warningClass === 'not-linked')).toBe(false)
        }
        expect(emulator.getProjectUnits()).toEqual({ needed: ['unused.asm'], leftOut: ['gas.s', 'mips.asm', 'stops.asm'] })
    })

    it('finds a global an include or a macro declares, in the preprocessed text', async () => {
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'extern from_macro', 'extern from_include', 'section .text', '_start:',
                    '    call from_macro', '    mov ebx, eax', '    call from_include', '    lea edi, [rbx + rax]', '    mov eax, 60', '    syscall'].join('\n'),
                'macro.asm': ['%macro VALUE 2', '    global %1', '%1:', '    mov eax, %2', '    ret', '%endmacro', 'section .text', 'VALUE from_macro, 40'].join('\n'),
                'include.asm': ['%include "values.inc"'].join('\n'),
                'values.inc': ['global from_include', 'section .text', 'from_include:', '    mov eax, 2', '    ret'].join('\n'),
                // declares a global only inside a block the preprocessor leaves out
                'skipped.asm': ['%if 0', 'global from_macro', 'from_macro:', '%endif', '    bogus'].join('\n'),
            },
        }
        expect(await emulator.checkProject(project)).toEqual([
            expect.objectContaining({ file: 'skipped.asm', code: 'not-linked' }),
        ])
        await build(project)
        expect(await exitCode()).toBe(42)
        // include.asm's instructions are the ones values.inc wrote
        expect(linkedFiles()).toEqual(['macro.asm', 'main.asm', 'values.inc'])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['include.asm', 'macro.asm'], leftOut: ['skipped.asm'] })
    })

    it('never takes a File another one includes on its own, the Entry or a unit', async () => {
        // defs.asm is part of the Entry, and frag.asm part of lib.asm, whose definition it needs
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': ['%include "defs.asm"', 'global _start', 'extern helper', 'section .text', '_start:', '    call helper', '    add eax, [rel base]', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n'),
                'defs.asm': ['global base', 'section .data', 'base: dd 2'].join('\n'),
                'a_frag.asm': ['global helper', 'section .text', 'helper:', '    mov eax, VALUE', '    ret'].join('\n'),
                'b_lib.asm': ['%define VALUE 40', '%include "a_frag.asm"'].join('\n'),
            },
        }
        expect(await emulator.checkProject(project)).toEqual([])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['b_lib.asm'], leftOut: [] })
        await build(project)
        expect(await exitCode()).toBe(42)
    })

    it('takes a File for a name only declared global where another defines it, and not the declaring one', async () => {
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'extern helper', 'section .text', '_start:', '    call helper', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n'),
                // declares helper global but defines no such label: no member for it
                'a_decoy.asm': ['global helper', 'section .text', 'other:', '    ret'].join('\n'),
                'b_real.asm': ['global helper', 'section .text', 'helper:', '    mov eax, 9', '    ret'].join('\n'),
                // only a common symbol the Entry also has: never taken for it, so its mistake fails nothing
                'c_common.asm': ['common shared 8', 'section .text', '    mov rax, rbx, rcx'].join('\n'),
            },
        }
        const withCommon = { ...project, files: { ...project.files, 'main.asm': project.files['main.asm'].replace('extern helper', 'extern helper\ncommon shared 8') } }
        expect((await emulator.checkProject(withCommon)).map((diagnostic) => [diagnostic.file, diagnostic.code])).toEqual([
            ['a_decoy.asm', 'not-linked'],
            ['c_common.asm', 'not-linked'],
        ])
        await build(withCommon)
        expect(await exitCode()).toBe(9)
    })

    it("takes a File a library unit needs, though the program's own units do not", async () => {
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'extern library_function', 'section .text', '_start:', '    call library_function', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n'),
                'hook.asm': ['global user_hook', 'section .text', 'user_hook:', '    mov eax, 5', '    ret'].join('\n'),
            },
            library: { '@runtime/library.asm': ['global library_function', 'extern user_hook', 'section .text', 'library_function:', '    call user_hook', '    add eax, 1', '    ret'].join('\n') },
        }
        expect(await emulator.checkProject(project)).toEqual([])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['hook.asm'], leftOut: [] })
        await build(project)
        expect(await exitCode()).toBe(6)
    })

    it('takes only the units a Project names, in their order, when it names them', async () => {
        const main = ['global _start', 'extern value', 'section .text', '_start:', '    call value', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n')
        const value = (code: number) => ['global value', 'section .text', 'value:', `    mov eax, ${code}`, '    ret'].join('\n')
        const files = { 'main.asm': main, 'a.asm': value(1), 'b.asm': value(2), 'other.mips': '.globl value\nvalue: jr $ra', 'c.s': value(3) }
        // the first of the named units that defines it, which needs no `.asm` name
        await build({ entry: 'main.asm', files: { ...files, 'c.txt': value(4) }, units: ['c.txt', 'b.asm'] })
        expect(await exitCode()).toBe(4)
        expect(emulator.getProjectUnits()).toEqual({ needed: ['c.txt'], leftOut: ['b.asm'] })
        await build({ entry: 'main.asm', files, units: ['b.asm', 'a.asm'] })
        expect(await exitCode()).toBe(2)
        // a File it does not name is not looked at, so a program it does not name cannot link
        const unnamed = await emulator.compileProject({ entry: 'main.asm', files, units: [] })
        expect(unnamed.ok).toBe(false)
        expect(emulator.getProjectUnits()).toEqual({ needed: [], leftOut: [] })
        // what a Project cannot name
        for (const units of [['main.asm'], ['missing.asm'], ['a.asm', 'a.asm'], ['/a.asm']])
            await expect(emulator.compileProject({ entry: 'main.asm', files, units })).rejects.toThrow()
        await expect(emulator.compileProject({ entry: 'main.asm', files: { ...files, 'bytes.asm': new Uint8Array([1]) }, units: ['bytes.asm'] })).rejects.toThrow(/text File/)
    })

    it('reports a needed File that does not assemble without knowing what else it needs, and no Hint until it does', async () => {
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'extern first', 'section .text', '_start:', '    call first', ...exit(0)].join('\n'),
                'first.asm': ['global first', 'extern second', 'section .text', 'first:', '    call second', '    mov rax, rbx, rcx', '    ret'].join('\n'),
                'second.asm': ['global second', 'section .text', 'second:', '    ret'].join('\n'),
            },
        }
        const checked = await emulator.checkProject(project)
        expect(checked.map((diagnostic) => [diagnostic.file, diagnostic.severity])).toEqual([['first.asm', 'error']])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['first.asm'], leftOut: ['second.asm'] })
        // a File that does not assemble still counts as defining what it declares, so another
        // that defines `first` too is not taken in its place
        const twice = { ...project, files: { ...project.files, 'z_first.asm': 'global first\nsection .text\nfirst: ret' } }
        expect((await emulator.checkProject(twice)).map((diagnostic) => diagnostic.file)).toEqual(['first.asm'])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['first.asm'], leftOut: ['second.asm', 'z_first.asm'] })
        // an Entry that does not assemble cannot say for certain what it needs, but the Files its
        // `extern` lines name are still assembled, so their mistakes are reported beside its own
        const entryBroken = { ...project, files: { ...project.files, 'main.asm': project.files['main.asm'] + '\n    mov rax, rbx, rcx' } }
        expect((await emulator.checkProject(entryBroken)).map((diagnostic) => diagnostic.file)).toEqual(['main.asm', 'first.asm'])
        expect(emulator.getProjectUnits()).toBeNull()
        // and a File it does not name is not
        const fixed = { ...entryBroken, files: { ...entryBroken.files, 'first.asm': project.files['second.asm'].replaceAll('second', 'first') } }
        const unrelated = { ...fixed, files: { ...fixed.files, 'other.asm': 'global other\nsection .text\nother:\n    mov rax, rbx, rcx' } }
        expect((await emulator.checkProject(unrelated)).map((diagnostic) => diagnostic.file)).toEqual(['main.asm'])
    })

    it('finds a global a scan of the text alone has to piece together: a local label, a continued line, a struc', async () => {
        const main = ['global _start', 'extern helper.inner, second, point_size, point.y', 'section .text', '_start:',
            '    call helper.inner', '    mov ebx, eax', '    call second', '    add ebx, eax',
            '    add ebx, point_size', '    add ebx, point.y', '    mov edi, ebx', '    mov eax, 60', '    syscall'].join('\n')
        const project = {
            entry: 'main.asm',
            files: {
                'main.asm': main,
                // NASM's helper.inner, a local label of helper
                'local.asm': ['global helper.inner', 'section .text', 'helper:', '    nop', '.inner:', '    mov eax, 30', '    ret'].join('\n'),
                // a global list a backslash continues onto the next line
                'continued.asm': ['global first, \\', '    second', 'section .text', 'first:', '    ret', 'second:', '    mov eax, 4', '    ret'].join('\n'),
                // a structure's size and field, written plainly and through the preprocessor
                'shape.asm': ['struc point', '.x: resd 1', '.y: resd 1', 'endstruc', 'global point_size, point.y'].join('\n'),
            },
        }
        expect(await emulator.checkProject(project)).toEqual([])
        expect(emulator.getProjectUnits()).toEqual({ needed: ['continued.asm', 'local.asm', 'shape.asm'], leftOut: [] })
        await build(project)
        expect(await exitCode()).toBe(30 + 4 + 8 + 4)
        const preprocessed = { ...project, files: { ...project.files, 'shape.asm': '%define FIELD resd 1\n' + project.files['shape.asm'].replaceAll('resd 1', 'FIELD') } }
        await build(preprocessed)
        expect(await exitCode()).toBe(46)
        // a local label after an `equ` is still the last label's, as NASM has it
        const afterEqu = { ...project, files: { ...project.files, 'local.asm': project.files['local.asm'].replace('    nop', 'size equ 4') } }
        await build(afterEqu)
        expect(await exitCode()).toBe(46)
    })

    it("reads a File's declarations again once it is no longer the Entry", async () => {
        // checked as the Entry, which reads only its includes, then needed as a unit: what its
        // scan as the Entry found is not what it declares
        const lib = ['%define VALUE 7', 'global seven', 'section .text', 'seven:', '    mov eax, VALUE', '    ret'].join('\n')
        const main = ['global _start', 'extern seven', 'section .text', '_start:', '    call seven', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n')
        const files = { 'lib.asm': lib, 'main.asm': main }
        await emulator.checkProject({ entry: 'lib.asm', files })
        await build({ entry: 'main.asm', files })
        expect(emulator.getProjectUnits()).toEqual({ needed: ['lib.asm'], leftOut: [] })
        expect(await exitCode()).toBe(7)
    })

    it('takes every member a reference needs, whichever way the references run', async () => {
        // The Entry calls `glue`, which calls `scaled`, which reads `base` and calls back into the
        // Entry. The archive holds the members by path, so each one needed comes after the one
        // that needs it, and `ld` has to search the archive again for each.
        await build({
            entry: 'main.c.asm',
            files: {
                'main.c.asm': [
                    'global _start',
                    'global bonus',
                    'extern glue',
                    'section .text',
                    '_start:',
                    '    call glue',
                    '    mov edi, eax',
                    '    mov eax, 60',
                    '    syscall',
                    'bonus:',
                    '    mov eax, 1',
                    '    ret',
                ].join('\n'),
                'z_glue.asm': ['global glue', 'extern scaled', 'section .text', 'glue:', '    call scaled', '    ret'].join(
                    '\n',
                ),
                'y_scaled.asm': [
                    'default rel',
                    'global scaled',
                    'extern base',
                    'extern bonus',
                    'section .text',
                    'scaled:',
                    '    call bonus',
                    '    add eax, [base]',
                    '    ret',
                ].join('\n'),
                'x_base.asm': ['global base', 'section .data', 'base: dd 41'].join('\n'),
            },
        })

        expect(await exitCode()).toBe(42)
        expect(linkedFiles()).toEqual(['main.c.asm', 'y_scaled.asm', 'z_glue.asm'])
        expect(linkedSymbols()).toContain('base')
    })

    it("starts at a library's `_start`, which calls `main`, though a Project File defines `_start` too", async () => {
        await build({
            entry: 'src/main.c.asm',
            files: {
                'src/main.c.asm': MAIN,
                'main.asm': ['global _start', 'section .text', '_start:', ...exit(7)].join('\n'),
            },
            startUnits: { [START_PATH]: START },
        })

        expect(emulator.getNextInstruction()?.file).toBe(START_PATH)
        expect(await exitCode()).toBe(42)
        expect(linkedFiles()).toEqual([START_PATH, 'src/main.c.asm'])
    })

    it("lets the Entry's definitions stand over a library's weak ones, which fill in for the rest", async () => {
        // The start code is taken for `_start`, and its weak definitions come with it. NASM resolves
        // a reference to a label of the same File itself, so only another unit's references show
        // which definition the link chose: here `compute`'s.
        const library = {
            [START_PATH]: [
                START,
                'global scale:weak',
                'global offset:weak',
                'section .text',
                'scale:',
                '    mov eax, 1',
                '    ret',
                'section .data',
                'offset: dd 100',
            ].join('\n'),
        }
        const compute = [
            'default rel',
            'global compute',
            'extern scale',
            'extern offset',
            'section .text',
            'compute:',
            '    call scale',
            '    add eax, [offset]',
            '    ret',
        ].join('\n')
        const main = (...definitions: string[]) =>
            ['global main', 'extern compute', 'section .text', 'main:', '    call compute', '    ret', ...definitions].join('\n')

        await build({
            entry: 'main.asm',
            files: {
                'main.asm': main('global scale', 'global offset', 'scale:', '    mov eax, 2', '    ret', 'section .data', 'offset: dd 40'),
                'compute.asm': compute,
            },
            library,
        })
        expect(await exitCode()).toBe(42)

        await build({ entry: 'main.asm', files: { 'main.asm': main(), 'compute.asm': compute }, library })
        expect(await exitCode()).toBe(101)
    })

    it('runs the constructors of a member the program needs, and only of those', async () => {
        await build({
            entry: 'main.c.asm',
            files: {
                'main.c.asm': [
                    'default rel',
                    'global main',
                    'extern counter',
                    'section .text',
                    'main:',
                    '    mov eax, [counter]',
                    '    add eax, 2',
                    '    ret',
                ].join('\n'),
                'counter.asm': [
                    'default rel',
                    'global counter',
                    'section .data',
                    'counter: dd 0',
                    'section .text',
                    'count:',
                    '    add dword [counter], 40',
                    '    ret',
                    'section .init_array',
                    '    dq count',
                ].join('\n'),
                // Nothing needs it, so as in a static library its constructor is not part of the program.
                'unneeded.asm': [
                    'default rel',
                    'extern counter',
                    'section .text',
                    'count_more:',
                    '    add dword [counter], 100',
                    '    ret',
                    'section .init_array',
                    '    dq count_more',
                ].join('\n'),
            },
            startUnits: { [START_PATH]: START },
        })

        expect(await exitCode()).toBe(42)
    })

    it('finds a `_start` only a library defines, and still explains a Project with none', async () => {
        const project = { entry: 'main.asm', files: { 'main.asm': MAIN }, library: { [START_PATH]: START } }
        expect(await emulator.checkProject(project)).toEqual([])
        await build(project)

        const without = {
            entry: 'main.asm',
            files: { 'main.asm': MAIN },
            library: { 'lib/helper.asm': ['global helper', 'section .text', 'helper:', '    ret'].join('\n') },
        }
        const explanation = expect.objectContaining({
            file: 'main.asm',
            severity: 'error',
            warningClass: 'entry-point',
            error: expect.stringContaining('no `_start` to start from'),
        })
        const checked = await emulator.checkProject(without)
        expect(checked).toEqual([
            expect.objectContaining({ file: 'main.asm', lineIndex: 0, severity: 'error', code: 'entry-point' }),
        ])
        const built = await emulator.compileProject(without)
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors).toEqual([explanation])
    })
})

describe('a library unit', () => {
    const project = { entry: 'src/main.c.asm', files: { 'src/main.c.asm': MAIN }, library: { [START_PATH]: START } }

    it('is named by its library path in instructions, breakpoints and the call stack', async () => {
        await build(project)
        emulator.initialize(100)

        expect(emulator.getNextInstruction()).toEqual(
            expect.objectContaining({ file: START_PATH, lineNumber: lineOf(START, 'lea rbx, [__init_array_start]') }),
        )
        expect(emulator.getCompiledInstructions()).toContainEqual(
            expect.objectContaining({ file: START_PATH, lineNumber: lineOf(START, 'call main') }),
        )

        await emulator.run(undefined, [{ path: START_PATH, line: lineOf(START, 'call main') }])
        expect(emulator.stopReason).toEqual(
            expect.objectContaining({ kind: 'breakpoint', file: START_PATH, lineNumber: lineOf(START, 'call main') }),
        )
        await emulator.step()
        expect(emulator.getNextInstruction()?.file).toBe('src/main.c.asm')
        expect(emulator.getCallStack().map((frame) => frame.name)).toEqual(['main'])
    })

    it('has its mistakes reported against its library path', async () => {
        const broken = START.replace('    call main', '    call main, main')
        const line = lineOf(broken, 'call main, main')
        const withBroken = { ...project, library: { [START_PATH]: broken } }

        const built = await emulator.compileProject(withBroken)
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors).toEqual([expect.objectContaining({ file: START_PATH, line: line + 1 })])

        expect(await emulator.checkProject(withBroken)).toEqual([
            expect.objectContaining({
                file: START_PATH,
                lineIndex: line,
                line: { line: '    call main, main', line_index: line },
            }),
        ])
    })

    it('reports its warnings on every build, not only the one that assembled it', async () => {
        const withWarning = { ...project, library: { [START_PATH]: START.replace('.done:', '.done') } }
        for (let build = 0; build < 2; build++) {
            const built = await emulator.compileProject(withWarning)
            expect(built.ok, built.report).toBe(true)
            expect(built.diagnostics).toContainEqual(
                expect.objectContaining({ file: START_PATH, severity: 'warning', warningClass: 'label-orphan' }),
            )
        }
    })

    it('is assembled again when a File it includes changes', async () => {
        const library = {
            '@runtime/value.asm': ['global value', '%include "../value.inc"', 'section .text', 'value:', '    mov eax, VALUE', '    ret'].join('\n'),
        }
        const main = ['global _start', 'extern value', 'section .text', '_start:', '    call value', '    mov edi, eax', '    mov eax, 60', '    syscall'].join('\n')
        for (const value of [3, 4]) {
            await build({ entry: 'main.asm', files: { 'main.asm': main, 'value.inc': `%define VALUE ${value}` }, library })
            expect(await exitCode()).toBe(value)
        }
    })

    it('cannot be included by a File', async () => {
        const main = ['global main', '%include "@runtime/start.asm"', 'section .text', 'main:', '    ret'].join('\n')

        const built = await emulator.compileProject({ ...project, files: { 'src/main.c.asm': main } })
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors).toEqual([
            expect.objectContaining({ file: 'src/main.c.asm', line: 2, error: expect.stringContaining('@runtime/start.asm') }),
        ])
    })

    it('cannot share a path with a File, and the build that refuses one leaves the last program alone', async () => {
        await build(project)
        const refused = [
            [{ 'src/main.c.asm': START }, 'collides with the Project File src/main.c.asm'],
            [{ src: START }, 'collides with the Project File src/main.c.asm'],
            [{ 'src/main.c.asm/start.asm': START }, 'collides with the Project File src/main.c.asm'],
            [{ '': START }, 'Invalid x86 Project library path'],
            [{ '../start.asm': START }, 'Invalid x86 Project library path'],
            [{ '/start.asm': START }, 'Invalid x86 Project library path'],
        ] as const

        for (const [library, message] of refused) {
            await expect(emulator.compileProject({ ...project, library })).rejects.toThrow(message)
            await expect(emulator.checkProject({ ...project, library })).rejects.toThrow(message)
        }

        expect(emulator.state).toBe(BlinkState.ProgramLoaded)
        expect(await exitCode()).toBe(42)
    })
})

describe('reviewed link policy', () => {
    it('prefers a secondary user memcpy over trailing weak support', async () => {
        await build({ entry: 'main.asm', files: {
            'main.asm': ['global _start', 'extern memcpy', 'section .text', '_start:', 'call memcpy', 'mov edi, eax', 'mov eax, 60', 'syscall'].join('\n'),
            'copy.asm': ['global memcpy', 'section .text', 'memcpy:', 'mov eax, 42', 'ret'].join('\n')
        }, library: { '@runtime/support.asm': ['global memcpy:weak', 'section .text', 'memcpy:', 'mov eax, 7', 'ret'].join('\n') } })
        expect(await exitCode()).toBe(42)
    })
    it('accepts a strong global defined twice in Files the link leaves out, as `ld` does', async () => {
        const project = { entry: 'main.asm', files: {
            'main.asm': ['global _start', 'section .text', '_start:', ...exit(0)].join('\n'),
            'a.asm': 'global duplicate\nsection .text\nduplicate: ret',
            'b.asm': 'global duplicate\nsection .text\nduplicate: ret'
        } }
        expect((await emulator.checkProject(project)).map((d) => [d.file, d.code])).toEqual([
            ['a.asm', 'not-linked'],
            ['b.asm', 'not-linked'],
        ])
        const result = await emulator.compileProject(project)
        expect(result.ok, result.report).toBe(true)
        expect(result.diagnostics.map((d) => [d.file, d.warningClass])).toEqual([
            ['a.asm', 'not-linked'],
            ['b.asm', 'not-linked'],
        ])
    })
    it('accepts a File that defines what the Entry defines, until the program needs it for something else', async () => {
        const entry = ['global _start', 'global shared', 'extern used', 'section .text', '_start:', '    call used', ...exit(0), 'shared:', '    ret'].join('\n')
        const other = (defines: string) => [`global ${defines}`, 'global shared', 'section .text', `${defines}:`, '    ret', 'shared:', '    ret'].join('\n')
        const used = 'global used\nsection .text\nused: ret'
        const apart = { entry: 'main.asm', files: { 'main.asm': entry, 'other.asm': other('spare'), 'used.asm': used } }
        expect(await emulator.checkProject(apart)).toEqual([expect.objectContaining({ file: 'other.asm', code: 'not-linked' })])
        await build(apart)

        // now the program needs `used` from other.asm, whose `shared` comes with it
        const together = { entry: 'main.asm', files: { 'main.asm': entry, 'other.asm': other('used') } }
        expect(await emulator.checkProject(together)).toEqual([
            expect.objectContaining({ file: 'main.asm', severity: 'error', message: "multiple definition of 'shared'; also defined in other.asm" }),
            expect.objectContaining({ file: 'other.asm', severity: 'error', message: "multiple definition of 'shared'; also defined in main.asm" }),
        ])
        const result = await emulator.compileProject(together)
        expect(result.ok).toBe(false)
        if (result.ok) return
        // `ld` places each at the instruction its label stands on, the `ret` below it
        expect(result.errors).toEqual([
            expect.objectContaining({
                file: 'other.asm',
                line: lineOf(other('used'), 'shared:') + 2,
                error: `multiple definition of \`shared'; first defined in main.asm, line ${lineOf(entry, 'shared:') + 2}`,
            }),
        ])
    })
    it('reports a strong global two Files define once the link takes both, naming both Files', async () => {
        const project = { entry: 'main.asm', files: {
            'main.asm': ['global _start', 'extern first', 'extern second', 'section .text', '_start:', '    call first', '    call second', ...exit(0)].join('\n'),
            'a.asm': 'global first\nglobal duplicate\nsection .text\nfirst: ret\nduplicate: ret',
            'b.asm': 'global second\nglobal duplicate\nsection .text\nsecond: ret\nduplicate: ret'
        } }
        expect(await emulator.checkProject(project)).toEqual([
            expect.objectContaining({ file: 'a.asm', severity: 'error', message: "multiple definition of 'duplicate'; also defined in b.asm" }),
            expect.objectContaining({ file: 'b.asm', severity: 'error', message: "multiple definition of 'duplicate'; also defined in a.asm" }),
        ])
        const result = await emulator.compileProject(project)
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.errors).toEqual([
            expect.objectContaining({ file: 'b.asm', line: 5, error: "multiple definition of `duplicate'; first defined in a.asm, line 5" }),
        ])
    })
    it('takes a member as `ld` reads its archive, so a check leaves out what the link leaves out', async () => {
        // `ld` reads the index in order: a.asm's `x` is not yet needed when it passes it, b.asm is
        // taken for `y` and needs `x`, which c.asm, further on, gives. a.asm, whose `z` the Entry
        // defines too, is never taken, so neither the check nor the link has two `z`.
        const value = (name: string, code: number) => [`global ${name}`, 'section .text', `${name}:`, `    mov eax, ${code}`, '    ret']
        const project = { entry: 'main.asm', files: {
            'main.asm': ['global _start', 'global z', 'extern y', 'section .text', '_start:', '    call y', '    mov edi, eax', '    mov eax, 60', '    syscall', 'z:', '    ret'].join('\n'),
            'a.asm': [...value('x', 1), ...value('z', 9)].join('\n'),
            'b.asm': ['global y', 'extern x', 'section .text', 'y:', '    jmp x'].join('\n'),
            'c.asm': value('x', 3).join('\n'),
        } }
        expect(await emulator.checkProject(project)).toEqual([expect.objectContaining({ file: 'a.asm', code: 'not-linked' })])
        await build(project)
        expect(await exitCode()).toBe(3)
        expect(linkedFiles()).toEqual(['b.asm', 'c.asm', 'main.asm'])
    })
    it('counts as `ld` does a common symbol, which a real definition in a member answers, and an absolute one', async () => {
        const start = (...lines: string[]) => ['global _start', ...lines, 'section .text', '_start:', ...exit(0)].join('\n')
        // `shared` is only common in the Entry, so `ld` takes the member that really defines it,
        // and the `twin` that comes with it is a second definition
        const common = { entry: 'main.asm', files: {
            'main.asm': start('common shared 8', 'global twin', 'section .text', 'twin:', '    ret'),
            'b.asm': ['global shared', 'global twin', 'section .data', 'shared: dq 5', 'section .text', 'twin:', '    ret'].join('\n'),
        } }
        expect(await emulator.checkProject(common)).toEqual([
            expect.objectContaining({ file: 'main.asm', message: "multiple definition of 'twin'; also defined in b.asm" }),
            expect.objectContaining({ file: 'b.asm', message: "multiple definition of 'twin'; also defined in main.asm" }),
        ])
        const built = await emulator.compileProject(common)
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors).toEqual([expect.objectContaining({ file: 'b.asm', error: expect.stringContaining("multiple definition of `twin'") })])

        // several common symbols of one name are one variable, and the same absolute value twice is harmless
        const harmless = (limit: number) => ({ entry: 'main.asm', files: {
            'main.asm': start('common counter 8', 'global LIMIT', 'LIMIT equ 10', 'extern used', 'section .text', '    call used'),
            'a.asm': ['common counter 8', 'global LIMIT', `LIMIT equ ${limit}`, 'global used', 'section .text', 'used:', '    ret'].join('\n'),
        } })
        expect(await emulator.checkProject(harmless(10))).toEqual([])
        await build(harmless(10))
        expect(await emulator.checkProject(harmless(11))).toEqual([
            expect.objectContaining({ file: 'main.asm', message: "multiple definition of 'LIMIT'; also defined in a.asm" }),
            expect.objectContaining({ file: 'a.asm', message: "multiple definition of 'LIMIT'; also defined in main.asm" }),
        ])
        expect((await emulator.compileProject(harmless(11))).ok).toBe(false)
    })
    it('allows a weak definition beside a strong definition and hints at an unused File', async () => {
        const result = await emulator.compileProject({ entry: 'main.asm', files: {
            'main.asm': ['global _start', 'extern value', 'section .text', '_start:', 'call value', ...exit(0)].join('\n'),
            'a.asm': 'global value\nsection .text\nvalue: ret',
            'b.asm': 'global value:weak\nsection .text\nvalue: ret'
        } })
        expect(result.ok).toBe(true)
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ file: 'b.asm', severity: 'hint', warningClass: 'not-linked' }))
    })
    it('resets instruction count per program and rewinds it with native Undo', async () => {
        await build({ entry: 'main.asm', files: { 'main.asm': ['global _start', 'section .text', '_start:', 'nop', 'nop', ...exit(0)].join('\n') } })
        emulator.initialize(100)
        expect(emulator.getInstructionsExecuted()).toBe(0n)
        await emulator.step()
        expect(emulator.getInstructionsExecuted()).toBe(1n)
        emulator.undo()
        expect(emulator.getInstructionsExecuted()).toBe(0n)
    })
})
