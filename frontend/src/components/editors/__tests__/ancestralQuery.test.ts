/**
 * Tests for the click-commits-ancestral-query invariant.
 *
 * Invariant: every click handler commits a string into normalSelection that
 * is either an ancestral query or an entity:/vertex: ID convertible to one
 * via parseTarget. No handler may store a bare topological index.
 *
 * The ids below are the input set each handler family writes. Every case drives
 * them through the production parsers and pins the canonical output, so a
 * change to parseTarget or parseSelectionId that would break a stored selection
 * fails here. The older version asserted properties of these same literals
 * (startsWith('?'), Number.isFinite(Number(id))), which restates the test's own
 * data and can never fail when the code changes.
 */

import { describe, it, expect } from 'vitest'
import { parseTarget } from '@/utils/yamlMutations'
import { parseSelectionId } from '@/utils/query/selectionId'

// The raw `?...` ancestral queries are minted by the kernel and stored verbatim
// by Body3D; they never pass through parseSelectionId, so they are covered by
// the wrapper-strip cases below rather than a parse table here.
const HANDLER_IDS: { id: string; kind: 'entity' | 'vertex' | 'plane' }[] = [
  { id: 'entity:Sketch1:line1', kind: 'entity' },        // EntityLines.tsx
  { id: 'entity:Sketch1:arc1', kind: 'entity' },         // EntityLines.tsx
  { id: 'vertex:Sketch1:line1:start', kind: 'vertex' },  // VertexDots.tsx
  { id: 'vertex:Sketch1:arc1:center', kind: 'vertex' },  // VertexDots.tsx
  { id: '@ex1/face/3', kind: 'plane' },                  // Body3D fallback face
  { id: '@ex1/edge/2', kind: 'plane' },                  // Body3D fallback edge
  { id: '@ex1/vertex/0', kind: 'plane' },                // Body3D fallback vertex
  { id: '@body_ex1', kind: 'plane' },                    // BodyPartsList.tsx
  { id: '@Sketch1', kind: 'plane' },                     // FeatureTree.tsx
  { id: '@builtin_plane_front', kind: 'plane' },         // FeatureTree.tsx
]

describe('handler selection ids parse to a typed selection', () => {
  it.each(HANDLER_IDS)('"$id" reads as a $kind selection', ({ id, kind }) => {
    expect(parseSelectionId(id).kind).toBe(kind)
  })
})

describe('handler selection ids convert to a canonical wire ref', () => {
  // A host feature that is not the sketch, so entity/vertex refs come out
  // absolute. Slash-joined is the canonical kernel format.
  const HOST = 'hostFeature1'

  it.each([
    ['entity:Sketch1:line1', '@Sketch1/line1'],
    ['entity:Sketch1:arc1', '@Sketch1/arc1'],
    ['vertex:Sketch1:line1:start', '@Sketch1/line1/start'],
    ['vertex:Sketch1:arc1:center', '@Sketch1/arc1/center'],
    // face:/edge: wrappers strip to the inner ancestry query.
    ['face:ex1:?9,9;@ex1face0@ex1face1:face', '?9,9;@ex1face0@ex1face1:face'],
    ['edge:ex1:?9;@ex1edge0:edge', '?9;@ex1edge0:edge'],
    // Absolute and builtin refs pass through unchanged.
    ['@ex1/face/3', '@ex1/face/3'],
    ['@ex1/edge/2', '@ex1/edge/2'],
    ['@ex1/vertex/0', '@ex1/vertex/0'],
    ['@body_ex1', '@body_ex1'],
    ['@Sketch1', '@Sketch1'],
    ['@builtin_plane_front', '@builtin_plane_front'],
  ])('"%s" with a foreign host converts to "%s"', (id, expected) => {
    expect(parseTarget(id, HOST)).toBe(expected)
  })

  // Same-sketch ids become host-local `$` refs, which is what re-targeting a
  // stored ref must produce rather than a second `$`.
  it.each([
    ['entity:Sketch1:line1', '$line1'],
    ['vertex:Sketch1:line1:start', '$line1start'],
  ])('"%s" with its own host converts to "%s"', (id, expected) => {
    expect(parseTarget(id, 'Sketch1')).toBe(expected)
  })

  // A stored local ref re-run through parseTarget is a no-op, never a `$$`.
  it('leaves an already-local ref unchanged', () => {
    expect(parseTarget('$line1', 'Sketch1')).toBe('$line1')
  })
})
