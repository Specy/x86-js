// How a Project of several units becomes one program: the Entry's unit linked as an object, and
// every other unit, the library's first, as a member of an archive that `ld` takes a member from
// only for a symbol the program still needs.
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

    it("builds the Entry's program when a File nothing needs defines `_start` too", async () => {
        await build({
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'section .text', '_start:', ...exit(42)].join('\n'),
                'other.asm': ['global _start', 'section .text', '_start:', ...exit(7)].join('\n'),
            },
        })

        expect(await exitCode()).toBe(42)
        expect(linkedFiles()).toEqual(['main.asm'])
    })

    it('assembles a File nothing needs, and reports its mistakes, but leaves it out of the program', async () => {
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

        const broken = await emulator.compileProject({
            entry: 'main.asm',
            files: {
                'main.asm': ['global _start', 'section .text', '_start:', ...exit(0)].join('\n'),
                'unused.asm': ['section .text', 'unused_function:', '    mov rax, rbx, rcx'].join('\n'),
            },
        })
        expect(broken.ok).toBe(false)
        if (broken.ok) return
        expect(broken.errors.length).toBeGreaterThan(0)
        expect(broken.errors.every((error) => error.file === 'unused.asm' && error.line === 3)).toBe(true)
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
            library: { [START_PATH]: START },
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
            library: { [START_PATH]: START },
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
