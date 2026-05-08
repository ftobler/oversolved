import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

beforeEach(() => {
  useSketchEditorStore.setState({
    hoveredBodyId: null,
    hoveredSurfaceId: null,
    hovered3DSurfaceId: null,
    normalSelection: new Set(),
    pickChipHighlightItems: [],
  })
})

describe('Body3D selection - store behavior', () => {
  it('setHoveredBodyId updates store', () => {
    useSketchEditorStore.getState().setHoveredBodyId('ex1')
    expect(useSketchEditorStore.getState().hoveredBodyId).toBe('ex1')
  })

  it('imperative getState reads current hovered3DSurfaceId without stale closure', () => {
    // Regression: handleMeshClick used a closed-over hovered3DSurfaceId value
    // that could be stale if React had not re-rendered Body3D between
    // onPointerOver and onClick. Fix: read from store imperatively.
    useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
    const currentHover = useSketchEditorStore.getState().hovered3DSurfaceId
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

  it('isHovered derived correctly from hoveredBodyId', () => {
    useSketchEditorStore.setState({ hoveredBodyId: 'ex1' })
    const featureId = 'ex1'
    const isHovered = useSketchEditorStore.getState().hoveredBodyId === featureId
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

describe('Body3D click-promotes-hover contract', () => {
  it('toggling normalSelection with the hovered query promotes hover to selection', () => {
    const query = '?d,d;@extrude1face0:face'
    useSketchEditorStore.getState().setHoveredSurface(query)
    const { hoveredSurfaceId } = useSketchEditorStore.getState()
    if (hoveredSurfaceId) {
      useSketchEditorStore.getState().toggleNormalSelection(hoveredSurfaceId)
    }
    expect(useSketchEditorStore.getState().normalSelection.has(query)).toBe(true)
  })

  it('no hover means click does nothing to normalSelection', () => {
    // hoveredSurfaceId is null (cleared in beforeEach)
    const { hoveredSurfaceId } = useSketchEditorStore.getState()
    if (hoveredSurfaceId) {
      useSketchEditorStore.getState().toggleNormalSelection(hoveredSurfaceId)
    }
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
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

describe('Body3D hover 3D surface - store behavior', () => {
  it('setHovered3DSurface sets hovered3DSurfaceId', () => {
    useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBe('?d,d;@extrude1face0:face')
  })

  it('setHovered3DSurface(null) clears hovered3DSurfaceId', () => {
    useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
    useSketchEditorStore.getState().setHovered3DSurface(null)
    expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBeNull()
  })

  it('hovered3DSurfaceId is independent from hoveredSurfaceId', () => {
    useSketchEditorStore.getState().setHoveredSurface('face:sketch1:?3;@sketch1abc')
    useSketchEditorStore.getState().setHovered3DSurface('?d,d;@extrude1face0:face')
    expect(useSketchEditorStore.getState().hoveredSurfaceId).toBe('face:sketch1:?3;@sketch1abc')
    expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBe('?d,d;@extrude1face0:face')
  })

  it('click-promotes-hover uses hovered3DSurfaceId for 3D faces', () => {
    const query = '?d,d;@extrude1face0:face'
    useSketchEditorStore.getState().setHovered3DSurface(query)
    const { hovered3DSurfaceId } = useSketchEditorStore.getState()
    if (hovered3DSurfaceId) {
      useSketchEditorStore.getState().toggleNormalSelection(hovered3DSurfaceId)
    }
    expect(useSketchEditorStore.getState().normalSelection.has(query)).toBe(true)
  })
})

describe('Body3D selection - vertex visual highlight simulation', () => {
  it('simulates hasSelection check for STEP import with vertexQueries populated', () => {
    // This simulates the useFrame logic in Body3D.tsx
    const vertexQueries = ['?f;@import1vertex0:vertex', '?f;@import1vertex1:vertex']
    const vertices = [[0,0,0], [1,1,1]]  // Just 2 vertices for simplicity
    const featureId = 'body_import1'

    // Simulate clicking on vertex 0
    const clickQuery = vertexQueries[0]
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // Simulate the hasSelection check from useFrame
    const hasSelection = vertices.some((_, i) => {
      const query = vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`
      return useSketchEditorStore.getState().normalSelection.has(query)
    })

    // hasSelection should be true because vertexQueries[0] is selected
    expect(hasSelection).toBe(true)
  })

  it('simulates hasSelection check for STEP import with vertexQueries UNDEFINED', () => {
    // This is the bug scenario: if vertexQueries is undefined for some reason
    const vertexQueries = undefined as string[] | undefined
    const vertices = [[0,0,0], [1,1,1]]
    const featureId = 'body_import1'

    // User clicks - stores the fallback query
    const clickQuery = vertexQueries?.[0] ?? `@${featureId}/vertex/0`
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // hasSelection check - also uses fallback
    const hasSelection = vertices.some((_, i) => {
      const query = vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`
      return useSketchEditorStore.getState().normalSelection.has(query)
    })

    // Both use fallback, so should match and return true
    expect(clickQuery).toBe(`@${featureId}/vertex/0`)
    expect(hasSelection).toBe(true)
  })

  it('simulates visual highlight color assignment for STEP import', () => {
    // This simulates the color assignment logic in useFrame
    const vertexQueries = ['?f;@import1vertex0:vertex', '?f;@import1vertex1:vertex']
    const vertices = [[0,0,0], [1,1,1]]
    const featureId = 'body_import1'

    // Click on vertex 0
    const clickQuery = vertexQueries[0]
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // Check each vertex for visual highlight
    const highlightedVertices: number[] = []
    vertices.forEach((_, i) => {
      const query = vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`
      if (useSketchEditorStore.getState().normalSelection.has(query)) {
        highlightedVertices.push(i)
      }
    })

    // Vertex 0 should be highlighted, vertex 1 should not
    expect(highlightedVertices).toEqual([0])
  })

  it('verifies query format difference between featureId and createdBy', () => {
    // Correct query (using createdBy, as backend does)
    const correctQuery = '?f;@import1vertex0:vertex'

    // Wrong query (using bodyId, which is what featureId would be if set to bodyId)
    const wrongQuery = '@body_import1/vertex/0'

    useSketchEditorStore.getState().toggleNormalSelection(correctQuery)

    // If we check with the wrong query, it won't find the selection
    expect(useSketchEditorStore.getState().normalSelection.has(wrongQuery)).toBe(false)
    expect(useSketchEditorStore.getState().normalSelection.has(correctQuery)).toBe(true)
  })
})

describe('Body3D selection - vertex click-to-highlight flow', () => {
  it('simulates full click-to-highlight flow for STEP import', () => {
    // This simulates what Body3D.tsx does:
    // 1. Click handler stores query: vertexQueries?.[idx] ?? `@${featureId}/vertex/${idx}`
    // 2. Visual highlight checks: vertexQueries?.[i] ?? `@${featureId}/vertex/${i}`

    const vertexQueries = ['?f;@import1vertex0:vertex', '?f;@import1vertex1:vertex']
    const featureId = 'body_import1'  // bodyId (not createdBy)

    // Step 1: User clicks on vertex 0 (stores query in selection)
    const clickQuery = vertexQueries[0] ?? `@${featureId}/vertex/0`
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // Verify the query is stored
    expect(useSketchEditorStore.getState().normalSelection.has(clickQuery)).toBe(true)

    // Step 2: Visual highlight checks the same query
    const highlightQuery = vertexQueries[0] ?? `@${featureId}/vertex/0`
    const isHighlighted = useSketchEditorStore.getState().normalSelection.has(highlightQuery)

    // Both should use vertexQueries[0] since it's populated, so highlight should work
    expect(vertexQueries[0]).toBeDefined()
    expect(isHighlighted).toBe(true)
  })

  it('simulates full click-to-highlight flow for extrusion', () => {
    const vertexQueries = ['?b;@ex1vertex0:vertex', '?b;@ex1vertex1:vertex']
    const featureId = 'body_ex1'  // bodyId (not createdBy)

    // Step 1: User clicks on vertex 0
    const clickQuery = vertexQueries[0] ?? `@${featureId}/vertex/0`
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // Step 2: Visual highlight checks
    const highlightQuery = vertexQueries[0] ?? `@${featureId}/vertex/0`
    const isHighlighted = useSketchEditorStore.getState().normalSelection.has(highlightQuery)

    expect(vertexQueries[0]).toBeDefined()
    expect(isHighlighted).toBe(true)
  })

  it('simulates click-to-highlight flow when vertexQueries is UNDEFINED', () => {
    // This is the BUG case: if vertexQueries is undefined, both click and highlight
    // use the fallback format with bodyId, which should match

    const vertexQueries = undefined as string[] | undefined
    const featureId = 'body_import1'

    // Step 1: Click uses fallback
    const clickQuery = vertexQueries?.[0] ?? `@${featureId}/vertex/0`
    useSketchEditorStore.getState().toggleNormalSelection(clickQuery)

    // Step 2: Highlight also uses fallback
    const highlightQuery = vertexQueries?.[0] ?? `@${featureId}/vertex/0`

    // Both use the same fallback format, so should match
    expect(clickQuery).toBe(highlightQuery)
    expect(useSketchEditorStore.getState().normalSelection.has(highlightQuery)).toBe(true)
  })

  it('demonstrates the BUG: vertexQueries populated but query format mismatch', () => {
    // This test demonstrates what happens if vertexQueries is populated but
    // the query stored doesn't match what the highlight check looks for

    const vertexQueries = ['?f;@import1vertex0:vertex']  // Populated with ancestry query
    const featureId = 'body_import1'

    // If somehow the click handler stored the WRONG query (e.g., from a different body)
    const wrongQuery = '@body_ex1/vertex/0'  // Query from a different body
    useSketchEditorStore.getState().toggleNormalSelection(wrongQuery)

    // Visual highlight checks using vertexQueries
    const highlightQuery = vertexQueries[0] ?? `@${featureId}/vertex/0`

    // These don't match!
    expect(wrongQuery).not.toBe(highlightQuery)
    expect(useSketchEditorStore.getState().normalSelection.has(highlightQuery)).toBe(false)
  })
})

describe('Body3D selection - vertex queries', () => {
  it('toggleNormalSelection adds vertex query with ancestry format', () => {
    // Simulates query from backend: "?f;@import1vertex0:vertex"
    const query = '?f;@import1vertex0:vertex'
    useSketchEditorStore.getState().toggleNormalSelection(query)
    expect(useSketchEditorStore.getState().normalSelection.has(query)).toBe(true)
  })

  it('vertex query from STEP import matches selection check', () => {
    // Simulates what Body3D.tsx does for visual highlighting
    const vertexQueries = ['?f;@import1vertex0:vertex', '?f;@import1vertex1:vertex']

    // User clicks on vertex 0 - stores this query
    const storedQuery = vertexQueries[0]
    useSketchEditorStore.getState().toggleNormalSelection(storedQuery)

    // Visual highlight check uses same logic
    const checkQuery = vertexQueries[0]
    expect(useSketchEditorStore.getState().normalSelection.has(checkQuery)).toBe(true)
  })

  it('vertex query from extrusion matches selection check', () => {
    // Simulates what Body3D.tsx does for visual highlighting
    const vertexQueries = ['?b;@ex1vertex0:vertex', '?b;@ex1vertex1:vertex']

    // User clicks on vertex 0 - stores this query
    const storedQuery = vertexQueries[0]
    useSketchEditorStore.getState().toggleNormalSelection(storedQuery)

    // Visual highlight check uses same logic
    const checkQuery = vertexQueries[0]
    expect(useSketchEditorStore.getState().normalSelection.has(checkQuery)).toBe(true)
  })

  it('fallback query format does NOT match ancestry query', () => {
    // If vertexQueries is undefined, Body3D falls back to "@{featureId}/vertex/{idx}"
    const featureId = 'body_import1'  // bodyId
    const fallbackQuery = `@${featureId}/vertex/0`  // "@body_import1/vertex/0"
    const ancestryQuery = '?f;@import1vertex0:vertex'  // What backend generates

    useSketchEditorStore.getState().toggleNormalSelection(ancestryQuery)

    // The fallback query does NOT match the ancestry query
    expect(useSketchEditorStore.getState().normalSelection.has(fallbackQuery)).toBe(false)
    expect(useSketchEditorStore.getState().normalSelection.has(ancestryQuery)).toBe(true)
  })
})

describe('Body3D selection - pickChipHighlightItems', () => {
  it('isBodySelected returns true when body ref is in pickChipHighlightItems', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@body_ex1'] })
    const bodyId = 'body_ex1'
    const isSelected = useSketchEditorStore.getState().pickChipHighlightItems.includes('@' + bodyId)
    expect(isSelected).toBe(true)
  })

  it('isBodySelected returns false when body ref is not in pickChipHighlightItems', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@body_ex2'] })
    const bodyId = 'body_ex1'
    const isSelected = useSketchEditorStore.getState().pickChipHighlightItems.includes('@' + bodyId)
    expect(isSelected).toBe(false)
  })

  it('edge query in pickChipHighlightItems matches getIsEdgeSelected logic', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@ex1/edge/0', '@ex1/edge/2'] })
    const edgeQueries = ['@ex1/edge/0', '@ex1/edge/1', '@ex1/edge/2']

    const selectedEdges = edgeQueries.filter(q =>
      useSketchEditorStore.getState().pickChipHighlightItems.includes(q)
    )

    expect(selectedEdges).toEqual(['@ex1/edge/0', '@ex1/edge/2'])
  })

  it('edge query in pickChipHighlightItems uses fallback when edgeQueries is undefined', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['@ex1/edge/1'] })
    const featureId = 'ex1'
    const edgeIndex = 1

    const query = `@${featureId}/edge/${edgeIndex}`
    const isHighlighted = useSketchEditorStore.getState().pickChipHighlightItems.includes(query)

    expect(isHighlighted).toBe(true)
  })

  it('face query in pickChipHighlightItems matches resolveFaceQuery output', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['?body_ex1/face/0', '?body_ex1/face/2'] })
    const faceQueries = ['?body_ex1/face/0', '?body_ex1/face/1', '?body_ex1/face/2']

    const selectedFaces = faceQueries.filter(q =>
      useSketchEditorStore.getState().pickChipHighlightItems.includes(q)
    )

    expect(selectedFaces).toEqual(['?body_ex1/face/0', '?body_ex1/face/2'])
  })

  it('face boundary overlay renders for chip-highlighted face queries', () => {
    useSketchEditorStore.setState({ pickChipHighlightItems: ['?f0'] })
    const faceBoundaryKeys = ['?f0', '?f1', '?f2', '?f3', '?f4', '?f5']

    const matchingQueries = [...new Set([...useSketchEditorStore.getState().normalSelection, ...useSketchEditorStore.getState().pickChipHighlightItems])]
      .filter(q => faceBoundaryKeys.includes(q))

    expect(matchingQueries).toEqual(['?f0'])
  })

  it('mixed normalSelection and pickChipHighlightItems deduplicates correctly', () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(['@body_ex1', '@ex1/edge/0']),
      pickChipHighlightItems: ['@ex1/edge/0', '@ex1/edge/1'],
    })

    const combined = new Set([...useSketchEditorStore.getState().normalSelection, ...useSketchEditorStore.getState().pickChipHighlightItems])
    expect(combined.has('@body_ex1')).toBe(true)
    expect(combined.has('@ex1/edge/0')).toBe(true)
    expect(combined.has('@ex1/edge/1')).toBe(true)
    expect(combined.size).toBe(3)
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
