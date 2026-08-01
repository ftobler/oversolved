// @vitest-environment node
//
// Gated real-OCC test for imported-face naming (`importLineage.ts`): every face
// of a STEP import gets a construction UUID derived from the file's own entity
// id, and every edge follows from the face pairs.
//
// Skips when opencascade.js is absent. Install:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { stepBytesToShapeWithIdentity } from './stepIo'
import { importedNameMaps } from './importLineage'
import { faceGh, edgeGh } from './lineageHash'
import { FACE_UUID_PREFIX, EDGE_UUID_PREFIX } from '../constructionName'

const oc = await loadOcc()

function fixtureBytes(): Uint8Array {
  return new Uint8Array(readFileSync(new URL('./__fixtures__/double_with_hole.step', import.meta.url)))
}

function edgeGhs(occ: OccModule, scope: DisposeScope, shape: OccShape): string[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out = new Set<string>()
  for (; exp.More(); exp.Next()) {
    const gh = edgeGh(occ, scope, scope.track(occ.TopoDS.Edge_1(exp.Current())))
    if (gh !== null) out.add(gh)
  }
  return [...out]
}

describe.skipIf(!oc)('importedNameMaps (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('names every face with a distinct construction UUID', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1')
      const uuids = Object.values(maps.faceNames)
      // Without a floor here the whole test passes on an empty map: every
      // length check becomes 0 === 0 and every loop body is skipped.
      expect(uuids.length).toBeGreaterThan(1)
      expect(uuids.length).toBe(Object.keys(faceStepIds).length)
      expect(new Set(uuids).size).toBe(uuids.length)
      for (const u of uuids) expect(u.startsWith(FACE_UUID_PREFIX)).toBe(true)
      // Empty on purpose: the UUID tier answers first and an imported face has
      // no ancestor inside this document.
      for (const u of uuids) expect(maps.faceAncestry[u]).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('names every edge, which is what makes an imported edge pickable', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1')
      const ghs = edgeGhs(occ, scope, shape)
      expect(ghs.length).toBeGreaterThan(0)
      for (const gh of ghs) {
        expect(maps.edgeNames[gh], `edge ${gh} unnamed`).toBeDefined()
        expect(maps.edgeNames[gh].startsWith(EDGE_UUID_PREFIX)).toBe(true)
      }
      expect(new Set(Object.values(maps.edgeNames)).size).toBe(Object.keys(maps.edgeNames).length)
    } finally {
      scope.dispose()
    }
  })

  it('gives two imports of the same file disjoint UUID namespaces', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const a = importedNameMaps(occ, scope, shape, faceStepIds, 'import1')
      const b = importedNameMaps(occ, scope, shape, faceStepIds, 'import2')
      const bFaces = new Set(Object.values(b.faceNames))
      expect(Object.values(a.faceNames).filter((u) => bFaces.has(u))).toEqual([])
      // The edge UUIDs derive from the face pairs, so they must part company too.
      const bEdges = new Set(Object.values(b.edgeNames))
      expect(Object.values(a.edgeNames).filter((u) => bEdges.has(u))).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('names a face the transfer map missed from its neighbours', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const dropped = Object.keys(faceStepIds)[0]
      const partial = { ...faceStepIds }
      delete partial[dropped]
      const maps = importedNameMaps(occ, scope, shape, partial, 'import1')
      expect(maps.faceNames[dropped], 'residual face left unnamed').toBeDefined()
      // Named off the neighbour set, so it must NOT be the entity-derived UUID.
      const full = importedNameMaps(occ, scope, shape, faceStepIds, 'import1')
      expect(maps.faceNames[dropped]).not.toBe(full.faceNames[dropped])
    } finally {
      scope.dispose()
    }
  })

  it('recomputes to the same names on a second read of the same file', () => {
    const scope = new DisposeScope()
    try {
      const first = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const second = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const a = importedNameMaps(occ, scope, first.shape, first.faceStepIds, 'import1')
      const b = importedNameMaps(occ, scope, second.shape, second.faceStepIds, 'import1')
      expect(b.faceNames).toEqual(a.faceNames)
      expect(b.edgeNames).toEqual(a.edgeNames)
    } finally {
      scope.dispose()
    }
  })

  it('gives a face the same UUID at a different import scale', () => {
    // The whole point of using the file's entity id: the geometry (and with it
    // every geom-hash KEY) moves, the identity does not.
    const scope = new DisposeScope()
    try {
      const plain = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 1.0)
      const scaled = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 3.0)
      const a = importedNameMaps(occ, scope, plain.shape, plain.faceStepIds, 'import1')
      const b = importedNameMaps(occ, scope, scaled.shape, scaled.faceStepIds, 'import1')
      expect(new Set(Object.values(b.faceNames))).toEqual(new Set(Object.values(a.faceNames)))
      expect(new Set(Object.values(b.edgeNames))).toEqual(new Set(Object.values(a.edgeNames)))
      expect(Object.keys(b.faceNames)).not.toEqual(Object.keys(a.faceNames))
    } finally {
      scope.dispose()
    }
  })

  it('keys the face names by the hash the explorer produces', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1')
      const E = occ.TopAbs_ShapeEnum
      const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      let n = 0
      for (; exp.More(); exp.Next()) {
        const gh = faceGh(occ, scope, scope.track(occ.TopoDS.Face_1(exp.Current())))
        expect(maps.faceNames[gh], `explorer face ${gh} has no name`).toBeDefined()
        n++
      }
      expect(n).toBeGreaterThan(1)
    } finally {
      scope.dispose()
    }
  })
})
