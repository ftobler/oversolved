// usePlaneIdRegistration turns a plane's transform + size into the two world-
// space triangles the planeFace ID layer rasterizes. The geometry must match
// the drawn plane exactly or picks would resolve to the wrong surface, so the
// known-input-to-known-output corner transform is pinned here. The existing
// helperHookRegisterThrow test covers only the registerBody-throw path.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Mesh } from 'three'
import { IdPipeline, PLANE_LAYER_NAME } from '../IdPipeline'
import { setLivePipeline } from '../IdPipelineContext'
import { usePlaneIdRegistration } from '../usePlaneIdRegistration'

function livePipeline(): IdPipeline {
  const p = new IdPipeline({ width: 64, height: 64 })
  setLivePipeline(p)
  return p
}

function planePositions(p: IdPipeline): number[] {
  const mesh = p.planeLayer.scene.children[0] as Mesh
  return Array.from(mesh.geometry.getAttribute('position').array as ArrayLike<number>)
}

describe('usePlaneIdRegistration', () => {
  afterEach(() => {
    setLivePipeline(null)
    vi.restoreAllMocks()
  })

  it('registers the two triangles in world space for an identity plane', () => {
    const p = livePipeline()
    const { unmount } = renderHook(() =>
      usePlaneIdRegistration({ selectionId: '@builtin_plane_top', size: 2 }),
    )

    expect(p.planeLayer.bodyCount()).toBe(1)
    // Corners at +/- half, wound (-,-) (+,-) (+,+) then (-,-) (+,+) (-,+).
    expect(planePositions(p)).toEqual([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,
      -1, -1, 0,  1, 1, 0,  -1, 1, 0,
    ])
    const id = p.registry.lookupKey(PLANE_LAYER_NAME, '@builtin_plane_top')
    expect(id).toBeDefined()
    expect(p.registry.lookup(id!)?.entityKey).toBe('@builtin_plane_top')

    unmount()
    p.dispose()
  })

  it('rotates the corners by the supplied Euler rotation', () => {
    const p = livePipeline()
    const { unmount } = renderHook(() =>
      usePlaneIdRegistration({ selectionId: '@p', size: 2, rotation: [0, 0, Math.PI / 2] }),
    )

    // A +90deg rotation about Z maps (x, y) to (-y, x).
    const pos = planePositions(p)
    const expected = [
      1, -1, 0,  1, 1, 0,  -1, 1, 0,
      1, -1, 0,  -1, 1, 0,  -1, -1, 0,
    ]
    expected.forEach((value, i) => expect(pos[i], `index ${i}`).toBeCloseTo(value, 10))

    unmount()
    p.dispose()
  })

  it('translates the corners by the supplied origin', () => {
    const p = livePipeline()
    const { unmount } = renderHook(() =>
      usePlaneIdRegistration({ selectionId: '@p', size: 2, origin: [10, 20, 30] }),
    )

    expect(planePositions(p)).toEqual([
      9, 19, 30,  11, 19, 30,  11, 21, 30,
      9, 19, 30,  11, 21, 30,  9, 21, 30,
    ])

    unmount()
    p.dispose()
  })

  it('does not register while disabled and registers when re-enabled', () => {
    const p = livePipeline()
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePlaneIdRegistration({ selectionId: '@p', size: 2, enabled }),
      { initialProps: { enabled: false } },
    )

    expect(p.planeLayer.bodyCount()).toBe(0)

    rerender({ enabled: true })
    expect(p.planeLayer.bodyCount()).toBe(1)

    unmount()
    p.dispose()
  })

  it('unregisters on unmount', () => {
    const p = livePipeline()
    const { unmount } = renderHook(() =>
      usePlaneIdRegistration({ selectionId: '@p', size: 2 }),
    )
    expect(p.planeLayer.bodyCount()).toBe(1)

    unmount()
    expect(p.planeLayer.bodyCount()).toBe(0)

    p.dispose()
  })
})
