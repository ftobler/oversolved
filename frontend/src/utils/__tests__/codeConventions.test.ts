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

describe('circular dependency guards', () => {
  it('registry/ does not import from stores/', () => {
    const registryDir = join(SRC, 'registry')
    const registryFiles = collectFiles(registryDir, ['.ts', '.tsx'])
      .filter(f => !f.includes('__tests__'))
    const violations: string[] = []
    for (const file of registryFiles) {
      const src = readFileSync(file, 'utf8')
      if (src.includes("from '@/stores/") || src.includes('from "@/stores/')) {
        violations.push(file.replace(SRC, 'src/'))
      }
    }
    expect(violations).toEqual([])
  })
})

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

  // A raw control byte makes `file` call the source `data` and makes plain grep
  // print nothing for it, so a search for any symbol in that file comes back empty
  // and reads as "the symbol does not exist". `query.ts` and `IdRegistry.ts` each
  // carried a raw 0x00 separator and cost a review pass real time. The separator is
  // fine, the byte in the source is not: write it as a unicode escape instead.
  it('no raw C0 control bytes in source (write them as \\uXXXX escapes)', () => {
    const allowed = new Set([0x09, 0x0a, 0x0d])  // tab, LF, CR
    expect(tsFiles.length).toBeGreaterThan(100)  // a broken walk would pass vacuously
    const violations: string[] = []
    for (const file of tsFiles) {
      const bytes = readFileSync(file)
      const hits: string[] = []
      let line = 1
      for (let i = 0; i < bytes.length && hits.length < 3; i++) {
        if (bytes[i] === 0x0a) line++
        else if (bytes[i] < 0x20 && !allowed.has(bytes[i])) {
          hits.push(`0x${bytes[i].toString(16).padStart(2, '0')} at line ${line}`)
        }
      }
      if (hits.length > 0) {
        violations.push(`${file.replace(SRC, 'src/')} (${hits.join(', ')})`)
      }
    }
    expect(violations).toEqual([])
  })
})
