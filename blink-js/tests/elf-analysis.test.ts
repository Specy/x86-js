import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { analyze } from '../src/elf'
import { elfFixture } from './elf-fixtures'

it('recognises all committed program fixtures from their bytes', () => {
    for (const name of ['crackme', 'crackme-stripped', 'crackme-static', 'crackme-static-pie', 'hello-atexit', 'hello-atexit-static', 'hello-atexit-static-pie', 'math', 'cpp', 'argv-env', 'ptrace', 'self-write', 'crackme-argv', 'overflow', 'avx'])
        expect(analyze(elfFixture(name)), name).toMatchObject({ isElf: true, supported: true })
})

it('reads dynamic dependencies, symbols, relocations and PLT stubs after stripping', () => {
    const info = analyze(elfFixture('crackme-stripped'))
    expect(info).toMatchObject({ stripped: true, pie: true, interpreter: '/lib64/ld-linux-x86-64.so.2', needed: ['libc.so.6'] })
    expect(info.plt.some(stub => stub.name === 'strcmp@plt')).toBe(true)
    expect(info.relocations.some(slot => slot.symbol === '__libc_start_main' && slot.type === 6)).toBe(true)
    expect(analyze(elfFixture('crackme')).stripped).toBe(false)
    const libc = analyze(readFileSync(new URL('../src/assets/linux/libc.so.6', import.meta.url)))
    expect(libc.soname).toBe('libc.so.6')
    const libm = analyze(readFileSync(new URL('../src/assets/linux/libm.so.6', import.meta.url)))
    expect(libm).toMatchObject({ supported: false, reason: 'a shared library, not a program' })
    expect(libc.dynamicSymbols.some(symbol => symbol.name === 'strlen')).toBe(true)
})

it('explains unsupported and truncated files without throwing', () => {
    const bytes = elfFixture('crackme')
    expect(analyze(new Uint8Array()).isElf).toBe(false)
    const class32 = bytes.slice(); class32[4] = 1
    expect(analyze(class32).reason).toContain('32-bit x86')
    const arm = bytes.slice(); new DataView(arm.buffer).setUint16(18, 40, true)
    expect(analyze(arm).reason).toContain('ARM')
    const object = bytes.slice(); new DataView(object.buffer).setUint16(16, 1, true)
    expect(analyze(object).reason).toBe('an object file, not a program')
    for (let length = 4; length < bytes.length; length += 37) {
        expect(() => analyze(bytes.subarray(0, length))).not.toThrow()
        expect(analyze(bytes.subarray(0, length)).supported).toBe(false)
    }
})
