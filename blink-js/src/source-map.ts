export type SourceMapEntry = {
    address: bigint
    lineIndex: number
    file?: string
}

export class SourceMap {
    private readonly entries: SourceMapEntry[]

    constructor(entries: SourceMapEntry[]) {
        this.entries = entries
            .filter((entry) => entry.address >= 0n && entry.lineIndex >= 0)
            .sort((left, right) => compareBigInt(left.address, right.address))
    }

    get size(): number {
        return this.entries.length
    }

    getLineIndex(address: bigint): number | null {
        return this.getLocation(address)?.lineIndex ?? null
    }

    getLocation(address: bigint): SourceMapEntry | null {
        let left = 0
        let right = this.entries.length - 1
        let match: SourceMapEntry | null = null

        while (left <= right) {
            const middle = Math.floor((left + right) / 2)
            const entry = this.entries[middle]
            if (!entry) break
            if (entry.address <= address) {
                match = entry
                left = middle + 1
            } else {
                right = middle - 1
            }
        }

        return match ? { ...match } : null
    }

    getAddressesForLine(lineIndex: number): bigint[] {
        return this.getAddressesForLocation(lineIndex)
    }

    getAddressesForLocation(lineIndex: number, file?: string): bigint[] {
        return this.getAddressesMatching(lineIndex, (candidate) => file === undefined || candidate === file)
    }

    getAddressesMatching(lineIndex: number, matchesFile: (file: string | undefined) => boolean): bigint[] {
        const addresses: bigint[] = []
        const seen = new Set<string>()
        for (const entry of this.entries) {
            if (entry.lineIndex !== lineIndex || !matchesFile(entry.file)) continue
            const key = entry.address.toString()
            if (seen.has(key)) continue
            seen.add(key)
            addresses.push(entry.address)
        }
        return addresses
    }

    getAddresses(): bigint[] {
        const addresses: bigint[] = []
        let previous: bigint | undefined
        for (const entry of this.entries) {
            if (entry.address === previous) continue
            addresses.push(entry.address)
            previous = entry.address
        }
        return addresses
    }
}

export function parseSourceMap(bytes: Uint8Array): SourceMap | null {
    const section = findElfSection(bytes, '.debug_line')
    if (!section) return null
    const entries = parseDebugLine(bytes.subarray(section.offset, section.offset + section.size))
    return entries.length ? new SourceMap(entries) : null
}

export type ElfSection = {
    offset: number
    size: number
}

export function findElfSection(bytes: Uint8Array, name: string): ElfSection | null {
    if (bytes.length < 0x40) return null
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null
    if (bytes[4] !== 2 || bytes[5] !== 1) return null

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const sectionHeaderOffset = readU64Number(view, 0x28)
    const sectionHeaderEntrySize = view.getUint16(0x3a, true)
    const sectionHeaderCount = view.getUint16(0x3c, true)
    const sectionNameTableIndex = view.getUint16(0x3e, true)
    if (sectionHeaderEntrySize <= 0 || sectionHeaderCount <= 0) return null
    if (sectionNameTableIndex >= sectionHeaderCount) return null

    const sectionNameHeader = sectionHeaderOffset + sectionNameTableIndex * sectionHeaderEntrySize
    const sectionNameOffset = readU64Number(view, sectionNameHeader + 0x18)
    const sectionNameSize = readU64Number(view, sectionNameHeader + 0x20)
    const sectionNames = bytes.subarray(sectionNameOffset, sectionNameOffset + sectionNameSize)

    for (let index = 0; index < sectionHeaderCount; index += 1) {
        const header = sectionHeaderOffset + index * sectionHeaderEntrySize
        if (header + 0x40 > bytes.length) return null
        const nameOffset = view.getUint32(header, true)
        const sectionName = readNullTerminatedString(sectionNames, nameOffset, sectionNames.length)[0]
        if (sectionName !== name) continue
        const offset = readU64Number(view, header + 0x18)
        const size = readU64Number(view, header + 0x20)
        if (offset + size > bytes.length) return null
        return { offset, size }
    }

    return null
}

function parseDebugLine(bytes: Uint8Array): SourceMapEntry[] {
    const entries: SourceMapEntry[] = []
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 0

    while (offset + 10 <= bytes.length) {
        const unitLength = view.getUint32(offset, true)
        offset += 4
        if (unitLength === 0 || unitLength === 0xffffffff) break
        const unitEnd = offset + unitLength
        if (unitEnd > bytes.length) break

        const version = view.getUint16(offset, true)
        offset += 2
        if (version < 2 || version > 4) {
            offset = unitEnd
            continue
        }

        const headerLength = view.getUint32(offset, true)
        offset += 4
        const headerEnd = offset + headerLength
        if (headerEnd > unitEnd || offset + 5 > headerEnd) {
            offset = unitEnd
            continue
        }

        const minimumInstructionLength = bytes[offset++] ?? 1
        const maximumOperationsPerInstruction = version >= 4 ? bytes[offset++] ?? 1 : 1
        const defaultIsStatement = (bytes[offset++] ?? 0) !== 0
        const lineBase = view.getInt8(offset++)
        const lineRange = bytes[offset++] ?? 1
        const opcodeBase = bytes[offset++] ?? 1
        const standardOpcodeLengths = bytes.subarray(offset, offset + Math.max(0, opcodeBase - 1))
        offset += standardOpcodeLengths.length

        const includeDirectories = ['']
        while (offset < headerEnd) {
            const [directory, nextOffset] = readNullTerminatedString(bytes, offset, headerEnd)
            offset = nextOffset
            if (!directory) break
            includeDirectories.push(directory)
        }

        const files: Array<{ name: string; directory?: string }> = [{ name: '' }]
        while (offset < headerEnd) {
            const [fileName, nextOffset] = readNullTerminatedString(bytes, offset, headerEnd)
            offset = nextOffset
            if (!fileName) break
            const directoryIndex = readUleb128(bytes, offset, headerEnd)
            offset = directoryIndex.offset
            const timestamp = readUleb128(bytes, offset, headerEnd)
            offset = timestamp.offset
            const fileSize = readUleb128(bytes, offset, headerEnd)
            offset = fileSize.offset
            files.push({ name: fileName, directory: includeDirectories[Number(directoryIndex.value)] })
        }

        offset = headerEnd

        let address = 0n
        let operationIndex = 0
        let file = 1
        let line = 1
        let column = 0
        let isStatement = defaultIsStatement

        const resetState = () => {
            address = 0n
            operationIndex = 0
            file = 1
            line = 1
            column = 0
            isStatement = defaultIsStatement
        }

        const addRow = () => {
            const sourceFile = files[file]
            entries.push({
                address,
                lineIndex: Math.max(0, line - 1),
                file: dwarfSourcePath(sourceFile),
            })
        }

        const advanceAddress = (operationAdvance: number) => {
            const maxOps = Math.max(1, maximumOperationsPerInstruction)
            const totalOperations = operationIndex + operationAdvance
            address += BigInt(Math.floor(totalOperations / maxOps) * minimumInstructionLength)
            operationIndex = totalOperations % maxOps
        }

        while (offset < unitEnd) {
            const opcode = bytes[offset++] ?? 0
            if (opcode === 0) {
                const length = readUleb128(bytes, offset, unitEnd)
                offset = length.offset
                const extendedEnd = offset + Number(length.value)
                if (extendedEnd > unitEnd || offset >= extendedEnd) {
                    offset = unitEnd
                    break
                }
                const subOpcode = bytes[offset++] ?? 0
                if (subOpcode === 1) {
                    resetState()
                } else if (subOpcode === 2) {
                    const remaining = extendedEnd - offset
                    if (remaining >= 8) {
                        address = view.getBigUint64(offset, true)
                    } else if (remaining >= 4) {
                        address = BigInt(view.getUint32(offset, true))
                    }
                    operationIndex = 0
                }
                offset = extendedEnd
                continue
            }

            if (opcode < opcodeBase) {
                switch (opcode) {
                    case 1:
                        addRow()
                        break
                    case 2: {
                        const value = readUleb128(bytes, offset, unitEnd)
                        offset = value.offset
                        advanceAddress(Number(value.value))
                        break
                    }
                    case 3: {
                        const value = readSleb128(bytes, offset, unitEnd)
                        offset = value.offset
                        line += Number(value.value)
                        break
                    }
                    case 4: {
                        const value = readUleb128(bytes, offset, unitEnd)
                        offset = value.offset
                        file = Number(value.value)
                        break
                    }
                    case 5: {
                        const value = readUleb128(bytes, offset, unitEnd)
                        offset = value.offset
                        column = Number(value.value)
                        break
                    }
                    case 6:
                        isStatement = !isStatement
                        break
                    case 7:
                        break
                    case 8: {
                        const adjustedOpcode = 255 - opcodeBase
                        advanceAddress(Math.floor(adjustedOpcode / lineRange))
                        break
                    }
                    case 9:
                        address += BigInt(view.getUint16(offset, true))
                        operationIndex = 0
                        offset += 2
                        break
                    default: {
                        const operandCount = standardOpcodeLengths[opcode - 1] ?? 0
                        for (let operand = 0; operand < operandCount; operand += 1) {
                            const value = readUleb128(bytes, offset, unitEnd)
                            offset = value.offset
                        }
                        break
                    }
                }
                void column
                void isStatement
                continue
            }

            const adjustedOpcode = opcode - opcodeBase
            advanceAddress(Math.floor(adjustedOpcode / lineRange))
            line += lineBase + (adjustedOpcode % lineRange)
            addRow()
        }

        offset = unitEnd
    }

    return entries
}

function dwarfSourcePath(sourceFile: { name: string; directory?: string } | undefined): string | undefined {
    if (!sourceFile?.name) return undefined
    if (!sourceFile.directory || sourceFile.name.startsWith('/')) return sourceFile.name
    return `${sourceFile.directory.replace(/\/$/, '')}/${sourceFile.name}`
}

export function readU64Number(view: DataView, offset: number): number {
    const value = view.getBigUint64(offset, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
    return Number(value)
}

export function readNullTerminatedString(bytes: Uint8Array, offset: number, limit: number): [string, number] {
    let end = offset
    while (end < limit && bytes[end] !== 0) end += 1
    const value = new TextDecoder().decode(bytes.subarray(offset, end))
    return [value, Math.min(end + 1, limit)]
}

function readUleb128(bytes: Uint8Array, offset: number, limit: number): { value: bigint; offset: number } {
    let result = 0n
    let shift = 0n
    while (offset < limit) {
        const byte = BigInt(bytes[offset++] ?? 0)
        result |= (byte & 0x7fn) << shift
        if ((byte & 0x80n) === 0n) break
        shift += 7n
    }
    return { value: result, offset }
}

function readSleb128(bytes: Uint8Array, offset: number, limit: number): { value: bigint; offset: number } {
    let result = 0n
    let shift = 0n
    let byte = 0n
    while (offset < limit) {
        byte = BigInt(bytes[offset++] ?? 0)
        result |= (byte & 0x7fn) << shift
        shift += 7n
        if ((byte & 0x80n) === 0n) break
    }
    if (shift < 64n && (byte & 0x40n) !== 0n) result |= -(1n << shift)
    return { value: result, offset }
}

function compareBigInt(left: bigint, right: bigint): number {
    if (left < right) return -1
    if (left > right) return 1
    return 0
}
