export type StatusRegister = {
    name: string
    value: number
    prev: number
}
export type DiagnosticSeverity = 'error' | 'warning'

export type MonacoError = {
    /** Project-relative source path when checking a virtual Project. */
    file?: string
    lineIndex: number
    column: number
    /**
     * One-based and exclusive, so the squiggle covers the whole name the
     * assembler complained about. Absent when the message named nothing that
     * could be found in the line.
     */
    endColumn?: number
    line: {
        line: string
        line_index: number
    }
    message: string
    formatted: string
    /** A warning still assembles; only an error stops the build. Absent means error. */
    severity?: DiagnosticSeverity
    /** The assembler's own name for the warning, such as `label-orphan`. */
    code?: string
    /** Help beyond what the assembler said, when this diagnostic has a known explanation. */
    hint?: string
}

export type StackFrame = {
    name: string
    address: bigint
    destination: bigint
    sp: bigint
    line: number
    file?: string
    color: string
}

export type RegisterHex = [hi: string, lo: string]

export enum RegisterSize {
    Byte = 1,
    Word = 2,
    Long = 4,
    Double = 8,
    /** 16 bytes, the width of an SSE register. */
    Quad = 16
}

/**
 * What produced a history entry: an instruction the program ran, or a Poke,
 * one or more register and memory values the host changed between two
 * instructions. Always present on an entry, so a reader never has to infer it.
 */
export type ExecutionStepKind = 'instruction' | 'poke'

/**
 * One value a Poke changed, with what the emulator held when the write was
 * made and what it holds when the transaction closes. Register names are the
 * ones this package already uses: `rax`, `xmm3`, `st0`, `mxcsr` and so on.
 */
export type PokeWrite =
    | {
          type: 'register'
          name: string
          old: bigint
          new: bigint
      }
    | {
          type: 'memory'
          address: bigint
          old: number[]
          new: number[]
      }

export type ExecutionStep = {
    kind: ExecutionStepKind
    mutations: MutationOperation[]
    pc: number
    old_ccr: {
        bits: number
    }
    new_ccr: {
        bits: number
    }
    line: number
    file?: string
    /** Present only on a `poke` entry: the values the host wrote, old and new. */
    writes?: PokeWrite[]
}

/**
 * What a history entry says an instruction or a Poke changed. Every write
 * carries BOTH sides of the change: `old`, the value it replaced, and `new`,
 * the value it left, each as this package reports that value elsewhere -
 * a whole 64-bit register as a bigint, memory as a byte array. An entry is
 * fixed when it is recorded and keeps saying what its own step did however
 * much has happened since.
 */
export type MutationOperation =
    | {
          type: 'WriteRegister'
          value: {
              register: string
              /** The WHOLE register before the write, whatever width the store was. */
              old: bigint
              /** The whole register after it, from the same post-step snapshot the entry was diffed from. */
              new: bigint
              size: RegisterSize
          }
      }
    | {
          type: 'WriteMemory'
          value: {
              address: bigint
              old: bigint
              new: bigint
              size: RegisterSize
          }
      }
    | {
          type: 'WriteMemoryBytes'
          value: {
              address: bigint
              /** The bytes the write replaced, at the width of the write. */
              old: number[]
              /**
               * The bytes the write left at that address, at the same width.
               * The machine's write journal captures only the bytes a store
               * replaced, so these are read out of the machine as the entry is
               * recorded - the step has finished and nothing has run since,
               * which is why they are still the bytes that step left. Were one
               * step ever to store twice over the same address, both entries
               * would report the bytes the step ENDED with; no x86 instruction
               * reachable here journals two stores to one address. Empty when
               * the machine refused to read the range back.
               */
              new: number[]
          }
      }
    | {
          type: 'PopCallStack'
          value: {
              to: bigint
              from: bigint
          }
      }
    | {
          type: 'PushCallStack'
          value: {
              to: bigint
              from: bigint
          }
      }
    | {
          type: 'Other'
          value: string
      }


export type EmulatorDecoration = {
    type: 'below-line'
    note?: string
    belowLine: number
    md: string
}


export type CompilationError = {
    type: 'raw'
    message: string
}

export enum EmulatorStatus {
    Terminated = 0,
    Running = 1,
    WaitingForInput = 2,
    NotReady = 3,
}

export type Instruction = {
    address: bigint
    lineNumber: number
    file?: string
    size?: number
    bytes?: Uint8Array
    code: string
}

export type EmulatorConfig<R extends string> = {
    systemSize: RegisterSize
    registerNames: R[]
    endianness?: 'little' | 'big'
    hiddenRegisters?: R[]
}

export abstract class BaseEmulator<
    T,
    R extends string,
    CompileResult = { ok: true } | { ok: false, errors: CompilationError[], report: string },
> {

    protected _registerNames: R[]
    protected _systemSize: RegisterSize
    protected _endianness: 'little' | 'big'

    constructor(options: EmulatorConfig<R>) {
        this._registerNames = options.registerNames;
        this._systemSize = options.systemSize;
        this._endianness = options.endianness ?? 'little';
    }

    getSystemSize(): RegisterSize {
        return this._systemSize;
    }

    getEndianness(): 'little' | 'big' {
        return this._endianness;
    }



    getRegisterNames(): R[] {
        return this._registerNames;
    }

    abstract initialize(undoSize: number): void;

    abstract getCompiledCode(): { decorations: EmulatorDecoration[], code: string }

    abstract dispose(): void;

    abstract stringifyError(error: unknown): string;

    abstract compile(code: string): Promise<CompileResult>;

    abstract checkCode(code: string): Promise<MonacoError[]>;

    abstract undo(): void;

    abstract canUndo(): boolean;

    abstract step(): Promise<{ terminated: boolean }>

    abstract getStatus(): EmulatorStatus;

    abstract writeMemoryBytes(address: bigint, data: Uint8Array): void;

    abstract readMemoryBytes(address: bigint, length: bigint): Uint8Array;

    abstract getNextInstruction(): Instruction | null;

    abstract getUndoHistory(max: number): ExecutionStep[]

    abstract getPc(): bigint;

    abstract getSp(): bigint;

    abstract getFlags(): {name: string, value: number, prev?: number}[];

    abstract getCallStack(): StackFrame[];

    abstract getInstructionAt(address: bigint): Instruction | null;

    abstract getRegisterValues(): bigint[]

    abstract getRegisterValuesRecord(): Record<R, bigint>

    abstract getRegisterValue(register: R, size?: RegisterSize): bigint

    abstract setRegisterValue(register: R, value: bigint, size?: RegisterSize): void;

    abstract hasTerminated(): boolean

    abstract run(
        limit?: number,
        breakpoints?: Array<number | { path: string; line: number }>,
    ): Promise<EmulatorStatus>;
}
