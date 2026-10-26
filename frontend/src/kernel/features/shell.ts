// The shell leaf: hollow a solid to a wall thickness, with zero or more picked
// faces left open. Face resolution is construction-based (never geometry), the
// same tier as fillet/chamfer's edge resolution: resolveFacesByQuery (shared)
// handles the UUID and stable-ancestry tiers. One body per feature; faces that
// name several bodies is an error, like the fillet `source_body` ambiguity.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape, OccXYZ } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { resolveBody } from './shared/bodyResolution'
import { resplitBody } from './bodySplit'
import { readBodyNames, type UuidArray } from '../occ/bodyNames'
import { SubShapeDedup } from '../occ/primitives'
import { applyShellWithLineage, type ShellDirection } from '../occ/thickSolid'
import { exploreFaces } from '../occ/edgeModifier'
import { bodyOfQuery, makeFaceIndexCache, resolveFacesByQuery } from './shared/faceResolution'

type Dict = Record<string, unknown>

interface ShellResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  // Query strings that matched no current face (a stale or deleted pick), so the
  // UI can strike them through: re-picking is the fix. Only on a partial result.
  unresolved_faces?: string[]
  // Query strings whose face resolved but the shell refused them. The shell is a
  // single whole-body operation, so a refusal is a loud exception rather than a
  // per-face failure; the field stays for the shared pick-chip contract.
  failed_faces?: string[]
  exception?: string
}

function named(uuids: UuidArray | undefined): boolean {
  return uuids?.some((u) => u !== null) ?? false
}

type V3 = [number, number, number]
const xyz = (p: { X(): number; Y(): number; Z(): number }): V3 => [p.X(), p.Y(), p.Z()]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * The smallest radius of a CONVEX round face of `shape` (cylinder, torus tube
 * or sphere whose centre of curvature lies in the material): the round an
 * inward offset collapses first. Concave rounds (a drilled hole, an inner
 * fillet) grow under an inward offset and are skipped, and so are the faces the
 * shell opens. Null when there is none.
 */
function smallestConvexRoundRadius(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  opened: OccShape[],
): number | null {
  let smallest: number | null = null
  const types = oc.GeomAbs_SurfaceType
  for (const face of exploreFaces(oc, scope, shape)) {
    if (opened.some((o) => (o as OccSubShape).IsSame(face as OccSubShape))) continue
    const surface = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
    const type = surface.GetType().value
    const p = scope.track(new oc.gp_Pnt_1())
    const du = scope.track(new oc.gp_Vec_1())
    const dv = scope.track(new oc.gp_Vec_1())
    surface.D1(
      (surface.FirstUParameter() + surface.LastUParameter()) / 2,
      (surface.FirstVParameter() + surface.LastVParameter()) / 2,
      p, du, dv,
    )
    const at = xyz(p)
    let radius: number
    let centre: V3
    if (type === types.GeomAbs_Cylinder.value || type === types.GeomAbs_Torus.value) {
      const isCylinder = type === types.GeomAbs_Cylinder.value
      const analytic = isCylinder ? scope.track(surface.Cylinder()) : scope.track(surface.Torus())
      const position = scope.track(analytic.Position())
      const a = xyz(scope.track(position.Location()))
      const d = xyz(scope.track(position.Direction()))
      const w: V3 = [at[0] - a[0], at[1] - a[1], at[2] - a[2]]
      const along = dot(w, d)
      if (isCylinder) {
        radius = (analytic as { Radius(): number }).Radius()
        centre = [a[0] + along * d[0], a[1] + along * d[1], a[2] + along * d[2]]
      } else {
        const torus = analytic as { MajorRadius(): number; MinorRadius(): number }
        radius = torus.MinorRadius()
        const perp: V3 = [w[0] - along * d[0], w[1] - along * d[1], w[2] - along * d[2]]
        const len = Math.hypot(perp[0], perp[1], perp[2])
        if (len < 1e-12) continue
        const k = torus.MajorRadius() / len
        centre = [a[0] + perp[0] * k, a[1] + perp[1] * k, a[2] + perp[2] * k]
      }
    } else if (type === types.GeomAbs_Sphere.value) {
      const sphere = scope.track(surface.Sphere())
      radius = sphere.Radius()
      const position = scope.track(sphere.Position())
      centre = xyz(scope.track(position.Location()))
    } else {
      continue
    }
    // Halfway from the surface to its centre of curvature: inside the material
    // for a convex round, in the air for a concave one.
    const probe = scope.track(new oc.gp_Pnt_3(
      (at[0] + centre[0]) / 2, (at[1] + centre[1]) / 2, (at[2] + centre[2]) / 2,
    )) as OccXYZ  // the same gp_Pnt the classifier reads, typed by its accessors
    const classifier = scope.track(new oc.BRepClass3d_SolidClassifier_3(shape, probe, 1e-7))
    if (classifier.State().value !== oc.TopAbs_State.TopAbs_IN.value) continue
    if (smallest === null || radius < smallest) smallest = radius
  }
  return smallest
}

/**
 * Solve a shell feature (the generator `KIND_SOLVER.shell` dispatches to). It
 * resolves the target body and its picked faces, applies the shell, resplits
 * the result and pushes `modified_by`. Throws for the errors the builder turns
 * into an `exception` status: no faces and no source_body, faces naming several
 * bodies, a missing body, or a kernel refusal (a thickness past the local
 * radius), which leaves the body unchanged.
 */
export function solveShell(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ShellResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.shell as Dict) ?? {}
  const thicknessRaw = sub.thickness
  const thickness = Number(thicknessRaw !== undefined && thicknessRaw !== null ? thicknessRaw : 1)
  if (!Number.isFinite(thickness) || thickness <= 0) throw new Error('shell: thickness must be positive')
  const direction: ShellDirection = sub.direction === 'outward' ? 'outward' : 'inward'
  const faces = (sub.faces as string[]) ?? []
  const sourceBody = (sub.source_body as string) ?? ''
  if (Object.keys(bodyStore).length === 0) throw new Error('shell: no bodies in body_store')
  if (faces.length === 0 && !sourceBody) throw new Error('shell: no faces and no source_body; a closed hollow needs a body')

  const indexFor = makeFaceIndexCache(oc, scope, table)

  // The one body this feature acts on.
  let targetId: string | null = null
  if (sourceBody) {
    targetId = resolveBody(sourceBody, bodyStore).id
  } else {
    const ids = new Set<string>()
    for (const q of faces) {
      const bid = bodyOfQuery(oc, scope, table, bodyStore, indexFor, q)
      if (bid !== null) ids.add(bid)
    }
    if (ids.size > 1) {
      throw new Error(`shell: faces name ${ids.size} bodies (${[...ids].join(', ')}); pick faces on one body`)
    }
    targetId = ids.size === 1 ? [...ids][0] : null
  }
  if (targetId === null) throw new Error('shell: no body resolved from the picked faces')

  const body = resolveBody(targetId, bodyStore)
  if (body.shape === null) throw new Error(`shell: body '${targetId}' has no shape`)
  const oldShape = table.get<OccShape>(body.shape)

  // Resolve the picked faces against this one body; a query that matches nothing
  // is unresolved (struck through), not a solve failure.
  const unresolved: string[] = []
  const topoFaces: OccShape[] = []
  const dedup = new SubShapeDedup()
  const byQuery = resolveFacesByQuery(oc, scope, table, body, indexFor(body), faces, bodyStore)
  for (const q of faces) {
    const face = byQuery.get(q) ?? null
    if (face === null) {
      unresolved.push(q)
      continue
    }
    if (dedup.add(face as OccSubShape)) topoFaces.push(face)
  }
  if (faces.length > 0 && topoFaces.length === 0) {
    throw new Error(`shell: none of the ${faces.length} picked face(s) resolved`)
  }

  const oldNames = named(body.face_uuids) || named(body.edge_uuids)
    ? { createdBy: featureId, ...readBodyNames(oc, scope, oldShape, body) }
    : null

  const res = applyShellWithLineage(oc, scope, oldShape, topoFaces, thickness, direction, oldNames)
  if (!res.success) {
    // The kernel refused: report the reason and leave the body alone. res.shape
    // is the UNCHANGED input, so resplitting it would re-register the same
    // geometry as a fresh handle and report success for a no-op.
    const collapse = direction === 'inward' ? smallestConvexRoundRadius(oc, scope, oldShape, topoFaces) : null
    if (collapse !== null && collapse <= thickness + 1e-9) {
      // An inward wall offsets every round face by the thickness; a fillet of
      // radius <= thickness collapses to nothing there (Case_Seam_Lip F4), and
      // the kernel says only build_failed.
      throw new Error(
        `shell: inward thickness ${thickness} >= fillet radius ${Number(collapse.toPrecision(6))}; ` +
          'shell outward or use a smaller thickness',
      )
    }
    throw new Error(`shell: ${res.reason ?? 'unknown failure'}`)
  }

  const ids = resplitBody(oc, scope, table, bodyStore, body, scope.track(res.shape), featureId, res.names ?? {})
  if (ids.length === 0) throw new Error('shell: the operation removed the whole body')
  body.brep_diff = res.diff
  body.modified_by.push(featureId)

  if (unresolved.length > 0) {
    return {
      status: 'partial',
      body_id: ids[0],
      body_ids: ids,
      unresolved_faces: [...new Set(unresolved)],
      failed_faces: [],
      exception: `shell: ${unresolved.length} face(s) could not be resolved`,
    }
  }
  return { status: 'ok', body_id: ids[0], body_ids: ids }
}
