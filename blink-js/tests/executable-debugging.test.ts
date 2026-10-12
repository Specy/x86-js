import { expect, it } from 'vitest'
import { analyze, disassemble } from '../src/disassembler'
import { createX86Emulator } from '../src/x86-emulator'
import { elfFixture, fixtureEmulator } from './elf-fixtures'

it('stops at an address before strcmp, exposes its operands and names every loaded object', async () => {
    const bytes = elfFixture('crackme')
    const info = analyze(bytes)
    const text = info.sections.find((section) => section.name === '.text')!
    const strcmp = info.plt.find((stub) => stub.name === 'strcmp@plt')!
    const call = disassemble(
        bytes.subarray(text.offset, text.offset + text.size),
        text.address
    ).find(
        (instruction) =>
            instruction.isCall &&
            instruction.operands.some((operand) => operand.branchTarget === strcmp.address)
    )!
    const emulator = await fixtureEmulator('crackme')
    try {
        emulator.provideInput('wrong\n')
        await emulator.run(1_000_000, [{ address: 0x555555554000n + call.address }])
        expect(emulator.stopReason?.kind).toBe('breakpoint')
        expect(
            new TextDecoder().decode(emulator.readMemoryBytes(emulator.getRegisterValue('rsi'), 8n))
        ).toBe('hunter2\0')
        expect(
            new TextDecoder().decode(emulator.readMemoryBytes(emulator.getRegisterValue('rdi'), 6n))
        ).toBe('wrong\0')
        const objects = emulator.getLoadedObjects()
        expect(objects.find((object) => object.path === '/program')?.base).toBe(0x555555554000n)
        const libc = objects.find((object) => object.soname === 'libc.so.6')!
        const linker = objects.find((object) => object.path === '/lib64/ld-linux-x86-64.so.2')!
        expect(libc.end).toBeLessThanOrEqual(linker.base)
        expect(linker.end).toBeLessThanOrEqual(0x7ffff7fff000n)
        expect(emulator.getLoadedObjectBytes(libc.path)).toBeInstanceOf(Uint8Array)
        expect(emulator.getInstructionAt(emulator.getPc())?.code).toContain('call')
    } finally {
        emulator.dispose()
    }
})

it('uses Zydis for instruction queries even when Blink cannot execute the instruction', async () => {
    const bytes = elfFixture('avx')
    const info = analyze(bytes)
    const section = info.sections.find((section) => section.name === '.text')!
    const code = disassemble(
        bytes.subarray(section.offset, section.offset + section.size),
        section.address
    )
    const avx = code.find((instruction) => instruction.mnemonic.startsWith('v'))!
    const cet = code.find((instruction) => instruction.mnemonic === 'endbr64')!
    const emulator = await fixtureEmulator('avx')
    try {
        emulator.getNextInstruction()
        expect(emulator.getInstructionAt(0x555555554000n + avx.address)?.code).toBe(avx.text)
        expect(emulator.getInstructionAt(0x555555554000n + cet.address)?.code).toBe('endbr64')
    } finally {
        emulator.dispose()
    }
})

it('emits a named unimplemented syscall each time while leaving ENOSYS in rax', async () => {
    const emulator = await createX86Emulator()
    try {
        const events: { number: number; name: string }[] = []
        emulator.on('unimplementedSyscall', (event) => {
            events.push(event)
        })
        const source =
            'global _start\nsection .text\n_start:\nmov eax,309\nsyscall\nmov r12,rax\nmov eax,309\nsyscall\nmov r13,rax\nmov eax,60\nxor edi,edi\nsyscall'
        expect((await emulator.compile(source)).ok).toBe(true)
        emulator.initialize(0)
        await emulator.run()
        expect(events).toEqual([
            { number: 309, name: 'getcpu' },
            { number: 309, name: 'getcpu' }
        ])
        expect(emulator.getRegisterValue('r12')).toBe(0xffffffffffffffdan)
        expect(emulator.getRegisterValue('r13')).toBe(0xffffffffffffffdan)
    } finally {
        emulator.dispose()
    }
})
