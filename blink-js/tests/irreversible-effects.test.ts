import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { END_OF_INPUT } from '../src/types'
import { probeSource } from './linux-probe'

async function make(body: string[]) {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(probeSource([...body, 'nop', 'finish']))
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(500)
    return emulator
}
async function throughSyscall(emulator: Awaited<ReturnType<typeof make>>, count = 1) {
    for (let index = 0; index < 500; index++) {
        const isCall = emulator.getNextInstruction()?.code.toLowerCase().includes('syscall')
        await emulator.step()
        if (isCall && --count === 0) return
    }
    throw new Error('Probe did not reach the requested syscall')
}

describe('unjournaled effect boundaries', () => {
    it.each([
        ['brk growth', ['sys 12,0', 'mov r12,rax', 'add r12,4096', 'sys 12,r12'], 2],
        ['anonymous mmap', ['sys 9,0,4096,3,34,-1,0'], 1],
        ['mprotect', ['sys 9,0,4096,3,34,-1,0', 'mov r12,rax', 'sys 10,r12,4096,1'], 2],
        ['munmap', ['sys 9,0,4096,3,34,-1,0', 'mov r12,rax', 'sys 11,r12,4096'], 2],
        ['descriptor duplication', ['sys 32,1'], 1],
        ['descriptor close', ['sys 3,1'], 1],
        ['pipe creation', ['sys 22,buf'], 1],
        ['pipe write', ['sys 22,buf', 'mov edi,[buf+4]', 'sys 1,rdi,buf2,1'], 2],
        [
            'pipe read',
            [
                'sys 22,buf',
                'mov edi,[buf+4]',
                'sys 1,rdi,buf2,1',
                'mov edi,[buf]',
                'sys 0,rdi,buf2,1'
            ],
            3
        ],
        ['umask', ['sys 95,18'], 1],
        ['credentials', ['sys 105,0'], 1],
        ['prctl name', ['sys 157,15,buf'], 1],
        ['FS segment base', ['sys 158,0x1002,123'], 1],
        ['CPUID trapping', ['sys 158,0x1012,0'], 1],
        ['resource limit', ['mov qword [buf],128', 'mov qword [buf+8],256', 'sys 160,7,buf'], 1],
        [
            'prlimit partial EFAULT',
            ['mov qword [buf],128', 'mov qword [buf+8],256', 'sys 302,0,7,buf,1'],
            1
        ],
        ['thread clear-tid pointer', ['sys 218,buf'], 1],
        ['terminal flags', ['sys 16,0,0x5401,buf', 'sys 16,0,0x5402,buf'], 2]
    ] as const)(
        'retains %s as a barrier, with reversible CPU steps and Pokes above it',
        async (_name, body, count) => {
            const emulator = await make([...body])
            try {
                await throughSyscall(emulator, count)
                const result = BigInt.asIntN(64, emulator.getRegisterValue('rax'))
                if (_name === 'prlimit partial EFAULT') expect(result).toBe(-14n)
                else expect(result).toBeGreaterThanOrEqual(0n)
                const depth = emulator.getUndoDepth()
                expect(emulator.getUndoHistory(1)[0].undoable).toBe(false)
                expect(emulator.canUndo()).toBe(false)
                const pc = emulator.getPc()
                expect(() => emulator.undo()).toThrow('cannot be undone')
                expect(emulator.getPc()).toBe(pc)
                expect(emulator.getUndoDepth()).toBe(depth)
                await emulator.step()
                expect(emulator.canUndoSteps(1)).toBe(true)
                expect(emulator.canUndoSteps(2)).toBe(false)
                emulator.beginPoke()
                emulator.setRegisterValue('r15', 123n)
                emulator.endPoke()
                expect(emulator.canUndoSteps(2)).toBe(true)
                expect(emulator.canUndoSteps(3)).toBe(false)
                emulator.undo()
                expect(emulator.getRegisterValue('r15')).toBe(0n)
                emulator.undo()
                expect(emulator.getPc()).toBe(pc)
                expect(emulator.canUndo()).toBe(false)
            } finally {
                emulator.dispose()
            }
        }
    )

    it.each([
        ['brk query', ['sys 12,0']],
        ['getuid', ['sys 102']],
        ['prctl query', ['sys 157,3']],
        ['segment base query', ['sys 158,0x1003,buf']],
        ['resource query', ['sys 97,7,buf']],
        ['prlimit query', ['sys 302,0,7,0,buf']],
        ['terminal query', ['sys 16,0,0x541b,buf']],
        ['output write', ['sys 1,1,buf,1']],
        ['failed close', ['sys 3,99999']],
        ['failed mmap', ['sys 9,0,0,3,34,-1,0']],
        ['failed limit', ['mov qword [buf],256', 'mov qword [buf+8],128', 'sys 160,7,buf']],
        ['no-op dup2', ['sys 33,1,1']],
        ['zero read', ['sys 0,0,buf,0']],
        ['empty flush', ['sys 16,0,0x540b,0']]
    ] as const)('keeps %s reversible', async (_name, body) => {
        const emulator = await make([...body])
        try {
            await throughSyscall(emulator)
            expect(emulator.canUndo()).toBe(true)
            expect(emulator.canUndoSteps(1)).toBe(true)
            emulator.undo()
            expect(emulator.getNextInstruction()?.code.toLowerCase()).toContain('syscall')
        } finally {
            emulator.dispose()
        }
    })

    it.each(['bytes', 'EOF', 'flush bytes', 'flush EOF'] as const)(
        'marks actual %s consumption irreversible',
        async (kind) => {
            const flush = kind.startsWith('flush')
            const emulator = await make([flush ? 'sys 16,0,0x540b,0' : 'sys 0,0,buf,8'])
            try {
                emulator.provideInput(kind.endsWith('EOF') ? END_OF_INPUT : 'abc\n')
                await throughSyscall(emulator)
                expect(emulator.canUndo()).toBe(false)
                expect(emulator.getUndoHistory(1)[0].undoable).toBe(false)
                expect(() => emulator.undo()).toThrow('cannot be undone')
            } finally {
                emulator.dispose()
            }
        }
    )

    it('invalidates a decoded row when an event marks its unchanged packet header', async () => {
        const emulator = await make(['nop'])
        try {
            await emulator.step()
            const before = emulator.getUndoHistory(1)[0]
            expect(before.undoable).toBe(true)
            emulator.module._blinkenlib_history_mark_irreversible!()
            const after = emulator.getUndoHistory(1)[0]
            expect(after.serial).toBe(before.serial)
            expect(after.mutations).toEqual(before.mutations)
            expect(after.undoable).toBe(false)
            expect(emulator.canUndoSteps(1)).toBe(false)
            expect(emulator.canUndoSteps(0)).toBe(true)
            expect(() => emulator.canUndoSteps(-1)).toThrow('Invalid Undo step count')
        } finally {
            emulator.dispose()
        }
    })
})
