// @vitest-environment node
//
// Gated test: STEP export (shape -> bytes) via STEPControl_Writer,
// round-tripped back through stepBytesToShape and verified by volume parity.
// opencascade.js must run under node (its emscripten FS path for STEP differs
// from the browser Worker's --target web FS).
//
// Skips when opencascade.js is absent. Install:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { makeBox, makeBoxAt, faceCentroid } from './primitives'
import { makeTranslationTrsf } from './transforms'
import { stepShapeToBytes, stepBytesToShape, stepBytesToShapeWithIdentity, shapeToStlBytes } from './stepIo'
import { faceGh } from './lineageHash'
import { volumeOf } from './booleans'

const oc = await loadOcc()

/** The fixture that already lives here, as raw bytes. 7 faces, one cylindrical. */
function fixtureBytes(): Uint8Array {
  return new Uint8Array(readFileSync(new URL('./__fixtures__/double_with_hole.step', import.meta.url)))
}

/** Explorer-ordered face geom-hashes of a shape -- the keys every consumer uses. */
function explorerFaceGhs(occ: OccModule, scope: DisposeScope, shape: OccShape): string[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: string[] = []
  for (; exp.More(); exp.Next()) out.push(faceGh(occ, scope, scope.track(occ.TopoDS.Face_1(exp.Current()))))
  return out
}

describe.skipIf(!oc)('stepShapeToBytes (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('serialises a box to valid STEP bytes', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 5, 5, 5))
      const bytes = stepShapeToBytes(occ, scope, box)
      const text = new TextDecoder().decode(bytes)
      expect(text).toContain('ISO-10303-21')
      expect(text).toContain('MANIFOLD_SOLID_BREP')
      expect(text).toContain('END-ISO-10303-21')
    } finally {
      scope.dispose()
    }
  })

  it('round-trips a box through STEP export -> import with volume parity', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 3, 4, 5))
      const originalVolume = volumeOf(occ, scope, box)

      const bytes = stepShapeToBytes(occ, scope, box)
      const reimported = scope.track(stepBytesToShape(occ, scope, bytes))
      const roundTripVolume = volumeOf(occ, scope, reimported)

      expect(originalVolume).toBeCloseTo(60, 1)  // 3*4*5
      expect(roundTripVolume).toBeCloseTo(originalVolume, 1)
    } finally {
      scope.dispose()
    }
  })

  it('round-trips a box at non-uniform scale', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = stepShapeToBytes(occ, scope, box)
      const reimported = scope.track(stepBytesToShape(occ, scope, bytes, 2.0))
      const vol = volumeOf(occ, scope, reimported)
      expect(vol).toBeCloseTo(8000, 1)  // 20*20*20
    } finally {
      scope.dispose()
    }
  })
})

// ─── STEP entity identity (imported-face-naming) ───

describe.skipIf(!oc)('stepBytesToShapeWithIdentity (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('recovers a distinct STEP entity id for every face', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const ghs = explorerFaceGhs(occ, scope, shape)
      expect(ghs.length).toBeGreaterThan(1)
      expect(Object.keys(faceStepIds).length).toBe(ghs.length)
      // Ids are the file's own `#N`, so they are positive and never repeat.
      const ids = Object.values(faceStepIds)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(id).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('keys the map the way the explorer hashes the faces, not the way ModifiedShape does', () => {
    // The orientation trap: `ModifiedShape` returns a face whose `faceGh` differs
    // from the explorer's for a subset of faces (3 of 7 in this fixture at scale
    // 2). Every consumer looks up by the explorer's hash, so a map keyed on
    // `ModifiedShape` output would silently miss those faces. Asserted at BOTH
    // scales because the unscaled path cannot reach the bug at all.
    for (const scale of [1.0, 2.0]) {
      const scope = new DisposeScope()
      try {
        const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), scale)
        const ghs = new Set(explorerFaceGhs(occ, scope, shape))
        for (const gh of Object.keys(faceStepIds)) {
          expect(ghs.has(gh), `scale ${scale}: ${gh} is not an explorer face hash`).toBe(true)
        }
        // Every key being an explorer hash is only half of it: losing 3 of 7 to
        // the orientation trap would still satisfy the loop above.
        expect(Object.keys(faceStepIds).length, `scale ${scale}`).toBe(ghs.size)
      } finally {
        scope.dispose()
      }
    }
  })

  it('carries the same entity ids across a scaled read', () => {
    const scope = new DisposeScope()
    try {
      const plain = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 1.0)
      const scaled = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 2.0)
      // The geometry moved, so the KEYS differ; the identity did not, so the
      // id sets must match exactly and stay complete.
      expect(new Set(Object.values(scaled.faceStepIds)))
        .toEqual(new Set(Object.values(plain.faceStepIds)))
      expect(Object.keys(scaled.faceStepIds).length).toBe(Object.keys(plain.faceStepIds).length)
      expect(Object.keys(scaled.faceStepIds)).not.toEqual(Object.keys(plain.faceStepIds))
    } finally {
      scope.dispose()
    }
  })

  it('keeps each entity id on the SAME face after scaling', () => {
    // The pairing has to survive the transform, not merely stay non-empty: a
    // shuffled correspondence would hand face A's identity to face B and every
    // pick would resolve to the wrong face while all the counts still looked
    // right. Scaling about the origin multiplies every centroid by the factor,
    // so that is checkable exactly.
    const scope = new DisposeScope()
    try {
      const factor = 2.0
      const plain = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 1.0)
      const scaled = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), factor)
      const centroidsById = (r: { shape: OccShape; faceStepIds: Record<string, number> }) => {
        const byGh = new Map<string, number[]>()
        const E = occ.TopAbs_ShapeEnum
        const exp = scope.track(new occ.TopExp_Explorer_2(r.shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
        for (; exp.More(); exp.Next()) {
          const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
          byGh.set(faceGh(occ, scope, f), faceCentroid(occ, scope, f))
        }
        const out = new Map<number, number[]>()
        for (const [gh, id] of Object.entries(r.faceStepIds)) out.set(id, byGh.get(gh)!)
        return out
      }
      const before = centroidsById(plain)
      const after = centroidsById(scaled)
      expect(after.size).toBe(before.size)
      for (const [id, c] of before) {
        const moved = after.get(id)
        expect(moved, `entity #${id} lost across the scale`).toBeDefined()
        for (let i = 0; i < 3; i++) expect(moved![i]).toBeCloseTo(c[i] * factor, 6)
      }
    } finally {
      scope.dispose()
    }
  })

  it('covers every face of a MULTI-ROOT file', () => {
    // A file with several roots comes back with each root under its own
    // TopLoc_Location while the transfer binders hold the unplaced faces, so
    // pairing them by `IsSame` matches nothing at all and the entire import
    // goes unnamed. One root cannot reach this: it is the identity location.
    const scope = new DisposeScope()
    try {
      for (const n of [1, 2, 3]) {
        const builder = scope.track(new occ.BRep_Builder())
        const compound = scope.track(new occ.TopoDS_Compound())
        builder.MakeCompound(compound)
        for (let i = 0; i < n; i++) builder.Add(compound, makeBoxAt(occ, scope, [i * 30, 0, 0], 10, 10, 10))
        const bytes = stepShapeToBytes(occ, scope, compound)
        const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, bytes)
        expect(explorerFaceGhs(occ, scope, shape).length).toBe(n * 6)
        expect(Object.keys(faceStepIds).length, `${n} solids`).toBe(n * 6)
      }
    } finally {
      scope.dispose()
    }
  })

  it('names every placement of a REPEATED part, not just the first', () => {
    // Two placements of one part share a TShape, so stripping the location to
    // fix the multi-root case collapses them onto one key. Keeping only the
    // first position there would leave every instance past the first entirely
    // unnamed -- and `nameFacesFromNeighbours` cannot rescue it, because no
    // face of such an instance has a named neighbour to derive from.
    const scope = new DisposeScope()
    try {
      const builder = scope.track(new occ.BRep_Builder())
      const compound = scope.track(new occ.TopoDS_Compound())
      builder.MakeCompound(compound)
      const part = scope.track(makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10))
      // copy=false, so the instance shares `part`'s TShape under a location --
      // which is what a repeated assembly instance is, and it survives the STEP
      // round trip as one.
      const mover = scope.track(
        new occ.BRepBuilderAPI_Transform_2(part, makeTranslationTrsf(occ, scope, 40, 0, 0), false),
      )
      mover.Build()
      builder.Add(compound, part)
      builder.Add(compound, mover.Shape())
      const bytes = stepShapeToBytes(occ, scope, compound)

      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, bytes)
      expect(explorerFaceGhs(occ, scope, shape).length).toBe(12)
      expect(Object.keys(faceStepIds).length).toBe(12)
      // Six ids for twelve faces is the proof that the two instances really do
      // share entities: a first-wins index would have returned six keys.
      expect(new Set(Object.values(faceStepIds)).size).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('is deterministic across two reads of the same bytes', () => {
    const scope = new DisposeScope()
    try {
      const a = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const b = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      expect(b.faceStepIds).toEqual(a.faceStepIds)
    } finally {
      scope.dispose()
    }
  })

  it('leaves the identity-free read untouched', () => {
    const scope = new DisposeScope()
    try {
      const bytes = fixtureBytes()
      const plain = scope.track(stepBytesToShape(occ, scope, bytes, 2.0))
      const withId = stepBytesToShapeWithIdentity(occ, scope, bytes, 2.0)
      expect(volumeOf(occ, scope, withId.shape)).toBeCloseTo(volumeOf(occ, scope, plain), 3)
    } finally {
      scope.dispose()
    }
  })
})

// ─── STL export ───

describe.skipIf(!oc)('shapeToStlBytes (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('serialises a box to non-empty STL bytes', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = shapeToStlBytes(occ, scope, box)
      expect(bytes.length).toBeGreaterThan(0)
      // Binary STL has an 80-byte header + 4-byte triangle count.
      expect(bytes.length).toBeGreaterThan(84)
    } finally {
      scope.dispose()
    }
  })

  it('STL bytes encode a valid triangle count', () => {
    /** Binary STL: bytes 80-83 (little-endian uint32) carry the triangle count.
     *  A 10x10x10 box should have at least 12 triangles (2 per face × 6 faces). */
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = shapeToStlBytes(occ, scope, box)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const triCount = view.getUint32(80, true)
      expect(triCount).toBeGreaterThanOrEqual(12)
    } finally {
      scope.dispose()
    }
  })

  it('tessellation deflection affects triangle count', () => {
    // A finer deflection (smaller value) produces more triangles.
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const coarse = shapeToStlBytes(occ, scope, box, 1.0)
      const fine = shapeToStlBytes(occ, scope, box, 0.01)
      const coarseTri = new DataView(coarse.buffer, coarse.byteOffset, coarse.byteLength).getUint32(80, true)
      const fineTri = new DataView(fine.buffer, fine.byteOffset, fine.byteLength).getUint32(80, true)
      expect(fineTri).toBeGreaterThanOrEqual(coarseTri)
    } finally {
      scope.dispose()
    }
  })
})
