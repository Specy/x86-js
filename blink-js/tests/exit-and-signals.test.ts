// How a program ends, as the Core reports it: the exit status a Linux parent would see, and the
// signal no handler took, by number, si_code and name. Also what the Core reports before any
// program runs: the system calls it implements, and no output of its own.
import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { describeSignal } from '../src/signals'
import { NATIVE, runInCore, runNatively } from './linux-probe'

/** Runs a probe that ends however it ends, natively too where this host can. */
async function ending(body: string[]) {
    const core = await runInCore(body)
    return { core, native: NATIVE ? runNatively(core.executable) : undefined }
}

describe('exit status', () => {
    it.each([
        { status: 0, seen: 0 },
        { status: 7, seen: 7 },
        { status: 255, seen: 255 },
        { status: 256, seen: 0 },
        { status: 300, seen: 44 },
        { status: -1, seen: 255 },
        { status: -255, seen: 1 }
    ])('exit($status) and exit_group($status) are seen as $seen', async ({ status, seen }) => {
        for (const call of [60, 231]) {
            const { core, native } = await ending([
                `mov rdi, ${status}`,
                `mov eax, ${call}`,
                'syscall'
            ])
            expect(core.stopReason).toMatchObject({ kind: 'exit', exitCode: seen })
            expect(core.stopReason?.details).toBe(`program terminated with Exit(${seen})`)
            if (native) expect(native.status).toBe(seen)
        }
    })
})

describe('a signal no handler takes', () => {
    it.each([
        {
            what: 'a load from address 0',
            body: ['mov rax, [0]'],
            signal: 11,
            code: 1,
            name: 'SIGSEGV',
            description: 'Segmentation fault'
        },
        {
            what: 'a division by zero',
            body: ['xor ecx, ecx', 'div ecx'],
            signal: 8,
            code: 1,
            name: 'SIGFPE',
            description: 'Floating point exception'
        },
        {
            what: 'ud2',
            body: ['ud2'],
            signal: 4,
            code: 2,
            name: 'SIGILL',
            description: 'Illegal instruction'
        },
        {
            what: 'int3',
            body: ['int3', 'mov eax, 60', 'xor edi, edi', 'syscall'],
            signal: 5,
            code: 128,
            name: 'SIGTRAP',
            description: 'Trace/breakpoint trap'
        },
        {
            what: 'a single step with TF set',
            body: [
                'pushfq',
                'or qword [rsp], 0x100',
                'popfq',
                'nop',
                'mov eax, 60',
                'xor edi, edi',
                'syscall'
            ],
            signal: 5,
            code: 2, // TRAP_TRACE
            name: 'SIGTRAP',
            description: 'Trace/breakpoint trap'
        },
        {
            what: 'rdtsc under PR_TSC_SIGSEGV',
            body: ['mov eax, 157', 'mov edi, 26', 'mov esi, 2', 'syscall', 'rdtsc'],
            signal: 11,
            code: 128, // SI_KERNEL, a general protection fault
            name: 'SIGSEGV',
            description: 'Segmentation fault'
        }
    ])(
        'ends the program on $what, as Linux does',
        async ({ body, signal, code, name, description }) => {
            const { core, native } = await ending(body)
            expect(core.stopReason).toEqual({
                loadFail: false,
                kind: 'signal',
                exitCode: 128 + signal,
                signal: { number: signal, code, name, description },
                details: `Program terminated with Exit(${128 + signal}) due to signal ${name}: ${description}`
            })
            if (native) expect(native.signal).toBe(name)
        }
    )

    it('ends the program on cpuid once ARCH_SET_CPUID turned it off, as cpuid faulting does', async () => {
        // Only hardware with cpuid faulting can show this natively, so it is held to Linux's rule:
        // the #GP becomes SIGSEGV with SI_KERNEL.
        const core = await runInCore([
            'mov eax, 158',
            'mov edi, 0x1012',
            'xor esi, esi',
            'syscall',
            'cpuid'
        ])
        expect(core.stopReason?.signal).toEqual({
            number: 11,
            code: 128,
            name: 'SIGSEGV',
            description: 'Segmentation fault'
        })
    })

    it('leaves a handled int3 to its handler, and the program runs on', async () => {
        const core = await runInCore([
            'mov eax, 13',
            'mov edi, 5',
            'lea rsi, [rel act]',
            'xor edx, edx',
            'mov r10d, 8',
            'syscall', // rt_sigaction
            'int3',
            'mov eax, 60',
            'mov edi, 3',
            'syscall',
            'handler:',
            'ret',
            'restorer:',
            'mov eax, 15',
            'syscall',
            'section .data',
            'act: dq handler, 0x04000000, restorer, 0',
            'section .text'
        ])
        expect(core.stopReason).toMatchObject({ kind: 'exit', exitCode: 3 })
    })
})

describe('signal names', () => {
    it('names every Linux signal, the real-time ones counted from the kernel’s SIGRTMIN', () => {
        expect(describeSignal(1, 0)).toEqual({
            number: 1,
            code: 0,
            name: 'SIGHUP',
            description: 'Hangup'
        })
        expect(describeSignal(16, 0).name).toBe('SIGSTKFLT')
        expect(describeSignal(31, 0)).toMatchObject({
            name: 'SIGSYS',
            description: 'Bad system call'
        })
        expect([32, 33, 48, 49, 63, 64].map((number) => describeSignal(number, 0).name)).toEqual([
            'SIGRTMIN',
            'SIGRTMIN+1',
            'SIGRTMIN+16',
            'SIGRTMAX-15',
            'SIGRTMAX-1',
            'SIGRTMAX'
        ])
        expect(describeSignal(40, -6)).toMatchObject({
            code: -6,
            description: 'Real-time signal 8'
        })
        for (let number = 1; number <= 64; number++)
            expect(describeSignal(number, 0).name).toMatch(/^SIG/)
        expect(describeSignal(65, 0).name).toBe('signal 65')
    })
})

/**
 * Every system call the Core implements, by number. The documentation lists what this lists, so a
 * change here is a change to what programs can do: update the README's account of it with it.
 */
const IMPLEMENTED = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
    26, 28, 32, 33, 34, 35, 36, 37, 38, 39, 40, 60, 61, 62, 63, 72, 73, 74, 75, 76, 77, 79, 80, 81, 82, 83,
    84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 102, 104, 105, 106, 107,
    108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 124, 127, 130, 131, 132,
    137, 138, 157, 158, 160, 162, 186, 200, 201, 204, 217, 218, 221, 228, 229, 230, 231, 234, 235, 257, 258,
    260, 261, 262, 263, 264, 265, 266, 267, 268, 269, 270, 271, 280, 292, 293, 295, 296, 302, 316,
    318, 327, 328, 436, 439
]

describe('the system calls the Core implements', () => {
    it('lists the arms of the dispatch table it was compiled with, by Linux’s names', async () => {
        const emulator = await createX86Emulator()
        try {
            const syscalls = emulator.getImplementedSyscalls()
            expect(syscalls.map((syscall) => syscall.number)).toEqual(IMPLEMENTED)
            const named = new Map(syscalls.map((syscall) => [syscall.number, syscall]))
            expect(
                [12, 17, 99, 157, 204, 217, 262, 292, 302, 316, 318, 327, 436].map(
                    (number) => named.get(number)?.name
                )
            ).toEqual([
                'brk',
                'pread64',
                'sysinfo',
                'prctl',
                'sched_getaffinity',
                'getdents64',
                'newfstatat',
                'dup3',
                'prlimit64',
                'renameat2',
                'getrandom',
                'preadv2',
                'close_range'
            ])
            // Answered outside the table: the clock fast path, the exits, rt_sigreturn and time.
            expect([228, 60, 231, 15, 201].map((number) => named.get(number)?.name)).toEqual([
                'clock_gettime',
                'exit',
                'exit_group',
                'rt_sigreturn',
                'time'
            ])
            expect(named.get(327)?.arity).toBe(6) // fd, iov, vlen, pos_l, pos_h, flags
            for (const syscall of syscalls) expect(syscall.arity).toBeGreaterThanOrEqual(0)
            for (const syscall of syscalls) expect(syscall.arity).toBeLessThanOrEqual(6)
        } finally {
            emulator.dispose()
        }
    })

    it('answers ENOSYS for a call it does not list', async () => {
        // socket, fork, mknod, mknodat, clock_settime, mount
        const missing = [41, 57, 133, 259, 227, 165]
        expect(missing.filter((number) => IMPLEMENTED.includes(number))).toEqual([])
        const core = await runInCore([
            ...missing.flatMap((number) => [`sys ${number}, 0, 0, 0`, 'save']),
            'finish'
        ])
        expect(core.results).toEqual(missing.map(() => -38n))
    })
})

describe('output', () => {
    it('writes nothing of its own: no banner, no command before the program', async () => {
        let stdout = ''
        const emulator = await createX86Emulator({
            callbacks: { stdout: (chunk) => void (stdout += String.fromCharCode(...chunk)) }
        })
        try {
            expect(stdout).toBe('')
            const build = await emulator.compile(
                [
                    'bits 64',
                    'global _start',
                    'section .data',
                    'hi: db "hi", 10',
                    'section .text',
                    '_start:',
                    'mov eax, 1',
                    'mov edi, 1',
                    'lea rsi, [rel hi]',
                    'mov edx, 3',
                    'syscall',
                    'mov eax, 60',
                    'xor edi, edi',
                    'syscall'
                ].join('\n')
            )
            expect(build.ok, build.report).toBe(true)
            await emulator.runUntilBlocked()
            expect(stdout).toBe('hi\n')
            // The build report still says which tool wrote what.
            expect(build.report).toBe('\n$ /linker /program.o -o /program\n')
        } finally {
            emulator.dispose()
        }
    })

    it('keeps the commands a blink-hosted assembler ran in its report', async () => {
        const emulator = await createX86Emulator({ mode: 'GNU_trunk' })
        try {
            const build = await emulator.compile(
                [
                    '.global _start',
                    '.text',
                    '_start:',
                    '  mov $60, %eax',
                    '  xor %edi, %edi',
                    '  syscall',
                    ''
                ].join('\n')
            )
            expect(build.ok, build.report).toBe(true)
            expect(build.report).toBe(
                '\n$ /assembler --gdwarf-4 /assembly.s -o /program.o\n\n$ /linker /program.o -o /program\n'
            )
        } finally {
            emulator.dispose()
        }
    })
})
