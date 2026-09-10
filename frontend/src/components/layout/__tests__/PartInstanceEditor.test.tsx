// The rotation row is the only orientation control an instance carrying the
// `fixed` flag has (the triad gizmo is refused for one), so these tests guard
// that it exists, commits degrees, and does not fight the typist.

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
      onSetFixed={vi.fn()}
      onSetPosition={vi.fn()}
      onSetRotation={onSetRotation}
    />
  )
  return { onSetRotation, ...utils }
}

const rotBox = (axis: 'X' | 'Y' | 'Z') =>
  screen.getByLabelText(`Rotation ${axis}`) as HTMLInputElement

describe('PartInstanceEditor rotation', () => {
  it('renders a rotation box per axis, alongside the position boxes', () => {
    renderEditor(instance())
    for (const axis of ['X', 'Y', 'Z'] as const) expect(rotBox(axis)).toBeTruthy()
    expect(screen.getByLabelText('Position X')).toBeTruthy()
  })

  it('offers the rotation boxes for a FIXED instance (the gizmo will not)', () => {
    renderEditor(instance({ fixed: true }))
    expect(rotBox('Z')).toBeTruthy()
    expect((rotBox('Z') as HTMLInputElement).disabled).toBe(false)
  })

  it('commits the typed degrees on every axis', () => {
    const { onSetRotation } = renderEditor(instance())
    fireEvent.change(rotBox('Z'), { target: { value: '90' } })
    expect(onSetRotation).toHaveBeenCalledWith({ rx: 0, ry: 0, rz: 90 })
    fireEvent.change(rotBox('X'), { target: { value: '45' } })
    // The RZ the user already typed is carried, not dropped.
    expect(onSetRotation).toHaveBeenLastCalledWith({ rx: 45, ry: 0, rz: 90 })
  })

  it('shows the instance orientation as degrees', () => {
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI / 2])
    renderEditor(instance({ transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }))
    expect(Number(rotBox('Z').value)).toBeCloseTo(90, 3)
  })

  it('waits for a complete number instead of committing a bare minus sign', () => {
    const { onSetRotation } = renderEditor(instance())
    // `<input type="number">` reports an incomplete number as '' rather than
    // holding the raw text, so the guard, not the box, is what is under test.
    fireEvent.change(rotBox('X'), { target: { value: '-' } })
    expect(onSetRotation).not.toHaveBeenCalled()
  })

  it('still reads the typed angle back after the parent echoes the quaternion', () => {
    // The commit updates the doc, which re-renders this editor with the new
    // quaternion. Degrees are re-derived from it, so the box must still show
    // the number the user typed rather than a rounding artefact of the round
    // trip through the quaternion.
    const inst = instance()
    const { rerender } = renderEditor(inst)
    fireEvent.change(rotBox('Y'), { target: { value: '30' } })
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, (30 * Math.PI) / 180, 0])
    rerender(
      <PartInstanceEditor
        instance={{ ...inst, transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }}
        onSetFixed={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={vi.fn()}
      />
    )
    expect(rotBox('Y').value).toBe('30')
  })

  it('resyncs the boxes when the orientation changes from elsewhere (gizmo, undo)', () => {
    const inst = instance()
    const { rerender } = renderEditor(inst)
    expect(Number(rotBox('Z').value)).toBeCloseTo(0, 3)
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI])
    rerender(
      <PartInstanceEditor
        instance={{ ...inst, transform: { ...IDENTITY_TRANSFORM, qx, qy, qz, qw } }}
        onSetFixed={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={vi.fn()}
      />
    )
    expect(Math.abs(Number(rotBox('Z').value))).toBeCloseTo(180, 3)
  })
})

describe('PartInstanceEditor pose basis', () => {
  // The viewport draws the solved pose while `instance.transform` is only the
  // placement seed. A position edit must carry the other two axes from the
  // drawn pose, not the seed, or it writes the seed back over the bake.
  it('shows the drawn pose and commits the other axes from it', () => {
    const onSetPosition = vi.fn()
    const pose = { ...IDENTITY_TRANSFORM, tx: 10, ty: 20, tz: 30 }
    render(
      <PartInstanceEditor
        instance={instance()}
        pose={pose}
        onSetFixed={vi.fn()}
        onSetPosition={onSetPosition}
        onSetRotation={vi.fn()}
      />
    )
    expect((screen.getByLabelText('Position Y') as HTMLInputElement).value).toBe('20')
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '5' } })
    expect(onSetPosition).toHaveBeenCalledWith({ tx: 5, ty: 20, tz: 30 })
  })

  it('derives the rotation boxes from the drawn pose and carries its other axes', () => {
    const onSetRotation = vi.fn()
    const [qx, qy, qz, qw] = quatFromEulerXyz([0, 0, Math.PI / 2])
    const pose = { ...IDENTITY_TRANSFORM, qx, qy, qz, qw }
    render(
      <PartInstanceEditor
        instance={instance()}
        pose={pose}
        onSetFixed={vi.fn()}
        onSetPosition={vi.fn()}
        onSetRotation={onSetRotation}
      />
    )
    expect(Number(rotBox('Z').value)).toBeCloseTo(90, 3)
    fireEvent.change(rotBox('X'), { target: { value: '45' } })
    expect(onSetRotation).toHaveBeenCalledWith({ rx: 45, ry: 0, rz: 90 })
  })
})
