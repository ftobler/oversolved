import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredBodyId: null,
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
