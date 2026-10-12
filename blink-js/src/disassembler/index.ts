import initWasm from './zydis.wasm?init'
export { analyze } from '../elf'
export type { ElfAnalysis, ElfProgramHeader, ElfRelocation, ElfPltStub, ElfSectionHeader, ElfSymbol } from '../elf'

export type DecodedOperand = {
    index: number
    branchTarget?: bigint
    memoryTarget?: bigint
    immediate?: bigint
    textStart?: number
    textEnd?: number
}
export type DecodedInstruction = {
    address: bigint; length: number; mnemonic: string; text: string
    operands: DecodedOperand[]
    isCall: boolean; isJump: boolean; isConditional: boolean; isReturn: boolean; isInvalid: boolean
}

type DecoderExports = {
    memory: WebAssembly.Memory
    malloc(size: number): number
    free(pointer: number): void
    decode(pointer: number, length: number, address: bigint): number
    release_decoded(): void
    _initialize?: () => void
}
let native: DecoderExports
const instance = await initWasm({
    env: {
        emscripten_notify_memory_growth: () => undefined,
        emscripten_resize_heap: (size: number) => {
            try { native.memory.grow(Math.ceil((size - native.memory.buffer.byteLength) / 65536)); return 1 }
            catch { return 0 }
        }
    },
    wasi_snapshot_preview1: {
        proc_exit: (code: number) => { throw new Error(`Zydis exited with ${code}`) },
        fd_write: () => 0,
        fd_close: () => 0,
        fd_seek: () => 0
    }
})
native = instance.exports as unknown as DecoderExports
native._initialize?.()
const decoder = new TextDecoder()

/** Decode a whole range in one native call. Addresses are unsigned x86-64 values. */
export function disassemble(bytes: Uint8Array, address: bigint = 0n): DecodedInstruction[] {
    if (!bytes.length) return []
    if (address < 0n || address > 0xffffffffffffffffn) throw new Error('Invalid x86-64 address')
    const pointer = native.malloc(bytes.length)
    if (!pointer) throw new Error('Zydis ran out of memory')
    try {
        new Uint8Array(native.memory.buffer).set(bytes, pointer)
        const packet = native.decode(pointer, bytes.length, address)
        if (!packet) throw new Error('Zydis could not decode the range')
        // malloc may have grown the heap; acquire its buffer after decoding.
        const buffer = native.memory.buffer
        const header = new DataView(buffer, packet, 16)
        const count = header.getUint32(8, true)
        const records = new DataView(buffer, header.getUint32(0, true), count * 56)
        const heap = new Uint8Array(buffer)
        const text = decoder.decode(heap.subarray(header.getUint32(4, true), header.getUint32(4, true) + header.getUint32(12, true)))
        const mnemonics = new Map<number, string>()
        const output: DecodedInstruction[] = new Array(count)
        for (let i = 0; i < count; ++i) {
            const at = i * 56
            const flags = records.getUint32(at + 36, true)
            const start = records.getUint32(at + 40, true)
            const line = text.slice(start, start + records.getUint32(at + 44, true))
            const mnemonicPointer = records.getUint32(at + 48, true)
            let mnemonic = mnemonics.get(mnemonicPointer)
            if (!mnemonic) {
                let end = mnemonicPointer
                while (heap[end]) ++end
                mnemonic = mnemonicPointer ? decoder.decode(heap.subarray(mnemonicPointer, end)) : 'db'
                mnemonics.set(mnemonicPointer, mnemonic)
            }
            const operands: DecodedOperand[] = []
            if (flags & 32) {
                const span = /0x[\da-f]+/.exec(line)
                operands.push({ index: records.getUint8(at + 52), branchTarget: records.getBigUint64(at + 8, true), textStart: span?.index, textEnd: span ? span.index + span[0].length : undefined })
            }
            if (flags & 64) {
                const from = line.indexOf('[rel ')
                operands.push({ index: records.getUint8(at + 53), memoryTarget: records.getBigUint64(at + 16, true), textStart: from, textEnd: line.indexOf(']', from) + 1 })
            }
            if (flags & 128) operands.push({ index: records.getUint8(at + 54), immediate: records.getBigUint64(at + 24, true) })
            output[i] = {
                address: records.getBigUint64(at, true), length: records.getUint32(at + 32, true), mnemonic, text: line, operands,
                isCall: !!(flags & 1), isJump: !!(flags & 2), isConditional: !!(flags & 4), isReturn: !!(flags & 8), isInvalid: !!(flags & 16)
            }
        }
        return output
    } finally { native.free(pointer); native.release_decoded() }
}
