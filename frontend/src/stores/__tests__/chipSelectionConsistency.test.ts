/**
 * The chip actions are selection mutators like any other, so they owe the same
 * bookkeeping every other mutator does: a derived `selectionDomain` and no
 * `selectedPicks` claim left behind by an evicted query. Before this was
 * enforced, a chip sync could leave the domain reading `sketch_2d` while the
 * selection had become pure `body_3d`, and an evicted query's pickKeys survived
 * to resurrect as ghost highlights.
 *
 * See feature/chip-selection-consistency.md.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { deriveSelectionDomain, validateSelectionState } from '@/stores/stateInvariants'
import { initializeTools } from '@/tools'

let toolsInitialized = false

beforeAll(() => {
  if (!toolsInitialized) {
    initializeTools()
    toolsInitialized = true
  }
})

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    activeTool: null,
    activePickField: null,
    dimensionPicks: [],
    drawPoints: [],
    drawHover: null,
    modeStack: [],
  })
})

/** The invariant under test, asserted against live store state. */
function expectConsistent(): void {
  const s = useSketchEditorStore.getState()
  expect(s.selectionDomain).toBe(deriveSelectionDomain(s.normalSelection))
  expect(() => validateSelectionState(s)).not.toThrow()
}

describe('syncChipSelection keeps the selection bookkeeping consistent', () => {
  it('derives the domain when a chip introduces a 3D query', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    expectConsistent()
  })

  it('derives the domain when a chip introduces a plane query', () => {
    useSketchEditorStore.getState().syncChipSelection(['@builtin_plane_top'])
    expect(useSketchEditorStore.getState().selectionDomain).toBe('plane_3d')
    expectConsistent()
  })

  it('re-derives the domain when the chip diff evicts the last 3D query', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    useSketchEditorStore.getState().syncChipSelection([])
    expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    expectConsistent()
  })

  it('mixes with a pre-existing sketch selection', () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(['entity:sk1:line1']),
      selectionDomain: 'sketch_2d',
    })
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/edge/2'])
    expect(useSketchEditorStore.getState().selectionDomain).toBe('mixed')
    expectConsistent()
  })

  it('drops the pick claims of a query the chip diff evicted', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0', '@body_ex1/face/1'])
    useSketchEditorStore.setState({
      selectedPicks: new Map([
        ['@body_ex1/face/0', new Set(['ex1/b0#face#0'])],
        ['@body_ex1/face/1', new Set(['ex1/b0#face#1'])],
      ]),
    })

    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/1'])

    const picks = useSketchEditorStore.getState().selectedPicks
    expect([...picks.keys()]).toEqual(['@body_ex1/face/1'])
    expectConsistent()
  })

  it('keeps the claims of queries the chip never owned', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1/face/1', 'ex1/b0#face#1')
    const claims = useSketchEditorStore.getState().selectedPicks
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    useSketchEditorStore.getState().syncChipSelection([])

    // The chip only ever evicts what it put in, so a viewport-selected query and
    // its claim must ride out the whole chip lifecycle. The map is not even
    // rebuilt: a needless new reference would wake every claim subscriber on
    // each chip sync.
    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.has('@body_ex1/face/1')).toBe(true)
    expect(s.selectedPicks.get('@body_ex1/face/1')).toEqual(new Set(['ex1/b0#face#1']))
    expect(s.selectedPicks).toBe(claims)
    expectConsistent()
  })

  it('leaves an empty selectedPicks referentially unchanged', () => {
    const before = useSketchEditorStore.getState().selectedPicks
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    expect(useSketchEditorStore.getState().selectedPicks).toBe(before)
  })
})

describe('clearChipSelection keeps the selection bookkeeping consistent', () => {
  it('resets the domain when the chip owned the whole selection', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    useSketchEditorStore.getState().clearChipSelection()
    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    expectConsistent()
  })

  it('re-derives the domain down to what survives the clear', () => {
    useSketchEditorStore.setState({
      normalSelection: new Set(['entity:sk1:line1']),
      selectionDomain: 'sketch_2d',
    })
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/edge/2'])
    useSketchEditorStore.getState().clearChipSelection()
    expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    expectConsistent()
  })

  it('drops the claims of every query it evicts', () => {
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/face/0'])
    useSketchEditorStore.setState({
      selectedPicks: new Map([['@body_ex1/face/0', new Set(['ex1/b0#face#0'])]]),
    })

    useSketchEditorStore.getState().clearChipSelection()

    expect(useSketchEditorStore.getState().selectedPicks.size).toBe(0)
    expectConsistent()
  })
})

describe('setActiveTool derives the domain it clears', () => {
  it('entering the dimension tool empties the selection and resets the domain', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1/face/0')
    expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')

    useSketchEditorStore.getState().setActiveTool('dimension')

    expect(useSketchEditorStore.getState().normalSelection.size).toBe(0)
    expect(useSketchEditorStore.getState().selectionDomain).toBe('sketch_2d')
    expectConsistent()
  })

  it('entering a tool mid-pick drops the chip mirror and resets the domain', () => {
    useSketchEditorStore.getState().setActivePickField({ featureId: 'ex1', field: 'edges', multi: true })
    useSketchEditorStore.getState().syncChipSelection(['@body_ex1/edge/2'])
    expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')

    useSketchEditorStore.getState().setActiveTool('line')

    const s = useSketchEditorStore.getState()
    expect(s.normalSelection.size).toBe(0)
    expect(s.chipOwnedSelection.size).toBe(0)
    expect(s.selectionDomain).toBe('sketch_2d')
    expectConsistent()
  })

  it('leaves a selection a tool does not clear alone', () => {
    useSketchEditorStore.getState().toggleNormalSelection('@body_ex1/face/0')
    useSketchEditorStore.getState().setActiveTool('line')
    expect(useSketchEditorStore.getState().normalSelection.has('@body_ex1/face/0')).toBe(true)
    expect(useSketchEditorStore.getState().selectionDomain).toBe('body_3d')
    expectConsistent()
  })
})
