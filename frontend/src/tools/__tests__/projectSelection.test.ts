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

  it('falls back to the face centroid point when boundary edges are unknown', () => {
    const muts = projectionMutationsForId(FACE_Q, FEATURE, noResolvers)
    expect(muts).toEqual([{ type: 'add_projected_entity', featureId: FEATURE, kind: 'point', source: FACE_Q }])
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
})

describe('projectSelection', () => {
  let mutations: Mutation[]

  beforeEach(() => {
    mutations = []
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      chipOwnedSelection: new Set(),
      selectionDomain: 'sketch_2d',
      activeFeatureId: FEATURE,
      activeTool: null,
    })
    setSketchCallback('onMutation', (m: Mutation) => { mutations.push(m) })
  })

  it('projects the whole selection and consumes it', () => {
    useSketchEditorStore.setState({ normalSelection: new Set([STRAIGHT_Q, VERTEX_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(noResolvers)).toBe(true)
    expect(mutations).toHaveLength(2)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
  })

  it('leaves the selection alone and reports failure when nothing is projectable', () => {
    useSketchEditorStore.setState({ normalSelection: new Set([`entity:${FEATURE}:L1`]) })
    expect(projectSelection(noResolvers)).toBe(false)
    expect(mutations).toHaveLength(0)
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(1)
  })

  it('reports failure on an empty selection so the caller enters the pick tool', () => {
    expect(projectSelection(noResolvers)).toBe(false)
    expect(mutations).toHaveLength(0)
  })

  it('reports failure when no sketch is being edited', () => {
    useSketchEditorStore.setState({ activeFeatureId: null, normalSelection: new Set([STRAIGHT_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(noResolvers)).toBe(false)
    expect(mutations).toHaveLength(0)
  })

  it('resolves kinds through the injected resolvers', () => {
    const edgeKind = vi.fn(() => 'circle')
    useSketchEditorStore.setState({ normalSelection: new Set([EDGE_Q]), selectionDomain: 'body_3d' })
    expect(projectSelection(resolvers({ edgeKind }))).toBe(true)
    expect(edgeKind).toHaveBeenCalledWith(EDGE_Q)
    expect(mutations[0]).toMatchObject({ type: 'add_projected_entity', kind: 'circle', source: EDGE_Q })
  })
})
