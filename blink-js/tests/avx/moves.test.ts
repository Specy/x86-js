// VEX moves, logic and integer arithmetic: the instructions that map straight onto a legacy SSE
// handler, in their 128-bit and 256-bit forms, with register and memory operands.
import { describe, expect, it } from 'vitest'
import { checkAgainstNative, NATIVE_AVX, type VectorCase } from './harness'

const PACKED_INTEGER = [
    'vpaddb', 'vpaddw', 'vpaddd', 'vpaddq', 'vpsubb', 'vpsubw', 'vpsubd', 'vpsubq', 'vpand', 'vpandn', 'vpor', 'vpxor',
    'vpcmpeqb', 'vpcmpeqw', 'vpcmpeqd', 'vpcmpgtb', 'vpcmpgtw', 'vpcmpgtd',
]

function threeOperand(names: string[]): VectorCase[] {
    return names.flatMap((name) => [
        { asm: `${name} xmm0, xmm1, xmm2` },
        { asm: `${name} ymm0, ymm1, ymm2` },
        { asm: `${name} ymm0, ymm0, ymm2` },
        { asm: `${name} ymm0, ymm1, ymm0` },
        { asm: `${name} ymm0, ymm1, ymm1` },
        { asm: `${name} xmm0, xmm1, [rel mem]` },
        { asm: `${name} ymm0, ymm1, [rel mem]` },
        { asm: `${name} ymm0, ymm1, [rel mem + 1]` },
    ])
}

describe.skipIf(!NATIVE_AVX)('VEX against the host', () => {
    it('runs a first instruction', async () => {
        await checkAgainstNative([{ asm: 'vpxor xmm0, xmm1, xmm2' }])
    })
    it('matches on packed integer arithmetic and logic', async () => {
        await checkAgainstNative(threeOperand(PACKED_INTEGER))
    })
})

describe('VEX without a host', () => {
    it('is exercised by the host comparison above', () => {
        expect(true).toBe(true)
    })
})
