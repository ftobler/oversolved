// @vitest-environment node
//
// Face projection against a real B-rep. The box + hole fixture is the project
// review's, keyed by geometry: the front face (z = 0) is 40 x 10 with the r3
// hole, so a 2 mm extrusion of its projected wire is (400 - 9 pi) * 2. The
// scenarios follow the design rules: one live constraint, members derived per
// solve, a vanished edge keeps its id (orphan), a broken upstream reports, and
// delete either freezes (constraint) or excludes (one member).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  applyAddSketch, applyMoveFeatureBefore, applySetFeatureSuppression,
} from '@/utils/yamlMutations/featureAdmin'
import {
  applyAddConstraint, applyAddEntity, applyAddProjectedEntity, applyDeleteElements,
  applySetConstraintValue,
} from '@/utils/yamlMutations/sketch'
import { applySolveToDoc } from '@/drive/solveWriteBack'
import { docHashOf } from '@/drive/docHash'
import { faceProjectionConstraintId, faceBoundaryFromBodies, edgeUuidToken } from '../projectionMembers'
import type { PartDoc, PartFeature, SketchFeature } from '@/types/cad'
import {
  BOX_BODY_ID, BOX_EXTRUDE_ID, BOX_SKETCH_ID,
  bodyVolume, oc, projectionBaseDoc, projectionTestHarness, solveBytes,
} from './projectionRealSupport'
import type { BuildResponse } from '../../builder'

const { h, base } = projectionTestHarness()

type SketchOut = {
  geometry?: Record<string, number[]>
  projection_errors?: string[]
  projection_members?: Record<string, {
    members: Record<string, string>
    entities: Array<{ id: string; kind: string; params: number[] }>
    orphans: string[]
  }>
  dropped_constraints?: Array<{ id: string; kind: string; reason: string }>
}

const run = (doc: PartDoc) => h.run(doc as unknown as Record<string, unknown>)
const sketchOf = (result: BuildResponse, id: string): SketchOut =>
  h.res(result, id) as SketchOut

function sketchFeature(doc: PartDoc, id: string): SketchFeature {
  const found = (doc.features ?? []).find(f => f.id === id)
  if (!found) throw new Error(`document has no feature ${id}`)
  return found as SketchFeature
}

function addExtrude(doc: PartDoc, id: string, sketchId: string, distance: number, operation = 'new'): void {
  doc.features!.push({
    id, kind: 'extrude', label: 'Extrude',
    extrude: { sketch: `@${sketchId}`, distance, direction: 'normal', operation },
  } as unknown as PartFeature)
}

function addFillet(doc: PartDoc, id: string, edge: string, radius = 2): void {
  doc.features!.push({
    id, kind: 'fillet', label: 'Fillet',
    fillet: { edges: [edge], radius },
  } as unknown as PartFeature)
}

/** The boundary the UI/drive would hand the applier: the base body's mesh. */
function addFaceProjection(
  doc: PartDoc,
  baseResult: BuildResponse,
  sketchId: string,
  faceQuery: string,
): string {
  applyAddSketch(doc, sketchId, 'Projection', '@builtin_plane_front')
  const body = h.body(baseResult, BOX_BODY_ID)
  applyAddProjectedEntity(doc, sketchId, '', faceQuery, undefined, undefined, {
    faceBoundary: faceBoundaryFromBodies(() => ({ [BOX_BODY_ID]: body })),
  })
  const cid = faceProjectionConstraintId(faceQuery)
  if (cid === null) throw new Error('face query carries no construction UUID')
  return cid
}

function reportOf(sketch: SketchOut, cid: string) {
  const report = sketch.projection_members?.[cid]
  if (!report) throw new Error(`solve reported no members for ${cid}`)
  return report
}

/** The x extent of the line members (the projected rectangle's width). Circle
 *  and point blocks have other lengths, so they do not enter the span. */
function profileExtent(sketch: SketchOut): number {
  const xs = Object.values(sketch.geometry ?? {})
    .flatMap(values => values.length === 4 ? [values[0], values[2]] : [])
  return Math.max(...xs) - Math.min(...xs)
}

/** The front face's left edge, running along y at x = 0, z = 0. A fillet on it
 *  replaces it with an arc ON THE FRONT FACE, which is what makes the live-add
 *  case observable. */
function frontLeftEdge(baseResult: BuildResponse): string {
  const body = h.body(baseResult, BOX_BODY_ID) as {
    edges?: Array<{ kind: string; start: number[]; end: number[] }>
    edge_queries?: string[]
  }
  const edges = body.edges ?? []
  const queries = body.edge_queries ?? []
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]
    if (edge.kind !== 'line') continue
    const atLeft = Math.abs(edge.start[0]) <= 1e-6 && Math.abs(edge.end[0]) <= 1e-6
    const atFront = Math.abs(edge.start[2]) <= 1e-6 && Math.abs(edge.end[2]) <= 1e-6
    const alongY = Math.abs(edge.start[1] - edge.end[1]) > 1e-6
    if (atLeft && atFront && alongY) return queries[i]
  }
  throw new Error('base body: no front-left vertical edge')
}

function lineMember(report: { entities: Array<{ id: string; kind: string }> }): string {
  const line = report.entities.filter(e => e.kind === 'line').map(e => e.id).sort()[0]
  if (line === undefined) throw new Error('no line member')
  return line
}

describe.skipIf(!oc || !solveBytes)('face projection (real OCC + Rust solver)', () => {
  it('9. a face pick is one live constraint deriving the boundary and the hole', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    addExtrude(doc, 'exF', 'skP', 2)

    const result = run(doc)
    const sketch = sketchOf(result, 'skP')
    const report = reportOf(sketch, cid)
    expect(sketch.projection_errors).toBeUndefined()
    // The 40 x 10 front face: four lines plus the r3 hole circle, and no seam
    // (a flat face has none) and no centroid point.
    expect(report.entities.map(e => e.kind).sort()).toEqual(['circle', 'line', 'line', 'line', 'line'])
    const row = sketchFeature(doc, 'skP')
    expect(row.entities).toEqual([])
    expect(row.constraints).toHaveLength(1)
    expect(Object.keys(row.constraints![0].members ?? {})).toHaveLength(5)
    expect(h.res(result, 'exF').status).toBe('ok')
    // 40 x 10 minus the r3 bore, 2 mm deep.
    expect(bodyVolume(h, result, 'exF', 'body_exF')).toBeCloseTo((400 - 9 * Math.PI) * 2, 4)
  })

  it('10. a cut inserted upstream adds an arc member and keeps the wire closed', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const before = sketchOf(run(doc), 'skP')
    const beforeReport = reportOf(before, cid)

    // A cylinder cut through the top edge of the front face: the wire keeps its
    // lines and gains the arc where the bore opens the boundary.
    const insertAt = doc.features!.findIndex(f => f.id === 'skP')
    doc.features!.splice(insertAt, 0, {
      id: 'skCut', kind: 'sketch', label: 'Notch', plane: '@builtin_plane_front',
      entities: [{ id: 'n1', kind: 'circle' }],
      initial: { n1: [20, 0, 3] },
      constraints: [],
    } as unknown as PartFeature, {
      id: 'exCut', kind: 'extrude', label: 'Notch',
      extrude: {
        sketch: '@skCut', distance: 20, direction: 'reverse',
        termination: 'through_all', operation: 'cut',
      },
    } as unknown as PartFeature)
    addExtrude(doc, 'exF', 'skP', 2)

    const result = run(doc)
    const report = reportOf(sketchOf(result, 'skP'), cid)
    expect(report.entities.filter(e => e.kind === 'arc').length).toBeGreaterThanOrEqual(1)
    expect(report.entities.length).toBeGreaterThan(beforeReport.entities.length)
    expect(h.res(result, 'exF').status).toBe('ok')
    const volume = bodyVolume(h, result, 'exF', 'body_exF')
    expect(volume).toBeGreaterThan(0)
    // The notch removed area, so the extruded profile is smaller.
    expect(volume).toBeLessThan((400 - 9 * Math.PI) * 2)
  })

  it('11. a width edit upstream moves the members, keeps their ids, and a dimension holds', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const first = sketchOf(run(doc), 'skP')
    const firstReport = reportOf(first, cid)
    const member = lineMember(firstReport)
    const ids = Object.values(firstReport.members).sort()

    applyAddEntity(doc, 'skP', 'point', [60, 60], 'u1')
    applyAddConstraint(
      doc, 'skP', 'point_distance_x',
      ['vertex:skP:u1:xy', `vertex:skP:${member}:start`], 5,
    )
    const before = run(doc)
    const beforeSketch = sketchOf(before, 'skP')
    const beforePoint = beforeSketch.geometry!.u1
    const beforeStart = beforeSketch.geometry![member]
    expect(Math.abs(beforePoint[0] - beforeStart[0])).toBeCloseTo(5, 4)

    applySetConstraintValue(doc, BOX_SKETCH_ID, 'c9', 50)
    const after = sketchOf(run(doc), 'skP')
    const afterReport = reportOf(after, cid)
    expect(Object.values(afterReport.members).sort()).toEqual(ids)
    // The projected wire followed the wider box: the profile's x extent grew by
    // 10, and the point still sits 5 to the right of its member's start.
    expect(profileExtent(after)).toBeCloseTo(profileExtent(beforeSketch) + 10, 4)
    const afterPoint = after.geometry!.u1
    expect(afterPoint[0] - after.geometry![member][0]).toBeCloseTo(5, 4)
    expect(after.dropped_constraints ?? []).toEqual([])
  })

  it('12. a settled document re-solves bit-identically and the write-back installs nothing', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    addExtrude(doc, 'exF', 'skP', 2)

    const first = run(doc)
    const firstWrite = applySolveToDoc(doc, first)
    expect(firstWrite.geometryMoved).toBe(true)
    const settled = firstWrite.doc
    const settledHash = docHashOf(settled)
    const second = run(settled)
    const secondWrite = applySolveToDoc(settled, second)
    expect(secondWrite.geometryMoved).toBe(false)
    expect(secondWrite.movedFeatureIds).toEqual([])
    expect(secondWrite.doc).toEqual(settled)
    expect(docHashOf(secondWrite.doc)).toBe(settledHash)
  })

  it('13. a filleted-away edge leaves an orphan, drops its constraining row, and undo restores it', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const first = sketchOf(run(doc), 'skP')
    const firstReport = reportOf(first, cid)
    const vanishedEdge = frontLeftEdge(baseResult)
    const token = edgeUuidToken(vanishedEdge)
    if (token === null) throw new Error('fillet edge carries no construction token')
    const member = firstReport.members[token]
    expect(member).toBeDefined()

    applyAddEntity(doc, 'skP', 'point', [5, 5], 'u1')
    applyAddConstraint(doc, 'skP', 'coincident', ['vertex:skP:u1:xy', `vertex:skP:${member}:start`])
    const coincidentId = sketchFeature(doc, 'skP').constraints!.at(-1)!.id
    const before = structuredClone(doc)

    addFillet(doc, 'fil1', vanishedEdge, 2)
    applyMoveFeatureBefore(doc, 'fil1', 'skP')
    const editHash = docHashOf(doc)
    const result = run(doc)
    const report = reportOf(sketchOf(result, 'skP'), cid)
    // The id survives in the map (so a restored edge gets it back) but yields
    // no geometry this solve, and the row naming it is reported dropped.
    expect(report.members[token]).toBe(member)
    expect(report.entities.some(entity => entity.id === member)).toBe(false)
    expect(report.orphans).toContain(token)
    expect((sketchOf(result, 'skP').dropped_constraints ?? []).map(d => d.id)).toContain(coincidentId)
    // The solve never writes the document: the fillet edit is the only change.
    expect(docHashOf(doc)).toBe(editHash)

    const restored = run(before)
    const restoredReport = reportOf(sketchOf(restored, 'skP'), cid)
    expect(restoredReport.entities.some(entity => entity.id === member)).toBe(true)
    expect((sketchOf(restored, 'skP').dropped_constraints ?? []).map(d => d.id)).not.toContain(coincidentId)
  })

  it('14. a broken upstream face drops the members and the return brings the same ids', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const firstReport = reportOf(sketchOf(run(doc), 'skP'), cid)
    const ids = Object.values(firstReport.members).sort()
    applyAddEntity(doc, 'skP', 'point', [5, 5], 'u1')
    applyAddConstraint(doc, 'skP', 'coincident', ['vertex:skP:u1:xy', `vertex:skP:${lineMember(firstReport)}:start`])
    const beforeHash = docHashOf(doc)

    applySetFeatureSuppression(doc, BOX_EXTRUDE_ID, true)
    const brokenHash = docHashOf(doc)
    const broken = sketchOf(run(doc), 'skP')
    expect(broken.projection_errors).toContain(cid)
    expect(reportOf(broken, cid).entities).toEqual([])
    expect((broken.dropped_constraints ?? []).length).toBeGreaterThan(0)
    expect(docHashOf(doc)).toBe(brokenHash)

    applySetFeatureSuppression(doc, BOX_EXTRUDE_ID, false)
    const back = sketchOf(run(doc), 'skP')
    expect(back.projection_errors).toBeUndefined()
    expect(Object.values(reportOf(back, cid).members).sort()).toEqual(ids)
    expect((back.dropped_constraints ?? [])).toEqual([])
    expect(docHashOf(doc)).toBe(beforeHash)
  })

  it('15. deleting the constraint freezes the members at their ids and stops following', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const firstReport = reportOf(sketchOf(run(doc), 'skP'), cid)
    const member = lineMember(firstReport)
    applyAddEntity(doc, 'skP', 'point', [5, 5], 'u1')
    applyAddConstraint(doc, 'skP', 'coincident', ['vertex:skP:u1:xy', `vertex:skP:${member}:start`])
    run(doc)
    const liveReport = reportOf(sketchOf(run(doc), 'skP'), cid)
    const liveSnapshot = structuredClone(doc)
    const frozenX = sketchOf(run(doc), 'skP').geometry![member][0]

    applyDeleteElements(doc, [`constraint:skP:${cid}`], liveReport.entities)
    const row = sketchFeature(doc, 'skP')
    expect(row.constraints?.some(c => c.id === cid)).toBe(false)
    expect(row.entities?.map(e => e.id).sort()).toEqual([...liveReport.entities.map(e => e.id), 'u1'].sort())
    expect(row.initial?.[member]).toHaveLength(4)

    applySetConstraintValue(doc, BOX_SKETCH_ID, 'c9', 50)
    const after = sketchOf(run(doc), 'skP')
    // The frozen rows are plain geometry now: a live projection would move 10 mm
    // with the wider box, while the frozen row stays near its baked position.
    expect(Math.abs(after.geometry![member][0] - frozenX)).toBeLessThan(5)
    // The coincident authored against the member id still holds.
    expect(after.geometry!.u1[0]).toBeCloseTo(after.geometry![member][0], 4)
    expect((after.dropped_constraints ?? [])).toEqual([])

    const undo = run(liveSnapshot)
    const undoReport = reportOf(sketchOf(undo, 'skP'), cid)
    expect(undoReport.entities).toHaveLength(firstReport.entities.length)
    expect(sketchFeature(liveSnapshot, 'skP').entities?.map(e => e.id)).toEqual(['u1'])
  })

  it('16. deleting one member records its exclusion and a re-solve never re-adds it', () => {
    const { result: baseResult, geometry } = base()
    const doc = projectionBaseDoc()
    const cid = addFaceProjection(doc, baseResult, 'skP', geometry.frontFace)
    const firstReport = reportOf(sketchOf(run(doc), 'skP'), cid)
    const member = lineMember(firstReport)
    const token = Object.entries(firstReport.members).find(([, id]) => id === member)?.[0]
    expect(token).toBeDefined()
    const liveSnapshot = structuredClone(doc)

    applyDeleteElements(doc, [`entity:skP:${member}`])
    const row = sketchFeature(doc, 'skP')
    expect(row.constraints?.[0].excluded).toEqual([token])
    expect(row.entities ?? []).toEqual([])

    const after = reportOf(sketchOf(run(doc), 'skP'), cid)
    expect(after.entities.some(entity => entity.id === member)).toBe(false)
    expect(after.members[token!]).toBeUndefined()

    const undo = reportOf(sketchOf(run(liveSnapshot), 'skP'), cid)
    expect(undo.entities.some(entity => entity.id === member)).toBe(true)
  })
})
