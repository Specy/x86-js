


/**
 * Returns the keys of an enum
 * @template T - Enum type
 * @param {T} e - Enum object
 * @returns {string[]} Array of enum keys
 */
export function enumKeys<T extends object>(e: T) {
    const keys = Object.keys(e)
    const isStringEnum = isNaN(Number(keys[0]))
    return isStringEnum ? keys : keys.slice(keys.length / 2)
}