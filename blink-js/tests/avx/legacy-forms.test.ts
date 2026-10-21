// VEX forms of the legacy SSE instructions Blink already runs. Each is checked against the host
// with register and memory operands, in 128 and 256 bits, and with destinations that alias a
// source.
import { describe, it } from 'vitest'
import { checkAgainstNative, NATIVE_AVX, type DataKind, type VectorCase } from './harness'

const operands = (name: string, kind: DataKind, imm = ''): VectorCase[] => {
    const tail = imm ? `, ${imm}` : ''
    return [
        { asm: `${name} xmm0, xmm1, xmm2${tail}`, kind },
        { asm: `${name} ymm0, ymm1, ymm2${tail}`, kind },
        { asm: `${name} ymm0, ymm0, ymm2${tail}`, kind },
        { asm: `${name} ymm0, ymm1, ymm0${tail}`, kind },
        { asm: `${name} ymm0, ymm1, ymm1${tail}`, kind },
        { asm: `${name} xmm0, xmm1, [rel mem]${tail}`, kind },
        { asm: `${name} ymm0, ymm1, [rel mem]${tail}`, kind },
        { asm: `${name} ymm0, ymm1, [rel mem + 3]${tail}`, kind },
    ]
}
const unary = (name: string, kind: DataKind, imm = ''): VectorCase[] => {
    const tail = imm ? `, ${imm}` : ''
    return [
        { asm: `${name} xmm0, xmm1${tail}`, kind },
        { asm: `${name} ymm0, ymm1${tail}`, kind },
        { asm: `${name} ymm0, ymm0${tail}`, kind },
        { asm: `${name} xmm0, [rel mem]${tail}`, kind },
        { asm: `${name} ymm0, [rel mem]${tail}`, kind },
        { asm: `${name} ymm0, [rel mem + 5]${tail}`, kind },
    ]
}
const scalar = (name: string, kind: DataKind): VectorCase[] => [
    { asm: `${name} xmm0, xmm1, xmm2`, kind },
    { asm: `${name} xmm0, xmm0, xmm2`, kind },
    { asm: `${name} xmm0, xmm1, xmm0`, kind },
    { asm: `${name} xmm0, xmm1, [rel mem]`, kind },
]

const INT_OPS = [
    'vpaddsb', 'vpaddsw', 'vpaddusb', 'vpaddusw', 'vpsubsb', 'vpsubsw', 'vpsubusb', 'vpsubusw', 'vpminub', 'vpmaxub',
    'vpminsw', 'vpmaxsw', 'vpmullw', 'vpmulhw', 'vpmulhuw', 'vpmuludq', 'vpmaddwd', 'vpsadbw', 'vpavgb', 'vpavgw',
    'vpunpcklbw', 'vpunpcklwd', 'vpunpckldq', 'vpunpcklqdq', 'vpunpckhbw', 'vpunpckhwd', 'vpunpckhdq', 'vpunpckhqdq',
    'vpacksswb', 'vpackuswb', 'vpackssdw', 'vpshufb', 'vphaddw', 'vphaddd', 'vphsubw', 'vphsubd', 'vphaddsw',
    'vphsubsw', 'vpmaddubsw', 'vpsignb', 'vpsignw', 'vpsignd', 'vpmulhrsw', 'vpmulld',
]
const FLOAT_PS = ['vaddps', 'vsubps', 'vmulps', 'vdivps', 'vminps', 'vmaxps', 'vandps', 'vandnps', 'vorps', 'vxorps',
    'vunpcklps', 'vunpckhps', 'vhaddps', 'vhsubps', 'vaddsubps']
const FLOAT_PD = ['vaddpd', 'vsubpd', 'vmulpd', 'vdivpd', 'vminpd', 'vmaxpd', 'vandpd', 'vandnpd', 'vorpd', 'vxorpd',
    'vunpcklpd', 'vunpckhpd', 'vhaddpd', 'vhsubpd', 'vaddsubpd']
// vrcpps, vrsqrtps and their scalar forms are left out: their results are approximations that
// differ between processors, so there is no host answer to compare with.
// The instructions that move bits and never compute with them, which may see NaNs.
const bitwise = (name: string) => /and|or|unpck|min|max/.test(name)
const SCALAR_SS = ['vaddss', 'vsubss', 'vmulss', 'vdivss', 'vminss', 'vmaxss', 'vsqrtss']
const SCALAR_SD = ['vaddsd', 'vsubsd', 'vmulsd', 'vdivsd', 'vminsd', 'vmaxsd', 'vsqrtsd']

describe.skipIf(!NATIVE_AVX)('VEX forms of legacy SSE instructions', () => {
    it('packed integer arithmetic, shuffles and packs', async () => {
        await checkAgainstNative(INT_OPS.flatMap((name) => operands(name, 'bytes')))
    })
    it('packed single precision', async () => {
        await checkAgainstNative(FLOAT_PS.flatMap((name) => operands(name, bitwise(name) ? 'f32n' : 'f32')))
    })
    it('packed double precision', async () => {
        await checkAgainstNative(FLOAT_PD.flatMap((name) => operands(name, bitwise(name) ? 'f64n' : 'f64')))
    })
    it('scalar single and double precision', async () => {
        await checkAgainstNative([
            ...SCALAR_SS.flatMap((name) => scalar(name, 'f32')),
            ...SCALAR_SD.flatMap((name) => scalar(name, 'f64')),
        ])
    })
    it('unary packed floats and conversions that keep the width', async () => {
        await checkAgainstNative([
            ...unary('vsqrtps', 'f32'),
            ...unary('vsqrtpd', 'f64'), ...unary('vcvtdq2ps', 'i32'), ...unary('vcvtps2dq', 'f32'),
            ...unary('vcvttps2dq', 'f32'), ...unary('vmovshdup', 'f32'), ...unary('vmovsldup', 'f32'),
            ...unary('vmovddup', 'f64'),
        ])
    })
    it('shifts by a count register', async () => {
        const names = ['vpsllw', 'vpslld', 'vpsllq', 'vpsrlw', 'vpsrld', 'vpsrlq', 'vpsraw', 'vpsrad']
        await checkAgainstNative(names.flatMap((name) => [
            { asm: `${name} xmm0, xmm1, xmm2` },
            { asm: `${name} ymm0, ymm1, xmm2` },
            { asm: `${name} ymm0, ymm0, xmm0` },
            { asm: `${name} ymm0, ymm1, xmm0` },
            { asm: `${name} ymm0, ymm1, xmm1` },
            { asm: `${name} ymm0, ymm1, [rel mem]` },
            { asm: `${name} xmm0, xmm1, [rel mem + 1]` },
        ]))
    })
    it('instructions with an immediate', async () => {
        const cases: VectorCase[] = []
        for (const imm of [0x00, 0x1b, 0xe4, 0xff, 0x93]) {
            cases.push(...unary('vpshufd', 'i32', `${imm}`), ...unary('vpshufhw', 'bytes', `${imm}`),
                ...unary('vpshuflw', 'bytes', `${imm}`), ...operands('vshufps', 'f32', `${imm}`),
                ...operands('vshufpd', 'f64', `${imm & 15}`))
        }
        for (const imm of [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 31]) {
            cases.push(...operands('vcmpps', 'f32n', `${imm}`), ...operands('vcmppd', 'f64n', `${imm}`))
            cases.push(...scalar('vcmpss', 'f32n').map((c) => ({ ...c, asm: `${c.asm}, ${imm}` })),
                ...scalar('vcmpsd', 'f64n').map((c) => ({ ...c, asm: `${c.asm}, ${imm}` })))
        }
        for (const imm of [0, 1, 2, 7, 15, 16, 31, 33]) {
            for (const op of ['vpsllw', 'vpslld', 'vpsllq', 'vpsrlw', 'vpsrld', 'vpsrlq', 'vpsraw', 'vpsrad']) {
                cases.push({ asm: `${op} xmm0, xmm1, ${imm}` }, { asm: `${op} ymm0, ymm1, ${imm}` },
                    { asm: `${op} ymm0, ymm0, ${imm}` })
            }
            cases.push({ asm: `vpslldq xmm0, xmm1, ${imm}` }, { asm: `vpslldq ymm0, ymm1, ${imm}` },
                { asm: `vpsrldq xmm0, xmm1, ${imm}` }, { asm: `vpsrldq ymm0, ymm1, ${imm}` })
        }
        for (const imm of [0, 3, 7]) {
            cases.push({ asm: `vpinsrw xmm0, xmm1, ecx, ${imm}` }, { asm: `vpinsrw xmm0, xmm1, [rel mem], ${imm}` },
                { asm: `vpextrw eax, xmm1, ${imm}` })
        }
        for (const imm of [0, 1, 5, 8, 15]) {
            cases.push(...operands('vpalignr', 'bytes', `${imm}`))
        }
        await checkAgainstNative(cases)
    })
    it('moves between registers and memory', async () => {
        const moves = ['vmovups', 'vmovupd', 'vmovdqu']
        const aligned = ['vmovaps', 'vmovapd', 'vmovdqa']
        const cases: VectorCase[] = []
        for (const name of [...moves, ...aligned]) {
            cases.push({ asm: `${name} xmm0, xmm1` }, { asm: `${name} ymm0, ymm1` }, { asm: `${name} ymm0, ymm0` },
                { asm: `${name} xmm0, [rel mem]` }, { asm: `${name} ymm0, [rel mem]` },
                { asm: `${name} [rel mem], xmm1` }, { asm: `${name} [rel mem], ymm1` },
                { asm: `${name} [rel mem + 32], ymm2` }, { asm: `${name} xmm2, xmm3` })
        }
        for (const name of moves) {
            cases.push({ asm: `${name} ymm0, [rel mem + 7]` }, { asm: `${name} [rel mem + 7], ymm1` },
                { asm: `${name} xmm0, [rel mem + 1]` })
        }
        cases.push({ asm: 'vlddqu ymm0, [rel mem + 3]' }, { asm: 'vlddqu xmm0, [rel mem + 3]' },
            { asm: 'vmovntdq [rel mem], ymm1' }, { asm: 'vmovntps [rel mem + 32], ymm2' },
            { asm: 'vmovntpd [rel mem], xmm2' }, { asm: 'vmovntdqa ymm0, [rel mem]' })
        await checkAgainstNative(cases)
    })
    it('scalar moves, half moves and general register transfers', async () => {
        const cases: VectorCase[] = []
        for (const kind of ['f32', 'f64'] as const) {
            const op = kind === 'f32' ? 'vmovss' : 'vmovsd'
            cases.push({ asm: `${op} xmm0, xmm1, xmm2`, kind }, { asm: `${op} xmm0, xmm0, xmm2`, kind },
                { asm: `${op} xmm0, xmm1, xmm0`, kind }, { asm: `${op} xmm0, [rel mem]`, kind },
                { asm: `${op} [rel mem], xmm1`, kind }, { asm: `${op} xmm2, xmm3, xmm1`, kind },
                { asm: `${op} xmm1, xmm3, xmm1`, kind })
        }
        cases.push({ asm: 'vmovlps xmm0, xmm1, [rel mem]' }, { asm: 'vmovlpd xmm0, xmm1, [rel mem]' },
            { asm: 'vmovhps xmm0, xmm1, [rel mem]' }, { asm: 'vmovhpd xmm0, xmm1, [rel mem]' },
            { asm: 'vmovlps [rel mem], xmm1' }, { asm: 'vmovhps [rel mem], xmm1' },
            { asm: 'vmovlhps xmm0, xmm1, xmm2' }, { asm: 'vmovhlps xmm0, xmm1, xmm2' },
            { asm: 'vmovd xmm0, ecx' }, { asm: 'vmovq xmm0, rcx' }, { asm: 'vmovd eax, xmm1' },
            { asm: 'vmovq rax, xmm1' }, { asm: 'vmovd xmm0, [rel mem]' }, { asm: 'vmovd [rel mem], xmm1' },
            { asm: 'vmovq xmm0, [rel mem]' }, { asm: 'vmovq [rel mem], xmm1' }, { asm: 'vmovq xmm0, xmm1' },
            { asm: 'vmovmskps eax, xmm1' }, { asm: 'vmovmskpd eax, xmm1' }, { asm: 'vpmovmskb eax, xmm1' })
        await checkAgainstNative(cases)
    })
    it('compares that set the flags, and scalar conversions', async () => {
        const cases: VectorCase[] = []
        for (const op of ['vucomiss', 'vcomiss']) {
            cases.push({ asm: `${op} xmm0, xmm1`, kind: 'f32n' }, { asm: `${op} xmm0, [rel mem]`, kind: 'f32n' })
        }
        for (const op of ['vucomisd', 'vcomisd']) {
            cases.push({ asm: `${op} xmm0, xmm1`, kind: 'f64n' }, { asm: `${op} xmm0, [rel mem]`, kind: 'f64n' })
        }
        cases.push({ asm: 'vcvtsi2ss xmm0, xmm1, ecx' }, { asm: 'vcvtsi2sd xmm0, xmm1, rcx' },
            { asm: 'vcvtsi2sd xmm0, xmm1, dword [rel mem]' }, { asm: 'vcvtsi2ss xmm0, xmm0, rcx' },
            { asm: 'vcvtss2sd xmm0, xmm1, xmm2', kind: 'f32' }, { asm: 'vcvtsd2ss xmm0, xmm1, xmm2', kind: 'f64' },
            { asm: 'vcvttss2si eax, xmm1', kind: 'f32' }, { asm: 'vcvttsd2si rax, xmm1', kind: 'f64' },
            { asm: 'vcvtss2si eax, xmm1', kind: 'f32' }, { asm: 'vcvtsd2si rax, xmm1', kind: 'f64' })
        await checkAgainstNative(cases)
    })
    it('zeroes the upper halves', async () => {
        await checkAgainstNative([{ asm: 'vzeroupper' }, { asm: 'vzeroall' },
            { asm: 'vpxor xmm0, xmm0, xmm0' }, { asm: 'vmovdqa xmm1, xmm2' },
            { asm: 'vzeroupper\nvmovdqu xmm0, xmm1' }])
    })
})
