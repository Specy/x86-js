import { expect, it } from 'vitest'
import { elfFixture, fixtureEmulator } from './elf-fixtures'
import { readElfSymbolTable } from '../src/elf-symbols'
import { expectCore } from './linux-probe'

const PIE = 0x555555554000n
const MMAP_TOP = 0x7ffff7fff000n
const STACK_TOP = 0x7ffffffff000n

it('loads a PIE and interpreter at Linux addresses with the heap after the main program', async () => {
    const bytes = elfFixture('crackme')
    const elf = readElfSymbolTable(bytes)
    const emulator = await fixtureEmulator('crackme')
    try {
        emulator.getNextInstruction()
        expect(emulator.getPc()).toBeLessThan(MMAP_TOP)
        expect(emulator.getPc()).toBeGreaterThan(MMAP_TOP - 0x100000n)
        expect(emulator.getStackTop()).toBe(emulator.getSp())
        expect(emulator.getStackTop()).toBeGreaterThan(STACK_TOP - 4096n)
        expect([...emulator.readMemoryBytes(STACK_TOP - 1n, 1n)]).toEqual([0])
        expect(() => emulator.readMemoryBytes(STACK_TOP, 1n)).toThrow(/not mapped/)
        expect(emulator.getSp()).toBeLessThan(STACK_TOP)
        expect([...emulator.readMemoryBytes(PIE, 4n)]).toEqual([0x7f, 0x45, 0x4c, 0x46])
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let highest = 0n
        for (let i = 0; i < view.getUint16(56, true); ++i) {
            const header = Number(view.getBigUint64(32, true)) + i * view.getUint16(54, true)
            if (view.getUint32(header, true) === 1) {
                const end = view.getBigUint64(header + 16, true) + view.getBigUint64(header + 40, true)
                if (end > highest) highest = end
            }
        }
        expect(emulator.getHeapStart()).toBe(PIE + ((highest + 4095n) & ~4095n))
        const main = elf.symbols.find(symbol => symbol.name === 'main')!
        for (let slice = 0; slice < 10; ++slice) {
            emulator.runtime.runSlice(50_000, [PIE + main.value], false)
            if (emulator.stopReason?.kind !== 'limit') break
        }
        expect(emulator.getPc(), emulator.stopReason?.details).toBe(PIE + main.value)
        // The PIE's writable bytes are visible through guest page tables, including Poke Undo.
        const data = elf.sections.find(section => section.name === '.data')!
        const at = PIE + data.address
        const original = [...emulator.readMemoryBytes(at, 8n)]
        emulator.initialize(100)
        emulator.beginPoke()
        emulator.writeMemoryBytes(at, Uint8Array.of(0x91, 2, 3, 4, 5, 6, 7, 8))
        emulator.endPoke()
        expect(emulator.canUndo()).toBe(true)
        emulator.undo()
        expect([...emulator.readMemoryBytes(at, 8n)]).toEqual(original)
    } finally { emulator.dispose() }
})

it('allocates downwards, respects free hints and reuses the highest unmapped hole', async () => {
    await expectCore([
        'sys 9, 0, 4096, 3, 0x22, -1, 0', 'mov r12, rax', 'save',
        'sys 9, 0, 8192, 3, 0x22, -1, 0', 'save',
        'sys 11, r12, 4096', 'save',
        'sys 9, 0, 4096, 3, 0x22, -1, 0', 'save',
        'sys 9, 0x10000000, 4096, 3, 0x22, -1, 0', 'save',
        'sys 9, 0x10000000, 4096, 3, 0x22, -1, 0', 'save',
        'sys 9, 0, 0x10000000, 0, 0x22, -1, 0', 'save',
    ], [MMAP_TOP - 4096n, MMAP_TOP - 12288n, 0, MMAP_TOP - 4096n,
        0x10000000n, MMAP_TOP - 16384n, MMAP_TOP - 16384n - 0x10000000n])
})

it('reads and undoes memory inside the old host-shadow range', async () => {
    const emulator = await fixtureEmulator('hello-atexit-static')
    try {
        emulator.getNextInstruction()
        // A Go-style heap address is a normal guest address when explicitly mapped.
        const source = `global _start
section .text
_start:
 mov eax,9
 mov rdi,0xc000000000
 mov esi,4096
 mov edx,3
 mov r10d,0x32
 mov r8,-1
 xor r9d,r9d
 syscall
 mov rbx,rax
 mov byte [rbx],77
 mov eax,60
 xor edi,edi
 syscall`
        emulator.clearExecution()
        expect((await emulator.compile(source)).ok).toBe(true)
        emulator.initialize(100)
        await emulator.run(undefined, [12])
        expect(emulator.getRegisterValue('rbx')).toBe(0xc000000000n)
        await emulator.step()
        expect([...emulator.readMemoryBytes(0xc000000000n, 1n)]).toEqual([77])
        expect(emulator.canUndo()).toBe(true)
        emulator.undo()
        expect([...emulator.readMemoryBytes(0xc000000000n, 1n)]).toEqual([0])
    } finally { emulator.dispose() }
})
