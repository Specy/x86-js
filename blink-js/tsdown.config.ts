import { wasm } from 'rolldown-plugin-wasm'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts'],
  plugins: [wasm({ targetEnv: 'auto-inline' })],
  dts: true,
  exports: {
    customExports: {
      '.': {
        types: './dist/index.d.mts',
        import: './dist/index.mjs',
        default: './dist/index.mjs',
      },
    },
  },
  format: ['esm'],
  clean: true,
  deps: {
    neverBundle: ['./wasm/blinkenlib.js'],
  },
})
