// The rotation row is the only orientation control a grounded part has (the
// triad gizmo is refused for a `fixed` instance), so these tests guard that it
// exists, commits degrees, and does not fight the typist.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import type { PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM, quatFromEulerXyz } from '@/utils/transform3d'

function instance(overrides: Partial<PartInstance> = {}): PartInstance {
  return {
    handle: 'h1',
    doc_id: 'doc-A',
    doc_rev: 1,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
    ...overrides,
  }
}

function renderEditor(inst: PartInstance, onSetRotation = vi.fn()) {
  const utils = render(
    <PartInstanceEditor
      instance={inst}
      onSetGrounded={vi.fn()}
      onSetPosition={vi.fn()}
      onSetRotation={onSetRotation}
    />
  )
  return { onSetRotation, ...utils }
}

const rotBox = (axis: 'RX' | 'RY' | 'RZ') =>
  screen.getByLabelText(`Rotation ${axis}`) as HTMLInputElement

describe('PartInstanceEditor rotation', () => {
  it('renders a rotation box per axis, alongside the position boxes', () => {
    renderEditor(instance())
    for (const axis of ['RX', 'RY', 'RZ'] as const) expect(rotBox(axis)).toBeTruthy()
    expect(screen.getByLabelText('Position X')).toBeTruthy()
  })

  it('offers the rotation boxes for a GROUNDED instance (the gizmo will not)', () => {
    renderEditor(instance({ fixed: true }))
    expect(rotBox('RZ')).toBeTruthy()
    expect((rotBox('RZ') as HTMLInputElement).disabled).toBe(false)
  })

  it('commits the typed degrees on every axis', () => {
    const { onSetRotation } = renderEditor(instance())
    fireEvent.change(rotBox('RZ'), { target: { value: '90' } })
    expect(onSetRotation).toHaveBeenCalledWith({ rx: 0, ry: 0, rz: 90 })
    fireEvent.change(rotBox('RX'), { target: { value: '45' } })
    // The RZ the user already typed is carried, not dropped.
    expect(onSetRotation).toHaveBeenLastCalledWith({ rx: 45, ry: 0, rz: 90 })
  })

  it('shows the instance orientation as degrees', () => {
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI / 2])
    renderEditor(instance({ transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }))
    expect(Number(rotBox('RZ').value)).toBeCloseTo(90, 3)
  })

  it('waits for a complete number instead of committing a bare minus sign', () => {
    const { onSetRotation } = renderEditor(instance())
    // `<input type="number">` reports an incomplete number as '' rather than
    // holding the raw text, so the guard, not the box, is what is under test.
    fireEvent.change(rotBox('RX'), { target: { value: '-' } })
    expect(onSetRotation).not.toHaveBeenCalled()
  })

  it('still reads the typed angle back after the parent echoes the quaternion', () => {
    // The commit updates the doc, which re-renders this editor with the new
    // quaternion. Degrees are re-derived from it, so the box must still show
    // the number the user typed rather than a rounding artefact of the round
    // trip through the quaternion.
    const inst = instance()
    const { rerender } = renderEditor(inst)
    fireEvent.change(rotBox('RY'), { target: { value: '30' } })
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, (30 * Math.PI) / 180, 0])
    rerender(
      <PartInstanceEditor
        instance={{ ...inst, transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }}
        onSetGrounded={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={vi.fn()}
      />
    )
    expect(rotBox('RY').value).toBe('30')
  })

  it('resyncs the boxes when the orientation changes from elsewhere (gizmo, undo)', () => {
    const inst = instance()
    const { rerender } = renderEditor(inst)
    expect(Number(rotBox('RZ').value)).toBeCloseTo(0, 3)
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI])
    rerender(
      <PartInstanceEditor
        instance={{ ...inst, transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }}
        onSetGrounded={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={vi.fn()}
      />
    )
    expect(Math.abs(Number(rotBox('RZ').value))).toBeCloseTo(180, 3)
  })
})
