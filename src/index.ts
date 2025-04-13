//@ts-ignore
import { uc } from './x86/deps/unicorn-x86.min'
//@ts-ignore
import { ks } from './x86/deps/keystone-x86.min'
//@ts-ignore
import { cs } from './x86/deps/capstone-x86.min'
import { X86InstructionCode, X86InstructionName, X86InstructionNames } from "./instructions";
import { enumKeys } from "./utils";

export {
    X86InstructionNames,
    X86InstructionCode,
    X86InstructionName,
}

/**
 * Enumeration of x86 condition flags
 */
export enum X86ConditionFlags {
    C = 0, // Carry flag
    Z = 1, // Zero flag
    S = 2, // Sign flag
    O = 3, // Overflow flag
    P = 4, // Parity flag
    A = 5, // Auxiliary carry flag
}

/**
 * Enumeration of x86 registers and their corresponding values
 */
export enum X86Register {
    EAX = 19,
    EBX = 21,
    ECX = 22,
    ESP = 30,
    EBP = 20,
    EDI = 23,
    ESI = 29,
    EDX = 24,
}



/** Array of all x86 register names */
export const X86_REGISTERS = enumKeys(X86Register)

/** Stack pointer register identifier */
export const X86_STACK_POINTER_REGISTER = X86Register.ESP;

/** Program counter register identifier (EIP) */
export const X86_PROGRAM_COUNTER_REGISTER = 26 //X86_REG_EIP

/** Flags register identifier (EFLAGS) */
export const X86_FLAGS_REGISTER = 25; //X86_REG_EFLAGS

/**
 * Converts a signed 32-bit integer to an unsigned 32-bit integer
 * @param {number} value - Signed 32-bit integer
 * @returns {number} Unsigned 32-bit integer
 */
function signed32ToUnsigned32(value: number): number {
    if (value < 0) {
        return value + Math.pow(2, 32);
    }
    return value;
}

/**
 * Represents a single x86 instruction
 */
export type X86Instruction = {
    /** Memory address of the instruction */
    address: number;
    /** Human-readable text representation of the instruction */
    text: string;
    /** Mnemonic name of the instruction */
    name: string;
    /** Instruction identifier */
    id: X86InstructionCode;
    /** Raw bytes of the instruction */
    bytes: number[];
    /** Line number in the source code */
    line: number;
    /** Size of the instruction in bytes */
    size: number;
}

//TODO
type HistoryEntry = {}

/**
 * Calculates the required page size for memory allocation
 * @param {number} size - Required memory size
 * @returns {number} Padded size aligned to page boundaries (4KB)
 */
function calculatePageSize(size: number): number {
    const pageSize = 4096; // 4KB
    return Math.ceil(size / pageSize) * pageSize;
}

/**
 * Simplifies error objects to string messages
 * @param {any} e - Error object or string
 * @returns {string} Simplified error message
 */
function simplifyError(e: any) {
    return typeof e === 'string' ? e : e.message
}

/**
 * X86 assembly interpreter using Unicorn, Keystone, and Capstone engines
 */
export class X86Interpreter {

    /**
     * Creates a new X86Interpreter instance
     * @param {string} code - Assembly code to interpret
     * @param {any} assembler - Keystone assembler instance
     * @param {any} interpreter - Unicorn interpreter instance
     * @param {any} disambler - Capstone disassembler instance
     */
    constructor(
        private readonly code: string,
        private readonly assembler: any,
        private readonly interpreter: any,
        private readonly disambler: any,
    ) {
    }

    /** Starting address for the code segment */
    static START_ADDRESS = 0x1000;
    /** Starting address for the stack segment */
    static STACK_START_ADDRESS = 0xf0000;
    /** Size of the stack segment */
    static STACK_SIZE = 0xf0000;
    /** Buffer containing assembled code bytes */
    private codeBuffer: number[] | null = null;
    /** Array of disassembled instructions */
    private instructions: X86Instruction[] = []
    /** Address following the last instruction */
    private endAddress: number = 0;

    /**
     * Hook callback for the interpreter
     * @param {any} handle - Hook handle
     * @param {number} addr_lo - Lower address bound
     * @param {number} addr_hi - Higher address bound
     * @param {number} size - Size of the region
     * @param {any} user_data - User data
     */
    //@ts-ignore
    private hook = (handle, addr_lo, addr_hi, size, user_data) => {

    }

    /**
     * Gets the disassembled instructions from the code buffer
     * @returns {any[]} Array of disassembled instructions
     * @throws {Error} If disassembly fails
     */
    private getInstructions() {
        try {
            return this.disambler.disasm(this.codeBuffer, X86Interpreter.START_ADDRESS) as any[]
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Assembles the code and prepares for interpretation
     * @throws {Error} If assembly fails
     */
    assemble() {
        try {
            this.codeBuffer = this.assembler.asm(this.code) as number[]
            const instructions = this.getInstructions();
            this.instructions = instructions.map((ins, i) => {
                return {
                    address: ins.address,
                    bytes: ins.bytes,
                    size: ins.size,
                    id: ins.id,
                    text: `${ins.mnemonic} ${ins.op_str}`,
                    name: ins.mnemonic,
                    line: i,
                }
            })
            this.endAddress = X86Interpreter.START_ADDRESS + this.codeBuffer.length;
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Initializes memory and registers for the interpreter
     * @throws {Error} If code buffer is not initialized
     */
    initialize() {
        if (!this.codeBuffer) {
            throw new Error('Code buffer is not initialized. Please call assemble() first.');
        }
        this.interpreter.mem_map(X86Interpreter.START_ADDRESS, calculatePageSize(this.codeBuffer.length), uc.PROT_ALL);
        this.interpreter.mem_write(X86Interpreter.START_ADDRESS, this.codeBuffer);
        this.interpreter.mem_map(X86Interpreter.STACK_START_ADDRESS, calculatePageSize(X86Interpreter.STACK_SIZE), uc.PROT_ALL);
        console.log(X86Interpreter.STACK_START_ADDRESS + X86Interpreter.STACK_SIZE)
        this.interpreter.reg_write_i32(X86Register.ESP, X86Interpreter.STACK_START_ADDRESS + X86Interpreter.STACK_SIZE);
        this.interpreter.reg_write_i32(X86Register.EBP, X86Interpreter.STACK_START_ADDRESS + X86Interpreter.STACK_SIZE);
        this.interpreter.reg_write_i32(X86_PROGRAM_COUNTER_REGISTER, X86Interpreter.START_ADDRESS);
    }

    /**
     * Simulates the execution of the code
     * @param {number} [limit] - Optional instruction execution limit
     * @throws {Error} If simulation fails
     */
    simulate(limit?: number) {
        try {
            //TODO add tracing
            const address = this.getProgramCounter();
            this.interpreter.emu_start(address, this.endAddress, 0, limit);
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Simulates execution with specified breakpoints
     * @param {number[]} breakpoints - Array of addresses to break at
     * @param {number} [limit] - Optional instruction execution limit
     * @throws {Error} If simulation fails
     */
    simulateWithBreakpoints(breakpoints: number[], limit?: number) {
        const breakpointsMap = new Map(breakpoints.map((bp) => [bp, true]));
        const handle = this.interpreter.hook_add(uc.HOOK_CODE, (_: unknown, address: number) => {
            if (breakpointsMap.has(address)) {
                this.interpreter.emu_stop();
            }
        });
        try {
            this.simulate(limit);
        } catch (e) {
            throw new Error(simplifyError(e));
        } finally {
            this.interpreter.hook_del(handle);
        }
    }

    /**
     * Executes a single instruction
     */
    step() {
        this.simulate(1);
    }

    /**
     * Gets the value of a register
     * @param {X86Register} register - Register to read
     * @returns {number} Unsigned 32-bit register value
     * @throws {Error} If reading the register fails
     */
    getRegisterValue(register: X86Register) {
        try {
            const signed = this.interpreter.reg_read_i32(register);
            return signed32ToUnsigned32(signed);
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Sets the value of a register
     * @param {X86Register} register - Register to write
     * @param {number} value - Value to set
     * @throws {Error} If writing to the register fails
     */
    setRegisterValue(register: X86Register, value: number) {
        try {
            this.interpreter.reg_write_i32(register, value);
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Gets the current stack pointer value
     * @returns {number} Stack pointer value
     */
    getStackPointer() {
        return this.getRegisterValue(X86_STACK_POINTER_REGISTER);
    }

    /**
     * Gets the current program counter value
     * @returns {number} Program counter value
     */
    getProgramCounter() {
        return this.getRegisterValue(X86_PROGRAM_COUNTER_REGISTER as X86Register);
    }

    /**
     * Gets the values of all registers
     * @returns {number[]} Array of register values
     */
    getRegistersValues(): number[] {
        return X86_REGISTERS.map((reg) => {
            return this.getRegisterValue(X86Register[reg as keyof typeof X86Register]);
        })
    }

    /**
     * Reads bytes from memory
     * @param {number} address - Memory address to read from
     * @param {number} length - Number of bytes to read
     * @returns {number[]} Array of byte values
     * @throws {Error} If reading memory fails
     */
    readMemoryBytes(address: number, length: number): Uint8Array {
        try {
            return this.interpreter.mem_read(address, length);
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Writes bytes to memory
     * @param {number} address - Memory address to write to
     * @param {number[]} bytes - Array of byte values to write
     */
    setMemoryBytes(address: number, bytes: number[]) {
        try {
            this.interpreter.mem_write(address, bytes);
        } catch (e) {
            // Error handling is missing here
        }
    }

    /**
     * Gets the next instruction to be executed
     * @returns {X86Instruction | null} Next instruction or null if no more instructions
     */
    getNextStatement(): X86Instruction | null {
        const pc = this.getProgramCounter();
        const instruction = this.instructions.find((ins) => ins.address === pc);
        return instruction ?? null;
    }

    /**
     * Checks if the execution has terminated (no more instructions)
     * @returns {boolean} True if execution is terminated
     */
    isTerminated() {
        return this.getNextStatement() === null;
    }

    /**
     * Gets the current state of all condition flags
     * @returns {Record<X86ConditionFlags, number>} Object mapping flags to their values (0 or 1)
     */
    getConditionFlags(): Record<X86ConditionFlags, number> {
        const flags = this.interpreter.reg_read_i32(X86_FLAGS_REGISTER) as number;
        return {
            [X86ConditionFlags.C]: (flags >> 0) & 1,
            [X86ConditionFlags.P]: (flags >> 2) & 1,
            [X86ConditionFlags.A]: (flags >> 4) & 1,
            [X86ConditionFlags.Z]: (flags >> 6) & 1,
            [X86ConditionFlags.S]: (flags >> 7) & 1,
            [X86ConditionFlags.O]: (flags >> 11) & 1,
        }
    }

    /**
     * Gets the instruction at a specific address
     * @param {number} address - Memory address
     * @returns {X86Instruction | null} Instruction at the address or null if not found
     */
    getStatementAtAddress(address: number): X86Instruction | null {
        const instruction = this.instructions.find((ins) => ins.address === address);
        return instruction ?? null;
    }

    /**
     * Gets the source code as a string
     * @returns {string} Source code
     */
    getSource() {
        this.instructions.map((ins) => ins.text).join('/n')
    }

    /**
     * Gets the instruction at a specific source line
     * @param {number} lineIndex - Line index in the source code
     * @returns {X86Instruction | null} Instruction at the line or null if not found
     */
    getStatementAtSourceLine(lineIndex: number): X86Instruction | null {
        return this.instructions[lineIndex] ?? null;
    }

    /*
    getCallStack() {
        throw new Error('Method not implemented.');
    }
     */

    /**
     * Gets all disassembled instructions
     * @returns {X86Instruction[]} Array of all instructions
     */
    getAssembledStatements() {
        return this.instructions
    }

    /**
     * Creates a new X86Interpreter instance with the provided assembly code
     * @param {string} code - Assembly code to interpret
     * @returns {X86Interpreter} New interpreter instance
     * @throws {Error} If creating the interpreter fails
     */
    static create(code: string) {
        try {
            const keystone = new ks.Keystone(ks.ARCH_X86, ks.MODE_32);
            keystone.option(ks.OPT_SYNTAX, ks.OPT_SYNTAX_INTEL);
            const interpreter = new X86Interpreter(
                code,
                keystone,
                new uc.Unicorn(uc.ARCH_X86, uc.MODE_32),
                //@ts-ignore
                new cs.Capstone(cs.ARCH_X86, cs.MODE_32)
            )
            return interpreter;
        } catch (e) {
            throw new Error(simplifyError(e));
        }
    }

    /**
     * Releases resources used by the interpreter
     */
    dispose() {
        this.interpreter.close();
        this.assembler.close()
        this.disambler.close();
    }
}