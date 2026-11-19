// @vitest-environment node
//
// Gated real-OCC tests for the body colour a STEP import takes from its file
// (occ/importColor.ts, read through OversolvedStepCaf in occ/stepIo.ts). The
// fixtures are double_with_hole.step and two OCCT-written assemblies with
// presentation entities added by hand (STYLED_ITEM -> ... -> COLOUR_RGB):
//
//   color_solid.step           (a) the solid alone is #808080
//   color_faces.step           (b) six faces #cc3333, the smallest #3333cc
//   color_solid_and_face.step  (c) solid #33cc33, one face #3333cc
//   color_two_solids.step      (d) a 10^3 box #cc3333, a 4x5x6 box #3333cc
//   color_instance.step        (e) one part placed twice: the part #808080,
//                                  the second placement overridden #cc3333
//                                  (OVER_RIDING_STYLED_ITEM whose
//                                  PRESENTATION_STYLE_BY_CONTEXT names the
//                                  placement's own SHAPE_REPRESENTATION, the
//                                  form OCCT's reader takes as an instance style)
//   double_with_hole.step      (f) no colour at all
//
// #808080 is the linear/sRGB trap: COLOUR_RGB values are sRGB, OCCT keeps
// linear RGB since 7.5, and a reader that took Red()/Green()/Blue() would hand
// back about #373737.
//
// Skips when OCC is absent. Install:
//   just install-occ

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { volumeAndCentroidOf } from '../../occ/volume'
import { stepBytesToShapeWithIdentity } from '../../occ/stepIo'
import { canonicalFaces } from '../../occ/partNames'
import { faceArea } from '../../occ/primitives'
import { SharedHarness } from '../../occ/sharedHarness'
import { Repository } from '../../query'
import { solveImportStep } from '../importStep'
import type { PartSolid } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../occ/__fixtures__/${name}`, import.meta.url)))
}

interface ImportedBody {
  id: string
  color: string | undefined
  volume: number
  centroid: [number, number, number]
}

interface Imported {
  bodies: ImportedBody[]
  note: string | undefined
}

/** Run the import leaf on one fixture and read each body's colour back. */
function importFixture(occ: OccModule, name: string, scale = 1): Imported {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const partStore: Record<string, PartSolid> = {}
    const result = solveImportStep(
      occ, scope, table, { id: 'imp', file_id: 'f', scale }, new Repository(), partStore, new Map([['f', fixture(name)]]),
    )
    return {
      bodies: result.body_ids.map((id) => {
        const part = partStore[id]
        const { volume, centroid } = volumeAndCentroidOf(occ, scope, table.get<OccShape>(part.shape!))
        return { id, color: part.import_color, volume, centroid: centroid as [number, number, number] }
      }),
      note: result.solver_note as string | undefined,
    }
  } finally {
    scope.dispose()
    table.disposeAll()
  }
}

describe.skipIf(!oc)('STEP import colours (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('reads a file sRGB #808080 back as #808080 on every face and the solid', () => {
    const scope = new DisposeScope()
    try {
      const read = stepBytesToShapeWithIdentity(occ, scope, fixture('color_solid.step'))
      scope.track(read.shape)
      const faces = canonicalFaces(occ, scope, read.shape)
      expect(faces.length).toBe(7)
      for (const face of faces) expect(read.faceColors.get(face)).toBe(0x808080)
      expect([...read.solidColors.values()]).toEqual([0x808080])
    } finally {
      scope.dispose()
    }
  })

  it('(a) a solid colour alone becomes the body colour, with no note', () => {
    const imported = importFixture(occ, 'color_solid.step')
    expect(imported.bodies.map((b) => b.color)).toEqual(['#808080'])
    expect(imported.note).toBeUndefined()
  })

  it('(a) keeps the colour through a scaled import', () => {
    expect(importFixture(occ, 'color_solid.step', 2.5).bodies.map((b) => b.color)).toEqual(['#808080'])
  })

  it('(b) face colours only: the majority by area wins and the note names the dropped colour', () => {
    // The fixture's premise: the one blue face is a minority of the area.
    const scope = new DisposeScope()
    try {
      const read = stepBytesToShapeWithIdentity(occ, scope, fixture('color_faces.step'))
      scope.track(read.shape)
      let red = 0
      let blue = 0
      for (const face of canonicalFaces(occ, scope, read.shape)) {
        const area = faceArea(occ, scope, face as OccShape)
        if (read.faceColors.get(face) === 0xcc3333) red += area
        else if (read.faceColors.get(face) === 0x3333cc) blue += area
        else throw new Error('every face of color_faces.step is coloured')
      }
      expect(blue).toBeGreaterThan(0)
      expect(red).toBeGreaterThan(blue)
      expect(read.solidColors.size).toBe(0)
    } finally {
      scope.dispose()
    }
    const imported = importFixture(occ, 'color_faces.step')
    expect(imported.bodies.map((b) => b.color)).toEqual(['#cc3333'])
    expect(imported.note).toMatch(/^body body_imp takes #cc3333 from the STEP file \(\d+% of its face area\); 1 other colour dropped \(#3333cc\)$/)
  })

  it('(c) a solid colour with one differently coloured face: the face keeps its own, the body the solid', () => {
    const scope = new DisposeScope()
    try {
      const read = stepBytesToShapeWithIdentity(occ, scope, fixture('color_solid_and_face.step'))
      scope.track(read.shape)
      const colors = canonicalFaces(occ, scope, read.shape).map((f) => read.faceColors.get(f))
      expect(colors.filter((c) => c === 0x3333cc)).toHaveLength(1)
      expect(colors.filter((c) => c === 0x33cc33)).toHaveLength(6)
      expect([...read.solidColors.values()]).toEqual([0x33cc33])
    } finally {
      scope.dispose()
    }
    const imported = importFixture(occ, 'color_solid_and_face.step')
    expect(imported.bodies.map((b) => b.color)).toEqual(['#33cc33'])
    expect(imported.note).toContain('1 other colour dropped (#3333cc)')
  })

  it('(d) two solids keep their own colours, body by body', () => {
    const imported = importFixture(occ, 'color_two_solids.step')
    expect(imported.bodies).toHaveLength(2)
    const byVolume = new Map(imported.bodies.map((b) => [Math.round(b.volume), b.color]))
    expect(byVolume.get(1000)).toBe('#cc3333')
    expect(byVolume.get(120)).toBe('#3333cc')
    expect(imported.note).toBeUndefined()
  })

  it('(e) a referenced part takes its part colour, and an instance override wins on its placement', () => {
    const imported = importFixture(occ, 'color_instance.step')
    expect(imported.bodies).toHaveLength(2)
    const byX = [...imported.bodies].sort((p, q) => p.centroid[0] - q.centroid[0])
    // The file places the part at x = 0 (NAUO '3') and x = 40 (NAUO '4', the
    // overridden one).
    expect(byX.map((b) => b.color)).toEqual(['#808080', '#cc3333'])
  })

  it('(e) scaled: the override stays on its own placement through the transform copy', () => {
    const imported = importFixture(occ, 'color_instance.step', 2.5)
    const byX = [...imported.bodies].sort((p, q) => p.centroid[0] - q.centroid[0])
    expect(byX.map((b) => b.color)).toEqual(['#808080', '#cc3333'])
  })

  it('(f) an uncoloured file sets no colour and no note', () => {
    const imported = importFixture(occ, 'double_with_hole.step')
    expect(imported.bodies.map((b) => b.color)).toEqual([undefined])
    expect(imported.note).toBeUndefined()
  })

  it('carries the colour to the body result of a full build', () => {
    const h = new SharedHarness(occ)
    const r = h.run({
      features: [{ id: 'imp', kind: 'import_step', file_id: 'f' }],
    }, { files: new Map([['f', fixture('color_two_solids.step')]]) })
    expect(h.res(r, 'imp').status).toBe('ok')
    const colors = Object.keys(r.bodies as Record<string, unknown>).map((id) => h.part(r, id).import_color).sort()
    expect(colors).toEqual(['#3333cc', '#cc3333'])
  }, 60000)
})
