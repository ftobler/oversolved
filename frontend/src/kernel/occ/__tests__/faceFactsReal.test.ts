// @vitest-environment node
//
// readFaceFacts (one OversolvedFaceFacts call per shape) must return what the
// per-face readers in primitives.ts return, number for number: the face sort
// order is derived from the centroid and normal, so a sub-ulp difference would
// reorder faces and move every face index. Every surface kind the frame reader
// distinguishes is covered, plus a freeform (B-spline) face and an imported one.
//
// Skips when OCC is absent, like every *Real suite.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  faceCentroid, faceCylinderAxis, faceNormal, faceSurfaceFrame, faceSurfaceType,
  makeBox, makeCircleEdge, makeCone, makeCylinder, makeWire,
} from '../primitives'
import { readFaceFacts, factNormal } from '../faceFacts'
import { stepBytesToShape } from '../stepIo'
import { readShapeFaces } from '../tessellation'
import { noProgress } from '../defaultArgs'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

function facesOf(occ: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(occ.TopoDS.Face_1(exp.Current())))
  return out
}

/** Bulk and per-face reads side by side; returns the surface kinds seen. */
function expectParity(occ: OccModule, scope: DisposeScope, shape: OccShape): Set<string> {
  const facts = readFaceFacts(occ, shape)
  const faces = facesOf(occ, scope, shape)
  expect(facts.length).toBe(faces.length)
  const kinds = new Set<string>()
  faces.forEach((face, i) => {
    const fact = facts[i]
    // toEqual compares numbers with Object.is: bit for bit, -0 included.
    expect(fact.surfaceType).toBe(faceSurfaceType(occ, scope, face))
    expect(fact.centroid).toEqual(faceCentroid(occ, scope, face))
    expect(factNormal(fact)).toEqual(faceNormal(occ, scope, face))
    expect(fact.surfaceFrame).toEqual(faceSurfaceFrame(occ, scope, face))
    expect(fact.cylinderAxis).toEqual(faceCylinderAxis(occ, scope, face))
    kinds.add(fact.surfaceType)
  })
  return kinds
}

function ax2(occ: OccModule, scope: DisposeScope) {
  return scope.track(new occ.gp_Ax2_4(
    scope.track(new occ.gp_Pnt_3(1, 2, 3)),
    scope.track(new occ.gp_Dir_5(0.3, -0.2, 0.9)),
  ))
}

describe.skipIf(!oc)('readFaceFacts parity with the per-face readers (real OCC)', () => {
  it('planes and a cylinder, REVERSED faces included', () => {
    const scope = new DisposeScope()
    try {
      expect(expectParity(oc!, scope, makeBox(oc!, scope, 3, 4, 5))).toEqual(new Set(['flatface']))
      const kinds = expectParity(oc!, scope, makeCylinder(oc!, scope, [1, -2, 0.5], [0.2, 0.1, 1], 4, 9))
      expect(kinds.has('cylinderface')).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('a cone, a sphere and a torus on a tilted frame', () => {
    const scope = new DisposeScope()
    try {
      expect(expectParity(oc!, scope, makeCone(oc!, scope, [1, 2, 3], [0.3, -0.2, 0.9], 5, 2, 7)).has('coneface'))
        .toBe(true)
      const sphere = scope.track(new oc!.BRepPrimAPI_MakeSphere_5(scope.track(new oc!.gp_Pnt_3(1, 2, 3)), 6)).Shape()
      expect(expectParity(oc!, scope, sphere).has('sphereface')).toBe(true)
      const torus = scope.track(new oc!.BRepPrimAPI_MakeTorus_5(ax2(oc!, scope), 8, 2)).Shape()
      expect(expectParity(oc!, scope, torus).has('torusface')).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('a freeform loft face', () => {
    const scope = new DisposeScope()
    try {
      const loft = scope.track(new oc!.BRepOffsetAPI_ThruSections(true, false, 1e-6))
      loft.AddWire(makeWire(oc!, scope, [scope.track(makeCircleEdge(oc!, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5))]))
      loft.AddWire(makeWire(oc!, scope, [scope.track(makeCircleEdge(oc!, scope, [1, 0, 6], [0.2, 0, 1], [1, 0, -0.2], 2))]))
      loft.Build(noProgress(oc!))
      expect(loft.IsDone()).toBe(true)
      expect(expectParity(oc!, scope, loft.Shape()).has('face')).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('an imported STEP body', () => {
    const scope = new DisposeScope()
    try {
      const bytes = new Uint8Array(readFileSync(join(__dirname, '../__fixtures__/double_with_hole.step')))
      expectParity(oc!, scope, scope.track(stepBytesToShape(oc!, scope, bytes)))
    } finally {
      scope.dispose()
    }
  })

  // Opt-in: the bench's larger STEP inputs (project-relative, comma-separated),
  // for a wider sweep over real freeform faces than the gate can afford.
  const sweep = (process.env.FACE_FACTS_FILES ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '')
  for (const rel of sweep) {
    it(`sweep: ${rel}`, () => {
      const scope = new DisposeScope()
      try {
        const bytes = new Uint8Array(readFileSync(join(__dirname, '../../../../..', rel)))
        expectParity(oc!, scope, scope.track(stepBytesToShape(oc!, scope, bytes)))
      } finally {
        scope.dispose()
      }
    }, 600_000)
  }

  it('refuses facts read off a different solid instead of pairing them', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 3, 4, 5)  // 6 faces
      const cyl = makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 2, 3)  // 3 faces
      expect(() => readShapeFaces(oc!, scope, cyl, 0.1, 0.1, readFaceFacts(oc!, box)))
        .toThrow('face facts: 6 read for 3 faces')
      expect(() => readShapeFaces(oc!, scope, box, 0.1, 0.1, readFaceFacts(oc!, cyl)))
        .toThrow('face facts: no fact for face 3 (3 read)')
    } finally {
      scope.dispose()
    }
  })

  it('refuses an undefined normal with the per-face reader\'s message', () => {
    const fact = { surfaceType: 'face', centroid: [0, 0, 0], normal: null, surfaceFrame: null, cylinderAxis: null, geomType: 6 } as const
    expect(() => factNormal({ ...fact, centroid: [0, 0, 0] })).toThrow(
      'faceNormal: normal is not defined at the UV midpoint (surface type 6)',
    )
  })
})
