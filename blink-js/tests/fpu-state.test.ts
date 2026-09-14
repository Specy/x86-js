// The packed FPU state block, decoded and encoded without a machine. The
// layout these offsets mirror is documented in libblink/blink/blinkenlib.h and
// asserted end to end against a running program in undo.test.ts; this file
// pins the byte arithmetic, above all the logical-to-physical rotation of the
// x87 stack, which is the part a reader is most likely to get backwards.
import { describe, expect, it } from 'vitest'
import {
    X86_FPU_STATE_CW_OFFSET,
    X86_FPU_STATE_DP_OFFSET,
    X86_FPU_STATE_IP_OFFSET,
    X86_FPU_STATE_MXCSR_OFFSET,
    X86_FPU_STATE_OP_OFFSET,
    X86_FPU_STATE_SIZE,
    X86_FPU_STATE_ST_OFFSET,
    X86_FPU_STATE_SW_OFFSET,
    X86_FPU_STATE_TW_OFFSET,
    X86_FPU_STATE_XMM_OFFSET,
    X86_SSE_REGISTERS,
    X86_X87_REGISTERS,
    decodeFpuState,
    encodeFpuState,
    fpuStateBlocksEqual,
    readLogicalStBits,
    readLogicalStTags,
} from '../src/fpu-state'

/** Builds a block whose every field is distinguishable, so a swapped offset shows up. */
function makeBlock(options: { top?: number } = {}): Uint8Array {
    const raw = new Uint8Array(X86_FPU_STATE_SIZE)
    const view = new DataView(raw.buffer)
    for (let index = 0; index < 16; index += 1) {
        // low half counts up from 1, high half is the low half shifted into the
        // top byte, so a decoded value that swaps the halves is obvious.
        view.setBigUint64(X86_FPU_STATE_XMM_OFFSET + index * 16, BigInt(index + 1), true)
        view.setBigUint64(X86_FPU_STATE_XMM_OFFSET + index * 16 + 8, BigInt(index + 1) << 56n, true)
    }
    view.setUint32(X86_FPU_STATE_MXCSR_OFFSET, 0x1f80, true)
    for (let physical = 0; physical < 8; physical += 1) {
        view.setFloat64(X86_FPU_STATE_ST_OFFSET + physical * 8, physical + 1, true)
    }
    view.setUint32(X86_FPU_STATE_SW_OFFSET, ((options.top ?? 0) & 7) << 11, true)
    view.setUint32(X86_FPU_STATE_TW_OFFSET, 0xaaaa, true)
    view.setUint32(X86_FPU_STATE_OP_OFFSET, 0x07de, true)
    view.setUint32(X86_FPU_STATE_CW_OFFSET, 0x037f, true)
    view.setBigUint64(X86_FPU_STATE_IP_OFFSET, 0x401000n, true)
    view.setBigUint64(X86_FPU_STATE_DP_OFFSET, 0x402000n, true)
    return raw
}

describe('x86 FPU state block', () => {
    it('names the SSE and x87 registers in the order the decoded values come in', () => {
        expect(X86_SSE_REGISTERS).toHaveLength(17)
        expect(X86_SSE_REGISTERS[0]).toBe('xmm0')
        expect(X86_SSE_REGISTERS[15]).toBe('xmm15')
        expect(X86_SSE_REGISTERS[16]).toBe('mxcsr')

        expect(X86_X87_REGISTERS).toHaveLength(11)
        expect(X86_X87_REGISTERS[0]).toBe('st0')
        expect(X86_X87_REGISTERS[7]).toBe('st7')
        expect([...X86_X87_REGISTERS].slice(8)).toEqual(['fctrl', 'fstat', 'ftag'])
    })

    it('reads xmm lanes little-endian, lane 0 least significant', () => {
        const state = decodeFpuState(makeBlock())

        expect(state.xmm).toHaveLength(16)
        expect(state.xmm[0]).toBe((1n << 56n << 64n) | 1n)
        expect(state.xmm[15]).toBe((16n << 56n << 64n) | 16n)
        expect(state.mxcsr).toBe(0x1f80)
        expect(state.fctrl).toBe(0x037f)
        expect(state.ftag).toBe(0xaaaa)
    })

    it('rotates the physical st array into logical order using TOP', () => {
        // TOP = 0 means st(i) is the physical slot i.
        expect(decodeFpuState(makeBlock({ top: 0 })).st).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

        // TOP = 6 means st(0) is physical st[6], and the array wraps.
        const rotated = decodeFpuState(makeBlock({ top: 6 }))
        expect(rotated.fstat).toBe(6 << 11)
        expect(rotated.st).toEqual([7, 8, 1, 2, 3, 4, 5, 6])
    })

    it('reads the stack as raw bit patterns in the same logical order', () => {
        const bits = readLogicalStBits(makeBlock({ top: 6 }))
        const asDoubles = bits.map((value) => {
            const buffer = new DataView(new ArrayBuffer(8))
            buffer.setBigUint64(0, value, true)
            return buffer.getFloat64(0, true)
        })
        expect(asDoubles).toEqual([7, 8, 1, 2, 3, 4, 5, 6])
    })

    it('rotates the tag word into logical order beside the stack values', () => {
        // 0b11 (empty) for physical slots 0 and 1, 0b00 (valid) for the rest.
        const raw = makeBlock({ top: 6 })
        new DataView(raw.buffer).setUint32(X86_FPU_STATE_TW_OFFSET, 0b1111, true)

        // TOP = 6, so logical st(0) is physical 6 and st(2) is physical 0.
        expect(readLogicalStTags(raw)).toEqual([0, 0, 3, 3, 0, 0, 0, 0])
        // The raw word stays physical, as ftag is documented to be.
        expect(decodeFpuState(raw).ftag).toBe(0b1111)
    })

    it('round trips a block byte for byte through decode and encode', () => {
        for (const top of [0, 3, 6, 7]) {
            const raw = makeBlock({ top })
            const again = encodeFpuState(decodeFpuState(raw), raw)
            expect(fpuStateBlocksEqual(again, raw)).toBe(true)
        }
    })

    it('writes logical stack values back under the TOP the state carries', () => {
        const raw = makeBlock({ top: 6 })
        const state = decodeFpuState(raw)
        state.st[0] = 42.5
        state.xmm[3] = (0xdeadbeefn << 64n) | 0xfeedfacen
        state.mxcsr = 0x9fc0
        state.fctrl = 0x027f
        state.ftag = 0x5555

        const encoded = encodeFpuState(state, raw)
        const view = new DataView(encoded.buffer)
        // st(0) with TOP = 6 belongs in physical slot 6, and nothing else moves.
        expect(view.getFloat64(X86_FPU_STATE_ST_OFFSET + 6 * 8, true)).toBe(42.5)
        expect(view.getFloat64(X86_FPU_STATE_ST_OFFSET + 7 * 8, true)).toBe(8)

        const decoded = decodeFpuState(encoded)
        expect(decoded.st).toEqual([42.5, 8, 1, 2, 3, 4, 5, 6])
        expect(decoded.xmm[3]).toBe((0xdeadbeefn << 64n) | 0xfeedfacen)
        expect(decoded.mxcsr).toBe(0x9fc0)
        expect(decoded.fctrl).toBe(0x027f)
        expect(decoded.ftag).toBe(0x5555)
    })

    it('carries op, ip and dp through untouched, because the state does not name them', () => {
        const raw = makeBlock({ top: 2 })
        const state = decodeFpuState(raw)
        state.st[0] = -1
        const encoded = encodeFpuState(state, raw)
        const view = new DataView(encoded.buffer)

        expect(view.getUint32(X86_FPU_STATE_OP_OFFSET, true)).toBe(0x07de)
        expect(view.getBigUint64(X86_FPU_STATE_IP_OFFSET, true)).toBe(0x401000n)
        expect(view.getBigUint64(X86_FPU_STATE_DP_OFFSET, true)).toBe(0x402000n)
    })

    it('rejects a block that is not the documented size', () => {
        expect(() => decodeFpuState(new Uint8Array(8))).toThrow(/356 bytes/)
        expect(() => encodeFpuState(decodeFpuState(makeBlock()), new Uint8Array(8))).toThrow(/356 bytes/)
        expect(fpuStateBlocksEqual(new Uint8Array(8), makeBlock())).toBe(false)
    })
})
