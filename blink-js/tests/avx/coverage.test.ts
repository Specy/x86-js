// Which VEX encodings run. Every combination of map, prefix, opcode, length and width is placed in
// its own sixteen-byte slot of one program, with register and memory forms; a signal handler
// records whether the slot raised SIGILL, SIGSEGV or nothing and moves on to the next. The host
// answers the same question, and the two must agree: an instruction Blink lacks, and an encoding
// the hardware refuses that Blink runs, both show up.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../../src/x86-emulator'
import { linkedProgram } from '../compiler-output/helpers'
import { NATIVE_AVX } from './harness'

import { slots, source, type Slot } from './coverage-lib'

async function inBlink(src: string, count: number): Promise<{ program: Uint8Array; results: Uint8Array }> {
    const bytes: number[] = []
    const emulator = await createX86Emulator({ callbacks: { stdout: (chunk) => void bytes.push(...chunk) } })
    try {
        const result = await emulator.compile(src)
        expect(result.ok, result.report).toBe(true)
        const program = linkedProgram(emulator)
        emulator.getCompiledInstructions()
        bytes.length = 0
        for (let i = 0; i < 200_000 && emulator.stopReason?.kind !== 'exit'; i++) await emulator.run(10_000_000)
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        expect(bytes.length).toBe(count)
        return { program, results: Uint8Array.from(bytes) }
    } finally {
        emulator.dispose()
    }
}

function natively(program: Uint8Array): Uint8Array {
    const directory = mkdtempSync(join(tmpdir(), 'avx-coverage-'))
    const path = join(directory, 'probe.elf')
    try {
        writeFileSync(path, program)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })
        if (run.error) throw run.error
        expect(run.status, run.stderr.toString()).toBe(0)
        return new Uint8Array(run.stdout)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

/** One line per instruction, saying for which lengths, widths and forms the problem occurs. */
function summarize(list: Slot[], flags: boolean[]): string[] {
    const groups = new Map<string, string[]>()
    list.forEach((slot, i) => {
        if (!flags[i]) return
        const key = `map${slot.map} pp${slot.pp} ${slot.opcode.toString(16).padStart(2, '0')} /${slot.reg}`
        groups.set(key, [...(groups.get(key) ?? []), `L${slot.l}W${slot.w}${slot.form === 'reg' ? 'r' : 'm'}`])
    })
    return [...groups].map(([key, forms]) => `${key} ${forms.length === 8 ? 'all' : forms.join(',')}`)
}

describe.skipIf(!NATIVE_AVX)('VEX encodings', () => {
    for (const map of [1, 2, 3]) {
        it(`map ${map} runs where the host's does`, async () => {
            const list = slots(map)
            const { program, results } = await inBlink(source(list), list.length)
            const host = natively(program)
            const missing = summarize(list, list.map((_, i) => host[i] !== 1 && results[i] === 1))
            const extra = summarize(list, list.map((_, i) => host[i] === 1 && results[i] !== 1))
            expect({ missing, extra }).toEqual({ missing: [], extra: [] })
        })
    }
})
