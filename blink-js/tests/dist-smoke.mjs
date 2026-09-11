// Smoke test for the published artifact: assembles and runs small x86-64
// programs through dist/, so it covers what a consumer of @specy/x86 actually
// imports rather than the sources vitest exercises.
//
// The vitest suite runs against src/, where the wasm arrives through a plugin
// in vitest.config.ts and the assembler ELFs are read out of src/assets. The
// published bundle gets both differently: rolldown-plugin-wasm inlines
// blinkenlib.wasm into dist/index.mjs, and scripts/copy-assets.mjs puts the
// ELFs next to it. Either can break with every src test still green, which is
// why this runs after `npm run build` rather than beside the unit tests.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/index.mjs', import.meta.url)
if (!existsSync(fileURLToPath(dist))) {
    console.error('dist/index.mjs is missing - run `npm run build` first.')
    process.exit(1)
}

const { createX86Emulator, EmulatorStatus } = await import(dist)

// ---------------------------------------------------------------------------
// Assembling and running
// ---------------------------------------------------------------------------

// NASM is the default assembler, so this passes no mode and exercises the one
// a caller gets by default. The program writes to fd 1 and then exits with a
// code of its own, so one run covers both the stdout callback and the exit
// path the host reads out of stopReason.
const SOURCE = [
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

let stdout = ''
const emulator = await createX86Emulator({
    callbacks: { stdout: (charCode) => { stdout += String.fromCharCode(charCode) } },
})
assert.equal(emulator.state, 'READY', 'the runtime initializes from the inlined wasm')

const result = await emulator.compile(SOURCE)
assert.equal(result.ok, true, `the program should assemble: ${result.report}`)
assert.equal(emulator.state, 'PROGRAM_LOADED')

// The instruction the program starts on, mapped back to its source line
// through the DWARF information the assembler emitted: line 6, counting from 0.
const entry = emulator.getNextInstruction()
assert.equal(entry.lineNumber, 6, 'execution starts at the first instruction of _start')
assert.match(entry.code, /mov/)

await emulator.runUntilBlocked()
assert.equal(emulator.getStatus(), EmulatorStatus.Terminated, 'the program ran to its exit syscall')
assert.equal(emulator.stopReason.kind, 'exit')
assert.equal(emulator.stopReason.exitCode, 7, 'the exit code the program asked for')
// The callback carries the emulator's own log lines too - the assembler and
// linker commands it ran - so the program's own output is what it ends with.
assert.ok(stdout.endsWith('ok\n'), `the write syscall reached the stdout callback: ${JSON.stringify(stdout)}`)
emulator.dispose()

// ---------------------------------------------------------------------------
// A project of several files
// ---------------------------------------------------------------------------

// Files are staged in the emulator's filesystem and the assembler resolves the
// include itself, so this is the path that needs the ELF assets copied beside
// the bundle. A breakpoint in the included file then proves the source map
// kept each instruction's own file.
const project = await createX86Emulator()
const built = await project.compileProject({
    entry: 'src/main.asm',
    files: {
        'src/main.asm': ['bits 64', 'global _start', 'section .text', '%include "parts/exit.asm"'].join('\n'),
        'src/parts/exit.asm': ['_start:', '  mov rax, 60', '  xor rdi, rdi', '  syscall'].join('\n'),
    },
})
assert.equal(built.ok, true, `a project of two files should assemble: ${built.report}`)

const next = project.getNextInstruction()
assert.equal(next.file, 'src/parts/exit.asm', 'an instruction names the file it was written in')
assert.equal(next.lineNumber, 1)

assert.equal(
    await project.run(undefined, [{ path: 'src/parts/exit.asm', line: 2 }]),
    EmulatorStatus.Running,
    'the run should stop on the breakpoint, not terminate'
)
assert.equal(project.stopReason.kind, 'breakpoint')
assert.equal(project.stopReason.file, 'src/parts/exit.asm')
assert.equal(project.stopReason.lineNumber, 2)
project.dispose()

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// A mistake builds no program and is reported on the line it is written on,
// which means the assembler's log reached the diagnostics parser.
const broken = await createX86Emulator()
const failed = await broken.compile(['bits 64', 'global _start', 'section .text', '_start:', '  mov rax, nope nonsense'].join('\n'))
assert.equal(failed.ok, false, 'a program with an error does not assemble')
assert.ok(failed.errors.length > 0, 'a failed build says what is wrong')
// A compile diagnostic carries the assembler's own 1-based line; checkCode is
// the surface that hands the editor the 0-based lineIndex.
assert.equal(failed.errors[0].line, 5, 'the diagnostic points at the line it is on')
assert.equal(typeof failed.errors[0].error, 'string')
broken.dispose()

console.log(`ok - ran a program to exit code 7, a two-file project to a breakpoint, and read ${failed.errors.length} diagnostic(s)`)
