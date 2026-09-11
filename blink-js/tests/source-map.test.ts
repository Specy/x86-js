import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSourceMap } from '../src/source-map'
import { nasmWasmAssembler } from '../src/wasm-assembler'

// NASM is no longer among these: it runs as a wasm module now, so the NASM case
// below assembles in-process and only needs the linker as a native ELF.
const assemblerTools = [
    fileURLToPath(new URL('../src/assets/assemblers/gnu-as.2.43.50.elf', import.meta.url)),
    fileURLToPath(new URL('../src/assets/assemblers/gnu-ld.2.43.50.elf', import.meta.url)),
]
const runElfToolTests = process.platform === 'linux' && assemblerTools.every((path) => {
    try {
        accessSync(path, constants.X_OK)
        return true
    } catch {
        return false
    }
})
const assemblyFixturePath = fileURLToPath(new URL('./fixtures/assembly.s', import.meta.url))

describe.skipIf(!runElfToolTests)('source map parser', () => {
    it('parses GNU as DWARF line rows from a linked ELF', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'x86-js-source-map-'))
        try {
            const sourcePath = join(tempDir, 'assembly.s')
            const objectPath = join(tempDir, 'program.o')
            const programPath = join(tempDir, 'program')
            writeFileSync(sourcePath, readFileSync(assemblyFixturePath, 'utf8'))

            const assemblerPath = fileURLToPath(new URL('../src/assets/assemblers/gnu-as.2.43.50.elf', import.meta.url))
            const linkerPath = fileURLToPath(new URL('../src/assets/assemblers/gnu-ld.2.43.50.elf', import.meta.url))
            execFileSync(assemblerPath, ['--gdwarf-4', sourcePath, '-o', objectPath])
            execFileSync(linkerPath, [objectPath, '-o', programPath])

            const sourceMap = parseSourceMap(readFileSync(programPath))
            expect(sourceMap?.getAddressesForLine(3).length).toBeGreaterThan(0)
            expect(sourceMap?.getAddressesForLine(4).length).toBeGreaterThan(0)
            expect(sourceMap?.getLocation(sourceMap.getAddressesForLine(3)[0]!)?.file).toContain('assembly.s')
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('parses NASM DWARF line rows from a linked ELF', async () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'x86-js-source-map-'))
        try {
            const objectPath = join(tempDir, 'program.o')
            const programPath = join(tempDir, 'program')

            // The wasm assembler emits the object the linker consumes, which is
            // the pipeline the emulator now runs: NASM outside blink, ld inside.
            const assembled = await nasmWasmAssembler.assemble({
                entry: 'assembly.s',
                files: {
                    'assembly.s': [
                        'global _start',
                        'section .text',
                        '_start:',
                        '  mov rax, 60',
                        '  xor rdi, rdi',
                        '  syscall',
                    ].join('\n'),
                },
            })
            expect(assembled.status).toBe(0)
            expect(assembled.object).not.toBeNull()
            writeFileSync(objectPath, assembled.object!)

            const linkerPath = fileURLToPath(new URL('../src/assets/assemblers/gnu-ld.2.43.50.elf', import.meta.url))
            execFileSync(linkerPath, [objectPath, '-o', programPath])

            const sourceMap = parseSourceMap(readFileSync(programPath))
            expect(sourceMap?.getAddressesForLine(3).length).toBeGreaterThan(0)
            expect(sourceMap?.getAddressesForLine(4).length).toBeGreaterThan(0)
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })
})
