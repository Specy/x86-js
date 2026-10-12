import { readFileSync } from 'node:fs'
import { createX86Emulator } from '../src/x86-emulator'

export const elfFixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./fixtures/elf/${name}`, import.meta.url)))

/**
 * crackme with its text and read-only load segments' program headers (the 4th and 5th headers)
 * swapped: a file that is out of address order, which Blink's loader refuses with exit status 127.
 */
export function swappedLoadsFixture() {
    const bytes = elfFixture('crackme')
    const at = (index: number) => 64 + 56 * index
    const text = bytes.slice(at(3), at(4))
    bytes.copyWithin(at(3), at(4), at(5))
    bytes.set(text, at(4))
    return bytes
}

export async function fixtureEmulator(name: string, args: string[] = []) {
    const emulator = await createX86Emulator()
    await emulator.loadExecutable(elfFixture(name))
    emulator.setProgramArguments('/program', args)
    emulator.initialize(0)
    return emulator
}
