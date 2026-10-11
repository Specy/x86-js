import { readFileSync } from 'node:fs'
import { createX86Emulator } from '../src/x86-emulator'

export const elfFixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./fixtures/elf/${name}`, import.meta.url)))

/** Before the library-resolution API exists, stage assets after each FS reset. */
export async function fixtureEmulator(name: string, args: string[] = []) {
    const emulator = await createX86Emulator()
    const runtime = emulator.runtime as unknown as {
        writeExecutableSync(path: string, bytes: Uint8Array): void
        setEmulationArgs(path: string, argv0: string, argv: string): void
    }
    const write = runtime.writeExecutableSync.bind(runtime)
    runtime.writeExecutableSync = (path, bytes) => {
        write(path, bytes)
        if (path !== '/program') return
        for (const soname of ['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1']) {
            const target = soname.startsWith('ld-') ? `/lib64/${soname}` : `/lib/x86_64-linux-gnu/${soname}`
            emulator.module.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')))
            write(target, new Uint8Array(readFileSync(new URL(`../src/assets/linux/${soname}`, import.meta.url))))
        }
    }
    const setArgs = runtime.setEmulationArgs.bind(runtime)
    runtime.setEmulationArgs = (path, argv0, argv) => setArgs(path, path === '/program' ? ['/program', ...args].join(' ') : argv0, argv)
    emulator.loadElf(elfFixture(name))
    emulator.initialize(0)
    return emulator
}
