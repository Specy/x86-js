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
    // Both are Emscripten modules that locate their own .wasm beside themselves
    // at runtime. nasm.wasm is 1.19MB, so it is fetched rather than inlined.
    neverBundle: ['./wasm/blinkenlib.js', './wasm/nasm.mjs'],
  },
})
