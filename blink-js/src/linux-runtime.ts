import { analyze } from './elf'
import { readResourceBytes } from './resources'

const libraries = [
    {
        soname: 'ld-linux-x86-64.so.2',
        path: '/lib64/ld-linux-x86-64.so.2',
        url: new URL('./assets/linux/ld-linux-x86-64.so.2', import.meta.url)
    },
    {
        soname: 'libc.so.6',
        path: '/lib/x86_64-linux-gnu/libc.so.6',
        url: new URL('./assets/linux/libc.so.6', import.meta.url)
    },
    {
        soname: 'libm.so.6',
        path: '/lib/x86_64-linux-gnu/libm.so.6',
        url: new URL('./assets/linux/libm.so.6', import.meta.url)
    },
    {
        soname: 'libstdc++.so.6',
        path: '/lib/x86_64-linux-gnu/libstdc++.so.6',
        url: new URL('./assets/linux/libstdc++.so.6', import.meta.url)
    },
    {
        soname: 'libgcc_s.so.1',
        path: '/lib/x86_64-linux-gnu/libgcc_s.so.1',
        url: new URL('./assets/linux/libgcc_s.so.1', import.meta.url)
    }
] as const

/** Each runtime retains only the libraries it needs; network fetches are shared. */
const fetched = new Map<string, Promise<Uint8Array>>()
export async function resolveLinuxLibraries(needed: string[], interpreter?: string) {
    const files = new Map<string, Uint8Array>()
    const missing = new Set<string>()
    const visited = new Set<string>()
    const queue = [...needed]
    if (interpreter) {
        const linker = libraries.find((library) => library.path === interpreter)
        if (linker) queue.unshift(linker.soname)
        else missing.add(interpreter)
    }
    for (let i = 0; i < queue.length; ++i) {
        const soname = queue[i]
        if (visited.has(soname)) continue
        visited.add(soname)
        const library = libraries.find((candidate) => candidate.soname === soname)
        if (!library) {
            missing.add(soname)
            continue
        }
        let promise = fetched.get(soname)
        if (!promise) {
            promise = readResourceBytes(library.url)
            fetched.set(soname, promise)
            promise.catch(() => {
                if (fetched.get(soname) === promise) fetched.delete(soname)
            })
        }
        const bytes = await promise
        files.set(library.path, bytes)
        queue.push(...analyze(bytes).needed)
    }
    return { files, missing: [...missing] }
}

export const X86_PROGRAM_ENVIRONMENT = [
    'PATH=/usr/local/bin:/usr/bin:/bin',
    'HOME=/project',
    'PWD=/project',
    'LANG=C.UTF-8',
    'TERM=xterm-256color',
    'SHELL=/bin/sh',
    'USER=user',
    'LOGNAME=user'
] as const

export function validateProgramArguments(argv0: string, args: readonly string[]): void {
    if (
        typeof argv0 !== 'string' ||
        !Array.isArray(args) ||
        args.some((arg) => typeof arg !== 'string')
    )
        throw new Error('Arguments must be UTF-8 strings')
    if (args.length > 1024) throw new Error('Arguments may contain at most 1,024 words')
    const words = [argv0, ...args]
    if (words.some((word) => word.includes('\0'))) throw new Error('Arguments cannot contain NUL')
    if (
        words.reduce((size, word) => size + new TextEncoder().encode(word).length + 1, 0) >
        128 * 1024
    )
        throw new Error('Arguments may contain at most 128 KiB')
}
