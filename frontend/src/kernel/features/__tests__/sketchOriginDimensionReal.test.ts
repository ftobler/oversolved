// @vitest-environment node
//
// A dimension against `@builtin_origin` on a face sketch must draw at the
// document origin expressed in that sketch's frame, not at the plane's own
// local (0,0) and not as the generic unrenderable tile. The solve already
// carries `originLocal`; this pins the render half to it end to end.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { frameFromPlaneTransform, projectWorldToFrame } from '../../types3d'
import { extrudeTestHarness, extrudeSpec, rectSketchSk, oc, solveBytes } from '../extrudeRealSupport'

type Dict = Record<string, unknown>

interface FaceDatum {
  centroid: number[]
  normal?: number[]
  surface_type?: string
}

interface FaceMesh {
  face_queries?: string[]
  face_data?: FaceDatum[]
}

/** The ancestry query of the flat face pointing along +z (the extrusion cap). */
function topFaceQuery(mesh: FaceMesh): string {
  const index = mesh.face_data?.findIndex(
    (fd) => fd.surface_type === 'flatface' && (fd.normal?.[2] ?? 0) > 0.99,
  ) ?? -1
  if (index < 0) throw new Error('no +z flat face in the extruded plate')
  const query = mesh.face_queries?.[index]
  if (!query) throw new Error('face query missing for the +z cap')
  return query
}

describe.skipIf(!oc || !solveBytes)('sketch origin dimension on a face (real solve)', () => {
  const h = extrudeTestHarness()

  it('draws the dimension from the face-local document origin', () => {
    const plate = h.run({
      features: [
        rectSketchSk('sk1', 10, 10),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
      ],
    })
    const mesh = h.body(plate, 'body_ex1').mesh as FaceMesh | undefined
    if (!mesh) throw new Error('plate mesh missing')
    const plane = topFaceQuery(mesh)

    const result: BuildResponse = h.run({
      features: [
        rectSketchSk('sk1', 10, 10),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        {
          id: 'sk2', kind: 'sketch', label: 'Face dimension', plane,
          entities: [{ id: 'p1', kind: 'point' }],
          initial: { p1: [10, 5] },
          constraints: [
            { id: 'dx', kind: 'point_distance_x', a: '@builtin_origin', b: '$p1xy', value: 10 },
          ],
        },
      ],
    })

    const out = h.res(result, 'sk2')
    expect(out.status).not.toBe('exception')
    const originLocal = out.originLocal as [number, number]
    const frame = frameFromPlaneTransform(out.plane_transform as { rotation: number[]; origin: number[] })
    // The cap's frame origin is the face centroid, so the document origin is
    // genuinely off this plane's local (0,0).
    expect(originLocal).toEqual(projectWorldToFrame([0, 0, 0], frame))
    expect(Math.hypot(originLocal[0], originLocal[1])).toBeGreaterThan(1)

    const render = ((out.constraints as Record<string, Dict>).dx.render) as {
      kind: string
      p1: [number, number]
      p2: [number, number]
    }
    expect(render.kind).toBe('dim_linear')
    // The origin end sits at originLocal; the authored point solved 10 along +x
    // from it, which proves the dimension used the document origin.
    expect(render.p1[0]).toBeCloseTo(originLocal[0], 6)
    expect(render.p2[0]).toBeCloseTo(originLocal[0] + 10, 6)
  })
})
