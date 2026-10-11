import { expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { X86_PROGRAM_ENVIRONMENT } from '../src/linux-runtime'
import { elfFixture } from './elf-fixtures'

it('preserves UTF-8, empty and spaced words and supplies the fixed environment', async () => {
    const emulator = await createX86Emulator()
    try {
        await emulator.loadExecutable(elfFixture('argv-env'))
        const words = ['./argv-env', '', 'two words', 'café 猫', 'a'.repeat(500)]
        emulator.setProgramArguments(words[0], words.slice(1))
        let output = ''
        emulator.on('stdout', bytes => { output += new TextDecoder().decode(bytes) })
        emulator.initialize(0)
        await emulator.run(1_000_000)
        expect(output).toBe(words.map((word, i) => `argv[${i}]=${word}\n`).join('') + X86_PROGRAM_ENVIRONMENT.map((word, i) => `env[${i}]=${word}\n`).join(''))
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
    } finally { emulator.dispose() }
})

it('validates Arguments and clears stale assembly when loading an Executable', async () => {
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.compile('global _start\nsection .text\n_start: nop')).ok).toBe(true)
        expect(emulator.getCompiledCode().code).not.toBe('')
        await emulator.loadExecutable(elfFixture('crackme'))
        expect(emulator.getCompiledCode().code).toBe('')
        expect(emulator.getMemoryLayout().sections).toContain('.data')
        expect(emulator.resolveMemoryLabel('main')).toBeDefined()
        expect(() => emulator.setProgramArguments('a', ['bad\0word'])).toThrow(/NUL/)
        expect(() => emulator.setProgramArguments('a', Array(1025).fill(''))).toThrow(/1,024/)
        expect(() => emulator.setProgramArguments('a', ['a'.repeat(128 * 1024)])).toThrow(/128 KiB/)
        expect(() => emulator.setProtectedPath('/tmp/program')).toThrow(/project/)
    } finally { emulator.dispose() }
})

it('follows C++ dependencies and retains libraries after a fresh start', async () => {
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.loadExecutable(elfFixture('cpp'))).missing).toEqual([])
        let output = ''
        emulator.on('stdout', bytes => { output += new TextDecoder().decode(bytes) })
        emulator.initialize(0)
        for (let run = 0; run < 2; ++run) {
            if (run) emulator.runtime.pauseAtEntry()
            emulator.initialize(0)
            await emulator.run(2_000_000)
            expect(emulator.stopReason, `run ${run}, output ${output}`).toMatchObject({ kind: 'exit', exitCode: 0 })
        }
        expect(output).toBe('hello\nC++\ncaught exception\n'.repeat(2))
    } finally { emulator.dispose() }
})

it('reports a missing library and preserves the dynamic linker message', async () => {
    const bytes = elfFixture('crackme').slice()
    const name = new TextEncoder().encode('libc.so.6')
    const offset = bytes.findIndex((_, i) => name.every((byte, j) => bytes[i + j] === byte))
    expect(offset).toBeGreaterThan(0)
    bytes.set(new TextEncoder().encode('libx.so.6'), offset)
    const emulator = await createX86Emulator()
    try {
        expect((await emulator.loadExecutable(bytes)).missing).toEqual(['libx.so.6'])
        let stderr = ''
        emulator.on('stderr', bytes => { stderr += new TextDecoder().decode(bytes) })
        emulator.initialize(0)
        await emulator.run(1_000_000)
        expect(stderr).toContain('libx.so.6')
        expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 127 })
    } finally { emulator.dispose() }
})
