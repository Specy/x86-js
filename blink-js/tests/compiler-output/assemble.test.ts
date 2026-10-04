// Translated programs assembled, linked and run by the Core in its default NASM mode. The
// translator never emits startup code, so each Build adds a start unit of its own, as a Runtime
// library's `crt0` would: it runs the `.init_array` entries, calls `main` and exits with its value.
import { describe, expect, it } from 'vitest'
import { translateCompilerOutput } from '../../src/compiler-output'
import { createX86Emulator } from '../../src/x86-emulator'

const START_UNIT = [
    'default rel',
    'extern main',
    'extern __init_array_start',
    'extern __init_array_end',
    'global _start',
    'section .text',
    '_start:',
    '    lea rbx, [__init_array_start]',
    '.next:',
    '    lea rax, [__init_array_end]',
    '    cmp rbx, rax',
    '    jae .done',
    '    call [rbx]',
    '    add rbx, 8',
    '    jmp .next',
    '.done:',
    '    call main',
    '    mov edi, eax',
    '    mov eax, 60',
    '    syscall',
].join('\n')

const IDENT = '\t.ident\t"GCC: (Compiler-Explorer-Build-gcc--binutils-2.42) 14.2.0"'
const NOTE = '\t.section\t.note.GNU-stack,"",@progbits'

/** Translates, builds beside the start unit, runs, and returns the exit value. */
async function run(input: readonly string[]): Promise<number | undefined> {
    const result = translateCompilerOutput(input, { profile: 'gcc-intel-v1' })
    if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.inputLine}: ${d.message}`).join('\n'))
    const emulator = await createX86Emulator()
    try {
        const build = await emulator.compileProject({
            entry: 'src/main.c.asm',
            files: { 'src/main.c.asm': result.text, 'runtime/crt0.asm': START_UNIT },
        })
        if (!build.ok) throw new Error(build.errors.map((e) => `${e.file}:${e.line}: ${e.error}`).join('\n'))
        // The contract: what the translator writes assembles with no NASM warnings.
        expect(build.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')).toEqual([])
        await emulator.run()
        expect(emulator.stopReason?.kind).toBe('exit')
        return emulator.stopReason?.kind === 'exit' ? emulator.stopReason.exitCode : undefined
    } finally {
        emulator.dispose()
    }
}

describe('translated programs in the Core', () => {
    it('runs C names NASM reserves, a local common, a string with a backquote and a location table', async () => {
        const input = [
            '\t.file\t"example.c"',
            '\t.intel_syntax noprefix',
            '\t.text',
            '.Ltext0:',
            '\t.file 0 "/app" "/app/example.c"',
            '\t.globl\tadd',
            '\t.type\tadd, @function',
            'add:',
            '.LFB0:',
            '\t.file 1 "src/main.c"',
            '\t.loc 1 2 23',
            '\t.cfi_startproc',
            '\tlea\teax, [rdi+rsi]',
            '\tret',
            '\t.cfi_endproc',
            '.LFE0:',
            '\t.size\tadd, .-add',
            '\t.section\t.text.startup,"ax",@progbits',
            '\t.p2align 4',
            '\t.globl\tmain',
            '\t.type\tmain, @function',
            'main:',
            '\t.loc 1 7 16',
            '\tmov\tedi, DWORD PTR si[rip]',
            '\tmov\tesi, DWORD PTR rel[rip]',
            '\tcall\tadd',
            '\tadd\teax, DWORD PTR n.0[rip]',
            '\tmovzx\tedx, BYTE PTR text[rip+3]',
            '\tadd\teax, edx',
            '\tret',
            '\t.local\tn.0',
            '\t.comm\tn.0,4,4',
            '\t.globl\tsi',
            '\t.data',
            '\t.align 4',
            '\t.type\tsi, @object',
            '\t.size\tsi, 4',
            'si:',
            '\t.long\t3',
            '\t.globl\trel',
            '\t.align 4',
            'rel:',
            '\t.long\t5',
            '\t.section\t.rodata',
            'text:',
            '\t.string\t"a`\\tl"',
            '\t.text',
            '.Letext0:',
            '\t.section\t.debug_info,"",@progbits',
            '\t.long\t0x7f',
            '\t.uleb128 0x2',
            IDENT,
            NOTE,
        ]
        // si + rel + the zeroed local + 'l'
        expect(await run(input)).toBe(3 + 5 + 0 + 108)
    })

    it('runs a constructor from .init_array, a COMDAT weak function and its .set alias', async () => {
        const input = [
            '\t.intel_syntax noprefix',
            '\t.text',
            '\t.p2align 4',
            '\t.type\t_GLOBAL__sub_I_seven, @function',
            '_GLOBAL__sub_I_seven:',
            '\tmov\teax, DWORD PTR seven[rip]',
            '\tlea\teax, [rax+rax*2]',
            '\tadd\teax, eax',
            '\tmov\tDWORD PTR config[rip], eax',
            '\tret',
            '\t.section\t.init_array,"aw"',
            '\t.align 8',
            '\t.quad\t_GLOBAL__sub_I_seven',
            '\t.section\t.text._ZN7Counter4nextEv,"axG",@progbits,_ZN7Counter4nextEv,comdat',
            '\t.align 2',
            '\t.weak\t_ZN7Counter4nextEv',
            '\t.type\t_ZN7Counter4nextEv, @function',
            '_ZN7Counter4nextEv:',
            '\tmov\teax, DWORD PTR [rdi]',
            '\tadd\teax, 1',
            '\tmov\tDWORD PTR [rdi], eax',
            '\tret',
            '\t.weak\t_ZN7Counter4bumpEv',
            '\t.set\t_ZN7Counter4bumpEv,_ZN7Counter4nextEv',
            '\t.text',
            '\t.globl\tmain',
            'main:',
            '\tsub\trsp, 24',
            '\tmov\tDWORD PTR [rsp+12], 10',
            '\tlea\trdi, [rsp+12]',
            '\tcall\t_ZN7Counter4bumpEv',
            '\tmov\teax, DWORD PTR config[rip]',
            '\tadd\teax, DWORD PTR [rsp+12]',
            '\tadd\trsp, 24',
            '\tret',
            '\t.globl\tconfig',
            '\t.bss',
            '\t.align 4',
            'config:',
            '\t.zero\t4',
            '\t.globl\tseven',
            '\t.data',
            '\t.align 4',
            'seven:',
            '\t.long\t7',
            IDENT,
            NOTE,
        ]
        // The constructor's 42 plus the counter bumped from 10.
        expect(await run(input)).toBe(42 + 11)
    })

    it('runs x87 register forms, a 64-byte-aligned global, a common and an undefined weak symbol', async () => {
        const input = [
            '\t.intel_syntax noprefix',
            '\t.text',
            '\t.globl\tmain',
            'main:',
            '\tfld\tTBYTE PTR a[rip]',
            '\tfld\tTBYTE PTR b[rip]',
            '\tfsubp\tst(1), st',
            '\tfld\tTBYTE PTR c[rip]',
            '\tfdivr\tst, st(1)',
            '\tfstp\tst(1)',
            '\tfistp\tDWORD PTR [rsp-8]',
            '\tmov\teax, DWORD PTR [rsp-8]',
            '\tmov\tedx, OFFSET FLAT:helper',
            '\ttest\trdx, rdx',
            '\tjne\t.L2',
            '\tadd\teax, 100',
            '.L2:',
            '\tadd\teax, DWORD PTR shared[rip]',
            '\tlea\trdx, aligned[rip]',
            '\tand\tedx, 63',
            '\tadd\teax, edx',
            '\tadd\teax, DWORD PTR aligned[rip+28]',
            '\tret',
            '\t.weak\thelper',
            '\t.comm\tshared,4,4',
            '\t.globl\taligned',
            '\t.data',
            '\t.align 64',
            'aligned:',
            '\t.long\t1, 2, 3, 4, 5, 6, 7, 8',
            '\t.section\t.rodata',
            '\t.align 16',
            'a:',
            '\t.long\t0',
            '\t.long\t-1610612736',
            '\t.long\t16386',
            '\t.long\t0',
            '\t.align 16',
            'b:',
            '\t.long\t0',
            '\t.long\t-2147483648',
            '\t.long\t16385',
            '\t.long\t0',
            '\t.align 16',
            'c:',
            '\t.long\t0',
            '\t.long\t-2147483648',
            '\t.long\t16384',
            '\t.long\t0',
            IDENT,
            NOTE,
        ]
        // (10 - 4) / 2, plus 100 for the missing weak helper, the zeroed common, an aligned address
        // and aligned[7].
        expect(await run(input)).toBe(3 + 100 + 0 + 0 + 8)
    })

    it('runs a jump table in .rodata, an indirect call through memory and rep stosq', async () => {
        const input = [
            '\t.intel_syntax noprefix',
            '\t.text',
            '\t.p2align 4',
            '\t.globl\tpick',
            'pick:',
            '\tcmp\tedi, 3',
            '\tja\t.L2',
            '\tmov\tedi, edi',
            '\tjmp\t[QWORD PTR .L4[0+rdi*8]]',
            '\t.section\t.rodata',
            '\t.align 8',
            '\t.align 4',
            '.L4:',
            '\t.quad\t.L7',
            '\t.quad\t.L6',
            '\t.quad\t.L5',
            '\t.quad\t.L3',
            '\t.text',
            '.L7:',
            '\tmov\teax, 11',
            '\tret',
            '.L6:',
            '\tmov\teax, 22',
            '\tret',
            '.L5:',
            '\tmov\teax, 33',
            '\tret',
            '.L3:',
            '\tmov\teax, 44',
            '\tret',
            '.L2:',
            '\txor\teax, eax',
            '\tret',
            '\t.globl\tmain',
            'main:',
            '\tpush\trbx',
            '\tsub\trsp, 32',
            '\tmov\trdi, rsp',
            '\tmov\tecx, 4',
            '\txor\teax, eax',
            '\trep stosq',
            '\tmov\tQWORD PTR [rsp+8], OFFSET FLAT:pick',
            '\tlea\trbx, [rsp+8]',
            '\tmov\tedi, 2',
            '\tcall\t[QWORD PTR [rbx]]',
            '\tadd\teax, DWORD PTR values[rip+4]',
            '\tmov\tecx, 2',
            '\tadd\teax, DWORD PTR values[0+rcx*4]',
            '\tsar\teax',
            '\tadd\trsp, 32',
            '\tpop\trbx',
            '\tret',
            '\t.globl\tvalues',
            '\t.data',
            '\t.align 16',
            'values:',
            '\t.long\t10',
            '\t.long\t20',
            '\t.long\t30',
            IDENT,
            NOTE,
        ]
        // (pick(2) + values[1] + values[2]) / 2
        expect(await run(input)).toBe((33 + 20 + 30) >> 1)
    })
})

// Function alignment (plan note 8), on GCC's own output: `gcc -S` under the profile's flags plus
// `-ffreestanding -fno-section-anchors -fdebug-prefix-map=$PWD=/app` (and, for C++,
// `-fno-threadsafe-statics`), without the DWARF sections between `.Letext0:` and `.ident`, which the
// translation drops. GCC 15.2 wrote them, so each translation also carries an `unverified-compiler`
// warning, which `run` lets through.

describe('function alignment in the Core (note 8)', () => {
    it('calls C++ member functions through pointers to members at -O0', async () => {
        // add(1) leaves 2, twice(2) leaves 6, and the virtual plus(3) returns 9.
        expect(await run(lines(MEMBERS_O0))).toBe(2 + 6 + 9)
    })

    it('calls C++ member functions through pointers to members at -O2', async () => {
        expect(await run(lines(MEMBERS_O2))).toBe(2 + 6 + 9)
    })

    it('keeps an aligned(64) function on a 64-byte boundary', async () => {
        const result = translateCompilerOutput(lines(ALIGNED_O0), { profile: 'gcc-intel-v1' })
        expect(result.ok && result.text).toContain('    section .text align=64\n')
        // 10 for the aligned address, plus sixty_four(before(2)).
        expect(await run(lines(ALIGNED_O0))).toBe(10 + 7)
    })
})

function lines(text: string): string[] {
    return text.split('\n')
}

/**
 * `g++ -O0` of members.cpp:
 *
 *     struct Counter {
 *         int value;
 *         int add(int n) { return value += n; }
 *         int twice(int n) { return value += 2 * n; }
 *         virtual int plus(int n) { return value + n; }
 *     };
 *
 *     typedef int (Counter::*Method)(int);
 *
 *     __attribute__((noipa)) int call(Counter &counter, Method method, int n) { return (counter.*method)(n); }
 *
 *     int main(void) {
 *         Counter counter;
 *         counter.value = 1;
 *         return call(counter, &Counter::add, 1) + call(counter, &Counter::twice, 2) + call(counter, &Counter::plus, 3);
 *     }
 *
 * Under the Itanium C++ ABI a pointer to a member function holds the function's address, or one
 * plus the offset of its vtable slot for a virtual one, and `call` tells them apart by the low bit:
 * GCC writes `.align 2` before every member function so that none starts at an odd address. With
 * the alignment dropped, `add` or `twice` did, and the call through its pointer crashed.
 */
const MEMBERS_O0 = `\t.file\t"members.cpp"
\t.intel_syntax noprefix
\t.text
.Ltext0:
\t.file 0 "/app" "members.cpp"
\t.section\t.text._ZN7Counter3addEi,"axG",@progbits,_ZN7Counter3addEi,comdat
\t.align 2
\t.weak\t_ZN7Counter3addEi
\t.type\t_ZN7Counter3addEi, @function
_ZN7Counter3addEi:
.LFB0:
\t.file 1 "members.cpp"
\t.loc 1 3 9
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tQWORD PTR [rbp-8], rdi
\tmov\tDWORD PTR [rbp-12], esi
\t.loc 1 3 29
\tmov\trax, QWORD PTR [rbp-8]
\tmov\tedx, DWORD PTR [rax+8]
\t.loc 1 3 35
\tmov\teax, DWORD PTR [rbp-12]
\tadd\tedx, eax
\tmov\trax, QWORD PTR [rbp-8]
\tmov\tDWORD PTR [rax+8], edx
\t.loc 1 3 38
\tmov\trax, QWORD PTR [rbp-8]
\tmov\teax, DWORD PTR [rax+8]
\t.loc 1 3 41
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE0:
\t.size\t_ZN7Counter3addEi, .-_ZN7Counter3addEi
\t.section\t.text._ZN7Counter5twiceEi,"axG",@progbits,_ZN7Counter5twiceEi,comdat
\t.align 2
\t.weak\t_ZN7Counter5twiceEi
\t.type\t_ZN7Counter5twiceEi, @function
_ZN7Counter5twiceEi:
.LFB1:
\t.loc 1 4 9
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tQWORD PTR [rbp-8], rdi
\tmov\tDWORD PTR [rbp-12], esi
\t.loc 1 4 31
\tmov\trax, QWORD PTR [rbp-8]
\tmov\teax, DWORD PTR [rax+8]
\t.loc 1 4 42
\tmov\tedx, DWORD PTR [rbp-12]
\tadd\tedx, edx
\t.loc 1 4 37
\tadd\tedx, eax
\tmov\trax, QWORD PTR [rbp-8]
\tmov\tDWORD PTR [rax+8], edx
\t.loc 1 4 44
\tmov\trax, QWORD PTR [rbp-8]
\tmov\teax, DWORD PTR [rax+8]
\t.loc 1 4 47
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE1:
\t.size\t_ZN7Counter5twiceEi, .-_ZN7Counter5twiceEi
\t.section\t.text._ZN7Counter4plusEi,"axG",@progbits,_ZN7Counter4plusEi,comdat
\t.align 2
\t.weak\t_ZN7Counter4plusEi
\t.type\t_ZN7Counter4plusEi, @function
_ZN7Counter4plusEi:
.LFB2:
\t.loc 1 5 17
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tQWORD PTR [rbp-8], rdi
\tmov\tDWORD PTR [rbp-12], esi
\t.loc 1 5 38
\tmov\trax, QWORD PTR [rbp-8]
\tmov\tedx, DWORD PTR [rax+8]
\t.loc 1 5 46
\tmov\teax, DWORD PTR [rbp-12]
\tadd\teax, edx
\t.loc 1 5 49
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE2:
\t.size\t_ZN7Counter4plusEi, .-_ZN7Counter4plusEi
\t.text
\t.globl\t_Z4callR7CounterMS_FiiEi
\t.type\t_Z4callR7CounterMS_FiiEi, @function
_Z4callR7CounterMS_FiiEi:
.LFB3:
\t.loc 1 10 73
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tsub\trsp, 32
\tmov\tQWORD PTR [rbp-8], rdi
\tmov\trax, rsi
\tmov\trsi, rdx
\tmov\trax, rax
\tmov\tedx, 0
\tmov\trdx, rsi
\tmov\tQWORD PTR [rbp-32], rax
\tmov\tQWORD PTR [rbp-24], rdx
\tmov\tDWORD PTR [rbp-12], ecx
\t.loc 1 10 99
\tmov\trcx, QWORD PTR [rbp-8]
\t.loc 1 10 92
\tmov\trax, QWORD PTR [rbp-32]
\tmov\trdx, QWORD PTR [rbp-24]
\t.loc 1 10 99
\tmov\trsi, rax
\tand\tesi, 1
\ttest\trsi, rsi
\tje\t.L8
\t.loc 1 10 99 is_stmt 0 discriminator 1
\tmov\trsi, rdx
\tadd\trsi, rcx
\tmov\trsi, QWORD PTR [rsi]
\tmov\trdi, rax
\tsub\trdi, 1
\tadd\trsi, rdi
\tmov\tr8, QWORD PTR [rsi]
\tjmp\t.L9
.L8:
\t.loc 1 10 99 discriminator 2
\tmov\tr8, rax
.L9:
\t.loc 1 10 99 discriminator 4
\tmov\trax, rdx
\tlea\trdx, [rcx+rax]
\tmov\teax, DWORD PTR [rbp-12]
\tmov\tesi, eax
\tmov\trdi, rdx
\tcall\tr8
.LVL0:
\t.loc 1 10 104 is_stmt 1
\tleave
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE3:
\t.size\t_Z4callR7CounterMS_FiiEi, .-_Z4callR7CounterMS_FiiEi
\t.section\t.text._ZN7CounterC2Ev,"axG",@progbits,_ZN7CounterC5Ev,comdat
\t.align 2
\t.weak\t_ZN7CounterC2Ev
\t.type\t_ZN7CounterC2Ev, @function
_ZN7CounterC2Ev:
.LFB6:
\t.loc 1 1 8
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tQWORD PTR [rbp-8], rdi
.LBB2:
\t.loc 1 1 8
\tmov\tedx, OFFSET FLAT:_ZTV7Counter+16
\tmov\trax, QWORD PTR [rbp-8]
\tmov\tQWORD PTR [rax], rdx
.LBE2:
\tnop
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE6:
\t.size\t_ZN7CounterC2Ev, .-_ZN7CounterC2Ev
\t.weak\t_ZN7CounterC1Ev
\t.set\t_ZN7CounterC1Ev,_ZN7CounterC2Ev
\t.text
\t.globl\tmain
\t.type\tmain, @function
main:
.LFB4:
\t.loc 1 12 16
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tpush\tr15
\tpush\tr14
\tpush\tr13
\tpush\tr12
\tpush\trbx
\tsub\trsp, 40
\t.cfi_offset 15, -24
\t.cfi_offset 14, -32
\t.cfi_offset 13, -40
\t.cfi_offset 12, -48
\t.cfi_offset 3, -56
\t.loc 1 13 13
\tlea\trax, [rbp-64]
\tmov\trdi, rax
\tcall\t_ZN7CounterC1Ev
\t.loc 1 14 19
\tmov\tDWORD PTR [rbp-56], 1
\t.loc 1 15 16
\tmov\tQWORD PTR [rbp-80], OFFSET FLAT:_ZN7Counter3addEi
\tmov\tQWORD PTR [rbp-72], 0
\tmov\trax, QWORD PTR [rbp-80]
\tmov\trdx, QWORD PTR [rbp-72]
\tmov\trsi, rax
\tlea\trax, [rbp-64]
\tmov\tecx, 1
\tmov\trdi, rax
\tcall\t_Z4callR7CounterMS_FiiEi
\tmov\tebx, eax
\t.loc 1 15 50 discriminator 1
\tmov\tr14d, OFFSET FLAT:_ZN7Counter5twiceEi
\tmov\tr15d, 0
\tmov\trsi, r14
\tmov\trdx, r15
\tlea\trax, [rbp-64]
\tmov\tecx, 2
\tmov\trdi, rax
\tcall\t_Z4callR7CounterMS_FiiEi
\t.loc 1 15 44 discriminator 2
\tadd\tebx, eax
\t.loc 1 15 86 discriminator 2
\tmov\tr12d, 1
\tmov\tr13d, 0
\tmov\trsi, r12
\tmov\trdx, r13
\tlea\trax, [rbp-64]
\tmov\tecx, 3
\tmov\trdi, rax
\tcall\t_Z4callR7CounterMS_FiiEi
\t.loc 1 15 113 discriminator 3
\tadd\teax, ebx
\t.loc 1 16 1
\tadd\trsp, 40
\tpop\trbx
\tpop\tr12
\tpop\tr13
\tpop\tr14
\tpop\tr15
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE4:
\t.size\tmain, .-main
\t.weak\t_ZTV7Counter
\t.section\t.rodata._ZTV7Counter,"aG",@progbits,_ZTV7Counter,comdat
\t.align 8
\t.type\t_ZTV7Counter, @object
\t.size\t_ZTV7Counter, 24
_ZTV7Counter:
\t.quad\t0
\t.quad\t0
\t.quad\t_ZN7Counter4plusEi
\t.text
.Letext0:
\t.ident\t"GCC: (Ubuntu 15.2.0-16ubuntu1) 15.2.0"
\t.section\t.note.GNU-stack,"",@progbits`

/** `g++ -O2` of the same members.cpp, which aligns each function to 16 after `.align 2`. */
const MEMBERS_O2 = `\t.file\t"members.cpp"
\t.intel_syntax noprefix
\t.text
.Ltext0:
\t.file 0 "/app" "members.cpp"
\t.section\t.text._ZN7Counter3addEi,"axG",@progbits,_ZN7Counter3addEi,comdat
\t.align 2
\t.p2align 4
\t.weak\t_ZN7Counter3addEi
\t.type\t_ZN7Counter3addEi, @function
_ZN7Counter3addEi:
.LFB0:
\t.file 1 "members.cpp"
\t.loc 1 3 9
\t.cfi_startproc
\t.loc 1 3 35
\tmov\teax, DWORD PTR [rdi+8]
\tadd\teax, esi
\tmov\tDWORD PTR [rdi+8], eax
\t.loc 1 3 41
\tret
\t.cfi_endproc
.LFE0:
\t.size\t_ZN7Counter3addEi, .-_ZN7Counter3addEi
\t.section\t.text._ZN7Counter5twiceEi,"axG",@progbits,_ZN7Counter5twiceEi,comdat
\t.align 2
\t.p2align 4
\t.weak\t_ZN7Counter5twiceEi
\t.type\t_ZN7Counter5twiceEi, @function
_ZN7Counter5twiceEi:
.LFB1:
\t.loc 1 4 9
\t.cfi_startproc
\t.loc 1 4 37
\tmov\teax, DWORD PTR [rdi+8]
\tlea\teax, [rax+rsi*2]
\tmov\tDWORD PTR [rdi+8], eax
\t.loc 1 4 47
\tret
\t.cfi_endproc
.LFE1:
\t.size\t_ZN7Counter5twiceEi, .-_ZN7Counter5twiceEi
\t.section\t.text._ZN7Counter4plusEi,"axG",@progbits,_ZN7Counter4plusEi,comdat
\t.align 2
\t.p2align 4
\t.weak\t_ZN7Counter4plusEi
\t.type\t_ZN7Counter4plusEi, @function
_ZN7Counter4plusEi:
.LFB2:
\t.loc 1 5 17
\t.cfi_startproc
\t.loc 1 5 46
\tmov\teax, DWORD PTR [rdi+8]
\tadd\teax, esi
\t.loc 1 5 49
\tret
\t.cfi_endproc
.LFE2:
\t.size\t_ZN7Counter4plusEi, .-_ZN7Counter4plusEi
\t.text
\t.p2align 4
\t.globl\t_Z4callR7CounterMS_FiiEi
\t.type\t_Z4callR7CounterMS_FiiEi, @function
_Z4callR7CounterMS_FiiEi:
.LFB3:
\t.loc 1 10 73
\t.cfi_startproc
\t.loc 1 10 92
\tmov\trax, rsi
\t.loc 1 10 99 discriminator 1
\tadd\trdi, rdx
\t.loc 1 10 99 is_stmt 0
\ttest\tsil, 1
\tje\t.L6
\t.loc 1 10 99 discriminator 1
\tmov\trdx, QWORD PTR [rdi]
\tmov\trax, QWORD PTR [rdx-1+rsi]
.L6:
\t.loc 1 10 99 discriminator 4
\tmov\tesi, ecx
\tjmp\trax
\t.cfi_endproc
.LFE3:
\t.size\t_Z4callR7CounterMS_FiiEi, .-_Z4callR7CounterMS_FiiEi
\t.section\t.text.startup,"ax",@progbits
\t.p2align 4
\t.globl\tmain
\t.type\tmain, @function
main:
.LFB4:
\t.loc 1 12 16 is_stmt 1
\t.cfi_startproc
\tpush\trbx
\t.cfi_def_cfa_offset 16
\t.cfi_offset 3, -16
\t.loc 1 15 16
\tmov\tecx, 1
\tmov\tesi, OFFSET FLAT:_ZN7Counter3addEi
\txor\tedx, edx
\t.loc 1 12 16
\tsub\trsp, 16
\t.cfi_def_cfa_offset 32
\t.loc 1 15 16
\tmov\trdi, rsp
.LBB5:
.LBB6:
\t.loc 1 1 8
\tmov\tQWORD PTR [rsp], OFFSET FLAT:_ZTV7Counter+16
.LBE6:
.LBE5:
\t.loc 1 14 19
\tmov\tDWORD PTR [rsp+8], 1
\t.loc 1 15 16
\tcall\t_Z4callR7CounterMS_FiiEi
\t.loc 1 15 50 discriminator 1
\tmov\trdi, rsp
\tmov\tecx, 2
\txor\tedx, edx
\tmov\tesi, OFFSET FLAT:_ZN7Counter5twiceEi
\t.loc 1 15 16
\tmov\tebx, eax
\t.loc 1 15 50 discriminator 1
\tcall\t_Z4callR7CounterMS_FiiEi
\t.loc 1 15 86 discriminator 2
\tmov\trdi, rsp
\tmov\tecx, 3
\txor\tedx, edx
\tmov\tesi, 1
\t.loc 1 15 44 discriminator 2
\tadd\tebx, eax
\t.loc 1 15 86 discriminator 2
\tcall\t_Z4callR7CounterMS_FiiEi
\t.loc 1 16 1
\tadd\trsp, 16
\t.cfi_def_cfa_offset 16
\t.loc 1 15 113 discriminator 3
\tadd\teax, ebx
\t.loc 1 16 1
\tpop\trbx
\t.cfi_def_cfa_offset 8
\tret
\t.cfi_endproc
.LFE4:
\t.size\tmain, .-main
\t.weak\t_ZTV7Counter
\t.section\t.rodata._ZTV7Counter,"aG",@progbits,_ZTV7Counter,comdat
\t.align 8
\t.type\t_ZTV7Counter, @object
\t.size\t_ZTV7Counter, 24
_ZTV7Counter:
\t.quad\t0
\t.quad\t0
\t.quad\t_ZN7Counter4plusEi
\t.text
.Letext0:
\t.ident\t"GCC: (Ubuntu 15.2.0-16ubuntu1) 15.2.0"
\t.section\t.note.GNU-stack,"",@progbits`

/**
 * `gcc -O0` of aligned.c, where `sixty_four` follows another function rather than starting the
 * section:
 *
 *     int before(int x) { return x * 3; }
 *     __attribute__((aligned(64))) int sixty_four(int x) { return x + 1; }
 *     int (*volatile pointer)(int) = sixty_four;
 *
 *     int main(void) {
 *         unsigned long address = (unsigned long)pointer;
 *         return (address % 64 == 0) * 10 + pointer(before(2));
 *     }
 */
const ALIGNED_O0 = `\t.file\t"aligned.c"
\t.intel_syntax noprefix
\t.text
.Ltext0:
\t.file 0 "/app" "aligned.c"
\t.globl\tbefore
\t.type\tbefore, @function
before:
.LFB0:
\t.file 1 "aligned.c"
\t.loc 1 1 19
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tDWORD PTR [rbp-4], edi
\t.loc 1 1 30
\tmov\tedx, DWORD PTR [rbp-4]
\tmov\teax, edx
\tadd\teax, eax
\tadd\teax, edx
\t.loc 1 1 35
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE0:
\t.size\tbefore, .-before
\t.align 64
\t.globl\tsixty_four
\t.type\tsixty_four, @function
sixty_four:
.LFB1:
\t.loc 1 2 52
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tmov\tDWORD PTR [rbp-4], edi
\t.loc 1 2 63
\tmov\teax, DWORD PTR [rbp-4]
\tadd\teax, 1
\t.loc 1 2 68
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE1:
\t.size\tsixty_four, .-sixty_four
\t.globl\tpointer
\t.data
\t.align 8
\t.type\tpointer, @object
\t.size\tpointer, 8
pointer:
\t.quad\tsixty_four
\t.text
\t.globl\tmain
\t.type\tmain, @function
main:
.LFB2:
\t.loc 1 4 16
\t.cfi_startproc
\tpush\trbp
\t.cfi_def_cfa_offset 16
\t.cfi_offset 6, -16
\tmov\trbp, rsp
\t.cfi_def_cfa_register 6
\tpush\tr12
\tpush\trbx
\tsub\trsp, 16
\t.cfi_offset 12, -24
\t.cfi_offset 3, -32
\t.loc 1 5 29
\tmov\trax, QWORD PTR pointer[rip]
\t.loc 1 5 19
\tmov\tQWORD PTR [rbp-24], rax
\t.loc 1 6 21
\tmov\trax, QWORD PTR [rbp-24]
\tand\teax, 63
\t.loc 1 6 32
\ttest\trax, rax
\tjne\t.L6
\t.loc 1 6 32 is_stmt 0 discriminator 1
\tmov\tr12d, 10
\tjmp\t.L7
.L6:
\t.loc 1 6 32 discriminator 2
\tmov\tr12d, 0
.L7:
\t.loc 1 6 39 is_stmt 1 discriminator 4
\tmov\trbx, QWORD PTR pointer[rip]
\tmov\tedi, 2
\tcall\tbefore
\t.loc 1 6 39 is_stmt 0 discriminator 5
\tmov\tedi, eax
\tcall\trbx
.LVL0:
\t.loc 1 6 37 is_stmt 1 discriminator 6
\tadd\teax, r12d
\t.loc 1 7 1
\tadd\trsp, 16
\tpop\trbx
\tpop\tr12
\tpop\trbp
\t.cfi_def_cfa 7, 8
\tret
\t.cfi_endproc
.LFE2:
\t.size\tmain, .-main
.Letext0:
\t.ident\t"GCC: (Ubuntu 15.2.0-16ubuntu1) 15.2.0"
\t.section\t.note.GNU-stack,"",@progbits`
