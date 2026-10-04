// Requires Playwright; PLAYWRIGHT_MODULE may point to an existing installation.
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const root = new URL('../', import.meta.url)
const server = createServer(async (req, res) => {
    try {
        const url = new URL(`.${new URL(req.url, 'http://localhost').pathname}`, root)
        if (!url.href.startsWith(root.href)) throw new Error('invalid path')
        if (url.href === root.href) {
            res.setHeader('Content-Type', 'text/html')
            res.end('<!doctype html><title>x86 performance experiment</title>')
            return
        }
        res.setHeader(
            'Content-Type',
            url.pathname.endsWith('.wasm')
                ? 'application/wasm'
                : url.pathname.endsWith('.mjs') || url.pathname.endsWith('.js')
                  ? 'text/javascript'
                  : 'application/octet-stream'
        )
        res.end(await readFile(url))
    } catch {
        res.statusCode = 404
        res.end()
    }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let browser
try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    const output = {
        browser: browser.version(),
        cpu: cpus()[0]?.model,
        ...(await page.evaluate(
            async (options) => {
                const { createX86Emulator } = await import('/dist/index.mjs')
                const { benchmarkExecution } = await import('/scripts/benchmark-workloads.mjs')
                return benchmarkExecution(createX86Emulator, options)
            },
            {
                count: Number(process.env.X86_BENCH_INSTRUCTIONS ?? 10000),
                samples: Number(process.env.X86_BENCH_SAMPLES ?? 5),
                ...(process.env.X86_BENCH_PATHS ? { paths: process.env.X86_BENCH_PATHS.split(',') } : {})
            }
        ))
    }
    console.table(
        output.results.map(({ workload, path, medianMs, instructionsPerSecond }) => ({
            workload,
            path,
            ms: medianMs.toFixed(2),
            ips: Math.round(instructionsPerSecond)
        }))
    )
    if (process.argv[2])
        await writeFile(
            fileURLToPath(new URL(process.argv[2], `file://${process.cwd()}/`)),
            JSON.stringify(output, null, 2) + '\n'
        )
} finally {
    await browser?.close()
    server.close()
}
