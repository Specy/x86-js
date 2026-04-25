import { cp, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const copies = [
  ['src/wasm/blinkenlib.js', 'dist/wasm/blinkenlib.js'],
  ['src/wasm/blinkenlib.d.ts', 'dist/wasm/blinkenlib.d.ts'],
  ['src/assets', 'dist/assets'],
]

await mkdir(resolve(root, 'dist'), { recursive: true })

for (const [from, to] of copies) {
  const fromPath = resolve(root, from)
  const toPath = resolve(root, to)
  const fromStats = await stat(fromPath)
  await mkdir(dirname(toPath), { recursive: true })
  await cp(fromPath, toPath, {
    recursive: fromStats.isDirectory(),
    force: true,
    errorOnExist: false,
  })
}