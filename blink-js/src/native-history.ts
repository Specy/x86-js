import type { BlinkRuntime } from './blink-runtime'
import { RegisterSize, type ExecutionStep, type PokeWrite, type StackFrame } from './interface'
import { X86_REGISTER_NAMES } from './types'
import { X86_FPU_STATE_SIZE } from './fpu-state'
import type { BlinkenlibModule } from './wasm-types'
import { makeFrameColor, toHistoryPc } from './x86-emulator-utils'

/** The version of debughistory.c's packets this reader decodes. */
const PACKET_VERSION = 1

type FpuMutations = (
    before: Uint8Array,
    after: Uint8Array,
    mutations: ExecutionStep['mutations'],
    writes?: PokeWrite[]
) => void

/** Reader for debughistory.c's v1 packets. Nothing here runs per instruction. */
export class NativeHistory {
    private cache = new Map<bigint, ExecutionStep>()

    /**
     * The undo history is recorded inside the wasm and nowhere else, and runs
     * go in the bounded slices it is recorded in. A blinkenlib.wasm built
     * without either, or with packets of another version, is refused when the
     * emulator is created instead of failing at the first step.
     */
    static assertSupported(module: BlinkenlibModule): void {
        const version = module._blinkenlib_history_version?.()
        if (version === undefined) {
            throw new Error(
                'This blinkenlib.wasm records no undo history: @specy/x86 needs a build with debughistory.c',
            )
        }
        if (version !== PACKET_VERSION) {
            throw new Error(
                `This blinkenlib.wasm records undo history version ${version}, and @specy/x86 reads version ${PACKET_VERSION}`,
            )
        }
        if (!module._blinkenlib_run_slice) {
            throw new Error('This blinkenlib.wasm cannot run in bounded slices: it has no _blinkenlib_run_slice')
        }
    }

    constructor(
        private runtime: BlinkRuntime,
        private fpuMutations: FpuMutations
    ) {}

    clear(): void {
        this.runtime.module._blinkenlib_history_clear!()
        this.cache.clear()
    }

    initialize(capacity: number): void {
        this.runtime.module._blinkenlib_history_capacity!(capacity)
        this.cache.clear()
    }

    private view(pointer: number, length?: number): DataView {
        // A ring allocation or guest allocation may grow memory between calls.
        return new DataView(this.runtime.module.wasmExports!.memory!.buffer, pointer, length)
    }

    previousFlags(): number | undefined {
        const pointer = this.runtime.module._blinkenlib_history_entry!(0)
        return pointer ? this.view(pointer, 88).getUint32(40, true) : undefined
    }

    canUndo(): boolean {
        return Boolean(this.runtime.module._blinkenlib_history_can_undo!())
    }

    undo(): boolean {
        const result = this.runtime.module._blinkenlib_history_undo!()
        if (result < 0)
            throw new Error(
                'The latest x86 step cannot be undone because its memory writes were too large to capture or are no longer mapped'
            )
        return result > 0
    }

    beginPoke(): void {
        if (!this.runtime.module._blinkenlib_history_begin_poke!()) {
            throw new Error('Cannot begin a poke before the program is started')
        }
    }

    endPoke(): boolean {
        const result = this.runtime.module._blinkenlib_history_end_poke!()
        if (result < 0) throw new Error('No poke is open: begin one before ending it')
        return Boolean(result)
    }

    callStack(): StackFrame[] {
        const frames: StackFrame[] = []
        const count = this.runtime.module._blinkenlib_history_stack_depth!()
        for (let index = 0; index < count; index++) {
            const pointer = this.runtime.module._blinkenlib_history_frame!(index)
            const view = this.view(pointer, 24)
            frames.push(
                this.frame(
                    view.getBigUint64(0, true),
                    view.getBigUint64(8, true),
                    view.getBigUint64(16, true),
                    index
                )
            )
        }
        return frames
    }

    private frame(target: bigint, destination: bigint, sp: bigint, index: number): StackFrame {
        const symbol = this.runtime.resolveSymbol(target)
        const address = symbol?.address ?? target
        const location = this.runtime.getSourceLocationForAddress(address)
        return {
            name: symbol?.name ?? '',
            address,
            destination,
            sp,
            line: location?.line ?? -1,
            file: location?.path,
            color: makeFrameColor(index, address)
        }
    }

    newestFirst(max: number): ExecutionStep[] {
        const count = Math.min(max, this.runtime.module._blinkenlib_history_count!())
        const nextCache = new Map<bigint, ExecutionStep>()
        const steps: ExecutionStep[] = []
        for (let index = 0; index < count; index++) {
            const pointer = this.runtime.module._blinkenlib_history_entry!(index)
            const header = this.view(pointer, 88)
            const serial = header.getBigUint64(8, true)
            const step = this.cache.get(serial) ?? this.decode(pointer, header.getUint32(4, true))
            nextCache.set(serial, step)
            steps.push(step)
        }
        // Only cache the displayed rows, not another copy of the entire ring.
        this.cache = nextCache
        return steps
    }

    private decode(pointer: number, length: number): ExecutionStep {
        const view = this.view(pointer, length)
        if (view.getUint32(0, true) !== PACKET_VERSION) throw new Error('Unsupported x86 history packet')
        const poke = Boolean(view.getUint32(16, true))
        const pcBefore = view.getBigUint64(24, true)
        const pcAfter = view.getBigUint64(32, true)
        const mutations: ExecutionStep['mutations'] = []
        const writes: PokeWrite[] | undefined = poke ? [] : undefined
        const mask = view.getUint32(56, true)
        let offset = 88
        for (let index = 0; index < X86_REGISTER_NAMES.length; index++) {
            if (!(mask & (1 << index))) continue
            const old = view.getBigUint64(offset, true)
            const value = view.getBigUint64(offset + 8, true)
            offset += 16
            const register = X86_REGISTER_NAMES[index]!
            if (!poke && register === 'rip') continue
            mutations.push({
                type: 'WriteRegister',
                value: { register, old, new: value, size: RegisterSize.Double }
            })
            writes?.push({ type: 'register', name: register, old, new: value })
        }
        const bytes = (start: number, size: number) =>
            new Uint8Array(view.buffer, view.byteOffset + start, size)
        if (view.getUint32(64, true)) {
            this.fpuMutations(
                bytes(offset, X86_FPU_STATE_SIZE),
                bytes(offset + X86_FPU_STATE_SIZE, X86_FPU_STATE_SIZE),
                mutations,
                writes
            )
            offset += X86_FPU_STATE_SIZE * 2
        }
        for (let index = 0; index < view.getUint32(60, true); index++) {
            const address = view.getBigUint64(offset, true)
            const size = view.getUint32(offset + 8, true)
            const oldSize = view.getUint32(offset + 12, true)
            const newSize = view.getUint32(offset + 16, true)
            const truncated = view.getUint32(offset + 20, true)
            if (truncated || oldSize !== size) {
                mutations.push({
                    type: 'Other',
                    value: `Wrote ${size} bytes to 0x${address.toString(16)}`
                })
            } else {
                const old = Array.from(bytes(offset + 24, oldSize))
                const value = Array.from(bytes(offset + 24 + oldSize, newSize))
                mutations.push({ type: 'WriteMemoryBytes', value: { address, old, new: value } })
                writes?.push({ type: 'memory', address, old, new: value })
            }
            offset += 24 + oldSize + newSize
        }
        const flow = view.getUint32(48, true)
        if (!poke && (flow === 1 || (flow === 2 && view.getUint32(68, true) > 0))) {
            mutations.push({
                type: flow === 1 ? 'PushCallStack' : 'PopCallStack',
                value: { from: pcBefore, to: pcAfter }
            })
        }
        const pc = poke ? pcAfter : pcBefore
        const location = this.runtime.getSourceLocationForAddress(pc)
        return {
            kind: poke ? 'poke' : 'instruction',
            mutations,
            pc: toHistoryPc(pc),
            old_ccr: { bits: view.getUint32(40, true) },
            new_ccr: { bits: view.getUint32(44, true) },
            line: location?.line ?? -1,
            file: location?.path,
            ...(writes ? { writes } : {})
        }
    }
}
