import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { expectCore, expectLinux, probeSource, quadwords, runInCore } from './linux-probe'

const ENODEV = -19
const EINVAL = -22

// open("/tmp/small", O_RDWR | O_CREAT | O_TRUNC, 0644) and write 100 bytes of 'a' into it.
const SMALL_FILE = [
    'mov rax, "/tmp/sma"',
    'mov [buf2], rax',
    'mov dword [buf2 + 7], "ll"',
    'mov rdi, buf',
    'mov al, "a"',
    'mov ecx, 100',
    'rep stosb',
    'sys 2, buf2, 0x242, 0o644',
    'mov r13, rax',
    'sys 1, r13, buf, 100'
]

describe('file mappings', () => {
    for (const gib of [1, 2]) {
        it(`maps ${gib} GiB of a 100-byte file without copying the pages past its end`, async () => {
            const emulator = await createX86Emulator()
            try {
                const build = await emulator.compile(
                    probeSource([
                        ...SMALL_FILE,
                        `sys 9, 0, ${gib} << 30, 1, 2, r13, 0`,
                        'mov r12, rax',
                        'movzx eax, byte [r12]',
                        'save',
                        'movzx eax, byte [r12 + 99]',
                        'save',
                        'movzx eax, byte [r12 + 100]',
                        'save',
                        `mov rax, ${gib} << 29`,
                        'movzx eax, byte [r12 + rax]',
                        'save',
                        `sys 11, r12, ${gib} << 30`,
                        'save',
                        'finish'
                    ])
                )
                expect(build.ok, build.report).toBe(true)
                emulator.initialize(0)
                const stderr: number[] = []
                emulator.on('stderr', (chunk) => void stderr.push(...chunk))
                const memory = emulator.module.wasmExports!.memory!
                const before = memory.buffer.byteLength
                await emulator.run(1_000_000)
                expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
                // The 'a's of the file, then zeros: the rest of its last page and a page wholly
                // past its end, which Linux would answer with SIGBUS.
                expect(quadwords(Uint8Array.from(stderr))).toEqual([97n, 97n, 0n, 0n, 0n])
                // Page tables only: a few MiB for 2 GiB, not one 4 KiB page per page mapped.
                expect(memory.buffer.byteLength - before).toBeLessThan(32 * 1024 * 1024)
            } finally {
                emulator.dispose()
            }
        })
    }

    it('maps only regular files, as Linux does', async () => {
        await expectLinux(
            [
                // a directory
                'mov dword [buf2], "/"',
                'sys 2, buf2, 0, 0',
                'mov r12, rax',
                'sys 9, 0, 4096, 1, 2, r12, 0',
                'save',
                // /dev/null, privately and shared, and /dev/urandom
                'mov rax, "/dev/nul"',
                'mov [buf2], rax',
                'mov dword [buf2 + 8], "l"',
                'sys 2, buf2, 0, 0',
                'mov r12, rax',
                'sys 9, 0, 4096, 1, 2, r12, 0',
                'save',
                'sys 9, 0, 4096, 1, 1, r12, 0',
                'save',
                'mov rax, "/dev/ura"',
                'mov [buf2], rax',
                'mov rax, "ndom"',
                'mov [buf2 + 8], rax',
                'sys 2, buf2, 0, 0',
                'mov r12, rax',
                'sys 9, 0, 4096, 1, 2, r12, 0',
                'save',
                // a pipe
                'sys 22, buf2',
                'mov r12d, [buf2]',
                'sys 9, 0, 4096, 1, 2, r12, 0',
                'save',
                // and a regular file
                ...SMALL_FILE,
                'sys 9, 0, 4096, 1, 2, r13, 0',
                'movzx eax, byte [rax]',
                'save'
            ],
            [ENODEV, ENODEV, ENODEV, ENODEV, ENODEV, 97]
        )
    })

    it('refuses a non-regular file before MAP_FIXED can replace a mapping', async () => {
        await expectLinux(
            [
                'sys 9, 0, 4096, 3, 0x22, -1, 0',
                'mov r13, rax',
                'mov qword [r13], 123',
                'sys 22, buf2',
                'mov r12d, [buf2]',
                'sys 9, r13, 4096, 1, 0x12, r12, 0',
                'save',
                'saveq r13'
            ],
            [ENODEV, 123]
        )
    })
})

describe('mmap address hints', () => {
    it('treats an address without MAP_FIXED as a hint, as Linux does', async () => {
        await expectLinux(
            [
                // a hint below mmap_min_addr rises to it
                'sys 9, 0x1000, 4096, 3, 0x22, -1, 0',
                'cmp rax, 0x10000',
                'sete al',
                'movzx eax, al',
                'save',
                // an unaligned hint is rounded down to its page
                'mov r12, 0x600000000123',
                'sys 9, r12, 4096, 3, 0x22, -1, 0',
                'mov r12, 0x600000000000',
                'cmp rax, r12',
                'sete al',
                'movzx eax, al',
                'save',
                // the same address with MAP_FIXED is an error
                'mov r12, 0x610000000123',
                'sys 9, r12, 4096, 3, 0x32, -1, 0',
                'save',
                // a hint outside the address space is ignored
                'mov r12, 0xffff800000000000',
                'sys 9, r12, 4096, 3, 0x22, -1, 0',
                'mov r12, 0x7ffffffff000',
                'cmp rax, r12',
                'setb al',
                'movzx eax, al',
                'save',
                'mov r12, 0x7ffffffff000',
                'sys 9, r12, 8192, 3, 0x22, -1, 0',
                'mov r12, 0x7ffffffff000',
                'cmp rax, r12',
                'setb al',
                'movzx eax, al',
                'save'
            ],
            [1, 1, EINVAL, 1, 1]
        )
    })
})

describe('the top-down allocator', () => {
    it('places thousands of mappings without searching through all of them each time', async () => {
        const count = 10_000
        const started = performance.now()
        const core = await runInCore([
            `mov r14, ${count}`,
            'xor r15, r15',
            '.next:',
            'sys 9, 0, 0x40000, 3, 0x22, -1, 0',
            'cmp rax, -4096',
            'jae .done',
            // each lands just below the one before
            'test r15, r15',
            'jz .first',
            'lea rcx, [rax + 0x40000]',
            'cmp rcx, r15',
            'jne .done',
            '.first:',
            'mov r15, rax',
            'dec r14',
            'jnz .next',
            '.done:',
            'save r14',
            // freeing one in the middle lets the next mapping of its size reuse its place
            `mov r12, r15`,
            `add r12, ${(count / 2) * 0x40000}`,
            'sys 11, r12, 0x40000',
            'sys 9, 0, 0x40000, 3, 0x22, -1, 0',
            'sub rax, r12',
            'save',
            'finish'
        ])
        const elapsed = performance.now() - started
        expect(core.stopReason?.kind, core.stopReason?.details).toBe('exit')
        expect(core.results).toEqual([0n, 0n])
        // A search through every mapping below took 0.7 s for 2,000 and grows with the square;
        // with the free-area cache 10,000 take a fraction of a second.
        expect(elapsed).toBeLessThan(10_000)
    })
})

describe('memory the Core cannot provide', () => {
    it('answers ENOMEM, not a crash, for a mapping larger than the address space it allows', async () => {
        await expectCore(['mov r12, 1 << 40', 'sys 9, 0, r12, 3, 0x22, -1, 0', 'save'], [-12])
    })
})
