# X86 Interpreter
[![npm](https://img.shields.io/npm/v/@specy/x86.svg)](https://www.npmjs.com/package/@specy/x86)

A TypeScript library for x86 assembly interpretation, simulation, and debugging.

## Overview

This library provides a JavaScript/TypeScript interface for interpreting and simulating x86 assembly code. It combines three powerful engines:

- **[Unicorn.js](https://github.com/AlexAltea/unicorn.js)** - For CPU emulation
- **[Keystone.js](https://github.com/AlexAltea/keystone.js)** - For assembly
- **[Capstone.js](https://github.com/AlexAltea/capstone.js)** - For disassembly

With this library, you can assemble, execute, and debug x86 instructions, manipulate registers and memory, and analyze program behavior at the instruction level.

## Features

- **Assembly/Disassembly**: Convert x86 assembly code to machine code and back
- **Full Simulation**: Execute assembled code with configurable limits and breakpoints
- **Register Access**: Read and write x86 registers (EAX, EBX, ECX, etc.)
- **Memory Management**: Allocate, read, and write memory
- **Debugging Support**: Single-step execution, breakpoints, and state inspection
- **Flag Monitoring**: Track condition flags (carry, zero, sign, overflow, etc.)

## Installation

```bash
npm install @specy/x86
```

## Basic Usage

```typescript
import { X86Interpreter } from '@specy/x86';

// Create an interpreter with assembly code
const code = `
mov eax, 42
add ebx, eax
`;

// Create and initialize the interpreter
const interpreter = X86Interpreter.create(code);
interpreter.assemble();
interpreter.initialize();

// Execute the code
interpreter.simulate();

// Read results
const eaxValue = interpreter.getRegisterValue(X86Register.EAX);
const ebxValue = interpreter.getRegisterValue(X86Register.EBX);

console.log(`EAX: ${eaxValue}, EBX: ${ebxValue}`);

// Clean up resources
interpreter.dispose();
```

## Step-by-Step Debugging

```typescript
// Create and initialize
const interpreter = X86Interpreter.create(assemblyCode);
interpreter.assemble();
interpreter.initialize();

// Execute one instruction at a time
while (!interpreter.isTerminated()) {
  const instruction = interpreter.getNextStatement();
  console.log(`Executing: ${instruction?.text}`);
  
  // Show register values
  const eax = interpreter.getRegisterValue(X86Register.EAX);
  console.log(`EAX: 0x${eax.toString(16)}`);
  
  // Execute one instruction
  interpreter.step();
}

interpreter.dispose();
```

## Breakpoint Support

```typescript
// Set breakpoints at specific addresses
const breakpoints = [0x1010, 0x1020];
interpreter.simulateWithBreakpoints(breakpoints);

// Program execution will pause at each breakpoint
console.log("Execution paused at breakpoint");
console.log(`PC: 0x${interpreter.getProgramCounter().toString(16)}`);
```

## Memory Access

```typescript
// Write bytes to memory
const bytes = [0x90, 0x90, 0x90]; // NOP instructions
interpreter.setMemoryBytes(0x2000, bytes);

// Read memory content
const memoryContent = interpreter.readMemoryBytes(0x2000, 3);
console.log("Memory content:", memoryContent);
```

## Flag Inspection

```typescript
// After execution, check condition flags
const flags = interpreter.getConditionFlags();
console.log("Zero flag:", flags[X86ConditionFlags.Z]);
console.log("Carry flag:", flags[X86ConditionFlags.C]);
```

## API Reference

### X86Interpreter Class

The main class for x86 assembly interpretation and simulation.

#### Constructor

- `constructor(code: string, assembler: any, interpreter: any, disambler: any)`

#### Static Methods

- `create(code: string): X86Interpreter` - Creates a new interpreter instance with the provided assembly code

#### Methods

- `assemble(): void` - Assembles the code and prepares for interpretation
- `initialize(): void` - Initializes memory and registers for the interpreter
- `simulate(limit?: number): void` - Simulates the execution of the code
- `simulateWithBreakpoints(breakpoints: number[], limit?: number): void` - Simulates execution with specified breakpoints
- `step(): void` - Executes a single instruction
- `getRegisterValue(register: X86Register): number` - Gets the value of a register
- `setRegisterValue(register: X86Register, value: number): void` - Sets the value of a register
- `getStackPointer(): number` - Gets the current stack pointer value
- `getProgramCounter(): number` - Gets the current program counter value
- `getRegistersValues(): number[]` - Gets the values of all registers
- `readMemoryBytes(address: number, length: number): number[]` - Reads bytes from memory
- `setMemoryBytes(address: number, bytes: number[]): void` - Writes bytes to memory
- `getNextStatement(): X86Instruction | null` - Gets the next instruction to be executed
- `isTerminated(): boolean` - Checks if the execution has terminated
- `getConditionFlags(): Record<X86ConditionFlags, number>` - Gets the current state of all condition flags
- `getStatementAtAddress(address: number): X86Instruction | null` - Gets the instruction at a specific address
- `getStatementAtSourceLine(lineIndex: number): X86Instruction | null` - Gets the instruction at a specific source line
- `getAssembledStatements(): X86Instruction[]` - Gets all disassembled instructions
- `dispose(): void` - Releases resources used by the interpreter

### Enums

#### X86Register

```typescript
enum X86Register {
    EAX = 19,
    EBX = 21,
    ECX = 22,
    ESP = 30,
    EBP = 20,
    EDI = 23,
    ESI = 29,
    EDX = 24,
}
```

#### X86ConditionFlags

```typescript
enum X86ConditionFlags {
    C = 0, // Carry flag
    Z = 1, // Zero flag
    S = 2, // Sign flag
    O = 3, // Overflow flag
    P = 4, // Parity flag
    A = 5, // Auxiliary carry flag
}
```