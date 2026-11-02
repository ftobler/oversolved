// @vitest-environment node
/**
 * Guards the shared source-scan helper the guard tests import.
 *
 * The load-bearing property is that `stripComments` blanks instead of
 * deletes: a guard that reports `file:line` is only honest while the
 * stripped text still maps one-to-one onto the real file's lines. A
 * planted violation pins that.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  collectSourceFiles, productionFiles, isTestFile, stripComments, liveText,
  IMPORT_SPECIFIERS, resolveSpecifier,
} from '@/testing/sourceScan'

const SRC = join(__dirname, '../../')

// One fixture, both comment shapes: a block comment spanning lines, a
// standalone line comment at column zero, and a trailing comment on code.
// The cast sits on line index 8 in the real file.
const PLANTED = [
  '/**',
  ' * A doc block spanning several lines',
  ' * carries prose that must not trip a scan',
  ' */',
  "import { parse } from 'doc'",
  '',
  '// a standalone comment line sits at column zero',
  'const value = parse(doc)',
  'const bad = value as unknown as PartDoc',
].join('\n')

const CAST = /\bas\s+unknown\s+as\s+PartDoc\b/

function indexOfCast(text: string): number {
  return text.split('\n').findIndex((line) => CAST.test(line))
}

describe('stripComments', () => {
  it('reports a violation after a block comment at its real line', () => {
    // The pre-helper scans deleted comments instead of blanking them and
    // reported this cast at line index 4 while the file says 8. The
    // stripComments assertion is the regression guard: a destructive
    // rewrite of the helper trips on it.
    expect(indexOfCast(PLANTED)).toBe(8)
    expect(indexOfCast(stripComments(PLANTED))).toBe(8)
  })

  it('keeps line count, offsets and code text intact', () => {
    const stripped = stripComments(PLANTED)
    const rawLines = PLANTED.split('\n')
    const strippedLines = stripped.split('\n')
    expect(strippedLines).toHaveLength(rawLines.length)
    expect(strippedLines[4]).toBe(rawLines[4])
    expect(strippedLines[7]).toBe(rawLines[7])
    expect(strippedLines[8]).toBe(rawLines[8])
    expect(strippedLines[0]).not.toContain('/**')
    expect(strippedLines[6]).not.toContain('//')
  })

  it('a standalone comment line does not join its neighbours', () => {
    // The line-comment pattern swallows the newline before `//`. Deleting
    // the match merges two lines; blanking keeps both.
    const text = 'one();\n// between\ntwo();'
    const lines = stripComments(text).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('one();')
    expect(lines[2]).toBe('two();')
  })

  it('preserves match offsets across a multi-line comment', () => {
    const text = 'const a = 1\n/* block\nspanning */\nconst target = 2'
    const stripped = stripComments(text)
    expect(stripped).toHaveLength(text.length)
    for (const m of stripped.matchAll(/const target/g)) {
      expect(m.index).toBe(text.indexOf('const target'))
    }
  })
})

describe('liveText', () => {
  it('blanks the helper module\'s own doc header but keeps its code lines', () => {
    const file = join(SRC, 'testing/sourceScan.ts')
    const stripped = liveText(file)
    expect(stripped.split('\n')).toHaveLength(readFileSync(file, 'utf8').split('\n').length)
    expect(stripped).toContain("const TS_EXTS = ['.ts', '.tsx']")
    expect(stripped.indexOf('/**')).toBe(-1)
  })
})

describe('collectSourceFiles and productionFiles', () => {
  it('walks the real tree and honours the extension list', () => {
    const files = collectSourceFiles(SRC)
    // Guards the guard: a broken walk would pass every scan on an empty set.
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(join(SRC, 'testing/sourceScan.ts'))
    expect(files.some((f) => f.endsWith('.css'))).toBe(false)
    expect(collectSourceFiles(SRC, ['.ts', '.tsx', '.css'])).toContain(join(SRC, 'index.css'))
  })

  it('productionFiles is the walk minus the test predicate', () => {
    const prod = productionFiles(SRC)
    expect(prod.length).toBeGreaterThan(200)
    expect(prod).toContain(join(SRC, 'testing/sourceScan.ts'))
    expect(prod.some((f) => isTestFile(f))).toBe(false)
  })
})

describe('isTestFile', () => {
  it('catches both repo test shapes', () => {
    expect(isTestFile(join(SRC, 'testing/__tests__/sourceScan.test.ts'))).toBe(true)
    expect(isTestFile(join(SRC, 'kernel/solveLocallyReal.test.ts'))).toBe(true)
    expect(isTestFile(join(SRC, 'testing/sourceScan.ts'))).toBe(false)
  })
})

describe('IMPORT_SPECIFIERS', () => {
  it('finds every import form the repo writes', () => {
    const source = [
      "import { a } from '@/utils/a'",
      "import type { B } from '@/types/b'",
      "export { c } from './c'",
      "import 'side-effect.css'",
      "const lazy = () => import('@/pages/Lazy')",
      'import {\n  d,\n  e,\n} from "@/multi/line"',
    ].join('\n')
    const found: string[] = []
    for (const pattern of IMPORT_SPECIFIERS) {
      for (const m of source.matchAll(pattern)) found.push(m[1])
    }
    expect(found).toEqual([
      '@/utils/a', '@/types/b', './c', '@/multi/line', 'side-effect.css', '@/pages/Lazy',
    ])
  })
})

describe('resolveSpecifier', () => {
  it('lands the alias and a relative hop on the same file', () => {
    const fromTest = join(SRC, 'testing/__tests__/sourceScan.test.ts')
    expect(resolveSpecifier(SRC, fromTest, '../sourceScan')).toBe(join(SRC, 'testing/sourceScan.ts'))
    expect(resolveSpecifier(SRC, fromTest, '@/testing/sourceScan')).toBe(join(SRC, 'testing/sourceScan.ts'))
  })

  it('resolves a directory import through its index file', () => {
    const fromTest = join(SRC, 'testing/__tests__/sourceScan.test.ts')
    expect(resolveSpecifier(SRC, fromTest, '@/kernel/select')).toBe(join(SRC, 'kernel/select/index.ts'))
  })

  it('returns null for bare packages and misses, and cuts loader hints to the base', () => {
    const fromTest = join(SRC, 'testing/__tests__/sourceScan.test.ts')
    expect(resolveSpecifier(SRC, fromTest, 'react')).toBeNull()
    expect(resolveSpecifier(SRC, fromTest, '@/no/such/module')).toBeNull()
    expect(resolveSpecifier(SRC, fromTest, '@/no/such/module?url')).toBeNull()
    expect(resolveSpecifier(SRC, fromTest, '@/testing/sourceScan?worker')).toBe(join(SRC, 'testing/sourceScan.ts'))
  })
})
