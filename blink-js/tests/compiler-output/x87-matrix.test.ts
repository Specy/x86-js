// The x87 matrix (milestone 1): `fadd`, `fsub`, `fsubr`, `fmul`, `fdiv` and `fdivr`, popping and
// not, with `st(0)` as destination and as source, each a small GNU-syntax program whose operands
// (10 and 4) give a different result in each order. Assemblers have historically disagreed about
// the non-commutative forms with an `st(i)` destination, so no form is inferred: each translated
// form must compute its intended value in Blink and natively, and encode as the GNU as build of
// the same program, stored at capture time, did.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createX86Emulator, type X86Emulator } from '../../src/x86-emulator'
import {
    errors,
    linkedProgram,
    loadManifest,
    loadX87Forms,
    NATIVE,
    programBytes,
    removeNativeScratch,
    runInBlink,
    runNatively,
    translatedProject,
    translateOrThrow,
    warnings,
    type X87Form,
} from './helpers'

const manifest = loadManifest()
const forms = loadX87Forms()

let emulator: X86Emulator

beforeAll(async () => {
    emulator = await createX86Emulator()
})

afterAll(() => {
    emulator?.dispose()
    removeNativeScratch()
})

function hex(bytes: Uint8Array): string {
    return [...bytes].map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function referenceProgram(form: X87Form): Uint8Array {
    return Uint8Array.from(Buffer.from(form.reference.elf!, 'base64'))
}

describe('the stored x87 matrix', () => {
    it('holds the 36 forms of the manifest, built by GNU as with the intended results natively', () => {
        const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)
        expect(forms.map(({ name, intended }) => ({ name, intended })).sort(byName)).toEqual(
            manifest.x87Matrix.forms.map(({ name, intended }) => ({ name, intended })).sort(byName),
        )
        expect(forms).toHaveLength(36)
        for (const form of forms) {
            expect(form.reference.status, form.name).toBe('built')
            // Hardware's answer for the GNU build. The capture stores no Blink result, which a fix to
            // Blink (such as the one to its `fdiv`, `fdivr` and `fsubp` register forms) would make
            // stale: the reference is run in Blink below instead.
            expect(form.reference.native?.status, form.name).toBe(form.intended)
            expect(Object.keys(form.reference), form.name).not.toContain('blink')
        }
    })
})

/** A form translated and built beside the start unit once, for all of its tests. */
type BuiltForm = { readonly program: Uint8Array; readonly encoding: Uint8Array }
const builds = new Map<string, Promise<BuiltForm>>()

function built(form: X87Form): Promise<BuiltForm> {
    let build = builds.get(form.name)
    if (!build) {
        build = buildForm(form)
        builds.set(form.name, build)
    }
    return build
}

async function buildForm(form: X87Form): Promise<BuiltForm> {
    const translation = translateOrThrow(form.input)
    // Hand-written, so no `.ident` names GCC 14.2; nothing else may be said about it.
    expect(translation.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['unverified-compiler'])
    const project = translatedProject('x87/main.s', translation.text)
    const result = await emulator.compileProject(project)
    expect(warnings(result)).toEqual([])
    if (!result.ok) throw new Error(`the build failed:\n${errors(result)}`)
    const instruction = emulator
        .getCompiledInstructions()
        .find(
            (candidate) =>
                candidate.file === project.entry &&
                translation.lines[candidate.lineNumber]?.inputLine === form.formLine,
        )
    if (!instruction?.bytes)
        throw new Error(`no instruction of the translated build comes from input line ${form.formLine}`)
    return { program: linkedProgram(emulator), encoding: Uint8Array.from(instruction.bytes) }
}

describe.each(forms.map((form) => [form.instruction, form] as const))('%s', (_, form) => {
    it(`returns ${form.intended} in Blink`, async () => {
        const { program } = await built(form)
        emulator.loadElf(program)
        expect(await runInBlink(emulator)).toBe(form.intended)
    })

    it.skipIf(!NATIVE)(`returns ${form.intended} natively, as the GNU reference did`, async () => {
        const { program } = await built(form)
        expect(runNatively(program, `x87-${form.name}`).status).toBe(form.reference.native?.status)
    })

    it(`encodes as GNU as did, ${form.intelOpcode}`, async () => {
        const { encoding } = await built(form)
        const address = form.reference.instructions!.find(([, line]) => line === form.formLine)?.[0]
        expect(address).toBeDefined()
        const reference = programBytes(referenceProgram(form), BigInt(address!), encoding.length)
        expect(hex(encoding)).toBe(hex(reference))
        expect(hex(encoding)).toBe(form.intelOpcode)
        expect(form.reference.encoding).toBe(form.intelOpcode)
    })

    it(`runs the GNU reference to ${form.intended} in Blink too`, async () => {
        builds.delete(form.name)
        emulator.loadElf(referenceProgram(form))
        expect(await runInBlink(emulator)).toBe(form.intended)
    })
})
