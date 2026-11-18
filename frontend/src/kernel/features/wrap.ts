// The wrap leaf: bend a planar sketch footprint onto a cylinder, cone, sphere or
// torus face and raise (add/new) or sink (cut) it by a height along the face
// normal, keeping lengths at the reference parallel (features/wrapMath.ts). It
// is the revolve leaf's shape: resolve the profile loops, resolve the target
// face, build the tool with lineage (occ/wrapSolid.ts through
// sweepLoopsWithLineage) and hand it to applyPartOperation.
//
// The datum is the target's own axis or centre, read in closed form off the
// face; there is no origin, direction or seed pick, so nothing here infers or
// ray casts. A missing or unresolved target is a soft failure that builds
// nothing, the same contract as an extrude's up_to with no target: guessing a
// surface would build a plausible wrong solid.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage, swallowUnlessTrap } from '../errors'
import type { OccModule, OccShape, OccXYZ } from '../occ/occTypes'
import type { HandleTable, OccHandle } from '../occ/handleTable'
import type { PartSolid } from '../types3d'
import { AmbiguousQueryError, type Repository } from '../query'
import { collectExtrudeLoops, resolveFaceSlashFace } from './faceProfile'
import { samePlane, type PlaneLike } from './shared/planes'
import { surfaceEntityIds } from './shared/partRef'
import { openJointHint, profileAreaReport } from './shared/profileLoops'
import { applyPartOperation, type PartOperation } from './partOps'
import { maxPrecision, sketchPrecision, type KernelPrecision } from '../precision'
import { sweepLoopsWithLineage } from '../occ/prismLineage'
import { extractOccFace } from '../occ/faceLoops'
import { faceNormal } from '../occ/primitives'
import { pointInFace } from '../occ/moveFaceSurfaces'
import { wrapBuilder } from '../occ/wrapSolid'
import { loopPts } from '../profileLoops'
import { SLASH_FACE_REF } from './upTo'
import {
  angleInRange,
  geometricOffset,
  refuseCollapsedOffset,
  wrapFitTolerance,
  wrapMap,
  type TubeSide,
  type Vec3,
  type WrapMap,
  type WrapSurface,
} from './wrapMath'
import { add as add3, dot, scale, sub as sub3 } from '@/utils/vec3'

type Dict = Record<string, unknown>

interface WrapResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids?: string[]
}

/** The operations a wrap may perform; an extrude's set. */
const OPERATIONS: readonly PartOperation[] = ['add', 'cut', 'new']

/** Boundary samples per arc or curve when testing a footprint's extent. */
const FOOTPRINT_ARC_SAMPLES = 16

/** Points inserted between neighbouring boundary samples. A line comes back as
 *  its two ends only, and a long edge spanning a gap in the target face (or a
 *  chord cutting inside an arc's furthest reach) must still be tested. */
const FOOTPRINT_SPAN_SAMPLES = 8

/** A closed sample loop with FOOTPRINT_SPAN_SAMPLES points on every span. */
function densified(loop: number[][]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    for (let k = 0; k < FOOTPRINT_SPAN_SAMPLES; k++) {
      const t = k / FOOTPRINT_SPAN_SAMPLES
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

function readXYZ(p: OccXYZ): Vec3 {
  const out: Vec3 = [p.X(), p.Y(), p.Z()]
  p.delete()
  return out
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2])
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : v
}

/** The target face of the pick, or null when the pick does not resolve. */
function resolveTargetFace(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  ref: string,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
): OccShape | null {
  let entry: Dict | null
  try {
    entry = globalRepo.query(ref, null, partStore) as Dict | null
  } catch (e) {
    swallowUnlessTrap(e)
    if (e instanceof AmbiguousQueryError) throw e
    entry = null
  }
  if (entry === null) {
    if (!SLASH_FACE_REF.test(ref)) return null
    return resolveFaceSlashFace(oc, scope, table, ref, globalRepo, partStore).face
  }
  const partId = entry.body_id as string | undefined
  const faceIndex = entry.face_index as number | undefined
  if (partId === undefined || faceIndex === undefined) {
    throw new Error(`wrap: the target '${ref}' is not a part face; pick a cylinder, cone, sphere or torus face`)
  }
  const part = partStore[partId]
  if (part === undefined || part.shape === null) return null
  return extractOccFace(oc, scope, table.get<OccShape>(part.shape as OccHandle), faceIndex)
}

/**
 * The analytic surface of the target and whether its material lies on the axis
 * side. The material normal (orientation-aware) is compared with the surface's
 * own outward direction at the face's UV midpoint.
 */
export function readWrapTarget(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { surface: WrapSurface; concave: boolean; tubeRange?: [number, number] } {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Plane.value) {
    throw new Error('wrap: the target face is planar; use an extrude to raise a sketch on a flat face')
  }
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  adaptor.D1(u, v, p, du, dv)
  const at: Vec3 = [p.X(), p.Y(), p.Z()]
  const material = faceNormal(oc, scope, face)
  const axisFrame = (axisObj: { Direction(): OccXYZ; delete(): void }, pos: { Location(): OccXYZ; delete(): void }) => {
    const axis = unit(readXYZ(axisObj.Direction()))
    const origin = readXYZ(pos.Location())
    axisObj.delete()
    pos.delete()
    return { axis, origin }
  }
  // The direction away from the axis line at `at`.
  const radialFrom = (origin: Vec3, axis: Vec3): Vec3 => {
    const rel = sub3(at, origin)
    return unit(sub3(rel, scale(axis, dot(rel, axis))))
  }
  let surface: WrapSurface
  let outward: Vec3
  // A torus face's tube-angle range, in the same convention as wrapMath's tube
  // angle (OCC's v about the face's own axis direction, which the map keeps).
  let tubeRange: [number, number] | undefined
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    const { axis, origin } = axisFrame(cyl.Axis(), cyl.Position())
    surface = { kind: 'cylinder', origin, axis, radius: cyl.Radius() }
    outward = radialFrom(origin, axis)
  } else if (t === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    const { axis, origin } = axisFrame(cone.Axis(), cone.Position())
    surface = { kind: 'cone', origin, axis, refRadius: cone.RefRadius(), semiAngle: cone.SemiAngle() }
    // The cone's normal leans off the radial direction by its semi-angle, which
    // is under 90 degrees, so the radial direction carries its sign.
    outward = radialFrom(origin, axis)
  } else if (t === S.GeomAbs_Sphere.value) {
    const sph = scope.track(adaptor.Sphere())
    const pos = sph.Position()
    const center = readXYZ(pos.Location())
    pos.delete()
    surface = { kind: 'sphere', center, radius: sph.Radius() }
    outward = unit(sub3(at, center))
  } else if (t === S.GeomAbs_Torus.value) {
    const tor = scope.track(adaptor.Torus())
    const { axis, origin } = axisFrame(tor.Axis(), tor.Position())
    const major = tor.MajorRadius()
    surface = { kind: 'torus', origin, axis, majorRadius: major, minorRadius: tor.MinorRadius() }
    // The tube's outward direction runs from the centre circle point nearest
    // `at`, which is the ring radius out along the same radial direction.
    const ringPoint = add3(origin, scale(radialFrom(origin, axis), major))
    outward = unit(sub3(at, ringPoint))
    tubeRange = [adaptor.FirstVParameter(), adaptor.LastVParameter()]
  } else {
    throw new Error(
      'wrap: the target must be a cylinder, cone, sphere or torus face; a freeform face is not supported yet',
    )
  }
  return { surface, concave: dot(material, outward) < 0, ...(tubeRange && { tubeRange }) }
}

/** Whether a sketch point's image on the target lies on the target face. */
function onFace(oc: OccModule, scope: DisposeScope, face: OccShape, map: WrapMap, p: number[], tol: number): boolean {
  return pointInFace(oc, scope, face, map.point(p, 0), tol)
}

function bboxSize(points: number[][]): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return Math.hypot(x1 - x0, y1 - y0)
}

/**
 * The map, on the torus half of the tube the face spans (outer preferred). The
 * choice reads the face's own tube-angle range, never a point classification:
 * a pattern rebuilds this wrap against a part the wrap already fused into, and
 * the footprint centre then sits in a hole of the face, which read as "not on
 * the outer half" and built every copy on the inner one.
 */
function mapOnFace(
  surface: WrapSurface,
  concave: boolean,
  plane: PlaneLike,
  footprint: number[][],
  tubeRange: [number, number] | undefined,
): WrapMap {
  const build = (tubeSide?: TubeSide): WrapMap => wrapMap({ surface, concave, plane, footprint, tubeSide })
  if (surface.kind !== 'torus') return build()
  const outer = build('outer')
  if (tubeRange === undefined || angleInRange(outer.tubeAngle ?? 0, tubeRange)) return outer
  const inner = build('inner')
  return angleInRange(inner.tubeAngle ?? 0, tubeRange) ? inner : outer
}

/** A pattern or mirror rebuilding an earlier wrap's tool. The tool is
 *  registered as `new` into a scratch store, but on a wrap the operation also
 *  signs the height (a cut goes into the material), so the source's own
 *  operation rides along. `parts` is the real part store, read only when the
 *  wrap left no record of its target (see `WrapTargetRecord`). */
export interface WrapRebuild {
  operation: PartOperation
  parts: Record<string, PartSolid>
}

/** What a caller other than the feature log hands a wrap. The registry's
 *  variable context rides the same slot, so its two keys are named here to keep
 *  the shared context type assignable (extrude's context does the same). */
export interface WrapSolveContext {
  variables?: Record<string, number>
  laterVariables?: Record<string, number>
  rebuild?: WrapRebuild
}

/**
 * The target surface a wrap resolved, recorded in the repository under
 * `wrapTargetKey(featureId)` when the wrap itself solves. A rebuild reads this
 * instead of the target face: by then the wrap has fused into or cut that face
 * (the footprint is a hole in it), and any later feature may have moved or split
 * it, so a re-read sees a different face from the one the wrap was built on.
 * Plain data, so it rides the repository snapshot through every checkpoint.
 */
export interface WrapTargetRecord {
  surface: WrapSurface
  concave: boolean
  tubeRange?: [number, number]
}

export const wrapTargetKey = (featureId: string): string => '_wrap_target_' + featureId

/** Solve a wrap feature into the body store. */
export function solveWrap(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  // The registry's featuresById slot; a wrap reads no other feature.
  _featuresById?: unknown,
  solveContext?: WrapSolveContext,
): WrapResult {
  const rebuild = solveContext?.rebuild
  const targetParts = rebuild?.parts ?? partStore
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.wrap as Dict) ?? {}
  const mergeTarget = (sub.merge_target as string) ?? null
  const sketchRaw = sub.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  const height = Number(sub.height)
  if (!Number.isFinite(height) || height <= 0) throw new Error('wrap: height must be a positive length')
  const operation = ((sub.operation as string) ?? 'add') as PartOperation
  if (!OPERATIONS.includes(operation)) throw new Error(`wrap: unknown operation ${JSON.stringify(operation)}`)
  if (sketchRefs.length === 0) throw new Error('wrap: requires a profile; pick a sketch or a sketch area')

  const allLoops: Dict[][] = []
  let plane: PlaneLike | null = null
  let sketchId = ''
  let precision: KernelPrecision | null = null
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const unbuildableReasons: string[] = []
  let areaTotal = 0
  let areaBuilt = 0

  for (const sketchRef of sketchRefs) {
    let resolved
    try {
      resolved = collectExtrudeLoops(oc, scope, table, sketchRef, globalRepo, partStore)
    } catch (exc) {
      swallowUnlessTrap(exc)
      profileErrors.push(extractErrorMessage(exc))
      continue
    }
    if (resolved.face !== null) {
      throw new Error('wrap: a picked part face or edge cannot be wrapped; wrap a sketch profile')
    }
    allLoops.push(...resolved.loops)
    if (plane === null) {
      plane = resolved.plane
      sketchId = resolved.sketchId
    } else if (!samePlane(plane, resolved.plane)) {
      throw new Error(
        `wrap: profile spans two different sketch planes ('${sketchId}' and '${resolved.sketchId}'); ` +
          'build one wrap per plane',
      )
    }
    precision = maxPrecision(precision, sketchPrecision(globalRepo, resolved.sketchId))
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    const report = profileAreaReport(resolved.profileSurfaces ?? [], resolved.builtSurfaces, resolved.loopDiags ?? [])
    areaTotal += report.total
    areaBuilt += report.built
    if (report.total === 0) {
      const hint = openJointHint((topo.edges as Dict[]) ?? [], (topo.unmet_contacts as Dict[]) ?? [])
      if (hint !== null && !unbuildableReasons.includes(hint)) unbuildableReasons.push(hint)
    }
    for (const reason of report.reasons) {
      if (!unbuildableReasons.includes(reason)) unbuildableReasons.push(reason)
    }
    for (const surface of (topo.surfaces as Dict[]) ?? []) profileQueries.push(...surfaceEntityIds(surface))
  }
  if (profileErrors.length && allLoops.length === 0) throw new Error(profileErrors.join('; '))

  const partId = 'body_' + featureId
  const result: WrapResult = { status: 'ok', body_id: partId }
  if (allLoops.length === 0 || plane === null) {
    result.status = 'error'
    const why = unbuildableReasons.length ? ` (${unbuildableReasons.join('; ')})` : ''
    result.exception = `wrap: no closed profile found in the referenced sketch${why}; no part created`
    result.mesh_warning = 'no closed profile found; part has no shape'
    return result
  }

  // No target, or one that names nothing: build nothing and say why. body_ids
  // is explicitly empty so no consumer chases a body that was never minted.
  const targetRef = (sub.target as string | undefined) ?? ''
  const recorded = rebuild !== undefined
    ? (globalRepo.elements.get(wrapTargetKey(featureId)) as WrapTargetRecord | undefined)
    : undefined
  let targetFace: OccShape | null = null
  let warning: string | undefined
  if (recorded !== undefined) {
    // The wrap's own solve already resolved and checked this target.
  } else if (!targetRef) {
    warning = 'wrap: has no target face; nothing was built'
  } else {
    try {
      targetFace = resolveTargetFace(oc, scope, table, targetRef, globalRepo, targetParts)
    } catch (e) {
      if (!(e instanceof AmbiguousQueryError)) throw e
      warning = `wrap: target '${targetRef}' matched several elements (${e.message}); nothing was built`
    }
    if (targetFace === null && warning === undefined) {
      warning = `wrap: target '${targetRef}' did not resolve; nothing was built`
    }
  }
  if (recorded === undefined && targetFace === null) {
    result.body_id = mergeTarget ?? Object.keys(partStore).sort()[0] ?? partId
    result.body_ids = []
    result.solver_warning = warning
    return result
  }

  const target: WrapTargetRecord = recorded ?? readWrapTarget(oc, scope, targetFace as OccShape)
  const { surface, concave, tubeRange } = target
  const footprint = allLoops.flatMap((loop) => densified(loopPts(loop, FOOTPRINT_ARC_SAMPLES)))
  const size = bboxSize(footprint)
  const tol = wrapFitTolerance(size)
  const map = mapOnFace(surface, concave, plane, footprint, tubeRange)
  // A rebuild registers its tool as `new`, but the height still goes the way
  // the source's own operation sends it.
  const offset = geometricOffset(height, rebuild?.operation ?? operation, concave)
  refuseCollapsedOffset(surface, map, offset, footprint)
  if (targetFace !== null) {
    // Every boundary sample has to land on the target face: a footprint running
    // off the face would build a wrap floating past the part's edge. Only the
    // face the wrap is built on can say so; a recorded target was checked when
    // it was recorded.
    const faceTol = Math.max(1e-6, size * 1e-6)
    if (!footprint.every((p) => onFace(oc, scope, targetFace as OccShape, map, p, faceTol))) {
      throw new Error('wrap: the footprint runs off the target face; move it onto the face or make it smaller')
    }
  }
  if (rebuild === undefined) globalRepo.register(wrapTargetKey(featureId), target)

  const lineage = sweepLoopsWithLineage(
    oc, scope, allLoops, plane,
    (face) => wrapBuilder(oc, scope, face, plane as PlaneLike, map, offset, tol),
    sketchId, featureId, precision,
  )
  const toolShape = scope.track(lineage.solid)

  const opResult = applyPartOperation(oc, scope, table, {
    toolShape,
    partStore,
    operation,
    mergeTarget,
    partId,
    featureId,
    sketchId,
    opName: 'wrap',
    profileQueries,
    faceNames: lineage.faceNames,
    edgeNames: lineage.edgeNames,
    faceAncestry: lineage.faceAncestry,
    edgeAncestry: lineage.edgeAncestry,
    capAncestry: lineage.capAncestry,
    precision,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }
  if (unbuildableReasons.length > 0) {
    result.status = 'partial'
    const message = `wrap: built ${areaBuilt} of ${areaTotal} profile areas; ` + unbuildableReasons.join('; ')
    result.exception = result.exception === undefined ? message : `${result.exception}; ${message}`
  }
  return result
}
