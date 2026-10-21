// Fused multiply-add, gathers and BMI, against the host.
import { describe, it } from 'vitest'
import { checkAgainstNative, NATIVE_AVX, type DataKind, type VectorCase } from './harness'

const FMA_KINDS = ['madd', 'msub', 'nmadd', 'nmsub']
const ORDERS = ['132', '213', '231']

describe.skipIf(!NATIVE_AVX)('fused multiply-add', () => {
    it('NaN operands and invalid products', async () => {
        const cases: VectorCase[] = []
        for (const name of ['vfmadd132ps', 'vfmsub213ps', 'vfnmadd231ps', 'vfnmsub132ps', 'vfmaddsub213ps']) {
            cases.push({ asm: `${name} ymm0, ymm1, ymm2`, kind: 'f32n' }, { asm: `${name} xmm0, xmm1, [rel mem + 1]`, kind: 'f32n' })
        }
        for (const name of ['vfmadd132pd', 'vfmsub213pd', 'vfnmadd231pd', 'vfnmsub132pd']) {
            cases.push({ asm: `${name} ymm0, ymm1, ymm2`, kind: 'f64n' }, { asm: `${name} xmm0, xmm1, [rel mem + 3]`, kind: 'f64n' })
        }
        for (const name of ['vfmadd213ss', 'vfnmsub231ss']) cases.push({ asm: `${name} xmm0, xmm1, xmm2`, kind: 'f32n' })
        for (const name of ['vfmadd213sd', 'vfnmsub231sd']) cases.push({ asm: `${name} xmm0, xmm1, xmm2`, kind: 'f64n' })
        await checkAgainstNative(cases.flatMap((c, i) => [c, ...[1, 2, 3, 4, 5, 6].map((seed) => ({ ...c, seed: seed * 977 + i }))]))
    })
    it('packed and scalar forms in every order', async () => {
        const cases: VectorCase[] = []
        for (const order of ORDERS) {
            for (const kind of FMA_KINDS) {
                for (const [suffix, data] of [['ps', 'f32'], ['pd', 'f64']] as const) {
                    const name = `vf${kind}${order}${suffix}`
                    cases.push(...[
                        `${name} xmm0, xmm1, xmm2`, `${name} ymm0, ymm1, ymm2`, `${name} ymm0, ymm0, ymm2`,
                        `${name} ymm0, ymm1, ymm0`, `${name} ymm0, ymm1, ymm1`, `${name} xmm0, xmm1, [rel mem + 1]`,
                        `${name} ymm0, ymm1, [rel mem + 3]`,
                    ].map((asm) => ({ asm, kind: data })))
                }
                for (const [suffix, data] of [['ss', 'f32'], ['sd', 'f64']] as const) {
                    const name = `vf${kind}${order}${suffix}`
                    cases.push(...[
                        `${name} xmm0, xmm1, xmm2`, `${name} xmm0, xmm0, xmm2`, `${name} xmm0, xmm1, xmm0`,
                        `${name} xmm0, xmm1, [rel mem + 1]`,
                    ].map((asm) => ({ asm, kind: data })))
                }
            }
            for (const name of ['vfmaddsub', 'vfmsubadd']) {
                for (const [suffix, data] of [['ps', 'f32'], ['pd', 'f64']] as const) {
                    cases.push(...[
                        `${name}${order}${suffix} xmm0, xmm1, xmm2`, `${name}${order}${suffix} ymm0, ymm1, ymm2`,
                        `${name}${order}${suffix} ymm0, ymm1, [rel mem + 2]`,
                    ].map((asm) => ({ asm, kind: data as DataKind })))
                }
            }
        }
        await checkAgainstNative(cases)
    })
})

describe.skipIf(!NATIVE_AVX)('gathers', () => {
    it('gather every width with a random mask', async () => {
        const prelude = (shift: string, wide: string) => `lea rax, [rel mem]\n${shift} ${wide}, ${wide}, ${wide === 'ymm1' ? (shift === 'vpsrld' ? 29 : 61) : shift === 'vpsrld' ? 29 : 61}`
        const cases: VectorCase[] = []
        for (const [name, kind] of [['vpgatherdd', 'i32'], ['vgatherdps', 'f32']] as const) {
            cases.push(
                { asm: `${prelude('vpsrld', 'xmm1')}\n${name} xmm0, [rax + xmm1*4], xmm2`, kind },
                { asm: `${prelude('vpsrld', 'ymm1')}\n${name} ymm0, [rax + ymm1*4], ymm2`, kind },
                { asm: `${prelude('vpsrld', 'ymm1')}\n${name} ymm0, [rax + ymm1*2 + 8], ymm2`, kind },
            )
        }
        for (const [name, kind] of [['vpgatherdq', 'i64'], ['vgatherdpd', 'f64']] as const) {
            cases.push(
                { asm: `${prelude('vpsrld', 'xmm1')}\n${name} xmm0, [rax + xmm1*8], xmm2`, kind },
                { asm: `${prelude('vpsrld', 'xmm1')}\n${name} ymm0, [rax + xmm1*8], ymm2`, kind },
            )
        }
        for (const [name, kind] of [['vpgatherqd', 'i32'], ['vgatherqps', 'f32']] as const) {
            cases.push(
                { asm: `${prelude('vpsrlq', 'xmm1')}\n${name} xmm0, [rax + xmm1*4], xmm2`, kind },
                { asm: `${prelude('vpsrlq', 'ymm1')}\n${name} xmm0, [rax + ymm1*4], xmm2`, kind },
            )
        }
        for (const [name, kind] of [['vpgatherqq', 'i64'], ['vgatherqpd', 'f64']] as const) {
            cases.push(
                { asm: `${prelude('vpsrlq', 'xmm1')}\n${name} xmm0, [rax + xmm1*8], xmm2`, kind },
                { asm: `${prelude('vpsrlq', 'ymm1')}\n${name} ymm0, [rax + ymm1*8], ymm2`, kind },
            )
        }
        await checkAgainstNative(cases)
    })
})

const BMI_FLAGS = 0x8c1
describe.skipIf(!NATIVE_AVX)('BMI1 and BMI2', () => {
    it('andn and the bit-isolating group', async () => {
        const cases: VectorCase[] = []
        for (const setup of ['', 'xor ecx, ecx\n', 'mov rcx, -1\n', 'mov ecx, 0x80000000\n']) {
            cases.push(
                { asm: `${setup}andn eax, ecx, edx`, flags: BMI_FLAGS }, { asm: `${setup}andn rax, rcx, rdx`, flags: BMI_FLAGS },
                { asm: `${setup}andn rax, rcx, [rel mem]`, flags: BMI_FLAGS }, { asm: `${setup}andn eax, ecx, dword [rel mem]`, flags: BMI_FLAGS },
            )
            for (const name of ['blsr', 'blsmsk', 'blsi']) {
                cases.push(
                    { asm: `${setup}${name} eax, ecx`, flags: BMI_FLAGS }, { asm: `${setup}${name} rax, rcx`, flags: BMI_FLAGS },
                    { asm: `${setup}${name} rax, [rel mem]`, flags: BMI_FLAGS }, { asm: `${setup}${name} eax, edx`, flags: BMI_FLAGS },
                )
            }
        }
        await checkAgainstNative(cases)
    })
    it('bzhi, bextr, pdep and pext', async () => {
        const cases: VectorCase[] = []
        for (const n of [0, 1, 7, 31, 32, 33, 63, 64, 200]) {
            cases.push({ asm: `mov edx, ${n}\nbzhi eax, ecx, edx`, flags: BMI_FLAGS }, { asm: `mov edx, ${n}\nbzhi rax, rcx, rdx`, flags: BMI_FLAGS },
                { asm: `mov edx, ${n}\nbzhi rax, [rel mem], rdx`, flags: BMI_FLAGS })
        }
        for (const control of [0x0800, 0x0804, 0x1004, 0x2000, 0x4010, 0x0821, 0x8008, 0xff00, 0x4000]) {
            cases.push({ asm: `mov edx, ${control}\nbextr eax, ecx, edx`, flags: 0x841 }, { asm: `mov edx, ${control}\nbextr rax, rcx, rdx`, flags: 0x841 },
                { asm: `mov edx, ${control}\nbextr rax, [rel mem], rdx`, flags: 0x841 })
        }
        cases.push({ asm: 'pdep eax, ecx, edx' }, { asm: 'pdep rax, rcx, rdx' }, { asm: 'pdep rax, rcx, [rel mem]' },
            { asm: 'pext eax, ecx, edx' }, { asm: 'pext rax, rcx, rdx' }, { asm: 'pext rax, rcx, [rel mem]' },
            { asm: 'mov edx, 0xff00ff00\npdep eax, ecx, edx' }, { asm: 'mov edx, 0xf0f0f0f0\npext eax, ecx, edx' })
        await checkAgainstNative(cases)
    })
    it('mulx, shifts and rotates', async () => {
        const cases: VectorCase[] = [{ asm: 'mulx rax, rcx, rdx' }, { asm: 'mulx eax, ecx, edx' }, { asm: 'mulx rax, rcx, [rel mem]' },
            { asm: 'mulx rax, rax, rdx' }, { asm: 'mulx eax, ecx, dword [rel mem]' }]
        for (const name of ['shlx', 'shrx', 'sarx']) {
            for (const n of [0, 1, 5, 31, 32, 33, 63, 64, 65, 200]) {
                cases.push({ asm: `mov ecx, ${n}\n${name} eax, edx, ecx` }, { asm: `mov ecx, ${n}\n${name} rax, rdx, rcx` },
                    { asm: `mov ecx, ${n}\n${name} rax, [rel mem], rcx` })
            }
        }
        for (const n of [0, 1, 5, 31, 32, 63, 64, 255]) {
            cases.push({ asm: `rorx eax, ecx, ${n}` }, { asm: `rorx rax, rcx, ${n}` }, { asm: `rorx rax, [rel mem], ${n}` })
        }
        await checkAgainstNative(cases)
    })
})
