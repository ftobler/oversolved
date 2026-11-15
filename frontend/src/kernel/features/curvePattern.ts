// The curve pattern leaf: resolve the path a pattern sweeps along, sample it,
// and hand the placements to the shared instance model. The spacing and
// orientation law lives in curvePatternPlacement.ts (pure); here the path picks
// and the `normal_to` direction are resolved and the copies become gp_Trsf.
//
// The path grammar is the sweep's: `orderedPathWorldEdges` / `collectPathEdges`
// resolve one ordered chain (or a bare helix), with the closed-curve arm a path
// pattern adds. A path that cannot be walked keeps the sweep's own sentences.
//
// The feature is `partial` when `distance` spacing runs past an open path's end:
// the instances that fit are built and the rest are named in one warning.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { makeRigidTrsf } from '../occ/transforms'
import { swallowUnlessTrap } from '../errors'
import { resolvePathSpine } from './sweep'
import { resolveSketchPlane } from './postRegister'
import { resolveDirectionQueryStrict } from './shared/directionQuery'
import { samplePath, spineSampler } from './shared/pathSampler'
import {
  pastEndWarning, placeOnPath,
  type CurveOrientation, type CurveSpacing, type Vec3,
} from './curvePatternPlacement'
import { instanceIndices, toInstances } from './patternInstances'
import {
  keptInstances, patternCountOf, patternNumber, solvePatternInstances,
  type Dict, type PatternCopy,
} from './pattern'
import type { PatternResult } from './patternFeature'
import type { BodyPatternResult } from './patternBody'

const ORIENTATIONS: readonly CurveOrientation[] = ['tangent', 'normal_to', 'fixed']

/**
 * The direction a `normal_to` pattern turns about. A plane (builtin, datum, or
 * a `?` face query) answers with its normal; a straight edge or planar face
 * answers through the same query resolver the linear pattern's direction uses.
 * A ref that names neither is refused by name rather than falling back to a
 * world axis, because a silent default would turn every copy the wrong way.
 */
export function resolveNormalRef(
  ref: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): Vec3 {
  if (!ref) {
    throw new Error(
      'curve_pattern: normal_ref is required for the Normal To orientation; ' +
      'pick a plane, a planar face or a straight edge',
    )
  }
  try {
    const plane = resolveSketchPlane(ref, globalRepo)
    const n = plane.normal
    const len = Math.hypot(n[0], n[1], n[2])
    if (len > 1e-12) return [n[0] / len, n[1] / len, n[2] / len]
  } catch (err) {
    // Not a plane ref: the edge/face resolver below owns the refusal, so only a
    // trap escapes here.
    swallowUnlessTrap(err)
  }
  const dir = resolveDirectionQueryStrict(ref, globalRepo, bodyStore)
  if (dir === null) {
    throw new Error(
      `curve_pattern: normal_ref '${ref}' did not resolve to a plane, a planar face or a straight edge`,
    )
  }
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (len < 1e-12) throw new Error(`curve_pattern: normal_ref '${ref}' has no direction`)
  return [dir[0] / len, dir[1] / len, dir[2] / len]
}

/** The stored path refs, in the authored order. */
function pathRefsOf(sub: Dict): string[] {
  const raw = sub.path
  if (Array.isArray(raw)) return raw.filter((ref): ref is string => typeof ref === 'string' && ref !== '')
  return typeof raw === 'string' && raw !== '' ? [raw] : []
}

export interface CurveCopies {
  copies: PatternCopy[]
  warnings: string[]
  // Instances a too-large `distance` left past the path end.
  dropped: number[]
  pathLength: number
  spacing: number
}

/** The copies a curve pattern generates, each with its naming key and the rigid
 *  transform that places it. Count 1 generates an empty list: the caller's
 *  quiet no-op, whatever the path. */
export function buildCurvePatternCopies(
  oc: OccModule,
  scope: DisposeScope,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featureId = '',
  featuresById: Record<string, Dict> = {},
): CurveCopies {
  const count = patternCountOf(sub, 'count', 3)
  // No centered option on this kind: a path has a start, not a middle.
  const generated = toInstances(instanceIndices(count, false))
  const { kept, warnings } = keptInstances(generated, sub, count, `count ${count}`)

  const pathRefs = pathRefsOf(sub)
  if (pathRefs.length === 0) throw new Error('curve_pattern: requires a path reference')

  const spacing: CurveSpacing = sub.spacing === 'distance' ? 'distance' : 'equal'
  // The distance is read in distance mode only, so a stale value outside it
  // cannot fail a solve the mode never consults.
  const distance = spacing === 'distance' ? patternNumber(sub, 'distance', 20) : 20
  const orientation: CurveOrientation = ORIENTATIONS.includes(sub.orientation as CurveOrientation)
    ? sub.orientation as CurveOrientation
    : 'tangent'
  const normal = orientation === 'normal_to' ? resolveNormalRef(String(sub.normal_ref ?? ''), globalRepo, bodyStore) : null

  const spine = resolvePathSpine(oc, scope, pathRefs, globalRepo, featureId, featuresById, { closedCurve: true })
  const path = samplePath(spineSampler(oc, scope, spine.edges))
  const placed = placeOnPath({
    path,
    indices: kept.map((instance) => instance.index as number),
    count,
    spacing,
    distance,
    reverse: sub.reverse === true,
    orientation,
    normal,
  })

  // The key comes from the instance model, not the array position, so a skipped
  // instance cannot renumber its siblings.
  const keyByIndex = new Map(kept.map((instance) => [instance.index as number, instance.key]))
  const copies: PatternCopy[] = placed.placements.map((placement) => ({
    key: keyByIndex.get(placement.index) ?? String(placement.index),
    trsf: makeRigidTrsf(oc, scope, placement.transform),
  }))
  const pastEnd = pastEndWarning(placed.dropped, placed.pathLength)
  return {
    copies,
    warnings: pastEnd === null ? warnings : [...warnings, pastEnd],
    dropped: placed.dropped,
    pathLength: placed.pathLength,
    spacing: placed.spacing,
  }
}

/** The `curve_pattern` leaf entry. */
export function solveCurvePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | BodyPatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.curve_pattern as Dict) ?? {}
  // The build runs inside the shared dispatch, so its report is carried out in
  // a holder: a plain `let` assigned in the callback does not narrow after it.
  const built: { value: CurveCopies | null } = { value: null }
  const result = solvePatternInstances(
    oc, scope, table, feature, sub, globalRepo, bodyStore, featuresById, solveContext,
    () => {
      const copies = buildCurvePatternCopies(oc, scope, sub, globalRepo, bodyStore, featureId, featuresById)
      built.value = copies
      return { copies: copies.copies, warnings: copies.warnings }
    },
  )
  const outcome = built.value
  if (outcome !== null) {
    // The editor hint and a headless report both read these: how long the path
    // is, and what the neighbour spacing worked out to.
    result.path_length = outcome.pathLength
    result.resolved_spacing = outcome.spacing
    // A distance that does not fit builds what it can and says so: the warning
    // names the instances, the status says the feature is not whole.
    if (outcome.dropped.length > 0) result.status = 'partial'
  }
  return result
}
