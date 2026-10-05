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
    /**
     * Decoded rows by serial, with the length of the packet each was decoded from: the history
     * hollows its oldest entries to their header once it holds too many bytes, and a hollowed
     * entry keeps its serial, so a row decoded before has to be decoded again.
     */
    private cache = new Map<bigint, { length: number; step: ExecutionStep }>()
    /**
     * Whether what the ring holds can be undone. Off, the ring records all the same, which keeps
     * the call stack it tracks right, but nothing recorded then can ever be undone.
     */
    private undoEnabled = true
    /**
     * The serial of the newest entry when undo was last turned back on. Nothing at or below it is
     * undone, counted or listed; serials only grow, so 0 hides nothing.
     */
    private floor = 0n

    /**
     * The undo history is recorded inside the wasm and nowhere else, and runs
     * go in the bounded slices it is recorded in. A blinkenlib.wasm built
     * without either, or with packets of another version, or one that does not
     * count what it records, is refused when the emulator is created instead
     * of failing at the first step.
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
        if (typeof module.wasmExports?.blinkenlib_history_recorded !== 'function') {
            throw new Error(
                'This blinkenlib.wasm does not count the entries it records: it has no blinkenlib_history_recorded',
            )
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
        this.undoEnabled = true
        this.floor = 0n
    }

    isUndoEnabled(): boolean {
        return this.undoEnabled
    }

    /**
     * Turns undo off, or back on above everything recorded so far. The wasm cannot record without
     * keeping what it records, so the floor is what puts those entries out of reach.
     */
    setUndoEnabled(enabled: boolean): void {
        if (enabled && !this.undoEnabled) this.floor = this.serial(0) ?? this.floor
        this.undoEnabled = enabled
    }

    /**
     * How many entries the wasm has recorded since it loaded: the last serial it handed out.
     * Undo, hollowing, a full ring and the undo floor never take it back, and nothing is recorded
     * while the capacity is 0.
     */
    recorded(): number {
        return Number(this.runtime.module.wasmExports!.blinkenlib_history_recorded!())
    }

    /**
     * How many entries undo can reach: those above the floor, of the ones the ring still holds,
     * and none while undo is off. Every entry's serial is larger than any older one's, so these
     * are the newest entries, and bisection finds where they end. The newest serial alone cannot
     * say how many there are: an undone entry's serial is never handed out again, so the serials
     * the ring holds are not consecutive.
     */
    depth(): number {
        if (!this.undoEnabled) return 0
        let low = 0
        let high = this.runtime.module._blinkenlib_history_count!()
        while (low < high) {
            const middle = (low + high) >>> 1
            if (this.serial(middle)! > this.floor) low = middle + 1
            else high = middle
        }
        return low
    }

    /** The serial of the entry `offset` places back from the newest, when the ring holds one. */
    private serial(offset: number): bigint | undefined {
        const pointer = this.runtime.module._blinkenlib_history_entry!(offset)
        return pointer ? this.view(pointer, 16).getBigUint64(8, true) : undefined
    }

    /** Whether undo may reach the newest entry at all, before asking whether it can be undone. */
    private canReachNewest(): boolean {
        const newest = this.serial(0)
        return this.undoEnabled && newest !== undefined && newest > this.floor
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
        return this.canReachNewest() && Boolean(this.runtime.module._blinkenlib_history_can_undo!())
    }

    undo(): boolean {
        // An entry undo may not reach is left alone exactly as an empty history leaves nothing.
        if (!this.canReachNewest()) return false
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
        const count = Math.min(max, this.depth())
        const nextCache = new Map<bigint, { length: number; step: ExecutionStep }>()
        const steps: ExecutionStep[] = []
        for (let index = 0; index < count; index++) {
            const pointer = this.runtime.module._blinkenlib_history_entry!(index)
            const header = this.view(pointer, 88)
            const serial = header.getBigUint64(8, true)
            const length = header.getUint32(4, true)
            const cached = this.cache.get(serial)
            const step = cached?.length === length ? cached.step : this.decode(pointer, length)
            nextCache.set(serial, { length, step })
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
