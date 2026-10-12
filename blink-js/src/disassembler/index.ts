import initWasm from './zydis.wasm?init'

export type DecodedOperand = {
    index: number
    /** A direct branch's absolute target, printed as `0x...` between `textStart` and `textEnd`. */
    branchTarget?: bigint
    /**
     * The absolute address a RIP-relative operand reaches. `textStart` and `textEnd` span its
     * `[rel 0x...]`, brackets included; a size keyword or a segment (`qword fs:[rel 0x...]`) is
     * printed before the span, outside it.
     */
    memoryTarget?: bigint
    immediate?: bigint
    textStart?: number
    textEnd?: number
}
export type DecodedInstruction = {
    address: bigint
    length: number
    /** NASM's spelling, as the text has it: `je`, `jae`, `setg`, `cmovne`, `retf`; `db` when invalid. */
    mnemonic: string
    /**
     * The instruction as NASM text that assembles back to it: lower-case hex, NASM's size keywords
     * without `ptr` wherever no other operand implies the size (`idiv qword [rbp-0x08]`,
     * `call far dword [rax]`), RIP-relative operands as `[rel 0x<absolute target>]`, and multi-byte
     * nops with their memory operand only (`nop word cs:[rax+rax*1]`). Undecodable bytes are one
     * `db 0x..` each.
     */
    text: string
    operands: DecodedOperand[]
    isCall: boolean
    isJump: boolean
    isConditional: boolean
    isReturn: boolean
    /** Not an instruction: a one-byte `db` entry. */
    isInvalid: boolean
    /**
     * With `isInvalid`: the bytes given ended before the instruction did, so more bytes (the rest
     * of a page that was not readable, say) might decode as a valid instruction. Still one `db`.
     */
    isTruncated: boolean
}

/** Zydis, instantiated: decodes x86-64 machine code into NASM-flavoured Intel text. */
export type Disassembler = {
    /** Decode a whole range in one native call. Addresses are unsigned x86-64 values. */
    disassemble(bytes: Uint8Array, address?: bigint): DecodedInstruction[]
}

type DecoderExports = {
    memory: WebAssembly.Memory
    malloc(size: number): number
    free(pointer: number): void
    decode(pointer: number, length: number, address: bigint): number
    release_decoded(): void
    _initialize?: () => void
}

let loading: Promise<Disassembler> | undefined

/**
 * Instantiates Zydis's wasm on the first call and answers the same {@link Disassembler} to every
 * call after it. Importing this module instantiates nothing.
 */
export function loadDisassembler(): Promise<Disassembler> {
    loading ??= instantiate().catch((error: unknown) => {
        loading = undefined
        throw error
    })
    return loading
}

async function instantiate(): Promise<Disassembler> {
    let native: DecoderExports | undefined
    const instance = await initWasm({
        env: {
            emscripten_notify_memory_growth: () => undefined,
            emscripten_resize_heap: (size: number) => {
                try {
                    native!.memory.grow(
                        Math.ceil((size - native!.memory.buffer.byteLength) / 65536)
                    )
                    return 1
                } catch {
                    return 0
                }
            }
        },
        wasi_snapshot_preview1: {
            proc_exit: (code: number) => {
                throw new Error(`Zydis exited with ${code}`)
            },
            fd_write: () => 0,
            fd_close: () => 0,
            fd_seek: () => 0
        }
    })
    native = instance.exports as unknown as DecoderExports
    native._initialize?.()
    const decoder = native
    return { disassemble: (bytes, address = 0n) => disassemble(decoder, bytes, address) }
}

const textDecoder = new TextDecoder()

function disassemble(
    native: DecoderExports,
    bytes: Uint8Array,
    address: bigint
): DecodedInstruction[] {
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
        const text = textDecoder.decode(
            heap.subarray(
                header.getUint32(4, true),
                header.getUint32(4, true) + header.getUint32(12, true)
            )
        )
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
                mnemonic = mnemonicPointer
                    ? textDecoder.decode(heap.subarray(mnemonicPointer, end))
                    : 'db'
                mnemonics.set(mnemonicPointer, mnemonic)
            }
            const operands: DecodedOperand[] = []
            if (flags & 32) {
                const span = /0x[\da-f]+/.exec(line)
                operands.push({
                    index: records.getUint8(at + 52),
                    branchTarget: records.getBigUint64(at + 8, true),
                    textStart: span?.index,
                    textEnd: span ? span.index + span[0].length : undefined
                })
            }
            if (flags & 64) {
                const from = line.indexOf('[rel ')
                operands.push({
                    index: records.getUint8(at + 53),
                    memoryTarget: records.getBigUint64(at + 16, true),
                    textStart: from,
                    textEnd: line.indexOf(']', from) + 1
                })
            }
            if (flags & 128)
                operands.push({
                    index: records.getUint8(at + 54),
                    immediate: records.getBigUint64(at + 24, true)
                })
            output[i] = {
                address: records.getBigUint64(at, true),
                length: records.getUint32(at + 32, true),
                mnemonic,
                text: line,
                operands,
                isCall: !!(flags & 1),
                isJump: !!(flags & 2),
                isConditional: !!(flags & 4),
                isReturn: !!(flags & 8),
                isInvalid: !!(flags & 16),
                isTruncated: !!(flags & 256)
            }
        }
        return output
    } finally {
        native.free(pointer)
        native.release_decoded()
    }
}
