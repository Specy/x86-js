// NASM 3.00 built as its own wasm module by ../../compile_wasm_nasm.sh, rather
// than as the x86-64 ELF blink interprets. These tests cover the contract a
// caller needs: the object bytes it produces, the status it exits with, and the
// diagnostics it writes - the three things the assembler pipeline reads.
//
// The module is a build artifact checked in beside blinkenlib, so this runs
// against whatever the last ./compile_wasm_nasm.sh produced.
import { describe, expect, it } from 'vitest'
import createNasm, { type NasmModule } from '../src/wasm/nasm.mjs'
import { nasmDiagnostics } from '../src/assemblers'

const ARGS = ['-g', '-F', 'dwarf', '-felf64', '/assembly.s', '-o', '/program.o']

type Run = { status: number; stderr: string; object: Uint8Array | null }

async function assemble(files: Record<string, string>, args: string[] = ARGS): Promise<Run> {
    let stderr = ''
    const module: NasmModule = await createNasm({
        noInitialRun: true,
        print: () => {},
        printErr: (line) => {
            stderr += `${line}\n`
        },
    })
    for (const [path, contents] of Object.entries(files)) {
        const directory = path.slice(0, path.lastIndexOf('/'))
        if (directory) module.FS.mkdirTree(directory)
        module.FS.writeFile(path, contents)
    }
    const status = module.callMain([...args])
    const object = module.FS.analyzePath('/program.o').exists
        ? (module.FS.readFile('/program.o') as Uint8Array)
        : null
    return { status, stderr, object }
}

const HELLO = [
    'bits 64',
    'global _start',
    'section .data',
    'msg: db "ok", 10',
    'section .text',
    '_start:',
    '  mov rax, 1',
    '  mov rdi, 1',
    '  mov rsi, msg',
    '  mov rdx, 3',
    '  syscall',
    '  mov rax, 60',
    '  mov rdi, 7',
    '  syscall',
].join('\n')

describe('nasm as a wasm module', () => {
    it('assembles to an ELF object carrying DWARF', async () => {
        const run = await assemble({ '/assembly.s': HELLO })

        expect(run.status).toBe(0)
        expect(run.stderr).toBe('')
        expect(run.object).not.toBeNull()
        // \x7fELF
        expect([...run.object!.slice(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46])
        // The source map reads .debug_line out of the linked executable, so the
        // object has to carry it through for the debugger to work at all.
        const text = new TextDecoder('latin1').decode(run.object!)
        expect(text).toContain('.debug_line')
    })

    it('resolves %include against the staged files', async () => {
        const run = await assemble({
            '/assembly.s': ['bits 64', 'global _start', 'section .text', '%include "parts/exit.asm"'].join('\n'),
            '/parts/exit.asm': ['_start:', '  mov rax, 60', '  xor rdi, rdi', '  syscall'].join('\n'),
        })

        expect(run.stderr).toBe('')
        expect(run.status).toBe(0)
        expect(run.object).not.toBeNull()
    })

    it('reports a syntax error in the form the diagnostics parser reads', async () => {
        const run = await assemble({
            '/assembly.s': ['bits 64', 'global _start', 'section .text', '_start:', '  mov rax, nope nonsense'].join('\n'),
        })

        expect(run.status).toBe(1)
        expect(nasmDiagnostics(run.stderr)).toEqual([
            {
                file: '/assembly.s',
                line: 5,
                error: expect.stringContaining('expected'),
                severity: 'error',
            },
        ])
    })

    it('reports a missing include on the line that asks for it', async () => {
        const run = await assemble({ '/assembly.s': ['bits 64', '%include "nope.asm"'].join('\n') })

        expect(run.status).toBe(1)
        expect(nasmDiagnostics(run.stderr)[0]).toMatchObject({ file: '/assembly.s', line: 2 })
    })

    it('exits non-zero rather than throwing when the arguments are wrong', async () => {
        const run = await assemble({ '/assembly.s': HELLO }, ['--not-an-option', '/assembly.s'])

        expect(run.status).toBe(1)
    })

    it('is good for one assembly per instance, and instances are independent', async () => {
        const first = await assemble({ '/assembly.s': HELLO })
        const second = await assemble({ '/assembly.s': HELLO })

        expect(first.status).toBe(0)
        expect(second.status).toBe(0)
        // Same input, same NASM, same flags: the bytes have to match, or the
        // module is carrying state between instantiations.
        expect(Buffer.from(second.object!)).toEqual(Buffer.from(first.object!))
    })
})

describe('the host process', () => {
    it('does not inherit the exit status of a failed assembly', async () => {
        const before = process.exitCode

        const { nasmWasmAssembler } = await import('../src/wasm-assembler')
        const failed = await nasmWasmAssembler.assemble({
            entry: 'assembly.s',
            files: { 'assembly.s': 'bits 64\nsection .text\n  mov rax, nope nonsense' },
        })

        expect(failed.status).toBe(1)
        // Emscripten sets process.exitCode from the module's status under Node,
        // which would make a build that merely failed exit the whole process.
        expect(process.exitCode).toBe(before)
    })
})
