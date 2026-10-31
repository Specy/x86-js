import type { X86DisplayMode, X86Framebuffer } from './types'
import type { BlinkenlibModule } from './wasm-types'

/** The mode a program starts with until `setDisplayMode()` names another. */
export const X86_DEFAULT_DISPLAY_MODE: Readonly<X86DisplayMode> = { width: 320, height: 240 }

/**
 * Checks a display mode as the guest's `video=` would take it: a GTF mode's width is a multiple
 * of 8, and both sides run from 8 (the smallest fbdev draws on) to 1024.
 */
export function checkDisplayMode(mode: X86DisplayMode): void {
    const { width, height } = mode
    if (!Number.isInteger(width) || width < 8 || width > 1024 || width % 8)
        throw new RangeError(`A display's width is a multiple of 8 from 8 to 1024, not ${width}`)
    if (!Number.isInteger(height) || height < 8 || height > 1024)
        throw new RangeError(`A display's height runs from 8 to 1024, not ${height}`)
}

/**
 * The Core's framebuffer, read out of the wasm heap where Blink keeps it (fbdev.c): no copy is
 * made, and the view of the visible page is only made again when the heap or the page moved.
 */
export class FramebufferView implements X86Framebuffer {
    private view: Uint8Array | null = null
    private viewBuffer: ArrayBufferLike | null = null
    private viewStart = 0

    constructor(private readonly module: BlinkenlibModule) {}

    /** Whether the program has opened `/dev/fb0`, whose buffer lasts until the next start. */
    static exists(module: BlinkenlibModule): boolean {
        return Boolean(module._blinkenlib_framebuffer_pixels?.())
    }

    get width(): number {
        return this.module._blinkenlib_framebuffer_width!()
    }

    get height(): number {
        return this.module._blinkenlib_framebuffer_height!()
    }

    get lineLength(): number {
        return this.module._blinkenlib_framebuffer_line_length!()
    }

    get yoffset(): number {
        return this.module._blinkenlib_framebuffer_yoffset!()
    }

    get blanked(): boolean {
        return Boolean(this.module._blinkenlib_framebuffer_blanked!())
    }

    visible(): Uint8Array {
        const pixels = this.module._blinkenlib_framebuffer_pixels!()
        const buffer = this.module.wasmExports?.memory?.buffer
        if (!pixels || !buffer) {
            this.view = this.viewBuffer = null
            return new Uint8Array(0)
        }
        const lineLength = this.lineLength
        const start = pixels + this.yoffset * lineLength
        const length = this.height * lineLength
        if (
            !this.view ||
            this.viewBuffer !== buffer ||
            this.viewStart !== start ||
            this.view.length !== length
        ) {
            this.view = new Uint8Array(buffer, start, length)
            this.viewBuffer = buffer
            this.viewStart = start
        }
        return this.view
    }
}
