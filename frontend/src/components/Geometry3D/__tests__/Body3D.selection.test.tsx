import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredSelectionId: null,
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
  })
})

describe('Body3D selection - store behavior', () => {
  it('setHoveredSelectionId updates store', () => {
    useSketchEditorStore.getState().setHoveredSelectionId('ex1')
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('ex1')
  })

  it('imperative getState reads current hoveredSelectionId without stale closure', () => {
    // Regression: handleMeshClick used a closed-over hoveredSelectionId value
    // that could be stale if React had not re-rendered Body3D between
    // onPointerOver and onClick. Fix: read from store imperatively.
    useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
    const currentHover = useSketchEditorStore.getState().hoveredSelectionId
    expect(currentHover).toBe('?d,d;@extrude1face0:face')
  })

  it('toggleNormalSelection adds body query', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(true)
  })

  it('toggleNormalSelection removes on second call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(false)
  })

  it('isSelected derived correctly from normalSelection using bodyId', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1']) })
    const bodyId = 'body_ex1'
    const isSelected = useSketchEditorStore.getState().normalSelection.has('@' + bodyId)
    expect(isSelected).toBe(true)
  })

  it('isHovered derived correctly from hoveredSelectionId', () => {
    useSketchEditorStore.setState({ hoveredSelectionId: 'ex1' })
    const featureId = 'ex1'
    const isHovered = useSketchEditorStore.getState().hoveredSelectionId === featureId
    expect(isHovered).toBe(true)
  })
})

describe('Body3D selection - bodyId format', () => {
  it('selects body using @body_<featureId> format', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_extrude1')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_extrude1')).toBe(true)
  })

  it('deselects body using @body_<featureId> format on second toggle', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_extrude1')
    useSketchEditorStore.getState().toggleNormalSelection('@body_extrude1')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_extrude1')).toBe(false)
  })

  it('supports suffixed body ids for multiple bodies per feature', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_extrude1_1')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_extrude1_1')).toBe(true)
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
  it('setHoveredSelectionId sets hoveredSelectionId', () => {
    useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('?d,d;@extrude1face0:face')
  })

  it('setHoveredSelectionId(null) clears hoveredSelectionId', () => {
    useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
    useSketchEditorStore.getState().setHoveredSelectionId(null)
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBeNull()
  })

  it('hoveredSelectionId is independent from normalSelection', () => {
    useSketchEditorStore.getState().setHoveredSelectionId('?d,d;@extrude1face0:face')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().normalSelection.has('@ex1/face/0')).toBe(true)
  })
})

describe('Body3D selection - chip highlights ride normalSelection', () => {
  it('syncChipSelection puts body ref into normalSelection so isBodySelected is true', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1'])
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(true)
  })

  it('a body ref not in chip values is not selected', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex2'])
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1')).toBe(false)
  })

  it('edge queries synced through chip match getIsEdgeSelected predicate', () => {
    useSketchEditorStore.getState().syncChipSelection(['@ex1/edge/0', '@ex1/edge/2'])
    const sel = useSketchEditorStore.getState().normalSelection
    expect(['@ex1/edge/0', '@ex1/edge/1', '@ex1/edge/2'].filter(q => sel.has(q))).toEqual(['@ex1/edge/0', '@ex1/edge/2'])
  })

  it('face queries synced through chip match face overlay predicate', () => {
    useSketchEditorStore.getState().syncChipSelection(['?body_ex1/face/0', '?body_ex1/face/2'])
    const sel = useSketchEditorStore.getState().normalSelection
    expect(['?body_ex1/face/0', '?body_ex1/face/1', '?body_ex1/face/2'].filter(q => sel.has(q))).toEqual(['?body_ex1/face/0', '?body_ex1/face/2'])
  })

  it('pre-existing normalSelection survives a chip sync that does not overlap', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1']) })
    useSketchEditorStore.getState().syncChipSelection(['@ex1/edge/0', '@ex1/edge/1'])
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@body_ex1')).toBe(true)
    expect(sel.has('@ex1/edge/0')).toBe(true)
    expect(sel.has('@ex1/edge/1')).toBe(true)
    expect(sel.size).toBe(3)
  })
})

describe('Body3D selection - mixed selection types', () => {
  it('supports body, face, and edge selection simultaneously', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')  // body
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')  // face 0
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/1')  // face 1
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/edge/0')  // edge 0

    const { normalSelection } = useSketchEditorStore.getState()
    expect(normalSelection.has('@body_ex1')).toBe(true)
    expect(normalSelection.has('@ex1/face/0')).toBe(true)
    expect(normalSelection.has('@ex1/face/1')).toBe(true)
    expect(normalSelection.has('@ex1/edge/0')).toBe(true)
    expect(normalSelection.size).toBe(4)
  })

  it('toggles each selection type independently', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')

    // Toggle off body, face should remain selected
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1')
    const state1 = useSketchEditorStore.getState()
    expect(state1.normalSelection.has('@body_ex1')).toBe(false)
    expect(state1.normalSelection.has('@ex1/face/0')).toBe(true)

    // Toggle off face
    useSketchEditorStore.getState().toggleNormalSelection('@ex1/face/0')
    const state2 = useSketchEditorStore.getState()
    expect(state2.normalSelection.has('@ex1/face/0')).toBe(false)
    expect(state2.normalSelection.size).toBe(0)
  })
})
