// A Project's include paths: directories of the Project NASM searches, as `-I`, for a `%include`
// it does not find beside the File it assembles. A host offers include files of its own, such as
// a system's headers, as Files under one of them, and every path the toolchain writes about such a
// File comes back as the Project path it was given at.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateX86Project, x86ProjectSourcePath } from '../src/project'
import type { X86Project } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

const INCLUDE = 'system/include'

/** Include files as a host offers them: one includes another by its path under the directory. */
const HEADERS = {
    [`${INCLUDE}/sys/exit.inc`]: ['%ifndef SYS_EXIT_INC', '%define SYS_EXIT_INC', '%include "sys/numbers.inc"', '%define EXIT_CODE 42', '%endif'].join('\n'),
    [`${INCLUDE}/sys/numbers.inc`]: ['%define SYS_exit 60'].join('\n'),
    [`${INCLUDE}/helper.inc`]: ['section .text', 'helper:', '    mov edi, EXIT_CODE', '    ret'].join('\n')
}

const MAIN = [
    'global _start',
    '%include "sys/exit.inc"',
    '%include "helper.inc"',
    'section .text',
    '_start:',
    '    call helper',
    '    mov eax, SYS_exit',
    '    syscall'
].join('\n')

const project = (files: Record<string, string>, entry = 'main.asm'): X86Project => ({
    entry,
    files: { ...files, ...HEADERS },
    includePaths: [INCLUDE]
})

/** The zero-based line of the first line of `source` that is `text`, trimmed. */
const lineOf = (source: string, text: string) => source.split('\n').findIndex((line) => line.trim() === text)

let emulator: X86Emulator

beforeEach(async () => {
    emulator = await createX86Emulator()
})

afterEach(() => {
    emulator.dispose()
})

async function exitCode(): Promise<number> {
    await emulator.run(100_000)
    expect(emulator.stopReason?.kind).toBe('exit')
    return emulator.stopReason!.exitCode
}

describe('an include path', () => {
    it('is searched for a %include, and one -I serves the include files that include each other', async () => {
        const built = await emulator.compileProject(project({ 'main.asm': MAIN }))
        expect(built.ok, built.report).toBe(true)
        expect(await exitCode()).toBe(42)
    })

    it('is searched from an Entry in another directory, and by a File the Entry includes', async () => {
        const nested = { 'src/game/main.asm': '%include "parts.asm"', 'src/game/parts.asm': MAIN }
        const built = await emulator.compileProject(project(nested, 'src/game/main.asm'))
        expect(built.ok, built.report).toBe(true)
        expect(await exitCode()).toBe(42)
    })

    it('comes after the directory of the File assembled, as for NASM on Linux', async () => {
        const files = { 'main.asm': MAIN, 'sys/exit.inc': '%include "sys/numbers.inc"\n%define EXIT_CODE 7' }
        const built = await emulator.compileProject(project(files))
        expect(built.ok, built.report).toBe(true)
        expect(await exitCode()).toBe(7)
    })

    it('is searched for an incbin too', async () => {
        const main = ['global _start', 'section .data', 'code: incbin "code.bin"', 'section .text', '_start:', '    movzx edi, byte [code]', '    mov eax, 60', '    syscall'].join('\n')
        const built = await emulator.compileProject({ entry: 'main.asm', files: { 'main.asm': main, [`${INCLUDE}/code.bin`]: new Uint8Array([9]) }, includePaths: [INCLUDE] })
        expect(built.ok, built.report).toBe(true)
        expect(await exitCode()).toBe(9)
    })

    it('is searched by a library unit too', async () => {
        const library = {
            '@runtime/exit.asm': ['global leave', '%include "sys/exit.inc"', 'section .text', 'leave:', '    mov edi, EXIT_CODE', '    mov eax, SYS_exit', '    syscall'].join('\n')
        }
        const main = ['global _start', 'extern leave', 'section .text', '_start:', '    jmp leave'].join('\n')
        const built = await emulator.compileProject({ ...project({ 'main.asm': main }), library })
        expect(built.ok, built.report).toBe(true)
        expect(await exitCode()).toBe(42)
    })

    it('names the instructions of an included File, and its Breakpoints, by its Project path', async () => {
        const built = await emulator.compileProject(project({ 'main.asm': MAIN }))
        expect(built.ok, built.report).toBe(true)
        const path = `${INCLUDE}/helper.inc`
        const line = lineOf(HEADERS[path]!, 'mov edi, EXIT_CODE')
        expect(emulator.getCompiledInstructions()).toContainEqual(expect.objectContaining({ file: path, lineNumber: line }))

        emulator.initialize(100)
        await emulator.run(undefined, [{ path, line }])
        expect(emulator.stopReason).toEqual(expect.objectContaining({ kind: 'breakpoint', file: path, lineNumber: line }))
        expect(emulator.getNextInstruction()).toEqual(expect.objectContaining({ file: path, lineNumber: line }))
    })

    it('reports a mistake inside an included File on that File, by its Project path', async () => {
        const path = `${INCLUDE}/sys/numbers.inc`
        const broken = { ...project({ 'main.asm': MAIN }) }
        broken.files = { ...broken.files, [path]: '%define SYS_exit 60\n%error the header is broken' }

        const built = await emulator.compileProject(broken)
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors).toEqual([expect.objectContaining({ file: path, line: 2, error: 'the header is broken' })])

        expect(await emulator.checkProject(broken)).toEqual([
            expect.objectContaining({ file: path, lineIndex: 1, message: expect.stringContaining('the header is broken') })
        ])
    })

    it('leaves a %include nothing satisfies an error on the line that wrote it', async () => {
        const built = await emulator.compileProject({ entry: 'main.asm', files: { 'main.asm': MAIN } })
        expect(built.ok).toBe(false)
        if (built.ok) return
        expect(built.errors[0]).toEqual(expect.objectContaining({ file: 'main.asm', line: 2, error: expect.stringContaining('sys/exit.inc') }))
    })

    it('must be a directory of the Project', () => {
        const files = { 'main.asm': '', 'lib/x.inc': '' }
        for (const path of ['', '/usr/include', '../include', 'a//b', 'lib/x.inc']) {
            expect(() => validateX86Project({ entry: 'main.asm', files, includePaths: [path] }), path).toThrow('Invalid x86 Project include path')
        }
        expect(() => validateX86Project({ entry: 'main.asm', files, includePaths: 'lib' as unknown as string[] })).toThrow('must be an array')
        expect(() => validateX86Project({ entry: 'main.asm', files, includePaths: ['lib', '@runtime/include'] })).not.toThrow()
    })

    it('leaves an included File named by the path it was staged at', () => {
        const staged = project({ 'main.asm': MAIN })
        expect(x86ProjectSourcePath(`/__x86_project/${INCLUDE}/sys/exit.inc`, staged)).toBe(`${INCLUDE}/sys/exit.inc`)
    })
})
