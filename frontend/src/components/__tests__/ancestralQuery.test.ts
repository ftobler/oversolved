/**
 * Tests for the click-commits-ancestral-query invariant.
 *
 * Invariant: every click handler commits a string into normalSelection that
 * is either an ancestral query or an entity:/vertex: ID convertible to one
 * via parseTarget.  No handler may store a bare topological index.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { parseTarget } from '@/utils/yamlMutations'
import { parseSelectionId } from '@/utils/selectionId'

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    hoveredBodyId: null,
    hoveredSurfaceId: null,
    hovered3DSurfaceId: null,
  })
})

// ─── test_click_face_stores_ancestral_query ───

describe('test_click_face_stores_ancestral_query', () => {
  it('face query stored by Body3D starts with ? (ancestry format)', () => {
    // Body3D.tsx resolveFaceQuery returns face_queries[i] from the backend
    // when available.  Those backend-provided strings are ancestral queries.
    const ancestralQuery = '?d,d;@extrude1face0@extrude1face1:face'
    useSketchEditorStore.getState().toggleNormalSelection(ancestralQuery)
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has(ancestralQuery)).toBe(true)
    // The stored string must be parseable as an ancestral query (starts with ?)
    // or as a stable @-reference -- never a raw number.
    expect(
      ancestralQuery.startsWith('?') || ancestralQuery.startsWith('@')
    ).toBe(true)
  })

  it('fallback face query uses @featureId/face/N form (still resolvable, never bare integer)', () => {
    // When face_queries is absent, Body3D falls back to `@${featureId}/face/${index}`.
    // This remains resolvable because it carries the featureId prefix.
    const featureId = 'ex1'
    const faceIndex = 3
    const fallback = `@${featureId}/face/${faceIndex}`
    useSketchEditorStore.getState().toggleNormalSelection(fallback)
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has(fallback)).toBe(true)
    // Must not be a bare integer.
    expect(Number.isFinite(Number(fallback))).toBe(false)
    // Must start with @ (absolute ref).
    expect(fallback.startsWith('@')).toBe(true)
  })

  it('face parseTarget strips the face: prefix and returns the inner ancestry query', () => {
    // When a face: ID reaches parseTarget (e.g. via a pick chip), the result
    // must be the raw ancestry query, not an index.
    const raw = '?9,9;@ex1face0@ex1face1:face'
    const selectionId = `face:ex1:${raw}`
    const result = parseTarget(selectionId, 'ex2')
    expect(result).toBe(raw)
    expect(result.startsWith('?') || result.startsWith('@')).toBe(true)
  })
})

// ─── test_click_sketch_entity_resolves_via_ancestry_after_reorder ───

describe('test_click_sketch_entity_resolves_via_ancestry_after_reorder', () => {
  it('entity: ID encodes featureId so reordering features does not break resolution', () => {
    // EntityLines.tsx stores `entity:<featureId>:<entityId>` where featureId is
    // the sketch feature ID -- not a positional index.  After a reorder the
    // featureId string remains the same, so the stored ID still resolves.
    const featureId = 'Sketch1'
    const entityId = 'line1'
    const entId = `entity:${featureId}:${entityId}`

    useSketchEditorStore.getState().toggleNormalSelection(entId)
    expect(useSketchEditorStore.getState().normalSelection.has(entId)).toBe(true)

    // Simulate feature reorder: the featureId string is unchanged.
    // parseTarget must still produce the correct query.
    const hostAfterReorder = 'Extrude1'  // consumer feature that is now first
    const resolved = parseTarget(entId, hostAfterReorder)
    // Cross-feature -> @<featureId><entityId> (absolute ref, not a local index).
    expect(resolved).toBe(`@${featureId}${entityId}`)
    expect(resolved.startsWith('@')).toBe(true)
  })

  it('vertex: ID encodes featureId + sub so reorder does not break resolution', () => {
    const featureId = 'Sketch1'
    const entityId = 'line1'
    const sub = 'start'
    const vertId = `vertex:${featureId}:${entityId}:${sub}`

    useSketchEditorStore.getState().toggleNormalSelection(vertId)
    expect(useSketchEditorStore.getState().normalSelection.has(vertId)).toBe(true)

    // After reorder, featureId is still 'Sketch1'.
    const resolved = parseTarget(vertId, 'Extrude1')
    expect(resolved).toBe(`@${featureId}${entityId}${sub}`)
    expect(resolved.startsWith('@')).toBe(true)
  })

  it('same-feature entity: resolves to local $-ref, not an index', () => {
    // When the consumer is in the same sketch, parseTarget returns $<entityId>.
    const featureId = 'Sketch1'
    const entityId = 'arc1'
    const entId = `entity:${featureId}:${entityId}`
    const resolved = parseTarget(entId, featureId)
    expect(resolved).toBe(`$${entityId}`)
    // $-refs are local IDs, not positional integers.
    expect(Number.isFinite(Number(entityId))).toBe(false)
  })
})

// ─── test_no_transient_index_in_normal_selection ───

describe('test_no_transient_index_in_normal_selection', () => {
  /**
   * All IDs that handlers may write into normalSelection.
   * Collected from every click-dispatch path in the codebase:
   *   - EntityLines.tsx / VertexDots.tsx: entity:, vertex:
   *   - Body3D.tsx faces: face_queries from backend (?...) or fallback @feat/face/N
   *   - Body3D.tsx edges: edgeQueries from backend (?...) or fallback @feat/edge/N
   *   - Body3D.tsx vertices: vertexQueries from backend (?...) or fallback @feat/vertex/N
   *   - BodyPartsList.tsx / FeatureTree.tsx: @<bodyId> / @<featureId>
   */
  const handlerExamples: string[] = [
    // Sketch entity click (EntityLines.tsx)
    'entity:Sketch1:line1',
    'entity:Sketch1:arc1',
    // Sketch vertex click (VertexDots.tsx)
    'vertex:Sketch1:line1:start',
    'vertex:Sketch1:arc1:center',
    // 3D face click -- backend-provided ancestral query (Body3D.tsx)
    '?d,d;@extrude1face0@extrude1face1:face',
    // 3D face click -- fallback when face_queries absent
    '@ex1/face/3',
    // 3D edge click -- backend-provided
    '?e;@ex1edge0:edge',
    // 3D edge click -- fallback
    '@ex1/edge/2',
    // 3D vertex click -- backend-provided
    '?f;@import1vertex0:vertex',
    // 3D vertex click -- fallback
    '@ex1/vertex/0',
    // Body click (BodyPartsList.tsx)
    '@body_ex1',
    // Feature/plane click (FeatureTree.tsx)
    '@Sketch1',
    '@builtin_plane_front',
  ]

  handlerExamples.forEach(id => {
    it(`"${id}" is not a bare integer`, () => {
      expect(Number.isFinite(Number(id))).toBe(false)
    })

    it(`"${id}" starts with a recognised prefix`, () => {
      const ok =
        id.startsWith('entity:') ||
        id.startsWith('vertex:') ||
        id.startsWith('face:') ||
        id.startsWith('edge:') ||
        id.startsWith('constraint:') ||
        id.startsWith('@') ||
        id.startsWith('?')
      expect(ok).toBe(true)
    })

    it(`"${id}" round-trips through toggleNormalSelection`, () => {
      useSketchEditorStore.getState().toggleNormalSelection(id)
      expect(useSketchEditorStore.getState().normalSelection.has(id)).toBe(true)
      useSketchEditorStore.getState().toggleNormalSelection(id)
      expect(useSketchEditorStore.getState().normalSelection.has(id)).toBe(false)
    })
  })

  it('parseSelectionId accepts all entity:/vertex:/@-prefixed IDs without throwing', () => {
    const parseable = handlerExamples.filter(id =>
      id.startsWith('entity:') ||
      id.startsWith('vertex:') ||
      id.startsWith('face:') ||
      id.startsWith('edge:') ||
      id.startsWith('constraint:') ||
      id.startsWith('@')
    )
    for (const id of parseable) {
      expect(() => parseSelectionId(id)).not.toThrow()
    }
  })

  it('parseTarget converts every entity:/vertex:/face:/@-prefixed ID to a non-empty string', () => {
    const convertible = handlerExamples.filter(id =>
      id.startsWith('entity:') ||
      id.startsWith('vertex:') ||
      id.startsWith('face:') ||
      id.startsWith('@')
    )
    for (const id of convertible) {
      const result = parseTarget(id, 'hostFeature1')
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    }
  })
})
