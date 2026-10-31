import type { X86SoundCutEvent, X86SoundDevice } from './types'

/** A time the Core hands over as its low and high 32 bits: nanoseconds of Program time. */
export function soundTime(lo: number, hi: number): bigint {
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)
}

/** `SOUND_*` (sound.h): 0 is every device. */
const SOUND_DEVICES: readonly (X86SoundDevice | undefined)[] = [undefined, 'dsp', 'midi', 'speaker']

export function soundCut(after: bigint, device: number): X86SoundCutEvent {
    const name = SOUND_DEVICES[device]
    return name ? { after, device: name } : { after }
}
