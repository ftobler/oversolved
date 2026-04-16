import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredBodyId: null,
    hoveredSurfaceId: null,
    normalSelection: new Set(),
  })
})

describe('Body3D selection - store behavior', () => {
  it('setHoveredBodyId updates store', () => {
    useSketchEditorStore.getState().setHoveredBodyId('ex1')
    expect(useSketchEditorStore.getState().hoveredBodyId).toBe('ex1')
  })

  it('toggleNormalSelection adds body query', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1')).toBe(true)
  })

  it('toggleNormalSelection removes on second call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1')).toBe(false)
  })

  it('isSelected derived correctly from normalSelection', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@ex1']) })
    const featureId = 'ex1'
    const isSelected = useSketchEditorStore.getState().normalSelection.has('@' + featureId)
    expect(isSelected).toBe(true)
  })

  it('isHovered derived correctly from hoveredBodyId', () => {
    useSketchEditorStore.setState({ hoveredBodyId: 'ex1' })
    const featureId = 'ex1'
    const isHovered = useSketchEditorStore.getState().hoveredBodyId === featureId
    expect(isHovered).toBe(true)
  })
})

describe('Body3D selection - face queries', () => {
  it('toggleNormalSelection adds face query', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/face/0')).toBe(true)
  })

  it('toggleNormalSelection removes face query on second call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/face/0')).toBe(false)
  })

  it('face selection query format is correct', () => {
    const featureId = 'ex1'
    const faceIndex = 5
    const query = `@${featureId}/face/${faceIndex}`
    useSketchEditorStore.getState().toggleNormalSelection(query)
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/face/5')).toBe(true)
  })
})

describe('Body3D selection - edge queries', () => {
  it('toggleNormalSelection adds edge query', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/edge/0')).toBe(true)
  })

  it('toggleNormalSelection removes edge query on second call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/edge/0')).toBe(false)
  })

  it('edge selection query format is correct', () => {
    const featureId = 'ex1'
    const edgeIndex = 3
    const query = `@${featureId}/edge/${edgeIndex}`
    useSketchEditorStore.getState().toggleNormalSelection(query)
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/edge/3')).toBe(true)
  })
})

describe('Body3D hover surface - store behavior', () => {
  it('setHoveredSurface sets hoveredSurfaceId', () => {
    useSketchEditorStore.getState().setHoveredSurface('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().hoveredSurfaceId).toBe('?d,d;@extrude1face0:face')
  })

  it('setHoveredSurface(null) clears hoveredSurfaceId', () => {
    useSketchEditorStore.getState().setHoveredSurface('?d,d;@extrude1face0:face')
    useSketchEditorStore.getState().setHoveredSurface(null)
    expect(useSketchEditorStore.getState().hoveredSurfaceId).toBeNull()
  })

  it('hoveredSurfaceId is independent from normalSelection', () => {
    useSketchEditorStore.getState().setHoveredSurface('?d,d;@extrude1face0:face')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    expect(useSketchEditorStore.getState().hoveredSurfaceId).toBe('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/face/0')).toBe(true)
  })
})

describe('Body3D selection - mixed selection types', () => {
  it('supports body, face, and edge selection simultaneously', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')  // body
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')  // face 0
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/1')  // face 1
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')  // edge 0

    const { normalSelection } = useSketchEditorStore.getState()
    expect(normalSelection.has('@ex1')).toBe(true)
    expect(normalSelection.has('@ex1/face/0')).toBe(true)
    expect(normalSelection.has('@ex1/face/1')).toBe(true)
    expect(normalSelection.has('@ex1/edge/0')).toBe(true)
    expect(normalSelection.size).toBe(4)
  })

  it('toggles each selection type independently', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')

    // Toggle off body, face should remain selected
    useSketchEditorStore.getState().toggleNormalSelection('@ex1')
    const state1 = useSketchEditorStore.getState()
    expect(state1.normalSelection.has('@ex1')).toBe(false)
    expect(state1.normalSelection.has('@ex1/face/0')).toBe(true)

    // Toggle off face
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    const state2 = useSketchEditorStore.getState()
    expect(state2.normalSelection.has('@ex1/face/0')).toBe(false)
    expect(state2.normalSelection.size).toBe(0)
  })
})
