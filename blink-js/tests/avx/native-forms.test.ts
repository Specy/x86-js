// VEX instructions Blink runs with handlers of their own: the AVX and AVX2 additions and the SSE4
// instructions that exist for the programs that use them through VEX.
import { describe, it } from 'vitest'
import { checkAgainstNative, NATIVE_AVX, type DataKind, type VectorCase } from './harness'

const three = (name: string, kind: DataKind = 'bytes', imm = '', wide = true): VectorCase[] => {
    const tail = imm ? `, ${imm}` : ''
    const cases: VectorCase[] = [
        { asm: `${name} xmm0, xmm1, xmm2${tail}`, kind },
        { asm: `${name} xmm0, xmm0, xmm2${tail}`, kind },
        { asm: `${name} xmm0, xmm1, [rel mem + 1]${tail}`, kind },
    ]
    if (wide) {
        cases.push(
            { asm: `${name} ymm0, ymm1, ymm2${tail}`, kind },
            { asm: `${name} ymm0, ymm0, ymm2${tail}`, kind },
            { asm: `${name} ymm0, ymm1, ymm0${tail}`, kind },
            { asm: `${name} ymm0, ymm1, [rel mem]${tail}`, kind },
            { asm: `${name} ymm0, ymm1, [rel mem + 5]${tail}`, kind },
        )
    }
    return cases
}
const two = (name: string, kind: DataKind = 'bytes', imm = '', wide = true): VectorCase[] => {
    const tail = imm ? `, ${imm}` : ''
    const cases: VectorCase[] = [
        { asm: `${name} xmm0, xmm1${tail}`, kind },
        { asm: `${name} xmm0, [rel mem + 1]${tail}`, kind },
    ]
    if (wide) {
        cases.push(
            { asm: `${name} ymm0, ymm1${tail}`, kind },
            { asm: `${name} ymm0, ymm0${tail}`, kind },
            { asm: `${name} ymm0, [rel mem + 3]${tail}`, kind },
        )
    }
    return cases
}

describe.skipIf(!NATIVE_AVX)('SSE4 integer instructions through VEX', () => {
    it('minimum, maximum, multiply and compare', async () => {
        const names = ['vpminsb', 'vpminsd', 'vpminuw', 'vpminud', 'vpmaxsb', 'vpmaxsd', 'vpmaxuw', 'vpmaxud', 'vpmuldq',
            'vpcmpeqq', 'vpcmpgtq', 'vpackusdw']
        await checkAgainstNative(names.flatMap((name) => three(name, 'i32')))
    })
    it('variable shifts', async () => {
        const names = ['vpsllvd', 'vpsrlvd', 'vpsravd', 'vpsllvq', 'vpsrlvq']
        await checkAgainstNative(names.flatMap((name) => three(name, name.endsWith('q') ? 'i64' : 'i32')))
    })
    it('vphminposuw and vmpsadbw', async () => {
        await checkAgainstNative([...two('vphminposuw', 'bytes', '', false),
            ...[0, 1, 2, 3, 4, 5, 7, 9, 63].flatMap((imm) => three('vmpsadbw', 'bytes', `${imm}`))])
    })
    it('sign and zero extension', async () => {
        const names = ['bw', 'bd', 'bq', 'wd', 'wq', 'dq']
        const forms = (name: string): VectorCase[] => [
            { asm: `${name} xmm0, xmm1` }, { asm: `${name} xmm0, xmm0` }, { asm: `${name} ymm0, xmm1` },
            { asm: `${name} ymm0, xmm0` }, { asm: `${name} xmm0, [rel mem + 1]` }, { asm: `${name} ymm0, [rel mem + 3]` },
        ]
        await checkAgainstNative(names.flatMap((n) => [...forms(`vpmovsx${n}`), ...forms(`vpmovzx${n}`)]))
    })
})

describe.skipIf(!NATIVE_AVX)('floating point instructions through VEX', () => {
    it('compares with all thirty-two predicates', async () => {
        const cases: VectorCase[] = []
        for (let imm = 0; imm < 32; imm++) {
            cases.push(...three('vcmpps', 'f32n', `${imm}`), ...three('vcmppd', 'f64n', `${imm}`))
            for (const [name, kind] of [['vcmpss', 'f32n'], ['vcmpsd', 'f64n']] as const) {
                cases.push({ asm: `${name} xmm0, xmm1, xmm2, ${imm}`, kind }, { asm: `${name} xmm0, xmm0, xmm2, ${imm}`, kind },
                    { asm: `${name} xmm0, xmm1, [rel mem], ${imm}`, kind })
            }
        }
        await checkAgainstNative(cases)
    })
    it('rounding', async () => {
        const cases: VectorCase[] = []
        for (const imm of [0, 1, 2, 3, 4, 8, 9, 10, 11, 12]) {
            cases.push(...two('vroundps', 'f32n', `${imm}`), ...two('vroundpd', 'f64n', `${imm}`))
            for (const [name, kind] of [['vroundss', 'f32n'], ['vroundsd', 'f64n']] as const) {
                cases.push({ asm: `${name} xmm0, xmm1, xmm2, ${imm}`, kind }, { asm: `${name} xmm0, xmm0, xmm2, ${imm}`, kind },
                    { asm: `${name} xmm0, xmm1, [rel mem], ${imm}`, kind })
            }
        }
        await checkAgainstNative(cases)
    })
    it('dot products', async () => {
        const cases: VectorCase[] = []
        for (const imm of [0xff, 0x71, 0x31, 0xf1, 0x0f, 0x5a, 0x00]) cases.push(...three('vdpps', 'f32', `${imm}`))
        for (const imm of [0xff, 0x31, 0x13, 0x23, 0x00]) cases.push(...three('vdppd', 'f64', `${imm}`, false))
        await checkAgainstNative(cases)
    })
    it('half precision conversion', async () => {
        const cases: VectorCase[] = [...two('vcvtph2ps', 'bytes', '', false)]
        cases.push({ asm: 'vcvtph2ps ymm0, xmm1' }, { asm: 'vcvtph2ps ymm0, [rel mem + 2]' })
        for (const imm of [0, 1, 2, 3, 4]) {
            cases.push({ asm: `vcvtps2ph xmm0, xmm1, ${imm}`, kind: 'f32n' }, { asm: `vcvtps2ph xmm0, ymm1, ${imm}`, kind: 'f32n' },
                { asm: `vcvtps2ph [rel mem], xmm1, ${imm}`, kind: 'f32n' }, { asm: `vcvtps2ph [rel mem + 1], ymm1, ${imm}`, kind: 'f32n' })
        }
        await checkAgainstNative(cases)
    })
})

describe.skipIf(!NATIVE_AVX)('moving data around the vector through VEX', () => {
    it('blends', async () => {
        const cases: VectorCase[] = []
        for (const imm of [0, 0x0f, 0xa5, 0xff, 0x3c, 0x81]) {
            cases.push(...three('vblendps', 'f32', `${imm}`), ...three('vpblendw', 'bytes', `${imm}`), ...three('vpblendd', 'i32', `${imm}`))
            cases.push(...three('vblendpd', 'f64', `${imm & 15}`))
        }
        for (const name of ['vblendvps', 'vblendvpd', 'vpblendvb']) {
            cases.push({ asm: `${name} xmm0, xmm1, xmm2, xmm3` }, { asm: `${name} ymm0, ymm1, ymm2, ymm3` },
                { asm: `${name} ymm0, ymm1, [rel mem], ymm3` }, { asm: `${name} ymm0, ymm0, ymm1, ymm0` },
                { asm: `${name} xmm0, xmm1, [rel mem + 1], xmm2` })
        }
        await checkAgainstNative(cases)
    })
    it('permutations', async () => {
        const cases: VectorCase[] = [...three('vpermilps', 'i32'), ...three('vpermilpd', 'i64')]
        for (const imm of [0, 0x1b, 0xe4, 0x55, 0xff]) {
            cases.push(...two('vpermilps', 'i32', `${imm}`), ...two('vpermilpd', 'i64', `${imm & 15}`),
                ...two('vpermq', 'i64', `${imm}`, false).filter((c) => c.asm.includes('ymm')),
                { asm: `vpermq ymm0, ymm1, ${imm}`, kind: 'i64' }, { asm: `vpermpd ymm0, [rel mem + 3], ${imm}`, kind: 'f64n' },
                { asm: `vpermq ymm0, ymm0, ${imm}`, kind: 'i64' })
        }
        for (const imm of [0x00, 0x01, 0x10, 0x11, 0x20, 0x31, 0x08, 0x80, 0x83, 0x28, 0xa5]) {
            cases.push({ asm: `vperm2f128 ymm0, ymm1, ymm2, ${imm}` }, { asm: `vperm2i128 ymm0, ymm1, [rel mem], ${imm}` },
                { asm: `vperm2f128 ymm0, ymm0, ymm0, ${imm}` })
        }
        cases.push({ asm: 'vpermd ymm0, ymm1, ymm2', kind: 'i32' }, { asm: 'vpermd ymm0, ymm1, [rel mem + 1]', kind: 'i32' },
            { asm: 'vpermps ymm0, ymm1, ymm2', kind: 'i32' }, { asm: 'vpermd ymm0, ymm0, ymm0', kind: 'i32' })
        await checkAgainstNative(cases)
    })
    it('lane inserts and extracts', async () => {
        const cases: VectorCase[] = []
        for (const imm of [0, 1]) {
            for (const name of ['vinsertf128', 'vinserti128']) {
                cases.push({ asm: `${name} ymm0, ymm1, xmm2, ${imm}` }, { asm: `${name} ymm0, ymm0, xmm2, ${imm}` },
                    { asm: `${name} ymm0, ymm1, [rel mem + 1], ${imm}` })
            }
            for (const name of ['vextractf128', 'vextracti128']) {
                cases.push({ asm: `${name} xmm0, ymm1, ${imm}` }, { asm: `${name} [rel mem], ymm1, ${imm}` },
                    { asm: `${name} [rel mem + 3], ymm2, ${imm}` }, { asm: `${name} xmm1, ymm1, ${imm}` })
            }
        }
        await checkAgainstNative(cases)
    })
    it('broadcasts', async () => {
        const cases: VectorCase[] = []
        for (const name of ['vbroadcastss', 'vpbroadcastb', 'vpbroadcastw', 'vpbroadcastd', 'vpbroadcastq']) {
            cases.push({ asm: `${name} xmm0, xmm1` }, { asm: `${name} xmm0, xmm0` }, { asm: `${name} ymm0, xmm1` },
                { asm: `${name} xmm0, [rel mem + 1]` }, { asm: `${name} ymm0, [rel mem + 3]` })
        }
        cases.push({ asm: 'vbroadcastsd ymm0, xmm1' }, { asm: 'vbroadcastsd ymm0, [rel mem + 1]' },
            { asm: 'vbroadcastf128 ymm0, [rel mem + 1]' }, { asm: 'vbroadcasti128 ymm0, [rel mem]' })
        await checkAgainstNative(cases)
    })
    it('element inserts and extracts', async () => {
        const cases: VectorCase[] = []
        for (let imm = 0; imm < 16; imm++) {
            cases.push({ asm: `vpinsrb xmm0, xmm1, ecx, ${imm}` }, { asm: `vpinsrb xmm0, xmm1, byte [rel mem], ${imm}` },
                { asm: `vpextrb eax, xmm1, ${imm}` }, { asm: `vpextrb [rel mem], xmm1, ${imm}` })
        }
        for (let imm = 0; imm < 8; imm++) {
            cases.push({ asm: `vpextrw [rel mem], xmm1, ${imm}` }, { asm: `vpextrw eax, xmm1, ${imm}` })
        }
        for (let imm = 0; imm < 4; imm++) {
            cases.push({ asm: `vpinsrd xmm0, xmm1, ecx, ${imm}` }, { asm: `vpinsrd xmm0, xmm0, dword [rel mem], ${imm}` },
                { asm: `vpextrd eax, xmm1, ${imm}` }, { asm: `vpextrd [rel mem], xmm1, ${imm}` },
                { asm: `vextractps eax, xmm1, ${imm}` }, { asm: `vextractps [rel mem], xmm1, ${imm}` })
        }
        for (let imm = 0; imm < 2; imm++) {
            cases.push({ asm: `vpinsrq xmm0, xmm1, rcx, ${imm}` }, { asm: `vpinsrq xmm0, xmm1, qword [rel mem], ${imm}` },
                { asm: `vpextrq rax, xmm1, ${imm}` }, { asm: `vpextrq [rel mem], xmm1, ${imm}` })
        }
        for (const imm of [0x00, 0x10, 0x4d, 0x8f, 0xc0, 0xff, 0x35, 0x2a, 0x91]) {
            cases.push({ asm: `vinsertps xmm0, xmm1, xmm2, ${imm}` }, { asm: `vinsertps xmm0, xmm0, xmm0, ${imm}` },
                { asm: `vinsertps xmm0, xmm1, [rel mem + 1], ${imm}` })
        }
        await checkAgainstNative(cases)
    })
    it('tests that set the flags', async () => {
        const cases: VectorCase[] = []
        for (const name of ['vptest', 'vtestps', 'vtestpd']) {
            for (const kind of ['bytes', 'i64'] as const) {
                cases.push(...two(name, kind), { asm: `${name} ymm0, ymm0`, kind }, { asm: `${name} xmm1, xmm1`, kind })
            }
        }
        await checkAgainstNative(cases)
    })
    it('masked moves', async () => {
        const cases: VectorCase[] = []
        for (const [load, store, kind] of [['vmaskmovps', 'vmaskmovps', 'i32'], ['vmaskmovpd', 'vmaskmovpd', 'i64'],
            ['vpmaskmovd', 'vpmaskmovd', 'i32'], ['vpmaskmovq', 'vpmaskmovq', 'i64']] as const) {
            cases.push({ asm: `${load} xmm0, xmm1, [rel mem]`, kind }, { asm: `${load} ymm0, ymm1, [rel mem + 4]`, kind },
                { asm: `${store} [rel mem], xmm1, xmm2`, kind }, { asm: `${store} [rel mem + 4], ymm1, ymm2`, kind },
                { asm: `${store} [rel mem], ymm0, ymm0`, kind })
        }
        await checkAgainstNative(cases)
    })
})

describe.skipIf(!NATIVE_AVX)('AES', () => {
    it('rounds, inverse mix and key assist', async () => {
        const cases: VectorCase[] = []
        for (const name of ['vaesenc', 'vaesenclast', 'vaesdec', 'vaesdeclast']) cases.push(...three(name, 'bytes', '', false))
        cases.push(...two('vaesimc', 'bytes', '', false))
        for (const imm of [0, 1, 0x1b, 0x36, 0xff]) cases.push(...two('vaeskeygenassist', 'bytes', `${imm}`, false))
        await checkAgainstNative(cases)
    })
})

describe.skipIf(!NATIVE_AVX)('string compares', () => {
    it('every aggregation, polarity and format', async () => {
        const cases: VectorCase[] = []
        // strings shorter than the vector, so that the lengths matter
        const shorten = 'mov eax, 5\nmov edx, 9\n'
        for (const unit of [0, 1, 2, 3]) {
            for (const aggregation of [0, 1, 2, 3]) {
                for (const polarity of [0, 1, 2, 3]) {
                    for (const output of [0, 0x40]) {
                        const imm = unit | aggregation << 2 | polarity << 4 | output
                        for (const [name, setup] of [['vpcmpestri', shorten], ['vpcmpestrm', shorten], ['vpcmpistri', ''], ['vpcmpistrm', '']] as const) {
                            cases.push({ asm: `${setup}${name} xmm1, xmm2, ${imm}`, kind: 'bytes' })
                            cases.push({ asm: `${setup}${name} xmm1, [rel mem + 2], ${imm}`, kind: 'bytes' })
                        }
                    }
                }
            }
        }
        await checkAgainstNative(cases)
    })
    it('explicit lengths at and beyond the bounds', async () => {
        const cases: VectorCase[] = []
        for (const length of [0, 1, 7, 8, 15, 16, 17, -1, -9, 100]) {
            for (const imm of [0x00, 0x08, 0x0c, 0x18, 0x1c, 0x45, 0x4a]) {
                cases.push({ asm: `mov eax, ${length}\nmov edx, ${length - 3}\nvpcmpestri xmm1, xmm2, ${imm}` },
                    { asm: `mov eax, ${length}\nmov edx, ${length - 3}\nvpcmpestrm xmm1, xmm2, ${imm}` } )
            }
        }
        // with VEX.W1 the lengths are rax and rdx; the most negative one saturates like the others
        for (const [rax, rdx] of [['0x8000000000000000', '5'], ['3', '0x8000000000000000'], ['-1', '0x7fffffffffffffff']]) {
            for (const imm of [0x00, 0x0c, 0x18, 0x41]) {
                // vpcmpestri xmm1, xmm2, imm and vpcmpestrm xmm1, xmm2, imm with W1
                cases.push({ asm: `mov rax, ${rax}\nmov rdx, ${rdx}\ndb 0xc4, 0xe3, 0xf9, 0x61, 0xca, ${imm}` },
                    { asm: `mov rax, ${rax}\nmov rdx, ${rdx}\ndb 0xc4, 0xe3, 0xf9, 0x60, 0xca, ${imm}` })
            }
        }
        await checkAgainstNative(cases)
    })
})
