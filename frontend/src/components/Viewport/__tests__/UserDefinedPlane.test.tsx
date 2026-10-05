import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { PlaneTransform } from '@/types/cad'
import UserDefinedPlane from '../UserDefinedPlane'

/**
 * UserDefinedPlane converts the solver's plane transform to an Euler triple for
 * PlaneBody. That conversion allocates a Matrix4 and an Euler, so it must be
 * keyed on the plane's value and must not re-run merely because the parent
 * re-rendered with an equal-valued fresh transform.
 */

const seams = vi.hoisted(() => ({
  bodyProps: vi.fn(),
}))

vi.mock('@/components/Viewport/PlaneBody', () => ({
  default: (props: Record<string, unknown>) => { seams.bodyProps(props); return null },
}))

function transform(origin: [number, number, number]): PlaneTransform {
  return {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    origin,
  }
}

beforeEach(() => {
  seams.bodyProps.mockClear()
})

describe('UserDefinedPlane', () => {
  it('places the body at the transform origin with its selection id', () => {
    render(<UserDefinedPlane featureId="F1" label="Plane 1" planeTransform={transform([1, 2, 3])} />)
    expect(seams.bodyProps.mock.calls.at(-1)![0]).toMatchObject({
      selId: '@F1', origin: [1, 2, 3], label: 'Plane 1',
    })
  })

  it('reuses the rotation array across an equal-valued fresh transform', () => {
    const { rerender } = render(
      <UserDefinedPlane featureId="F1" label="P" planeTransform={transform([1, 2, 3])} />
    )
    const firstRotation = seams.bodyProps.mock.calls.at(-1)![0].rotation

    rerender(
      <UserDefinedPlane featureId="F1" label="P" planeTransform={transform([1, 2, 3])} />
    )

    expect(seams.bodyProps.mock.calls.at(-1)![0].rotation).toBe(firstRotation)
  })

  it('rebuilds the rotation when the plane actually moves', () => {
    const { rerender } = render(
      <UserDefinedPlane featureId="F1" label="P" planeTransform={transform([0, 0, 0])} />
    )
    const firstRotation = seams.bodyProps.mock.calls.at(-1)![0].rotation

    rerender(
      <UserDefinedPlane featureId="F1" label="P" planeTransform={transform([5, 0, 0])} />
    )

    expect(seams.bodyProps.mock.calls.at(-1)![0].rotation).not.toBe(firstRotation)
  })
})
