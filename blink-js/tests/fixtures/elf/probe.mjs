// Development measurement only; the committed tests use bundled assets after M3.
import { readFileSync } from 'node:fs'
import { createX86Emulator } from '../../../dist/index.mjs'

const name = process.argv[2] ?? 'cpp'
const emulator = await createX86Emulator()
const originalWrite = emulator.runtime.writeExecutableSync.bind(emulator.runtime)
emulator.runtime.writeExecutableSync = (path, bytes) => {
  originalWrite(path, bytes)
  if (path !== '/program') return
  for (const soname of ['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']) {
    const target = soname.startsWith('ld-') ? `/lib64/${soname}` : `/lib/x86_64-linux-gnu/${soname}`
    emulator.module.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')))
    originalWrite(target, readFileSync(`/usr/lib/x86_64-linux-gnu/${soname}`))
  }
}
let output = ''
emulator.on('stdout', (bytes) => { output += new TextDecoder().decode(bytes) })
emulator.on('stderr', (bytes) => { output += new TextDecoder().decode(bytes) })
emulator.loadElf(readFileSync(new URL(name, import.meta.url)))
emulator.initialize(0)
const heap = () => emulator.module.wasmExports.memory.buffer.byteLength
const before = heap()
try {
  await emulator.run(2_000_000)
  if (emulator.stopReason?.kind === 'input') {
    await emulator.provideInput('hunter2\n')
    await emulator.run(2_000_000)
  }
} catch (error) { console.log('error:', String(error)) }
console.log(JSON.stringify({ name, before, after: heap(), growth: heap() - before, output, stop: emulator.stopReason }, (_, value) => typeof value === 'bigint' ? String(value) : value))
try { emulator.dispose() } catch (error) { console.log("dispose:", String(error)) }
