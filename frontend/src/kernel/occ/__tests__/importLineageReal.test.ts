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
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import type { OccModule, OccShape } from '../occTypes'
import { stepBytesToShapeWithIdentity, stepShapeToBytes } from '../stepIo'
import { importedNameMaps } from '../importLineage'
import { canonicalEdges, canonicalFaces, namesToArray } from '../bodyNames'
import { SubShapeMap } from '../subshapeIdentity'
import { FACE_UUID_PREFIX, EDGE_UUID_PREFIX } from '../../constructionName'
import { makeBoxAt } from '../primitives'
import { makeTranslationTrsf } from '../transforms'
import { splitSolids } from '../../features/bodySplit'

const oc = await loadOcc()

function fixtureBytes(): Uint8Array {
  return new Uint8Array(readFileSync(new URL('../__fixtures__/double_with_hole.step', import.meta.url)))
}

const valuesOf = (m: SubShapeMap<string>): string[] => [...m.values()]

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
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', [])
      const uuids = valuesOf(maps.faceNames)
      // Without a floor here the whole test passes on an empty map: every
      // length check becomes 0 === 0 and every loop body is skipped.
      expect(uuids.length).toBeGreaterThan(1)
      expect(uuids.length).toBe(faceStepIds.size)
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
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', [])
      const edges = canonicalEdges(occ, scope, shape)
      expect(edges.length).toBeGreaterThan(0)
      edges.forEach((edge, i) => {
        expect(maps.edgeNames.get(edge), `edge ${i} unnamed`).toBeDefined()
        expect(maps.edgeNames.get(edge)!.startsWith(EDGE_UUID_PREFIX)).toBe(true)
      })
      expect(new Set(maps.edgeNames.values()).size).toBe(maps.edgeNames.size)
    } finally {
      scope.dispose()
    }
  })

  it('gives two imports of the same file disjoint UUID namespaces', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const a = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', [])
      const b = importedNameMaps(occ, scope, shape, faceStepIds, 'import2', [])
      const bFaces = new Set(b.faceNames.values())
      expect(valuesOf(a.faceNames).filter((u) => bFaces.has(u))).toEqual([])
      // The edge UUIDs derive from the face pairs, so they must part company too.
      const bEdges = new Set(b.edgeNames.values())
      expect(valuesOf(a.edgeNames).filter((u) => bEdges.has(u))).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('names a face the transfer map missed from its neighbours', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const dropped = canonicalFaces(occ, scope, shape).find((f) => faceStepIds.has(f))!
      const partial = new SubShapeMap(faceStepIds)
      partial.delete(dropped)
      const maps = importedNameMaps(occ, scope, shape, partial, 'import1', [])
      expect(maps.faceNames.get(dropped), 'residual face left unnamed').toBeDefined()
      // Named off the neighbour set, so it must NOT be the entity-derived UUID.
      const full = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', [])
      expect(maps.faceNames.get(dropped)).not.toBe(full.faceNames.get(dropped))
    } finally {
      scope.dispose()
    }
  })

  it('recomputes to the same names on a second read of the same file', () => {
    const scope = new DisposeScope()
    try {
      const first = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const second = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const a = importedNameMaps(occ, scope, first.shape, first.faceStepIds, 'import1', [])
      const b = importedNameMaps(occ, scope, second.shape, second.faceStepIds, 'import1', [])
      // Two reads are two shapes; position by position in their canonical order
      // they must carry the same names.
      const facesOf = (s: OccShape, m: SubShapeMap<string>) => namesToArray(canonicalFaces(occ, scope, s), m)
      const edgesOf = (s: OccShape, m: SubShapeMap<string>) => namesToArray(canonicalEdges(occ, scope, s), m)
      expect(facesOf(second.shape, b.faceNames)).toEqual(facesOf(first.shape, a.faceNames))
      expect(edgesOf(second.shape, b.edgeNames)).toEqual(edgesOf(first.shape, a.edgeNames))
    } finally {
      scope.dispose()
    }
  })

  it('gives a face the same UUID at a different import scale', () => {
    // The whole point of using the file's entity id: the geometry moves, the
    // identity does not.
    const scope = new DisposeScope()
    try {
      const plain = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 1.0)
      const scaled = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes(), 3.0)
      const a = importedNameMaps(occ, scope, plain.shape, plain.faceStepIds, 'import1', [])
      const b = importedNameMaps(occ, scope, scaled.shape, scaled.faceStepIds, 'import1', [])
      expect(new Set(b.faceNames.values())).toEqual(new Set(a.faceNames.values()))
      expect(new Set(b.edgeNames.values())).toEqual(new Set(a.edgeNames.values()))
    } finally {
      scope.dispose()
    }
  })

  it('names every face the explorer walk of the shape yields', () => {
    const scope = new DisposeScope()
    try {
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, fixtureBytes())
      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', [])
      const faces = canonicalFaces(occ, scope, shape)
      faces.forEach((face, i) => expect(maps.faceNames.get(face), `explorer face ${i} has no name`).toBeDefined())
      expect(faces.length).toBeGreaterThan(1)
    } finally {
      scope.dispose()
    }
  })

  it('keeps two placements of one part in disjoint UUID sets', () => {
    // A repeated instance shares its TShape, so both copies carry the same STEP
    // entity ids. With the per-solid index from `splitSolids` folded into the
    // path, each placement mints its OWN six face UUIDs -- without it the two
    // placements collapsed onto the same six and the resolver's UUID tier
    // threw "collision by construction" on every pick.
    const scope = new DisposeScope()
    try {
      const part = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
      const mover = scope.track(
        new occ.BRepBuilderAPI_Transform_2(part, makeTranslationTrsf(occ, scope, 40, 0, 0), false),
      )
      mover.Build()
      const builder = scope.track(new occ.BRep_Builder())
      const compound = scope.track(new occ.TopoDS_Compound())
      builder.MakeCompound(compound)
      builder.Add(compound, part)
      builder.Add(compound, mover.Shape())
      const { shape, faceStepIds } = stepBytesToShapeWithIdentity(
        occ, scope, stepShapeToBytes(occ, scope, compound),
      )
      const solids = splitSolids(occ, scope, shape)
      expect(solids.length).toBe(2)

      const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', solids)
      // 12 face keys (six per placement) carrying 12 DISTINCT uuids: pre-fix
      // this was 12 keys collapsing onto 6 shared uuids.
      expect(maps.faceNames.size).toBe(12)
      expect(new Set(maps.faceNames.values()).size).toBe(12)
      // Edge UUIDs derive from the face pairs, so they part company too.
      expect(maps.edgeNames.size).toBeGreaterThan(0)
      expect(new Set(maps.edgeNames.values()).size).toBe(maps.edgeNames.size)
    } finally {
      scope.dispose()
    }
  })
})
