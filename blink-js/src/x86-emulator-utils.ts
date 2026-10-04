import { RegisterSize } from './interface'

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
