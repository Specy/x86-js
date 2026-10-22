export type ResourceSource = string | URL | ArrayBuffer | Uint8Array

/** How long a download may receive nothing before `readResourceBytes` gives it up. */
export const RESOURCE_STALL_TIMEOUT_MS = 20_000

/**
 * A resource `readResourceBytes` could not download: the request failed, the server refused it,
 * or nothing arrived for {@link RESOURCE_STALL_TIMEOUT_MS}. The message names the resource and
 * why, as in "Could not download libc.so.6: no data for 20 s".
 */
export class ResourceDownloadError extends Error {
    /**
     * The HTTP status the server refused the request with, such as 404 for a file a newer version
     * of the site no longer has; undefined when the request failed or stalled.
     */
    readonly status: number | undefined

    constructor(
        /** What the resource is called, as `ResourceReadOptions.name` gave it. */
        readonly resource: string,
        /** Why: "no data for 20 s", the network's own error, or the server's status. */
        readonly reason: string,
        options?: ErrorOptions & { status?: number }
    ) {
        super(`Could not download ${resource}: ${reason}`, options)
        this.name = 'ResourceDownloadError'
        this.status = options?.status
    }
}

export type ResourceReadOptions = {
    /**
     * What a download error calls the resource, such as a Bundled library's soname; by default the
     * last part of its URL, which a bundler may have renamed.
     */
    name?: string
}

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

/**
 * A resource's bytes as a plain Uint8Array, never a Node `Buffer`, whose `slice` would alias it.
 * A Uint8Array source is not copied. One that is downloaded throws a {@link ResourceDownloadError}
 * when the request fails, when the server answers with an error status, and when nothing arrives
 * for {@link RESOURCE_STALL_TIMEOUT_MS}, however long the whole download takes.
 */
export async function readResourceBytes(
    source: ResourceSource,
    options: ResourceReadOptions = {}
): Promise<Uint8Array> {
    if (source instanceof Uint8Array) return plainBytes(source)
    if (source instanceof ArrayBuffer) return new Uint8Array(source)

    if (typeof source === 'string' && isNodeRuntime()) {
        let url: URL | null = null
        try {
            url = new URL(source)
        } catch {
            const { readFile } = await import('node:fs/promises')
            const { resolve } = await import('node:path')
            return plainBytes(await readFile(resolve(source)))
        }
        if (url.protocol === 'file:') {
            const { readFile } = await import('node:fs/promises')
            const { fileURLToPath } = await import('node:url')
            return plainBytes(await readFile(fileURLToPath(url)))
        }
    }

    const url = toResourceUrl(source)
    if (isNodeRuntime() && url.protocol === 'file:') {
        const { readFile } = await import('node:fs/promises')
        const { fileURLToPath } = await import('node:url')
        return plainBytes(await readFile(fileURLToPath(url)))
    }

    return download(url, options.name ?? resourceName(url))
}

/**
 * Reads the body as it arrives, so that a download which stops sending ends after
 * `RESOURCE_STALL_TIMEOUT_MS` instead of waiting forever, while a slow one that keeps sending goes
 * on. The stall is raced against every wait rather than left to the request's own abort, which a
 * `fetch` given in its place need not honour.
 */
async function download(url: URL, name: string): Promise<Uint8Array> {
    const controller = new AbortController()
    let stallError: ResourceDownloadError | undefined
    let rejectStall: (error: ResourceDownloadError) => void = () => undefined
    const stall = new Promise<never>((_, reject) => {
        rejectStall = reject
    })
    stall.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const awaitData = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
            stallError = new ResourceDownloadError(
                name,
                `no data for ${RESOURCE_STALL_TIMEOUT_MS / 1000} s`
            )
            rejectStall(stallError)
            controller.abort(stallError)
        }, RESOURCE_STALL_TIMEOUT_MS)
    }
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
        awaitData()
        const response = await Promise.race([fetch(url, { signal: controller.signal }), stall])
        if (!response.ok) {
            void response.body?.cancel().catch(() => undefined)
            throw new ResourceDownloadError(
                name,
                `${response.status} ${response.statusText}`.trim(),
                { status: response.status }
            )
        }
        awaitData()
        if (!response.body) return new Uint8Array(await Promise.race([response.arrayBuffer(), stall]))
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let length = 0
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), stall])
            if (done) break
            chunks.push(value)
            length += value.byteLength
            awaitData()
        }
        reader = undefined
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
        }
        return bytes
    } catch (error) {
        void reader?.cancel().catch(() => undefined)
        if (stallError) throw stallError
        if (error instanceof ResourceDownloadError) throw error
        throw new ResourceDownloadError(
            name,
            error instanceof Error ? error.message : String(error),
            { cause: error }
        )
    } finally {
        clearTimeout(timer)
    }
}

/** The last part of a URL's path, which names the file. */
function resourceName(url: URL): string {
    const last = url.pathname.split('/').pop()
    return last ? decodeURIComponent(last) : url.href
}

/** The same memory as a plain Uint8Array, so `slice` copies as it does for any Uint8Array. */
function plainBytes(buffer: Uint8Array): Uint8Array {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

export function defaultResourceUrl(relativePath: string, baseUrl: string): URL {
    return new URL(relativePath, baseUrl)
}
