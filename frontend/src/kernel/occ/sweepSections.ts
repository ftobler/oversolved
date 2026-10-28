// The multisection sweep's brep producer: one pipe shell through two or more
// section wires placed along the spine, with the profile interpolated between
// the stations (BRepFill_NSections' behaviour inside MakePipeShell).
//
// It lives beside prismLineage.ts rather than in it because the single-profile
// sweep path there is already near the file-size budget and must stay
// byte-identical. Naming follows D6 of the plan: side faces come from ONE
// naming section (the richest, earliest on a tie), caps from their own end
// sections.
//
// There is no geometric fallback: a measured fallback (joining each section
// into one C0 spline edge) builds a valid but wrong solid, so a failure is a
// named error instead.

import type { DisposeScope } from './disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccOrientableShape, OccShape } from './occTypes'
import type { PlaneLike } from '../features/shared/planes'
import type { LoopEdge } from '../profileLoops'
import type { Vec3 } from './primitives'
import { faceArea, healWire, makeWire } from './primitives'
import { sketchLoopsToFace } from './prismProfile'
import {
  attemptPipeShellSweep,
  buildPrismLineageMap,
  prefixLineageMaps,
  type LineageResult,
} from './prismLineage'
import { countSolids } from './booleans'
import { volumeOf } from './volume'

/** One section as the station finder ordered it: its plane, its outer loop and
 *  the spine direction at its station (used only to orient the wire). */
export type SweepSection = {
  sketchId: string
  plane: PlaneLike
  loop: LoopEdge[]
  tangent: Vec3
}

// The plausibility gate is loose on purpose: it is a guard against a grossly
// twisted skin, not a volume oracle. A twisted skin passes BRepCheck, which is
// why the gate exists at all.
const PLAUSIBILITY_FACTOR = 1.5
const SPINE_LENGTH_SAMPLES = 64

type PreparedSection = {
  section: SweepSection
  face: OccShape
  wire: OccShape
  edges: number
  area: number
  tokens: string[]
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Chord-summed length of the built spine, for the plausibility gate. */
function spineLength(oc: OccModule, scope: DisposeScope, spineEdges: OccShape[]): number {
  let total = 0
  for (const edge of spineEdges) {
    const ad = scope.track(new oc.BRepAdaptor_Curve_2(edge))
    const u0 = ad.FirstParameter()
    const u1 = ad.LastParameter()
    let prev: Vec3 | null = null
    for (let i = 0; i <= SPINE_LENGTH_SAMPLES; i++) {
      const u = u0 + ((u1 - u0) * i) / SPINE_LENGTH_SAMPLES
      const p = ad.Value(u)
      const v: Vec3 = [p.X(), p.Y(), p.Z()]
      p.delete()
      if (prev !== null) total += dist3(prev, v)
      prev = v
    }
  }
  return total
}

function wireEdgeCount(oc: OccModule, scope: DisposeScope, wire: OccShape): number {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) n++
  return n
}

/** The section's own entity ids as construction tokens. They are pre-qualified
 *  so the naming prefix pass leaves them alone: a cap belongs to its section,
 *  not to the naming section. */
function sectionTokens(section: SweepSection): string[] {
  const ids = section.loop
    .map((edge) => edge['id'] as string | undefined)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return [...new Set(ids)].sort().map((id) => `@${section.sketchId}/${id}`)
}

/** Build one section's healed outer wire, oriented so its face normal agrees
 *  with the spine tangent at the station. A reversed section would twist the
 *  skin, so the direction is fixed here rather than left to OCC. */
function prepareSection(
  oc: OccModule,
  scope: DisposeScope,
  section: SweepSection,
): PreparedSection {
  const face = scope.track(sketchLoopsToFace(oc, scope, [section.loop], section.plane))
  const raw = scope.track(oc.BRepTools.OuterWire(face))
  let wire = scope.track(healWire(oc, scope, raw))
  scope.release(raw)
  const dot =
    section.plane.normal[0] * section.tangent[0] +
    section.plane.normal[1] * section.tangent[1] +
    section.plane.normal[2] * section.tangent[2]
  if (dot < 0) {
    const flipped = scope.track((wire as OccOrientableShape).Reversed())
    scope.release(wire)
    wire = flipped
  }
  return {
    section,
    face,
    wire,
    edges: wireEdgeCount(oc, scope, wire),
    area: faceArea(oc, scope, face),
    tokens: sectionTokens(section),
  }
}

/**
 * Refuse neighbouring sections whose vertex pairing OCC cannot make: two wires
 * with different edge counts both above one. A single closed edge (a circle)
 * is exempt because OCC can split it to any count, which is why the handle's
 * circle-to-rounded-rectangle joins work.
 *
 * Measured on the shipped 7.4: an 8/4 alternation does NOT throw in OCC, it
 * builds a valid but wrong 28-face solid, so this check cannot wait for the
 * build to fail.
 */
function refuseUnmatchable(prepared: PreparedSection[]): void {
  for (let i = 0; i + 1 < prepared.length; i++) {
    const a = prepared[i].edges
    const b = prepared[i + 1].edges
    if (a > 1 && b > 1 && a !== b) {
      throw new Error(
        `sweep: the sections could not be matched (edge counts ${a} at station ${i + 1}, ` +
        `${b} at station ${i + 2}): OCC could not pair their vertices; ` +
        `give neighbouring sections the same number of edges`,
      )
    }
  }
}

export type SweepSectionsResult = LineageResult & { namingSketchId: string }

/**
 * Sweep two or more section wires along the spine and return (solid +
 * construction-name maps). Sections must already be in station order.
 * OWNERSHIP: the returned `solid` is UNTRACKED; the caller tracks it or hands
 * it to `applyBodyOperation`, the same contract the other producers keep.
 */
export function sweepSectionsWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  sections: SweepSection[],
  spineEdges: OccShape[],
  createdBy = '',
  roundCorners = false,
): SweepSectionsResult {
  if (sections.length < 2) throw new Error('sweep: multisection needs at least two sections')
  if (spineEdges.length === 0) throw new Error('sweep: empty path')

  const prepared = sections.map((section) => prepareSection(oc, scope, section))
  refuseUnmatchable(prepared)

  const rawSpineWire = scope.track(makeWire(oc, scope, spineEdges))
  const spineWire = scope.track(healWire(oc, scope, rawSpineWire))
  scope.release(rawSpineWire)

  // A round corner falls back to the mitre like the mitre falls back to
  // Transformed, so a refused arc never turns a buildable sweep into an error.
  const modes = [
    ...(roundCorners ? [oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner] : []),
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
  ]
  const { result, lastError } = attemptPipeShellSweep(
    oc, scope, spineWire, prepared.map((p) => p.wire), modes,
  )
  if (lastError !== null) {
    const msg = extractErrorMessage(lastError)
    throw new Error(`sweep: BRepOffsetAPI_MakePipeShell failed: ${msg}`)
  }
  if (result === null) throw new Error('sweep: could not build a solid from the swept shell')
  const { solid, pipeBuilder } = result
  // The shell builder holds its own handle to the spine wire.
  scope.release(spineWire)

  // A twisted skin passes BRepCheck, so the acceptance bar is geometric: one
  // solid and no more material than the largest section could carry.
  const maxArea = Math.max(...prepared.map((p) => p.area))
  const volume = volumeOf(oc, scope, solid)
  if (
    countSolids(oc, scope, solid) !== 1 ||
    !(volume > 0) ||
    volume > maxArea * spineLength(oc, scope, spineEdges) * PLAUSIBILITY_FACTOR
  ) {
    throw new Error('sweep: multisection result is self-intersecting')
  }

  // Identity follows the richest section, earliest on a tie: a circle would
  // otherwise name every wall through split ordering, and the eight rectangle
  // entities should own their own walls.
  let naming = prepared[0]
  for (const p of prepared) {
    if (p.edges > naming.edges) naming = p
  }
  const lineage = buildPrismLineageMap(
    oc, scope, naming.face, pipeBuilder, [naming.section.loop], naming.section.plane,
    createdBy, naming.section.sketchId, 0, naming.wire,
    { start: prepared[0].tokens, end: prepared[prepared.length - 1].tokens },
  )
  prefixLineageMaps(lineage, naming.section.sketchId ? `@${naming.section.sketchId}/` : '@')

  for (const p of prepared) {
    scope.release(p.wire)
    scope.release(p.face)
  }
  return { solid, ...lineage, namingSketchId: naming.section.sketchId }
}
