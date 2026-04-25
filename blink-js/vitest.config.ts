import { readFile } from 'node:fs/promises'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [inlineWasmInitPlugin()],
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
  },
})

function inlineWasmInitPlugin() {
  return {
    name: 'inline-wasm-init-for-vitest',
    enforce: 'pre' as const,
    async load(id: string) {
      const [file, query = ''] = id.split('?')
      if (!file.endsWith('.wasm') || !new URLSearchParams(query).has('init')) return null

      const source = await readFile(file)
      const base64 = source.toString('base64')
      return `
import { Buffer } from 'node:buffer'

const wasmBase64 = ${JSON.stringify(base64)}

export default async function initWasm(imports = {}) {
  const bytes = Buffer.from(wasmBase64, 'base64')
  const { instance } = await WebAssembly.instantiate(bytes, imports)
  return instance
}
`
    },
  }
}