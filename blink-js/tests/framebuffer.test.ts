// /dev/fb0 (x86-devices-plan.md, M2): the screen information Linux's DRM fbdev emulation gives on
// the QEMU guest's bochs display, its check of a new one, panning and the vsync wait; the buffer
// mmap() shares and read(), write() and lseek() reach; what Undo takes back; and the wrapper's
// view of the page the scanout shows. The values are the guest's as Linux 6.12's sources give
// them, provisional until the guest is booted, so these run in the Core only.
import { describe, expect, it } from 'vitest'
import { BlinkState, type X86Environment, type X86WaitRequest } from '../src/types'
import { createX86Emulator, type X86Emulator } from '../src/x86-emulator'
import { probeSource, quadwords } from './linux-probe'

const ENXIO = -6n
const EBADF = -9n
const EACCES = -13n
const EINVAL = -22n
const ENOTTY = -25n
const EFBIG = -27n
const ENOSPC = -28n
const EOPNOTSUPP = -95n

const FBIOGET_VSCREENINFO = 0x4600
const FBIOPUT_VSCREENINFO = 0x4601
const FBIOGET_FSCREENINFO = 0x4602
const FBIOGETCMAP = 0x4604
const FBIOPAN_DISPLAY = 0x4606
const FBIO_CURSOR = 0xc0684608
const FBIOBLANK = 0x4611
const FBIO_WAITFORVSYNC = 0x40044620

const SMEM_LEN = 320 * 4 * 480
const PAGE = 320 * 4 * 240

// offsets in struct fb_var_screeninfo
const V = {
    xres: 0,
    yres: 4,
    xresVirtual: 8,
    yresVirtual: 12,
    xoffset: 16,
    yoffset: 20,
    bpp: 24,
    grayscale: 28,
    red: 32,
    green: 44,
    blue: 56,
    transp: 68,
    nonstd: 80,
    activate: 84,
    height: 88,
    width: 92,
    vmode: 132
}

const DATA = [
    'section .data',
    'fb0: db "/dev/fb0", 0',
    'pattern: dq 0x0807060504030201',
    'section .text'
]

/** Opens /dev/fb0 read-write into r12 and maps all of it, shared, into r13. */
const OPEN_AND_MAP = [
    'sys 2, fb0, 2',
    'mov r12, rax',
    `sys 9, 0, ${SMEM_LEN}, 3, 1, r12, 0`,
    'mov r13, rax'
]

/** Reads the screen information into buf, then sets the u32 at `field` of it to `value`. */
const getVar = (field?: number, value?: number | string) => [
    `sys 16, r12, ${FBIOGET_VSCREENINFO}, buf`,
    ...(field === undefined ? [] : [`mov dword [buf + ${field}], ${value}`])
]

/** Saves the 160 bytes of a struct fb_var_screeninfo at `at` as 20 results. */
const saveVar = (at = 'buf') => Array.from({ length: 20 }, (_, i) => `saveq ${at} + ${i * 8}`)

/** The u32 fields of `count` results starting at `start`, as the struct held them. */
function words(results: bigint[], start: number, count: number): number[] {
    const bytes = new DataView(new ArrayBuffer(count * 8))
    for (let i = 0; i < count; i++) bytes.setBigInt64(i * 8, results[start + i]!, true)
    return Array.from({ length: count * 2 }, (_, i) => bytes.getUint32(i * 4, true))
}

/** Eight characters as the little-endian quadword they make. */
function text8(text: string): bigint {
    const bytes = new TextEncoder().encode(text.padEnd(8, '\0'))
    return new DataView(bytes.buffer).getBigInt64(0, true)
}

/** Every bitfield's offset, length and msb_right cleared, as SDL 1.2 is known to send them. */
function zeroFormat(): [number, number][] {
    return Array.from({ length: 12 }, (_, i) => [V.red + i * 4, 0] as [number, number])
}

/** The screen information a 320×240 program starts with, as 40 words. */
function initialVar(): number[] {
    const var_ = new Array(40).fill(0)
    var_[V.xres / 4] = 320
    var_[V.yres / 4] = 240
    var_[V.xresVirtual / 4] = 320
    var_[V.yresVirtual / 4] = 480
    var_[V.bpp / 4] = 32
    var_.splice(V.red / 4, 12, 16, 8, 0, 8, 8, 0, 0, 8, 0, 0, 0, 0)
    var_[V.height / 4] = 200
    var_[V.width / 4] = 320
    return var_
}

function virtualClock(): X86Environment {
    let now = 0n
    return {
        now: () => (Number(now) + 0.5) / 1e6,
        wait: async (request) => {
            if (request.deadlineNanoseconds === null)
                throw new Error('a wait with nothing to end it')
            if (request.deadlineNanoseconds > now) now = request.deadlineNanoseconds
        }
    }
}

async function build(body: readonly string[], environment?: X86Environment) {
    const emulator = await createX86Emulator(environment ? { environment } : {})
    const result = await emulator.compile(probeSource([...body, 'finish', ...DATA]))
    expect(result.ok, result.report).toBe(true)
    return emulator
}

type Run = {
    results: bigint[]
    presents: number[]
    waits: X86WaitRequest[]
}

async function runToEnd(emulator: X86Emulator): Promise<Run> {
    const stderr: number[] = []
    const presents: number[] = []
    const waits: X86WaitRequest[] = []
    const stops = [
        emulator.on('stderr', (bytes) => void stderr.push(...bytes)),
        emulator.on('framebufferPresent', ({ yoffset }) => void presents.push(yoffset)),
        emulator.on('waitRequest', (request) => void waits.push(request))
    ]
    try {
        for (let slice = 0; slice < 1000 && !emulator.hasTerminated(); slice++) {
            await emulator.run(1_000_000)
            while (emulator.state === BlinkState.ProgramWaitPause) {
                await new Promise<void>((resolve) => {
                    const stop = emulator.on('stateChange', () => {
                        stop()
                        resolve()
                    })
                })
            }
        }
        expect(emulator.stopReason?.kind, emulator.stopReason?.details).toBe('exit')
        return { results: quadwords(Uint8Array.from(stderr)), presents, waits }
    } finally {
        for (const stop of stops) stop()
    }
}

async function probe(
    body: readonly string[],
    check: (run: Run, emulator: X86Emulator) => void,
    environment?: X86Environment
): Promise<void> {
    const emulator = await build(body, environment)
    try {
        check(await runToEnd(emulator), emulator)
    } finally {
        emulator.dispose()
    }
}

/** Builds the probe for stepping with a history, and steps to the line marked `; <-- step`. */
async function stepTo(body: readonly string[]) {
    const source = probeSource([...body, 'finish', ...DATA])
    const lines = source.split('\n')
    const emulator = await createX86Emulator()
    const result = await emulator.compile(source)
    expect(result.ok, result.report).toBe(true)
    emulator.initialize(64)
    const presents: number[] = []
    emulator.on('framebufferPresent', ({ yoffset }) => void presents.push(yoffset))
    const marked = lines.findIndex((line) => line.includes('; <-- step'))
    for (let step = 0; step < 1000; step++) {
        if (emulator.getInstructionAt(emulator.getPc())?.lineNumber === marked)
            return { emulator, presents }
        await emulator.step()
    }
    emulator.dispose()
    throw new Error('the marked instruction never came up')
}

function pixelAt(emulator: X86Emulator, index: number): number {
    const visible = emulator.getFramebuffer()!.visible()
    return new DataView(visible.buffer, visible.byteOffset).getUint32(index * 4, true)
}

describe('the screen information', () => {
    it('is fixed as the bochs display gives it through DRM fbdev emulation', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                'lea rdi, [buf]',
                'mov ecx, 256',
                'mov al, 0xaa',
                'rep stosb',
                `sys 16, r12, ${FBIOGET_FSCREENINFO}, buf`,
                'save',
                ...Array.from({ length: 11 }, (_, i) => `saveq buf + ${i * 8}`)
            ],
            ({ results }) => {
                expect(results[0]).toBe(0n)
                expect(results[1]).toBe(text8('bochs-dr'))
                expect(results[2]).toBe(text8('mdrmfb'))
                expect(results[3]).toBe(0n) // smem_start, hidden
                // smem_len, then type FB_TYPE_PACKED_PIXELS
                expect(words(results, 4, 1)).toEqual([SMEM_LEN, 0])
                // type_aux, then visual FB_VISUAL_TRUECOLOR
                expect(words(results, 5, 1)).toEqual([0, 2])
                // xpanstep 1, ypanstep 1, ywrapstep 0 and the padding
                expect(results[6]).toBe(0x10001n)
                expect(words(results, 7, 1)).toEqual([1280, 0]) // line_length
                expect(results[8]).toBe(0n) // mmio_start
                expect(words(results, 9, 1)).toEqual([0, 0]) // mmio_len, accel FB_ACCEL_NONE
                expect(results[10]).toBe(0n) // capabilities and reserved
                expect(results[11]).toBe(-0x5555555555555556n) // past the struct, untouched
            }
        )
    })

    it('is variable as drm_fb_helper fills it: XRGB8888 on two pages', async () => {
        await probe(
            ['sys 2, fb0, 2', 'mov r12, rax', ...getVar(), 'save', ...saveVar()],
            ({ results }) => {
                expect(results[0]).toBe(0n)
                expect(words(results, 1, 20)).toEqual(initialVar())
            }
        )
    })

    it('takes its size from the display mode set before the program starts', async () => {
        const emulator = await build([
            'sys 2, fb0, 2',
            'mov r12, rax',
            ...getVar(),
            'saved buf + 0',
            'saved buf + 4',
            'saved buf + 12',
            `sys 16, r12, ${FBIOGET_FSCREENINFO}, buf`,
            'saved buf + 24',
            'saved buf + 48'
        ])
        try {
            expect(() => emulator.setDisplayMode({ width: 324, height: 200 })).toThrow(RangeError)
            expect(() => emulator.setDisplayMode({ width: 0, height: 200 })).toThrow(RangeError)
            expect(() => emulator.setDisplayMode({ width: 1032, height: 200 })).toThrow(RangeError)
            expect(() => emulator.setDisplayMode({ width: 320, height: 1025 })).toThrow(RangeError)
            expect(emulator.getFramebuffer()).toBeNull()
            const first = await runToEnd(emulator)
            expect(first.results).toEqual([320n, 240n, 480n, BigInt(SMEM_LEN), 1280n])
            // a running program keeps its mode; the next start takes the new one
            emulator.setDisplayMode({ width: 328, height: 200 })
            expect(emulator.getFramebuffer()!.width).toBe(320)
            emulator.runtime.starti()
            expect(emulator.getFramebuffer()).toBeNull()
            const second = await runToEnd(emulator)
            // 1312 × 400 bytes, rounded up to whole pages as the VRAM helper does
            expect(second.results).toEqual([328n, 200n, 400n, 528384n, 1312n])
            const framebuffer = emulator.getFramebuffer()!
            expect([framebuffer.width, framebuffer.height, framebuffer.lineLength]).toEqual([
                328, 200, 1312
            ])
            expect(framebuffer.visible().length).toBe(1312 * 200)
        } finally {
            emulator.dispose()
        }
    })
})

describe('FBIOPUT_VSCREENINFO', () => {
    it('accepts a smaller size and reads it back, while the scanout shows the whole mode', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                ...getVar(V.xres, 160),
                `mov dword [buf + ${V.yres}], 120`,
                `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                'save',
                'saved buf + 0',
                'saved buf + 4',
                'lea rdi, [buf]',
                'mov ecx, 160',
                'xor eax, eax',
                'rep stosb',
                ...getVar(),
                ...saveVar()
            ],
            ({ results }, emulator) => {
                expect(results.slice(0, 3)).toEqual([0n, 160n, 120n])
                const expected = initialVar()
                expected[V.xres / 4] = 160
                expected[V.yres / 4] = 120
                expect(words(results, 3, 20)).toEqual(expected)
                const framebuffer = emulator.getFramebuffer()!
                expect([framebuffer.width, framebuffer.height]).toEqual([320, 240])
                expect(framebuffer.visible().length).toBe(PAGE)
            }
        )
    })

    it('answers as drm_fb_helper_check_var does', async () => {
        // each case starts from the screen information the device has, changes some fields and
        // saves the answer, bits_per_pixel and pixclock as given back, and the size set now
        const cases: [string, [number, number][], bigint[]][] = [
            ['wider', [[V.xres, 328]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['taller than the buffer', [[V.yres, 481]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['as tall as the buffer', [[V.yres, 480]], [0n, 32n, 0n, 320n, 480n]],
            ['a larger virtual size', [[V.yresVirtual, 960]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['narrower than 8', [[V.xres, 4]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['deeper', [[V.bpp, 64]], [EINVAL, 64n, 0n, 320n, 240n]],
            ['grayscale', [[V.grayscale, 1]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['nonstd', [[V.nonstd, 1]], [EINVAL, 32n, 0n, 320n, 240n]],
            [
                'RGB565',
                [
                    [V.bpp, 16],
                    [V.red, 11],
                    [V.red + 4, 5],
                    [V.green, 5],
                    [V.green + 4, 6],
                    [V.blue + 4, 5]
                ],
                [EINVAL, 16n, 0n, 320n, 240n]
            ],
            ['16 bpp, the format left as it is', [[V.bpp, 16]], [0n, 32n, 0n, 320n, 240n]],
            ['16 bpp, no format', [[V.bpp, 16], ...zeroFormat()], [0n, 32n, 0n, 320n, 240n]],
            ['an offset past the buffer', [[V.yoffset, 241]], [EINVAL, 32n, 0n, 320n, 240n]],
            ['a pixel clock, ignored', [[100, 39721]], [0n, 32n, 0n, 320n, 240n]],
            [
                'FB_ACTIVATE_TEST',
                [
                    [V.xres, 64],
                    [V.activate, 2]
                ],
                [0n, 32n, 0n, 320n, 240n]
            ],
            [
                'a transparency channel',
                [
                    [V.transp, 24],
                    [V.transp + 4, 8]
                ],
                [EINVAL, 32n, 0n, 320n, 240n]
            ],
            [
                'deleting the mode in use',
                [[V.activate, 256]], // FB_ACTIVATE_INV_MODE
                [EINVAL, 32n, 0n, 320n, 240n]
            ],
            [
                'deleting another mode',
                [
                    [V.activate, 256],
                    [V.xres, 64]
                ],
                [0n, 32n, 0n, 320n, 240n]
            ]
        ]
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                ...cases.flatMap(([, fields]) => [
                    ...getVar(),
                    ...fields.map(([field, value]) => `mov dword [buf + ${field}], ${value}`),
                    `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                    'save',
                    `saved buf + ${V.bpp}`,
                    'saved buf + 100',
                    ...getVar(),
                    `saved buf + ${V.xres}`,
                    `saved buf + ${V.yres}`,
                    // back to the whole mode
                    ...getVar(V.yres, 240),
                    `mov dword [buf + ${V.xres}], 320`,
                    `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`
                ])
            ],
            ({ results }) => {
                const answers = cases.map(([name], i) => [name, results.slice(i * 5, i * 5 + 5)])
                expect(answers).toEqual(cases.map(([name, , expected]) => [name, expected]))
            }
        )
    })

    it('pans to a new yoffset', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                ...getVar(V.yoffset, 240),
                `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                'save',
                ...getVar(),
                `saved buf + ${V.yoffset}`,
                // the same again changes nothing, so nothing is presented
                `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                'save'
            ],
            ({ results, presents }, emulator) => {
                expect(results).toEqual([0n, 240n, 0n])
                expect(presents).toEqual([240])
                expect(emulator.getFramebuffer()!.yoffset).toBe(240)
            }
        )
    })
})

describe('panning', () => {
    it('shows the other page with FBIOPAN_DISPLAY, and presents it', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                ...getVar(V.yoffset, 240),
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                ...getVar(),
                `saved buf + ${V.yoffset}`,
                `mov dword [buf + ${V.yoffset}], 241`,
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                `mov dword [buf + ${V.yoffset}], 0`,
                `mov dword [buf + ${V.xoffset}], 1`,
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                `mov dword [buf + ${V.xoffset}], 0`,
                `mov dword [buf + ${V.yoffset}], 8`,
                `mov dword [buf + ${V.vmode}], 256`, // FB_VMODE_YWRAP, with no ywrapstep
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                `mov dword [buf + ${V.vmode}], 0`,
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                ...getVar(),
                `saved buf + ${V.yoffset}`
            ],
            ({ results, presents }, emulator) => {
                expect(results).toEqual([0n, 240n, EINVAL, EINVAL, EINVAL, 0n, 8n])
                expect(presents).toEqual([240, 8])
                expect(emulator.getFramebuffer()!.yoffset).toBe(8)
            }
        )
    })

    it('fails with ENOSPC where the whole mode would not fit, after a smaller size', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                ...getVar(V.yres, 120),
                `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                'save',
                `mov dword [buf + ${V.yoffset}], 300`,
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                `mov dword [buf + ${V.yoffset}], 361`,
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                // set through the screen information, the failed pan goes unreported
                ...getVar(V.yoffset, 300),
                `sys 16, r12, ${FBIOPUT_VSCREENINFO}, buf`,
                'save',
                ...getVar(),
                `saved buf + ${V.yoffset}`
            ],
            ({ results, presents }, emulator) => {
                expect(results).toEqual([0n, ENOSPC, EINVAL, 0n, 300n])
                // the first size set pans where the scanout already was; the others fail to
                expect(presents).toEqual([0])
                expect(emulator.getFramebuffer()!.yoffset).toBe(0)
            }
        )
    })

    it('presents at fsync and fdatasync, and blanks with FBIOBLANK until the next pan', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                'sys 74, r12', // fsync
                'save',
                'sys 75, r12', // fdatasync
                'save',
                `sys 16, r12, ${FBIOBLANK}, 5`,
                'save',
                `sys 16, r12, ${FBIOBLANK}, 4`,
                'save',
                `sys 16, r12, ${FBIOBLANK}, 1`, // still off
                'save',
                ...getVar(),
                `sys 16, r12, ${FBIOPAN_DISPLAY}, buf`,
                'save',
                `sys 16, r12, ${FBIOBLANK}, 1`,
                'save'
            ],
            ({ results, presents }, emulator) => {
                expect(results).toEqual([0n, 0n, EINVAL, 0n, 0n, 0n, 0n])
                expect(presents).toEqual([0, 0, 0, 0, 0])
                expect(emulator.getFramebuffer()!.blanked).toBe(true)
            }
        )
    })
})

describe('the other ioctls', () => {
    it('answer as fb_ioctl and drm_fb_helper_ioctl do', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                `sys 16, r12, ${FBIO_CURSOR}, buf`,
                'save',
                `sys 16, r12, 0x46ff, buf`,
                'save',
                `sys 16, r12, 0x4b2f, 440`, // KIOCSOUND belongs to a console
                'save',
                `sys 16, r12, ${FBIOGETCMAP}, buf`, // not implemented: a documented deviation
                'save',
                // the vsync wait reads no argument
                `sys 16, r12, ${FBIO_WAITFORVSYNC}, 0`,
                'save'
            ],
            ({ results }) => {
                expect(results).toEqual([EINVAL, ENOTTY, ENOTTY, ENOTTY, 0n])
            },
            virtualClock()
        )
    })
})

describe('FBIO_WAITFORVSYNC', () => {
    it('waits for the next 1/60 s boundary of Program time', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                `sys 16, r12, ${FBIO_WAITFORVSYNC}, buf`,
                'save',
                'sys 228, 1, buf', // clock_gettime(CLOCK_MONOTONIC)
                'saveq buf + 8',
                `sys 16, r12, ${FBIO_WAITFORVSYNC}, buf`,
                'sys 228, 1, buf',
                'saveq buf + 8',
                // 5 ms in, the next boundary is still the third
                'mov qword [buf2], 0',
                'mov qword [buf2 + 8], 5000000',
                'sys 35, buf2, 0',
                `sys 16, r12, ${FBIO_WAITFORVSYNC}, buf`,
                'sys 228, 1, buf',
                'saveq buf + 8'
            ],
            ({ results, waits }) => {
                expect(results).toEqual([0n, 16666667n, 33333334n, 50000000n])
                expect(waits.map((wait) => wait.deadlineNanoseconds)).toEqual([
                    16666667n,
                    33333334n,
                    38333334n,
                    50000000n
                ])
                expect(waits.every((wait) => !wait.wakeSources.terminal)).toBe(true)
                expect(waits.every((wait) => wait.wakeSources.inputDevices.length === 0)).toBe(true)
            },
            virtualClock()
        )
    })
})

describe('the mapping', () => {
    it('is one buffer that every shared mapping and the wrapper see', async () => {
        await probe(
            [
                ...OPEN_AND_MAP,
                'save r13',
                `sys 9, 0, ${SMEM_LEN}, 3, 1, r12, 0`,
                'mov r14, rax',
                'mov dword [r13 + 16], 0x00ff8000',
                'saved r14 + 16',
                // and an offset maps from there
                `sys 9, 0, 4096, 1, 1, r12, ${PAGE}`,
                'mov dword [r13 + ' + PAGE + '], 0x11223344',
                'saved rax',
                'mov rax, r13',
                'sub rax, r14',
                'save'
            ],
            ({ results }, emulator) => {
                expect(results[0]).toBeGreaterThan(0n)
                expect(results.slice(1, 3)).toEqual([0x00ff8000n, 0x11223344n])
                expect(results[3]).not.toBe(0n)
                expect(pixelAt(emulator, 4)).toBe(0x00ff8000)
                expect(emulator.getFramebuffer()!.visible().length).toBe(PAGE)
            }
        )
    })

    it('is a copy when private, as a file mapping is', async () => {
        await probe(
            [
                ...OPEN_AND_MAP,
                'mov dword [r13], 0x01020304',
                `sys 9, 0, ${SMEM_LEN}, 3, 2, r12, 0`, // MAP_PRIVATE
                'mov r14, rax',
                'saved r14',
                'mov dword [r14], 0x55',
                'saved r13'
            ],
            ({ results }, emulator) => {
                expect(results).toEqual([0x01020304n, 0x01020304n])
                expect(pixelAt(emulator, 0)).toBe(0x01020304)
            }
        )
    })

    it('refuses what goes past the buffer, an unaligned offset and a write to a read-only open', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                `sys 9, 0, ${SMEM_LEN + 4096}, 3, 1, r12, 0`,
                'save',
                `sys 9, 0, 8192, 3, 1, r12, ${SMEM_LEN - 4096}`,
                'save',
                `sys 9, 0, 4096, 3, 1, r12, 100`,
                'save',
                'sys 2, fb0, 0', // O_RDONLY
                'mov r13, rax',
                `sys 9, 0, 4096, 3, 1, r13, 0`,
                'save',
                `sys 9, 0, 4096, 1, 1, r13, 0`,
                'mov rcx, rax',
                'shr rcx, 63',
                'save rcx'
            ],
            ({ results }) => {
                expect(results).toEqual([EINVAL, EINVAL, EINVAL, EACCES, 0n])
            }
        )
    })

    it('outlives munmap, whose pages never reach the free list, and close', async () => {
        await probe(
            [
                ...OPEN_AND_MAP,
                'mov dword [r13 + 8], 0x12345678',
                `sys 11, r13, ${SMEM_LEN}`,
                'save',
                // anonymous memory as large, every page of it written
                `sys 9, 0, ${SMEM_LEN}, 3, 0x22, -1, 0`,
                'mov rdi, rax',
                `mov ecx, ${SMEM_LEN / 4}`,
                'mov eax, 0xdeadbeef',
                'rep stosd',
                'sys 17, r12, buf, 16, 0', // pread64
                'saved buf + 8',
                'sys 3, r12',
                // open again: the same device, as the last open left it
                'sys 2, fb0, 2',
                'mov r12, rax',
                `sys 9, 0, ${SMEM_LEN}, 3, 1, r12, 0`,
                'saved rax + 8',
                'sys 0, r12, buf, 16',
                'save',
                'saved buf + 8'
            ],
            ({ results }, emulator) => {
                expect(results).toEqual([0n, 0x12345678n, 0x12345678n, 16n, 0x12345678n])
                expect(pixelAt(emulator, 2)).toBe(0x12345678)
            }
        )
    })
})

describe('read, write and lseek', () => {
    it('reach the buffer as fb_sys_read and fb_sys_write do', async () => {
        await probe(
            [
                'sys 2, fb0, 2',
                'mov r12, rax',
                'sys 8, r12, 0, 2', // SEEK_END of an empty inode
                'save',
                `sys 8, r12, ${SMEM_LEN - 4}, 0`,
                'save',
                'sys 1, r12, pattern, 8', // short at the end
                'save',
                'sys 1, r12, pattern, 8',
                'save',
                'sys 8, r12, 0, 1',
                'save',
                'sys 0, r12, buf, 8',
                'save',
                `sys 8, r12, ${SMEM_LEN + 4}, 0`,
                'save',
                'sys 1, r12, pattern, 8',
                'save',
                'sys 8, r12, 0, 3', // SEEK_DATA
                'save',
                'sys 8, r12, -1, 4', // SEEK_HOLE
                'save',
                'sys 8, r12, -1, 0',
                'save',
                'sys 8, r12, 0, 5',
                'save',
                // at an offset, which leaves the file offset alone
                'sys 18, r12, pattern, 8, 100', // pwrite64
                'save',
                'sys 8, r12, 0, 1',
                'save',
                'sys 17, r12, buf, 8, 100',
                'save',
                'saveq buf',
                'sys 17, r12, buf, 8, -1',
                'save',
                // a dup() shares the offset
                'sys 32, r12',
                'mov r13, rax',
                'sys 8, r13, 96, 0',
                'sys 0, r12, buf, 8',
                'save',
                'saveq buf',
                'sys 8, r13, 0, 1',
                'save',
                // a flag preadv2 would need read_iter for
                'mov qword [buf2], buf',
                'mov qword [buf2 + 8], 8',
                'sys 327, r12, buf2, 1, 0, 0, 4', // RWF_NOWAIT... in r9: flags
                'save'
            ],
            ({ results }, emulator) => {
                expect(results).toEqual([
                    0n,
                    BigInt(SMEM_LEN - 4),
                    4n,
                    ENOSPC,
                    BigInt(SMEM_LEN),
                    0n,
                    BigInt(SMEM_LEN + 4),
                    EFBIG,
                    ENXIO,
                    0n,
                    EINVAL,
                    EINVAL,
                    8n,
                    0n,
                    8n,
                    0x0807060504030201n,
                    EINVAL,
                    8n,
                    0x0403020100000000n,
                    104n,
                    EOPNOTSUPP
                ])
                expect(pixelAt(emulator, 25)).toBe(0x04030201)
            }
        )
    })

    it('answers EBADF for a write through a read-only open', async () => {
        await probe(
            ['sys 2, fb0, 0', 'mov r12, rax', 'sys 1, r12, pattern, 4', 'save'],
            ({ results }) => {
                expect(results).toEqual([EBADF])
            }
        )
    })
})

describe('Undo', () => {
    it('takes back a pixel stored through the mapping', async () => {
        const { emulator } = await stepTo([
            ...OPEN_AND_MAP,
            'mov dword [r13 + 40], 0x00abcdef ; <-- step'
        ])
        try {
            await emulator.step()
            expect(pixelAt(emulator, 10)).toBe(0x00abcdef)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(pixelAt(emulator, 10)).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('takes back a write(), its bytes and the file offset it moved', async () => {
        const { emulator } = await stepTo([
            'sys 2, fb0, 2',
            'mov r12, rax',
            'mov rax, 1',
            'mov rdi, r12',
            'mov rsi, pattern',
            'mov rdx, 8',
            'syscall ; <-- step',
            'save',
            'sys 8, r12, 0, 1',
            'save'
        ])
        try {
            await emulator.step()
            expect(pixelAt(emulator, 1)).toBe(0x08070605)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(pixelAt(emulator, 0)).toBe(0)
            expect(pixelAt(emulator, 1)).toBe(0)
            // the write runs again from the offset it had
            const run = await runToEnd(emulator)
            expect(run.results).toEqual([8n, 8n])
            expect(pixelAt(emulator, 0)).toBe(0x04030201)
            expect(pixelAt(emulator, 2)).toBe(0)
        } finally {
            emulator.dispose()
        }
    })

    it('takes back a pan, and presents the page it shows again', async () => {
        const { emulator, presents } = await stepTo([
            'sys 2, fb0, 2',
            'mov r12, rax',
            ...getVar(V.yoffset, 240),
            'mov rax, 16',
            'mov rdi, r12',
            `mov rsi, ${FBIOPAN_DISPLAY}`,
            'mov rdx, buf',
            'syscall ; <-- step'
        ])
        try {
            await emulator.step()
            expect(emulator.getFramebuffer()!.yoffset).toBe(240)
            expect(presents).toEqual([240])
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(emulator.getFramebuffer()!.yoffset).toBe(0)
            expect(presents).toEqual([240, 0])
        } finally {
            emulator.dispose()
        }
    })

    it('takes back a smaller size set with FBIOPUT_VSCREENINFO', async () => {
        const { emulator, presents } = await stepTo([
            'sys 2, fb0, 2',
            'mov r12, rax',
            ...getVar(V.xres, 64),
            'mov rax, 16',
            'mov rdi, r12',
            `mov rsi, ${FBIOPUT_VSCREENINFO}`,
            'mov rdx, buf',
            'syscall ; <-- step',
            'save',
            ...getVar(),
            `saved buf + ${V.xres}`
        ])
        try {
            const buf = emulator.getRegisterValue('rdx')
            await emulator.step()
            expect(presents).toEqual([0])
            emulator.undo()
            // run again asking for the whole mode, it finds the device already has it: nothing
            // changes and nothing is presented
            emulator.writeMemoryBytes(buf + BigInt(V.xres), Uint8Array.of(0x40, 1, 0, 0))
            const run = await runToEnd(emulator)
            expect(run.results).toEqual([0n, 320n])
            expect(run.presents).toEqual([])
        } finally {
            emulator.dispose()
        }
    })

    it('takes back a whole page cleared with rep stosd through the mapping', async () => {
        const { emulator } = await stepTo([
            ...OPEN_AND_MAP,
            'mov rdi, r13',
            `mov ecx, ${PAGE / 4}`,
            'mov eax, 0x00112233',
            'rep stosd ; <-- step'
        ])
        try {
            const rows = emulator.getUndoDepth()
            await emulator.step()
            expect(emulator.getRegisterValue('rcx')).toBe(0n)
            const visible = emulator.getFramebuffer()!.visible()
            expect(visible.every((byte, i) => byte === [0x33, 0x22, 0x11, 0][i % 4])).toBe(true)
            expect(emulator.getUndoDepth()).toBe(rows + 1)
            expect(emulator.canUndo()).toBe(true)
            emulator.undo()
            expect(
                emulator
                    .getFramebuffer()!
                    .visible()
                    .every((byte) => byte === 0)
            ).toBe(true)
            expect(emulator.getRegisterValue('rcx')).toBe(BigInt(PAGE / 4))
        } finally {
            emulator.dispose()
        }
    })

    it('stops at the open and the mapping, as at every descriptor and mapping change', async () => {
        const { emulator } = await stepTo(['sys 2, fb0, 2', 'mov r12, rax', 'nop ; <-- step'])
        try {
            expect(emulator.canUndo()).toBe(true) // mov r12, rax
            emulator.undo()
            expect(emulator.canUndo()).toBe(false) // the open
        } finally {
            emulator.dispose()
        }
    })
})

describe('the wrapper', () => {
    it('has no framebuffer before the program opens /dev/fb0, and a black one after', async () => {
        const emulator = await build(['sys 39', 'save'])
        try {
            await runToEnd(emulator)
            expect(emulator.getFramebuffer()).toBeNull()
        } finally {
            emulator.dispose()
        }
        await probe(['sys 2, fb0, 2'], (_, emulator) => {
            const framebuffer = emulator.getFramebuffer()!
            expect(framebuffer.visible().every((byte) => byte === 0)).toBe(true)
            expect(framebuffer.yoffset).toBe(0)
            expect(framebuffer.blanked).toBe(false)
            // the same view while nothing moved, and it is the heap's, not a copy
            expect(framebuffer.visible()).toBe(framebuffer.visible())
            expect(framebuffer.visible().buffer).toBe(emulator.module.wasmExports!.memory!.buffer)
        })
    })
})
