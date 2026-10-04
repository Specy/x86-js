// Captures the `gcc-intel-v1` corpus: GCC 14.2's x86-64 output for every program of
// tests/fixtures/gcc-intel-v1/manifest.json, with a GNU as reference build of each runnable case,
// the x87 matrix, a raw inventory of the output and the capture environment.
//
// This is the package's only contact with Compiler Explorer, and CI never runs it: the tests read
// what it stores. GNU as runs here too, and only here (gate 1 of
// docs/design/x86-compiler-assembly-translation-plan.md in the editor repository), through the
// GNU_trunk binaries in Blink, so everything the GNU comparison needs is stored in the fixtures.
//
//   npm run build && node scripts/capture-gcc-fixtures.mjs [options]
//
//   --only <regex>      only the cases (`<program>-O<level>`) the expression matches
//   --offline           reuse each case's stored response instead of asking Compiler Explorer, to
//                       rebuild references or apply a changed outcome
//   --concurrency <n>   Compiler Explorer requests in flight at once (default 2); Compiler Explorer
//                       rate-limits bursts, which the script waits out
//   --skip-x87          leave the x87 matrix as it is
//
// Every reference runs natively, so the script refuses any host but x86-64 Linux. Blink's result
// for a reference is reported, not stored: a fix to Blink would make it stale, and the tests run
// the references in Blink themselves. capture.json records what produced the fixtures: the
// submodule's revision and every uncommitted or untracked file in it, and the hashes of this
// script and of the built Core it ran.

import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(PACKAGE, 'tests/fixtures/gcc-intel-v1')
const CASES = join(FIXTURES, 'cases')
const X87 = join(FIXTURES, 'x87')
const DIST = join(PACKAGE, 'dist/index.mjs')
const FORMAT = 1

/** The Core's GNU_trunk command plus `-L`, which keeps `.L` local labels in the symbol table. */
const REFERENCE_ASSEMBLER = '/assembler --gdwarf-4 -L /assembly.s -o /program.o'
const REQUEST_ATTEMPTS = 8
const REQUEST_TIMEOUT_MS = 90_000
const REQUEST_SPACING_MS = 1000
const NATIVE_TIMEOUT_MS = 10_000
/** Instructions a reference may run in Blink: the longest corpus program runs fewer than 32,000. */
const RUN_LIMIT = 1_000_000

const FILTERS = {
    binary: false,
    execute: false,
    labels: false,
    directives: false,
    commentOnly: false,
    trim: false,
    demangle: false,
    libraryCode: false,
}

/**
 * Runs before GCC's output in every reference build: each `.init_array` entry in order, with a
 * callee-saved register as the cursor and no pushes, so the stack Linux hands `_start` stays
 * 16-byte aligned at every call; then `main`, exiting with its result.
 */
const START = [
    '        .intel_syntax noprefix',
    '        .text',
    '        .globl  _start',
    '        .type   _start, @function',
    '_start:',
    '        mov     rbx, OFFSET FLAT:__init_array_start',
    '.Lstart_next:',
    '        cmp     rbx, OFFSET FLAT:__init_array_end',
    '        jae     .Lstart_main',
    '        call    [QWORD PTR [rbx]]',
    '        add     rbx, 8',
    '        jmp     .Lstart_next',
    '.Lstart_main:',
    '        call    main',
    '        mov     edi, eax',
    '        mov     eax, 60',
    '        syscall',
]

const options = parseArguments(process.argv.slice(2))
if (process.platform !== 'linux' || process.arch !== 'x64') {
    console.error(`The capture runs every reference natively, so it needs an x86-64 Linux host, not ${process.platform} ${process.arch}.`)
    process.exit(1)
}
if (!existsSync(DIST)) {
    console.error('dist/index.mjs is missing: run `npm run build` first.')
    process.exit(1)
}
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
const capturedAt = new Date().toISOString()
const scratch = mkdtempSync(join(tmpdir(), 'gcc-intel-v1-'))
const core = await import(pathToFileURL(DIST).href)
const referenceMode = {
    ...core.assemblers.GNU_trunk,
    binaries: {
        ...core.assemblers.GNU_trunk.binaries,
        assembler: { ...core.assemblers.GNU_trunk.binaries.assembler, commands: REFERENCE_ASSEMBLER },
    },
}

mkdirSync(CASES, { recursive: true })
mkdirSync(X87, { recursive: true })

const cases = manifest.programs.flatMap((program) =>
    (program.optimizations ?? manifest.optimizations).map((level) => ({
        program,
        level,
        name: `${program.name}-O${level}`,
        outcome: program.outcomes?.[level] ?? program.outcome,
    })),
)
const selected = cases.filter((entry) => !options.only || options.only.test(entry.name))
const builder = createReferenceBuilder()
const summary = []

// ---------------------------------------------------------------------------
// Compiler Explorer
// ---------------------------------------------------------------------------

/** The editor's request shape (`createCompilerRequest` in src/lib/sourceCompilation/compilerExplorer.ts) for x86: no `main` rename and no signature line. */
function compilerRequest(program, level) {
    const { flags, compilerExplorer } = manifest
    const sourcePath = compilerExplorer.sourcePaths[program.language]
    const profileFlags = [
        ...flags.translation,
        ...flags.locations,
        ...flags.target,
        ...flags.language[program.language],
        ...flags.driver.map((flag) => flag.replace('<level>', level)),
        ...(program.language === 'cpp' ? flags.driverCpp : []),
    ]
    const replace = program.flags?.replace ?? {}
    for (const flag of Object.keys(replace)) {
        if (!profileFlags.includes(flag)) throw new Error(`${program.name}: no ${flag} to replace`)
    }
    const userArguments = [...profileFlags.map((flag) => replace[flag] ?? flag), ...(program.flags?.add ?? [])].join(' ')
    const body = {
        source: `#line 1 ${JSON.stringify(sourcePath)}\n${program.source}`,
        lang: program.language === 'cpp' ? 'c++' : 'c',
        options: { userArguments, filters: FILTERS },
        files: Object.entries(program.headers).map(([filename, contents]) => ({ filename, contents })),
    }
    return { compiler: compilerExplorer.compilers[program.language], sourcePath, userArguments, body }
}

async function compile(request, label) {
    const url = manifest.compilerExplorer.endpoint.replace('<compiler>', request.compiler)
    for (let attempt = 1; ; attempt += 1) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(request.body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (response.status === 429) throw new TransientError('HTTP 429 (rate limited)', rateLimitDelay(response, attempt))
            if (response.status >= 500) throw new TransientError(`HTTP ${response.status}`)
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
            const result = await response.json()
            if (result.timedOut) throw new TransientError('the compilation timed out')
            if (result.truncated) throw new Error('Compiler Explorer truncated the output')
            if (!Array.isArray(result.asm)) throw new TransientError('the response has no assembly')
            return {
                code: result.code,
                stdout: result.stdout ?? [],
                stderr: result.stderr ?? [],
                asm: result.asm.map((line) => ({ text: line.text, source: line.source ?? null })),
            }
        } catch (error) {
            const transient =
                error instanceof TransientError ||
                error?.name === 'TimeoutError' ||
                error?.name === 'AbortError' ||
                (error instanceof TypeError && /fetch failed/i.test(error.message))
            if (!transient || attempt >= REQUEST_ATTEMPTS) throw new Error(`${label}: ${error.message}`, { cause: error })
            const delay = error.delay ?? 2000 * 2 ** (attempt - 1)
            console.warn(`${label}: ${error.message}; retrying in ${delay / 1000} s`)
            await sleep(delay)
        }
    }
}

class TransientError extends Error {
    constructor(message, delay) {
        super(message)
        this.delay = delay
    }
}

/** `Retry-After` when Compiler Explorer sends one, otherwise a backoff from 30 s up to 5 minutes. */
function rateLimitDelay(response, attempt) {
    const seconds = Number(response.headers.get('retry-after'))
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
    return Math.min(300_000, 30_000 * 2 ** (attempt - 1))
}

function assertSameRequest(name, stored, request) {
    const same =
        stored.compiler === request.compiler &&
        stored.userArguments === request.userArguments &&
        stored.sourcePath === request.sourcePath &&
        `#line 1 ${JSON.stringify(stored.sourcePath)}\n${stored.source}` === request.body.source &&
        JSON.stringify(stored.headers) === JSON.stringify(Object.fromEntries(request.body.files.map((file) => [file.filename, file.contents])))
    if (!same) throw new Error(`${name}: the manifest changed what is compiled, so the stored response cannot be reused offline`)
}

// ---------------------------------------------------------------------------
// GNU as reference builds
// ---------------------------------------------------------------------------

/**
 * Which cases get a reference: those meant to run, other than the mixed C and NASM programs, which
 * the Core's GNU mode cannot build since it assembles only the Entry. A link failure is built too,
 * without an executable, so its `ld` diagnostics are on record. A case meant to fail translation
 * gets one only when its program names a `referenceOutcome`, the outcome its GNU as build has, which
 * shows the program itself works as written. Blink's result is returned beside the reference, for
 * the report only.
 */
async function referenceFor(entry, response) {
    if (response.code !== 0) return { reference: null, referenceSkipped: 'the compilation failed' }
    const expected = referenceOutcome(entry)
    if (!expected) {
        return { reference: null, referenceSkipped: 'a translation error is intended, so the case never runs' }
    }
    if (Object.keys(entry.program.files).length) {
        return { reference: null, referenceSkipped: "the Core's GNU mode assembles only the Entry, so a program with NASM Files has no reference" }
    }
    const prepared = prepareForGnuAs(response.asm.map((line) => line.text))
    const entryPath = `${manifest.compilerExplorer.sourcePaths[entry.program.language]}.s`
    const { reference, blink } = await builder.build(prepared, entryPath, entry.name, expected.kind === 'exit')
    return { reference, blink }
}

/** The outcome a case's GNU as reference must reach: the case's own, or for a translation error the program's `referenceOutcome`. */
function referenceOutcome(entry) {
    if (entry.outcome.kind !== 'translation-error') return entry.outcome
    return entry.program.referenceOutcome ?? null
}

/**
 * GCC's output as GNU as reads it in the reference build. Debug material goes, since GNU as writes
 * its own line table for the prepared file (`--gdwarf-4`): `.file`, `.loc`, `.cfi_*`, `.ident` and
 * the contents of `.debug_*` sections, apart from symbol directives that happen to sit inside one
 * (GCC declares libcalls such as `__divti3` at the end of the file). Merge flags are cleared, so
 * `ld` keeps every literal's own bytes and label. `inputLines[i]` is the input line prepared line
 * `i` came from, null for the start.
 */
function prepareForGnuAs(input) {
    const lines = [...START]
    const inputLines = START.map(() => null)
    const sections = sectionTracker()
    input.forEach((text, index) => {
        const switched = sections.update(text)
        if (switched ? isDebugSection(switched.name) : isDebugSection(sections.current)) {
            if (!switched && /^\s*\.(globl|global|weak|hidden|protected|internal)\s/.test(text)) {
                lines.push(text)
                inputLines.push(index)
            }
            return
        }
        if (/^\s*\.(file|loc|ident)\b/.test(text) || /^\s*\.cfi_\w+/.test(text)) return
        lines.push(clearMergeFlags(text))
        inputLines.push(index)
    })
    return { lines, inputLines }
}

function isDebugSection(name) {
    return /^\.z?debug_/.test(name ?? '')
}

/** Follows the current section through `.section`, `.text`, `.data`, `.bss`, `.pushsection`, `.popsection` and `.previous`. */
function sectionTracker() {
    let current = '.text'
    let previous = '.text'
    const stack = []
    const enter = (name) => {
        previous = current
        current = name
        return { name }
    }
    return {
        get current() {
            return current
        },
        update(text) {
            const named = /^\s*\.(section|pushsection)\s+("[^"]*"|[^\s,]+)/.exec(text)
            if (named) {
                if (named[1] === 'pushsection') stack.push(current)
                return enter(named[2].replace(/^"|"$/g, ''))
            }
            const simple = /^\s*\.(text|data|bss)\b/.exec(text)
            if (simple) return enter(`.${simple[1]}`)
            if (/^\s*\.popsection\b/.test(text)) return enter(stack.pop() ?? '.text')
            if (/^\s*\.previous\b/.test(text)) return enter(previous)
            return null
        },
    }
}

/** `.section .rodata.str1.1,"aMS",@progbits,1` becomes `.section .rodata.str1.1,"a",@progbits`. */
function clearMergeFlags(text) {
    const directive = /^(\s*\.section\s+)(.*)$/.exec(text)
    if (!directive) return text
    const parts = splitArguments(directive[2])
    const flags = parts[1]?.trim()
    if (!flags || !/^"[^"]*"$/.test(flags) || !/[MS]/.test(flags)) return text
    const rest = parts.slice(2)
    if (flags.includes('M') && rest.length >= 2) rest.splice(1, 1)
    return directive[1] + [parts[0], flags.replace(/[MS]/g, ''), ...rest].join(',')
}

/** Splits at commas outside quotes, brackets and parentheses. */
function splitArguments(text) {
    const parts = []
    let depth = 0
    let quoted = false
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (quoted) {
            if (character === '\\') index += 1
            else if (character === '"') quoted = false
        } else if (character === '"') quoted = true
        else if (character === '[' || character === '(') depth += 1
        else if (character === ']' || character === ')') depth -= 1
        else if (character === ',' && depth === 0) {
            parts.push(text.slice(start, index))
            start = index + 1
        }
    }
    parts.push(text.slice(start))
    return parts
}

/** One Core in the reference mode, building one program at a time. */
function createReferenceBuilder() {
    let emulator = null
    let queue = Promise.resolve()
    const create = async () => {
        emulator ??= await core.createX86Emulator({ mode: referenceMode, callbacks: { stdout: () => {}, stderr: () => {} } })
        return emulator
    }
    return {
        serialized(task) {
            const run = queue.then(task)
            queue = run.catch(() => {})
            return run
        },
        async build(prepared, entryPath, label, runnable) {
            const instance = await create()
            const text = `${prepared.lines.join('\n')}\n`
            let result
            try {
                result = await instance.compileProject({ entry: entryPath, files: { [entryPath]: text } })
            } catch (error) {
                emulator?.dispose()
                emulator = null
                throw new Error(`${label}: the reference build threw: ${error.message}`, { cause: error })
            }
            const diagnostics = (result.diagnostics ?? []).map((diagnostic) => ({
                severity: diagnostic.severity,
                line: diagnostic.line,
                inputLine: prepared.inputLines[diagnostic.line - 1] ?? null,
                message: diagnostic.error,
            }))
            const undefinedSymbols = [
                ...new Set(diagnostics.flatMap((diagnostic) => /undefined reference to `(.+)'$/.exec(diagnostic.message)?.[1] ?? [])),
            ]
            const base = { assembler: REFERENCE_ASSEMBLER, prepared, diagnostics }
            if (!result.ok) {
                const linking = undefinedSymbols.length > 0 || diagnostics.every((diagnostic) => !/^Error: /.test(diagnostic.message))
                return { reference: { status: linking ? 'link-failed' : 'assembly-failed', ...base, undefinedSymbols }, blink: null }
            }
            const elf = Uint8Array.from(instance.module.FS.readFile('/program'))
            const instructions = instance
                .getCompiledInstructions()
                .map((instruction) => [Number(instruction.address), prepared.inputLines[instruction.lineNumber] ?? null])
            const built = { status: 'built', ...base, elf: Buffer.from(elf).toString('base64'), instructions }
            if (!runnable) return { reference: built, blink: null }
            const native = runNatively(elf, label)
            let blink
            if (native.timedOut) {
                blink = { skipped: 'the native run did not finish, so Blink was not run' }
            } else {
                await instance.run(RUN_LIMIT)
                const stop = instance.stopReason
                blink = stop ? { kind: stop.kind, exitCode: stop.exitCode, details: stop.details } : { kind: null }
            }
            return { reference: { ...built, native }, blink }
        },
        dispose() {
            emulator?.dispose()
            emulator = null
        },
    }
}

function runNatively(elf, label) {
    const path = join(scratch, `${label}.elf`)
    writeFileSync(path, elf, { mode: 0o755 })
    const run = spawnSync(path, [], { timeout: NATIVE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
    rmSync(path, { force: true })
    if (run.error?.code === 'ETIMEDOUT') return { timedOut: true }
    if (run.error) return { error: run.error.message }
    return run.signal ? { signal: run.signal } : { status: run.status }
}

// ---------------------------------------------------------------------------
// The x87 matrix
// ---------------------------------------------------------------------------

/** GCC's `-masm=intel` layout as Compiler Explorer shows it: a tab after the mnemonic, expanded to the next 8-column stop. */
function statement(mnemonic, operands = '') {
    if (!operands) return `        ${mnemonic}`
    const column = 8 + mnemonic.length
    return `        ${mnemonic}${' '.repeat(8 - (column % 8))}${operands}`
}

/**
 * The form's `stack` (top first) loaded from .rodata with `fld`, the form applied, the stack
 * stored with `fstp`, and the destination register's value returned as cvtsd2si(value × 4) + 64.
 */
function x87Input(form) {
    const [mnemonic, ...operands] = form.instruction.split(' ')
    const constants = [...new Set([...form.stack, 4])]
    const label = (value) => `.LC${constants.indexOf(value)}`
    const index = form.destination === 'st(0)' ? 0 : Number(/\d+/.exec(form.destination)[0])
    const left = form.stack.length - (form.pops ? 1 : 0)
    const slot = (position) => `[rsp-${8 * (position + 1)}]`
    const words = (value) => {
        const view = new DataView(new ArrayBuffer(8))
        view.setFloat64(0, value, true)
        return [statement('.long', String(view.getUint32(0, true))), statement('.long', String(view.getUint32(4, true)))]
    }
    return [
        '        .intel_syntax noprefix',
        statement('.text'),
        statement('.globl', 'main'),
        statement('.type', 'main, @function'),
        'main:',
        ...[...form.stack].reverse().map((value) => statement('fld', `QWORD PTR ${label(value)}[rip]`)),
        statement(mnemonic, operands.join(' ')),
        ...Array.from({ length: left }, (_, position) => statement('fstp', `QWORD PTR ${slot(position)}`)),
        statement('movsd', `xmm0, QWORD PTR ${slot(form.pops ? index - 1 : index)}`),
        statement('mulsd', `xmm0, QWORD PTR ${label(4)}[rip]`),
        statement('cvtsd2si', 'eax, xmm0'),
        statement('add', 'eax, 64'),
        statement('ret'),
        statement('.size', 'main, .-main'),
        statement('.section', '.rodata'),
        ...constants.flatMap((value) => ['        .align 8', `${label(value)}:`, ...words(value)]),
        statement('.section', '.note.GNU-stack,"",@progbits'),
    ]
}

async function captureX87Matrix() {
    const names = new Set()
    for (const form of manifest.x87Matrix.forms) {
        names.add(form.name)
        const input = x87Input(form)
        const formLine = input.findIndex((line) => line.trim().replace(/\s+/g, ' ') === form.instruction)
        const prepared = prepareForGnuAs(input)
        const { reference, blink: blinkRun } = await builder.serialized(() => builder.build(prepared, 'x87.s', `x87-${form.name}`, true))
        if (reference.status === 'built') {
            const elf = Buffer.from(reference.elf, 'base64')
            const address = reference.instructions.find(([, line]) => line === formLine)?.[0]
            reference.encoding = address === undefined ? null : instructionBytes(elf, address)
        }
        write(join(X87, `${form.name}.json.gz`), {
            format: FORMAT,
            profile: manifest.profile,
            ...form,
            input,
            formLine,
            capturedAt,
            reference,
        })
        const blink = blinkRun?.exitCode
        const native = reference.native?.status
        const agrees = blink === form.intended && native === form.intended
        summary.push({
            line: `${`x87 ${form.name}`.padEnd(28)} intended ${String(form.intended).padStart(3)}  GNU as in Blink ${String(blink).padStart(3)}  native ${String(native ?? reference.native?.signal ?? reference.native?.error ?? 'timed out').padStart(3)}  ${reference.encoding ?? ''} (Intel ${form.intelOpcode})${agrees ? '' : '  DIFFERS'}`,
            finding: agrees ? null : `x87 ${form.name}: intended ${form.intended}, GNU as reference ${blink} in Blink, ${native} natively`,
        })
        console.log(summary.at(-1).line)
    }
    for (const file of readdirSync(X87)) {
        if (!names.has(file.replace(/\.json\.gz$/, ''))) rmSync(join(X87, file))
    }
}

/** The bytes the ELF's loadable segments place at `address`, up to the instruction's length as GNU as encoded it (an x87 register form is two bytes). */
function instructionBytes(elf, address) {
    const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength)
    const phoff = Number(view.getBigUint64(32, true))
    const phentsize = view.getUint16(54, true)
    for (let index = 0; index < view.getUint16(56, true); index += 1) {
        const header = phoff + index * phentsize
        if (view.getUint32(header, true) !== 1) continue
        const offset = Number(view.getBigUint64(header + 8, true))
        const vaddr = Number(view.getBigUint64(header + 16, true))
        const filesz = Number(view.getBigUint64(header + 32, true))
        if (address < vaddr || address + 2 > vaddr + filesz) continue
        const start = offset + address - vaddr
        return [...elf.subarray(start, start + 2)].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
    }
    return null
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const REGISTER_CLASSES = new Map([
    ...['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', ...range(8, 16).map((n) => `r${n}`)].map((name) => [name, 'r64']),
    ...['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', ...range(8, 16).map((n) => `r${n}d`)].map((name) => [name, 'r32']),
    ...['ax', 'bx', 'cx', 'dx', 'si', 'di', 'bp', 'sp', ...range(8, 16).map((n) => `r${n}w`)].map((name) => [name, 'r16']),
    ...['al', 'bl', 'cl', 'dl', 'sil', 'dil', 'bpl', 'spl', 'ah', 'bh', 'ch', 'dh', ...range(8, 16).map((n) => `r${n}b`)].map((name) => [name, 'r8']),
    ...range(0, 32).map((n) => [`xmm${n}`, 'xmm']),
    ...range(0, 32).map((n) => [`ymm${n}`, 'ymm']),
    ...range(0, 8).map((n) => [`mm${n}`, 'mm']),
    ['rip', 'rip'],
    ['st', 'st'],
    ...['cs', 'ds', 'es', 'fs', 'gs', 'ss'].map((name) => [name, name]),
])
const INSTRUCTION = /^((?:(?:rep|repe|repz|repne|repnz|lock|notrack|data16|addr32|rex|rex64)\s+)*)([a-z][a-z0-9]*)(?:\s+(.*))?$/i
const OPERAND_TOKEN = /@[A-Za-z_]\w*|st\(\d+\)|"(?:[^"\\]|\\.)*"|0[xX][0-9a-fA-F]+|\d+[bf](?![\w.$])|\d+|[A-Za-z_.$][\w.$]*(?:@[A-Za-z_]\w*)?/g
const KEYWORDS = new Set(['BYTE', 'WORD', 'DWORD', 'QWORD', 'TBYTE', 'XMMWORD', 'YMMWORD', 'ZMMWORD', 'OWORD', 'FWORD', 'MMWORD', 'PTR', 'OFFSET', 'FLAT'])

function range(from, to) {
    return Array.from({ length: to - from }, (_, index) => from + index)
}

/**
 * Every directive, section, mnemonic, operand shape, instruction form, label and comment in the
 * captured output outside debug sections, with how often each appears and in which cases. Raw on
 * purpose: which of them the translator handles, drops or rejects is for its tests to say.
 */
function writeInventory() {
    const tables = {
        directives: new Map(),
        directiveForms: new Map(),
        sections: new Map(),
        mnemonics: new Map(),
        operandShapes: new Map(),
        instructionForms: new Map(),
        labels: new Map(),
        comments: new Map(),
        unrecognized: new Map(),
        debugSectionDirectives: new Map(),
    }
    const count = (table, key, caseName) => {
        const entry = tables[table].get(key) ?? { count: 0, cases: new Map() }
        entry.count += 1
        const [, program, level] = /^(.*)-O(.)$/.exec(caseName)
        const levels = entry.cases.get(program) ?? new Set()
        levels.add(level)
        entry.cases.set(program, levels)
        tables[table].set(key, entry)
    }
    const caseNames = []
    for (const file of readdirSync(CASES).sort()) {
        const stored = JSON.parse(gunzipSync(readFileSync(join(CASES, file))).toString('utf8'))
        caseNames.push(stored.case)
        const sections = sectionTracker()
        for (const { text } of stored.response.asm) {
            const switched = sections.update(text)
            const trimmed = text.trim()
            if (!trimmed) continue
            if (switched) {
                count('sections', trimmed.replace(/\s+/g, ' '), stored.case)
                count('directives', trimmed.split(/\s+/)[0], stored.case)
                continue
            }
            if (isDebugSection(sections.current)) {
                if (/^\.[\w.]+(\s|$)/.test(trimmed) && !trimmed.endsWith(':')) count('debugSectionDirectives', trimmed.split(/\s+/)[0], stored.case)
                continue
            }
            inventoryStatement(trimmed, stored.case, count)
        }
    }
    const entries = (map) =>
        [...map.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, { count: total, cases }]) => [
                key,
                {
                    count: total,
                    cases: Object.fromEntries([...cases.entries()].sort().map(([program, levels]) => [program, [...levels].sort().join(' ')])),
                },
            ])
    const header = {
        profile: manifest.profile,
        description:
            "Everything in the captured output outside debug sections, as written: directive names, directives with their arguments' shapes, section directives, mnemonics with their prefixes, operand shapes, instruction forms, label shapes and comments. Each entry counts its lines and lists the cases containing it, as each program's optimization levels. Shapes replace numbers with N, numeric label references with Nf or Nb, symbols with sym (.L symbols with .Lsym), strings with \"…\" and registers with their class (r64, r32, r16, r8, xmm, mm, st, st(i) as written, rip, segment registers by name); a token written against `[` or after `FLAT:` is a symbol whatever its spelling, and so is every name in a directive. GCC's spacing is kept. `debugSectionDirectives` counts the directives inside debug sections. Nothing here is classified.",
        cases: caseNames.length,
    }
    // One entry per line: diffable, and far smaller than one line per level.
    const names = Object.keys(tables)
    const lines = ['{', ...Object.entries(header).map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)]
    names.forEach((name, tableIndex) => {
        const rows = entries(tables[name])
        lines.push(`  ${JSON.stringify(name)}: {`)
        rows.forEach(([key, value], index) => lines.push(`    ${JSON.stringify(key)}: ${JSON.stringify(value)}${index < rows.length - 1 ? ',' : ''}`))
        lines.push(`  }${tableIndex < names.length - 1 ? ',' : ''}`)
    })
    lines.push('}')
    writeFileSync(join(FIXTURES, 'inventory.json'), `${lines.join('\n')}\n`)
}

function inventoryStatement(trimmed, caseName, count) {
    if (trimmed.startsWith('#')) {
        count('comments', trimmed.replace(/"[^"]*"/g, '"…"').replace(/\b\d+\b/g, 'N'), caseName)
        return
    }
    const label = /^("[^"]+"|[A-Za-z_.$][\w.$@]*|\d+):(.*)$/.exec(trimmed)
    if (label) {
        count('labels', labelShape(label[1]), caseName)
        if (label[2].trim()) inventoryStatement(label[2].trim(), caseName, count)
        return
    }
    if (trimmed.startsWith('.')) {
        const [name] = trimmed.split(/\s+/, 1)
        const rest = trimmed.slice(name.length).trim()
        count('directives', name, caseName)
        count('directiveForms', rest ? `${name} ${directiveShape(name, rest)}` : name, caseName)
        return
    }
    const instruction = INSTRUCTION.exec(trimmed)
    if (!instruction) {
        count('unrecognized', trimmed, caseName)
        return
    }
    const mnemonic = `${instruction[1]}${instruction[2]}`.replace(/\s+/g, ' ').toLowerCase()
    const operands = instruction[3] ? splitArguments(instruction[3]).map((operand) => operandShape(operand.trim())) : []
    count('mnemonics', mnemonic, caseName)
    for (const shape of operands) count('operandShapes', shape, caseName)
    count('instructionForms', operands.length ? `${mnemonic} ${operands.join(', ')}` : mnemonic, caseName)
}

function labelShape(name) {
    if (name.startsWith('"')) return '"…"'
    if (/^\d+$/.test(name)) return '<numeric>'
    if (name.startsWith('.L')) return name.replace(/\d+/g, '<N>')
    return name.replace(/^[A-Za-z_$][\w$]*/, '<name>').replace(/\d+/g, '<N>')
}

/**
 * Replaces each token of an operand with its kind and keeps GCC's own spacing. A token written
 * against `[` (a displacement) or after `FLAT:` is a symbol even when it is spelled like a
 * register; outside instructions every name is a symbol.
 */
function operandShape(operand, { registers = true } = {}) {
    return operand.replace(OPERAND_TOKEN, (token, offset) => {
        if (token.startsWith('@') || /^st\(\d+\)$/.test(token)) return token
        if (token.startsWith('"')) return '"…"'
        if (/^(0[xX][0-9a-fA-F]+|\d+)$/.test(token)) return 'N'
        if (/^\d+[bf]$/.test(token)) return `N${token.at(-1)}`
        const [name, relocation] = token.split('@')
        const suffix = relocation ? `@${relocation}` : ''
        const symbolic = operand[offset + token.length] === '[' || /FLAT:\s*$/.test(operand.slice(0, offset))
        if (!symbolic && KEYWORDS.has(name)) return token
        if (!symbolic && registers && REGISTER_CLASSES.has(name.toLowerCase())) return REGISTER_CLASSES.get(name.toLowerCase()) + suffix
        if (name === '.') return token
        return (name.startsWith('.L') ? '.Lsym' : 'sym') + suffix
    })
}

function directiveShape(name, rest) {
    if (name === '.intel_syntax' || name === '.att_syntax') return rest
    if (name === '.loc') return rest.replace(/\b\d+\b/g, 'N').replace(/\.L[\w.$]*/g, '.Lsym')
    return operandShape(rest, { registers: false })
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function write(path, value) {
    writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }))
}

function writeCase(name, value) {
    write(join(CASES, `${name}.json.gz`), value)
}

function readCase(name) {
    const path = join(CASES, `${name}.json.gz`)
    return existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) : null
}

function removeStaleCases() {
    const names = new Set(cases.map((entry) => `${entry.name}.json.gz`))
    for (const file of readdirSync(CASES)) {
        if (!names.has(file)) {
            rmSync(join(CASES, file))
            console.log(`removed ${file}, which is no longer in the manifest`)
        }
    }
}

/** The SHA-256 of a file's contents. */
function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * What produced the fixtures besides the manifest: the submodule's revision with every change not
 * committed in it, untracked files included, apart from the fixtures this script writes; and the
 * SHA-256 of this script, of the built Core it imported, and of what that Core loads to build and
 * run the references: Blink's glue code and the GNU as and GNU ld binaries.
 */
function captureProvenance(gnu) {
    const git = (...args) => execFileSync('git', args, { cwd: PACKAGE, encoding: 'utf8' })
    const fixtures = `${git('rev-parse', '--show-prefix').trim()}${relative(PACKAGE, FIXTURES)}/`
    // `-z` keeps every path as written: each entry is a status pair and a path, a rename adding the
    // path it came from as an entry of its own.
    const fields = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean)
    const changes = []
    for (let index = 0; index < fields.length; index += 1) {
        const status = fields[index].slice(0, 2)
        const path = fields[index].slice(3)
        if (/[RC]/.test(status)) index += 1
        if (!path.startsWith(fixtures)) changes.push(`${status} ${path}`)
    }
    const files = [
        fileURLToPath(import.meta.url),
        DIST,
        join(PACKAGE, 'dist/wasm/blinkenlib.js'),
        fileURLToPath(gnu.binaries.assembler.file),
        fileURLToPath(gnu.binaries.linker.file),
    ]
    return {
        submodule: { path: 'emulators/x86', revision: git('rev-parse', 'HEAD').trim(), dirty: changes.length > 0, changes },
        sha256: Object.fromEntries(files.map((path) => [relative(PACKAGE, path), sha256(path)])),
    }
}

function writeCaptureEnvironment() {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'))
    const { NASM_trunk: nasm, GNU_trunk: gnu } = core.assemblers
    const idents = new Set()
    const files = {}
    for (const directory of [FIXTURES, CASES, X87]) {
        for (const file of readdirSync(directory).sort()) {
            const path = join(directory, file)
            if (file === 'capture.json' || !statSync(path).isFile()) continue
            const bytes = readFileSync(path)
            const entry = { bytes: bytes.length }
            if (file.endsWith('.gz')) {
                const value = gunzipSync(bytes)
                entry.uncompressedBytes = value.length
                if (directory === CASES) {
                    for (const { text } of JSON.parse(value.toString('utf8')).response.asm) {
                        const ident = /^\s*\.ident\s+"(.*)"/.exec(text)?.[1]
                        if (ident) idents.add(ident)
                    }
                }
            }
            files[relative(FIXTURES, path)] = entry
        }
    }
    const { submodule, sha256: hashes } = captureProvenance(gnu)
    const environment = {
        profile: manifest.profile,
        capturedAt,
        package: { name: packageJson.name, version: packageJson.version },
        submodule,
        sha256: hashes,
        assemblers: {
            nasm: { version: /NASM (\d+\.\d+)/.exec(nasm.description)?.[1] ?? null, mode: nasm.id, description: nasm.description },
            gnu: {
                as: /version (\d+\.\d+\.\d+)/.exec(gnu.description)?.[1] ?? null,
                ld: /ld v?(\d+\.\d+\.\d+)/.exec(nasm.description)?.[1] ?? null,
                mode: gnu.id,
                description: gnu.description,
            },
            referenceAssembler: REFERENCE_ASSEMBLER,
            referenceLinker: gnu.binaries.linker.link(['/program.o']),
        },
        compilerExplorer: { ...manifest.compilerExplorer, idents: [...idents].sort() },
        host: { node: process.version, platform: process.platform, arch: process.arch, nativeRuns: true },
        cases: Object.keys(files).filter((file) => file.startsWith('cases/')).length,
        x87Forms: Object.keys(files).filter((file) => file.startsWith('x87/')).length,
        totalBytes: Object.values(files).reduce((total, file) => total + file.bytes, 0),
        files,
    }
    writeFileSync(join(FIXTURES, 'capture.json'), `${JSON.stringify(environment, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeOutcome(outcome) {
    if (outcome.kind === 'exit') return `exit ${outcome.value}`
    if (outcome.kind === 'link-failure') return `link-failure ${outcome.symbols.join(', ')}`
    return `${outcome.kind} ${outcome.code}`
}

function summarize(entry, response, { reference, referenceSkipped, blink: blinkRun }) {
    const outcome = referenceOutcome(entry) ?? entry.outcome
    const expected =
        outcome === entry.outcome ? describeOutcome(outcome) : `${describeOutcome(entry.outcome)}, reference ${describeOutcome(outcome)}`
    let observed = referenceSkipped ? `no reference: ${referenceSkipped}` : reference.status
    let finding = null
    if (response.code !== 0) finding = `${entry.name}: Compiler Explorer reported code ${response.code}`
    else if (reference && outcome.kind === 'exit') {
        if (reference.status !== 'built') {
            observed = `${reference.status}: ${reference.diagnostics.find((d) => d.severity === 'error')?.message ?? ''}`
            finding = `${entry.name}: the reference ${reference.status.replace('-', ' ')} (${observed})`
        } else {
            const blink = blinkRun.exitCode
            const native = reference.native.status ?? reference.native.signal ?? reference.native.error ?? 'timed out'
            observed = `Blink ${blinkRun.kind ?? blinkRun.skipped} ${blink}, native ${native}`
            const nativeAgrees = native === (outcome.value & 255)
            if (blinkRun.kind !== 'exit' || blink !== outcome.value || !nativeAgrees)
                finding = `${entry.name}: intended ${outcome.value}, reference ${observed}`
        }
    } else if (reference && outcome.kind === 'link-failure') {
        observed = reference.status === 'link-failed' ? `link-failed ${reference.undefinedSymbols.join(', ')}` : reference.status
        const same =
            reference.status === 'link-failed' &&
            reference.undefinedSymbols.length === outcome.symbols.length &&
            outcome.symbols.every((symbol) => reference.undefinedSymbols.includes(symbol))
        if (!same) finding = `${entry.name}: intended link failure naming ${outcome.symbols.join(', ')}, reference ${observed}`
    }
    return { line: `${entry.name.padEnd(22)} ${expected.padEnd(48)} ${observed}${finding ? '  <-- finding' : ''}`, finding }
}

function report() {
    const findings = summary.flatMap((entry) => (entry.finding ? [entry.finding] : []))
    console.log(`\n${selected.length} cases captured${options.skipX87 ? '' : ` and ${manifest.x87Matrix.forms.length} x87 forms built`}.`)
    if (findings.length) console.log(`Findings:\n${findings.map((finding) => `  - ${finding}`).join('\n')}`)
    else console.log('Every reference agrees with its intended outcome.')
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function parseArguments(argv) {
    const parsed = { only: null, offline: false, concurrency: 2, skipX87: false }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === '--only') parsed.only = new RegExp(argv[++index])
        else if (argument === '--offline') parsed.offline = true
        else if (argument === '--concurrency') parsed.concurrency = Math.max(1, Number(argv[++index]) || 1)
        else if (argument === '--skip-x87') parsed.skipX87 = true
        else {
            console.error(`Unknown argument ${argument}`)
            process.exit(2)
        }
    }
    return parsed
}

async function pool(items, size, task) {
    let next = 0
    const failures = []
    await Promise.all(
        Array.from({ length: Math.min(size, items.length) }, async () => {
            while (next < items.length) {
                const item = items[next++]
                try {
                    await task(item)
                } catch (error) {
                    failures.push(error)
                    console.error(error.message)
                }
            }
        }),
    )
    if (failures.length) throw new Error(`${failures.length} case(s) failed; see above`)
}

function sleep(ms) {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// ---------------------------------------------------------------------------
// Main, last, so every declaration above is initialized before it runs
// ---------------------------------------------------------------------------

try {
    let lastRequest = 0
    await pool(selected, options.concurrency, async (entry) => {
        const request = compilerRequest(entry.program, entry.level)
        let response
        let caseCapturedAt = capturedAt
        if (options.offline) {
            const stored = readCase(entry.name)
            if (!stored) throw new Error(`${entry.name}: no stored case to reuse offline`)
            assertSameRequest(entry.name, stored, request)
            response = stored.response
            caseCapturedAt = stored.capturedAt
        } else {
            const wait = lastRequest + REQUEST_SPACING_MS - Date.now()
            lastRequest = Math.max(Date.now(), lastRequest + REQUEST_SPACING_MS)
            if (wait > 0) await sleep(wait)
            response = await compile(request, entry.name)
        }
        const reference = await builder.serialized(() => referenceFor(entry, response))
        const { blink, ...stored } = reference
        writeCase(entry.name, {
            format: FORMAT,
            profile: manifest.profile,
            case: entry.name,
            program: entry.program.name,
            language: entry.program.language,
            optimization: entry.level,
            exercises: entry.program.exercises,
            compiler: request.compiler,
            userArguments: request.userArguments,
            sourcePath: request.sourcePath,
            source: entry.program.source,
            headers: entry.program.headers,
            files: entry.program.files,
            outcome: entry.outcome,
            ...(entry.program.referenceOutcome ? { referenceOutcome: entry.program.referenceOutcome } : {}),
            ...(entry.program.note ? { note: entry.program.note } : {}),
            capturedAt: caseCapturedAt,
            response,
            ...stored,
        })
        summary.push(summarize(entry, response, reference))
        console.log(summary.at(-1).line)
    })

    if (!options.skipX87) await captureX87Matrix()
    if (!options.only) removeStaleCases()
    writeInventory()
    writeCaptureEnvironment()
    report()
} finally {
    builder.dispose()
    rmSync(scratch, { recursive: true, force: true })
}
process.exit(0)
