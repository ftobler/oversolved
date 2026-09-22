import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import type { EdgeCurve } from '@/kernel/partBundle'
import AssemblyBody from '../AssemblyBody'

/**
 * AssemblyBody's only interaction logic is the grab guard: a non-primary
 * button, a ctrl-click, or any click while a mate reference is armed must not
 * grab (drag) the part. The last two are the same gesture the mate picker
 * consumes, so grabbing here would drag the part away from the anchor the user
 * was aiming at.
 */

vi.mock('@/components/Geometry3D/bodyGeometry', () => ({
  buildBodyGeometry: () => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }),
}))

vi.mock('@/utils/edgeSampling', () => ({
  buildCurveSegments: () => new Float32Array(0),
}))

function makeItem(): BodyRenderItem {
  return {
    key: 'b1', featureId: 'F1', bodyId: 'b1',
    mesh: {} as BodyRenderItem['mesh'],
    edges: [], visible: true,
  }
}

function renderBody(overrides: { aiming?: boolean; selected?: boolean } = {}) {
  const onGrab = vi.fn()
  const { container } = render(
    <AssemblyBody
      item={makeItem()}
      curves={[] as EdgeCurve[]}
      selected={overrides.selected ?? false}
      aiming={overrides.aiming ?? false}
      onGrab={onGrab}
    />,
  )
  const mesh = container.querySelector('mesh')!
  return { container, mesh, onGrab }
}

describe('AssemblyBody grab guard', () => {
  it('renders the body mesh', () => {
    const { mesh } = renderBody()
    expect(mesh).not.toBeNull()
  })

  it('ignores a non-primary button', () => {
    const { mesh, onGrab } = renderBody()
    fireEvent.pointerDown(mesh, { button: 2 })
    expect(onGrab).not.toHaveBeenCalled()
  })

  it('ignores a ctrl-click (it aims a mate reference instead)', () => {
    const { mesh, onGrab } = renderBody()
    fireEvent.pointerDown(mesh, { button: 0, ctrlKey: true })
    expect(onGrab).not.toHaveBeenCalled()
  })

  it('ignores a primary click while a mate slot is armed', () => {
    const { mesh, onGrab } = renderBody({ aiming: true })
    fireEvent.pointerDown(mesh, { button: 0 })
    expect(onGrab).not.toHaveBeenCalled()
  })
})
