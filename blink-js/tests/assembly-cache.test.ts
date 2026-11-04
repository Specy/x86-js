// Units assembled once and links run once: a Build of an unchanged Project assembles none of its
// Files again, scans none of them for `%include` again and runs no `ld`, while a File that changed,
// or one that includes a File that changed, is assembled again. The caches outlive an emulator, so
// each test writes sources of its own.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { linkerRunCount } from '../src/linker-runs'
import type { X86Project } from '../src/types'
import { nasmInstanceCount } from '../src/wasm-assembler'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'

let emulator: X86Emulator

beforeEach(async () => {
    emulator = await createX86Emulator()
})

afterEach(() => {
    emulator.dispose()
})

const exitWith = (code: string, tag: string) =>
    [`; ${tag}`, 'global _start', 'section .text', '_start:', `    mov edi, ${code}`, '    mov eax, 60', '    syscall'].join('\n')

/**
 * Builds and runs the Project; answers its exit code, how many NASM instances and `ld` runs the
 * Build took, and what it reported.
 */
async function build(project: X86Project) {
    const instancesBefore = nasmInstanceCount()
    const linksBefore = linkerRunCount()
    const built = await emulator.compileProject(project)
    expect(built.ok, built.report).toBe(true)
    const instances = nasmInstanceCount() - instancesBefore
    const links = linkerRunCount() - linksBefore
    await emulator.run(100_000)
    expect(emulator.stopReason?.kind).toBe('exit')
    return { exitCode: emulator.stopReason!.exitCode, instances, links, built }
}

it('assembles and links an unchanged Project once, and a changed File again', async () => {
    const helper = ['; cache test helper', 'global helper', 'section .text', 'helper:', '    ret'].join('\n')
    const project = (code: string): X86Project => ({
        entry: 'main.asm',
        files: { 'main.asm': exitWith(code, 'cache test main'), 'helper.asm': helper }
    })
    const first = await build(project('7'))
    expect(first.exitCode).toBe(7)
    //the Entry assembled, and not the helper, which nothing needs; neither has a word that reads
    //another File or uses the preprocessor, so neither is preprocessed
    expect([first.instances, first.links]).toEqual([1, 1])
    //nothing assembled or linked again, and the same report: the helper is still not linked
    const again = await build(project('7'))
    expect([again.exitCode, again.instances, again.links]).toEqual([7, 0, 0])
    expect(again.built.report).toBe(first.built.report)
    expect(again.built.diagnostics).toEqual(first.built.diagnostics)
    expect(again.built.diagnostics.map((item) => [item.file, item.warningClass])).toEqual([
        ['helper.asm', 'not-linked']
    ])
    //only the File that changed assembled, and linked again
    const changed = await build(project('9'))
    expect([changed.exitCode, changed.instances, changed.links]).toEqual([9, 1, 1])
})

it('assembles again a File whose included File changed', async () => {
    const project = (value: string): X86Project => ({
        entry: 'main.asm',
        files: {
            'main.asm': ['; include cache test', '%include "value.inc"', exitWith('EXIT_CODE', 'include cache test body')].join('\n'),
            'value.inc': `%define EXIT_CODE ${value}`
        }
    })
    expect((await build(project('5'))).exitCode).toBe(5)
    const changed = await build(project('6'))
    expect(changed.exitCode).toBe(6)
    expect(changed.instances).toBeGreaterThan(0)
    expect(changed.links).toBe(1)
})

it('starts a program whose link it reused from the beginning, though the last run stopped half way', async () => {
    const loop = [
        '; reuse after a pause',
        'global _start',
        'section .text',
        '_start:',
        '    mov ecx, 1000',
        'again:',
        '    loop again',
        '    mov edi, 3',
        '    mov eax, 60',
        '    syscall'
    ].join('\n')
    const project: X86Project = { entry: 'main.asm', files: { 'main.asm': loop } }
    expect((await emulator.compileProject(project)).ok).toBe(true)
    await emulator.run(50)
    expect(emulator.stopReason?.kind).not.toBe('exit')
    const links = linkerRunCount()
    expect((await emulator.compileProject(project)).ok).toBe(true)
    expect(linkerRunCount()).toBe(links)
    await emulator.run(100_000)
    expect(emulator.stopReason?.kind).toBe('exit')
    expect(emulator.stopReason?.exitCode).toBe(3)
    expect(emulator.getInstructionsExecuted()).toBeGreaterThan(1000n)
})

it("reads a program's instructions once, and the new ones once the program changed", async () => {
    const project = (code: string): X86Project => ({
        entry: 'main.asm',
        files: { 'main.asm': exitWith(code, 'instructions cache test') }
    })
    const codeOf = () => emulator.getCompiledInstructions().map((instruction) => instruction.code)
    expect((await emulator.compileProject(project('11'))).ok).toBe(true)
    const first = codeOf()
    expect(first).toContain('mov edi, 0x0b')
    //asked again, and after a Build of the unchanged Project: the same instructions
    expect(codeOf()).toEqual(first)
    expect((await emulator.compileProject(project('11'))).ok).toBe(true)
    expect(codeOf()).toEqual(first)
    //and the new program's once it changed
    expect((await emulator.compileProject(project('12'))).ok).toBe(true)
    expect(codeOf()).toContain('mov edi, 0x0c')
})
