import { describe, expect, it } from 'vitest'
import { validateX86Project, x86ProjectSourcePath } from '../src/project'

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
})
