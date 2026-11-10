import { describe, expect, it, vi } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { EmulatorStatus } from '../src/interface'

// The call stack the wasm keeps for every instruction, whether or not the undo history records,
// and the run option that ends a Step over or a Step out: `untilCallDepth`.

const HEAD = ['bits 64', 'global _start', 'section .text', '_start:']

/** A program of these lines after `_start:`, and the 0-based index of a line by its text. */
function program(...lines: string[]) {
    const source = [...HEAD, ...lines].join('\n') + '\n'
    const all = source.split('\n')
    const line = (text: string) => {
        const index = all.findIndex((candidate) => candidate.trim() === text)
        if (index < 0) throw new Error(`No line reads ${text}`)
        return index
    }
    return { source, line }
}

async function build(
    source: string,
    undoSize: number,
    environment?: { now: () => number }
): Promise<X86Emulator> {
    const emulator = await createX86Emulator(environment ? { environment } : {})
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(undoSize)
    emulator.getNextInstruction()
    return emulator
}

const names = (emulator: X86Emulator) => emulator.getCallStack().map((frame) => frame.name)
const code = (emulator: X86Emulator) => emulator.getNextInstruction()?.code ?? ''
const quadword = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
/** What the handler's helper counted, in memory: rt_sigreturn puts the registers back. */
const count = (emulator: X86Emulator) =>
    quadword(emulator.readMemoryBytes(emulator.resolveMemoryLabel('count')!, 8n))

/** A Step over as the editor makes one: a step, and the routine it entered run to its return. */
async function stepOver(emulator: X86Emulator, breakpoints: number[] = []) {
    const depth = emulator.getCallDepth()
    const step = await emulator.step()
    if (step.terminated || emulator.getCallDepth() <= depth) return step
    return emulator.run(undefined, breakpoints, {
        untilCallDepth: depth,
        skipBreakpointAtPc: false
    })
}

/** rt_sigaction(signal, act, 0, 8), with `act` a handler, SA_RESTORER and `restorer`. */
const sigaction = (signal: number) => [
    'mov eax, 13',
    `mov edi, ${signal}`,
    'lea rsi, [rel act]',
    'xor edx, edx',
    'mov r10d, 8',
    'syscall'
]
/** The handler's return, the data `sigaction` names and a counter. */
const RESTORER = [
    'restorer:',
    'mov eax, 15',
    'syscall',
    'section .data',
    'act: dq handler, 0x04000000, restorer, 0',
    'count: dq 0',
    'section .text'
]

describe.each([0, 100])('with an undo size of %i', (undoSize) => {
    const undo = (emulator: X86Emulator, times = 1) => {
        if (undoSize) for (let i = 0; i < times; i++) emulator.undo()
    }

    it('has no frames before the program starts, and keeps a frame per level of recursion', async () => {
        const { source } = program(
            'mov edi, 3',
            'call fact',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'fact:',
            'cmp edi, 0',
            'je fact_done',
            'dec edi',
            'call fact',
            'fact_done:',
            'ret'
        )
        const emulator = await createX86Emulator()
        try {
            expect((await emulator.compile(source)).ok).toBe(true)
            emulator.initialize(undoSize)
            expect(emulator.getCallDepth()).toBe(0)
            expect(emulator.getCallStack()).toEqual([])
            // two to the first call, four a level: the fourth call, with edi 0
            expect(await emulator.run(14)).toBe(EmulatorStatus.Running)
            expect(emulator.getCallDepth()).toBe(4)
            expect(names(emulator)).toEqual(['fact', 'fact', 'fact', 'fact'])
            const deep = emulator.getCallStack()
            expect(deep.every((frame) => frame.kind === 'call')).toBe(true)
            // each frame's return address is in the routine below it, lower on the stack
            for (let i = 1; i < 4; i++) {
                expect(deep[i].destination).toBe(deep[1].destination)
                expect(deep[i].sp).toBe(deep[i - 1].sp - 8n)
            }
            // the newest frames alone, as they are in the whole stack
            expect(emulator.getCallStack(2)).toEqual(deep.slice(2))
            expect(emulator.getCallStack(0)).toEqual([])
            expect(emulator.getCallStack(10)).toEqual(deep)
            // cmp, je and two returns: not the first return to the same address
            expect(
                await emulator.run(undefined, [], { untilCallDepth: 2, skipBreakpointAtPc: false })
            ).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                executedInstructions: 4n
            })
            expect(emulator.getCallStack()).toEqual(deep.slice(0, 2))
            expect(code(emulator)).toContain('ret')
            if (undoSize) {
                undo(emulator, 4)
                expect(emulator.getCallStack()).toEqual(deep)
                undo(emulator, 14)
                expect(emulator.getCallDepth()).toBe(0)
            }
        } finally {
            emulator.dispose()
        }
    })

    it('steps over and out of nested calls', async () => {
        const { source, line } = program(
            'call outer',
            'mov ebx, eax',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'outer:',
            'call inner',
            'add eax, 1',
            'ret',
            'inner:',
            'mov eax, 41',
            'ret'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.step()
            await emulator.step()
            expect(names(emulator)).toEqual(['outer', 'inner'])
            const [outer, inner] = emulator.getCallStack()
            expect(emulator.getInstructionAt(inner.destination)?.lineNumber).toBe(
                line('add eax, 1')
            )
            expect(emulator.getInstructionAt(outer.destination)?.lineNumber).toBe(
                line('mov ebx, eax')
            )
            // Step out of inner, then of outer
            await emulator.run(undefined, [], { untilCallDepth: 1 })
            expect(emulator.stopReason?.kind).toBe('callDepth')
            expect(names(emulator)).toEqual(['outer'])
            expect(code(emulator)).toContain('add')
            await emulator.run(undefined, [], { untilCallDepth: 0 })
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov ebx, eax'),
                executedInstructions: 2n
            })
            expect(emulator.getRegisterValue('rax')).toBe(42n)
            expect(emulator.getCallDepth()).toBe(0)
            undo(emulator, 2)
            if (undoSize) expect(names(emulator)).toEqual(['outer'])
            undo(emulator, 2)
            if (undoSize) expect(emulator.getCallStack()).toEqual([outer, inner])
        } finally {
            emulator.dispose()
        }
    })

    it('keeps the frame through a tail call until the second routine returns', async () => {
        const { source, line } = program(
            'call first',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'first:',
            'mov ebx, 1',
            'jmp second',
            'second:',
            'mov ecx, 2',
            'ret'
        )
        const emulator = await build(source, undoSize)
        try {
            expect(await stepOver(emulator)).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov eax, 60'),
                executedInstructions: 4n
            })
            expect(emulator.getRegisterValue('rcx')).toBe(2n)
            undo(emulator)
            if (undoSize) expect(names(emulator)).toEqual(['first'])
        } finally {
            emulator.dispose()
        }
    })

    it('pushes no frame for push and ret used as a jump, and keeps the caller frame', async () => {
        const { source, line } = program(
            'lea rax, [rel there]',
            'push rax',
            'ret',
            'there:',
            'call routine',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'routine:',
            'lea rax, [rel back]',
            'push rax',
            'ret',
            'back:',
            'ret'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(3)
            expect(emulator.getCallDepth()).toBe(0)
            expect(code(emulator)).toContain('call')
            await emulator.step()
            await emulator.run(3)
            // the ret that went to `back` was not the routine's
            expect(names(emulator)).toEqual(['routine'])
            await emulator.run(undefined, [], { untilCallDepth: 0 })
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov eax, 60'),
                executedInstructions: 1n
            })
        } finally {
            emulator.dispose()
        }
    })

    it('ends a call to the next instruction at the pop that takes its return address', async () => {
        const { source, line } = program(
            'call next',
            'next:',
            'pop rbx',
            'mov eax, 60',
            'xor edi, edi',
            'syscall'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.step()
            expect(names(emulator)).toEqual(['next'])
            await emulator.run(undefined, [], { untilCallDepth: 0, skipBreakpointAtPc: false })
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov eax, 60'),
                executedInstructions: 1n
            })
            undo(emulator)
            if (undoSize) expect(names(emulator)).toEqual(['next'])
        } finally {
            emulator.dispose()
        }
    })

    it('drops the frame of a ret that also releases arguments', async () => {
        const { source, line } = program(
            'push 20',
            'push 22',
            'call add_two',
            'mov ebx, eax',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'add_two:',
            'mov rax, [rsp + 8]',
            'add rax, [rsp + 16]',
            'ret 16'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(2)
            const rsp = emulator.getRegisterValue('rsp')
            expect(await stepOver(emulator)).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov ebx, eax')
            })
            expect(emulator.getRegisterValue('rax')).toBe(42n)
            expect(emulator.getRegisterValue('rsp')).toBe(rsp + 16n)
            undo(emulator)
            if (undoSize) expect(names(emulator)).toEqual(['add_two'])
        } finally {
            emulator.dispose()
        }
    })

    it('drops every frame a longjmp passes, and stops the step out there', async () => {
        const { source } = program(
            'call outer',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'outer:',
            'mov rbx, rsp',
            'call middle',
            'landed:',
            'nop',
            'ret',
            'middle:',
            'push rbp',
            'call deepest',
            'deepest:',
            'sub rsp, 0x40',
            'mov rsp, rbx',
            'jmp landed'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(5)
            expect(names(emulator)).toEqual(['outer', 'middle', 'deepest'])
            const deep = emulator.getCallStack()
            // a Step out of `middle`, which never returns: over once rsp is back in `outer`
            await emulator.run(undefined, [], { untilCallDepth: 1 })
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                executedInstructions: 2n
            })
            expect(code(emulator)).toContain('jmp')
            expect(names(emulator)).toEqual(['outer'])
            undo(emulator, 2)
            if (undoSize) expect(emulator.getCallStack()).toEqual(deep)
        } finally {
            emulator.dispose()
        }
    })

    it('gives a delivered alarm a frame that lasts until rt_sigreturn, and says the step entered it', async () => {
        let now = 0
        const { source, line } = program(
            ...sigaction(14),
            'mov eax, 37',
            'mov edi, 1',
            'syscall', // alarm(1)
            'spin:',
            'inc rbx',
            'jmp spin',
            'handler:',
            'nop',
            'call helper',
            'ret',
            'helper:',
            'inc qword [rel count]',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize, { now: () => now })
        try {
            await emulator.run(10)
            expect(await emulator.step()).toEqual({ terminated: false })
            const interrupted = emulator.getPc()
            const rsp = emulator.getRegisterValue('rsp')
            const rbx = emulator.getRegisterValue('rbx')
            now = 2000
            // the alarm is delivered, and the handler's first instruction runs instead
            expect(await emulator.step()).toEqual({ terminated: false, handlerEntry: true })
            expect(emulator.getRegisterValue('rbx')).toBe(rbx)
            expect(code(emulator)).toContain('call')
            const [frame] = emulator.getCallStack()
            expect(emulator.getCallStack()).toEqual([frame])
            expect(frame).toMatchObject({ name: 'handler', kind: 'signal', destination: interrupted })
            expect(frame.sp).toBe(emulator.getRegisterValue('rsp'))
            expect(frame.sp).toBeLessThan(rsp - 128n)
            const restorer = quadword(emulator.readMemoryBytes(frame.sp, 8n))
            if (undoSize) {
                // the step that ran the handler's nop, after which nothing is undone: the
                // delivery cannot be
                undo(emulator)
                expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(
                    line('nop')
                )
                expect(emulator.getCallStack()).toEqual([frame])
                expect(emulator.canUndo()).toBe(false)
                expect(await emulator.step()).toEqual({ terminated: false })
            }
            // a call inside the handler
            await emulator.step()
            expect(emulator.getCallStack().map((each) => [each.name, each.kind])).toEqual([
                ['handler', 'signal'],
                ['helper', 'call']
            ])
            await emulator.step()
            await emulator.step()
            expect(emulator.getCallStack()).toEqual([frame])
            undo(emulator)
            if (undoSize) {
                expect(names(emulator)).toEqual(['handler', 'helper'])
                await emulator.step()
            }
            // the handler's ret goes to the restorer, and the frame stays
            await emulator.step()
            expect(emulator.getPc()).toBe(restorer)
            expect(emulator.getCallStack()).toEqual([frame])
            undo(emulator)
            if (undoSize) {
                expect(emulator.getCallStack()).toEqual([frame])
                await emulator.step()
            }
            await emulator.step()
            expect(emulator.getCallStack()).toEqual([frame])
            // rt_sigreturn ends it, which cannot be undone
            expect(await emulator.step()).toEqual({ terminated: false })
            expect(emulator.getCallDepth()).toBe(0)
            expect(emulator.getPc()).toBe(interrupted)
            expect(emulator.getRegisterValue('rsp')).toBe(rsp)
            expect(count(emulator)).toBe(1n)
            expect(emulator.canUndo()).toBe(false)
        } finally {
            emulator.dispose()
        }
    })

    it('steps over a line a handler is entered on: the handler, then the line', async () => {
        let now = 0
        const { source, line } = program(
            ...sigaction(14),
            'mov eax, 37',
            'mov edi, 1',
            'syscall',
            'spin:',
            'inc rbx',
            'jmp spin',
            'handler:',
            'call helper',
            'ret',
            'helper:',
            'inc qword [rel count]',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize, { now: () => now })
        try {
            await emulator.run(9)
            expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(line('inc rbx'))
            now = 2000
            const step = await emulator.step()
            expect(step).toEqual({ terminated: false, handlerEntry: true })
            // the handler runs to rt_sigreturn, through a breakpoint on the line it returns to
            expect(
                await emulator.run(undefined, [line('inc rbx')], {
                    untilCallDepth: 0,
                    skipBreakpointAtPc: false
                })
            ).toBe(EmulatorStatus.Running)
            // the step ran the handler's call: helper's two, the handler's ret and the restorer's
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('inc rbx'),
                executedInstructions: 5n
            })
            expect(count(emulator)).toBe(1n)
            expect(emulator.getRegisterValue('rbx')).toBe(0n)
        } finally {
            emulator.dispose()
        }
    })

    it('delivers a pending alarm before it tests the depth a run begins at', async () => {
        let now = 0
        const { source, line } = program(
            ...sigaction(14),
            'mov eax, 37',
            'mov edi, 1',
            'syscall',
            'spin:',
            'inc rbx',
            'jmp spin',
            'handler:',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize, { now: () => now })
        try {
            await emulator.run(9)
            now = 2000
            await emulator.run(undefined, [], { untilCallDepth: 0 })
            // ret, mov and the rt_sigreturn: back before the instruction it interrupted
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('inc rbx'),
                executedInstructions: 3n
            })
            expect(emulator.getRegisterValue('rbx')).toBe(0n)
        } finally {
            emulator.dispose()
        }
    })

    it('ends the run for a signal that ends the program, at a depth it would stop at', async () => {
        let now = 0
        const { source } = program('mov eax, 37', 'mov edi, 1', 'syscall', 'spin:', 'jmp spin')
        const emulator = await build(source, undoSize, { now: () => now })
        try {
            await emulator.run(4)
            now = 2000
            expect(await emulator.run(undefined, [], { untilCallDepth: 0 })).toBe(
                EmulatorStatus.Terminated
            )
            expect(emulator.stopReason).toMatchObject({ kind: 'signal', exitCode: 142 })
        } finally {
            emulator.dispose()
        }
    })

    it('leaves no frame of its own for a handled int3, only the handler’s', async () => {
        const { source, line } = program(
            ...sigaction(5),
            'int3',
            'mov ebx, 1',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'handler:',
            'nop',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(6)
            const rsp = emulator.getRegisterValue('rsp')
            // the int3 raised the signal itself: no handler entry before it
            expect(await emulator.step()).toEqual({ terminated: false })
            expect(emulator.getCallStack().map((frame) => [frame.name, frame.kind])).toEqual([
                ['handler', 'signal']
            ])
            const [frame] = emulator.getCallStack()
            expect(emulator.getInstructionAt(frame.destination)?.lineNumber).toBe(
                line('mov ebx, 1')
            )
            for (let i = 0; i < 3; i++) {
                await emulator.step()
                expect(emulator.getCallStack()).toEqual([frame])
            }
            await emulator.step()
            expect(emulator.getCallDepth()).toBe(0)
            expect(emulator.getRegisterValue('rsp')).toBe(rsp)
            expect(emulator.getInstructionAt(emulator.getPc())?.lineNumber).toBe(
                line('mov ebx, 1')
            )
        } finally {
            emulator.dispose()
        }
    })

    it('steps over a handled int3 to the line after it', async () => {
        const { source, line } = program(
            ...sigaction(5),
            'int3',
            'mov ebx, 1',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'handler:',
            'call helper',
            'ret',
            'helper:',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(6)
            expect(await stepOver(emulator)).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov ebx, 1')
            })
            expect(emulator.getCallDepth()).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('runs on into the handler of an int3 within the same run, from its first instruction too', async () => {
        const { source, line } = program(
            ...sigaction(5),
            'call trapping',
            'mov ebx, 1',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'trapping:',
            'int3',
            'ret',
            'handler:',
            'ret',
            ...RESTORER
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.run(6)
            await emulator.step()
            // the routine's first instruction traps: the run goes on to the handler and back
            expect(
                await emulator.run(undefined, [], { untilCallDepth: 0, skipBreakpointAtPc: false })
            ).toBe(EmulatorStatus.Running)
            // int3 is not counted, as no faulting instruction is: the handler's three and the ret
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov ebx, 1'),
                executedInstructions: 4n
            })
        } finally {
            emulator.dispose()
        }
        // and a run from the start goes over it to the end in one call
        const fresh = await build(source, undoSize)
        try {
            expect(await fresh.run(1000)).toBe(EmulatorStatus.Terminated)
            expect(fresh.stopReason).toMatchObject({ kind: 'exit', exitCode: 0 })
        } finally {
            fresh.dispose()
        }
    })

    describe('a run until a call depth', () => {
        const { source, line } = program(
            'call routine',
            'mov ebx, eax',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'routine:',
            'mov eax, 1',
            'add eax, 2',
            'ret'
        )

        it('stops for the depth on the last instruction of its limit, not for the limit', async () => {
            const emulator = await build(source, undoSize)
            try {
                await emulator.step()
                expect(await emulator.run(2, [], { untilCallDepth: 0 })).toBe(
                    EmulatorStatus.Running
                )
                expect(emulator.stopReason).toMatchObject({ kind: 'limit' })
                expect(await emulator.run(1, [], { untilCallDepth: 0 })).toBe(
                    EmulatorStatus.Running
                )
                expect(emulator.stopReason).toMatchObject({
                    kind: 'callDepth',
                    lineNumber: line('mov ebx, eax'),
                    executedInstructions: 1n
                })
            } finally {
                emulator.dispose()
            }
        })

        it('stops at once, having run nothing, when it begins at the depth', async () => {
            const emulator = await build(source, undoSize)
            try {
                await emulator.run(undefined, [], { untilCallDepth: 0 })
                expect(emulator.stopReason).toMatchObject({
                    kind: 'callDepth',
                    executedInstructions: 0n
                })
                expect(code(emulator)).toContain('call')
            } finally {
                emulator.dispose()
            }
        })

        it('stops for the depth on a breakpoint at the instruction it returns to', async () => {
            const emulator = await build(source, undoSize)
            try {
                expect(await stepOver(emulator, [line('mov ebx, eax')])).toBe(
                    EmulatorStatus.Running
                )
                expect(emulator.stopReason).toMatchObject({
                    kind: 'callDepth',
                    lineNumber: line('mov ebx, eax'),
                    executedInstructions: 3n
                })
            } finally {
                emulator.dispose()
            }
        })

        it('stops at a breakpoint inside the routine, its first instruction included', async () => {
            const emulator = await build(source, undoSize)
            try {
                expect(await stepOver(emulator, [line('mov eax, 1')])).toBe(EmulatorStatus.Running)
                expect(emulator.stopReason).toMatchObject({
                    kind: 'breakpoint',
                    lineNumber: line('mov eax, 1'),
                    executedInstructions: 0n
                })
                expect(
                    await emulator.run(undefined, [line('add eax, 2')], { untilCallDepth: 0 })
                ).toBe(EmulatorStatus.Running)
                expect(emulator.stopReason).toMatchObject({
                    kind: 'breakpoint',
                    lineNumber: line('add eax, 2')
                })
                expect(emulator.getCallDepth()).toBe(1)
                await emulator.run(undefined, [], { untilCallDepth: 0 })
                expect(emulator.stopReason?.kind).toBe('callDepth')
                expect(emulator.getRegisterValue('rax')).toBe(3n)
            } finally {
                emulator.dispose()
            }
        })

        it('refuses a depth that is not a non-negative integer', async () => {
            const emulator = await build(source, undoSize)
            try {
                for (const depth of [-1, 1.5, Number.NaN, Infinity])
                    await expect(emulator.run(10, [], { untilCallDepth: depth })).rejects.toThrow(
                        'Invalid call depth'
                    )
            } finally {
                emulator.dispose()
            }
        })
    })

    it('counts a routine longer than one native slice, given the depth in every slice', async () => {
        const { source, line } = program(
            'call routine',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'routine:',
            'mov ecx, 250000',
            'again:',
            'dec ecx',
            'jnz again',
            'ret'
        )
        const emulator = await build(source, undoSize)
        try {
            await emulator.step()
            const slices = vi.spyOn(emulator.runtime, 'runSlice')
            expect(await emulator.run(undefined, [], { untilCallDepth: 0 })).toBe(
                EmulatorStatus.Running
            )
            expect(slices).toHaveBeenCalledTimes(3)
            for (const call of slices.mock.calls) expect(call[3]).toBe(0)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov eax, 60'),
                executedInstructions: 500002n
            })
        } finally {
            vi.restoreAllMocks()
            emulator.dispose()
        }
    })

    it('goes on with the depth after the routine has waited for input', async () => {
        const { source, line } = program(
            'call reader',
            'mov ebx, eax',
            'mov eax, 60',
            'xor edi, edi',
            'syscall',
            'reader:',
            'xor eax, eax',
            'xor edi, edi',
            'lea rsi, [rel buffer]',
            'mov edx, 8',
            'syscall',
            'ret',
            'section .data',
            'buffer: dq 0'
        )
        const emulator = await build(source, undoSize)
        try {
            expect(await stepOver(emulator)).toBe(EmulatorStatus.WaitingForInput)
            expect(emulator.getCallDepth()).toBe(1)
            emulator.provideInput('ab\n')
            // the input finished the read alone
            expect(emulator.getCallDepth()).toBe(1)
            expect(code(emulator)).toContain('ret')
            expect(
                await emulator.run(undefined, [], { untilCallDepth: 0, skipBreakpointAtPc: false })
            ).toBe(EmulatorStatus.Running)
            expect(emulator.stopReason).toMatchObject({
                kind: 'callDepth',
                lineNumber: line('mov ebx, eax'),
                executedInstructions: 1n
            })
            expect(emulator.getRegisterValue('rax')).toBe(3n)
        } finally {
            emulator.dispose()
        }
    })

    it('ends with the program when the routine exits it', async () => {
        const { source } = program(
            'call quits',
            'nop',
            'quits:',
            'mov eax, 60',
            'mov edi, 7',
            'syscall'
        )
        const emulator = await build(source, undoSize)
        try {
            expect(await stepOver(emulator)).toBe(EmulatorStatus.Terminated)
            expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 7 })
            // the frame the program ended in is still there to be shown
            expect(names(emulator)).toEqual(['quits'])
        } finally {
            emulator.dispose()
        }
    })
})
