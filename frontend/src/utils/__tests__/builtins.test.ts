// One builtin feature id list. The tree, the viewport and the document layer
// all read BUILTIN_FEATURE_IDS: a second hand-written list (the layout module
// that called itself "Single source") drifts the moment a builtin is added.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

const SRC = join(__dirname, '..', '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full)
  }
  return out
}

describe('BUILTIN_FEATURE_IDS', () => {
  it('names the Origin and the three cardinal planes', () => {
    expect([...BUILTIN_FEATURE_IDS].sort()).toEqual(['Front', 'Origin', 'Right', 'Top'])
    expect(BUILTIN_FEATURE_DEFAULTS.map(f => f.id)).toEqual([...BUILTIN_FEATURE_IDS])
  })

  it('is the only builtin id list in the tree', () => {
    const rel = (full: string) => full.slice(SRC.length + 1).split('\\').join('/')
    // A second list would spell the four ids out in one array/set literal.
    const inlineList = /['"]Origin['"][^\]\n]*['"]Top['"][^\]\n]*['"]Front['"][^\]\n]*['"]Right['"]/
    const offenders: string[] = []
    for (const file of sourceFiles(SRC)) {
      const name = rel(file)
      if (name === 'utils/builtins.ts' || name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
      const source = readFileSync(file, 'utf8')
      if (inlineList.test(source)) offenders.push(name)
      if (name !== 'utils/builtins.ts' && /export const BUILTIN_FEATURE_IDS\b/.test(source)) {
        offenders.push(`${name} (redeclares the set)`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the layout copy is gone', () => {
    expect(existsSync(join(SRC, 'components', 'layout', 'builtinFeatureIds.ts'))).toBe(false)
  })
})
