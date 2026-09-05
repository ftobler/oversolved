import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Mutation } from '@/types/cad'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { projectionMutationsForId, projectionMutationsForSelection, type ProjectionResolvers } from '@/tools/projectionMutations'
import { projectSelection } from '@/tools/projectSelectionCommand'

const FEATURE = 'S1'
const EDGE_Q = '?4,4;@bxx@fyy:edge'
const STRAIGHT_Q = '?4,4;@bxx@fzz:straightedge'
const FACE_Q = '?4,4;@bxx@fww:flatface'
const VERTEX_Q = '?4,4;@bxx@fvv:vertex'

const noResolvers: ProjectionResolvers = {
  entityKind: () => null,
  edgeKind: () => null,
  faceEdges: () => null,
}

function resolvers(over: Partial<ProjectionResolvers>): ProjectionResolvers {
  return { ...noResolvers, ...over }
}

describe('projectionMutationsForId', () => {
  it('skips an entity of the sketch being projected onto', () => {
    expect(projectionMutationsForId(`entity:${FEATURE}:L1`, FEATURE, noResolvers)).toEqual([])
  })

  it('skips ids that are not projectable geometry', () => {
    expect(projectionMutationsForId('constraint:S1:C1', FEATURE, noResolvers)).toEqual([])
    expect(projectionMutationsForId('@xy_plane', FEATURE, noResolvers)).toEqual([])
    expect(projectionMutationsForId('entity:S2', FEATURE, noResolvers)).toEqual([])
  })

  it('excludes a whole-body pick as a projection source', () => {
    // A parts-list `@body_...` pick names no geometry, so it is never
    // projected; a body primitive (face/edge/vertex ancestry query) still is.
    expect(projectionMutationsForId('@body_ex1', FEATURE, noResolvers)).toEqual([])
    expect(projectionMutationsForId(FACE_Q, FEATURE, noResolvers)).not.toEqual([])
  })

  it('projects a foreign sketch entity with its resolved kind', () => {
    const muts = projectionMutationsForId('entity:S2:C1', FEATURE, resolvers({ entityKind: () => 'circle' }))
    expect(muts).toEqual([{ type: 'add_projected_entity', featureId: FEATURE, kind: 'circle', source: '@S2/C1' }])
  })

  it('falls back to a line when the source entity kind is unknown', () => {
    const muts = projectionMutationsForId('entity:S2:L1', FEATURE, noResolvers)
    expect(muts[0]).toMatchObject({ kind: 'line', source: '@S2/L1' })
  })

  it('projects a body edge with the curve kind of its source', () => {
    const muts = projectionMutationsForId(EDGE_Q, FEATURE, resolvers({ edgeKind: () => 'arc' }))
    expect(muts).toEqual([{ type: 'add_projected_entity', featureId: FEATURE, kind: 'arc', source: EDGE_Q }])
  })

  it('projects a straight body edge as a line', () => {
    const muts = projectionMutationsForId(STRAIGHT_Q, FEATURE, noResolvers)
    expect(muts[0]).toMatchObject({ kind: 'line', source: STRAIGHT_Q })
  })

  it('projects a body vertex as a point', () => {
    const muts = projectionMutationsForId(VERTEX_Q, FEATURE, noResolvers)
    expect(muts[0]).toMatchObject({ kind: 'point', source: VERTEX_Q })
  })

  it('expands a face into one projected entity per boundary edge', () => {
    const faceEdges = [
      { source: '?a;@b:edge', kind: 'line' },
      { source: '?c;@d:edge', kind: 'arc' },
    ]
    const muts = projectionMutationsForId(FACE_Q, FEATURE, resolvers({ faceEdges: () => faceEdges }))
    expect(muts).toHaveLength(2)
    expect(muts.map(m => m.type === 'add_projected_entity' && m.kind)).toEqual(['line', 'arc'])
  })

  it('projects a conic/sphere/torus face by its boundary wire, not the centroid point', () => {
    // The isFace decision must cover every SurfaceType kind; before the shared
    // restriction vocabulary these three fell through to the centroid branch.
    const faceEdges = [{ source: '?a;@b:edge', kind: 'arc' }]
    for (const tr of ['coneface', 'sphereface', 'torusface']) {
      const muts = projectionMutationsForId(`?4,4;@bxx@fww:${tr}`, FEATURE, resolvers({ faceEdges: () => faceEdges }))
      expect(muts).toEqual([{ type: 'add_projected_entity', featureId: FEATURE, kind: 'arc', source: '?a;@b:edge' }])
    }
  })

  it('falls back to the face centroid point when boundary edges are unknown', () => {
    const muts = projectionMutationsForId('?4,4;@bxx@fww:coneface', FEATURE, noResolvers)
    expect(muts).toEqual([{ type: 'add_projected_entity', featureId: FEATURE, kind: 'point', source: '?4,4;@bxx@fww:coneface' }])
  })
})

describe('projectionMutationsForSelection', () => {
  it('projects every projectable id and skips the rest, in selection order', () => {
    const ids = [`entity:${FEATURE}:L1`, STRAIGHT_Q, 'constraint:S1:C1', VERTEX_Q]
    const muts = projectionMutationsForSelection(ids, FEATURE, noResolvers)
    expect(muts.map(m => m.type === 'add_projected_entity' && m.source)).toEqual([STRAIGHT_Q, VERTEX_Q])
  })

  it('returns nothing for a wholly unprojectable selection', () => {
    expect(projectionMutationsForSelection([`entity:${FEATURE}:L1`], FEATURE, noResolvers)).toEqual([])
  })

  it('returns nothing for a selection holding only whole-body picks', () => {
    expect(projectionMutationsForSelection(['@body_ex1', '@body_ex2'], FEATURE, noResolvers)).toEqual([])
  })
})

describe('projectSelection', () => {
  let batches: Mutation[][]

  beforeEach(() => {
    batches = []
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
      activeFeatureId: FEATURE,
      activeTool: null,
    })
    setSketchCallback('onMutationBatch', (ms: Mutation[]) => { batches.push(ms) })
  })

  it('projects the whole selection as one batch and consumes it', () => {
    useSketchEditorStore.setState({ normalSelection: new Set([STRAIGHT_Q, VERTEX_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(noResolvers)).toBe(true)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('leaves the selection alone and reports failure when nothing is projectable', () => {
    useSketchEditorStore.setState({ normalSelection: new Set([`entity:${FEATURE}:L1`]) })
    expect(projectSelection(noResolvers)).toBe(false)
    expect(batches).toHaveLength(0)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(1)
  })

  it('reports failure on an empty selection so the caller enters the pick tool', () => {
    expect(projectSelection(noResolvers)).toBe(false)
    expect(batches).toHaveLength(0)
  })

  it('reports failure and leaves the selection when it holds only whole-body picks', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1']), selectionDomain: 'body_3d' })
    expect(projectSelection(noResolvers)).toBe(false)
    expect(batches).toHaveLength(0)
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(true)
  })

  it('reports failure when no sketch is being edited', () => {
    useSketchEditorStore.setState({ activeFeatureId: null, normalSelection: new Set([STRAIGHT_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(noResolvers)).toBe(false)
    expect(batches).toHaveLength(0)
  })

  it('resolves kinds through the injected resolvers', () => {
    const edgeKind = vi.fn(() => 'circle')
    useSketchEditorStore.setState({ normalSelection: new Set([EDGE_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(resolvers({ edgeKind }))).toBe(true)
    expect(edgeKind).toHaveBeenCalledWith(EDGE_Q)
    expect(batches[0][0]).toMatchObject({ type: 'add_projected_entity', kind: 'circle', source: EDGE_Q })
  })
})
