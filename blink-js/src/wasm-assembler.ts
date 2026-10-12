import createNasm from './wasm/nasm.mjs'
import { loadDisassembler, type Disassembler } from './disassembler'
import { selectX86Source, stageX86Project } from './project'
import { readResourceBytes } from './resources'
import { parseDependencyList, x86TranslationUnitCandidates } from './translation-units'
import type { X86Project } from './types'
import type { NasmModule } from './wasm/nasm.d.mts'

/**
 * An assembler that runs as its own WebAssembly module rather than as an x86-64
 * ELF interpreted by blink. Blink costs roughly 1.2s of startup plus 14ms per
 * line of source for NASM; the same work in its own module takes single-digit
 * milliseconds, and produces byte-identical output.
 *
 * The object files come back as bytes for the caller to stage wherever the
 * linker expects them, so the linker can keep running inside blink unchanged.
 */
export interface WasmAssembler {
    assemble(project: X86Project): Promise<WasmAssemblyResult>
}

/** One translation unit's object, and the Project File it was assembled from. */
export type WasmAssemblyUnit = {
    path: string
    object: Uint8Array
}

export type WasmAssemblyResult = {
    /** The assembler's exit status: 0 when every translation unit assembled. */
    status: number
    /** What it wrote to stdout, verbatim. */
    stdout: string
    /** What it wrote to stderr, verbatim - the diagnostics a parser reads. */
    stderr: string
    /**
     * The objects to link: the Entry's, then the library's units and then the
     * Project's other units, each group by path, which is the order the archive
     * holds them in. Empty when any translation unit failed: a partial link would
     * report missing symbols that are only missing because the File defining them
     * is the one that did not assemble.
     */
    units: WasmAssemblyUnit[]
    /** The Entry's object, or null when the assembly failed. */
    object: Uint8Array | null
}

const OBJECT_PATH = '/program.o'
const DEPENDENCIES_PATH = '/unit.d'

/**
 * `-g -F dwarf` is what makes the source map possible: the debugger reads
 * `.debug_line` out of the linked executable to map an address back to the line
 * it was written on. The working directory `selectX86Source` selects is what
 * lets NASM resolve `%include` itself.
 */
const NASM_ARGS = ['-g', '-F', 'dwarf', '-felf64']

const NASM_WASM = new URL('./wasm/nasm.wasm', import.meta.url)
let compiledNasm: Promise<WebAssembly.Module | null> | null = null

/**
 * `nasm.wasm` compiled once for every instance. Left to itself, Emscripten compiles the 1.2MB
 * module again for each instance it creates, which for a Project with a Runtime library, hundreds
 * of units, cost more than assembling them. Null when the module cannot be loaded from here, and
 * each instance then loads its own as Emscripten would.
 */
function compiledNasmModule(): Promise<WebAssembly.Module | null> {
    compiledNasm ??= readResourceBytes(NASM_WASM)
        .then((bytes) => WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>))
        .catch(() => null)
    return compiledNasm
}

async function createNasmModule(): Promise<{
    module: NasmModule
    stdout: () => string
    stderr: () => string
}> {
    let stdout = ''
    let stderr = ''
    const compiled = await compiledNasmModule()
    // Emscripten waits on `receiveInstance` forever, so a failed instantiation is raced in instead.
    let failInstantiation: (error: unknown) => void = () => undefined
    const instantiationFailed = new Promise<never>((_, reject) => {
        failInstantiation = reject
    })
    const module = await Promise.race([
        createNasm({
            noInitialRun: true,
            print: (line) => {
                stdout += `${line}\n`
            },
            printErr: (line) => {
                stderr += `${line}\n`
            },
            ...(compiled
                ? {
                      instantiateWasm: (imports, receiveInstance) => {
                          WebAssembly.instantiate(compiled, imports).then(
                              (instance) => receiveInstance(instance, compiled),
                              failInstantiation
                          )
                      }
                  }
                : {})
        }),
        instantiationFailed
    ])
    return { module, stdout: () => stdout, stderr: () => stderr }
}

type LibraryObject = { object: Uint8Array; stdout: string; stderr: string; size: number }

/**
 * Library and start units already assembled, by path and source. A Runtime library is the same
 * hundreds of units on every build and every check, and assembling them was most of the work. A
 * unit is kept only when NASM read nothing but the unit itself, so its object cannot depend on a
 * File of the Project, and only when it does not ask for the date or time, the one other input an
 * assembly has. A Map iterates in insertion order, which makes it least recently used first.
 */
const libraryObjects = new Map<string, LibraryObject>()
const LIBRARY_OBJECT_BUDGET = 64 * 1024 * 1024
let libraryObjectBytes = 0

/** NASM's `__?DATE?__`, `__?TIME_NUM?__`, `__?UTC_DATE?__`, `__?POSIX_TIME?__`, and their old spellings. */
const CLOCK_MACRO = /__\??(?:UTC_)?(?:DATE|TIME)|__\??POSIX_TIME/

function libraryObjectKey(path: string, source: string): string {
    return `${path}\0${source}`
}

function takeLibraryObject(key: string): LibraryObject | undefined {
    const cached = libraryObjects.get(key)
    if (!cached) return undefined
    libraryObjects.delete(key)
    libraryObjects.set(key, cached)
    return cached
}

function keepLibraryObject(key: string, unit: Omit<LibraryObject, 'size'>): void {
    const size = unit.object.byteLength + key.length + unit.stdout.length + unit.stderr.length
    if (size > LIBRARY_OBJECT_BUDGET) return
    libraryObjects.set(key, { ...unit, size })
    libraryObjectBytes += size
    for (const [oldest, cached] of libraryObjects) {
        if (libraryObjectBytes <= LIBRARY_OBJECT_BUDGET) break
        libraryObjects.delete(oldest)
        libraryObjectBytes -= cached.size
    }
}

/**
 * Emscripten's Node path sets `process.exitCode` from the status the module
 * exits with, so an assembly that failed would leave the host process exiting
 * non-zero for a reason of its own. NASM's status belongs to the caller of this
 * function, never to the host.
 */
function callNasm(module: NasmModule, args: string[]): number {
    const host = (globalThis as { process?: { exitCode?: number | string | undefined } }).process
    const hostExitCode = host?.exitCode
    const status = module.callMain(args)
    if (host) host.exitCode = hostExitCode
    return status
}

/**
 * Which Files the Project's candidate translation units `%include`, so that a fragment is
 * assembled as part of whatever includes it and never a second time on its own. Every candidate
 * is scanned before any of them is treated as a unit, because a fragment can be included by a
 * File that sorts after it.
 */
async function scanIncludedFiles(
    project: X86Project,
    candidates: readonly string[]
): Promise<Set<string>> {
    const included = new Set<string>()
    if (candidates.length < 2) return included

    for (const path of candidates) {
        const { module, stdout } = await createNasmModule()
        stageX86Project(module.FS, project)
        const source = selectX86Source(module.FS, project, path)
        // `-M` preprocesses and writes the dependency list without assembling, so a fragment that
        // cannot stand on its own costs nothing here; its diagnostics are deliberately discarded.
        callNasm(module, ['-M', ...NASM_ARGS, source, '-o', OBJECT_PATH])
        for (const dependency of parseDependencyList(stdout(), project)) {
            if (dependency !== path) included.add(dependency)
        }
    }
    return included
}

/**
 * The Project as a library unit's assembly sees it: its Files, and the unit among them at its
 * library path, so that the unit is staged and selected exactly as a File would be and its DWARF
 * names it by that path. Only its own assembly stages it, which is what keeps the Project's Files
 * from `%include`ing it.
 */
function withLibraryUnit(project: X86Project, path: string): X86Project {
    return {
        entry: project.entry,
        files: {
            ...project.files,
            [path]: (project.startUnits?.[path] ?? project.library?.[path])!
        }
    }
}

export const nasmWasmAssembler: WasmAssembler = {
    async assemble(project: X86Project): Promise<WasmAssemblyResult> {
        const candidates = x86TranslationUnitCandidates(project)
        const included = await scanIncludedFiles(project, candidates)
        const [entry, ...others] = candidates.filter(
            (path) => path === project.entry || !included.has(path)
        )
        const library = new Set(Object.keys({ ...project.startUnits, ...project.library }))
        const units = [entry!, ...[...library].sort(), ...others]

        let stdout = ''
        let stderr = ''
        let status = 0
        const assembled: WasmAssemblyUnit[] = []

        for (const path of units) {
            const isLibrary = library.has(path)
            const unitSource = isLibrary
                ? (project.startUnits?.[path] ?? project.library?.[path])
                : undefined
            // Only a unit written as text is kept: a library given as bytes is assembled every time.
            const key =
                typeof unitSource === 'string' ? libraryObjectKey(path, unitSource) : undefined
            const cached = key === undefined ? undefined : takeLibraryObject(key)
            if (cached) {
                stdout += cached.stdout
                stderr += cached.stderr
                assembled.push({ path, object: cached.object.slice() })
                continue
            }

            const { module, stdout: readStdout, stderr: readStderr } = await createNasmModule()
            const staged = isLibrary ? withLibraryUnit(project, path) : project
            stageX86Project(module.FS, staged)
            const source = selectX86Source(module.FS, staged, path)
            const dependencies = key === undefined ? [] : ['-MD', DEPENDENCIES_PATH]
            const unitStatus = callNasm(module, [
                ...NASM_ARGS,
                ...dependencies,
                source,
                '-o',
                OBJECT_PATH
            ])
            const unitStdout = readStdout()
            const unitStderr = readStderr()
            stdout += unitStdout
            stderr += unitStderr

            // NASM writes no object at all when it fails, and an instance is never reused, so an
            // existing file can only be the one this run produced.
            const wroteObject = unitStatus === 0 && module.FS.analyzePath(OBJECT_PATH).exists
            if (!wroteObject) {
                if (status === 0) status = unitStatus === 0 ? 1 : unitStatus
                continue
            }
            const object = module.FS.readFile(OBJECT_PATH) as Uint8Array
            assembled.push({ path, object })
            if (
                key !== undefined &&
                !CLOCK_MACRO.test(unitSource as string) &&
                module.FS.analyzePath(DEPENDENCIES_PATH).exists
            ) {
                const read = parseDependencyList(
                    module.FS.readFile(DEPENDENCIES_PATH, { encoding: 'utf8' }) as string,
                    staged
                )
                if (read.length === 1)
                    keepLibraryObject(key, {
                        object: object.slice(),
                        stdout: unitStdout,
                        stderr: unitStderr
                    })
            }
        }

        const ok = status === 0 && assembled.length === units.length
        return {
            status,
            stdout,
            stderr,
            units: ok ? assembled : [],
            object: ok ? (assembled[0]?.object ?? null) : null
        }
    }
}

/** What {@link assembleInstruction} answers: the encoding, or why the text has none. */
export type AssembledInstruction = { bytes: Uint8Array } | { error: string }

/** A line of NASM and the run-time address its first byte will have. */
export type InstructionRequest = { text: string; address: bigint }

/**
 * Assemble one instruction at its run-time address, for a debugger Poke. The text is NASM as the
 * decoder prints it, with every address written as a number:
 *
 * - a direct branch names its absolute target (`je 0x401020`, `call 0x401000+0x10`); it is encoded
 *   relative to `address`, short whenever the target is in reach of one;
 * - `[rel 0x404010]`, `[rel 0x404010+0x8]` and `[rel 0x404010-0x8]` name the absolute address a
 *   RIP-relative operand reaches, with any size keyword and segment around them
 *   (`qword fs:[rel 0x404010]`, or `[fs:rel 0x404010]`); a name inside `[rel ...]` is an error,
 *   since labels are the caller's to resolve;
 * - such a target, and a displacement beside a 64-bit register, may be any expression of numbers
 *   (in NASM's notations), `$` (the instruction's address), `+ - * / ~` and parentheses
 *   (`jmp 0x401000+2*0x10`, `[rax+(0x10-0x8)]`); one written with anything else (`'ab'`,
 *   `1 << 4`) is an error, since only a value known here can be checked;
 * - `[0x404010]` is an absolute address (NASM's `default abs`);
 * - `notrack` is encoded as the `3e` prefix it stands for, and an ignored segment prefix the
 *   decoder prints (`nop word cs:[rax+rax*1]`) is encoded too.
 *
 * Nothing is silently encoded as something else: a value NASM would truncate is an error, not a
 * warning, and so is a branch or RIP-relative target out of reach of its displacement (the
 * encoding is decoded again and must reach the target the text named), a memory operand whose
 * size NASM 3.00 would guess (`add [rax], 1`), and the few forms NASM 3.00 encodes wrongly.
 * Errors read without NASM's file, line and severity. NASM's -Ox still chooses the shortest
 * encoding, which may not be the original's: `mov rax, 0x10` becomes `mov eax, 0x10`, the same
 * result in five bytes instead of seven, and the bytes never exceed 15.
 */
export async function assembleInstruction(
    text: string,
    address: bigint
): Promise<AssembledInstruction> {
    const [result] = await assembleInstructions([{ text, address }])
    return result!
}

/**
 * {@link assembleInstruction} for many lines at once, answered in order, through the same code:
 * each line is rewritten and checked exactly as it is alone, and one NASM instance assembles up
 * to 200 of them, each in a section of its own that starts at its address, where alone each
 * would cost an instance. The lines share NASM's names, so one that defines a label (decoder text
 * never does) makes it visible to the lines after it in its batch.
 */
export async function assembleInstructions(
    requests: readonly InstructionRequest[]
): Promise<AssembledInstruction[]> {
    const results: AssembledInstruction[] = new Array(requests.length)
    const prepared: PreparedInstruction[] = []
    requests.forEach(({ text, address }, index) => {
        const item = prepareInstruction(text, address, index)
        if ('error' in item) results[index] = item
        else prepared.push(item)
    })
    await assembleAll(prepared, results)
    const assembled = prepared.filter((item) => 'bytes' in results[item.index]!)
    const targeted = assembled.filter(
        (item) => item.branchTarget !== undefined || item.memoryTarget !== undefined
    )
    const unsized = assembled.filter((item) => item.line.includes('[') && !SIZED.test(item.line))
    if (!targeted.length && !unsized.length) return results
    const { disassemble } = await loadDisassembler()
    for (const item of targeted)
        results[item.index] = checkTargets(disassemble, item, bytesOf(results[item.index]!))
    await refuseGuessedSizes(disassemble, unsized, results)
    return results
}

async function assembleAll(
    items: readonly PreparedInstruction[],
    results: AssembledInstruction[]
): Promise<void> {
    for (let from = 0; from < items.length; from += INSTRUCTION_BATCH)
        await assembleBatch(items.slice(from, from + INSTRUCTION_BATCH), results)
}

const bytesOf = (result: AssembledInstruction) => ('bytes' in result ? result.bytes : undefined)!

const SIZES = ['byte', 'word', 'dword', 'qword', 'tword', 'oword', 'yword', 'zword']
/** A memory operand with a size keyword: `qword [rax]`, `dword fs:[rel 0x404010]`. */
const SIZED = new RegExp(String.raw`\b(${SIZES.join('|')})\s+(?:far\s+)?(?:[c-gs]s\s*:\s*)?\[`, 'i')

/**
 * NASM 3.00 does not refuse a memory operand whose size nothing gives, as NASM 2 did ("operation
 * size not specified"): it picks one (`add [rax], 1` assembles as `add word [rax], 1`, and
 * `idiv [rbp-8]` as a byte division). So when the encoding decodes with a size the text did not
 * give, the line is assembled again with each other size, and if any of those encodes something
 * else, the text was ambiguous and is refused. A size only one form has (`sete [rax]`,
 * `fnstcw [rax]`) or one that changes no byte (`clflush [rax]`) needs no keyword.
 */
async function refuseGuessedSizes(
    disassemble: Disassembler['disassemble'],
    items: readonly PreparedInstruction[],
    results: AssembledInstruction[]
): Promise<void> {
    const probes: (PreparedInstruction & { size: string })[] = []
    const guessed: { item: PreparedInstruction; size: string; from: number }[] = []
    for (const item of items) {
        const [decoded] = disassemble(bytesOf(results[item.index]!), item.address)
        const size = decoded && SIZED.exec(decoded.text)?.[1]?.toLowerCase()
        if (!size) continue
        const at = item.line.search(/(?:far\s+)?(?:[c-gs]s\s*:\s*)?\[/i)
        guessed.push({ item, size, from: probes.length })
        for (const other of SIZES)
            if (other !== size)
                probes.push({
                    ...item,
                    index: probes.length,
                    size: other,
                    line: `${item.line.slice(0, at)}${other} ${item.line.slice(at)}`
                })
    }
    if (!probes.length) return
    const answers: AssembledInstruction[] = new Array(probes.length)
    await assembleAll(probes, answers)
    for (const { item, size, from } of guessed) {
        const chosen = bytesOf(results[item.index]!)
        const others = probes.slice(from, from + SIZES.length - 1).filter((probe) => {
            const answer = answers[probe.index]!
            return 'bytes' in answer && !sameBytes(answer.bytes, chosen)
        })
        if (!others.length) continue
        const sizes = SIZES.filter((s) => s === size || others.some((probe) => probe.size === s))
        results[item.index] = {
            error: `The operation size is not specified: write ${sizes.slice(0, -1).join(', ')} or ${sizes.at(-1)} before the memory operand`
        }
    }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, k) => byte === b[k])

/** A request rewritten for NASM, and the absolute targets its encoding must reach. */
type PreparedInstruction = {
    index: number
    address: bigint
    /** The line NASM reads, in a section whose `$$` is `address`. */
    line: string
    branchTarget?: bigint
    memoryTarget?: bigint
}

/**
 * `-Werror` because a warning is how NASM reports a value it truncated (`add eax, 0x100000000`
 * assembles to `83 c0 00` with only a warning). Two warnings are exceptions, as they only say a
 * prefix is redundant while NASM still encodes it, which is what such text asks for: prefix-seg
 * (a cs, ds, es or ss override has no effect in 64-bit mode; the decoder prints one as
 * `nop word cs:[rax+rax*1]`) and prefix-lock-xchg (xchg with memory locks without one).
 */
const INSTRUCTION_ARGS = ['-Ox', '-fbin', '-Werror', '-w-prefix-seg', '-w-prefix-lock-xchg']
const INSTRUCTION_SOURCE = '/instructions.asm'
const INSTRUCTION_OUTPUT = '/instructions.bin'
/** How many lines one NASM instance assembles; each is its own section, which NASM looks up by name. */
const INSTRUCTION_BATCH = 200
/**
 * Each line is assembled into a 32-byte record: its encoding, zeros up to byte 29, the encoding's
 * length, and the line's position in the batch as a word, which is how the output is checked to
 * be laid out as expected.
 */
const RECORD_SIZE = 32
const RECORD_LENGTH_AT = 29
/** The longest encoding of one x86 instruction. */
const MAX_INSTRUCTION_LENGTH = 15
/** `bits 64` and `default abs` come before the first section. */
const HEADER_LINES = 2
/** The lines of one record: section, the text, padding, length, position. */
const RECORD_LINES = 5

const MAX_ADDRESS = 0xffffffffffffffffn
/** A number in any of NASM's notations, a `$` or `$$`, a name, or an operator {@link evaluate} knows. */
const TOKEN = /\s*(?:(\d[\w.$]*)|(\$\$?)(?![\w$#@~.?])|([a-z_.?][\w$#@~.?]*)|([-+*/~()]))/iy
/** A name in NASM: not preceded by anything a name or number continues with. */
const NAME = /(?<![\w$#@~.?])[a-z_.?][\w$#@~.?]*/gi
/** NASM's radix letters, after a leading 0 (`0x1f`) or at the end (`1fh`). */
const RADIX: Record<string, number> = { b: 2, y: 2, o: 8, q: 8, d: 10, t: 10, h: 16, x: 16 }
const DIGITS: Record<number, RegExp> = {
    2: /^[01]+$/,
    8: /^[0-7]+$/,
    10: /^\d+$/,
    16: /^[\da-f]+$/i
}
const SEGMENT = String.raw`(?:[c-gs]s\s*:\s*)`
const RIP_RELATIVE = new RegExp(String.raw`^(\s*${SEGMENT}?)rel\b\s*(${SEGMENT}?)(.*)$`, 'is')
const BRANCH =
    /^((?:(?:bnd|nobnd|notrack|[ao](?:16|32|64)|rep(?:n?[ez])?|[c-gs]s)\s+)*)(jmp|call|j[a-z]{1,4}|loop(?:n?[ez])?|xbegin)\b(\s*(?:(?:strict|short|near|word|dword|qword)\b\s*)*)(\S.*)$/i
const DIRECTIVE =
    /^\s*(?:[%[]|(?:bits|use16|use32|use64|default|section|segment|absolute|extern|global|common|static|required|cpu|float|org|align|alignb|sectalign|struc|endstruc|istruc|iend|incbin|warning|map|list|debug)\b)/i
const GPR64 = /^(?:r[abcd]x|r[sd]i|r[sb]p|rip|r(?:8|9|1[0-5]))$/i
const GPR32 = /^(?:e[abcd]x|e[sd]i|e[sb]p|eip|r(?:8|9|1[0-5])d)$/i
/**
 * Text NASM 3.00 assembles to the wrong bytes without a warning, refused instead: kunpckbw comes
 * out as kunpckwd and kunpckwd as an undefined encoding, bswap of a 16-bit register as xchg, and
 * smsw into a 16-bit register as the 32-bit form.
 */
const MISENCODED: [RegExp, string][] = [
    [/^kunpck(?:bw|wd)\b/i, 'NASM encodes kunpckbw and kunpckwd wrongly'],
    [
        /^bswap\s+(?:[abcd]x|[sd]i|[sb]p|r(?:8|9|1[0-5])w)\s*$/i,
        'bswap of a 16-bit register is undefined, and NASM encodes it as xchg'
    ],
    [
        /^smsw\s+(?:[abcd]x|[sd]i|[sb]p|r(?:8|9|1[0-5])w)\s*$/i,
        'NASM encodes smsw into a 16-bit register as its 32-bit form'
    ]
]
const GPR16 = /^(?:[abcd]x|[sd]i|[sb]p|r(?:8|9|1[0-5])w)$/i
const CMPXCHG = /^((?:(?:lock|xacquire|xrelease)\s+)*)(cmpxchg\s+.*,\s*([a-z0-9]+))\s*$/i
const VECTOR = /^[xyz]mm(?:\d|[12]\d|3[01])$/i

const hex = (value: bigint) => `0x${value.toString(16)}`

/**
 * A number as NASM reads one: `0x1f`, `1fh`, `0b101`, `101b`, `17q`, `0d17` or `17`, with any
 * `_` between digits; when it has a radix letter both before and after, the larger radix wins.
 */
function readNumber(token: string): bigint | undefined {
    const prefix = token.length > 2 && token[0] === '0' ? (RADIX[token[1]!.toLowerCase()] ?? 0) : 0
    const suffix = token.length > 1 ? (RADIX[token.at(-1)!.toLowerCase()] ?? 0) : 0
    const radix = prefix > suffix ? prefix : suffix > prefix ? suffix : 10
    let digits = prefix > suffix ? token.slice(2) : suffix > prefix ? token.slice(0, -1) : token
    digits = digits.replace(/_/g, '')
    if (!DIGITS[radix]!.test(digits)) return undefined
    return BigInt(radix === 10 ? digits : `0${{ 2: 'b', 8: 'o', 16: 'x' }[radix]}${digits}`)
}

/**
 * The value of an expression NASM computes as a constant, so that a target or displacement is
 * known before NASM encodes it: numbers, `$` and `$$` (both `here`, as each line is the first in
 * its section), `+ - * / ~` and parentheses, `/` dividing as NASM does, unsigned. Names have the
 * value `valueOf` gives them; the result is not wrapped to 64 bits. Otherwise the reason: a name
 * without a value, which NASM resolves or refuses itself; text NASM may read as a constant this
 * does not (`'ab'`, `1 << 40`); a number past 64 bits.
 */
function evaluate(
    expression: string,
    here: bigint,
    valueOf: (name: string) => bigint | undefined = () => undefined
): bigint | 'name' | 'invalid' | 'overflow' {
    const tokens: (bigint | string)[] = []
    let named = false
    let overflow = false
    for (let at = 0; !/^\s*$/.test(expression.slice(at)); at = TOKEN.lastIndex) {
        TOKEN.lastIndex = at
        const match = TOKEN.exec(expression)
        if (!match) return 'invalid'
        const [, number, dollar, name, operator] = match
        if (number !== undefined) {
            const value = readNumber(number)
            if (value === undefined) return 'invalid'
            overflow ||= value > MAX_ADDRESS
            tokens.push(value)
        } else if (dollar !== undefined) tokens.push(here)
        else if (name !== undefined) {
            const value = valueOf(name)
            named ||= value === undefined
            tokens.push(value ?? 0n)
        } else tokens.push(operator!)
    }
    if (named) return 'name'
    let k = 0
    const operand = (): bigint | undefined => {
        const token = tokens[k++]
        if (typeof token === 'bigint') return token
        if (token === '(') {
            const value = sum()
            return tokens[k++] === ')' ? value : undefined
        }
        if (token !== '-' && token !== '+' && token !== '~') return undefined
        const value = operand()
        if (value === undefined) return undefined
        return token === '-' ? -value : token === '~' ? ~value : value
    }
    const product = (): bigint | undefined => {
        let value = operand()
        while (value !== undefined && (tokens[k] === '*' || tokens[k] === '/')) {
            const times = tokens[k++] === '*'
            const right = operand()
            if (right === undefined || (!times && !BigInt.asUintN(64, right))) return undefined
            value = times ? value * right : BigInt.asUintN(64, value) / BigInt.asUintN(64, right)
        }
        return value
    }
    const sum = (): bigint | undefined => {
        let value = product()
        while (value !== undefined && (tokens[k] === '+' || tokens[k] === '-')) {
            const plus = tokens[k++] === '+'
            const right = product()
            value = right === undefined ? undefined : plus ? value + right : value - right
        }
        return value
    }
    const value = sum()
    if (value === undefined || k !== tokens.length) return 'invalid'
    return overflow ? 'overflow' : value
}

/**
 * The target as NASM must read it to encode a displacement: relative to the section, which starts
 * at the instruction. NASM can only encode `[rel 0x4018]` or `jmp 0x401020` relative to a number
 * by giving up (absolute addressing for the first, and a displacement it never range-checks for
 * the second); relative to `$$` it encodes the displacement and checks that it fits.
 */
function fromHere(target: bigint, address: bigint): string {
    const delta = BigInt.asIntN(64, target - address)
    return delta < 0n ? `$$-${hex(-delta)}` : `$$+${hex(delta)}`
}

/** The code of a line without its comment: everything before a `;` outside quotes. */
function withoutComment(text: string): string {
    let quote = ''
    for (let i = 0; i < text.length; ++i) {
        const c = text[i]!
        if (quote) {
            if (c === quote) quote = ''
        } else if (c === "'" || c === '"' || c === '`') quote = c
        else if (c === ';') return text.slice(0, i)
    }
    return text
}

/**
 * NASM silently keeps only the low 32 bits of a displacement too large for one when the operand
 * has a base register and the rest fits a byte (`[rax+0xffffffff]` assembles as `[rax-1]`, and
 * `[rax+2*0x7fffffff+1]` too), so a 64-bit address's displacement is computed here, with the
 * registers as 0, and checked; one written with what {@link evaluate} cannot compute is refused.
 * A name is left to NASM's own checks, and 32-bit addressing wraps at 4 GiB as written.
 */
function checkDisplacement(inside: string, address: bigint): string | undefined {
    const expression = inside
        .replace(new RegExp(String.raw`^\s*${SEGMENT}`, 'i'), '')
        .replace(/^\s*(?:(?:abs|nosplit|byte|word|dword|qword)\s+)*/i, '')
    const names = expression.match(NAME) ?? []
    if (!names.some((name) => GPR64.test(name))) return undefined
    if (names.some((name) => GPR32.test(name) || GPR16.test(name))) return undefined
    const displacement = evaluate(expression, address, (name) =>
        GPR64.test(name) || VECTOR.test(name) ? 0n : undefined
    )
    if (displacement === 'name') return undefined
    if (displacement === 'overflow') return `A number in [${inside.trim()}] does not fit in 64 bits`
    if (displacement === 'invalid')
        return `Write the displacement in [${inside.trim()}] with numbers, + - * / ~ and parentheses, such as [rax+0x10]`
    if (displacement < -(1n << 31n) || displacement >= 1n << 31n)
        return `The displacement ${displacement < 0n ? '-' : ''}${hex(displacement < 0n ? -displacement : displacement)} does not fit in 32 bits`
    return undefined
}

/** The text rewritten for NASM, which {@link assembleInstruction} and the batch path share. */
function prepareInstruction(
    text: string,
    address: bigint,
    index: number
): PreparedInstruction | { error: string } {
    if (!text.trim() || /[\r\n]/.test(text)) return { error: 'Enter one instruction' }
    if (address < 0n || address > MAX_ADDRESS) return { error: 'Invalid x86-64 address' }
    let line = withoutComment(text).trim()
    // A trailing backslash would join the next line of the batch to this one.
    if (!line || line.endsWith('\\')) return { error: 'Enter one instruction' }
    if (DIRECTIVE.test(line)) return { error: 'Enter an instruction, not an assembler directive' }
    for (const [form, error] of MISENCODED) if (form.test(line)) return { error }

    let memoryTarget: bigint | undefined
    let failure: string | undefined
    line = line.replace(/\[([^\]]*)\]/g, (whole, inside: string) => {
        const rel = RIP_RELATIVE.exec(inside)
        if (!rel) {
            failure ??= checkDisplacement(inside, address)
            return whole
        }
        const target = evaluate(rel[3]!, address)
        if (target === 'overflow') failure ??= `${rel[3]!.trim()} does not fit in 64 bits`
        else if (typeof target === 'bigint') {
            memoryTarget = BigInt.asUintN(64, target)
            return `[${rel[1]}rel ${rel[2]}${fromHere(memoryTarget, address)}]`
        } else
            failure ??= `Write the target of [rel ${rel[3]!.trim()}] as an address, such as [rel 0x404010] or [rel 0x404010+0x8]`
        return whole
    })
    if (failure) return { error: failure }

    let branchTarget: bigint | undefined
    const branch = BRANCH.exec(line)
    // A constant target, however it is written, is rewritten relative to the section, or NASM
    // encodes a displacement it never range-checks (`jmp 0x90000000+0x1+0x1` from 0x401000 jumps
    // to 0xffffffff90000002). A register, a memory operand, a name and a far pointer (`0x10:0x0`)
    // are NASM's to encode or refuse.
    if (branch && !/[[:]/.test(branch[4]!)) {
        const target = evaluate(branch[4]!, address)
        if (target === 'overflow') return { error: `${branch[4]!.trim()} does not fit in 64 bits` }
        if (target === 'invalid')
            return {
                error: `Write the target of ${branch[2]} ${branch[4]!.trim()} as an address, such as 0x401020 or 0x401020+0x8`
            }
        if (target !== 'name') {
            branchTarget = BigInt.asUintN(64, target)
            line = `${branch[1]}${branch[2]}${branch[3] || ' '}${fromHere(branchTarget, address)}`
        }
    }
    // NASM 3.00 encodes cmpxchg with a 64-bit or 16-bit register without its REX.W or 66 prefix
    // (`cmpxchg [rdx], rbx` assembles as `cmpxchg [rdx], ebx`); o64 and o16 make it write them.
    const cmpxchg = CMPXCHG.exec(line)
    if (cmpxchg && (GPR64.test(cmpxchg[3]!) || GPR16.test(cmpxchg[3]!)))
        line = `${cmpxchg[1]}${GPR64.test(cmpxchg[3]!) ? 'o64' : 'o16'} ${cmpxchg[2]}`
    // NASM 3.00 accepts `notrack` and encodes nothing for it; `ds` is the 3e prefix it stands for.
    line = line.replace(
        /^((?:(?:lock|bnd|rep|repe|repz|repne|repnz|xacquire|xrelease)\s+)*)notrack\b/i,
        '$1ds'
    )
    return { index, address, line, branchTarget, memoryTarget }
}

/** NASM's diagnostic, worded for a person: no file, line, severity or warning class. */
function diagnosticMessage(message: string, item: PreparedInstruction, part: number): string {
    message = message.replace(/\s*\[-w[+-][^\]]*\]\s*$/, '').trim()
    if (part === 2 || /^TIMES value .* is negative$/i.test(message))
        return `The text encodes more than ${MAX_INSTRUCTION_LENGTH} bytes, the most one instruction can have`
    const target = item.branchTarget ?? item.memoryTarget
    if (target !== undefined && /short jump is out of range/i.test(message))
        return `${hex(target)} is out of reach of a short jump from ${hex(item.address)}`
    if (target !== undefined && /^signed (?:byte|dword) exceeds bounds$/i.test(message))
        return `${hex(target)} is out of reach of a 32-bit displacement from ${hex(item.address)}`
    const overflow =
        /^(signed |unsigned )?(byte|word|dword|qword)( displacement)? exceeds bounds$/i.exec(
            message
        )
    if (overflow)
        return `The ${overflow[3] ? 'displacement' : 'value'} does not fit in a ${overflow[1] ?? ''}${overflow[2]}`
    if (/label alone on a line without a colon/i.test(message))
        return `${item.line.split(/\s/)[0]} is not an instruction`
    return message.charAt(0).toUpperCase() + message.slice(1)
}

type BatchRun = { output: Uint8Array } | { failed: Map<number, string>; message?: string }

const DIAGNOSTIC = new RegExp(
    String.raw`^(?:panic: )?${INSTRUCTION_SOURCE.replace(/[.]/g, '\\.')}:(\d+): (?:(?:error|warning|fatal|panic): )?(.*)$`
)

/** One NASM instance over a batch: its output, or which lines failed and why. */
async function runBatch(items: readonly PreparedInstruction[]): Promise<BatchRun> {
    let source = 'bits 64\ndefault abs\n'
    items.forEach((item, k) => {
        source +=
            `section i${k} vstart=${hex(item.address)} align=1\n${item.line}\n` +
            `..@e${k}: times ${RECORD_LENGTH_AT}-(..@e${k}-$$) db 0\ndb ..@e${k}-$$\ndw ${k}\n`
    })
    const { module, stderr } = await createNasmModule()
    module.FS.writeFile(INSTRUCTION_SOURCE, source)
    const status = callNasm(module, [
        ...INSTRUCTION_ARGS,
        INSTRUCTION_SOURCE,
        '-o',
        INSTRUCTION_OUTPUT
    ])
    const failed = new Map<number, string>()
    let message: string | undefined
    for (const diagnostic of stderr().split('\n')) {
        if (!diagnostic.trim()) continue
        const match = DIAGNOSTIC.exec(diagnostic)
        const offset = match ? Number(match[1]) - 1 - HEADER_LINES : -1
        const k = Math.floor(offset / RECORD_LINES)
        if (match && offset >= 0 && k < items.length) {
            if (!failed.has(k))
                failed.set(k, diagnosticMessage(match[2]!, items[k]!, offset % RECORD_LINES))
        } else message ??= diagnostic.replace(/^[^:]*: (?:error|warning|fatal|panic): /, '')
    }
    if (status !== 0 || failed.size) return { failed, message }
    const output = module.FS.analyzePath(INSTRUCTION_OUTPUT).exists
        ? (module.FS.readFile(INSTRUCTION_OUTPUT) as Uint8Array)
        : undefined
    const laidOut =
        output?.length === items.length * RECORD_SIZE &&
        items.every(
            (_, k) =>
                output[k * RECORD_SIZE + RECORD_SIZE - 2]! +
                    (output[k * RECORD_SIZE + RECORD_SIZE - 1]! << 8) ===
                k
        )
    return laidOut
        ? { output }
        : { failed, message: 'The text did not assemble as one instruction' }
}

/** Assemble a batch, setting aside the lines NASM rejects and assembling the others again. */
async function assembleBatch(
    items: readonly PreparedInstruction[],
    results: AssembledInstruction[]
): Promise<void> {
    while (items.length) {
        const run = await runBatch(items)
        if ('output' in run) {
            items.forEach((item, k) => {
                const at = k * RECORD_SIZE
                const length = run.output[at + RECORD_LENGTH_AT]!
                results[item.index] = !length
                    ? { error: 'The text did not encode an instruction' }
                    : length > MAX_INSTRUCTION_LENGTH
                      ? { error: diagnosticMessage('TIMES value is negative', item, 2) }
                      : { bytes: run.output.slice(at, at + length) }
            })
            return
        }
        if (run.failed.size) {
            for (const [k, error] of run.failed) results[items[k]!.index] = { error }
            items = items.filter((_, k) => !run.failed.has(k))
            continue
        }
        // NASM failed without naming a line of the batch: assemble each half alone to find which.
        if (items.length === 1) {
            results[items[0]!.index] = { error: run.message || 'The instruction did not assemble' }
            return
        }
        const half = items.length >> 1
        await assembleBatch(items.slice(0, half), results)
        await assembleBatch(items.slice(half), results)
        return
    }
}

/** The encoding must reach the targets the text named, which NASM only checks for range. */
function checkTargets(
    disassemble: Disassembler['disassemble'],
    item: PreparedInstruction,
    bytes: Uint8Array
): AssembledInstruction {
    const [decoded] = disassemble(bytes, item.address)
    const reached = (target: bigint | undefined, key: 'branchTarget' | 'memoryTarget') => {
        if (target === undefined) return true
        const operand = decoded?.operands.find((o) => o[key] !== undefined)
        return !operand || operand[key] === target
    }
    if (!reached(item.branchTarget, 'branchTarget'))
        return { error: `${hex(item.branchTarget!)} is out of reach from ${hex(item.address)}` }
    if (!reached(item.memoryTarget, 'memoryTarget'))
        return { error: `${hex(item.memoryTarget!)} is out of reach from ${hex(item.address)}` }
    return { bytes }
}
