#!/usr/bin/env node
/**
 * Writes the two tables the compiler-output translator reads NASM through. Both are committed, so
 * this runs when NASM is updated, not as part of the build:
 *
 *   node scripts/generate-nasm-reserved-names.mjs [path/to/nasm]
 *
 * The sources are NASM's own, from the tree `../compile_wasm_nasm.sh` downloads and builds into
 * the Core (`../wasm_nasm/nasm`, untracked), so the tables describe the assembler the Core runs.
 *
 * `src/compiler-output/nasm-reserved.ts`: every name NASM reads as something other than a symbol,
 * which is what the translator `$`-escapes a symbol from.
 *
 * - `x86/insnsn.c`: every mnemonic, condition-code families already expanded, pseudo-ops included.
 * - `x86/regs.dat`: every register, ranges such as `xmm0-31` expanded.
 * - `asm/tokens.dat`: prefixes, sizes, `rel`, `wrt`, `ptr` and the other keywords. A group flagged
 *   `TFLAG_BRC` (`{vex}`, `{z}`, `{sae}`) is a keyword only between braces: `asm/stdscan.c` reads
 *   it as an ordinary identifier everywhere else, so it is left out.
 * - `asm/directiv.dat`: the global directives, the pseudo-ops and the format-specific directives,
 *   but not the words that only follow `%pragma`.
 * - `macros/standard.mac`: the standard macros (`section`, `global`, `align`) and the single-line
 *   macros and aliases it defines (`__SECT__`, `__FILE__`), which the preprocessor would expand.
 *
 * Every name is lowercased: instructions, registers, keywords and directives are case-insensitive
 * in NASM and the standard macros are `%imacro`s, so a symbol is reserved whatever its case.
 *
 * `src/compiler-output/nasm-instruction-set.ts`: which forms of each mnemonic the translator lets
 * through, from the macro-expanded instruction table `x86/insns.xda`, its flags (`x86/iflags.ph`)
 * and the condition codes `x86/insns.pl` expands `cc` templates with. A form is allowed when its
 * template is neither VEX, EVEX nor XOP encoded, needs no instruction-set extension beyond x87,
 * SSE, SSE2 and SSE3, needs no processor newer than x86-64's baseline, works in 64-bit mode, is
 * documented, unprivileged and no system instruction. That is what Blink, as the Core builds it
 * (no MMX, no VEX decoder), runs; `endbr64` is admitted on top, since Blink runs it as a no-op.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nasmRoot = resolve(process.argv[2] ?? join(packageRoot, '../wasm_nasm/nasm'))
const outputDirectory = join(packageRoot, 'src/compiler-output')

const read = (path) => readFileSync(join(nasmRoot, path), 'utf8')

/** NASM's `nasm_isidstart` and `nasm_isidchar` (`include/nctype.h`, `nasmlib/ctype.c`). */
const NASM_IDENTIFIER = /^[A-Za-z_.?@][A-Za-z0-9_.?@$#~]*$/

// --- Reserved names ------------------------------------------------------------------------------

function readMnemonics() {
    return [...read('x86/insnsn.c').matchAll(/^\t"([^"]+)",$/gm)].map((match) => match[1])
}

function readRegisters() {
    const registers = []
    for (const line of read('x86/regs.dat').split('\n')) {
        const match = /^([a-z][a-z0-9-]*)\s+\S+/.exec(line)
        if (!match) continue
        const range = /^([a-z]+)(\d+)-(\d+)([a-z]*)$/.exec(match[1])
        if (!range) {
            registers.push(match[1])
            continue
        }
        const [, prefix, from, to, suffix] = range
        for (let index = Number(from); index <= Number(to); index += 1) {
            registers.push(`${prefix}${index}${suffix}`)
        }
    }
    return registers
}

function readKeywords() {
    const keywords = []
    let braceOnly = false
    for (const line of read('asm/tokens.dat').split('\n')) {
        const header = /^%\s*([^,]+),\s*([^,]+),\s*([^,]+),/.exec(line)
        if (header) {
            braceOnly = header[3].split('|').some((flag) => flag.trim() === 'TFLAG_BRC')
            continue
        }
        const token = line.trim()
        if (!token || token.startsWith('#') || braceOnly) continue
        if (NASM_IDENTIFIER.test(token)) keywords.push(token)
    }
    return keywords
}

function readDirectives() {
    const directives = []
    let section = null
    for (const line of read('asm/directiv.dat').split('\n')) {
        const heading = /^; ---\s*(.*)$/.exec(line)
        if (heading) {
            section = heading[1]
            continue
        }
        const kept =
            section === 'Global directives' ||
            section?.startsWith('Pseudo-op list') ||
            section === 'Format-specific directives'
        if (!kept || line.startsWith('#') || line.startsWith(';')) continue
        const name = line.split(';')[0].trim()
        if (name && NASM_IDENTIFIER.test(name)) directives.push(name)
    }
    return directives
}

function readStandardMacros() {
    const source = read('macros/standard.mac')
    const multiLine = [...source.matchAll(/^\s*%i?r?macro\s+([^\s(]+)/gim)].map((match) => match[1])
    const singleLine = [
        ...source.matchAll(/^\s*%(?:i?x?define|i?assign|i?defalias|i?defstr|i?deftok)\s+([^\s(]+)/gim),
    ].map((match) => match[1])
    return [...multiLine, ...singleLine].filter((name) => NASM_IDENTIFIER.test(name))
}

// --- Instruction set -----------------------------------------------------------------------------

/** The extensions the translator allows on top of the integer baseline, as `iflags.ph` names them. */
const ALLOWED_FEATURES = new Set(['FPU', 'SSE', 'SSE2', 'SSE3'])

/** Processor levels up to x86-64's baseline; `AMD` marks AMD-introduced baseline (`syscall`). */
const ALLOWED_LEVELS = new Set([
    '8086',
    '186',
    '286',
    '386',
    '486',
    'PENT',
    'P6',
    'KATMAI',
    'WILLAMETTE',
    'PRESCOTT',
    'X86_64',
    'AMD',
])

/** Flags in the feature group that are not extensions, and what they make a template. */
const REJECTING_FLAGS = {
    PRIV: 'is privileged',
    SMM: 'runs only in system-management mode',
    UNDOC: 'is undocumented',
    OBSOLETE: 'was removed from the architecture',
    NEVER: 'was never implemented',
    NOP: 'is a legacy no-op',
}

/** `PROT` only says protected mode, which 64-bit mode is. */
const NEUTRAL_FEATURES = new Set(['PROT'])

/**
 * Table sections of system instructions: an operating system's, never a program's, whether or not
 * the table flags them privileged (`cpuid`, `swapgs`, `in`, `int` and `syscall` are not).
 */
const SYSTEM_SECTIONS = new Set([
    'Interrupts, system calls, and returns',
    'Machine control and management instructions',
    'System management mode',
    'I/O instructions',
    'Segment handling instructions',
    'XSAVE group (AVX and extended state)',
    'VMX/SVM Instructions',
    'Extended Page Tables VMX instructions',
    'SEV-SNP AMD instructions',
    'Intel SMX',
    'VIA (Centaur) security instructions',
    'AMD Lightweight Profiling (LWP) instructions',
    'Intel Software Guard Extensions (SGX)',
    'Flexible Return and Exception Delivery',
    'User interrupts',
    'History reset',
])

/** System instructions filed in otherwise ordinary sections. */
const SYSTEM_MNEMONICS = new Set(['cli', 'sti', 'insb', 'insw', 'insd', 'outsb', 'outsw', 'outsd', 'rdpmc', 'invlpga'])

/**
 * Mnemonics the flags let through by a quirk of the table: one `jmpe` template lacks `IA64`, and
 * `jmpabs`, an APX instruction, has a fallback template that is not marked APX.
 */
const REJECTED_MNEMONICS = {
    jmpe: 'is a system instruction',
    jmpabs: 'needs APX',
}

/** Allowed despite their flags: Blink runs `endbr64` as a 4-byte no-op, and NASM accepts it. */
const ADMITTED = new Set(['endbr64'])

/** Short names for the reasons a form is rejected. */
const FEATURE_NAMES = {
    '3DNOW': '3DNow!',
    SSE41: 'SSE4.1',
    SSE42: 'SSE4.2',
    SSE4A: 'SSE4a',
    SSE5: 'SSE5 (XOP)',
    AVX512: 'AVX-512',
}

function featureName(flag) {
    if (FEATURE_NAMES[flag]) return FEATURE_NAMES[flag]
    const avx512 = /^AVX512(\w+)$/.exec(flag)
    if (avx512) return `AVX-512 ${avx512[1]}`
    return flag
}

/**
 * The flag groups of `iflags.ph`: two `if_align` markers cut the ordered list into behaviour
 * flags, then features (`FEATURE`), then processor levels (`CPU`).
 */
function readFlagGroups() {
    const groups = new Map()
    const descriptions = new Map()
    let group = 'behaviour'
    for (const line of read('x86/iflags.ph').split('\n')) {
        const align = /^if_align\('(\w+)'/.exec(line)
        if (align) {
            if (align[1] === 'FEATURE') group = 'feature'
            else if (align[1] === 'CPU') group = 'cpu'
            continue
        }
        const flag = /^if_\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\)/.exec(line)
        if (flag) {
            groups.set(flag[1].toUpperCase(), group)
            descriptions.set(flag[1].toUpperCase(), flag[2].replace(/\s+/g, ' ').trim())
        }
    }
    // The single-CPUID-bit features are a Perl list spanning several lines, in the feature group.
    const oneins = /my @oneins = qw\(([^)]*)\)/s.exec(read('x86/iflags.ph'))
    for (const name of oneins?.[1].split(/\s+/).filter(Boolean) ?? []) {
        groups.set(name.toUpperCase(), 'feature')
        descriptions.set(name.toUpperCase(), `${name.toUpperCase()} instruction`)
    }
    return { groups, descriptions }
}

/** `%conds` of `insns.pl`: which condition names a `cc` and an `scc` template expand over. */
function readConditions() {
    const block = /my %conds = \(([\s\S]*?)\);/.exec(read('x86/insns.pl'))
    if (!block) throw new Error('could not find %conds in x86/insns.pl')
    const cc = []
    const scc = []
    for (const match of block[1].matchAll(/'(\w*)'\s*=>\s*([^,)]+)/g)) {
        const [, name, value] = match
        const ccOnly = /\$c_cc\b/.test(value)
        const sccOnly = /\$c_scc\b/.test(value)
        if (!sccOnly) cc.push(name)
        if (!ccOnly) scc.push(name)
    }
    return { cc, scc }
}

/**
 * The operand kinds the translator tells apart: `g` general register, `m` memory, `i` immediate or
 * branch target, `x` an `xmm` register, `f` an x87 register. Anything else (MMX, AVX, mask,
 * segment and system registers, far pointers) is `-`, which no translated operand ever is.
 */
function operandKinds(operand) {
    const base = operand.split('|')[0].replace(/[*?]$/, '')
    if (/^(reg(8|16|32|64)|reg32na|reg_(al|ah|ax|eax|rax|bl|bx|ebx|rbx|cl|cx|ecx|rcx|dl|dx|edx|rdx))$/.test(base))
        return 'g'
    if (/^rm(8|16|32|64)$/.test(base)) return 'gm'
    if (/^(mem\d*|mem_offs)$/.test(base)) return 'm'
    if (/^(imm\d*|imm_known8|sbyte(word|dword)\d*|udword64|sdword64|unity)$/.test(base)) return 'i'
    if (/^(xmmreg|xmm0)$/.test(base)) return 'x'
    if (/^xmmrm\d*$/.test(base)) return 'xm'
    if (/^(fpureg|fpu0)$/.test(base)) return 'f'
    if (
        /^(mmx|ymm|zmm|tmm|k|bnd|creg|dreg|treg|sreg|[xyz]mem|reg64:|reg_(es|cs|ss|ds|fs|gs|sreg|creg|dreg|treg)|rm_sel|imm\d*:imm|spec4)/.test(
            base,
        )
    )
        return '-'
    throw new Error(`unclassified operand type ${operand}`)
}

/** The operand lists a template accepts: `*` and `?` mark an operand that may be left out. */
function operandForms(operands) {
    if (operands === 'void' || operands === 'ignore') return [[]]
    const list = operands.split(',')
    const forms = [list.map(operandKinds)]
    list.forEach((operand, index) => {
        if (!/[*?]$/.test(operand.split('|')[0])) return
        forms.push(list.filter((_, other) => other !== index).map(operandKinds))
    })
    return forms
}

function readInstructionSet() {
    const { groups, descriptions } = readFlagGroups()
    const conditions = readConditions()
    const accepted = new Set(readMnemonics())
    /** mnemonic -> { allowed: Set<signature>, rejected: Map<signature, Set<reason>> } */
    const table = new Map()
    const entry = (mnemonic) => {
        if (!table.has(mnemonic)) table.set(mnemonic, { allowed: new Set(), rejected: new Map() })
        return table.get(mnemonic)
    }

    let section = ''
    for (const line of read('x86/insns.xda').split('\n')) {
        if (line.startsWith(';#')) {
            section = line.slice(2).trim()
            continue
        }
        if (!line.trim() || line.trim().startsWith(';')) continue
        const match = /^(\S+)\s+(\S+)\s+(\[.*?\]|\S+)\s+(\S+)\s*$/.exec(line)
        if (!match) throw new Error(`unreadable insns.xda line: ${line}`)
        const [, template, operands, encoding, flagList] = match
        const flags = flagList.split(',')

        const reason = rejection({ template, operands, encoding, flags, section, groups, descriptions })
        for (const mnemonic of expandMnemonic(template, conditions, accepted)) {
            const record = entry(mnemonic)
            for (const form of operandForms(operands)) {
                const signature = form.join(',')
                if (reason && !ADMITTED.has(mnemonic)) {
                    if (!record.rejected.has(signature)) record.rejected.set(signature, new Set())
                    record.rejected.get(signature).add(reason)
                } else if (!form.includes('-')) record.allowed.add(signature)
            }
        }
    }
    for (const mnemonic of accepted) entry(mnemonic)
    return table
}

/** `CMOVcc` is the 30 `cmovz`/`cmovnbe`/… names, as `insns.pl` expands it. */
function expandMnemonic(template, conditions, accepted) {
    const conditional = /s?cc/.exec(template)
    if (!conditional) return [template.toLowerCase()]
    const names = conditional[0] === 'scc' ? conditions.scc : conditions.cc
    return names
        .map((condition) => template.replace(/s?cc/, condition).toLowerCase())
        .filter((name) => accepted.has(name))
}

/** Why a template is outside the allowed instruction set, or null when it is inside it. */
function rejection({ template, encoding, flags, section, groups, descriptions }) {
    if (flags.includes('PSEUDO')) return 'is a NASM pseudo-instruction, not an instruction'
    const named = REJECTED_MNEMONICS[template.toLowerCase()]
    if (named) return named
    const features = flags.filter((flag) => groups.get(flag) === 'feature')
    const levels = flags.filter((flag) => groups.get(flag) === 'cpu')
    const extensions = features.filter(
        (flag) =>
            !ALLOWED_FEATURES.has(flag) &&
            !NEUTRAL_FEATURES.has(flag) &&
            !REJECTING_FLAGS[flag] &&
            flag !== 'VEX' &&
            flag !== 'EVEX',
    )
    const encoded = /^\[\s*(?:\S*:)?\s*(vex|evex|xop)\b/.exec(encoding)?.[1]
    if (encoded || flags.includes('VEX') || flags.includes('EVEX') || flags.includes('REX2')) {
        const kind = (
            encoded ?? (flags.includes('EVEX') ? 'evex' : flags.includes('VEX') ? 'vex' : 'rex2')
        ).toUpperCase()
        const named = extensions.map(featureName)
        return `needs ${named.length ? named.join(' and ') : 'APX'} (${kind}-encoded)`
    }
    if (extensions.length) return `needs ${extensions.map(featureName).join(' and ')}`
    for (const flag of flags) if (REJECTING_FLAGS[flag]) return REJECTING_FLAGS[flag]
    if (flags.includes('NOLONG')) return 'is not available in 64-bit mode'
    if (SYSTEM_SECTIONS.has(section) || SYSTEM_MNEMONICS.has(template.toLowerCase())) {
        return 'is a system instruction'
    }
    const newer = levels.filter((level) => !ALLOWED_LEVELS.has(level))
    if (newer.length) {
        return `needs ${newer.map((level) => descriptions.get(level) ?? level).join(' and ')}, beyond the x86-64 baseline`
    }
    return null
}

// --- Output --------------------------------------------------------------------------------------

const version = read('version').trim()
const mnemonics = readMnemonics()
const registers = readRegisters()
const keywords = readKeywords()
const directives = readDirectives()
const macros = readStandardMacros()

const sorted = (names) => [...new Set(names.map((name) => name.toLowerCase()))].sort()
const reserved = sorted([...mnemonics, ...registers, ...keywords, ...directives, ...macros])

/** Ten names to a line keeps the file diffable without one line per name. */
function list(names) {
    const rows = []
    for (let index = 0; index < names.length; index += 10) {
        rows.push(
            `    ${names
                .slice(index, index + 10)
                .map((name) => JSON.stringify(name))
                .join(', ')},`,
        )
    }
    return rows.join('\n')
}

const sourceLine = `NASM ${version} (\`${relative(packageRoot, nasmRoot)}\`, downloaded by \`compile_wasm_nasm.sh\`)`
const licence = 'SPDX-License-Identifier: BSD-2-Clause, Copyright 1996-2025 The NASM Authors.'

writeFileSync(
    join(outputDirectory, 'nasm-reserved.ts'),
    `/**
 * Every name NASM ${version} reads as an instruction, register, keyword, directive or standard
 * macro, lowercased and sorted: the names the compiler-output translator \`$\`-escapes a symbol from.
 *
 * Generated by \`node scripts/generate-nasm-reserved-names.mjs\`; edit that script, never this file.
 *
 * Sources: ${sourceLine}:
 * \`x86/insnsn.c\`, \`x86/regs.dat\`, \`asm/tokens.dat\`, \`asm/directiv.dat\` and \`macros/standard.mac\`,
 * ${licence}
 */

/** The NASM release the tables were read from. */
export const NASM_RESERVED_VERSION = ${JSON.stringify(version)}

/** Every register name NASM reads (\`x86/regs.dat\`). */
export const NASM_REGISTERS: readonly string[] = [
${list(sorted(registers))}
]

/** Every mnemonic, register, keyword, directive and standard macro name. */
export const NASM_RESERVED_NAMES: readonly string[] = [
${list(reserved)}
]
`,
)

const instructionSet = readInstructionSet()
const reasonTable = []
const reasonIndex = new Map()
const indexOf = (reason) => {
    if (!reasonIndex.has(reason)) {
        reasonIndex.set(reason, reasonTable.length)
        reasonTable.push(reason)
    }
    return reasonIndex.get(reason)
}
/** `_` stands for no operands, so that an empty string can mean no forms at all. */
const spell = (signature) => signature || '_'
const bySignature = (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
const rows = [...instructionSet.keys()].sort().map((mnemonic) => {
    const { allowed, rejected } = instructionSet.get(mnemonic)
    const forms = [...allowed].map(spell).sort(bySignature)
    if (forms.length === 0) {
        // Nothing allowed: one entry, `*`, for every form, with every reason.
        const reasons = new Set([...rejected.values()].flatMap((set) => [...set]))
        const indices = [...reasons]
            .map(indexOf)
            .sort((a, b) => a - b)
            .join('+')
        return `    [${JSON.stringify(mnemonic)}, ["", ${JSON.stringify(indices ? `*=${indices}` : '')}]],`
    }
    const others = [...rejected.entries()]
        .filter(([signature]) => !allowed.has(signature))
        .map(([signature, reasons]) => [
            spell(signature),
            [...reasons]
                .map(indexOf)
                .sort((a, b) => a - b)
                .join('+'),
        ])
        .sort(([left], [right]) => bySignature(left, right))
        .map(([signature, reasons]) => `${signature}=${reasons}`)
    return `    [${JSON.stringify(mnemonic)}, [${JSON.stringify(forms.join('|'))}, ${JSON.stringify(others.join('|'))}]],`
})
const allowedCount = [...instructionSet.values()].filter((record) => record.allowed.size > 0).length

writeFileSync(
    join(outputDirectory, 'nasm-instruction-set.ts'),
    `/**
 * Every mnemonic NASM ${version} assembles, with the operand forms the compiler-output translator lets
 * through and why its other forms are rejected. A form is allowed when its template is neither VEX,
 * EVEX nor XOP encoded, needs no extension beyond x87, SSE, SSE2 and SSE3, no processor newer than
 * the x86-64 baseline, works in 64-bit mode, and is documented, unprivileged and no system
 * instruction; \`endbr64\` is admitted on top. That is what Blink, as the Core builds it, runs.
 *
 * Generated by \`node scripts/generate-nasm-reserved-names.mjs\`; edit that script, never this file.
 *
 * Sources: ${sourceLine}:
 * \`x86/insns.xda\`, \`x86/iflags.ph\` and \`x86/insns.pl\`,
 * ${licence}
 */

/** Why forms are rejected, as predicates of the mnemonic (\`needs SSSE3\`, \`is privileged\`). */
export const NASM_REJECTION_REASONS: readonly string[] = [
${reasonTable.map((reason) => `    ${JSON.stringify(reason)},`).join('\n')}
]

/** A mnemonic's allowed forms and its rejected forms with their reasons. */
export type InstructionForms = readonly [allowed: string, rejected: string]

/**
 * Each mnemonic with its [allowed forms, rejected forms]. Forms are \`|\`-separated operand lists,
 * \`_\` for none; each operand is the kinds it accepts: \`g\` a general register, \`m\` memory, \`i\` an
 * immediate or branch target, \`x\` an \`xmm\` register, \`f\` an x87 register, so \`gm\` is a register
 * or memory, and \`-\` a kind no translated operand is (MMX, AVX, mask and system registers). A
 * rejected form is followed by \`=\` and the \`+\`-separated indices of its reasons in
 * {@link NASM_REJECTION_REASONS}. An empty allowed list means no form at all is allowed, and its
 * rejected forms are then the single \`*\`, standing for every form.
 *
 * A Map rather than an object, so that no mnemonic in the input reads a property every object has,
 * such as \`constructor\`.
 */
export const NASM_INSTRUCTION_SET: ReadonlyMap<string, InstructionForms> = new Map<string, InstructionForms>([
${rows.join('\n')}
])
`,
)

console.log(
    `nasm-reserved.ts: ${reserved.length} reserved names (${mnemonics.length} mnemonics, ` +
        `${registers.length} registers, ${keywords.length} keywords, ${directives.length} directives, ` +
        `${macros.length} standard macros); nasm-instruction-set.ts: ${instructionSet.size} mnemonics, ` +
        `${allowedCount} with allowed forms, ${reasonTable.length} reasons; from NASM ${version}`,
)
