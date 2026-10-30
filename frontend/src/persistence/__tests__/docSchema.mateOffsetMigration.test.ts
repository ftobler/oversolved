// The v4 mate offset sign flip at the document boundary. A stored FIXED mate
// offset authored against the old convention (B's anchor at A's anchor MINUS
// the offset) is negated once so it keeps solving to the same pose now that
// the solver reads PLUS (B at A + R_a * offset). The flip is not idempotent by
// construction, so it stamps the document it changed; these tests pin the
// shapes it touches, the shapes it must not, and the once-only property.

import { describe, it, expect } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import {
  CURRENT_DOC_VERSION,
  loadAssemblyDoc,
  loadAssemblyDocText,
  migrate,
} from '@/persistence/docSchema'
import { LEGACY_V3_ASSEMBLY_OFFSETS } from '@/persistence/__fixtures__/historicalDocs'

interface MateRow {
  kind: string
  offset?: unknown
}

/** The `mate` defs of a loaded document, keyed by feature id. */
function mates(doc: { features?: unknown }): Record<string, MateRow> {
  const out: Record<string, MateRow> = {}
  for (const feature of (doc.features ?? []) as Array<{ id: string; mate?: MateRow }>) {
    if (feature.mate) out[feature.id] = feature.mate
  }
  return out
}

const REF_A = { part: '__assembly', anchor: '__assembly/AssemblyOrigin' }
const REF_B = { part: 'hA', anchor: 'hA/origin' }

describe('the fixed mate offset sign flip', () => {
  it('negates every authored offset shape and reports the step', () => {
    const result = loadAssemblyDocText(LEGACY_V3_ASSEMBLY_OFFSETS.text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toContain('mate-offset-plus-convention')
    const byId = mates(result.doc)
    expect(byId.m_scalar.offset).toBe(-7)
    // Present components flip; an absent component stays absent.
    expect(byId.m_vector.offset).toEqual({ x: -3, y: 4 })
    // Expression strings are refused by the solve today but must round-trip
    // with the sign flipped, parens and all.
    expect(byId.m_expr.offset).toBe('-(w / 2)')
    // Tangential reads its offset as a clearance, not as a translation; only
    // `kind: fixed` changed convention.
    expect(byId.m_tangential.offset).toBe(5)
    // A mate without an offset is nothing to flip.
    expect(byId.m_absent.offset).toBeUndefined()
  })

  it('stamps the document it flipped with the new version', () => {
    const result = loadAssemblyDocText(LEGACY_V3_ASSEMBLY_OFFSETS.text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The stamp is the once-only mechanism: without it the (non-idempotent)
    // flip would negate back on the next load of the saved document.
    expect(result.doc.version).toBe(CURRENT_DOC_VERSION)
  })

  it('flips a scalar to plain 0 rather than -0 at zero', () => {
    const doc = {
      kind: 'assembly',
      features: [{ id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: REF_A, ref_b: REF_B, offset: 0 } }],
    }
    const result = loadAssemblyDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // toBe compares with Object.is, so -0 would fail here.
    expect(mates(result.doc).m1.offset).toBe(0)
  })

  it('leaves an assembly with no fixed offset unstamped and unchanged', () => {
    const doc = {
      kind: 'assembly',
      features: [
        { id: 'm_tan', kind: 'mate', mate: { kind: 'tangential', ref_a: REF_A, ref_b: REF_B, offset: 5 } },
        { id: 'm_none', kind: 'mate', mate: { kind: 'fixed', ref_a: REF_A, ref_b: REF_B } },
      ],
    }
    const result = loadAssemblyDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual([])
    expect(result.doc.version).toBeUndefined()
    expect(mates(result.doc).m_tan.offset).toBe(5)
  })

  it('flips a kindless assembly identified by its mates', () => {
    // `validateAssembly` tolerates a missing `kind` (kindless documents are a
    // real historical shape, classified by workspace metadata), so the guard
    // must too: a kindless document carrying a `mate` is a kindless assembly,
    // and its old-sign offsets would otherwise load untouched.
    const doc = {
      features: [{ id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: REF_A, ref_b: REF_B, offset: 7 } }],
    }
    const result = loadAssemblyDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toContain('mate-offset-plus-convention')
    expect(mates(result.doc).m1.offset).toBe(-7)
    expect(result.doc.version).toBe(CURRENT_DOC_VERSION)
  })

  it('leaves a kindless document without mates untouched', () => {
    // No `kind` and no mate feature identifies nothing as an assembly, so the
    // flip must not run: a kindless part loads through the same shape.
    const doc: Record<string, unknown> = {
      features: [{ id: 'e1', kind: 'extrude', params: { depth: 10 } }],
    }
    const applied = migrate(doc, 3)
    expect(applied).not.toContain('mate-offset-plus-convention')
    expect(doc.version).toBeUndefined()
  })

  it('leaves part documents untouched', () => {
    // The step guards on assembly shape: an explicit `kind: assembly`, or
    // kindless with a mate present. A part record with a mate-shaped feature
    // must come through `migrate` with its offset and stamp intact.
    const doc: Record<string, unknown> = {
      version: 3,
      kind: 'part',
      features: [{ id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: REF_A, ref_b: REF_B, offset: 7 } }],
    }
    const applied = migrate(doc, 3)
    expect(applied).not.toContain('mate-offset-plus-convention')
    expect(mates(doc).m1.offset).toBe(7)
    expect(doc.version).toBe(3)
  })

  it('leaves a document already stamped at the new version untouched', () => {
    const doc = {
      version: CURRENT_DOC_VERSION,
      kind: 'assembly',
      features: [{ id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: REF_A, ref_b: REF_B, offset: 7 } }],
    }
    const result = loadAssemblyDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual([])
    expect(mates(result.doc).m1.offset).toBe(7)
  })

  it('is stable across load, save and load again: no double negation', () => {
    const first = loadAssemblyDocText(LEGACY_V3_ASSEMBLY_OFFSETS.text)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const saved = stringifyYaml(first.doc)
    const second = loadAssemblyDocText(saved)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // The first load stamped the doc, so the second skips the flip entirely.
    expect(second.migrations).toEqual([])
    expect(second.doc).toEqual(first.doc)
    expect(mates(second.doc).m_scalar.offset).toBe(-7)
    expect(mates(second.doc).m_vector.offset).toEqual({ x: -3, y: 4 })
  })
})
