import { RegisterSize, type ExecutionStep, type StackFrame } from './interface'
import { X86_REGISTER_NAMES, type X86RegisterName } from './types'
import type { RegisterSnapshot } from './wasm-types'

export type RegisterValues = Record<X86RegisterName, bigint>

export type UndoMemoryWrite = {
    address: bigint
    old: number[]
}

export type X86HistoryEntry = ExecutionStep & {
    registersBefore: RegisterValues
    flagsBefore: number
    callStackBefore: StackFrame[]
    memoryWrites: UndoMemoryWrite[]
    reversible: boolean
}

export class CircularHistory<T> {
    readonly capacity: number

    private readonly entries: Array<T | undefined>
    private startIndex = 0
    private entryCount = 0

    constructor(capacity: number) {
        this.capacity = Math.max(0, Math.floor(capacity))
        this.entries = new Array(this.capacity)
    }

    clear(): void {
        this.entries.fill(undefined)
        this.startIndex = 0
        this.entryCount = 0
    }

    push(entry: T): void {
        if (this.capacity === 0) return
        if (this.entryCount === this.capacity) {
            this.entries[this.startIndex] = entry
            this.startIndex = (this.startIndex + 1) % this.capacity
            return
        }

        const insertionIndex = (this.startIndex + this.entryCount) % this.capacity
        this.entries[insertionIndex] = entry
        this.entryCount += 1
    }

    pop(): T | undefined {
        if (this.entryCount === 0) return undefined
        const latestIndex = (this.startIndex + this.entryCount - 1) % this.capacity
        const entry = this.entries[latestIndex]
        this.entries[latestIndex] = undefined
        this.entryCount -= 1
        if (this.entryCount === 0) this.startIndex = 0
        return entry
    }

    peekNewest(): T | undefined {
        if (this.entryCount === 0) return undefined
        return this.entries[(this.startIndex + this.entryCount - 1) % this.capacity]
    }

    newestFirst(max: number): T[] {
        const count = Math.min(Math.max(0, Math.floor(max)), this.entryCount)
        const result: T[] = []
        for (let offset = 0; offset < count; offset += 1) {
            const entryIndex = (this.startIndex + this.entryCount - 1 - offset + this.capacity) % this.capacity
            const entry = this.entries[entryIndex]
            if (entry !== undefined) result.push(entry)
        }
        return result
    }
}

export const X86_FLAGS = [
    { name: 'CF', mask: 0x00000001 },
    { name: 'PF', mask: 0x00000004 },
    { name: 'AF', mask: 0x00000010 },
    { name: 'ZF', mask: 0x00000040 },
    { name: 'SF', mask: 0x00000080 },
    { name: 'TF', mask: 0x00000100 },
    { name: 'DF', mask: 0x00000400 },
    { name: 'OF', mask: 0x00000800 },
] as const

export function cloneRegisterValues(snapshot: RegisterSnapshot): RegisterValues {
    return Object.fromEntries(
        X86_REGISTER_NAMES.map((register) => [
            register,
            snapshot.registers[register] ?? (register === 'rip' ? snapshot.rip : 0n),
        ]),
    ) as RegisterValues
}

export function cloneCallStack(stack: StackFrame[]): StackFrame[] {
    return stack.map((frame) => ({ ...frame }))
}

export function stripPrivateHistory(entry: X86HistoryEntry): ExecutionStep {
    return {
        mutations: entry.mutations,
        pc: entry.pc,
        old_ccr: entry.old_ccr,
        new_ccr: entry.new_ccr,
        line: entry.line,
    }
}

export function toHistoryPc(address: bigint): number {
    return Number(address)
}

export function makeFrameColor(index: number, address: bigint): string {
    return `hsl(${(index * 137) % 360}, 40%, 60%)`
}

export function maskForSize(size: RegisterSize): bigint {
    return (1n << BigInt(size * 8)) - 1n
}

export function maskRegisterValue(value: bigint, size: RegisterSize): bigint {
    return value & maskForSize(size)
}

export function deferToHost(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}