// doc-ref-canon ratchets: the two spellings this feature collapsed must not
// grow back.
//
// 1. A feature-level reference to a feature is `@id`. No non-test source builds
//    a `$<id>` feature ref. The three host-local `$` emitters below are the
//    only legitimate ones (a sketch's own constraint operands, a local vertex
//    ref, and the wire codec's local branch); a feature writer routes through
//    the query engine instead.
// 2. No leaf solver overlays flat params over the sub-dict. The overlay can be
//    spelled several ways (`{ ...sub, ...feature }`, `{ ...sub, ...rest }` after
//    destructuring the kind key out, either order, or an Object.assign); all of
//    them are the regression this ratchet pins. Params live in the sub-dict
//    only.
//
// The scan skips `__tests__/`, `*.test.*` and `testing/` (test support code)
// and strips comments first, exactly as featureUnionRatchet.test.ts does.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative, sep } from 'node:path'

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => {
      const i = line.indexOf('//')
      if (i < 0) return line
      const before = line.slice(0, i)
      if (before.endsWith(':')) return line
      const quotes = (before.match(/(?<!\\)['"`]/g) ?? []).length
      if (quotes % 2 === 1) return line
      return before
    })
    .join('\n')
}

const rel = (full: string) => relative(SRC_DIR, full).split(sep).join('/')

describe('doc-ref-canon ratchets', () => {
  it('scans a non-empty source tree', () => {
    expect(sourceFiles().length).toBeGreaterThan(150)
  })

  // The literal shapes a feature-level `$` writer would take. A writer minting
  // `'$' + featureId` or `` `$${featureId}` `` is the regression.
  const DOLLAR_EMIT_TOKENS = ["'$' +", '"$" +', '`$${']
  // The legitimate host-local emitters: constraint-operand targets, a local
  // vertex ref in the drag loop, and the wire codec's own local branch.
  const DOLLAR_EMIT_ALLOWLIST = new Set([
    'utils/yamlMutations/helpers.ts',
    'components/Geometry3D/dragLogic.ts',
    'kernel/queryWire.ts',
  ])

  it('only the host-local emitters build a $ ref', () => {
    const offenders: string[] = []
    for (const full of sourceFiles()) {
      const source = stripComments(readFileSync(full, 'utf8'))
      if (!DOLLAR_EMIT_TOKENS.some(t => source.includes(t))) continue
      const name = rel(full)
      if (!DOLLAR_EMIT_ALLOWLIST.has(name)) offenders.push(name)
    }
    expect(
      offenders,
      `a feature-level $ writer reappeared in: ${offenders.join(', ')}. A feature ` +
        `naming another feature is @id; route the wire through the query engine ` +
        `(kernel/query) instead of a hand-built $ string.`,
    ).toEqual([])
  })

  it('keeps the allowlist honest (each entry still builds a $ ref)', () => {
    for (const name of DOLLAR_EMIT_ALLOWLIST) {
      const source = stripComments(readFileSync(resolve(SRC_DIR, name), 'utf8'))
      expect(
        DOLLAR_EMIT_TOKENS.some(t => source.includes(t)),
        `${name} no longer builds a $ ref; drop it from the allowlist`,
      ).toBe(true)
    }
  })

  // Every spelling a flat overlay takes: the sub-dict spread beside the whole
  // feature or a feature-derived `rest`, in either order, or via Object.assign.
  // The first ratchet matched only `...sub, ...feature`, so `{ ...sub, ...rest }`
  // (what transform/mirror used) slipped through.
  const OVERLAY_PATTERNS = [
    /\.\.\.sub\b[^;{}]*\.\.\.(?:feature|rest)\b/,
    /\.\.\.(?:feature|rest)\b[^;{}]*\.\.\.sub\b/,
    /Object\.assign\([^)]*\bsub\b[^)]*\b(?:feature|rest)\b/,
  ]

  it('no leaf solver overlays flat params over the sub-dict', () => {
    const offenders: string[] = []
    for (const full of sourceFiles()) {
      const source = stripComments(readFileSync(full, 'utf8'))
      if (OVERLAY_PATTERNS.some(p => p.test(source))) offenders.push(rel(full))
    }
    expect(
      offenders,
      `flat-param overlay reappeared in: ${offenders.join(', ')}. Params live in ` +
        `the kind sub-dict; read feature[kind] directly.`,
    ).toEqual([])
  })

  it('the overlay patterns catch every spelling the invariant names', () => {
    const shapes = [
      '{ ...sub, ...feature }',
      '{ ...sub, ...rest }',
      '{ ...feature, ...sub }',
      '{ ...rest, ...sub }',
      'Object.assign({}, sub, feature)',
      'Object.assign({}, sub, rest)',
    ]
    for (const shape of shapes) {
      expect(OVERLAY_PATTERNS.some(p => p.test(shape)), `no pattern matched: ${shape}`).toBe(true)
    }
  })
})
