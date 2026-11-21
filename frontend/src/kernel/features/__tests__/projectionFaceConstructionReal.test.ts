// @vitest-environment node
//
// The face-projection construction flag at the real kernel boundary. The repro
// is the practice finding: a 60 x 40 x 10 block, a sketch on its top face
// projected whole as construction, a 30 x 20 pocket dimensioned 10 from two
// wire edges, and a 4 mm cut. As profile geometry the projected wire wraps the
// pocket, so the cut removes the ring (24000 -> 16800); as construction it
// bounds nothing, so the cut removes the pocket alone (21600). A later width
// edit must keep the wire following without changing what is removed.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect } from 'vitest'
import {
  applyAddConstraint, applyAddProjectedEntity, applyAddRect, applySetConstraintValue,
} from '@/utils/yamlMutations/sketch'
import { applyFreezeProjection } from '@/utils/yamlMutations/freezeProjection'
import { applyAddSketch } from '@/utils/yamlMutations/featureAdmin'
import { applySolveToDoc } from '@/drive/solveWriteBack'
import { docHashOf } from '@/drive/docHash'
import type { PartDoc, PartFeature } from '@/types/cad'
import { faceBoundaryFromParts } from '../projectionMembers'
import {
  BOX_PART_ID, partVolume, oc, solveBytes, projectionTestHarness,
} from './projectionRealSupport'
import { rectSketchSk, extrudeSpec } from '../extrudeRealSupport'
import type { BuildResponse } from '../../builder'

const { h } = projectionTestHarness()

const WIDTH = 60
const HEIGHT = 40
const DEPTH = 10
const POCKET = { width: 30, height: 20, offset: 10, depth: 4 } as const
const FULL_VOLUME = WIDTH * HEIGHT * DEPTH
const POCKET_VOLUME = POCKET.width * POCKET.height * POCKET.depth
const RING_VOLUME = (WIDTH * HEIGHT - POCKET.width * POCKET.height) * POCKET.depth

type SketchOut = {
  geometry?: Record<string, number[]>
  status?: string
  projection_members?: Record<string, {
    entities: Array<{ id: string; kind: string; params: number[] }>
  }>
}

const run = (doc: PartDoc) => h.run(doc as unknown as Record<string, unknown>)
const sketchOf = (result: BuildResponse, id: string): SketchOut =>
  h.res(result, id) as SketchOut

/** The block fixture: 60 x 40 on Top, extruded 10. */
function blockDoc(width = WIDTH): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      rectSketchSk('sk1', width, HEIGHT, '@builtin_plane_top'),
      extrudeSpec('sk1', 'ex1', { distance: DEPTH, operation: 'new' }),
    ],
  } as unknown as PartDoc
}

function addCutExtrude(doc: PartDoc, id: string, sketchId: string, distance: number): void {
  doc.features!.push({
    id, kind: 'extrude', label: 'Pocket',
    extrude: {
      sketch: `@${sketchId}`, distance, direction: 'reverse', operation: 'cut',
    },
  } as unknown as PartFeature)
}

/** The +y cap of the block: outward normal +y at y = depth. */
function topFaceQuery(result: BuildResponse): string {
  const part = h.part(result, BOX_PART_ID) as {
    mesh?: {
      face_queries?: string[]
      face_data?: Array<{ normal: number[]; centroid: number[] }>
    }
  }
  const queries = part.mesh?.face_queries ?? []
  const data = part.mesh?.face_data ?? []
  const found = queries.filter((_, i) => {
    const face = data[i]
    return face !== undefined
      && face.normal[1] > 0.9
      && Math.abs(face.centroid[1] - DEPTH) <= 1e-6
  })
  if (found.length !== 1) throw new Error(`block: expected one top face, found ${found.length}`)
  return found[0]
}

/** The bottom and left wire edges in sketch-local coordinates, plus the two
 *  lines' ids: the pair the two 10 mm dimensions hold the pocket against. */
function wireEdges(report: { entities: Array<{ id: string; kind: string; params: number[] }> }) {
  const lines = report.entities.filter(e => e.kind === 'line')
  const horizontal = lines.filter(e => Math.abs(e.params[1] - e.params[3]) <= 1e-6)
  const vertical = lines.filter(e => Math.abs(e.params[0] - e.params[2]) <= 1e-6)
  if (horizontal.length === 0 || vertical.length === 0) throw new Error('top face: no line members')
  const bottom = [...horizontal].sort((a, b) => a.params[1] - b.params[1])[0]
  const left = [...vertical].sort((a, b) => a.params[0] - b.params[0])[0]
  return { bottom, left, minX: left.params[0], minY: bottom.params[1] }
}

/** The x extent of the projected wire alone (the rect rows are other ids), so
 *  a width edit upstream is visible as a wider wire, not just a bigger cut. */
function wireExtent(sketch: SketchOut): number {
  const memberIds = new Set(
    Object.values(sketch.projection_members ?? {}).flatMap(report => report.entities.map(e => e.id)),
  )
  const xs = Object.entries(sketch.geometry ?? {})
    .filter(([id, params]) => memberIds.has(id) && params.length === 4)
    .flatMap(([, params]) => [params[0], params[2]])
  return Math.max(...xs) - Math.min(...xs)
}

/** Build the repro through the appliers, solve once to read the derived wire,
 *  then author the pocket and the cut. */
function pocketDoc(construction: boolean, width = WIDTH): PartDoc {
  const baseResult = run(blockDoc(width))
  const topFace = topFaceQuery(baseResult)
  const doc = blockDoc(width)
  applyAddSketch(doc, 'sk2', 'Pocket', topFace)
  const part = h.part(baseResult, BOX_PART_ID)
  applyAddProjectedEntity(doc, 'sk2', '', topFace, undefined, undefined, {
    faceBoundary: faceBoundaryFromParts(() => ({ [BOX_PART_ID]: part })),
    construction,
  })

  const projection = sketchOf(run(doc), 'sk2').projection_members
  const report = Object.values(projection ?? {})[0]
  if (report === undefined) throw new Error('top face projection derived no members')
  const { bottom, left, minX, minY } = wireEdges(report)

  const p0: [number, number] = [minX + POCKET.offset, minY + POCKET.offset]
  const p1: [number, number] = [p0[0] + POCKET.width, p0[1] + POCKET.height]
  applyAddRect(doc, 'sk2', p0, p1, undefined, undefined, ['p1', 'p2', 'p3', 'p4'], true)
  // p1 is the bottom line and p4 the left line of the authored rectangle.
  // The signed side is the one inside the wire: the rect sits at +offset in
  // both local axes, while the solver's +1 is the opposite side on this face's
  // axis handedness.
  applyAddConstraint(
    doc, 'sk2', 'line_distance', ['entity:sk2:p1', `entity:sk2:${bottom.id}`], POCKET.offset,
    undefined, -1,
  )
  applyAddConstraint(
    doc, 'sk2', 'line_distance', ['entity:sk2:p4', `entity:sk2:${left.id}`], POCKET.offset,
    undefined, -1,
  )
  addCutExtrude(doc, 'exCut', 'sk2', POCKET.depth)
  return doc
}

describe.skipIf(!oc || !solveBytes)('face projection construction (real OCC + Rust solver)', () => {
  it('keeps the projected wire out of the profile, so the cut removes the pocket alone', () => {
    const profileDoc = pocketDoc(false)
    const profile = run(profileDoc)
    const profileSketch = sketchOf(profile, 'sk2')
    expect(profileSketch.status).toBe('fully_constrained')
    expect(partVolume(h, profile, 'exCut', BOX_PART_ID)).toBeCloseTo(FULL_VOLUME - RING_VOLUME, 4)
    expect(FULL_VOLUME - RING_VOLUME).toBeCloseTo(16800, 6)

    const constructionDoc = pocketDoc(true)
    const construction = run(constructionDoc)
    expect(sketchOf(construction, 'sk2').status).toBe('fully_constrained')
    expect(partVolume(h, construction, 'exCut', BOX_PART_ID)).toBeCloseTo(FULL_VOLUME - POCKET_VOLUME, 4)
    expect(FULL_VOLUME - POCKET_VOLUME).toBeCloseTo(21600, 6)
  })

  it('follows a width edit upstream with the flag and the pocket offset intact', () => {
    const doc = pocketDoc(true)
    const first = run(doc)
    expect(partVolume(h, first, 'exCut', BOX_PART_ID)).toBeCloseTo(21600, 4)
    const beforeExtent = wireExtent(sketchOf(first, 'sk2'))

    applySetConstraintValue(doc, 'sk1', 'c9', 80)
    const after = run(doc)
    // The wire follows the wider face and the pocket keeps its 10 mm gap: the
    // block gained 20 x 40 x 10 of material, the same 30 x 20 x 4 is removed.
    expect(wireExtent(sketchOf(after, 'sk2'))).toBeCloseTo(beforeExtent + 20, 4)
    expect(partVolume(h, after, 'exCut', BOX_PART_ID)).toBeCloseTo(32000 - POCKET_VOLUME, 4)
    expect(sketchOf(after, 'sk2').status).toBe('fully_constrained')
  })

  it('keeps the flag on the constraint through the solve write-back', () => {
    const doc = pocketDoc(true)
    run(doc)
    const feature = (doc.features ?? []).find(candidate => candidate.id === 'sk2')
    if (feature?.kind !== 'sketch') throw new Error('no sketch sk2')
    const projection = (feature.constraints ?? []).find(c => c.kind === 'projection')
    expect(projection?.construction).toBe(true)
  })

  it('freezes the wire into construction rows and keeps the volume', () => {
    const doc = pocketDoc(true)
    const solved = run(doc)
    const report = Object.values(sketchOf(solved, 'sk2').projection_members ?? {})[0]
    if (report === undefined) throw new Error('top face projection derived no members')
    const projection = ((doc.features ?? []).find(candidate => candidate.id === 'sk2'))
    if (projection?.kind !== 'sketch') throw new Error('no sketch sk2')
    const cid = (projection.constraints ?? []).find(c => c.kind === 'projection')?.id
    if (cid === undefined) throw new Error('no face projection constraint')

    applyFreezeProjection(doc, 'sk2', cid, 'fixed', report.entities)
    const frozen = (doc.features ?? []).find(candidate => candidate.id === 'sk2')
    if (frozen?.kind !== 'sketch') throw new Error('no sketch sk2')
    const memberIds = new Set(report.entities.map(entity => entity.id))
    const rows = (frozen.entities ?? []).filter(entity => memberIds.has(entity.id))
    expect(rows.length).toBe(report.entities.length)
    expect(rows.every(entity => entity.construction === true)).toBe(true)
    expect(frozen.constraints?.some(c => c.kind === 'projection')).toBe(false)

    const after = run(doc)
    // Frozen geometry is ordinary construction: it still bounds no profile, so
    // the cut removes the pocket alone.
    expect(partVolume(h, after, 'exCut', BOX_PART_ID)).toBeCloseTo(21600, 4)
  })

  it('never invents the key on a document that does not carry it', () => {
    // Existing documents carry no key and absent means profile. The solve and
    // its write-back must leave the bytes alone, so a settled doc hashes the
    // same on every later solve and stays free of `construction: false`.
    const doc = pocketDoc(false)
    const feature = (doc.features ?? []).find(candidate => candidate.id === 'sk2')
    if (feature?.kind !== 'sketch') throw new Error('no sketch sk2')
    expect((feature.constraints ?? []).every(c => c.construction === undefined)).toBe(true)

    const settled = applySolveToDoc(doc, run(doc)).doc
    const hash = docHashOf(settled)
    const again = applySolveToDoc(settled, run(settled)).doc
    expect(docHashOf(again)).toBe(hash)
    expect(JSON.stringify(again)).not.toContain('"construction":false')
  })
})
