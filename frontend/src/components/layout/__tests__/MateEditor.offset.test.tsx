// The mate offset control. `offset` widened from a scalar to a 3D vector in
// body A's local frame, and the editor kept rendering it through the generic
// numeric branch -- which reads a number or nothing, so every vector-valued
// offset drew a BLANK box over a live constraint. These pin the control the
// widening needs: three boxes that author the `{x, y, z}` object, a single box
// wherever the solver reduces the offset to one distance, and a presentation for
// the legacy scalar form that does not invent components it cannot know.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MateEditor } from '@/components/layout/MateEditor'
import type { MateFeatureDef } from '@/types/cad'

function mate(overrides: Partial<MateFeatureDef> = {}): MateFeatureDef {
  return {
    kind: 'fixed',
    ref_a: { part: 'h1', anchor: 'a1' },
    ref_b: { part: 'h2', anchor: 'b1' },
    ...overrides,
  }
}

function editor(m: MateFeatureDef, onUpdate = vi.fn(), featureId = 'm1') {
  return (
    <MateEditor
      featureId={featureId}
      mate={m}
      activeField={null}
      onArmField={vi.fn()}
      onUpdate={onUpdate}
    />
  )
}

function renderEditor(m: MateFeatureDef, onUpdate = vi.fn()) {
  return { onUpdate, ...render(editor(m, onUpdate)) }
}

const box = (axis: 'X' | 'Y' | 'Z') =>
  screen.getByLabelText(`Offset ${axis}`) as HTMLInputElement
const scalarBox = () => screen.getByLabelText('Offset') as HTMLInputElement

describe('MateEditor offset vector', () => {
  it('shows a box per axis for a fixed mate', () => {
    renderEditor(mate())
    for (const axis of ['X', 'Y', 'Z'] as const) expect(box(axis)).toBeTruthy()
  })

  it('renders an authored vector rather than a blank box', () => {
    // The bug itself: `numericValue` returned '' for the object form, so a mate
    // holding a real offset looked unset.
    renderEditor(mate({ offset: { x: 1, y: 2, z: 3 } }))
    expect([box('X').value, box('Y').value, box('Z').value]).toEqual(['1', '2', '3'])
  })

  it('reads a partially authored vector, treating the absent components as unset', () => {
    renderEditor(mate({ offset: { y: 4 } }))
    expect([box('X').value, box('Y').value, box('Z').value]).toEqual(['', '4', ''])
  })

  it('writes the object form when a component is typed', () => {
    const { onUpdate } = renderEditor(mate())
    fireEvent.change(box('Y'), { target: { value: '5' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: { y: 5 } })
  })

  it('carries the components already typed when another axis is edited', () => {
    const { onUpdate } = renderEditor(mate())
    fireEvent.change(box('X'), { target: { value: '1' } })
    fireEvent.change(box('Z'), { target: { value: '3' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: { x: 1, z: 3 } })
  })

  it('omits an emptied component rather than authoring a zero', () => {
    const { onUpdate } = renderEditor(mate({ offset: { x: 1, y: 2 } }))
    fireEvent.change(box('X'), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: { y: 2 } })
  })

  it('unsets the offset entirely when the last component is cleared', () => {
    // `updateMate` deletes a key whose patch value is undefined, so this is what
    // keeps the YAML clean instead of leaving `offset: {x: 0, y: 0, z: 0}`.
    const { onUpdate } = renderEditor(mate({ offset: { z: 7 } }))
    fireEvent.change(box('Z'), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: undefined })
  })

  it('authors an explicit zero when the user actually types one', () => {
    // Only an EMPTY box means "unset"; a typed 0 is a value the user chose, and
    // silently dropping it would fight the typist on the next keystroke.
    const { onUpdate } = renderEditor(mate())
    fireEvent.change(box('X'), { target: { value: '0' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: { x: 0 } })
  })
})

describe('MateEditor offset dirty text', () => {
  it('keeps what is typed when the mate re-renders without the offset changing', () => {
    // The parent re-renders for reasons of its own (a chip armed, a solve
    // result arriving). Without the dirty-text discipline the box would snap
    // back to the committed value mid-entry.
    const m = mate()
    const { rerender } = renderEditor(m)
    fireEvent.change(box('X'), { target: { value: '5' } })
    rerender(editor(m))
    expect(box('X').value).toBe('5')
  })

  it('follows the document when the offset changes from elsewhere', () => {
    const { rerender } = renderEditor(mate())
    fireEvent.change(box('X'), { target: { value: '5' } })
    rerender(editor(mate({ offset: { x: 9 } })))
    expect(box('X').value).toBe('9')
  })

  it('resyncs when a different mate is selected', () => {
    // Two mates can hold identical offsets, so the identity has to be part of
    // what the boxes key their resync on, not just the numbers.
    const { rerender } = renderEditor(mate({ offset: { x: 2 } }))
    fireEvent.change(box('X'), { target: { value: '5' } })
    rerender(editor(mate({ offset: { x: 2 } }), vi.fn(), 'm2'))
    expect(box('X').value).toBe('2')
  })
})

describe('MateEditor legacy scalar offset', () => {
  // The chosen presentation: a bare number means "this distance along A's anchor
  // axis", and that axis is resolved inside the solve. The editor cannot
  // decompose it without inventing an axis, and an invented axis moves the part
  // -- so the scalar keeps its own single box and the user converts by clearing.
  it('shows the authored number instead of a blank or zeroed triple', () => {
    renderEditor(mate({ offset: 12 }))
    expect(scalarBox().value).toBe('12')
    expect(screen.queryByLabelText('Offset X')).toBeNull()
  })

  it('says what the scalar means and how to convert it', () => {
    renderEditor(mate({ offset: 12 }))
    expect(screen.getByText(/Clear the box to author X\/Y\/Z/)).toBeTruthy()
  })

  it('stays a scalar while it is edited as one', () => {
    const { onUpdate } = renderEditor(mate({ offset: 12 }))
    fireEvent.change(scalarBox(), { target: { value: '15' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: 15 })
  })

  it('unsets the offset when cleared, handing the row to the vector boxes', () => {
    const { onUpdate, rerender } = renderEditor(mate({ offset: 12 }))
    fireEvent.change(scalarBox(), { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ offset: undefined })
    rerender(editor(mate()))
    expect(box('X')).toBeTruthy()
  })
})

describe('MateEditor axial-only offset kinds', () => {
  // Tangential and ParallelPlaneDistance read `Mate::axial_offset()`: one signed
  // distance along A's axis. Three boxes would promise two components that
  // provably do nothing.
  for (const kind of ['tangential', 'parallel_plane_distance'] as const) {
    it(`gives ${kind} a single box, not a triple`, () => {
      renderEditor(mate({ kind }))
      expect(scalarBox()).toBeTruthy()
      expect(screen.queryByLabelText('Offset X')).toBeNull()
      expect(screen.getByText(/Signed distance along A's axis/)).toBeTruthy()
    })

    it(`writes a scalar for ${kind}`, () => {
      const { onUpdate } = renderEditor(mate({ kind }))
      fireEvent.change(scalarBox(), { target: { value: '3' } })
      expect(onUpdate).toHaveBeenLastCalledWith({ offset: 3 })
    })
  }

  it('still shows a vector authored on an axial kind, and says what is read', () => {
    // Reachable by switching a fixed mate's kind, or by hand-editing the YAML.
    // Blanking the boxes would hide data the document holds, so they stay
    // editable and the hint carries the truth instead.
    renderEditor(mate({ kind: 'tangential', offset: { x: 1, y: 2 } }))
    expect(box('Y').value).toBe('2')
    expect(screen.getByText(/Only the component along A's axis is used/)).toBeTruthy()
  })
})
