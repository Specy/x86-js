import type { X86ProcessStart, X86ProcessStartBytes } from './types'

const AT_NULL = 0n
const AT_RANDOM = 25n
const AT_EXECFN = 31n
/** More pointers than any start can have: 1,025 arguments, the environment and a margin. */
const MAX_POINTERS = 8192
/** More auxiliary vector entries than Blink writes (fifteen with AT_NULL). */
const MAX_AUXV = 64
/** The longest string read: the 128 KiB the arguments may take, and a margin. */
const MAX_STRING = 256 * 1024
const PAGE = 4096n

/**
 * The block a Linux loader writes above the initial stack pointer, read back from memory right
 * after the loader ran: `argc` at `rsp`, the NULL-terminated `argv[]` and `envp[]`, the auxiliary
 * vector up to `AT_NULL`, then, above some alignment padding, the strings they point at. Blink's
 * `LoadArgv` writes the program's path first, at the very top, then the 16 `AT_RANDOM` bytes, the
 * `AT_EXECFN` path, the environment's strings and the arguments' strings, each below the one
 * before; the path at the top is found as the string that starts where the highest named one ends.
 * Throws when the memory does not read as such a block.
 */
export function readProcessStart(
    rsp: bigint,
    read: (address: bigint, length: number) => Uint8Array
): X86ProcessStart {
    // Each page is read once, from the block's start at the lowest, so nothing below rsp is read.
    const pages = new Map<bigint, { start: bigint; bytes: Uint8Array }>()
    const page = (address: bigint) => {
        const base = address - (address % PAGE)
        let cached = pages.get(base)
        if (!cached) {
            const start = base < rsp ? rsp : base
            cached = { start, bytes: read(start, Number(base + PAGE - start)) }
            pages.set(base, cached)
        }
        return cached
    }
    const byte = (address: bigint) => {
        if (address < rsp) throw new Error(`0x${address.toString(16)} is below the block`)
        const { start, bytes } = page(address)
        const value = bytes[Number(address - start)]
        if (value === undefined) throw new Error(`0x${address.toString(16)} could not be read`)
        return value
    }
    const qword = (address: bigint) => {
        let value = 0n
        for (let i = 7n; i >= 0n; i--) value = (value << 8n) | BigInt(byte(address + i))
        return value
    }
    /** The string at `address`, its NUL included, searched for a page at a time. */
    const string = (address: bigint): X86ProcessStartBytes => {
        if (address < rsp) throw new Error(`0x${address.toString(16)} is below the block`)
        for (let length = 0; length < MAX_STRING;) {
            const at = address + BigInt(length)
            const { start, bytes } = page(at)
            const offset = Number(at - start)
            if (offset >= bytes.length) break
            const nul = bytes.indexOf(0, offset)
            if (nul >= 0) return { address, length: length + nul - offset + 1 }
            length += bytes.length - offset
        }
        throw new Error(`No NUL ends the string at 0x${address.toString(16)}`)
    }
    /** The pointers of a NULL-terminated array, and where the array ends, past its NULL. */
    const pointers = (address: bigint, limit: number) => {
        const found: bigint[] = []
        for (let at = address; ; at += 8n) {
            const pointer = qword(at)
            if (pointer === 0n) return { found, end: at + 8n }
            if (found.length >= limit)
                throw new Error(`The array at 0x${address.toString(16)} has no NULL`)
            found.push(pointer)
        }
    }

    const argc = qword(rsp)
    if (argc > BigInt(MAX_POINTERS)) throw new Error(`argc is ${argc}`)
    const argv = rsp + 8n
    const args = pointers(argv, Number(argc))
    if (args.found.length !== Number(argc))
        throw new Error(`argv holds ${args.found.length} pointers for argc ${argc}`)
    const envp = args.end
    const environment = pointers(envp, MAX_POINTERS)
    const auxv = environment.end
    let execfn: X86ProcessStartBytes | undefined
    let random: X86ProcessStartBytes | undefined
    let auxvEnd: bigint | undefined
    for (let at = auxv, entries = 0; entries < MAX_AUXV; at += 16n, entries++) {
        const type = qword(at)
        const value = qword(at + 8n)
        if (type === AT_NULL) {
            auxvEnd = at + 16n
            break
        }
        if (type === AT_EXECFN && value) execfn = string(value)
        if (type === AT_RANDOM && value) random = { address: value, length: 16 }
    }
    if (auxvEnd === undefined) throw new Error('The auxiliary vector has no AT_NULL')

    const result: X86ProcessStart = {
        start: rsp,
        end: auxvEnd,
        argc: Number(argc),
        argv,
        envp,
        auxv,
        auxvEnd,
        arguments: args.found.map(string),
        environment: environment.found.map(string)
    }
    if (execfn) result.execfn = execfn
    if (random) result.random = random
    const named = [...result.arguments, ...result.environment, execfn, random].filter(
        (part): part is X86ProcessStartBytes => !!part
    )
    let top = auxvEnd
    for (const part of named) {
        const partEnd = part.address + BigInt(part.length)
        if (part.address < auxvEnd)
            throw new Error(`A string at 0x${part.address.toString(16)} lies inside the vectors`)
        if (partEnd > top) top = partEnd
    }
    // The path the loader wrote first, if a string starts where the highest named one ends.
    try {
        if (top > auxvEnd) {
            const path = string(top)
            if (path.length > 1) {
                result.path = path
                top += BigInt(path.length)
            }
        }
    } catch {
        // nothing readable above the named strings: the block ends with them
    }
    result.end = top
    return result
}
