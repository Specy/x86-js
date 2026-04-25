export type ResourceSource = string | URL | ArrayBuffer | Uint8Array

export function isNodeRuntime(): boolean {
    return (
        typeof process !== 'undefined' &&
        typeof process.versions === 'object' &&
        typeof process.versions.node === 'string'
    )
}

export function toResourceUrl(source: string | URL): URL {
    if (source instanceof URL) return source
    try {
        return new URL(source)
    } catch {
        return new URL(source, globalThis.location?.href)
    }
}

export async function readResourceBytes(source: ResourceSource): Promise<Uint8Array> {
    if (source instanceof Uint8Array) return source
    if (source instanceof ArrayBuffer) return new Uint8Array(source)

    if (typeof source === 'string' && isNodeRuntime()) {
        try {
            const url = new URL(source)
            if (url.protocol === 'file:') {
                const { readFile } = await import('node:fs/promises')
                const { fileURLToPath } = await import('node:url')
                return readFile(fileURLToPath(url))
            }
        } catch {
            const { readFile } = await import('node:fs/promises')
            const { resolve } = await import('node:path')
            return readFile(resolve(source))
        }
    }

    const url = toResourceUrl(source)
    if (isNodeRuntime() && url.protocol === 'file:') {
        const { readFile } = await import('node:fs/promises')
        const { fileURLToPath } = await import('node:url')
        return readFile(fileURLToPath(url))
    }

    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`Failed to load resource ${url.href}: ${response.status} ${response.statusText}`)
    }
    return new Uint8Array(await response.arrayBuffer())
}

export function defaultResourceUrl(relativePath: string, baseUrl: string): URL {
    return new URL(relativePath, baseUrl)
}