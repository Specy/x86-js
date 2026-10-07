import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { END_OF_INPUT, type X86Environment } from '../src/types'
import { EmulatorStatus } from '../src/interface'
import { probeSource, quadwords, expectLinux, runInCore, runNatively, NATIVE } from './linux-probe'

describe('browser environment', () => {
    it('implements pipe bytes, EOF and readiness as Linux', async () => {
        await expectLinux(
            [
                'sys 293, buf2, 2048',
                'save',
                'mov r12d, [buf2]',
                'mov r13d, [buf2 + 4]',
                'sys 0, r12, buf, 8',
                'save',
                'mov qword [buf], 0x04030201',
                'sys 1, r13, buf, 4',
                'save',
                'sys 0, r12, buf + 16, 8',
                'save',
                'saveq buf + 16',
                'sys 3, r13',
                'save',
                'sys 0, r12, buf + 16, 8',
                'save'
            ],
            [0, -11, 4, 4, 0x04030201, 0, 0]
        )
    })
    it('ignores negative poll fds and counts invalid descriptors', async () => {
        await expectLinux(
            [
                'mov dword [buf], -1',
                'mov dword [buf+8], 1000',
                'mov word [buf+4], 1',
                'mov word [buf+12], 1',
                'sys 7, buf, 2, 0',
                'save',
                'movzx eax, word [buf+6]',
                'save',
                'movzx eax, word [buf+14]',
                'save'
            ],
            [1, 0, 32]
        )
    })
    it('uses selected sources only during program load/execution, with active identity', async () => {
        const calls: (string | null)[] = []
        const emulator = await createX86Emulator({
            environment: {
                now: () => 1234567,
                random: (length, serial) => {
                    calls.push(serial)
                    return new Uint8Array(length).fill(0x42)
                }
            }
        })
        const result = await emulator.compile(
            probeSource([
                'sys 318, buf, 8, 0',
                'save',
                'saveq buf',
                'sys 228, 0, buf',
                'saveq buf',
                'saveq buf+8',
                'finish'
            ])
        )
        expect(result.ok, result.report).toBe(true)
        expect(calls).toEqual([])
        const output: number[] = []
        emulator.on('stderr', (bytes) => {
            output.push(...bytes)
        })
        await emulator.run(100000)
        expect(calls[0]).toBeNull()
        expect(calls.slice(1).every((serial) => serial !== null)).toBe(true)
        expect(quadwords(Uint8Array.from(output))).toEqual([
            8n,
            0x4242424242424242n,
            1234n,
            567000000n
        ])
        emulator.dispose()
    })
    it('halts sleep without blocking and keeps one identity across early wakes/cancel', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: { now: () => now, wait: () => new Promise(() => {}) }
        })
        expect(
            (
                await emulator.compile(
                    probeSource([
                        'mov qword [buf], 1',
                        'sys 35, buf, buf2',
                        'save',
                        'saveq buf2',
                        'saveq buf2+8',
                        'finish'
                    ])
                )
            ).ok
        ).toBe(true)
        emulator.initialize(100)
        expect(emulator.resumeWait()).toBe(false)
        expect(emulator.cancelWait()).toBe(false)
        expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
        const serial = emulator.getCurrentInstructionSerial()
        const count = emulator.getInstructionsExecuted()
        expect(serial).not.toBeNull()
        expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(1000)
        now = 250
        expect(emulator.resumeWait()).toBe(true)
        expect(emulator.getCurrentInstructionSerial()).toBe(serial)
        expect(emulator.getInstructionsExecuted()).toBe(count)
        expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(750)
        const output: number[] = []
        emulator.on('stderr', (bytes) => {
            output.push(...bytes)
        })
        expect(emulator.cancelWait()).toBe(true)
        expect(emulator.cancelWait()).toBe(false)
        await emulator.run(100000)
        expect(emulator.resumeWait()).toBe(false)
        expect(quadwords(Uint8Array.from(output))).toEqual([-4n, 0n, 750000000n])
        expect(emulator.getInstructionsExecuted()).toBeGreaterThan(count)
        emulator.dispose()
    })
})

const frozen = () => ({ now: (_clock: number) => 0, wait: () => new Promise<void>(() => {}) })
async function make(body: string[], environment: X86Environment = frozen()) {
    const emulator = await createX86Emulator({ environment })
    const build = await emulator.compile(probeSource(body))
    expect(build.ok, build.report).toBe(true)
    return emulator
}
async function results(emulator: Awaited<ReturnType<typeof make>>) {
    const bytes: number[] = []
    const stop = emulator.on('stderr', (chunk) => {
        bytes.push(...chunk)
    })
    try {
        await emulator.run(100000)
        return quadwords(Uint8Array.from(bytes))
    } finally {
        stop()
    }
}

describe('wait lifecycle and Linux readiness', () => {
    it('matches pipe readiness, duplicate lifetime, nonblocking flags, positioned I/O and SIGPIPE', async () => {
        await expectLinux(
            [
                'sys 22, buf2',
                'save',
                'mov r12d,[buf2]',
                'mov r13d,[buf2+4]',
                'sys 32,r13',
                'mov r14,rax',
                'sys 3,r13',
                'mov dword [buf+128],r12d',
                'mov word [buf+132],1',
                'sys 7,buf+128,1,0',
                'save',
                'mov qword [buf],0x11223344',
                'sys 1,r14,buf,4',
                'save',
                'sys 7,buf+128,1,0',
                'save',
                'movzx eax,word [buf+134]',
                'save',
                'sys 3,r14',
                'sys 7,buf+128,1,0',
                'save',
                'movzx eax,word [buf+134]',
                'save',
                'sys 0,r12,buf+16,8',
                'save',
                'sys 7,buf+128,1,0',
                'save',
                'movzx eax,word [buf+134]',
                'save',
                'sys 8,r12,0,0',
                'save',
                'sys 17,r12,buf,1,0',
                'save',
                'sys 72,r12,3',
                'save',
                'sys 32,r12',
                'mov r15,rax',
                'sys 72,r12,4,2048',
                'save',
                'sys 72,r15,3',
                'save'
            ],
            [0, 0, 4, 1, 1, 1, 17, 4, 1, 16, -29, -29, 0, 0, 2048]
        )
    })
    it('returns EAGAIN for empty nonblocking terminal read and readv', async () => {
        const emulator = await make([
            'sys 72,0,4,2048',
            'sys 0,0,buf,8',
            'save',
            'mov qword [buf2],buf',
            'mov qword [buf2+8],8',
            'sys 19,0,buf2,1',
            'save',
            'finish'
        ])
        expect(await results(emulator)).toEqual([-11n, -11n])
        emulator.dispose()
    })
    it.each([
        ['poll', ['mov dword [buf],0', 'mov word [buf+4],1', 'sys 7,buf,1,1000', 'save', 'finish']],
        [
            'select',
            ['mov qword [buf],1', 'mov qword [buf2],1', 'sys 23,1,buf,0,0,buf2', 'save', 'finish']
        ]
    ] as const)(
        'wakes %s for queued terminal input and preserves a readable byte',
        async (_name, body) => {
            const emulator = await make([...body])
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            expect(emulator.getWaitRequest()?.acceptsInput).toBe(true)
            expect(emulator.canUndo()).toBe(false)
            expect(() => emulator.beginPoke()).toThrow(/waiting/)
            expect(() => emulator.initialize(10)).toThrow(/waiting/)
            const bytes: number[] = []
            emulator.on('stderr', (chunk) => {
                bytes.push(...chunk)
            })
            emulator.provideInput('x\n')
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([1n])
            emulator.dispose()
        }
    )
    it.each([
        ['poll', ['sys 7,0,0,-1']],
        ['pause', ['sys 34']],
        ['sigsuspend', ['mov qword [buf],-1', 'sys 130,buf,8']],
        ['pipe read', ['sys 22,buf2', 'mov r12d,[buf2]', 'sys 0,r12,buf,8']]
    ] as const)(
        'exposes indefinite %s without requesting terminal input and cancels with EINTR',
        async (_name, body) => {
            const emulator = await make([
                ...body,
                'save',
                'sys 14,2,0,buf,8',
                'saveq buf',
                'finish'
            ])
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            expect(emulator.getWaitRequest()).toMatchObject({
                acceptsInput: false,
                remainingMilliseconds: null,
                deadlineNanoseconds: null
            })
            const bytes: number[] = []
            emulator.on('stderr', (chunk) => {
                bytes.push(...chunk)
            })
            emulator.cancelWait()
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-4n, 0n])
            emulator.dispose()
        }
    )
    it.each([
        ['ppoll', ['mov qword [buf],1', 'mov qword [buf2],-1', 'sys 271,0,0,buf,buf2,8']],
        [
            'pselect6',
            [
                'mov qword [buf],1',
                'mov qword [buf2],-1',
                'mov qword [buf2+16],buf2',
                'mov qword [buf2+24],8',
                'sys 270,0,0,0,0,buf,buf2+16'
            ]
        ]
    ] as const)(
        'restores %s temporary signal mask after early wakes/cancellation',
        async (_name, body) => {
            const emulator = await make([
                ...body,
                'save',
                'sys 14,2,0,buf2,8',
                'saveq buf2',
                'finish'
            ])
            emulator.initialize(100)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            const serial = emulator.getCurrentInstructionSerial()
            emulator.resumeWait()
            expect(emulator.getCurrentInstructionSerial()).toBe(serial)
            const bytes: number[] = []
            emulator.on('stderr', (chunk) => {
                bytes.push(...chunk)
            })
            emulator.cancelWait()
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-4n, 0n])
            emulator.dispose()
        }
    )
    it('uses monotonic relative deadlines even when wall clock differs and completes a virtual wait', async () => {
        let monotonic = 500
        const emulator = await make(
            [
                'mov qword [buf],1',
                'sys 35,buf,0',
                'save',
                'sys 228,1,buf',
                'saveq buf',
                'saveq buf+8',
                'finish'
            ],
            {
                now: (clock) => (clock === 0 ? 1_000_000 : monotonic),
                wait: async (request) => {
                    expect(request.clock).toBe(1)
                    expect(request.remainingMilliseconds).toBe(1000)
                    monotonic += request.remainingMilliseconds!
                }
            }
        )
        const bytes: number[] = []
        emulator.on('stderr', (chunk) => {
            bytes.push(...chunk)
        })
        await emulator.run(100000)
        await new Promise((resolve) => setTimeout(resolve, 0))
        await emulator.run(100000)
        expect(quadwords(Uint8Array.from(bytes))).toEqual([0n, 1n, 500000000n])
        emulator.dispose()
    })
    it('invalid ppoll timeout unwinds its mask before the next syscall', async () => {
        await expectLinux(
            [
                'mov qword [buf],0',
                'mov qword [buf+8],1000000000',
                'mov qword [buf2],-1',
                'sys 271,0,0,buf,buf2,8',
                'save',
                'sys 14,2,0,buf,8',
                'saveq buf'
            ],
            [-22, 0]
        )
    })
    it('replacement and disposal abort old transport and reject late wakeups', async () => {
        let resolveOld: (() => void) | undefined
        let signal: AbortSignal | undefined
        const emulator = await make(['sys 34', 'save', 'finish'], {
            now: () => 0,
            wait: async (_request, abort) => {
                signal = abort
                await new Promise<void>((resolve) => {
                    resolveOld = resolve
                })
            }
        })
        await emulator.run(100000)
        await Promise.resolve()
        expect(signal?.aborted).toBe(false)
        const next = await emulator.compile(probeSource(['sys 60,7']))
        expect(next.ok).toBe(true)
        expect(signal?.aborted).toBe(true)
        resolveOld?.()
        await Promise.resolve()
        expect(emulator.getCurrentInstructionSerial()).toBeNull()
        expect(Boolean(emulator.module._blinkenlib_wait_pending())).toBe(false)
        await emulator.run(100000)
        expect(emulator.stopReason?.exitCode).toBe(7)
        await emulator.compile(probeSource(['sys 34']))
        await emulator.run(100000)
        await Promise.resolve()
        emulator.dispose()
        expect(signal?.aborted).toBe(true)
        expect(emulator.getCurrentInstructionSerial()).toBeNull()
        expect(Boolean(emulator.module._blinkenlib_wait_pending())).toBe(false)
        resolveOld?.()
    })
})

describe('sources and execution accounting', () => {
    it.each([0, 100])(
        'counts completed input once with history capacity %i and counts exit',
        async (capacity) => {
            const emulator = await make(['sys 0,0,buf,8', 'sys 60,0'])
            emulator.initialize(capacity)
            const before = emulator.getInstructionsExecuted()
            await emulator.run(100000)
            const waiting = emulator.getInstructionsExecuted()
            const serial = emulator.getCurrentInstructionSerial()
            expect(waiting - before).toBe(4n)
            expect(serial).toMatch(/^\d+$/)
            emulator.provideInput(END_OF_INPUT)
            expect(emulator.getInstructionsExecuted() - waiting).toBe(1n)
            if (capacity) expect(emulator.getUndoHistory(1)[0].serial).toBe(serial)
            await emulator.run(100000)
            expect(emulator.getInstructionsExecuted() - before).toBe(8n)
            const after = emulator.getInstructionsExecuted()
            if (capacity) {
                emulator.undo()
                expect(emulator.getInstructionsExecuted()).toBe(after)
            }
            emulator.dispose()
        }
    )
    it('keeps count through Pokes/Undo/reset and allocates new identities after replay', async () => {
        const emulator = await make(['mov r12,1', 'mov r12,2', 'sys 60,0'])
        emulator.initialize(20)
        const before = emulator.getInstructionsExecuted()
        await emulator.step()
        const serial = emulator.getUndoHistory(1)[0].serial
        expect(emulator.getInstructionsExecuted() - before).toBe(1n)
        emulator.beginPoke()
        emulator.setRegisterValue('r12', 3n)
        emulator.endPoke()
        expect(emulator.getInstructionsExecuted() - before).toBe(1n)
        emulator.undo()
        emulator.undo()
        await emulator.step()
        expect(emulator.getInstructionsExecuted() - before).toBe(2n)
        expect(BigInt(emulator.getUndoHistory(1)[0].serial)).toBeGreaterThan(BigInt(serial))
        emulator.initialize(0)
        expect(emulator.getInstructionsExecuted() - before).toBe(2n)
        await emulator.step()
        expect(emulator.getInstructionsExecuted() - before).toBe(3n)
        emulator.dispose()
    })
    it('does not count a faulting instruction as retired', async () => {
        const emulator = await make(['ud2'])
        const before = emulator.getInstructionsExecuted()
        await emulator.run(100000)
        expect(emulator.stopReason?.kind).toBe('signal')
        expect(emulator.getInstructionsExecuted()).toBe(before)
        expect(emulator.getCurrentInstructionSerial()).toBeNull()
        emulator.dispose()
    })
    it('draws one ordered stream for loader/getrandom/urandom/RDRAND/RDSEED and preserves runtime identities', async () => {
        let position = 0
        const calls: { length: number; serial: string | null }[] = []
        const emulator = await createX86Emulator({
            environment: {
                random: (length, serial) => {
                    calls.push({ length, serial })
                    return Uint8Array.from({ length }, () => position++ & 255)
                },
                now: () => 1000
            }
        })
        const build = await emulator.compile(
            probeSource([
                'sys 318,buf,8,0',
                'saveq buf',
                'mov rax,0x6172752f7665642f',
                'mov [buf],rax',
                'mov dword [buf+8],0x6d6f646e',
                'mov byte [buf+12],0',
                'sys 2,buf,0,0',
                'mov r12,rax',
                'sys 0,r12,buf+32,8',
                'saveq buf+32',
                'rdrand rax',
                'save',
                'rdseed rax',
                'save',
                'rdtsc',
                'save',
                'finish'
            ])
        )
        expect(build.ok, build.report).toBe(true)
        expect(calls).toEqual([])
        emulator.initialize(100)
        const output = await results(emulator)
        expect(calls.map((call) => call.length)).toEqual([16, 8, 8, 8, 8])
        expect(calls[0].serial).toBeNull()
        expect(new Set(calls.slice(1).map((call) => call.serial)).size).toBe(4)
        expect(
            calls
                .slice(1)
                .every((call) =>
                    emulator.getUndoHistory(100).some((entry) => entry.serial === call.serial)
                )
        ).toBe(true)
        expect(output).toEqual([
            0x1716151413121110n,
            0x1f1e1d1c1b1a1918n,
            0x2726252423222120n,
            0x2f2e2d2c2b2a2928n,
            3000000000n
        ])
        position = 0
        calls.length = 0
        await emulator.run(100000)
        expect(calls[0].serial).toBeNull()
        expect(calls.map((call) => call.length)).toEqual([16, 8, 8, 8, 8])
        emulator.dispose()
    })
    it.each([0, 1])(
        'clock_nanosleep absolute clock %i preserves its original deadline and leaves rem untouched on cancel',
        async (clock) => {
            let now = 500
            const emulator = await make(
                [
                    'mov qword [buf],1',
                    'mov qword [buf+8],500000000',
                    'mov qword [buf2],99',
                    'sys 230,' + clock + ',1,buf,buf2',
                    'save',
                    'saveq buf2',
                    'finish'
                ],
                {
                    now: (id) => (id === clock ? now : 100000),
                    wait: () => new Promise(() => {})
                }
            )
            await emulator.run(100000)
            expect(emulator.getWaitRequest()).toMatchObject({ clock, remainingMilliseconds: 1000 })
            now = 1000
            emulator.resumeWait()
            expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(500)
            const bytes: number[] = []
            emulator.on('stderr', (chunk) => {
                bytes.push(...chunk)
            })
            emulator.cancelWait()
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(bytes))).toEqual([-4n, 99n])
            emulator.dispose()
        }
    )
    it('reports a clock hook failure', async () => {
        const emulator = await createX86Emulator({
            environment: {
                now: () => {
                    throw new Error('clock unavailable')
                }
            }
        })
        await emulator.compile(probeSource(['sys 228,1,buf', 'finish']))
        await expect(emulator.run(100000)).rejects.toMatchObject({
            name: 'X86EnvironmentError',
            message: 'clock unavailable'
        })
        expect(emulator.stopReason?.details).toBe('clock unavailable')
        emulator.dispose()
    })
})

describe('pipe capacity and default signal action', () => {
    it('ends a broken-pipe write with SIGPIPE before later instructions', async () => {
        const core = await runInCore([
            'sys 22,buf2',
            'mov r12d,[buf2]',
            'mov r13d,[buf2+4]',
            'sys 3,r12',
            'sys 1,r13,buf,1',
            'sys 60,99'
        ])
        expect(core.stopReason).toMatchObject({
            kind: 'signal',
            exitCode: 141,
            signal: { number: 13 }
        })
        if (NATIVE) expect(runNatively(core.executable).signal).toBe('SIGPIPE')
    })
    it('buffers bytes to its fixed capacity, preserves small-write atomicity, and reports FIONREAD', async () => {
        const emulator = await make([
            'sys 293,buf2,2048',
            'mov r12d,[buf2]',
            'mov r13d,[buf2+4]',
            ...Array(16).fill('sys 1,r13,buf,4096'),
            'sys 1,r13,buf,1',
            'save',
            'sys 16,r12,0x541b,buf+16',
            'save',
            'saved buf+16',
            'sys 0,r12,buf,1',
            'save',
            'sys 1,r13,buf,2',
            'save',
            'sys 0,r12,buf,4095',
            'save',
            'sys 1,r13,buf,4096',
            'save',
            'finish'
        ])
        expect(await results(emulator)).toEqual([-11n, 0n, 65536n, 1n, -11n, 4095n, 4096n])
        emulator.dispose()
    })
})

it('reports loader random failure without aborting the module, then allows a replacement run', async () => {
    const emulator = await createX86Emulator({
        environment: {
            random: () => {
                throw new Error('seed source unavailable')
            }
        }
    })
    await emulator.compile(probeSource(['sys 60,9']))
    await emulator.run(100000)
    expect(emulator.stopReason).toMatchObject({
        kind: 'load-fail',
        details: 'seed source unavailable'
    })
    emulator.setEnvironment({ random: (length) => new Uint8Array(length) })
    await emulator.run(100000)
    expect(emulator.stopReason).toMatchObject({ kind: 'exit', exitCode: 9 })
    emulator.dispose()
})
it('keeps hosted tool waits and entropy separate from program sources', async () => {
    const builder = await make([
        'mov qword [buf],0',
        'mov qword [buf+8],1000000',
        'sys 35,buf,0',
        'mov rax,0x6d6172676f72702f',
        'mov [buf2],rax',
        'mov byte [buf2+8],0',
        'sys 2,buf2,65,420',
        'mov r12,rax',
        'mov dword [buf+32],0x656b6166',
        'sys 1,r12,buf+32,4',
        'sys 3,r12',
        'sys 60,0'
    ])
    const executable = builder.getExecutable()!
    builder.dispose()
    let sourceCalls = 0
    const emulator = await createX86Emulator({
        mode: {
            id: 'waiting-tool',
            displayName: 'Fixture tool',
            description: 'Hosted tool wait probe',
            binaries: { assembler: { file: executable, commands: '/assembler' } }
        },
        environment: {
            now: () => {
                ++sourceCalls
                return 0
            },
            random: (length) => {
                ++sourceCalls
                return new Uint8Array(length)
            },
            wait: async () => {
                ++sourceCalls
            }
        }
    })
    const result = await emulator.compile('unused')
    expect(result.ok, result.report).toBe(true)
    expect(emulator.getExecutable()).toEqual(new TextEncoder().encode('fake'))
    expect(sourceCalls).toBe(0)
    emulator.dispose()
})
it('supports getrandom flag validation without drawing on errors or zero-length reads', async () => {
    await expectLinux(
        [
            'sys 318,0,0,0',
            'save',
            'sys 318,buf,8,8',
            'save',
            'sys 318,buf,8,6',
            'save',
            'sys 318,buf,8,4',
            'save'
        ],
        [0, -22, -22, 8]
    )
})
it('touches nanosleep rem only on interruption and reports EFAULT if the interrupted write fails', async () => {
    await expectLinux(['sys 35,buf,1', 'save'], [0])
    const emulator = await make(['mov qword [buf],1', 'sys 35,buf,1', 'save', 'finish'])
    await emulator.run(100000)
    const bytes: number[] = []
    emulator.on('stderr', (chunk) => {
        bytes.push(...chunk)
    })
    emulator.cancelWait()
    await emulator.run(100000)
    expect(quadwords(Uint8Array.from(bytes))).toEqual([-14n])
    emulator.dispose()
})
it('reports pipe fstat as FIFO, and ioctl TCGETS as ENOTTY', async () => {
    await expectLinux(
        [
            'sys 22,buf2',
            'mov r12d,[buf2]',
            'sys 5,r12,buf',
            'save',
            'mov eax,[buf+24]',
            'and eax,0xf000',
            'save',
            'sys 16,r12,0x5401,buf',
            'save'
        ],
        [0, 0x1000, -25]
    )
})
it.each([
    ['poll', ['sys 7,0,0,250'], 'poll'],
    ['select', ['mov qword [buf],0', 'mov qword [buf+8],250000', 'sys 23,0,0,0,0,buf'], 'timeval'],
    [
        'ppoll',
        ['mov qword [buf],0', 'mov qword [buf+8],250000000', 'sys 271,0,0,buf,0,8'],
        'timespec'
    ],
    [
        'pselect6',
        ['mov qword [buf],0', 'mov qword [buf+8],250000000', 'sys 270,0,0,0,0,buf,0'],
        'timespec'
    ]
] as const)(
    'completes %s on a virtual timeout and writes back remaining duration',
    async (_name, body, shape) => {
        let now = 0
        const emulator = await make(
            [...body, 'save', ...(shape === 'poll' ? [] : ['saveq buf', 'saveq buf+8']), 'finish'],
            {
                now: () => now,
                wait: async (request) => {
                    expect(request.acceptsInput).toBe(false)
                    now += request.remainingMilliseconds!
                }
            }
        )
        const bytes: number[] = []
        emulator.on('stderr', (chunk) => {
            bytes.push(...chunk)
        })
        await emulator.run(100000)
        await new Promise((resolve) => setTimeout(resolve, 0))
        await emulator.run(100000)
        expect(now).toBe(250)
        expect(quadwords(Uint8Array.from(bytes))).toEqual(shape === 'poll' ? [0n] : [0n, 0n, 0n])
        emulator.dispose()
    }
)
it('cancels a full blocking pipe write without consuming bytes or requesting Terminal input', async () => {
    const emulator = await make([
        'sys 22,buf2',
        'mov r12d,[buf2]',
        'mov r13d,[buf2+4]',
        ...Array(16).fill('sys 1,r13,buf,4096'),
        'sys 1,r13,buf,1',
        'save',
        'sys 16,r12,0x541b,buf+16',
        'saved buf+16',
        'finish'
    ])
    await emulator.run(100000)
    expect(emulator.getWaitRequest()).toMatchObject({
        remainingMilliseconds: null,
        acceptsInput: false
    })
    const before = emulator.getInstructionsExecuted()
    const bytes: number[] = []
    emulator.on('stderr', (chunk) => {
        bytes.push(...chunk)
    })
    emulator.cancelWait()
    expect(emulator.getInstructionsExecuted() - before).toBe(1n)
    await emulator.run(100000)
    expect(quadwords(Uint8Array.from(bytes))).toEqual([-4n, 65536n])
    emulator.dispose()
})

it('copies a regular file into a pipe with sendfile, and rejects pipes as positioned sources', async () => {
    await expectLinux(
        [
            'sys 293, buf2, 2048',
            'mov r12d, [buf2]',
            'mov r13d, [buf2+4]',
            'mov qword [buf], "f"',
            'sys 2, buf, 0x242, 420',
            'mov r14, rax',
            'mov qword [buf+64], "abcd"',
            'sys 1, r14, buf+64, 4',
            'sys 8, r14, 0, 0',
            'mov qword [buf2+16], 1',
            'sys 40, r13, r14, buf2+16, 3',
            'save',
            'saveq buf2+16',
            'sys 8, r14, 0, 1',
            'save',
            'sys 0, r12, buf+128, 4',
            'save',
            'saveq buf+128',
            'sys 40, r13, r12, 0, 1',
            'save',
            'sys 40, r13, r12, buf2+16, 1',
            'save'
        ],
        [3, 4, 0, 3, 0x646362, -22, -29]
    )
})
