export type StatusRegister = {
    name: string
    value: number
    prev: number
}
export type MonacoError = {
    lineIndex: number
    column: number
    line: {
        line: string
        line_index: number
    }
    message: string
    formatted: string
}

export type StackFrame = {
    name: string
    address: bigint
    destination: bigint
    sp: bigint
    line: number
    color: string
}

export type RegisterHex = [hi: string, lo: string]

export enum RegisterSize {
    Byte = 1,
    Word = 2,
    Long = 4,
    Double = 8
}

export type ExecutionStep = {
    mutations: MutationOperation[]
    pc: number
    old_ccr: {
        bits: number
    }
    new_ccr: {
        bits: number
    }
    line: number
}

export type MutationOperation =
    | {
          type: 'WriteRegister'
          value: {
              register: string
              old: bigint
              size: RegisterSize
          }
      }
    | {
          type: 'WriteMemory'
          value: {
              address: bigint
              old: bigint
              size: RegisterSize
          }
      }
    | {
          type: 'WriteMemoryBytes'
          value: {
              address: bigint
              old: number[]
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

    abstract run(limit?: number, breakpoints?: number[]): Promise<EmulatorStatus>;
}