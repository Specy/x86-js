export type MaybePromise<T> = T | PromiseLike<T>

export function observeCallbackResult(result: MaybePromise<void>): void {
    if (!isPromiseLike(result)) return
    void Promise.resolve(result).catch(reportAsyncCallbackError)
}

function isPromiseLike<T>(value: MaybePromise<T>): value is PromiseLike<T> {
    return (
        value !== undefined &&
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        typeof (value as PromiseLike<T>).then === 'function'
    )
}

function reportAsyncCallbackError(error: unknown): void {
    setTimeout(() => {
        throw error
    }, 0)
}
