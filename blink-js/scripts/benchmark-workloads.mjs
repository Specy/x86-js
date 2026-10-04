// Shared Node/browser workload. Every loop has four instructions and increments RBX once.
function equal(actual, expected, message = '') {
    if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`)
}
export async function benchmarkExecution(createX86Emulator, {
    count = 10000, samples = 5, nativeHistory = true,
    paths = ['traced', 'untraced-steps', 'native-run']
} = {}) {
    if (!Number.isSafeInteger(count) || count <= 0 || count % 4)
        throw new Error('count must be a positive multiple of four')
    if (!Number.isSafeInteger(samples) || samples <= 0) throw new Error('samples must be positive')
    const programs = {
        arithmetic: 'inc rbx\nadd rdx, 3\nxor rsi, rdx\njmp loop',
        memory: 'inc rbx\nmov [cell], rbx\nmov rdx, [cell]\njmp loop',
        sse: 'inc rbx\npaddq xmm0, xmm1\npxor xmm2, xmm0\njmp loop'
    }
    const results = []
    for (const [workload, body] of Object.entries(programs)) {
        for (const path of paths) {
            const emulator = await createX86Emulator({ nativeHistory })
            const vectorSetup = workload === 'sse' ? 'pcmpeqd xmm1, xmm1\n' : ''
            const code = `bits 64\nglobal _start\nsection .data\ncell: dq 0\nsection .text\n_start:\n${vectorSetup}loop:\n${body}\n`
            const compiled = await emulator.compile(code)
            equal(compiled.ok, true, compiled.report)
            emulator.initialize(path.startsWith('traced') ? 1000 : 0)
            emulator.getNextInstruction()
            // Nonzero lanes make the vector loop exercise FPU mutation history too.
            if (workload === 'sse') {
                await emulator.step()
                emulator.runtime.pauseForLimit(emulator.getPc(), 0n)
            }
            const run = async () => {
                if (path === 'untraced-steps') {
                    emulator.runtime.resumeAfterStateMutation()
                    for (let i = 0; i < count; i++) emulator.runtime.step()
                } else if (path === 'traced-steps') {
                    for (let i = 0; i < count; i++) await emulator.step()
                } else await emulator.run(count)
            }
            await run()
            const durations = []
            for (let i = 0; i < samples; i++) {
                const start = performance.now()
                await run()
                durations.push(performance.now() - start)
            }
            equal(emulator.getRegisterValue('rbx'), BigInt(Math.ceil((count * (samples + 1)) / 4)))
            const iterations = BigInt((count * (samples + 1)) / 4)
            if (workload === 'memory') equal(emulator.getRegisterValue('rdx'), iterations)
            if (workload === 'sse') {
                const lane = BigInt.asUintN(64, -iterations)
                equal(emulator.getFpuState().xmm[0], lane | (lane << 64n))
            }
            durations.sort((a, b) => a - b)
            const medianMs = durations[Math.floor(durations.length / 2)]
            const historyStart = performance.now()
            const historyRows = emulator.getUndoHistory(100).length
            const historyDecodeMs = performance.now() - historyStart
            results.push({
                workload,
                path,
                instructions: count,
                medianMs,
                instructionsPerSecond: (count / medianMs) * 1000,
                samplesMs: durations, historyRows, historyDecodeMs
            })
            emulator.dispose()
        }
    }

    // Attribution is a separate instrumented run, not part of throughput results.
    const emulator = await createX86Emulator({ nativeHistory })
    equal(
        (
            await emulator.compile(
                `bits 64\nglobal _start\nsection .text\n_start:\ninc rbx\njmp _start\n`
            )
        ).ok,
        true
    )
    emulator.initialize(1000)
    emulator.getNextInstruction()
    const profile = {}
    for (const method of [
        'step',
        'runSlice',
        'getRegisterSnapshot',
        'getFpuStateRaw',
        'getInstructionAt',
        'getLastStepInfo',
        'getPc',
        'getSourceLocationForAddress'
    ]) {
        const original = emulator.runtime[method].bind(emulator.runtime)
        profile[method] = { calls: 0, ms: 0 }
        emulator.runtime[method] = (...args) => {
            const start = performance.now()
            const result = original(...args)
            profile[method].ms += performance.now() - start
            profile[method].calls++
            return result
        }
    }
    const start = performance.now()
    await emulator.run(count)
    const profiledMs = performance.now() - start
    emulator.dispose()
    return { count, samples, nativeHistory, results, profile: { elapsedMs: profiledMs, methods: profile } }
}
