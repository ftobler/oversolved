import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { originAdapter } from '../originAdapter'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredSelectionId: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    activeFeatureId: 'S1',
    activeOriginLocal: [0, 0],
    normalSelection: new Set(),
  })
})

describe('originAdapter', () => {
  it('onHover sets hoveredSelectionId and hoveredVertexId', () => {
    originAdapter.onHover('@builtin_origin')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe('@builtin_origin')
    expect(s.hoveredVertexId).toBe('@builtin_origin')
    expect(s.hoveredSnapKind).toBe('vertex')
  })

  it('onHover publishes the active sketch originLocal as the hovered position', () => {
    useSketchEditorStore.setState({ activeOriginLocal: [-37.5, 12.25] })
    originAdapter.onHover('@builtin_origin')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexPosition).toEqual([-37.5, 12.25])
  })

  it('onHover publishes [0,0] on a builtin plane', () => {
    useSketchEditorStore.setState({ activeOriginLocal: [0, 0] })
    originAdapter.onHover('@builtin_origin')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexPosition).toEqual([0, 0])
  })

  it('onHover never publishes a bare [0,0] when originLocal is nonzero', () => {
    useSketchEditorStore.setState({ activeOriginLocal: [-37.5, 12.25] })
    originAdapter.onHover('@builtin_origin')
    const s = useSketchEditorStore.getState()
    expect(s.hoveredVertexPosition).not.toEqual([0, 0])
  })

  it('leaving the sketch resets activeOriginLocal so a stale plane cannot be published', () => {
    useSketchEditorStore.setState({ activeOriginLocal: [-37.5, 12.25] })
    useSketchEditorStore.getState().setActiveFeatureId(null)
    expect(useSketchEditorStore.getState().activeOriginLocal).toEqual([0, 0])
  })
})
