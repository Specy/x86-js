/**
 * Decoding and encoding of the packed FPU state block that
 * `blinkenlib_get_fpu_state()` copies out of Blink's machine and
 * `blinkenlib_set_fpu_state()` copies back.
 *
 * The layout is documented once, authoritatively, in
 * `libblink/blink/blinkenlib.h`; the offsets below mirror it and the two must
 * move together. Everything here is pure: it takes bytes and returns values,
 * so it can be unit tested without a machine and used both by the register
 * panel and by the undo snapshot.
 */

/** Byte offset of `xmm[16][16]` in the block. */
export const X86_FPU_STATE_XMM_OFFSET = 0
/** Byte offset of `mxcsr` in the block. */
export const X86_FPU_STATE_MXCSR_OFFSET = 256
/** Byte offset of the eight `st` doubles, in physical array order. */
export const X86_FPU_STATE_ST_OFFSET = 260
/** Byte offset of the x87 status word, which carries TOP in bits 11..13. */
export const X86_FPU_STATE_SW_OFFSET = 324
/** Byte offset of the x87 tag word. */
export const X86_FPU_STATE_TW_OFFSET = 328
/** Byte offset of the last x87 opcode, carried through untouched. */
export const X86_FPU_STATE_OP_OFFSET = 332
/** Byte offset of the x87 control word. */
export const X86_FPU_STATE_CW_OFFSET = 336
/** Byte offset of the last x87 instruction pointer, carried through untouched. */
export const X86_FPU_STATE_IP_OFFSET = 340
/** Byte offset of the last x87 data pointer, carried through untouched. */
export const X86_FPU_STATE_DP_OFFSET = 348
/** Total size in bytes of the block, matching `BLINKENLIB_FPU_STATE_SIZE`. */
export const X86_FPU_STATE_SIZE = 356

/**
 * The SSE register file in the order `decodeFpuState` returns it: `xmm[0]`
 * through `xmm[15]`, then `mxcsr`.
 */
export const X86_SSE_REGISTERS = [
    'xmm0',
    'xmm1',
    'xmm2',
    'xmm3',
    'xmm4',
    'xmm5',
    'xmm6',
    'xmm7',
    'xmm8',
    'xmm9',
    'xmm10',
    'xmm11',
    'xmm12',
    'xmm13',
    'xmm14',
    'xmm15',
    'mxcsr',
] as const

/**
 * The x87 register file in the order `decodeFpuState` returns it: the stack
 * `st[0]` (the top) through `st[7]`, then the control, status and tag words.
 */
export const X86_X87_REGISTERS = [
    'st0',
    'st1',
    'st2',
    'st3',
    'st4',
    'st5',
    'st6',
    'st7',
    'fctrl',
    'fstat',
    'ftag',
] as const

export type X86SseRegisterName = (typeof X86_SSE_REGISTERS)[number]
export type X86X87RegisterName = (typeof X86_X87_REGISTERS)[number]

export type X86FpuState = {
    /**
     * `xmm0` through `xmm15` as unsigned 128-bit values. Lane 0, the lowest
     * byte in memory, is the least significant part of the value.
     */
    xmm: bigint[]
    /** The SSE control and status register. */
    mxcsr: number
    /**
     * The x87 stack in LOGICAL order: `st[0]` is `st(0)`, the top of the
     * stack, whatever TOP happens to be. Blink keeps the stack as 64-bit
     * doubles rather than 80-bit extended values, so these are exactly the
     * doubles the machine holds.
     */
    st: number[]
    /** The 16-bit x87 control word. */
    fctrl: number
    /** The 16-bit x87 status word. TOP lives in bits 11..13. */
    fstat: number
    /** The 16-bit x87 tag word, two bits per PHYSICAL stack slot. */
    ftag: number
}

const XMM_COUNT = 16
const ST_COUNT = 8
const WORD_MASK = 0xffff
const LOW_64 = (1n << 64n) - 1n

/** The stack slot `st(i)` lives at physical `st[(i + TOP) & 7]`, as `FpuSt()` in blink/fpu.h computes. */
function topOfStack(statusWord: number): number {
    return (statusWord >> 11) & 7
}

function viewOf(raw: Uint8Array): DataView {
    return new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
}

function assertBlockSize(raw: Uint8Array, what: string): void {
    if (raw.length !== X86_FPU_STATE_SIZE) {
        throw new Error(`${what} must be ${X86_FPU_STATE_SIZE} bytes, got ${raw.length}`)
    }
}

/**
 * Reads the block into named values, rotating the x87 stack from the physical
 * array order the machine holds into the logical `st(0)..st(7)` order a
 * programmer reads.
 */
export function decodeFpuState(raw: Uint8Array): X86FpuState {
    assertBlockSize(raw, 'an x86 FPU state block')
    const view = viewOf(raw)

    const xmm: bigint[] = new Array(XMM_COUNT)
    for (let index = 0; index < XMM_COUNT; index += 1) {
        const offset = X86_FPU_STATE_XMM_OFFSET + index * 16
        const low = view.getBigUint64(offset, true)
        const high = view.getBigUint64(offset + 8, true)
        xmm[index] = (high << 64n) | low
    }

    const fstat = view.getUint32(X86_FPU_STATE_SW_OFFSET, true) & WORD_MASK
    const top = topOfStack(fstat)
    const st: number[] = new Array(ST_COUNT)
    for (let logical = 0; logical < ST_COUNT; logical += 1) {
        const physical = (logical + top) & 7
        st[logical] = view.getFloat64(X86_FPU_STATE_ST_OFFSET + physical * 8, true)
    }

    return {
        xmm,
        mxcsr: view.getUint32(X86_FPU_STATE_MXCSR_OFFSET, true) >>> 0,
        st,
        fctrl: view.getUint32(X86_FPU_STATE_CW_OFFSET, true) & WORD_MASK,
        fstat,
        ftag: view.getUint32(X86_FPU_STATE_TW_OFFSET, true) & WORD_MASK,
    }
}

/**
 * Writes `state` over a copy of `base`, inverting the rotation `decodeFpuState`
 * applied: the logical stack goes back to physical slots under the TOP that
 * `state.fstat` carries. `op`, `ip` and `dp` are not part of `X86FpuState` and
 * are carried through from `base` untouched, as are the high halves of the
 * control, status and tag words, so `encodeFpuState(decodeFpuState(raw), raw)`
 * reproduces `raw` byte for byte.
 */
export function encodeFpuState(state: X86FpuState, base: Uint8Array): Uint8Array {
    assertBlockSize(base, 'an x86 FPU state block')
    const raw = new Uint8Array(base)
    const view = viewOf(raw)

    for (let index = 0; index < XMM_COUNT; index += 1) {
        const value = BigInt.asUintN(128, state.xmm[index] ?? 0n)
        const offset = X86_FPU_STATE_XMM_OFFSET + index * 16
        view.setBigUint64(offset, value & LOW_64, true)
        view.setBigUint64(offset + 8, value >> 64n, true)
    }
    view.setUint32(X86_FPU_STATE_MXCSR_OFFSET, state.mxcsr >>> 0, true)

    const fstat = state.fstat & WORD_MASK
    const top = topOfStack(fstat)
    for (let logical = 0; logical < ST_COUNT; logical += 1) {
        const physical = (logical + top) & 7
        view.setFloat64(X86_FPU_STATE_ST_OFFSET + physical * 8, state.st[logical] ?? 0, true)
    }

    writeWord(view, X86_FPU_STATE_SW_OFFSET, fstat)
    writeWord(view, X86_FPU_STATE_TW_OFFSET, state.ftag)
    writeWord(view, X86_FPU_STATE_CW_OFFSET, state.fctrl)
    return raw
}

/** Replaces the low 16 bits of a 32-bit field, leaving whatever the machine kept above them. */
function writeWord(view: DataView, offset: number, value: number): void {
    const preserved = view.getUint32(offset, true) & ~WORD_MASK
    view.setUint32(offset, (preserved | (value & WORD_MASK)) >>> 0, true)
}

/**
 * The eight x87 stack slots as raw IEEE-754 binary64 bit patterns, in LOGICAL
 * order. Undo diffing compares bit patterns rather than the decoded doubles so
 * that a NaN compares equal to itself and never looks like a write.
 */
export function readLogicalStBits(raw: Uint8Array): bigint[] {
    assertBlockSize(raw, 'an x86 FPU state block')
    const view = viewOf(raw)
    const top = topOfStack(view.getUint32(X86_FPU_STATE_SW_OFFSET, true) & WORD_MASK)
    const bits: bigint[] = new Array(ST_COUNT)
    for (let logical = 0; logical < ST_COUNT; logical += 1) {
        bits[logical] = view.getBigUint64(X86_FPU_STATE_ST_OFFSET + (((logical + top) & 7) * 8), true)
    }
    return bits
}

/** True when two blocks hold the same bytes. The common step changes nothing, and this is all it costs. */
export function fpuStateBlocksEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return false
    }
    return true
}

/** An all-zero block, the state the panel shows before a program is built. */
export function emptyFpuStateBlock(): Uint8Array {
    return new Uint8Array(X86_FPU_STATE_SIZE)
}
