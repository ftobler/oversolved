import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyClearPickField } from '@/utils/yamlMutations/featureAdmin'
import { featureAt } from '@/testing/featureAccess'

const filletDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [
    { id: 'f1', kind: 'fillet', fillet: { edges: ['?e1', '?e2', '?e3'], radius: 1 } },
  ],
})

const VALID_NAMES = 'edges, faces, tools, bodies, sketch, path, targets, source_features'

describe('applyClearPickField', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('empties a multi pick field and leaves its other parameters alone', () => {
    const doc = filletDoc()
    applyClearPickField(doc, 'f1', 'edges')
    expect(featureAt(doc, 0, 'fillet').fillet.edges).toEqual([])
    expect(featureAt(doc, 0, 'fillet').fillet.radius).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('normalizes a legacy bare-string sketch ref before clearing it', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 3 } }],
    }
    applyClearPickField(doc, 'ex1', 'sketch')
    expect(featureAt(doc, 0, 'extrude').extrude.sketch).toEqual([])
    expect(featureAt(doc, 0, 'extrude').extrude.distance).toBe(3)
  })

  it('no-ops for an unknown feature id', () => {
    const doc = filletDoc()
    const before = structuredClone(doc)
    applyClearPickField(doc, 'nonexistent', 'edges')
    expect(doc).toEqual(before)
  })

  it('refuses an unknown field by name instead of writing it', () => {
    const doc = filletDoc()
    const before = structuredClone(doc)
    applyClearPickField(doc, 'f1', 'unknown_field')
    expect(doc).toEqual(before)
    // A direct call gets the same named refusal the drive's value rule gives,
    // rather than a silent return that makes a typo look like a successful clear.
    expect(warnSpy).toHaveBeenCalledOnce()
    expect(warnSpy.mock.calls[0][0]).toBe(
      `applyClearPickField: unknown pick field "unknown_field"; use one of ${VALID_NAMES}`,
    )
  })
})
