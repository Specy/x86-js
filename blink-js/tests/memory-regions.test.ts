import { expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'

it('exports section layout and library ownership, and restores the stack extent on Undo', async () => {
    const core = await createX86Emulator()
    try {
        const result = await core.compileProject({ entry: 'main.asm', files: { 'main.asm': `global main
extern libraryData
section .text
main:
 mov rsp,0x4fffffff0000
 push rax
 mov rax,[libraryData]
 ret
section .data
own: dq 7
section .bss
room: resb 16` }, startUnits: { '@runtime/start.asm': 'global _start\nextern main\nsection .text\n_start: jmp main' }, library: {
            '@runtime/data.asm': 'global libraryData\nsection .data\nlibraryData: dq 3\nlocalData: dq 4'
        } })
        expect(result.ok).toBe(true)
        core.initialize(100)
        core.getNextInstruction()
        const layout = core.getMemoryLayout()
        expect(layout.sections).toEqual(expect.arrayContaining(['.text', '.data', '.bss']))
        expect(layout.symbols.find(symbol => symbol.name === 'own')?.fromLibrary).toBe(false)
        expect(layout.symbols.find(symbol => symbol.name === 'libraryData')?.fromLibrary).toBe(true)
        expect(layout.symbols.find(symbol => symbol.name === 'localData')?.fromLibrary).toBe(true)
        const top = core.getStackTop()
        await core.step() // startup jump
        await core.step() // new stack
        expect(core.getStackTop()).toBe(0x4fffffff0000n)
        await core.step() // push
        expect(core.getStackTop()).toBe(0x4fffffff0000n)
        core.undo(); core.undo()
        expect(core.getStackTop()).toBe(top)
    } finally { core.dispose() }
}, 20000)

it('reads the current Linux heap break and exports translated compiler names', async () => {
    const core = await createX86Emulator()
    try {
        expect((await core.compile(`global _start
section .text
_start:
 mov eax,12
 xor edi,edi
 syscall
 lea rdi,[rax+4096]
 mov eax,12
 syscall
 mov eax,60
 xor edi,edi
 syscall
; compiler-symbol LC0 .LC0
section .data
LC0: db 'Hello',0`)).ok).toBe(true)
        core.initialize(100); core.getNextInstruction()
        const start = core.getHeapStart()
        expect(core.getMemoryLayout().symbols.find(symbol => symbol.name === '.LC0')).toBeDefined()
        for (let i=0;i<6;i++) await core.step()
        expect(core.getHeapBreak()).toBe(start+4096n)
    } finally { core.dispose() }
}, 20000)

it('preserves compiler names and source provenance inside an included Generated assembly file', async () => {
    const core = await createX86Emulator()
    try {
        const result = await core.compileProject({ entry: 'main.asm', files: {
            'main.asm': 'global _start\nsection .text\n_start: nop\n%include "generated.asm"\nsection .data\nhandwritten: db 1',
            'generated.asm': '; compiler-symbol LC0 .LC0\nsection .data\nLC0: db "Hello",0\n_ZN4Game5scoreE: dd 7'
        } })
        expect(result.ok).toBe(true)
        const symbols = core.getMemoryLayout().symbols
        expect(symbols.find(symbol => symbol.name === '.LC0')).toMatchObject({ file: 'generated.asm', fromLibrary: false })
        expect(symbols.find(symbol => symbol.name === '_ZN4Game5scoreE')).toMatchObject({ file: 'generated.asm' })
        expect(symbols.find(symbol => symbol.name === 'handwritten')).toMatchObject({ file: 'main.asm' })
    } finally { core.dispose() }
}, 20000)
