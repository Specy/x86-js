import { readFileSync } from 'node:fs'
import { createX86Emulator } from '../src/x86-emulator'

export const elfFixture = (name: string) =>
    new Uint8Array(readFileSync(new URL(`./fixtures/elf/${name}`, import.meta.url)))

export async function fixtureEmulator(name: string, args: string[] = []) {
    const emulator = await createX86Emulator()
    await emulator.loadExecutable(elfFixture(name))
    emulator.setProgramArguments('/program', args)
    emulator.initialize(0)
    return emulator
}
