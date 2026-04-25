import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSourceMap } from '../src/source-map'

const runElfToolTests = process.platform === 'linux'
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
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })

    it('parses NASM DWARF line rows from a linked ELF', () => {
        const tempDir = mkdtempSync(join(tmpdir(), 'x86-js-source-map-'))
        try {
            const sourcePath = join(tempDir, 'assembly.s')
            const objectPath = join(tempDir, 'program.o')
            const programPath = join(tempDir, 'program')
            writeFileSync(sourcePath, [
                'global _start',
                'section .text',
                '_start:',
                '  mov rax, 60',
                '  xor rdi, rdi',
                '  syscall',
            ].join('\n'))

            const assemblerPath = fileURLToPath(new URL('../src/assets/assemblers/nasm.3.00.elf', import.meta.url))
            const linkerPath = fileURLToPath(new URL('../src/assets/assemblers/gnu-ld.2.43.50.elf', import.meta.url))
            execFileSync(assemblerPath, ['-g', '-F', 'dwarf', '-felf64', sourcePath, '-o', objectPath])
            execFileSync(linkerPath, [objectPath, '-o', programPath])

            const sourceMap = parseSourceMap(readFileSync(programPath))
            expect(sourceMap?.getAddressesForLine(3).length).toBeGreaterThan(0)
            expect(sourceMap?.getAddressesForLine(4).length).toBeGreaterThan(0)
        } finally {
            rmSync(tempDir, { recursive: true, force: true })
        }
    })
})
