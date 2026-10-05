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
//
// The package has a second entry point, @specy/x86/compiler-output, a bundle of
// its own with no WebAssembly in it. That is checked first, before this file
// has imported the root bundle, and the root's export names are checked
// against the ones 2.8.0 published, so adding the subpath changed nothing there.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const dist = new URL('../dist/index.mjs', import.meta.url)
const compilerOutputDist = new URL('../dist/compiler-output.mjs', import.meta.url)
for (const bundle of [dist, compilerOutputDist]) {
    if (!existsSync(fileURLToPath(bundle))) {
        console.error(`dist/${bundle.pathname.split('/').pop()} is missing - run \`npm run build\` first.`)
        process.exit(1)
    }
}

// ---------------------------------------------------------------------------
// The compiler-output subpath, without WebAssembly
// ---------------------------------------------------------------------------

// A consumer that only translates, such as a compiler driver or an offline
// build, must never load the emulator. So the subpath is imported by its
// package specifier, which the exports map in package.json resolves, with
// WebAssembly replaced by a stub that throws on any use: importing the bundle,
// reading its profile and translating must not touch it. Nothing has imported
// the root bundle yet, so no module the two bundles could share has already
// been evaluated with the real WebAssembly.
assert.equal(import.meta.resolve('@specy/x86/compiler-output'), compilerOutputDist.href, 'the exports map resolves the subpath to its own bundle')
assert.equal(import.meta.resolve('@specy/x86'), dist.href, 'and the root to the emulator')

// The stub only notices WebAssembly being used, and the root bundle instantiates
// its inlined wasm lazily, so the bundle is also read for wasm it carries (a
// wasm module starts with \0asm, `AGFzbQ` in base64) or names, and the import
// below records every module it resolves.
const compilerOutputSource = readFileSync(compilerOutputDist, 'utf8')
for (const marker of ['AGFzbQ', '.wasm', 'blinkenlib', 'nasm.mjs']) {
    assert.equal(compilerOutputSource.includes(marker), false, `the subpath bundle carries no wasm, and ${marker} is not in it`)
}
const resolvedModules = []

// GCC 14.2's output for a C++ global built by a constructor, under the profile's
// flags at -O2: the `ctor` case of tests/fixtures/gcc-intel-v1, in the tab layout
// `gcc -S` writes, without the DWARF sections between `.Letext0:` and `.ident`,
// which the translation drops anyway. main returns 42 only if the constructor ran.
const CTOR_O2 = [
    '\t.file\t"example.cpp"',
    '\t.intel_syntax noprefix',
    '\t.text',
    '.Ltext0:',
    '\t.file 0 "/app" "/app/example.cpp"',
    '\t.section\t.text.startup,"ax",@progbits',
    '\t.p2align 4',
    '\t.globl\tmain',
    '\t.type\tmain, @function',
    'main:',
    '.LFB4:',
    '\t.file 1 "src/main.cpp"',
    '\t.loc 1 5 12',
    '\t.cfi_startproc',
    '\t.loc 1 5 35',
    '\tmov\teax, DWORD PTR config[rip]',
    '\tret',
    '\t.cfi_endproc',
    '.LFE4:',
    '\t.size\tmain, .-main',
    '\t.p2align 4',
    '\t.type\t_GLOBAL__sub_I_seven, @function',
    '_GLOBAL__sub_I_seven:',
    '.LFB6:',
    '\t.loc 1 5 35',
    '\t.cfi_startproc',
    '.LBB17:',
    '.LBB18:',
    '\t.loc 1 4 20',
    '\tmov\teax, DWORD PTR seven[rip]',
    '.LBB19:',
    '.LBB20:',
    '.LBB21:',
    '.LBB22:',
    '.LBB23:',
    '\t.loc 1 1 40',
    '\tlea\teax, [rax+rax*2]',
    '\tadd\teax, eax',
    '.LBE23:',
    '.LBE22:',
    '\t.loc 1 2 53 discriminator 1',
    '\tmov\tDWORD PTR config[rip], eax',
    '.LBE21:',
    '.LBE20:',
    '.LBE19:',
    '.LBE18:',
    '.LBE17:',
    '\t.loc 1 5 35',
    '\tret',
    '\t.cfi_endproc',
    '.LFE6:',
    '\t.size\t_GLOBAL__sub_I_seven, .-_GLOBAL__sub_I_seven',
    '\t.section\t.init_array,"aw"',
    '\t.align 8',
    '\t.quad\t_GLOBAL__sub_I_seven',
    '\t.globl\tconfig',
    '\t.bss',
    '\t.align 4',
    '\t.type\tconfig, @object',
    '\t.size\tconfig, 4',
    'config:',
    '\t.zero\t4',
    '\t.globl\tseven',
    '\t.data',
    '\t.align 4',
    '\t.type\tseven, @object',
    '\t.size\tseven, 4',
    'seven:',
    '\t.long\t7',
    '\t.text',
    '.Letext0:',
    '\t.ident\t"GCC: (Compiler-Explorer-Build-gcc--binutils-2.42) 14.2.0"',
    '\t.section\t.note.GNU-stack,"",@progbits',
]

// One case of the corpus itself, when this runs from the repository: the
// fixtures are not part of the published package.
const FIXTURE_CASE = new URL('./fixtures/gcc-intel-v1/cases/fixture-O0.json.gz', import.meta.url)

const webAssemblyUses = []
const realWebAssembly = Object.getOwnPropertyDescriptor(globalThis, 'WebAssembly')
// The handler is itself a proxy, so every trap the engine looks up on it - a
// property read, a call, a construction, even a key enumeration - records the
// use and throws, whether or not the bundle catches what it throws.
const forbiddenWebAssembly = new Proxy(
    function WebAssembly() {},
    new Proxy(
        {},
        {
            get: (_handler, trap) => (_target, key) => {
                const use = typeof key === 'string' ? `${trap} ${key}` : String(trap)
                webAssemblyUses.push(use)
                throw new Error(`the compiler-output subpath used WebAssembly (${use})`)
            },
        }
    )
)

let ctor
let fixture = null
Object.defineProperty(globalThis, 'WebAssembly', { ...realWebAssembly, value: forbiddenWebAssembly })
const moduleHooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        const resolved = nextResolve(specifier, context)
        resolvedModules.push(resolved.url)
        return resolved
    },
})
try {
    assert.equal(globalThis.WebAssembly, forbiddenWebAssembly, 'the stub is in place')
    const compilerOutput = await import('@specy/x86/compiler-output')
    assert.deepEqual(resolvedModules, [compilerOutputDist.href], 'importing the subpath loads its bundle and nothing else')
    const { GCC_INTEL_V1, translateCompilerOutput } = compilerOutput
    assert.deepEqual(Object.keys(compilerOutput), ['GCC_INTEL_V1', 'translateCompilerOutput'], 'the subpath exports the translator and its profile')
    assert.equal(GCC_INTEL_V1.id, 'gcc-intel-v1')
    assert.ok(GCC_INTEL_V1.flags.translation.includes('-masm=intel'))
    assert.ok(Object.isFrozen(GCC_INTEL_V1.flags.translation), 'a consumer cannot change the profile')
    assert.throws(
        () => translateCompilerOutput(CTOR_O2, { profile: 'gcc-intel-v0' }),
        /Unknown compiler-output translation profile/,
        'an unknown profile id is the one thing that throws'
    )

    ctor = translateCompilerOutput(CTOR_O2, { profile: GCC_INTEL_V1.id })
    assert.equal(ctor.ok, true, `the C++ program should translate: ${JSON.stringify(ctor.diagnostics)}`)
    assert.deepEqual(ctor.diagnostics, [], 'its .ident names GCC 14.2, so not even a warning')
    assert.equal(ctor.text, ctor.lines.map((line) => `${line.text}\n`).join(''), 'the text is its lines, in order')
    assert.deepEqual(ctor.lines[0], { text: '    default rel', inputLine: null, synthesized: true, location: null }, 'the header comes from no input line')
    assert.deepEqual(
        ctor.lines.find((line) => line.inputLine === 15),
        { text: '    mov eax, dword [rel config]', inputLine: 15, synthesized: false, location: { file: 'src/main.cpp', line: 5, column: 35 } },
        'an instruction keeps the line it came from and the .loc in effect there'
    )
    assert.equal(ctor.lines.find((line) => line.inputLine === 54)?.text, '    dq _GLOBAL__sub_I_seven', 'the constructor stays in .init_array')
    assert.deepEqual(ctor.symbols, {
        defined: [
            { name: 'main', nasmName: 'main', binding: 'global' },
            { name: 'config', nasmName: 'config', binding: 'global' },
            { name: 'seven', nasmName: 'seven', binding: 'global' },
        ],
        common: [],
        external: [],
        constructors: [{ name: '_GLOBAL__sub_I_seven', nasmName: '_GLOBAL__sub_I_seven' }],
    })
    assert.equal(translateCompilerOutput(CTOR_O2, { profile: 'gcc-intel-v1' }).text, ctor.text, 'translating twice gives the same text')

    // Inline assembly is refused, at its own line and with the location in
    // effect there, and an error leaves no output at all.
    const withInlineAssembly = [...CTOR_O2.slice(0, 16), '#APP', '# 5 "src/main.cpp" 1', '\tnop', '# 0 "" 2', '#NO_APP', ...CTOR_O2.slice(16)]
    const refused = translateCompilerOutput(withInlineAssembly, { profile: 'gcc-intel-v1' })
    assert.equal(refused.ok, false, 'inline assembly does not translate')
    assert.equal('text' in refused, false, 'an error means no output')
    assert.deepEqual(
        refused.diagnostics.map(({ severity, code, inputLine, location }) => ({ severity, code, inputLine, location })),
        [{ severity: 'error', code: 'inline-assembly', inputLine: 16, location: { file: 'src/main.cpp', line: 5, column: 35 } }]
    )

    if (existsSync(fileURLToPath(FIXTURE_CASE))) {
        const stored = JSON.parse(gunzipSync(readFileSync(FIXTURE_CASE)).toString('utf8'))
        const translation = translateCompilerOutput(
            stored.response.asm.map((line) => line.text),
            { profile: 'gcc-intel-v1' }
        )
        assert.equal(stored.outcome.kind, 'exit', 'the fixture case is meant to run')
        assert.equal(translation.ok, true, `the fixture case should translate: ${JSON.stringify(translation.diagnostics)}`)
        assert.deepEqual(translation.diagnostics, [])
        assert.ok(translation.symbols.defined.some((symbol) => symbol.name === 'main'), 'it defines main')
        assert.ok(
            translation.lines.some((line) => line.location?.file === '/app/values.h'),
            'an instruction from the inline function in values.h is located there'
        )
        fixture = { name: stored.case, exitCode: stored.outcome.value, translation }
    } else {
        console.log(`skip - ${fileURLToPath(FIXTURE_CASE)} is not here, so only the inline program is translated`)
    }
} finally {
    moduleHooks.deregister()
    Object.defineProperty(globalThis, 'WebAssembly', realWebAssembly)
}
assert.deepEqual(webAssemblyUses, [], 'the compiler-output subpath never touched WebAssembly')
assert.deepEqual(resolvedModules, [compilerOutputDist.href], 'translating loaded no module either')

// ---------------------------------------------------------------------------
// The root export
// ---------------------------------------------------------------------------

// Every name the root module exported in 2.8.0, recorded from that build. The
// subpath is an addition, so the root must export exactly these: change this
// list only in the commit that changes the root surface on purpose.
const ROOT_EXPORTS_2_8_0 = [
    'BaseEmulator', 'BlinkRuntime', 'BlinkState', 'DEFAULT_ASSEMBLER_ID', 'EmulatorStatus', 'RegisterSize',
    'X86Emulator', 'X86_FPU_STATE_CW_OFFSET', 'X86_FPU_STATE_DP_OFFSET', 'X86_FPU_STATE_IP_OFFSET',
    'X86_FPU_STATE_MXCSR_OFFSET', 'X86_FPU_STATE_OP_OFFSET', 'X86_FPU_STATE_SIZE', 'X86_FPU_STATE_ST_OFFSET',
    'X86_FPU_STATE_SW_OFFSET', 'X86_FPU_STATE_TW_OFFSET', 'X86_FPU_STATE_XMM_OFFSET', 'X86_PROJECT_ROOT',
    'X86_REGISTER_NAMES', 'X86_SSE_REGISTERS', 'X86_X87_REGISTERS', 'assemblers', 'createX86Emulator',
    'decodeFpuState', 'defaultResourceUrl', 'emptyFpuStateBlock', 'encodeFpuState', 'fasmDiagnostics',
    'fpuStateBlocksEqual', 'gnuDiagnostics', 'isNodeRuntime', 'isShadowAddress', 'ldDiagnostics',
    'locateDiagnosticColumn', 'locateDiagnosticSpan', 'nasmDiagnostics', 'observeCallbackResult',
    'readLogicalStBits', 'readLogicalStTags', 'readResourceBytes', 'selectX86Source', 'stageX86Project',
    'toResourceUrl', 'validateX86Project', 'x86ProjectSourcePath', 'x86ProjectText',
]

const root = await import(dist)
const rootNames = Object.keys(root)
assert.deepEqual(
    {
        added: rootNames.filter((name) => !ROOT_EXPORTS_2_8_0.includes(name)),
        removed: ROOT_EXPORTS_2_8_0.filter((name) => !rootNames.includes(name)),
    },
    { added: [], removed: [] },
    'the root module exports exactly the names 2.8.0 did'
)

const { createX86Emulator, EmulatorStatus, RegisterSize, X86_SSE_REGISTERS, X86_X87_REGISTERS, X86_FPU_STATE_SIZE, decodeFpuState, encodeFpuState } = root

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
// Exit must retain a restorable machine in the artifact, just as it does in src/.
emulator.initialize(16)
await emulator.runUntilBlocked()
emulator.undo()
assert.equal(emulator.hasTerminated(), false, 'undo restores the instruction before exit')
assert.equal(emulator.getNextInstruction()?.lineNumber, SOURCE.split('\n').length - 1)
await emulator.step()
assert.equal(emulator.stopReason?.exitCode, 7, 'stepping replays exit without aborting the wasm')
emulator.undo()
await emulator.runUntilBlocked()
assert.equal(emulator.stopReason?.exitCode, 7, 'running replays exit on the same machine')
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
// The SSE and x87 register files
// ---------------------------------------------------------------------------

// getFpuState() reaches all the way into the wasm bridge, so it only works in
// the published bundle if the embind facade survived the build. This covers
// both files in one program: an SSE write, an x87 push and add, the undo that
// rolls both back, and a preset written straight into the machine.
assert.equal(X86_SSE_REGISTERS.length, 17, 'xmm0..xmm15 plus mxcsr')
assert.equal(X86_SSE_REGISTERS[0], 'xmm0')
assert.equal(X86_SSE_REGISTERS[16], 'mxcsr')
assert.deepEqual([...X86_X87_REGISTERS].slice(8), ['fctrl', 'fstat', 'ftag'])
assert.equal(X86_FPU_STATE_SIZE, 356)
assert.equal(RegisterSize.Quad, 16, 'an SSE register is 16 bytes wide')

const fpu = await createX86Emulator({ mode: 'GNU_trunk' })
const fpuBuilt = await fpu.compile([
    '.global _start',
    '.text',
    '_start:',
    '  movabs $0x4010000000000000, %rax',
    '  movq %rax, %xmm0',
    '  fld1',
    '  fld1',
    '  faddp',
    '  mov $60, %rax',
    '  xor %rdi, %rdi',
    '  syscall',
].join('\n'))
assert.equal(fpuBuilt.ok, true, `the FPU program should assemble: ${fpuBuilt.report}`)

fpu.initialize(8)
await fpu.step()
await fpu.step()
assert.equal(fpu.getFpuState().xmm[0], 0x4010000000000000n, 'movq wrote 4.0 into xmm0')

const xmmWrite = fpu
    .getUndoHistory(1)[0]
    .mutations.find((mutation) => mutation.type === 'WriteRegister' && mutation.value.register === 'xmm0')
assert.ok(xmmWrite, 'the step names xmm0 as a register write')
assert.equal(xmmWrite.value.size, RegisterSize.Quad, 'an xmm write is 16 bytes wide')
assert.equal(xmmWrite.value.old, 0n)
assert.equal(xmmWrite.value.new, 0x4010000000000000n, 'the write reports the value it wrote as well as the one it replaced')

await fpu.step()
await fpu.step()
await fpu.step()
assert.equal(fpu.getFpuState().st[0], 2, 'fld1; fld1; faddp leaves 2 on top of the x87 stack')

fpu.undo()
assert.equal(fpu.getFpuState().st[0], 1, 'undo puts the stack back as faddp found it')
assert.equal(fpu.getFpuState().st[1], 1)
fpu.undo()
fpu.undo()
assert.equal(fpu.getFpuState().xmm[0], 0x4010000000000000n, 'undoing the x87 steps left xmm0 alone')

// A preset goes straight into the machine, so it is not something to undo.
const historyLength = fpu.getUndoHistory(8).length
const preset = fpu.getFpuState()
preset.xmm[7] = (0xaaaaaaaaaaaaaaaan << 64n) | 0x5555555555555555n
preset.st[0] = -0.5
fpu.setFpuState(preset)
const presetBack = fpu.getFpuState()
assert.equal(presetBack.xmm[7], (0xaaaaaaaaaaaaaaaan << 64n) | 0x5555555555555555n)
assert.equal(presetBack.st[0], -0.5)
assert.equal(fpu.getUndoHistory(8).length, historyLength, 'a preset adds no undo entry')

// The pure codec is exported beside the emulator, and round trips the block.
const rawBlock = fpu.runtime.getFpuStateRaw()
assert.equal(rawBlock.length, X86_FPU_STATE_SIZE)
assert.deepEqual(
    Array.from(encodeFpuState(decodeFpuState(rawBlock), rawBlock)),
    Array.from(rawBlock),
    'decode then encode reproduces the block byte for byte'
)
fpu.dispose()

// ---------------------------------------------------------------------------
// What a memory write left
// ---------------------------------------------------------------------------

// The memory half of the write values: a store's history entry names the bytes
// it replaced and the bytes it left, at the width of the store.
const stores = await createX86Emulator({ mode: 'GNU_trunk' })
const storesBuilt = await stores.compile([
    '.global _start',
    '.data',
    'buffer: .quad 0x1122334455667788',
    '.text',
    '_start:',
    '  lea buffer(%rip), %rbx',
    '  movw $0xbeef, (%rbx)',
    '  mov $60, %rax',
    '  xor %rdi, %rdi',
    '  syscall',
].join('\n'))
assert.equal(storesBuilt.ok, true, `the store program should assemble: ${storesBuilt.report}`)

stores.initialize(8)
await stores.step()
const bufferAddress = stores.getRegisterValue('rbx')
await stores.step()
const memoryWrite = stores
    .getUndoHistory(1)[0]
    .mutations.find((mutation) => mutation.type === 'WriteMemoryBytes')
assert.ok(memoryWrite, 'the step names the memory it wrote')
assert.equal(memoryWrite.value.address, bufferAddress)
assert.deepEqual(memoryWrite.value.old, [0x88, 0x77], 'the two bytes the store replaced')
assert.deepEqual(memoryWrite.value.new, [0xef, 0xbe], 'the two bytes it left, at the width of the store')
assert.deepEqual(Array.from(stores.readMemoryBytes(bufferAddress, 2n)), memoryWrite.value.new)
stores.undo()
assert.deepEqual(Array.from(stores.readMemoryBytes(bufferAddress, 2n)), [0x88, 0x77], 'undo puts the old bytes back')
stores.dispose()

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

// ---------------------------------------------------------------------------
// Translated compiler output, built and run
// ---------------------------------------------------------------------------

// The translator writes no startup code, so a Build brings its own start unit:
// this is the one the package README shows, and running the translations with
// it here is what keeps that example honest. It runs the .init_array entries
// in order, calls main and exits with main's result, and pushes nothing, so the
// 16-byte alignment Linux starts rsp with reaches every callee intact.
const START_UNIT = `    default rel
    extern main
    extern __init_array_start     ; ld defines both, around .init_array
    extern __init_array_end
    global _start

    section .text
_start:
    lea rbx, [__init_array_start] ; rbx is callee-saved: it survives the calls
.next:
    lea rax, [__init_array_end]
    cmp rbx, rax
    jae .done
    call [rbx]                    ; one constructor
    add rbx, 8
    jmp .next
.done:
    call main
    mov edi, eax                  ; main's result is the exit status
    mov eax, 60                   ; exit
    syscall
`

/** Builds a translation with the start unit as its library and runs it, returning the exit code. */
async function runTranslated(name, translation) {
    const machine = await createX86Emulator()
    try {
        // The archive `ld` takes the start unit from is written in TypeScript, so the
        // bundle has to carry it as well as the property that announces it.
        assert.equal(machine.projectLinking, 'archive', 'a Project links from an archive')
        const build = await machine.compileProject({
            entry: 'main.asm',
            files: { 'main.asm': translation.text },
            library: { 'start.asm': START_UNIT },
        })
        assert.equal(build.ok, true, `${name} should build: ${build.report}`)
        assert.deepEqual(build.diagnostics, [], `${name}: what the translator writes assembles with no NASM warnings`)

        // Loads the program and pauses at its entry, which is in the start unit.
        const compiled = machine.getCompiledInstructions()
        assert.equal(machine.getNextInstruction().file, 'start.asm', `${name} starts at _start`)
        assert.equal(machine.getRegisterValue('rsp') % 16n, 0n, `${name} starts with rsp 16-byte aligned`)

        // The Core reports each instruction's zero-based line in the File it was
        // assembled from; in the translation, that is an index into lines.
        const translated = compiled.filter((instruction) => instruction.file === 'main.asm')
        // Alignment kept before a function pads with NOPs, listed on its `align`
        // line: no source line made them, and nothing runs them, since they follow
        // the previous function's last instruction. Everything else came from GCC.
        const isPadding = (instruction) => /^\s*align \d+$/.test(translation.lines[instruction.lineNumber]?.text ?? '')
        for (const instruction of translated.filter(isPadding)) {
            const text = /class='str'>([^<]*)</.exec(instruction.code ?? '')?.[1] ?? instruction.code
            assert.match(text.trim(), /^nop\b/, `${name}: the padding on line ${instruction.lineNumber} is NOPs`)
        }
        const generated = translated.filter((instruction) => !isPadding(instruction))
        assert.equal(
            new Set(generated.map((instruction) => instruction.lineNumber)).size,
            translation.lines.filter((line) => line.location).length,
            `${name}: one instruction for every located line`
        )
        for (const instruction of generated) {
            assert.ok(
                translation.lines[instruction.lineNumber]?.location,
                `${name}: the instruction on line ${instruction.lineNumber} leads back to a source location`
            )
        }

        await machine.runUntilBlocked()
        assert.equal(machine.stopReason.kind, 'exit', `${name} runs to its exit`)
        return machine.stopReason.exitCode
    } finally {
        machine.dispose()
    }
}

assert.equal(await runTranslated('ctor-O2', ctor), 42, 'the constructor ran through .init_array before main read its result')
if (fixture) {
    assert.equal(await runTranslated(fixture.name, fixture.translation), fixture.exitCode, `${fixture.name} exits with its intended value`)
}

console.log(`ok - ran a program to exit code 7, a two-file project to a breakpoint, the SSE and x87 register files through undo, checked both sides of a store, and read ${failed.errors.length} diagnostic(s)`)
console.log(`ok - translated GCC output through @specy/x86/compiler-output without WebAssembly, built and ran ${fixture ? `ctor-O2 and ${fixture.name}` : 'ctor-O2'} with a start unit, and the root still exports the ${ROOT_EXPORTS_2_8_0.length} names of 2.8.0`)
