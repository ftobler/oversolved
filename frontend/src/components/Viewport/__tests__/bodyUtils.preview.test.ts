import { describe, it, expect } from 'vitest'
import { getSketchesToRender, getPreviewBodies } from '@/components/Viewport/bodyUtils'
import type { Feature, BodyResult } from '@/types/cad'

// bodyUtils is pure render-list selection (no R3F). bodyUtils.test.ts covers
// getBodiesToRender + computeEffectiveVisibleBodies; this pins the two
// previously-uncovered selectors: getSketchesToRender and getPreviewBodies.

const makeBody = (createdBy: string | undefined, withMesh = true): BodyResult => ({
  id: 'b',
  created_by: createdBy,
  modified_by: [],
  mesh: withMesh ? { vertices: [], faces: [], face_data: [], face_queries: [] } : undefined,
} as unknown as BodyResult)

describe('getSketchesToRender', () => {
  const features: Feature[] = [
    { id: 'sk1', kind: 'sketch' },
    { id: 'pl1', kind: 'plane' },
    { id: 'sk2', kind: 'sketch' },
    { id: 'ex1', kind: 'extrude' },
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
    { id: 'ex1', kind: 'extrude' },
    { id: 'ex2', kind: 'extrude' },
  ]
  const bodies: Record<string, BodyResult> = {
    body_ex1: makeBody('ex1'),
    body_ex2: makeBody('ex2'),
  }

  it('returns [] when bodies are missing or no rollback is set', () => {
    expect(getPreviewBodies(undefined, features, 2, undefined)).toEqual([])
    expect(getPreviewBodies(bodies, features, undefined, undefined)).toEqual([])
  })

  it('includes bodies created at or after previewFrom (rollback - 1)', () => {
    // rollback 2 -> previewFrom 1; ex1 (idx 1) and ex2 (idx 2) both qualify.
    const ids = getPreviewBodies(bodies, features, 2, undefined).map(b => b.bodyId).sort()
    expect(ids).toEqual(['body_ex1', 'body_ex2'])
  })

  it('excludes bodies whose creator is before previewFrom', () => {
    // rollback 3 -> previewFrom 2; ex1 (idx 1 < 2) drops out, only ex2 remains.
    const ids = getPreviewBodies(bodies, features, 3, undefined).map(b => b.bodyId)
    expect(ids).toEqual(['body_ex2'])
  })

  it('keeps bodies with an unknown creator (idx < 0) as non-preview', () => {
    const withGhost = { ...bodies, body_ghost: makeBody('not-a-feature') }
    const ids = getPreviewBodies(withGhost, features, 3, undefined).map(b => b.bodyId)
    expect(ids).toContain('body_ghost')
  })

  it('treats every body as non-preview when the feature list is undefined', () => {
    // features?.findIndex(...) ?? -1 -> -1, so nothing is filtered out.
    const ids = getPreviewBodies(bodies, undefined, 3, undefined).map(b => b.bodyId).sort()
    expect(ids).toEqual(['body_ex1', 'body_ex2'])
  })

  it('skips bodies that have no mesh', () => {
    const withNoMesh = { body_ex2: makeBody('ex2', false) }
    expect(getPreviewBodies(withNoMesh, features, 2, undefined)).toEqual([])
  })

  it('falls back featureId to bodyId when created_by is missing', () => {
    const items = getPreviewBodies({ orphan: makeBody(undefined) }, features, 1, undefined)
    expect(items[0].featureId).toBe('orphan')
  })

  it('sets the visible flag from the visibleBodies set', () => {
    const visible = getPreviewBodies(bodies, features, 2, new Set(['body_ex1']))
    const ex1 = visible.find(b => b.bodyId === 'body_ex1')!
    const ex2 = visible.find(b => b.bodyId === 'body_ex2')!
    expect(ex1.visible).toBe(true)
    expect(ex2.visible).toBe(false)
  })
})
