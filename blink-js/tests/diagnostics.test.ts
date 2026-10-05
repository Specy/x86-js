import { describe, expect, it } from 'vitest'
import { fasmDiagnostics, gnuDiagnostics, ldDiagnostics, nasmDiagnostics } from '../src/assemblers'
import { x86ProjectSourcePath } from '../src/project'

describe('assembler diagnostics', () => {
    it('parses GNU assembler errors', () => {
        expect(gnuDiagnostics('/assembly.s:4: Error: operand type mismatch for `mov`')).toEqual([
            {
                file: '/assembly.s',
                line: 4,
                error: 'Error: operand type mismatch for `mov`',
                severity: 'error',
            },
        ])
    })

    it('parses GNU assembler warnings', () => {
        expect(gnuDiagnostics('/assembly.s:9: Warning: end of file not at end of a line')).toEqual([
            {
                file: '/assembly.s',
                line: 9,
                error: 'Warning: end of file not at end of a line',
                severity: 'warning',
            },
        ])
    })

    it('parses NASM errors and warnings', () => {
        expect(nasmDiagnostics('/assembly.s:7: error: symbol `main` not defined')).toEqual([
            {
                file: '/assembly.s',
                line: 7,
                error: 'symbol `main` not defined',
                severity: 'error',
            },
        ])
    })

    it('keeps the class NASM names a warning by, out of the message', () => {
        expect(
            nasmDiagnostics(
                '/assembly.s:4: warning: label alone on a line without a colon might be in error [-w+label-orphan]',
            ),
        ).toEqual([
            {
                file: '/assembly.s',
                line: 4,
                error: 'label alone on a line without a colon might be in error',
                severity: 'warning',
                warningClass: 'label-orphan',
            },
        ])
    })

    it('reads a whole NASM run, warnings and errors together', () => {
        const log = [
            '/assembly.s:4: warning: byte exceeds bounds [-w+number-overflow]',
            '/assembly.s:7: error: symbol `msg` not defined',
        ].join('\n')

        expect(nasmDiagnostics(log)).toEqual([
            expect.objectContaining({ line: 4, severity: 'warning', warningClass: 'number-overflow' }),
            expect.objectContaining({ line: 7, severity: 'error' }),
        ])
    })

    it('parses FASM line/error pairs', () => {
        const log = '/assembly.s [12]:\nmov rax, nope\nerror: invalid argument.'
        expect(fasmDiagnostics(log)).toEqual([
            {
                file: '/assembly.s',
                line: 12,
                error: 'error: invalid argument.',
                severity: 'error',
            },
        ])
    })
})

describe('linker diagnostics', () => {
    // A compiled program's Project: the Entry is the compiler's output, the start code is a unit of
    // its library, and `main.asm` is a hand-written File that defines `_start` as well.
    const project = {
        entry: 'src/main.c.asm',
        files: { 'src/main.c.asm': '', 'main.asm': '' },
        library: { '@runtime/x86-start.asm': '' },
    }
    const projectPath = (path: string) => x86ProjectSourcePath(path, project)

    it('puts a symbol defined twice on the second definition, naming the first by its File and line', () => {
        // What `ld` said about that Project, verbatim, when the Entry calls a function `main.asm`
        // defines and the link takes `main.asm` from the archive after the start code.
        const log = [
            '',
            '$ /linker /program.o /program.a -o /program',
            "/linker: /program.a(u1.o): in function `_start':",
            "/__x86_project/main.asm:7: multiple definition of `_start'; /program.a(u0.o):/__x86_project/@runtime/x86-start.asm:5: first defined here",
            '',
        ].join('\n')

        expect(ldDiagnostics(log, projectPath)).toEqual([
            {
                file: '/__x86_project/main.asm',
                line: 7,
                error: "multiple definition of `_start'; first defined in @runtime/x86-start.asm, line 5",
                severity: 'error',
            },
        ])
    })

    it('names the first definition by the path ld wrote when given nothing else to name it by', () => {
        const log = "/__x86_project/a.asm:5: multiple definition of `helper'; /program.o:/assembly.s:11: first defined here"

        expect(ldDiagnostics(log)).toEqual([
            {
                file: '/__x86_project/a.asm',
                line: 5,
                error: "multiple definition of `helper'; first defined in /assembly.s, line 11",
                severity: 'error',
            },
        ])
        expect(ldDiagnostics(log, projectPath)[0]?.error).toBe(
            "multiple definition of `helper'; first defined in src/main.c.asm, line 11",
        )
    })

    it('puts a definition with no line, as in data, on line 1 of its File', () => {
        const log =
            "/__x86_project/main.asm:(.data+0x0): multiple definition of `value'; /program.o:/assembly.s:(.data+0x0): first defined here"

        expect(ldDiagnostics(log, projectPath)).toEqual([
            {
                file: '/__x86_project/main.asm',
                line: 1,
                error: "multiple definition of `value'; first defined in src/main.c.asm",
                severity: 'error',
            },
        ])
    })

    it('locates an undefined reference by its line, past the section and offset', () => {
        expect(ldDiagnostics("/assembly.s:15:(.text+0x14): undefined reference to `printf'")).toEqual([
            { file: '/assembly.s', line: 15, error: "undefined reference to `printf'", severity: 'error' },
        ])
    })

    it('reads past the object ld names first when no symbol comes before the address', () => {
        const log = [
            "/linker: /program.o:/assembly.s:3:(.text+0x1): undefined reference to `absent'",
            "/linker: /program.a(u0.o):/__x86_project/lib/start.asm:4:(.text+0x1): undefined reference to `missing'",
        ].join('\n')

        expect(ldDiagnostics(log)).toEqual([
            { file: '/assembly.s', line: 3, error: "undefined reference to `absent'", severity: 'error' },
            { file: '/__x86_project/lib/start.asm', line: 4, error: "undefined reference to `missing'", severity: 'error' },
        ])
    })

    it('keeps a location that names only an object in the message, which has no File to go on', () => {
        const log = [
            "/linker: /program.o:(.data+0x8): undefined reference to `absent'",
            "/linker: /program.a(u0.o):(.data+0x8): undefined reference to `missing'",
            "/linker: /program.a(u1.o):(.data+0x0): multiple definition of `value'; /program.a(u0.o):(.data+0x0): first defined here",
        ].join('\n')

        expect(ldDiagnostics(log, projectPath)).toEqual([
            { line: 1, error: "/program.o:(.data+0x8): undefined reference to `absent'", severity: 'error' },
            { line: 1, error: "/program.a(u0.o):(.data+0x8): undefined reference to `missing'", severity: 'error' },
            {
                line: 1,
                error: "/program.a(u1.o):(.data+0x0): multiple definition of `value'; /program.a(u0.o):(.data+0x0): first defined here",
                severity: 'error',
            },
        ])
    })

    it('puts a location that names only an object on the File the object was assembled from', () => {
        // What `ld` says of data with no label before it, and of symbols typed as data, verbatim.
        const log = [
            "/linker: /program.o:(.data+0x8): undefined reference to `absent'",
            "/linker: /program.a(u0.o):(.data+0x8): undefined reference to `missing'",
            "/linker: /program.a(u1.o):(.data+0x0): multiple definition of `value'; /program.a(u0.o):(.data+0x0): first defined here",
            "/linker: /program.a(u0.o):(.data+0x0): multiple definition of `value'; /program.o:(.data+0x0): first defined here",
            "/linker: /program.a(u2.o):(.data+0x0): undefined reference to `unknown'",
        ].join('\n')
        // The unit each object was assembled from, as `ld` writes source paths; this build made no u2.o.
        const sources: Record<string, string> = {
            '/program.o': '/assembly.s',
            '/program.a(u0.o)': '/__x86_project/@runtime/x86-start.asm',
            '/program.a(u1.o)': '/__x86_project/main.asm',
        }

        expect(ldDiagnostics(log, projectPath, (object) => sources[object])).toEqual([
            { file: '/assembly.s', line: 1, error: "undefined reference to `absent'", severity: 'error' },
            {
                file: '/__x86_project/@runtime/x86-start.asm',
                line: 1,
                error: "undefined reference to `missing'",
                severity: 'error',
            },
            {
                file: '/__x86_project/main.asm',
                line: 1,
                error: "multiple definition of `value'; first defined in @runtime/x86-start.asm",
                severity: 'error',
            },
            {
                file: '/__x86_project/@runtime/x86-start.asm',
                line: 1,
                error: "multiple definition of `value'; first defined in src/main.c.asm",
                severity: 'error',
            },
            { line: 1, error: "/program.a(u2.o):(.data+0x0): undefined reference to `unknown'", severity: 'error' },
        ])
    })

    it('reads a location only at the start of a line, whatever the message holds after it', () => {
        const log = [
            'warning: odd value at main.asm:12: ignored',
            "/assembly.s:7:(.text+0x5): undefined reference to `ns::helper(int)'",
            "/__x86_project/a.asm:5: multiple definition of `ns::value'; /program.o:/assembly.s:9: first defined here",
        ].join('\n')

        expect(ldDiagnostics(log)).toEqual([
            { line: 1, error: 'odd value at main.asm:12: ignored', severity: 'warning' },
            { file: '/assembly.s', line: 7, error: "undefined reference to `ns::helper(int)'", severity: 'error' },
            {
                file: '/__x86_project/a.asm',
                line: 5,
                error: "multiple definition of `ns::value'; first defined in /assembly.s, line 9",
                severity: 'error',
            },
        ])
    })

    it('skips command echoes, the notes before an error and the missing entry point', () => {
        const log = [
            '$ /linker /program.o -o /program',
            "/linker: /program.o: in function `_start':",
            '/linker: warning: cannot find entry symbol _start; defaulting to 0000000000401000',
            '/linker: warning: /program.o: missing .note.GNU-stack section implies executable stack',
            '/linker: cannot find /program.2.o: No such file or directory',
        ].join('\n')

        expect(ldDiagnostics(log)).toEqual([
            {
                line: 1,
                error: '/program.o: missing .note.GNU-stack section implies executable stack',
                severity: 'warning',
            },
            { line: 1, error: 'cannot find /program.2.o: No such file or directory', severity: 'error' },
        ])
    })
})
