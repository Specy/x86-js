import { describe, expect, it } from 'vitest'
import { RegisterSize, type MutationOperation } from '../src/interface'
import {
    createX86Emulator as createDefaultX86Emulator,
    type X86Emulator,
    type X86EmulatorOptions,
} from '../src/x86-emulator'
import type { BlinkenlibModule, NativeMemoryWrite } from '../src/wasm-types'
import { isRecordableWrite } from '../src/x86-emulator-utils'
import { isShadowAddress } from '../src/blink-runtime'

const createX86Emulator = (options: X86EmulatorOptions = {}) =>
    createDefaultX86Emulator({ ...options, mode: 'GNU_trunk' })

async function startedEmulator(source: string, undoSize = 32, steps = 0): Promise<X86Emulator> {
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok).toBe(true)
    emulator.initialize(undoSize)
    for (let step = 0; step < steps; step += 1) await emulator.step()
    return emulator
}

/** The newest entry's WriteRegister mutations, by register name. */
function registerWrites(
    emulator: X86Emulator,
    back = 0,
): Map<string, { old: bigint; new: bigint; size: RegisterSize }> {
    const mutations = emulator.getUndoHistory(back + 1)[back]?.mutations ?? []
    const writes = new Map<string, { old: bigint; new: bigint; size: RegisterSize }>()
    for (const mutation of mutations) {
        if (mutation.type === 'WriteRegister') writes.set(mutation.value.register, mutation.value)
    }
    return writes
}

/** The newest entry's memory writes, in the order the step made them. */
function memoryWrites(emulator: X86Emulator, back = 0) {
    const mutations = emulator.getUndoHistory(back + 1)[back]?.mutations ?? []
    return mutations.flatMap((mutation) =>
        mutation.type === 'WriteMemoryBytes' ? [mutation.value] : [],
    )
}

/** The IEEE-754 binary64 bit pattern of a double, which is what an st mutation carries. */
function doubleBits(value: number): bigint {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value, true)
    return view.getBigUint64(0, true)
}

/**
 * Counts every look the recorder takes at the machine, so the cost of a step
 * can be pinned: the byte-by-byte memory bridge, the page lookup the recorder
 * reads through instead, the register snapshot and the FPU block.
 */
function countBridgeCalls(emulator: X86Emulator) {
    const module = emulator.module as BlinkenlibModule & Record<string, unknown>
    const counts = { memoryReads: 0, registerSnapshots: 0, fpuReads: 0 }
    const read = module.blinkenlibReadMemoryBytes.bind(module)
    const snapshot = module.blinkenlibGetRegisterSnapshot.bind(module)
    const fpu = module.blinkenlibGetFpuState.bind(module)
    const spy = module._blinkenlib_spy_address?.bind(module)

    module._blinkenlib_spy_address = spy
        ? (address: bigint) => {
              counts.memoryReads += 1
              return spy(address)
          }
        : undefined
    module.blinkenlibReadMemoryBytes = (address: bigint, length: number) => {
        counts.memoryReads += 1
        return read(address, length)
    }
    module.blinkenlibGetRegisterSnapshot = () => {
        counts.registerSnapshots += 1
        return snapshot()
    }
    module.blinkenlibGetFpuState = () => {
        counts.fpuReads += 1
        return fpu()
    }

    return {
        counts,
        reset() {
            counts.memoryReads = 0
            counts.registerSnapshots = 0
            counts.fpuReads = 0
        },
        restore() {
            module.blinkenlibReadMemoryBytes = read
            module.blinkenlibGetRegisterSnapshot = snapshot
            module.blinkenlibGetFpuState = fpu
            module._blinkenlib_spy_address = spy
        },
    }
}

const SIZED_WRITES = `
.global _start
.data
buffer: .quad 0x1122334455667788
.text
_start:
  lea buffer(%rip), %rbx
  movabs $0x1122334455667788, %rax
  mov $0xff, %al
  movw $0xbeef, (%rbx)
  push %rax
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`

// Point 1: a register write reports the whole register on both sides, a memory
// write reports the bytes it replaced and the bytes it left at its own width.
describe('every write reports the value it wrote', () => {
    it('reports the whole register before and after a sized store', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 2)

        // movabs wrote the whole register.
        const wholeWrite = registerWrites(emulator).get('rax')
        expect(wholeWrite).toEqual({
            register: 'rax',
            old: 0n,
            new: 0x1122334455667788n,
            size: RegisterSize.Double,
        })

        // mov $0xff, %al writes ONE byte, and the entry still reports the whole
        // register on both sides, the way `old` already did.
        await emulator.step()
        const byteWrite = registerWrites(emulator).get('rax')
        expect(byteWrite).toEqual({
            register: 'rax',
            old: 0x1122334455667788n,
            new: 0x11223344556677ffn,
            size: RegisterSize.Double,
        })
        expect(emulator.getRegisterValue('rax')).toBe(byteWrite!.new)

        emulator.dispose()
    })

    it('reports the bytes a memory write replaced and the bytes it left, at its width', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 3)
        const buffer = emulator.getRegisterValue('rbx')
        expect([...emulator.readMemoryBytes(buffer, 8n)]).toEqual([
            0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        ])

        // A two-byte store reports two bytes: the width of the write, not of the register.
        await emulator.step()
        expect(memoryWrites(emulator)).toEqual([
            { address: buffer, old: [0x88, 0x77], new: [0xef, 0xbe] },
        ])
        expect([...emulator.readMemoryBytes(buffer, 2n)]).toEqual([0xef, 0xbe])

        // An eight-byte push reports eight.
        await emulator.step()
        const pushed = memoryWrites(emulator)
        expect(pushed).toHaveLength(1)
        expect(pushed[0]!.address).toBe(emulator.getSp())
        expect(pushed[0]!.new).toEqual([0xff, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
        expect(pushed[0]!.old).toHaveLength(8)
        expect([...emulator.readMemoryBytes(emulator.getSp(), 8n)]).toEqual(pushed[0]!.new)

        emulator.undo()
        expect([...emulator.readMemoryBytes(buffer, 2n)]).toEqual([0xef, 0xbe])
        emulator.undo()
        expect([...emulator.readMemoryBytes(buffer, 2n)]).toEqual([0x88, 0x77])
        emulator.dispose()
    })

    it('reports both sides of an FPU write, SSE and x87 alike', async () => {
        const emulator = await startedEmulator(
            `
.global _start
.text
_start:
  movabs $0x4010000000000000, %rax
  movq %rax, %xmm0
  addsd %xmm0, %xmm0
  fld1
  fld1
  faddp
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`,
            32,
            2,
        )

        // movq %rax, %xmm0 puts 4.0 in lane 0 and zeroes the rest.
        expect(registerWrites(emulator).get('xmm0')).toEqual({
            register: 'xmm0',
            old: 0n,
            new: 0x4010000000000000n,
            size: RegisterSize.Quad,
        })

        // addsd doubles it to 8.0.
        await emulator.step()
        expect(registerWrites(emulator).get('xmm0')).toEqual({
            register: 'xmm0',
            old: 0x4010000000000000n,
            new: 0x4020000000000000n,
            size: RegisterSize.Quad,
        })
        expect(emulator.getFpuState().xmm[0]).toBe(0x4020000000000000n)

        await emulator.step()
        await emulator.step()
        const statusBeforeAdd = emulator.getFpuState().fstat

        // faddp leaves 2.0 on top and pops, which moves TOP in the status word.
        await emulator.step()
        const x87 = registerWrites(emulator)
        expect(x87.get('st0')).toEqual({
            register: 'st0',
            old: doubleBits(1),
            new: doubleBits(2),
            size: RegisterSize.Double,
        })
        expect(x87.get('fstat')?.old).toBe(BigInt(statusBeforeAdd))
        expect(x87.get('fstat')?.new).toBe(BigInt(emulator.getFpuState().fstat))
        expect(emulator.getFpuState().st[0]).toBe(2)
        emulator.dispose()
    })

    it('records no program counter restore, and reports both sides when rip is poked', async () => {
        const emulator = await startedEmulator(
            `
.global _start
.text
_start:
  call target
  mov $60, %rax
  xor %rdi, %rdi
  syscall
target:
  mov $3, %rax
  ret
`,
            32,
            1,
        )

        // x86 reports control flow as the entry's own pc and a call-stack
        // mutation; there is no pc-restore write to carry a new value on, and
        // no instruction entry ever names rip as a register write.
        const callEntry = emulator.getUndoHistory(1)[0]!
        expect(callEntry.mutations.some((mutation) => mutation.type === 'PushCallStack')).toBe(true)
        expect(registerWrites(emulator).has('rip')).toBe(false)

        // The one place a program counter change IS a write is a Poke of rip,
        // and that reports the address it put there next to the one it replaced.
        const pcBefore = emulator.getPc()
        const target = emulator.getCompiledInstructions().find((instruction) => instruction.address !== pcBefore)!
        emulator.beginPoke()
        emulator.setRegisterValue('rip', target.address)
        expect(emulator.endPoke()).toBe(true)

        expect(registerWrites(emulator).get('rip')).toEqual({
            register: 'rip',
            old: pcBefore,
            new: target.address,
            size: RegisterSize.Double,
        })

        emulator.undo()
        expect(emulator.getPc()).toBe(pcBefore)
        emulator.dispose()
    })
})

const STORE_TO_DATA = `
.global _start
.data
buffer: .byte 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08
.text
_start:
  lea buffer(%rip), %rbx
  movq $0x8877665544332211, %rax
  mov %rax, (%rbx)
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`

const FRESH_PAGE_WRITE = `
.global _start
.bss
.lcomm area, 8192
.text
_start:
  lea area(%rip), %rbx
  movabs $0x1122334455667788, %rax
  mov %rax, (%rbx)
  mov %rax, (%rbx)
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`

// Point 1, at the edge: what the machine's own journal can and cannot say
// about a write. `old` is the machine's capture, so a write it could not
// capture keeps the valueless shape it always had; `new` is read back, so it
// is there whenever the addresses can still be read.
describe('a write the machine could not capture keeps its old shape', () => {
    it('reports neither value for a store into a page the machine has not touched yet', async () => {
        // .bss is faulted in on demand, so the FIRST store to a page finds no
        // page to copy the replaced bytes out of: the native record comes back
        // truncated and the entry keeps its `Other` shape, with neither the
        // bytes it replaced nor the bytes it left.
        const emulator = await startedEmulator(FRESH_PAGE_WRITE, 32, 2)
        const buffer = emulator.getRegisterValue('rbx')

        await emulator.step()
        const truncated = emulator.getUndoHistory(1)[0]!
        expect(truncated.mutations).toContainEqual({
            type: 'Other',
            value: `Wrote 8 bytes to 0x${buffer.toString(16)}`,
        })
        expect(truncated.mutations.some((mutation) => mutation.type === 'WriteMemoryBytes')).toBe(false)
        // A step whose writes the machine could not capture stays out of undo,
        // exactly as before this change.
        expect(emulator.canUndo()).toBe(false)

        // The very same instruction over the now-resident page reports both
        // sides in full.
        await emulator.step()
        expect(memoryWrites(emulator)).toEqual([
            {
                address: buffer,
                old: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
                new: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
            },
        ])
        expect(emulator.canUndo()).toBe(true)

        emulator.dispose()
    })

    it('reports neither value for a store the journal could only capture in part', async () => {
        // `rep stosb` over more than the journal's 64 KiB of replaced bytes is
        // one record the machine marks truncated.
        const emulator = await startedEmulator(
            `
.global _start
.bss
.lcomm area, 200000
.text
_start:
  lea area(%rip), %rdi
  mov $100000, %rcx
  mov $0xab, %al
  rep stosb
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`,
            32,
            3,
        )
        const area = emulator.getRegisterValue('rdi')

        await emulator.step()
        const entry = emulator.getUndoHistory(1)[0]!
        expect(entry.mutations).toContainEqual({
            type: 'Other',
            value: `Wrote 100000 bytes to 0x${area.toString(16)}`,
        })
        expect(entry.mutations.some((mutation) => mutation.type === 'WriteMemoryBytes')).toBe(false)
        expect(emulator.canUndo()).toBe(false)
        emulator.dispose()
    })

    it('reports no new bytes when the machine refuses to read the range back', async () => {
        // A step can unmap what it wrote. Both ways of reading the machine are
        // refused here, and recording still finishes with the bytes it does
        // have rather than throwing or guessing.
        const emulator = await startedEmulator(STORE_TO_DATA, 32, 2)
        const buffer = emulator.getRegisterValue('rbx')
        const module = emulator.module as BlinkenlibModule & Record<string, unknown>
        const read = module.blinkenlibReadMemoryBytes.bind(module)
        const spy = module._blinkenlib_spy_address?.bind(module)

        try {
            module.blinkenlibReadMemoryBytes = () => ({ ok: false, error: 'unmapped', readBytes: 0 })
            module._blinkenlib_spy_address = () => 0
            await emulator.step()
            expect(memoryWrites(emulator)).toEqual([
                { address: buffer, old: [1, 2, 3, 4, 5, 6, 7, 8], new: [] },
            ])
        } finally {
            module.blinkenlibReadMemoryBytes = read
            module._blinkenlib_spy_address = spy
            emulator.dispose()
        }
    })

    it('knows a write it can report in full from one it cannot', () => {
        const write = (address: bigint, size: number): NativeMemoryWrite => ({
            address,
            size,
            old: Array.from({ length: size }, () => 0),
            truncated: false,
        })

        expect(isRecordableWrite(write(0x10n, 4))).toBe(true)
        expect(isRecordableWrite({ ...write(0x10n, 4), truncated: true })).toBe(false)
        expect(isRecordableWrite({ address: 0x10n, size: 4, old: [1, 2], truncated: false })).toBe(false)
    })
})

// The fast read path the recorder uses has to answer exactly what the bridge
// answers, or a history entry would report bytes the machine does not hold.
describe('the page lookup the recorder reads through', () => {
    it('agrees with the byte-by-byte bridge, and declines what the bridge refuses', async () => {
        const emulator = await startedEmulator(STORE_TO_DATA, 32, 3)
        const buffer = emulator.getRegisterValue('rbx')

        for (const length of [1, 3, 8, 64]) {
            const spied = emulator.runtime.spyMemoryBytes(buffer, length)
            expect(spied).not.toBeNull()
            expect([...spied!]).toEqual([...emulator.readMemoryBytes(buffer, BigInt(length))])
        }

        // A run that leaves the page is looked up page by page: the bytes
        // inside the mapped page still match the bridge, and a run reaching
        // into an unmapped page is declined whole, which sends the recorder to
        // the bridge and, when that refuses too, to no new bytes at all.
        const pageEnd = (buffer | 4095n) - 3n
        const straddling = emulator.runtime.spyMemoryBytes(pageEnd, 8)
        if (straddling) {
            expect([...straddling]).toEqual([...emulator.readMemoryBytes(pageEnd, 8n)])
        } else {
            expect(() => emulator.readMemoryBytes(pageEnd, 8n)).toThrow()
        }

        expect(emulator.runtime.spyMemoryBytes(0x7ffff0000000n, 8)).toBeNull()
        // The shadow range the bridge refuses is refused here too.
        expect(isShadowAddress(0x7fff8000n)).toBe(true)
        expect(emulator.runtime.spyMemoryBytes(0x7fff8000n, 1)).toBeNull()
        expect(isShadowAddress(buffer)).toBe(false)
        emulator.dispose()
    })

    it('falls back to the bridge when the build has no page lookup to offer', async () => {
        const emulator = await startedEmulator(STORE_TO_DATA, 32, 2)
        const buffer = emulator.getRegisterValue('rbx')
        const module = emulator.module as BlinkenlibModule & Record<string, unknown>
        const spy = module._blinkenlib_spy_address?.bind(module)

        try {
            module._blinkenlib_spy_address = undefined
            expect(emulator.runtime.spyMemoryBytes(buffer, 8)).toBeNull()
            await emulator.step()
            expect(memoryWrites(emulator)).toEqual([
                {
                    address: buffer,
                    old: [1, 2, 3, 4, 5, 6, 7, 8],
                    new: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
                },
            ])
        } finally {
            module._blinkenlib_spy_address = spy
            emulator.dispose()
        }
    })
})

// Point 2: the values cross to JavaScript without loss. blink-js is a 64-bit
// Core and already hands 64-bit values to the host as bigints, in Poke writes
// and everywhere else; memory stays byte arrays.
describe('write values cross to JavaScript without loss', () => {
    it('carries a full 64-bit register and a full 128-bit SSE register as bigints', async () => {
        const emulator = await startedEmulator(
            `
.global _start
.text
_start:
  movabs $0xffffffffffffffff, %rax
  movabs $0xfedcba9876543210, %rcx
  movq %rcx, %xmm1
  punpcklqdq %xmm1, %xmm1
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`,
            32,
            1,
        )

        const allOnes = registerWrites(emulator).get('rax')!
        expect(typeof allOnes.new).toBe('bigint')
        // Unsigned and whole: not truncated to 32 bits, not read back as -1.
        expect(allOnes.new).toBe(0xffffffffffffffffn)
        expect(allOnes.new).toBe(emulator.getRegisterValue('rax'))

        await emulator.step()
        expect(registerWrites(emulator).get('rcx')!.new).toBe(0xfedcba9876543210n)

        await emulator.step()
        await emulator.step()
        const wide = registerWrites(emulator).get('xmm1')!
        expect(wide.size).toBe(RegisterSize.Quad)
        expect(wide.new).toBe(0xfedcba9876543210fedcba9876543210n)
        expect(wide.new).toBe(emulator.getFpuState().xmm[1])
        emulator.dispose()
    })

    it('carries memory as plain byte numbers on both sides', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 4)
        const write = memoryWrites(emulator)[0]!

        for (const byte of [...write.old, ...write.new]) {
            expect(Number.isInteger(byte)).toBe(true)
            expect(byte).toBeGreaterThanOrEqual(0)
            expect(byte).toBeLessThanOrEqual(255)
        }
        expect(write.new).toEqual([...emulator.readMemoryBytes(write.address, BigInt(write.new.length))])
        emulator.dispose()
    })
})

// Point 3: the shape is additive - the old fields keep their names and their
// meanings, `new` is on every write entry of the history read API, and Poke
// entries' own `writes`, which already carried both values, are untouched.
describe('the history shape stays additive', () => {
    it('puts new on every write mutation of every entry, instruction and poke alike', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 5)

        const rdxBefore = emulator.getRegisterValue('rdx')
        emulator.beginPoke()
        emulator.setRegisterValue('rdx', 0x99n)
        emulator.writeMemoryBytes(emulator.getSp(), Uint8Array.from([1, 2, 3, 4]))
        const state = emulator.getFpuState()
        state.xmm[4] = (1n << 127n) | 5n
        emulator.setFpuState(state)
        expect(emulator.endPoke()).toBe(true)

        const history = emulator.getUndoHistory(32)
        expect(history.length).toBeGreaterThan(5)

        let registerWriteCount = 0
        let memoryWriteCount = 0
        for (const entry of history) {
            for (const mutation of entry.mutations as MutationOperation[]) {
                if (mutation.type === 'WriteRegister') {
                    registerWriteCount += 1
                    expect(typeof mutation.value.old).toBe('bigint')
                    expect(typeof mutation.value.new).toBe('bigint')
                    expect(typeof mutation.value.register).toBe('string')
                    expect(typeof mutation.value.size).toBe('number')
                } else if (mutation.type === 'WriteMemory') {
                    memoryWriteCount += 1
                    expect(typeof mutation.value.old).toBe('bigint')
                    expect(typeof mutation.value.new).toBe('bigint')
                } else if (mutation.type === 'WriteMemoryBytes') {
                    memoryWriteCount += 1
                    expect(Array.isArray(mutation.value.old)).toBe(true)
                    expect(Array.isArray(mutation.value.new)).toBe(true)
                    expect(mutation.value.new).toHaveLength(mutation.value.old.length)
                }
            }
        }
        expect(registerWriteCount).toBeGreaterThan(0)
        expect(memoryWriteCount).toBeGreaterThan(0)

        // The poke's own writes are what they always were: type, name or
        // address, old and new, and nothing else.
        const poke = history[0]!
        expect(poke.kind).toBe('poke')
        const pokedRegister = poke.writes!.find(
            (write) => write.type === 'register' && write.name === 'rdx',
        )
        expect(pokedRegister).toEqual({ type: 'register', name: 'rdx', old: rdxBefore, new: 0x99n })
        const pokedMemory = poke.writes!.find((write) => write.type === 'memory')!
        expect(Object.keys(pokedMemory).sort()).toEqual(['address', 'new', 'old', 'type'])

        // And the poke's mutations gained the field the same way an instruction's did.
        const pokedFpu = poke.mutations.find(
            (mutation) => mutation.type === 'WriteRegister' && mutation.value.register === 'xmm4',
        )
        expect(pokedFpu && pokedFpu.type === 'WriteRegister' && pokedFpu.value.new).toBe(
            (1n << 127n) | 5n,
        )
        emulator.dispose()
    })

    it('keeps old meaning what it meant, and reversible and truncation untouched', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 2)

        const first = registerWrites(emulator).get('rax')!
        await emulator.step()
        const second = registerWrites(emulator).get('rax')!

        // The value one write left is the value the next write replaces.
        expect(second.old).toBe(first.new)
        expect(emulator.canUndo()).toBe(true)

        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(first.new)
        emulator.undo()
        expect(emulator.getRegisterValue('rax')).toBe(first.old)
        emulator.dispose()
    })
})

// Point 4: what recording both sides costs. Registers and the FPU cost
// nothing at all - both sides come from the two snapshots the step was already
// taking. Memory costs one page lookup per store, because the machine's
// journal has no post-image to read and the bytes a store left can only come
// from the addresses themselves; a step that writes no memory pays nothing,
// and a run with tracing off never records and never looks.
describe('recording both sides costs one page lookup per store and nothing else', () => {
    it('looks at memory once per memory write and never for a register-only step', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 32, 3)
        const probe = countBridgeCalls(emulator)

        try {
            // movw $0xbeef, (%rbx): one store, one lookup.
            probe.reset()
            await emulator.step()
            expect(probe.counts.memoryReads).toBe(1)
            expect(probe.counts.registerSnapshots).toBe(2)
            expect(probe.counts.fpuReads).toBe(2)

            // push %rax: one store, one lookup.
            probe.reset()
            await emulator.step()
            expect(probe.counts.memoryReads).toBe(1)

            // mov $60, %rax: no memory write, so memory is never touched, and
            // the register values still come from the two snapshots the step
            // was already taking.
            probe.reset()
            await emulator.step()
            expect(probe.counts.memoryReads).toBe(0)
            expect(probe.counts.registerSnapshots).toBe(2)
            expect(probe.counts.fpuReads).toBe(2)
        } finally {
            probe.restore()
            emulator.dispose()
        }
    })

    it('never looks at memory on a run with tracing off', async () => {
        const emulator = await startedEmulator(SIZED_WRITES, 0, 3)
        const probe = countBridgeCalls(emulator)

        try {
            probe.reset()
            // The same three instructions that cost a lookup, a snapshot and
            // an FPU read apiece above: with no history to record into, the
            // step touches none of them.
            await emulator.step()
            await emulator.step()
            await emulator.step()
            expect(emulator.getUndoHistory(4)).toEqual([])
            expect(probe.counts).toEqual({ memoryReads: 0, registerSnapshots: 0, fpuReads: 0 })
        } finally {
            probe.restore()
            emulator.dispose()
        }
    })

    it('captures what each step left, and never reconstructs it from a later state', async () => {
        const emulator = await startedEmulator(
            `
.global _start
.data
buffer: .byte 0x01
.text
_start:
  lea buffer(%rip), %rbx
  movb $0xaa, (%rbx)
  movb $0xbb, (%rbx)
  mov $60, %rax
  xor %rdi, %rdi
  syscall
`,
            32,
            2,
        )

        expect(memoryWrites(emulator)).toEqual([
            { address: emulator.getRegisterValue('rbx'), old: [0x01], new: [0xaa] },
        ])

        await emulator.step()
        const buffer = emulator.getRegisterValue('rbx')
        expect(memoryWrites(emulator)).toEqual([{ address: buffer, old: [0xaa], new: [0xbb] }])
        // The older entry still says what ITS step left, though memory has
        // moved on since: the value was taken at the write, not read now.
        expect(memoryWrites(emulator, 1)).toEqual([{ address: buffer, old: [0x01], new: [0xaa] }])

        emulator.undo()
        expect([...emulator.readMemoryBytes(buffer, 1n)]).toEqual([0xaa])
        expect(memoryWrites(emulator)).toEqual([{ address: buffer, old: [0x01], new: [0xaa] }])
        emulator.dispose()
    })
})
