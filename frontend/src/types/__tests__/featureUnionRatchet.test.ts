/**
 * The feature-union ratchet.
 *
 * PartFeature is a discriminated union, solver dispatch is a mapped type tied
 * to it, and call sites narrow by `kind` instead of probing payload fields.
 * The two tokens below are how the old erosion grows back: a loose
 * `Record<string, unknown>` feature record, and an `as unknown as` double cast
 * that erases whatever the type system proved. Neither is banned outright --
 * the worker boundary legitimately carries untyped clones -- so this counts the
 * non-test occurrences and pins them: the counts may only go down. Lowering one
 * means lowering its baseline here in the same commit, which keeps the
 * allowance from turning into slack that a later change can spend.
 *
 * The scan skips `__tests__/`, `*.test.*` and `testing/` (test support code):
 * this ratchets production code. Comments are stripped first, exactly as in
 * noBackend.test.ts, so prose about a token cannot count as the token.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, sep } from 'node:path'

// src/ root, derived from this file's location (src/types/__tests__/<this>).
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Ratchet {
  token: string
  baseline: number
}

// The baselines track the whole tree, so every merge that brings new code
// re-measures them; the counts above are from the tree the folder regression
// corpus landed on (its loader validates untyped JSON and the runner reads
// solve results, which are legitimate loose records). A merge that adds a
// token is allowed to raise a baseline (the new kinds add their leaf
// `bodyStore` records, the generic sub-dict accessor and a couple of casts),
// but a change to union-affected code is not: that growth is exactly what this
// test is for.
const RATCHETS: Ratchet[] = [
  {
    token: 'as unknown as',
    baseline: 48,
  },
  {
    // 362 after the batch B inline adds: featureDefs' generic mergeInlineFields
    // and setFeatureField take the definition object and name the write bag
    // (FieldBag) once instead of spelling a loose record per call. Same
    // boundary looseness, one token fewer.
    token: 'Record<string, unknown>',
    baseline: 362,
  },
]

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '__tests__' || name === 'testing') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(name)) continue
      if (/\.test\.(ts|tsx)$/.test(name)) continue
      if (name.endsWith('.d.ts')) continue
      out.push(full)
    }
  }
  walk(SRC_DIR)
  return out
}

// Mirrors noBackend.test.ts's stripper: block and line comments go, while a `//`
// that is not a comment (inside a string literal, or the scheme separator in a
// URL) is kept so a real line of code cannot be truncated.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      const i = line.indexOf('//')
      if (i < 0) return line
      const before = line.slice(0, i)
      if (before.endsWith(':')) return line  // https:// and friends
      const quotes = (before.match(/(?<!\\)['"`]/g) ?? []).length
      if (quotes % 2 === 1) return line  // inside a string literal
      return before
    })
    .join('\n')
}

function countOccurrences(text: string, token: string): number {
  let count = 0
  let at = text.indexOf(token)
  while (at >= 0) {
    count += 1
    at = text.indexOf(token, at + token.length)
  }
  return count
}

function countToken(token: string): Map<string, number> {
  const perFile = new Map<string, number>()
  for (const full of sourceFiles()) {
    const count = countOccurrences(stripComments(readFileSync(full, 'utf8')), token)
    if (count > 0) perFile.set(relative(SRC_DIR, full).split(sep).join('/'), count)
  }
  return perFile
}

describe('feature-union ratchet', () => {
  it('scans a non-empty source tree', () => {
    // Guards the guard: a broken walk would report a clean tree forever.
    expect(sourceFiles().length).toBeGreaterThan(150)
  })

  it.each(RATCHETS)('$token occurrences match the baseline', ({ token, baseline }) => {
    const perFile = countToken(token)
    const total = [...perFile.values()].reduce((sum, n) => sum + n, 0)
    const detail = [...perFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([file, n]) => `  ${n} ${file}`)
      .join('\n')
    expect(
      total,
      `The ${token} count moved from ${baseline} to ${total}:\n${detail}\n\n` +
        `Feature shapes narrow by kind now; a loose record or a double cast is ` +
        `the old erasure growing back. If this change legitimately lowered the ` +
        `count, lower its baseline in this file to ${total}; if it raised it, ` +
        `the change is the regression this test exists for.`,
    ).toBe(baseline)
  })

  // The acceptance bar for the union work, pinned where it cannot drift: the
  // dispatch table replaced its `as unknown as` entry adapters with the mapped
  // type above, and nothing in that module may reintroduce one.
  it('solver dispatch carries no erased double cast', () => {
    const source = stripComments(readFileSync(resolve(SRC_DIR, 'kernel', 'solverRegistry.ts'), 'utf8'))
    expect(source).not.toContain('as unknown as')
  })
})
