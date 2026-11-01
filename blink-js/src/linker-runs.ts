/**
 * How many times a build ran `ld`, which a test reads to see a link reused. A module of its own,
 * outside the package's root, which re-exports all of `blink-runtime`.
 */
let runs = 0

export function countLinkerRun(): void {
    runs++
}

export function linkerRunCount(): number {
    return runs
}
