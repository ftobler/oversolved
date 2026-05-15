/**
 * Enforce code conventions across the frontend source tree.
 * These tests catch regressions in naming and environment-access patterns.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname } from 'path'

const SRC = join(__dirname, '../../')

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, exts))
    } else if (exts.includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

const tsFiles = collectFiles(SRC, ['.ts', '.tsx'])
const srcOnlyFiles = tsFiles.filter(f => !f.includes('__tests__'))

describe('code conventions', () => {
  it('no underscore-prefixed exports', () => {
    const violations: string[] = []
    const re = /^export\s+(?:function|const|class|type|interface|enum)\s+_/m
    for (const file of srcOnlyFiles) {
      const src = readFileSync(file, 'utf8')
      if (re.test(src)) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })

  it('no process.env in source files (use import.meta.env)', () => {
    const violations: string[] = []
    for (const file of srcOnlyFiles) {
      const src = readFileSync(file, 'utf8')
      if (src.includes('process.env')) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })
})
