import type { X86InputDeviceId, X86TerminalMode, X86WakeSources } from './types'
import type { BlinkenlibModule } from './wasm-types'

/** Where the kernel lists the input devices, which the Core generates from its device table. */
export const X86_INPUT_DEVICES_FILE = '/proc/bus/input/devices'

/**
 * The stream operations of every device node. Blink answers a program's reads, writes and
 * ioctls of a device itself, by the node's number, and only holds the host descriptor for its
 * number, so these are never asked for anything a program does.
 */
const DEVICE_STREAM_OPS = {
    read: () => 0,
    write: (_stream: unknown, _buffer: unknown, _offset: number, length: number) => length
}

/** `DEVICE_SERIAL` (devices.h): `/dev/ttyS0` and `/dev/console`, the program's own terminal. */
const DEVICE_SERIAL = 8

/**
 * What the host writes to its descriptor 1 or 2, which are the serial line's node once a program
 * has started (terminal.c), as its own standard streams were before: Blink's own messages. What
 * it writes to descriptor 0 goes nowhere, as it did on the host's standard input.
 */
export type SerialHostOutput = (fd: 1 | 2, bytes: Uint8Array) => void

/**
 * Makes the device nodes the machine has, the udev links to them and `/proc/bus/input/devices`,
 * from the device table compiled into the Core (devices.c), before the file system every program
 * starts with is captured: each start puts them back as they were. A Core built without the table
 * makes none. A node the module already has under the same path, Emscripten's `/dev/tty1`, gives
 * way to the guest's; the directories the nodes are in have the guest's mode, 0755.
 */
export function installDevices(module: BlinkenlibModule, serialOutput?: SerialHostOutput): void {
    const fs = module.FS
    const text = (pointer: number) => module.UTF8ToString(pointer)
    const directories = new Set<string>()
    const makeParent = (path: string) => {
        const parent = parentOf(path)
        fs.mkdirTree(parent)
        for (let at = parent; at.startsWith('/dev/'); at = parentOf(at)) directories.add(at)
    }
    const serialOps = {
        read: () => 0,
        write: (stream: { fd?: number }, buffer: Uint8Array, offset: number, length: number) => {
            if (stream.fd === 1 || stream.fd === 2) {
                serialOutput?.(
                    stream.fd,
                    new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice()
                )
            }
            return length
        }
    }
    const count = module._blinkenlib_device_count?.() ?? 0
    for (let index = 0; index < count; index++) {
        const path = text(module._blinkenlib_device_path!(index))
        const number = module._blinkenlib_device_number!(index)
        const serial = module._blinkenlib_device_kind?.(index) === DEVICE_SERIAL
        makeParent(path)
        fs.registerDevice(number, serial ? serialOps : DEVICE_STREAM_OPS)
        try {
            fs.unlink(path)
        } catch {
            // nothing there
        }
        fs.mkdev(path, module._blinkenlib_device_mode!(index), number)
    }
    const links = module._blinkenlib_device_link_count?.() ?? 0
    for (let index = 0; index < links; index++) {
        const path = text(module._blinkenlib_device_link_path!(index))
        makeParent(path)
        fs.symlink(text(module._blinkenlib_device_link_target!(index)), path)
    }
    for (const directory of directories) fs.chmod(directory, 0o755)
    if (module._blinkenlib_input_devices_text) {
        fs.mkdirTree(parentOf(X86_INPUT_DEVICES_FILE))
        fs.writeFile(X86_INPUT_DEVICES_FILE, text(module._blinkenlib_input_devices_text()))
        fs.chmod(X86_INPUT_DEVICES_FILE, 0o444)
    }
}

function parentOf(path: string): string {
    return path.slice(0, path.lastIndexOf('/')) || '/'
}

/** `TERMINAL_MODE_*` (terminal.h). */
const TERMINAL_MODE = {
    canonical: 1,
    echo: 2,
    signals: 4,
    crToNl: 8,
    outputProcessing: 16,
    nlToCrNl: 32,
    echoControl: 64
} as const

export function decodeTerminalMode(bits: number): X86TerminalMode {
    return {
        canonical: Boolean(bits & TERMINAL_MODE.canonical),
        echo: Boolean(bits & TERMINAL_MODE.echo),
        echoControl: Boolean(bits & TERMINAL_MODE.echoControl),
        signals: Boolean(bits & TERMINAL_MODE.signals),
        crToNl: Boolean(bits & TERMINAL_MODE.crToNl),
        outputProcessing: Boolean(bits & TERMINAL_MODE.outputProcessing),
        nlToCrNl: Boolean(bits & TERMINAL_MODE.nlToCrNl)
    }
}

/** `WAKE_*` (devices.h): the terminal, then the input devices the host delivers events to. */
const WAKE_TERMINAL = 1
const WAKE_INPUT_DEVICES: readonly [number, X86InputDeviceId][] = [
    [2, 'keyboard'],
    [4, 'tablet']
]

export function decodeWakeSources(bits: number): X86WakeSources {
    return {
        terminal: Boolean(bits & WAKE_TERMINAL),
        inputDevices: WAKE_INPUT_DEVICES.filter(([bit]) => bits & bit).map(([, id]) => id)
    }
}
