import { wasm } from 'rolldown-plugin-wasm'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  plugins: [wasm({ targetEnv: 'auto-inline' })],
  dts: true,
  exports: true,
  format: ['esm'],
  clean: true,
  deps: {
    neverBundle: ['./wasm/blinkenlib.js'],
  },
})
