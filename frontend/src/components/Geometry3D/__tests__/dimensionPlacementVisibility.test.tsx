import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Constraints, Mutation, Sketch } from '@/types/cad'
import { setSketchCallback, useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { resetDimensionLabelDomBoxesForTest } from '@/picking/dimensionLabelDom'

// The reported bug: the placement click opened the value prompt over an empty
// canvas because it cleared the picks (and with them the ghost preview) before
// the constraint existed. Now the click inserts the dimension first, so the real
// label is on screen while the prompt is open, and the ghost hands over to it.
// This renders the real dimension overlay (only its R3F primitives are stubbed)
// for the constraint the insert created.

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: {}, size: { width: 800, height: 600 }, invalidate: () => {} }),
  useFrame: () => {},
}))

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => null,
}))

vi.mock('@/components/Geometry3D/dimensions/primitives', () => ({
  Arrowhead: () => null,
  ArrowTail: () => null,
  ExtensionLine: () => null,
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

const sketch: Sketch = {
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
}

describe('a placed dimension stays visible while its editor is open', () => {
  beforeEach(() => {
    resetDimensionLabelDomBoxesForTest()
    useSketchUiStore.setState({ pendingDialog: null })
    useEditorState.setState({
      activeTool: 'dimension',
      activeFeatureId: 'S1',
      activeOriginLocal: [0, 0],
      dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
    })
  })

  afterEach(() => {
    setSketchCallback('onMutation', null)
    setSketchCallback('getSketch', null)
    setSketchCallback('commitPlacement', null)
    setSketchCallback('cancelPlacement', null)
  })

  it('inserts on the click, and the inserted label renders under the prompt', () => {
    const mutations: Mutation[] = []
    setSketchCallback('onMutation', m => { mutations.push(m) })
    setSketchCallback('getSketch', () => sketch)
    useSketchEditorStore.getState().finalizeDimensionPlacement([120, 140])

    // The dimension already exists: one insert, and the prompt is open for it.
    const insert = mutations[0] as Extract<Mutation, { type: 'add_constraint' }>
    expect(insert.type).toBe('add_constraint')
    expect(insert.id).toEqual(expect.any(String))
    expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
    // The ghost's picks are gone because the real dimension replaced them.
    expect(useSketchEditorStore.getState().dimensionPicks).toEqual([])

    // The solve's write-back carries the inserted constraint; the label paints
    // at its measured 10 while the prompt is still open.
    const constraints: Constraints = {
      [insert.id!]: {
        render: { kind: 'dim_linear', dimKind: 'length', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 },
        residual: 0,
      } as Constraints[string],
    }
    render(
      <ConstraintOverlays
        constraints={constraints}
        sketch={sketch}
        extent={10}
        featureId="S1"
        authoredConstraints={[{
          id: insert.id!, kind: 'length', target: '$L1', value: 10,
          ...(insert.pos && { pos: insert.pos }),
        }]}
      />,
    )

    expect(screen.getByText('10')).toBeInTheDocument()
    expect(useSketchUiStore.getState().pendingDialog).not.toBeNull()
  })
})
