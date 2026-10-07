import { describe, expect, it } from 'vitest'
import { createX86Emulator } from '../src/x86-emulator'
import { EmulatorStatus } from '../src/interface'
import { BlinkState } from '../src/types'
import { expectLinux, NATIVE, probeSource, quadwords, runInCore, runNatively } from './linux-probe'

describe('one-process Linux signals', () => {
    it('validates self targets, signals and childless wait4 as Linux does', async () => {
        await expectLinux(
            [
                'sys 39',
                'mov r12, rax',
                'sys 62, r12, 0',
                'save',
                'sys 200, r12, 0',
                'save',
                'sys 234, r12, r12, 0',
                'save',
                'sys 62, 0x7fffffff, 0',
                'save',
                'sys 200, 0x7fffffff, 0',
                'save',
                'sys 234, r12, 0x7fffffff, 0',
                'save',
                'sys 62, r12, 65',
                'save',
                'sys 200, r12, 65',
                'save',
                'sys 234, r12, r12, 65',
                'save',
                'sys 234, 0x7fffffff, 0x7fffffff, 65',
                'save',
                'sys 61, -1, buf, 1, buf2',
                'save'
            ],
            [0, 0, 0, -3, -3, -3, -22, -22, -22, -3, -10]
        )
    })

    it('delivers kill, tkill and tgkill to the guest handler with their Linux si_code', async () => {
        await expectLinux(
            [
                'sys 13, 10, act, 0, 8',
                'sys 39',
                'mov r12, rax',
                'sys 62, r12, 10',
                'save',
                'movsxd rax, dword [buf2]',
                'save',
                'sys 200, r12, 10',
                'save',
                'movsxd rax, dword [buf2]',
                'save',
                'sys 234, r12, r12, 10',
                'save',
                'movsxd rax, dword [buf2]',
                'save',
                'finish',
                'handler:',
                'mov eax, [rsi+8]',
                'mov [buf2], eax',
                'ret',
                'restorer:',
                'mov eax, 15',
                'syscall',
                'section .data',
                'act: dq handler, 0x04000004, restorer, 0',
                'section .text'
            ],
            [0, 0, 0, -6, 0, -6]
        )
    })

    it('reports a default self signal before later exit can replace it', async () => {
        const core = await runInCore(['sys 39', 'mov r12, rax', 'sys 62, r12, 15', 'sys 60, 0'])
        expect(core.stopReason).toMatchObject({
            kind: 'signal',
            exitCode: 143,
            signal: { number: 15, name: 'SIGTERM' }
        })
        if (NATIVE) expect(runNatively(core.executable).signal).toBe('SIGTERM')
        const thread = await runInCore(['sys 39', 'mov r12, rax', 'sys 200, r12, 15', 'sys 60, 0'])
        expect(thread.stopReason?.signal).toMatchObject({ number: 15, code: -6 })
    })

    it('coalesces a blocked standard signal and keeps the first sender code', async () => {
        await expectLinux(
            [
                'mov qword [buf], 512', // SIGUSR1, bit 9
                'sys 13, 10, act, 0, 8',
                'sys 14, 0, buf, 0, 8',
                'sys 39',
                'mov r12, rax',
                'sys 62, r12, 10',
                'save',
                'sys 200, r12, 10',
                'save',
                'sys 14, 1, buf, 0, 8',
                'movsxd rax, dword [buf2]',
                'save',
                'finish',
                'handler:',
                'mov eax, [rsi+8]',
                'mov [buf2], eax',
                'ret',
                'restorer:',
                'mov eax, 15',
                'syscall',
                'section .data',
                'act: dq handler, 0x04000004, restorer, 0',
                'section .text'
            ],
            [0, 0, 0]
        )
    })
})

describe('ITIMER_REAL', () => {
    it('rejects invalid timer values with Linux errno', async () => {
        await expectLinux(
            [
                'mov qword [buf+24], 1000000',
                'sys 38, 0, buf, 0',
                'save',
                'mov qword [buf+24], -1',
                'sys 38, 0, buf, 0',
                'save',
                'sys 36, 3, buf2',
                'save',
                'sys 38, 3, buf, 0',
                'save'
            ],
            [-22, -22, -22, -22]
        )
    })

    it('shares alarm and setitimer state, and null new value disarms', async () => {
        const body = [
            'mov qword [buf+16], 2',
            'sys 38, 0, buf, 0',
            'save',
            'sys 37, 3',
            'save',
            'sys 36, 0, buf2',
            'save',
            'saveq buf2+16',
            'sys 38, 0, 0, buf2',
            'save',
            'saveq buf2+16',
            'sys 36, 0, buf2',
            'save',
            'saveq buf2+16',
            'sys 36, 1, buf2',
            'save',
            'sys 38, 2, buf, 0',
            'save'
        ]
        const core = await runInCore([...body, 'finish'])
        expect(core.results.slice(0, 3)).toEqual([0n, 2n, 0n])
        expect(core.results[3]).toBeGreaterThan(0n)
        expect(core.results[3]).toBeLessThanOrEqual(3n)
        expect(core.results[4]).toBe(0n)
        expect(core.results[5]).toBeGreaterThan(0n)
        expect(core.results.slice(6)).toEqual([0n, 0n, -95n, -95n])
        if (NATIVE) {
            const native = runNatively(core.executable)
            expect(native.results.slice(0, 3)).toEqual([0n, 2n, 0n])
            expect(native.results[3]).toBeGreaterThan(0n)
            expect(native.results[5]).toBeGreaterThan(0n)
            expect(native.results[5]).toBeLessThanOrEqual(3n)
            expect(native.results[4]).toBe(0n)
            expect(native.results.slice(6, 8)).toEqual([0n, 0n])
            // Linux implements CPU timers; this browser guest rejects them explicitly.
            expect(native.results[8]).toBe(0n)
            expect(native.results[9]).toBe(0n)
        }
    })

    it('interrupts a wait at its timer deadline while retaining its original deadline', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: {
                now: () => now,
                wait: () => new Promise<void>(() => {})
            }
        })
        try {
            const source = probeSource([
                'sys 13, 14, act, 0, 8',
                'sys 37, 1',
                'mov qword [buf], 2',
                'sys 35, buf, buf2',
                'save',
                'saved buf2',
                'saved buf2+8',
                'saved buf2+16',
                'finish',
                'handler:',
                'inc qword [buf2+16]',
                'ret',
                'restorer:',
                'mov eax, 15',
                'syscall',
                'section .data',
                'act: dq handler, 0x04000000, restorer, 0',
                'section .text'
            ])
            const build = await emulator.compile(source)
            expect(build.ok, build.report).toBe(true)
            emulator.initialize(100)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            const serial = emulator.getCurrentInstructionSerial()
            expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(1000)
            now = 500
            expect(emulator.resumeWait()).toBe(true)
            expect(emulator.getCurrentInstructionSerial()).toBe(serial)
            expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(500)
            now = 1000
            expect(emulator.resumeWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n, 1n, 0n, 1n])
        } finally {
            emulator.dispose()
        }
    })

    it('pairs a monotonic timer deadline with its clock during a realtime absolute wait', async () => {
        let monotonic = 1000
        let realtime = 1_000_000
        const emulator = await createX86Emulator({
            environment: {
                now: (clock) => (clock === 0 ? realtime : monotonic),
                wait: () => new Promise<void>(() => {})
            }
        })
        try {
            const build = await emulator.compile(
                probeSource([
                    'mov qword [buf], 1002',
                    'mov qword [buf2+24], 500000',
                    'sys 13, 14, act, 0, 8',
                    'sys 38, 0, buf2, 0',
                    'sys 230, 0, 1, buf, 0',
                    'save',
                    'finish',
                    'handler:',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x04000000, restorer, 0',
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            const serial = emulator.getCurrentInstructionSerial()
            expect(emulator.getWaitRequest()).toMatchObject({
                clock: 1,
                deadlineNanoseconds: 1_500_000_000n,
                remainingMilliseconds: 500
            })
            monotonic = 1250
            realtime = 1_000_250
            expect(emulator.resumeWait()).toBe(true)
            expect(emulator.getCurrentInstructionSerial()).toBe(serial)
            expect(emulator.getWaitRequest()).toMatchObject({
                clock: 1,
                deadlineNanoseconds: 1_500_000_000n,
                remainingMilliseconds: 250
            })
            monotonic = 1500
            realtime = 1_000_500
            expect(emulator.resumeWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n])
        } finally {
            emulator.dispose()
        }
    })

    it('queues a masked alarm, then delivers it when the guest unmasks it', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: {
                now: () => now,
                wait: () => new Promise<void>(() => {})
            }
        })
        try {
            const build = await emulator.compile(
                probeSource([
                    'mov qword [buf], 8192', // SIGALRM
                    'sys 13, 14, act, 0, 8',
                    'sys 14, 0, buf, 0, 8',
                    'sys 37, 1',
                    'sys 34',
                    'save',
                    'sys 127, buf2',
                    'saveq buf2',
                    'sys 14, 1, buf, 0, 8',
                    'saveq buf2+16',
                    'finish',
                    'handler:',
                    'inc qword [buf2+16]',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x04000000, restorer, 0',
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            now = 1000
            expect(emulator.resumeWait()).toBe(true)
            expect(emulator.getWaitRequest()?.deadlineNanoseconds).toBeNull()
            expect(emulator.cancelWait()).toBe(true)
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n, 8192n, 1n])
        } finally {
            emulator.dispose()
        }
    })

    it('leaves pause waiting when its alarm disposition is SIG_IGN', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: { now: () => now, wait: () => new Promise<void>(() => {}) }
        })
        try {
            const build = await emulator.compile(
                probeSource([
                    'mov qword [buf+24], 100000',
                    'sys 13, 14, act, 0, 8',
                    'sys 38, 0, buf, 0',
                    'sys 34',
                    'save',
                    'finish',
                    'section .data',
                    'act: dq 1, 0, 0, 0', // SIG_IGN
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            now = 100
            expect(emulator.resumeWait()).toBe(true)
            expect(emulator.getWaitRequest()?.deadlineNanoseconds).toBeNull()
            expect(emulator.cancelWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n])
        } finally {
            emulator.dispose()
        }
    })

    it('restores the ordinary blocked mask after ppoll temporarily unmasks an alarm', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: {
                now: () => now,
                wait: () => new Promise<void>(() => {})
            }
        })
        try {
            const build = await emulator.compile(
                probeSource([
                    'mov qword [buf], 8192',
                    'sys 13, 14, act, 0, 8',
                    'sys 14, 0, buf, 0, 8',
                    'sys 37, 1',
                    'sys 271, 0, 0, 0, buf2, 8',
                    'save',
                    'sys 14, 2, 0, buf2, 8',
                    'saveq buf2',
                    'finish',
                    'handler:',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x04000000, restorer, 0',
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            now = 1000
            expect(emulator.resumeWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n, 8192n])
        } finally {
            emulator.dispose()
        }
    })

    it('fires an interval timer at successive waits', async () => {
        let now = 0
        const emulator = await createX86Emulator({
            environment: {
                now: () => now,
                wait: () => new Promise<void>(() => {})
            }
        })
        try {
            const build = await emulator.compile(
                probeSource([
                    'mov qword [buf+8], 500000',
                    'mov qword [buf+24], 500000',
                    'sys 13, 14, act, 0, 8',
                    'sys 38, 0, buf, 0',
                    'sys 34',
                    'save',
                    'sys 34',
                    'save',
                    'saveq buf2',
                    'finish',
                    'handler:',
                    'inc qword [buf2]',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x04000000, restorer, 0',
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            now = 500
            expect(emulator.resumeWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
            expect(emulator.getWaitRequest()?.remainingMilliseconds).toBe(500)
            now = 1000
            expect(emulator.resumeWait()).toBe(true)
            expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n, -4n, 2n])
        } finally {
            emulator.dispose()
        }
    })

    it('wakes a standard-input read on alarm without taking queued bytes', async () => {
        let now = 0
        const emulator = await createX86Emulator({ environment: { now: () => now } })
        try {
            const build = await emulator.compile(
                probeSource([
                    'sys 13, 14, act, 0, 8',
                    'sys 37, 1',
                    'sys 0, 0, buf, 1',
                    'save',
                    'sys 0, 0, buf, 1',
                    'save',
                    'saved buf',
                    'finish',
                    'handler:',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x04000000, restorer, 0',
                    'section .text'
                ])
            )
            expect(build.ok, build.report).toBe(true)
            emulator.initialize(100)
            const output: number[] = []
            emulator.on('stderr', (bytes) => void output.push(...bytes))
            expect(await emulator.run(100000)).toBe(EmulatorStatus.WaitingForInput)
            now = 1000
            // Resume without input: the read returns EINTR and the next one waits.
            emulator.runtime.module._blinkenlib_faketty_resume()
            expect(emulator.state).toBe(BlinkState.ProgramReadlinePause)
            emulator.provideInput('Z\n')
            await emulator.run(100000)
            expect(quadwords(Uint8Array.from(output))).toEqual([-4n, 1n, 90n])
        } finally {
            emulator.dispose()
        }
    })

    it.each([0, 19])(
        'restarts a blocking syscall %i after an SA_RESTART handler',
        async (number) => {
            let now = 0
            const draws: string[] = []
            const emulator = await createX86Emulator({
                environment: {
                    now: () => now,
                    random: (length, serial) => {
                        if (serial) draws.push(serial)
                        return new Uint8Array(length).fill(7)
                    }
                }
            })
            try {
                const read = number === 0 ? 'sys 0, 0, buf+8, 1' : 'sys 19, 0, iov, 1'
                const source = probeSource([
                    'mov qword [buf2+24], 100000',
                    'sys 13, 14, act, 0, 8',
                    'sys 38, 0, buf2, 0',
                    read,
                    'save',
                    'saved buf+8',
                    'finish',
                    'handler:',
                    'nop',
                    'sys 318, buf2+40, 1, 0',
                    'ret',
                    'restorer:',
                    'mov eax, 15',
                    'syscall',
                    'section .data',
                    'act: dq handler, 0x14000000, restorer, 0', // SA_RESTART | SA_RESTORER
                    'iov: dq buf+8, 1',
                    'section .text'
                ])
                const build = await emulator.compile(source)
                expect(build.ok, build.report).toBe(true)
                emulator.initialize(100)
                const output: number[] = []
                emulator.on('stderr', (bytes) => void output.push(...bytes))
                let requests = 0
                let secondRequest!: () => void
                const repeated = new Promise<void>((resolve) => {
                    secondRequest = resolve
                })
                emulator.on('inputRequest', () => {
                    if (++requests === 2) secondRequest()
                })
                expect(await emulator.run(100000)).toBe(EmulatorStatus.WaitingForInput)
                const firstSerial = emulator.getCurrentInstructionSerial()
                const beforeWake = emulator.getInstructionsExecuted()
                const woke = new Promise<void>((resolve) => {
                    const off = emulator.on('stateChange', ({ state }) => {
                        if (state === BlinkState.ProgramRunning) {
                            off()
                            resolve()
                        }
                    })
                })
                now = 100
                await woke
                expect(draws).toHaveLength(0) // timer wake retired only the interrupted read
                expect(emulator.getInstructionsExecuted() - beforeWake).toBe(1n)
                const handlerLine = source.split('\n').indexOf('handler:') + 1
                expect(
                    await emulator.run(100000, [handlerLine], { skipBreakpointAtPc: false })
                ).toBe(EmulatorStatus.Running)
                expect(emulator.stopReason?.kind).toBe('breakpoint')
                expect(draws).toHaveLength(0)
                const beforeStep = emulator.getInstructionsExecuted()
                await emulator.step()
                expect(emulator.getInstructionsExecuted() - beforeStep).toBe(1n)
                expect(draws).toHaveLength(0)
                expect(await emulator.run(100000)).toBe(EmulatorStatus.WaitingForInput)
                await repeated
                expect(emulator.state).toBe(BlinkState.ProgramReadlinePause)
                expect(draws).toHaveLength(1)
                expect(draws[0]).not.toBe(firstSerial)
                expect(emulator.getCurrentInstructionSerial()).not.toBe(firstSerial)
                emulator.provideInput('Q\n')
                await emulator.run(100000)
                expect(quadwords(Uint8Array.from(output))).toEqual([1n, 81n])
            } finally {
                emulator.dispose()
            }
        }
    )

    it.each(['step', 'run'] as const)(
        'delivers an alarm at the next %s slice start',
        async (mode) => {
            let now = 0
            const emulator = await createX86Emulator({ environment: { now: () => now } })
            try {
                const build = await emulator.compile(
                    probeSource(['sys 37, 1', 'loop:', 'inc qword [buf]', 'jmp loop'])
                )
                expect(build.ok, build.report).toBe(true)
                expect(await emulator.run(3)).toBe(EmulatorStatus.Running)
                const before = emulator.getInstructionsExecuted()
                now = 1000
                if (mode === 'step') await emulator.step()
                else await emulator.run(10)
                expect(emulator.stopReason).toMatchObject({
                    kind: 'signal',
                    exitCode: 142,
                    signal: { number: 14, name: 'SIGALRM' }
                })
                expect(emulator.getInstructionsExecuted()).toBe(before)
            } finally {
                emulator.dispose()
            }
        }
    )

    it('resets an armed timer before a replacement program and rejects a late wake after disposal', async () => {
        let now = 0
        const emulator = await createX86Emulator({ environment: { now: () => now } })
        const first = await emulator.compile(probeSource(['sys 37, 1', 'finish']))
        expect(first.ok, first.report).toBe(true)
        expect(await emulator.run(100000)).toBe(EmulatorStatus.Terminated)
        const second = await emulator.compile(probeSource(['sys 34', 'finish']))
        expect(second.ok, second.report).toBe(true)
        now = 1000
        expect(await emulator.run(100000)).toBe(EmulatorStatus.Waiting)
        expect(emulator.getWaitRequest()?.deadlineNanoseconds).toBeNull()
        expect(emulator.cancelWait()).toBe(true)
        await emulator.run(100000)
        expect(emulator.stopReason?.kind).toBe('exit')
        emulator.dispose()

        const pending = await createX86Emulator({ environment: { now: () => 0 } })
        const build = await pending.compile(probeSource(['sys 37, 1', 'sys 34']))
        expect(build.ok, build.report).toBe(true)
        expect(await pending.run(100000)).toBe(EmulatorStatus.Waiting)
        pending.dispose()
        expect(pending.resumeWait()).toBe(false)
        expect(pending.getWaitRequest()).toBeNull()
    })
})
