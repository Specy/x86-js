// Run after npm run build. Assembly/startup are excluded from measured samples.
import { writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { createX86Emulator } from '../dist/index.mjs'
import { benchmarkExecution } from './benchmark-workloads.mjs'

const output = {
    node: process.version,
    cpu: cpus()[0]?.model,
    ...(await benchmarkExecution(createX86Emulator, {
        count: Number(process.env.X86_BENCH_INSTRUCTIONS ?? 10000),
        samples: Number(process.env.X86_BENCH_SAMPLES ?? 5),
        ...(process.env.X86_BENCH_PATHS ? { paths: process.env.X86_BENCH_PATHS.split(',') } : {})
    }))
}
console.table(
    output.results.map(({ workload, path, medianMs, instructionsPerSecond }) => ({
        workload,
        path,
        ms: medianMs.toFixed(2),
        ips: Math.round(instructionsPerSecond)
    }))
)
console.log(JSON.stringify(output.profile, null, 2))
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2) + '\n')
