import type { X86InputDeviceId, X86InputEvent } from './types'

/** Each device the host delivers events to, by its place in `/dev/input` (`INPUT_*`, devices.h). */
const INPUT_DEVICE_INDEX: Record<X86InputDeviceId, number> = {
    keyboard: 0,
    tablet: 2
}

/** The `INPUT_*` index of a device the host delivers events to. */
export function inputDeviceIndex(device: X86InputDeviceId): number {
    if (!Object.hasOwn(INPUT_DEVICE_INDEX, device))
        throw new TypeError(`Not an input device the host delivers events to: ${String(device)}`)
    return INPUT_DEVICE_INDEX[device]
}

/**
 * Writes a report's events where the Core reads them, as int32 type, code and value, after
 * checking each is what a `struct input_event` holds: a 16-bit type and code and a 32-bit value.
 */
export function writeInputEvents(
    heap: Uint8Array,
    pointer: number,
    capacity: number,
    events: readonly X86InputEvent[]
): void {
    if (!Array.isArray(events)) throw new TypeError('An input report is an array of events')
    if (events.length > capacity)
        throw new RangeError(`An input report holds at most ${capacity} events`)
    const view = new DataView(heap.buffer, heap.byteOffset + pointer, events.length * 12)
    events.forEach((event, index) => {
        const { type, code, value } = event ?? {}
        if (!isInteger(type, 0, 0xffff) || !isInteger(code, 0, 0xffff))
            throw new RangeError(`Input event ${index} needs a 16-bit type and code`)
        if (!isInteger(value, -0x80000000, 0x7fffffff))
            throw new RangeError(`Input event ${index} needs a 32-bit value`)
        view.setInt32(index * 12, type, true)
        view.setInt32(index * 12 + 4, code, true)
        view.setInt32(index * 12 + 8, value, true)
    })
}

function isInteger(value: unknown, low: number, high: number): value is number {
    return Number.isInteger(value) && (value as number) >= low && (value as number) <= high
}
