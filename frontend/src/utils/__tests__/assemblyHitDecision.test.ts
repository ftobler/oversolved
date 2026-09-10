// T3: the one assembly highlight decision. The assembly equivalent of the part
// editor's highlightSymmetry test: hover and click must resolve the same
// primitive into their respective colour slots, and a gizmo handle occludes the
// entity behind it for both.

import { describe, it, expect } from 'vitest'
import {
  EDGE_LAYER_NAME, FACE_LAYER_NAME, GIZMO_HANDLE_LAYER_NAME,
  ORIGIN_LAYER_NAME, PLANE_LAYER_NAME, VERTEX_LAYER_NAME,
} from '@/picking'
import { clickTarget, decideAssemblyHit, hoverTarget, type AssemblyHit } from '@/utils/assemblyHitDecision'
import { buildAssemblySelectionGeometry } from '@/utils/assemblySelectionGeometry'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

describe('decideAssemblyHit symmetry', () => {
  for (const layer of [FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME, PLANE_LAYER_NAME, ORIGIN_LAYER_NAME]) {
    it(`hover and click name the same entity on layer '${layer}'`, () => {
      const hits: AssemblyHit[] = [{ entityKey: 'k', layer }]
      const decision = decideAssemblyHit(hits)
      expect(clickTarget(decision)).toBe('k')
      expect(hoverTarget(decision)).toBe('k')
      expect(clickTarget(decision)).toBe(hoverTarget(decision))
      expect(decision.gizmoHandle).toBeNull()
    })
  }

  it('a gizmo handle occludes the entity for both framings', () => {
    const hits: AssemblyHit[] = [
      { entityKey: 'gizmo', layer: GIZMO_HANDLE_LAYER_NAME },
      { entityKey: 'k', layer: FACE_LAYER_NAME },
    ]
    const decision = decideAssemblyHit(hits)
    expect(decision.gizmoHandle).toBe('gizmo')
    expect(decision.entityKey).toBeNull()
    expect(clickTarget(decision)).toBeNull()
    expect(hoverTarget(decision)).toBeNull()
  })

  it('an empty hit list names nothing in either framing', () => {
    const decision = decideAssemblyHit([])
    expect(clickTarget(decision)).toBeNull()
    expect(hoverTarget(decision)).toBeNull()
    expect(decision.gizmoHandle).toBeNull()
  })

  it('the top entity wins, not a lower one', () => {
    const hits: AssemblyHit[] = [
      { entityKey: 'top', layer: EDGE_LAYER_NAME },
      { entityKey: 'below', layer: FACE_LAYER_NAME },
    ]
    const decision = decideAssemblyHit(hits)
    expect(hoverTarget(decision)).toBe('top')
    expect(clickTarget(decision)).toBe('top')
  })
})

// One face with two triangles, the minimal pick body that lights a primitive.
function body(): AssemblyPickBody {
  return {
    handle: 'B',
    bodyKey: 'B',
    faces: {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        2, 0, 0, 3, 0, 0, 2, 1, 0,
      ]),
      triangleToFace: new Uint32Array([0, 0]),
      faceQueries: ['k'],
    },
    edges: null,
    vertices: null,
    faceBoundaries: null,
  }
}

describe('assembly highlight geometry parity', () => {
  it('the same primitive lights the selected and hovered slots', () => {
    const selected = buildAssemblySelectionGeometry([body()], new Set(['k']), null)
    const hovered = buildAssemblySelectionGeometry([body()], new Set(), 'k')
    expect(selected.selectedFaces.length).toBeGreaterThan(0)
    expect(hovered.hoveredFaces.length).toBeGreaterThan(0)
    // Same triangles, different colour slot: the decision feeds one build shape.
    expect(Array.from(hovered.hoveredFaces)).toEqual(Array.from(selected.selectedFaces))
  })
})
