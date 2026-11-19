// @vitest-environment node
//
// Identity guard for the colour-aware STEP reader. Imported face and edge
// names (and with them every UUID a document stores against an import) are
// derived from the transfer map's face -> `#N` entity ids. The import path
// reads through OversolvedStepCaf now, so the ids it yields must equal the
// plain STEPControl_Reader's, face for face in explorer order, for every STEP
// the suite knows; the shape must be the same one too (volume, face count).
// A difference here is a naming regression, not an accepted UUID change.
//
// Skips when OCC is absent. Install:
//   just install-occ

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'
import { stepBytesToShapeWithIdentity, stepShapeToBytes, type StepReaderKind } from '../stepIo'
import { importedNameMaps } from '../importLineage'
import { canonicalEdges, canonicalFaces } from '../partNames'
import { volumeOf } from '../booleans'
import { makeBoxAt } from '../primitives'
import { makeTranslationTrsf } from '../transforms'
import { splitSolids } from '../../features/partSplit'

const oc = await loadOcc()

const FIXTURES = new URL('../__fixtures__/', import.meta.url)

/** Every STEP file checked in beside the kernel fixtures. */
function fixtureFiles(): string[] {
  return readdirSync(FIXTURES).filter((f) => /\.(step|stp)$/i.test(f)).sort()
}

interface IdentityRead {
  faceIds: (number | undefined)[]
  faceNames: (string | undefined)[]
  edgeNames: (string | undefined)[]
  volume: number
}

function identityRead(occ: OccModule, bytes: Uint8Array, scale: number, kind: StepReaderKind): IdentityRead {
  const scope = new DisposeScope()
  try {
    const { shape, faceStepIds } = stepBytesToShapeWithIdentity(occ, scope, bytes, scale, kind)
    scope.track(shape)
    const maps = importedNameMaps(occ, scope, shape, faceStepIds, 'import1', splitSolids(occ, scope, shape))
    const faces = canonicalFaces(occ, scope, shape) as OccShape[]
    const edges = canonicalEdges(occ, scope, shape) as OccShape[]
    return {
      faceIds: faces.map((f) => faceStepIds.get(f as OccSubShape)),
      faceNames: faces.map((f) => maps.faceNames.get(f as OccSubShape)),
      edgeNames: edges.map((e) => maps.edgeNames.get(e as OccSubShape)),
      volume: volumeOf(occ, scope, shape),
    }
  } finally {
    scope.dispose()
  }
}

function expectSameIdentity(occ: OccModule, bytes: Uint8Array, scale = 1): void {
  const plain = identityRead(occ, bytes, scale, 'plain')
  const caf = identityRead(occ, bytes, scale, 'caf')
  // A floor, or two empty reads would agree vacuously.
  expect(plain.faceIds.length).toBeGreaterThan(0)
  expect(plain.faceIds.filter((id) => id !== undefined).length).toBeGreaterThan(0)
  expect(caf.faceIds).toEqual(plain.faceIds)
  expect(caf.faceNames).toEqual(plain.faceNames)
  expect(caf.edgeNames).toEqual(plain.edgeNames)
  expect(caf.volume).toBeCloseTo(plain.volume, 9)
}

/** Two copies of one box (a repeated instance shares its TShape) plus a
 *  distinct box: the multi-root and repeated-instance cases in one file. */
function generatedAssemblyBytes(occ: OccModule): Uint8Array {
  const scope = new DisposeScope()
  try {
    const part = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
    const mover = scope.track(
      new occ.BRepBuilderAPI_Transform_2(part, makeTranslationTrsf(occ, scope, 40, 0, 0), false, false),
    )
    const other = makeBoxAt(occ, scope, [0, 30, 0], 5, 6, 7)
    const builder = scope.track(new occ.BRep_Builder())
    const compound = scope.track(new occ.TopoDS_Compound())
    builder.MakeCompound(compound)
    builder.Add(compound, part)
    builder.Add(compound, mover.Shape())
    builder.Add(compound, other)
    return stepShapeToBytes(occ, scope, compound)
  } finally {
    scope.dispose()
  }
}

describe.skipIf(!oc)('OversolvedStepCaf keeps the plain reader identity (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('knows at least the original fixture', () => {
    expect(fixtureFiles()).toContain('double_with_hole.step')
  })

  for (const file of fixtureFiles()) {
    it(`${file}: same face ids, names, edge names and volume`, () => {
      expectSameIdentity(occ, new Uint8Array(readFileSync(new URL(file, FIXTURES))))
    })
  }

  it('converts an inch file to millimetres exactly as the plain reader does', () => {
    // double_with_hole_inch.step is the same file with its length unit declared
    // as INCH, so a reader left in another length unit would show up as a
    // volume off by a power of 25.4.
    const mm = identityRead(occ, new Uint8Array(readFileSync(new URL('double_with_hole.step', FIXTURES))), 1, 'caf')
    const inch = identityRead(occ, new Uint8Array(readFileSync(new URL('double_with_hole_inch.step', FIXTURES))), 1, 'caf')
    expect(inch.volume / mm.volume).toBeCloseTo(25.4 ** 3, 3)
  })

  it('double_with_hole.step scaled: the identity survives the transform copy', () => {
    expectSameIdentity(occ, new Uint8Array(readFileSync(new URL('double_with_hole.step', FIXTURES))), 2.5)
  })

  it('a generated multi-root file with a repeated instance', () => {
    expectSameIdentity(occ, generatedAssemblyBytes(occ))
  })

  it('the repeated instance scaled: each placement keeps its own ids through the copy', () => {
    expectSameIdentity(occ, generatedAssemblyBytes(occ), 2.5)
    const read = identityRead(occ, generatedAssemblyBytes(occ), 2.5, 'caf')
    // Every face of both placements is named, not only the first placement's.
    expect(read.faceIds.every((id) => id !== undefined)).toBe(true)
    // The plain read shares the pairing, so equality alone cannot catch a
    // placement collapse: the two copies must also stay apart by name.
    expect(new Set(read.faceNames).size).toBe(read.faceNames.length)
    expect(read.faceIds.length).toBe(18)
  })
})
