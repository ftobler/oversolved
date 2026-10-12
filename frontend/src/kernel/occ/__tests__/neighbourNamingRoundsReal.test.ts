// @vitest-environment node
//
// The neighbour naming pass (constructionLineage `nameFacesFromNeighbours`) runs in
// rounds and skips uuids the body already holds. Two properties are locked here on
// real OCC shapes, below the feature layer so nothing else can name the faces first:
//   1. the names do not depend on the order the face rows are visited in, also when
//      a face reachable only through other new faces is named in a later round;
//   2. a group of new faces whose base uuid some face already holds takes the next
//      free multiplicities instead of laying a second claim on it.
//
// Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeCylinder, faceNormal, type Vec3 } from '../primitives'
import { booleanWithDiff } from '../booleans'
import { canonicalFaces } from '../bodyNames'
import { FaceEdgeTable, nameFacesFromNeighbours } from '../constructionLineage'
import { SubShapeMap } from '../subshapeIdentity'
import { deriveCornerFaceUuid } from '../../constructionName'
import type { OccShape, OccSubShape } from '../occTypes'

const oc = await loadOcc()

/** A 10x10x5 box with cylinders of radius 1 cut into it, each `[x, y, z0, height]`
 *  along +z. Every face the box contributes is named `u_box<i>` by its canonical
 *  box index; every face a cylinder left behind is unnamed, as after a hole cut
 *  whose tool carried no names. */
function drilledBox(scope: DisposeScope, cylinders: Array<[number, number, number, number]>) {
  const box = makeBox(oc!, scope, 10, 10, 5)
  const boxFaces = canonicalFaces(oc!, scope, box)
  let shape: OccShape = box
  // Source box face -> its name, carried across every cut by the face history.
  let names = new SubShapeMap<string>()
  boxFaces.forEach((f, i) => names.set(f, `u_box${i}`))
  for (const [x, y, z0, h] of cylinders) {
    const cyl = scope.track(makeCylinder(oc!, scope, [x, y, z0], [0, 0, 1], 1, h))
    const res = booleanWithDiff(oc!, scope, shape, cyl, 'cut', { unifyFaces: true })
    const next = new SubShapeMap<string>()
    for (const o of res.faceOrigin) {
      if (o.fromTool) continue
      const uuid = names.get(o.source)
      if (uuid !== undefined) next.set(scope.track(oc!.TopoDS.Face_1(o.output as unknown as OccShape)) as OccSubShape, uuid)
    }
    names = next
    shape = scope.track(res.shape)
  }
  const ancestry: Record<string, string[]> = {}
  for (const uuid of names.values()) ancestry[uuid] = [`@${uuid}`]
  return { shape, names, ancestry }
}

/** The same table with its rows visited in another order. The pass reads only
 *  `rows` and `shape`, so a copy with the rows permuted is a faithful stand-in for
 *  a shape whose explorer happened to list its faces differently. */
function permuted(t: FaceEdgeTable, order: (rows: FaceEdgeTable['rows']) => FaceEdgeTable['rows']): FaceEdgeTable {
  return Object.assign(Object.create(FaceEdgeTable.prototype) as FaceEdgeTable, t, { rows: order(t.rows) })
}

describe.skipIf(!oc)('neighbour naming rounds (real OCC)', () => {
  // One plain blind bore, and one cut through the x=0 wall so its floor touches
  // an old face AND the new bore: a pass that let a face see a name minted in the
  // same round would give that floor a different neighbour set depending on
  // whether the bore came first.
  const sites: Array<[number, number, number, number]> = [[5, 5, 2, 4], [0.5, 5, 2, 4]]

  it('names every face, and identically for any row order', () => {
    const scope = new DisposeScope()
    try {
      const { shape, names, ancestry } = drilledBox(scope, sites)
      const table = FaceEdgeTable.read(oc!, scope, shape)
      const orders: Array<(rows: FaceEdgeTable['rows']) => FaceEdgeTable['rows']> = [
        (rows) => rows,
        (rows) => [...rows].reverse(),
        (rows) => [...rows.slice(3), ...rows.slice(0, 3)],
        (rows) => [...rows.filter((_r, i) => i % 2 === 1), ...rows.filter((_r, i) => i % 2 === 0)],
      ]
      const results = orders.map((order) => {
        const faceNames = new SubShapeMap(names)
        const faceAncestry = structuredClone(ancestry)
        nameFacesFromNeighbours(oc!, scope, permuted(table, order), faceNames, faceAncestry)
        return { faceNames, faceAncestry }
      })
      const faces = table.rows.map((r) => r.face)
      // The new faces really needed more than one round: a floor sits behind its bore.
      expect(faces.length - names.size).toBeGreaterThanOrEqual(4)
      for (const { faceNames } of results) {
        expect(faces.every((f) => faceNames.has(f)), 'every face is named').toBe(true)
        expect(new Set(faces.map((f) => faceNames.get(f))).size, 'no uuid names two faces').toBe(faces.length)
      }
      const reference = faces.map((f) => results[0].faceNames.get(f))
      for (const { faceNames, faceAncestry } of results.slice(1)) {
        expect(faces.map((f) => faceNames.get(f))).toEqual(reference)
        expect(faceAncestry).toEqual(results[0].faceAncestry)
      }
    } finally { scope.dispose() }
  })

  it('a group whose base uuid is already held takes the next free multiplicities', () => {
    const scope = new DisposeScope()
    try {
      // Two through bores, both between the top and the bottom face only.
      const { shape, names, ancestry } = drilledBox(scope, [[3, 3, -1, 7], [7, 6, -1, 7]])
      const capNames: string[] = []
      let side: OccSubShape | null = null
      for (const [face, uuid] of names.entries()) {
        const n = faceNormal(oc!, scope, face) as Vec3
        if (Math.abs(n[2]) > 0.99) capNames.push(uuid)
        else side ??= face
      }
      expect(capNames).toHaveLength(2)
      // A side face of the body already holds the uuid the bore pair would start
      // at, as when an earlier cut of the same hole named a bore off the same caps.
      const base = deriveCornerFaceUuid(capNames, 0)
      const lost = names.get(side!)!
      names.set(side!, base)
      ancestry[base] = ancestry[lost]

      const faceNames = new SubShapeMap(names)
      nameFacesFromNeighbours(oc!, scope, shape, faceNames, ancestry)
      const bores = FaceEdgeTable.read(oc!, scope, shape).rows.map((r) => r.face).filter((f) => !names.has(f))
      expect(bores).toHaveLength(2)
      expect(new Set(bores.map((f) => faceNames.get(f)))).toEqual(
        new Set([deriveCornerFaceUuid(capNames, 1), deriveCornerFaceUuid(capNames, 2)]),
      )
      expect(faceNames.get(side!), 'the holder keeps its uuid').toBe(base)
    } finally { scope.dispose() }
  })
})
