import { describe, expect, it } from 'vitest'
import { validateX86Project, x86ProjectSourcePath, x86ProjectText } from '../src/project'

describe('x86 Project paths', () => {
  it('rejects an inherited Entry and paths that escape the Project', () => {
    expect(() =>
      validateX86Project({
        entry: 'toString',
        files: {},
      }),
    ).toThrow('entry file not found')
    expect(() =>
      validateX86Project({
        entry: '../main.asm',
        files: { '../main.asm': '' },
      }),
    ).toThrow('Invalid x86 Project entry path')
  })

  it('maps absolute and Entry-relative assembler paths to Project Files', () => {
    const project = {
      entry: 'src/main.asm',
      files: {
        'src/main.asm': '',
        'src/parts/lib.asm': '',
      },
    }
    expect(x86ProjectSourcePath('/assembly.s', project)).toBe('src/main.asm')
    expect(x86ProjectSourcePath('parts/lib.asm', project)).toBe('src/parts/lib.asm')
    expect(x86ProjectSourcePath('/__x86_project/src/parts/lib.asm', project)).toBe(
      'src/parts/lib.asm',
    )
  })

  it('rejects a library path that is no path, or that a File or its directory already has', () => {
    const files = { 'src/main.asm': '' }
    const withLibrary = (library: Record<string, string | Uint8Array>) => ({ entry: 'src/main.asm', files, library })
    for (const path of ['', '/start.asm', '../start.asm', 'a//start.asm', 'a\\start.asm']) {
      expect(() => validateX86Project(withLibrary({ [path]: '' })), path).toThrow('Invalid x86 Project library path')
    }
    for (const path of ['src/main.asm', 'src', 'src/main.asm/start.asm']) {
      expect(() => validateX86Project(withLibrary({ [path]: '' })), path).toThrow(
        'collides with the Project File src/main.asm',
      )
    }
    expect(() => validateX86Project(withLibrary({ 'start.asm': 42 as unknown as string }))).toThrow(
      'Invalid x86 Project library contents',
    )
    expect(() =>
      validateX86Project(withLibrary({ 'src/start.asm': '', '@runtime/start.asm': new Uint8Array() })),
    ).not.toThrow()
  })

  it('maps a library unit to its path, and a path under the Project root to exactly that File', () => {
    const project = {
      entry: 'src/main.asm',
      files: { 'src/main.asm': '', 'src/lib.asm': '', 'lib.asm': '' },
      library: { '@runtime/start.asm': 'global _start' },
    }
    expect(x86ProjectSourcePath('/__x86_project/@runtime/start.asm', project)).toBe('@runtime/start.asm')
    expect(x86ProjectText(project, '@runtime/start.asm')).toBe('global _start')
    // A unit's own path is written in full, so it is never read against the Entry's directory...
    expect(x86ProjectSourcePath('/__x86_project/lib.asm', project)).toBe('lib.asm')
    // ...as a relative path, which is how NASM writes an included File's, still is.
    expect(x86ProjectSourcePath('lib.asm', project)).toBe('src/lib.asm')
  })
})
