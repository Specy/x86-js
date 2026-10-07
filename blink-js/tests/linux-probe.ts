// A probe is a NASM program that makes system calls and writes what they returned to stderr, as
// little-endian quadwords, before it exits. The same ELF runs in the Core and, on x86-64 Linux,
// natively, so a test can hold the Core to what Linux does with the very same bytes.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { BlinkState, type StopReason } from '../src/types'

/** Whether this host can run a probe natively, as the reference. */
export const NATIVE = process.platform === 'linux' && process.arch === 'x64'

export const EPERM = -1
export const ENOENT = -2
export const ESRCH = -3
export const EBADF = -9
export const EEXIST = -17
export const ENOTDIR = -20
export const EINVAL = -22
export const EOPNOTSUPP = -95

/** No process has this id: it is above any `kernel.pid_max` Linux allows. */
export const NO_SUCH_PID = 0x7fffffff

/**
 * `sys number, args...` makes a system call with its arguments in Linux's registers (rdi, rsi,
 * rdx, r10, r8, r9); `save` appends rax, or the operand given, to the results; `saveq` and `saved`
 * append the quadword or the zero-extended doubleword at an address; `finish` writes the results
 * to stderr and exits 0. `buf` and `buf2` are 4 KiB of scratch each.
 */
const PRELUDE = [
    'bits 64',
    'global _start',
    '%assign slot 0',
    '%macro sys 1-7',
    '  mov rax, %1',
    '  %if %0 > 1',
    '    mov rdi, %2',
    '  %endif',
    '  %if %0 > 2',
    '    mov rsi, %3',
    '  %endif',
    '  %if %0 > 3',
    '    mov rdx, %4',
    '  %endif',
    '  %if %0 > 4',
    '    mov r10, %5',
    '  %endif',
    '  %if %0 > 5',
    '    mov r8, %6',
    '  %endif',
    '  %if %0 > 6',
    '    mov r9, %7',
    '  %endif',
    '  syscall',
    '%endmacro',
    '%macro save 0-1 rax',
    '  mov [results + slot * 8], %1',
    '  %assign slot slot + 1',
    '%endmacro',
    '%macro saveq 1',
    '  mov rax, [%1]',
    '  save',
    '%endmacro',
    '%macro saved 1',
    '  mov eax, [%1]',
    '  save',
    '%endmacro',
    '%macro finish 0',
    '  sys 1, 2, results, slot * 8',
    '  sys 60, 0',
    '%endmacro',
    'section .bss',
    'results: resq 256',
    'buf: resb 4096',
    'buf2: resb 4096',
    'section .text',
    '_start:'
]

/** A probe's whole source: the prelude, then `body`. */
export function probeSource(body: readonly string[]): string {
    return [...PRELUDE, ...body].join('\n')
}

/** The little-endian quadwords a probe wrote. */
export function quadwords(bytes: Uint8Array): bigint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return Array.from({ length: Math.floor(bytes.byteLength / 8) }, (_, index) =>
        view.getBigInt64(index * 8, true)
    )
}

export type CoreRun = {
    results: bigint[]
    stdout: string
    stopReason: StopReason | null
    executable: Uint8Array
}

/** Builds the probe and runs it in a Core of its own, from a file system nothing else used. */
export async function runInCore(body: readonly string[]): Promise<CoreRun> {
    const emulator = await createX86Emulator()
    try {
        const build = await emulator.compile(probeSource(body))
        if (!build.ok) throw new Error(`the probe did not assemble:\n${build.report}`)
        const executable = Uint8Array.from(emulator.module.FS.readFile('/program') as Uint8Array)
        const stderr: number[] = []
        let stdout = ''
        emulator.on('stderr', (chunk) => void stderr.push(...chunk))
        emulator.on('stdout', (chunk) => void (stdout += String.fromCharCode(...chunk)))
        for (let slice = 0; slice < 100 && !emulator.hasTerminated(); slice++) {
            await emulator.run(1_000_000)
            const wakeDeadline = Date.now() + 5000
            while (emulator.state === BlinkState.ProgramWaitPause) {
                if (emulator.getWaitRequest()?.deadlineNanoseconds === null)
                    throw new Error('Probe entered an indefinite wait')
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(
                        () => {
                            stop()
                            reject(new Error('Probe wait did not wake within five seconds'))
                        },
                        Math.max(0, wakeDeadline - Date.now())
                    )
                    const stop = emulator.on('stateChange', ({ state }) => {
                        if (state !== BlinkState.ProgramWaitPause) {
                            stop()
                            clearTimeout(timeout)
                            resolve()
                        }
                    })
                })
            }
        }
        return {
            results: quadwords(Uint8Array.from(stderr)),
            stdout,
            stopReason: emulator.stopReason,
            executable
        }
    } finally {
        emulator.dispose()
    }
}

export type NativeRun = { results: bigint[]; status: number | null; signal: NodeJS.Signals | null }

/** Runs the probe's ELF on this host, in an empty directory of its own. */
export function runNatively(executable: Uint8Array): NativeRun {
    const directory = mkdtempSync(join(tmpdir(), 'x86-probe-'))
    try {
        const path = join(directory, 'program')
        writeFileSync(path, executable)
        chmodSync(path, 0o755)
        const run = spawnSync(path, [], { cwd: directory, timeout: 10_000 })
        if (run.error) throw run.error
        return {
            results: quadwords(Uint8Array.from(run.stderr)),
            status: run.status,
            signal: run.signal
        }
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
}

const asBigints = (values: readonly (number | bigint)[]) => values.map((value) => BigInt(value))

/**
 * Runs the probe in the Core and expects `expected`, and on x86-64 Linux runs it natively and
 * expects the same: what a test asserts is then what Linux does, not only what the Core does.
 */
export async function expectLinux(body: readonly string[], expected: readonly (number | bigint)[]) {
    const core = await runInCore([...body, 'finish'])
    expect(core.stopReason?.kind, core.stopReason?.details).toBe('exit')
    expect(core.results, 'Core').toEqual(asBigints(expected))
    if (NATIVE)
        expect(runNatively(core.executable).results, 'native Linux').toEqual(asBigints(expected))
    return core
}

/**
 * Runs the probe in the Core only and expects `expected`: for behaviour this host could not show,
 * such as a process running as root, or that depends on the host's kernel version or hardware.
 * Each use says which Linux behaviour the values stand for.
 */
export async function expectCore(body: readonly string[], expected: readonly (number | bigint)[]) {
    const core = await runInCore([...body, 'finish'])
    expect(core.stopReason?.kind, core.stopReason?.details).toBe('exit')
    expect(core.results).toEqual(asBigints(expected))
    return core
}
