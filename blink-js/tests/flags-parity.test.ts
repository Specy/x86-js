// The flags the Core reports, against the ones the machine itself uses.
//
// Blink keeps PF lazily: bit 2 of its flags word is not maintained, and PF is
// the parity of the low byte of the last result, kept in bits 24..31. PUSHF,
// JP and SETP compute PF from there. The bridge used to hand JavaScript that
// raw word, and to write raw words back, so the flags panel, the register
// snapshot, the step history and a Poke all saw or set a bit 2 nothing reads:
// after `xor eax, eax` the panel said PF=0 while PUSHFQ pushed PF=1. Every
// check here compares what the Core reports with what PUSHFQ pushes, or what
// it writes with what JP then does.
import { describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { X86_FLAGS } from '../src/x86-emulator-utils'

const CHECKED_FLAGS = ['CF', 'PF', 'AF', 'ZF', 'SF', 'OF'] as const
type CheckedFlag = (typeof CHECKED_FLAGS)[number]

const PF = 1 << 2

function maskOf(name: CheckedFlag): number {
    return X86_FLAGS.find((flag) => flag.name === name)!.mask
}

/** The checked flags of an RFLAGS word, by name. */
function flagsOf(word: number | bigint): Record<CheckedFlag, number> {
    const value = Number(BigInt(word) & 0xffffffffn)
    return Object.fromEntries(CHECKED_FLAGS.map((name) => [name, value & maskOf(name) ? 1 : 0])) as Record<
        CheckedFlag,
        number
    >
}

/** The checked flags as the Core's flags panel reports them. */
function panelFlags(emulator: X86Emulator): Record<CheckedFlag, number> {
    const panel = emulator.getFlags()
    return Object.fromEntries(
        CHECKED_FLAGS.map((name) => [name, panel.find((flag) => flag.name === name)!.value]),
    ) as Record<CheckedFlag, number>
}

/** The quadword on top of the stack: what the PUSHFQ just before pushed. */
function pushedWord(emulator: X86Emulator): bigint {
    const bytes = emulator.readMemoryBytes(emulator.getSp(), 8n)
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
}

function lineOf(lines: string[], marker: string): number {
    const index = lines.findIndex((line) => line.includes(marker))
    if (index < 0) throw new Error(`no line holds ${marker}`)
    return index
}

async function compiled(lines: string[]): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(lines.join('\n'))
    if (!result.ok) throw new Error(`the program did not assemble:\n${result.report}`)
    return emulator
}

function addressOfLine(emulator: X86Emulator, line: number): bigint {
    const instruction = emulator.getCompiledInstructions().find((candidate) => candidate.lineNumber === line)
    if (!instruction) throw new Error(`no instruction on line ${line}`)
    return instruction.address
}

type ParityCase = { name: string; lines: string[]; pf: number }

// Results of both parities, from several instructions, and two whose low byte
// has the other parity from the whole value: PF looks at the low byte only.
const PARITY_CASES: ParityCase[] = [
    { name: 'xor eax, eax: 0, even', lines: ['xor eax, eax'], pf: 1 },
    { name: 'add al, 0 on 1: odd', lines: ['mov al, 1', 'add al, 0'], pf: 0 },
    { name: 'add al, 0 on 3: even', lines: ['mov al, 3', 'add al, 0'], pf: 1 },
    { name: 'sub: 9 - 2 = 7, odd', lines: ['mov eax, 9', 'sub eax, 2'], pf: 0 },
    { name: 'sub: 2 - 3 = -1, even, with a borrow and the sign', lines: ['mov eax, 2', 'sub eax, 3'], pf: 1 },
    { name: 'and: 0xF0 & 0x70 = 0x70, odd', lines: ['mov eax, 0xf0', 'and eax, 0x70'], pf: 0 },
    { name: 'and: 0xFF & 0x0F = 0x0F, even', lines: ['mov eax, 0xff', 'and eax, 0x0f'], pf: 1 },
    { name: '0xFF + 1 = 0x100: low byte even, whole value odd', lines: ['mov eax, 0xff', 'add eax, 1'], pf: 1 },
    { name: '0x101 | 0 = 0x101: low byte odd, whole value even', lines: ['mov eax, 0x101', 'or eax, 0'], pf: 0 },
    { name: '0x7F + 1 in al = 0x80: overflow, odd', lines: ['mov al, 0x7f', 'add al, 1'], pf: 0 },
    { name: '0xFF + 1 in al = 0: carry and zero, even', lines: ['mov al, 0xff', 'add al, 1'], pf: 1 },
]

describe('the flags the Core reports are the ones PUSHFQ pushes', () => {
    it('agrees on every flag after results of either parity', async () => {
        const lines = ['bits 64', 'global _start', 'section .text', '_start:']
        const probes = new Map<number, ParityCase>()
        for (const entry of PARITY_CASES) {
            lines.push(...entry.lines.map((line) => `  ${line}`), '  pushfq')
            probes.set(lines.length, entry)
            lines.push('  nop', '  pop rcx')
        }
        lines.push('  mov eax, 60', '  xor edi, edi', '  syscall')

        const emulator = await compiled(lines)
        const seen: string[] = []
        const breakpoints = [...probes.keys()]
        await emulator.run(undefined, breakpoints)
        while (emulator.stopReason?.kind === 'breakpoint') {
            const entry = probes.get(emulator.stopReason.lineNumber ?? -1)!
            const pushed = pushedWord(emulator)
            expect(flagsOf(pushed).PF, `${entry.name}: the PF PUSHFQ pushed`).toBe(entry.pf)
            expect(panelFlags(emulator), `${entry.name}: the flags panel`).toEqual(flagsOf(pushed))
            // The whole word, not only the named flags, is the one PUSHFQ pushed,
            // both as the bridge returns it and in the register snapshot.
            expect(emulator.runtime.getFlags(), `${entry.name}: the flags word`).toBe(pushed)
            expect(BigInt(emulator.runtime.getRegisterSnapshot().flags), `${entry.name}: the snapshot`).toBe(pushed)
            seen.push(entry.name)
            await emulator.run(undefined, breakpoints)
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        expect(seen).toEqual(PARITY_CASES.map((entry) => entry.name))
        emulator.dispose()
    })
})

describe('with native history', () => {
    it('records the architectural PF in a step and reports the one before it as prev', async () => {
        const lines = [
            'bits 64',
            'global _start',
            'section .text',
            '_start:',
            '  mov al, 1',
            '  add al, 0',
            '  xor eax, eax',
            '  pushfq',
            '  mov eax, 60',
            '  xor edi, edi',
            '  syscall',
        ]
        const emulator = await compiled(lines)
        emulator.initialize(16)

        await emulator.step() // mov al, 1
        await emulator.step() // add al, 0: PF=0
        expect(panelFlags(emulator).PF).toBe(0)
        await emulator.step() // xor eax, eax: PF=1

        const [xor] = emulator.getUndoHistory(1)
        expect(flagsOf(xor!.old_ccr.bits).PF, 'old_ccr').toBe(0)
        expect(flagsOf(xor!.new_ccr.bits).PF, 'new_ccr').toBe(1)
        expect(flagsOf(xor!.new_ccr.bits).ZF, 'new_ccr').toBe(1)
        const pf = emulator.getFlags().find((flag) => flag.name === 'PF')!
        expect(pf).toEqual({ name: 'PF', value: 1, prev: 0 })

        await emulator.step() // pushfq
        expect(BigInt(xor!.new_ccr.bits), 'new_ccr is the word PUSHFQ pushed').toBe(pushedWord(emulator))
        emulator.dispose()
    })

    it('undoes a step back to the PF before it, which JP then reads', async () => {
        const lines = [
            'bits 64',
            'global _start',
            'section .text',
            '_start:',
            '  xor eax, eax', //    PF=1
            '  add al, 1', //       PF=0, stepped and undone
            '  jp parity_even', //  reached by moving rip past the add
            '  mov edi, 1',
            '  jmp done',
            'parity_even:',
            '  mov edi, 2',
            'done:',
            '  mov eax, 60',
            '  syscall',
        ]
        const emulator = await compiled(lines)
        emulator.initialize(16)

        await emulator.step() // xor eax, eax
        await emulator.step() // add al, 1
        expect(panelFlags(emulator).PF).toBe(0)

        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(0n)
        expect(panelFlags(emulator).PF, 'PF after the undo').toBe(1)

        // Run the JP without the ADD, so it reads the flags the undo restored.
        emulator.setRegisterValue('rip', addressOfLine(emulator, lineOf(lines, 'jp parity_even')))
        await emulator.step()
        expect(emulator.getPc(), 'JP took the even-parity branch').toBe(
            addressOfLine(emulator, lineOf(lines, 'mov edi, 2')),
        )
        await emulator.run()
        expect(emulator.stopReason?.exitCode).toBe(2)
        emulator.dispose()
    })

    for (const { from, to } of [
        { from: 0, to: 1 },
        { from: 1, to: 0 },
    ]) {
        it(`lets a Poke set PF from ${from} to ${to} for the JP after it`, async () => {
            const lines = [
                'bits 64',
                'global _start',
                'section .text',
                '_start:',
                // 1 has odd parity, 3 even
                `  mov al, ${from ? 3 : 1}`,
                '  add al, 0',
                '  jp parity_even',
                '  mov edi, 1',
                '  jmp done',
                'parity_even:',
                '  mov edi, 2',
                'done:',
                '  mov eax, 60',
                '  syscall',
            ]
            const emulator = await compiled(lines)
            await emulator.run(undefined, [lineOf(lines, 'jp parity_even')])
            expect(emulator.stopReason?.kind).toBe('breakpoint')

            // X86Emulator has no flags setter of its own; the runtime's is the public one.
            emulator.beginPoke()
            const flags = emulator.runtime.getFlags()
            emulator.runtime.setFlags(to ? flags | BigInt(PF) : flags & ~BigInt(PF))
            emulator.endPoke()
            expect(panelFlags(emulator).PF, 'PF after the Poke').toBe(to)

            await emulator.step()
            expect(emulator.getPc(), 'where JP went').toBe(
                addressOfLine(emulator, lineOf(lines, to ? 'mov edi, 2' : 'mov edi, 1')),
            )
            emulator.dispose()
        })
    }
})
