import { wasm } from 'rolldown-plugin-wasm'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    // The compiler-output translator imports nothing from the emulator, so its
    // bundle carries no wasm and a consumer that only translates never loads it.
    'compiler-output': './src/compiler-output/index.ts',
  },
  plugins: [wasm({ targetEnv: 'auto-inline' })],
  dts: true,
  exports: {
    customExports: {
      '.': {
        types: './dist/index.d.mts',
        import: './dist/index.mjs',
        default: './dist/index.mjs',
      },
      './compiler-output': {
        types: './dist/compiler-output.d.mts',
        import: './dist/compiler-output.mjs',
        default: './dist/compiler-output.mjs',
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
