import { describe, it, expect } from 'vitest'
import { getSketchesToRender, getPreviewParts } from '@/components/Viewport/partUtils'
import type { Feature, PartResult } from '@/types/cad'

// partUtils is pure render-list selection (no R3F). partUtils.test.ts covers
// getBodiesToRender + computeEffectiveVisibleBodies; this pins the two
// previously-uncovered selectors: getSketchesToRender and getPreviewBodies.

const makePart = (createdBy: string | undefined, withMesh = true): PartResult => ({
  id: 'b',
  created_by: createdBy,
  modified_by: [],
  mesh: withMesh ? { vertices: [], faces: [], face_data: [], face_queries: [] } : undefined,
} as unknown as PartResult)

describe('getSketchesToRender', () => {
  const features: Feature[] = [
    { id: 'sk1', kind: 'sketch' },
    { id: 'pl1', kind: 'plane' },
    { id: 'sk2', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  ]

  it('returns [] for undefined or empty feature lists', () => {
    expect(getSketchesToRender(undefined, undefined, undefined)).toEqual([])
    expect(getSketchesToRender([], 2, undefined)).toEqual([])
  })

  it('returns every sketch when no visibility filter is given', () => {
    const ids = getSketchesToRender(features, undefined, undefined).map(f => f.id)
    expect(ids).toEqual(['sk1', 'sk2'])
  })

  it('drops sketches not in the visibleFeatures set', () => {
    const ids = getSketchesToRender(features, undefined, new Set(['sk1'])).map(f => f.id)
    expect(ids).toEqual(['sk1'])
  })

  it('only considers features before the rollback position', () => {
    // limit = 2 -> slice keeps [sk1, pl1]; only sk1 is a sketch, sk2 is beyond it.
    const ids = getSketchesToRender(features, 2, undefined).map(f => f.id)
    expect(ids).toEqual(['sk1'])
  })
})

describe('getPreviewBodies', () => {
  // idx: sk1=0, ex1=1, ex2=2
  const features: Feature[] = [
    { id: 'sk1', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    { id: 'ex2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  ]
  const parts: Record<string, PartResult> = {
    body_ex1: makePart('ex1'),
    body_ex2: makePart('ex2'),
  }

  it('returns [] when bodies are missing or no rollback is set', () => {
    expect(getPreviewParts(undefined, features, 2, undefined)).toEqual([])
    expect(getPreviewParts(parts, features, undefined, undefined)).toEqual([])
  })

  it('includes bodies created at or after previewFrom (rollback - 1)', () => {
    // rollback 2 -> previewFrom 1; ex1 (idx 1) and ex2 (idx 2) both qualify.
    const ids = getPreviewParts(parts, features, 2, undefined).map(b => b.partId).sort()
    expect(ids).toEqual(['body_ex1', 'body_ex2'])
  })

  it('excludes bodies whose creator is before previewFrom', () => {
    // rollback 3 -> previewFrom 2; ex1 (idx 1 < 2) drops out, only ex2 remains.
    const ids = getPreviewParts(parts, features, 3, undefined).map(b => b.partId)
    expect(ids).toEqual(['body_ex2'])
  })

  it('keeps bodies with an unknown creator (idx < 0) as non-preview', () => {
    const withGhost = { ...parts, body_ghost: makePart('not-a-feature') }
    const ids = getPreviewParts(withGhost, features, 3, undefined).map(b => b.partId)
    expect(ids).toContain('body_ghost')
  })

  it('treats every body as non-preview when the feature list is undefined', () => {
    // features?.findIndex(...) ?? -1 -> -1, so nothing is filtered out.
    const ids = getPreviewParts(parts, undefined, 3, undefined).map(b => b.partId).sort()
    expect(ids).toEqual(['body_ex1', 'body_ex2'])
  })

  it('skips bodies that have no mesh', () => {
    const withNoMesh = { body_ex2: makePart('ex2', false) }
    expect(getPreviewParts(withNoMesh, features, 2, undefined)).toEqual([])
  })

  it('falls back featureId to bodyId when created_by is missing', () => {
    const items = getPreviewParts({ orphan: makePart(undefined) }, features, 1, undefined)
    expect(items[0].featureId).toBe('orphan')
  })

  it('sets the visible flag from the visibleBodies set', () => {
    const visible = getPreviewParts(parts, features, 2, new Set(['body_ex1']))
    const ex1 = visible.find(b => b.partId === 'body_ex1')!
    const ex2 = visible.find(b => b.partId === 'body_ex2')!
    expect(ex1.visible).toBe(true)
    expect(ex2.visible).toBe(false)
  })
})
