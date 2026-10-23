// The hole leaf. For each drill site the `sketch` ref names it drills a cylinder (blind depth
// or through-all) and boolean-cuts it from the target body. Composite of the cut boolean
// + cylinder primitive.
//
// The ref is a pick chip's raw value, so it names either a whole sketch (every point and circle
// in it) or ONE picked entity -- a point, or a circle that carries its own radius. A circle
// drills at its own radius either way; a point takes the feature's `diameter`.
// parseHoleSketchRef / drilledEntities / drillSite below are that rule; a pick that names no
// drill site is refused there by name.
//
// through_all sizes the cylinder from the target's edge-sampled AABB (bodyFrame).
// A vertex-only box is NOT a safe stand-in for one: an OCCT cylinder carries
// just two seam vertices, so its vertex box collapses radially and a radial
// through-hole sized from it under-penetrates by roughly the full diameter,
// leaving the far wall intact. Sampling the edges (the cap circles) recovers
// the true extent, matching Python's Bnd_Box-sized cylinder.

import { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { parseSketchEntityRef, sketchIdFromQuery, soleEntityInQuery } from './shared/bodyRef'
import { resolveBody } from './shared/bodyResolution'
import { mergeBrepDiff } from './shared/brepDiff'
import { stripRefSigil } from '@/utils/refSigil'
import { makeCylinderWithFaces, makeCone, faceSurfaceType, type CylinderFaces, type Vec3 } from '../occ/primitives'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { holeFacePath, mintFaceUuid, type HoleFaceRole } from '../constructionName'
import { absolute, emitWire, featureRefId } from '../query'
import { bodyFrame } from '../occ/tessellation'
import { booleanWithDiff, volumeOf } from '../occ/booleans'
import { resplitBody } from './bodySplit'
import { transferBooleanNames } from './booleanLineage'
import { readBodyNames, type ShapeNames } from '../occ/bodyNames'
import { threadHelices, type ThreadDisplay, type ThreadSite } from './threadDisplay'
import type { PlaneLike } from './shared/planes'

type Dict = Record<string, unknown>

interface HoleResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  hole_count: number
  // The cosmetic thread the drilled bores are for, if the feature names one: its
  // metadata plus one display helix per drilled site. A cosmetic thread changes
  // no geometry, so this rides the result rather than the body.
  thread?: ThreadDisplay
}

/**
 * The cosmetic thread a hole's `thread` field names, or null. The doc schema
 * already checked the pair against the thread table at the boundary, so this
 * only refuses a spec a hand-built solve would otherwise carry into the result:
 * a missing designation, or a non-positive nominal or pitch.
 */
function readThreadSpec(raw: unknown): { designation: string; nominal: number; pitch: number } | null {
  if (raw === null || raw === undefined) return null
  const spec = raw as Dict
  const designation = typeof spec.designation === 'string' ? spec.designation : ''
  const nominal = Number(spec.nominal ?? 0)
  const pitch = Number(spec.pitch ?? 0)
  if (designation === '') throw new Error('hole: a cosmetic thread needs a designation')
  if (!Number.isFinite(nominal) || nominal <= 0) throw new Error('hole: the thread nominal must be positive')
  if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('hole: the thread pitch must be positive')
  return { designation, nominal, pitch }
}

/**
 * The sketch a hole's `sketch` ref names, and the ONE entity of it the pick
 * narrows to (null = the whole sketch).
 *
 * A hole's sketch field is a pick chip like any other, so it holds whatever the
 * viewport toggled: a feature-tree click on the sketch gives `@<sketchId>`, but
 * a click in the 3D view gives `entity:<sk>:<eid>` / `vertex:<sk>:<eid>:<sub>`
 * for a curve or a vertex, and a `?...` ancestry query for an area fill. Those
 * three used to reach `_pt_entity:<sk>:<eid>` verbatim and red the feature out
 * with "has no plane transform registered", which named nothing the user could
 * act on -- picking in the viewport, the obvious gesture, was the one that could
 * not work. This is the single decoder for all four forms; `entity:`/`vertex:`
 * and a single-entity area pick narrow the drill to that entity, everything else
 * keeps the whole-sketch meaning `@<sketchId>` always had.
 */
function parseHoleSketchRef(
  ref: string,
  globalRepo: Repository,
): { sketchId: string; entityId: string | null } {
  const picked = parseSketchEntityRef(ref)
  if (picked !== null) return { sketchId: picked.sketchId, entityId: picked.eid }
  if (ref.startsWith('?')) {
    const sketchId = sketchIdFromQuery(ref, globalRepo)
    // A query naming no sketch (a body face, say) keeps the raw ref, so the
    // plane lookup below refuses the pick by name rather than silently drilling
    // some other sketch.
    if (sketchId === null) return { sketchId: ref, entityId: null }
    return { sketchId, entityId: soleEntityInQuery(ref, sketchId) }
  }
  return { sketchId: featureRefId(ref) ?? stripRefSigil(ref, '@$'), entityId: null }
}

/**
 * Where one entity puts a drill and how wide, or null when the solver left it
 * without geometry (the caller counts those as skipped).
 *
 * A point entity is the classic hole site: it names a position and nothing else,
 * so the feature's own diameter applies. A CIRCLE names both -- position and
 * size -- and its size wins, whether the pick named it alone or took it in with
 * the whole sketch, because the hole it asks for is the hole the user drew and
 * can see; the same pick through an extrude cut removes exactly that cylinder,
 * and a hole that came out at the feature's diameter instead would disagree with
 * the circle still sitting in the sketch. Nothing else is a drill site: a line,
 * an arc or a spline names no enclosed circle, so those are refused rather than
 * reduced to some point on them.
 */
function drillSite(
  globalRepo: Repository,
  sketchId: string,
  entity: Dict,
  featureRadius: number,
): { xy: number[]; radius: number } | null {
  const eid = entity.id as string
  if (entity.kind === 'circle') {
    const solved = globalRepo.elements.get(sketchId + '/' + eid) as Dict | undefined
    const params = solved?.external_params as number[] | undefined
    if (params === undefined || params.length < 3 || !(params[2] > 0)) return null
    return { xy: [params[0], params[1]], radius: params[2] }
  }
  const xyEntry = globalRepo.elements.get(sketchId + '/' + eid + '/xy') as Dict | undefined
  if (xyEntry === undefined) return null
  return { xy: xyEntry.external_xy as number[], radius: featureRadius }
}

/**
 * The entities this hole drills. A pick that named one entity drills that one
 * and nothing else -- a user who clicked a single point does not expect the
 * other points in the sketch to be drilled too. A pick that named the sketch
 * drills every point and circle in it, in the sketch's entity order; each point
 * takes the feature's diameter and each circle its own radius (drillSite).
 */
function drilledEntities(
  entities: Dict[],
  sketchId: string,
  entityId: string | null,
): Dict[] {
  if (entityId === null) {
    const sites = entities.filter((e) => e.kind === 'point' || e.kind === 'circle')
    if (sites.length === 0) {
      throw new Error(
        `hole: sketch '${sketchId}' has no point or circle entities; the hole needs a point or circle in its sketch`,
      )
    }
    return sites
  }
  const picked = entities.find((e) => e.id === entityId)
  if (picked === undefined) throw new Error(`hole: sketch '${sketchId}' has no entity '${entityId}'`)
  if (picked.kind !== 'point' && picked.kind !== 'circle') {
    throw new Error(
      `hole: '${entityId}' of sketch ${sketchId} is a ${picked.kind}, which names no drill site; ` +
      'pick a sketch point or a circle, or the sketch itself',
    )
  }
  return [picked]
}

/**
 * Construction names for one drill site's cutter, keyed by its faces before the
 * cut: the bore wall, the mouth (the cutter's start disc), the floor (its end
 * disc), and for a widened mouth the counterbore's wall and step floor or the
 * countersink's cone. A through_all cutter starts backed off outside the body
 * and ends past it, so only a blind hole's floor, or a mouth at a site inside
 * the body, ever survives the cut; the names are minted for every role anyway,
 * since which survive is the boolean's to say. The roles come from the cutter
 * primitives themselves, never from where a face sits, and the uuid from the
 * hole, the site and the role, so a bore is the same bore whatever other sites
 * the hole drills and in whatever order. The site's sketch entity is the
 * ancestry, as a profile entity is a prism side face's.
 */
function cutterNames(
  holeId: string,
  sketchId: string,
  entityId: string,
  roles: SubShapeMap<HoleFaceRole>,
): { faceNames: SubShapeMap<string>; faceAncestry: Record<string, string[]>; capAncestry: Record<string, string[]> } {
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  // A cutter's bore/floor/mouth come from the drill site's entity, and a
  // cylinder cap path names no cap here (every role is a generated face), so
  // there is no whole-profile net to carry.
  const capAncestry: Record<string, string[]> = {}
  const site = `${sketchId}/${entityId}`
  const token = emitWire(absolute(sketchId, entityId))
  for (const [face, role] of roles.entries()) {
    const uuid = mintFaceUuid(holeFacePath(holeId, site, role))
    faceNames.set(face, uuid)
    faceAncestry[uuid] = [token]
  }
  return { faceNames, faceAncestry, capAncestry }
}

/** One cutter's face roles, keyed by the primitive's faces before the cut. */
interface Cutter {
  shape: OccShape
  roles: SubShapeMap<HoleFaceRole>
}

/** The bore cylinder's roles: its wall and end disc, plus the start disc as the
 *  mouth. A counterbore/step or countersink cone reuses `mouth`; the fuse maps
 *  only the surviving disc. */
function cylinderRoles(faces: CylinderFaces, wall: HoleFaceRole, end: HoleFaceRole): SubShapeMap<HoleFaceRole> {
  const roles = new SubShapeMap<HoleFaceRole>()
  roles.set(faces.lateral as OccSubShape, wall)
  roles.set(faces.top as OccSubShape, end)
  roles.set(faces.bottom as OccSubShape, 'mouth')
  return roles
}

/** The lateral (conical) face of a `makeCone` shape. This OCC build exposes no
 *  `BRepPrim_Cone`, so the one curved face IS the cone wall. */
function coneLateral(oc: OccModule, scope: DisposeScope, cone: OccShape): OccSubShape | null {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(cone, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(scope.track(exp.Current()))) as OccSubShape
    if (faceSurfaceType(oc, scope, face) === 'coneface') return face
  }
  return null
}

/**
 * Fuse a widened mouth onto the bore so the hole still cuts in ONE boolean (the
 * lineage stays one operation). The fused tool's faces are new shapes, so each
 * is named by the operand face the fuse's own history says it came from; a role
 * the union dropped simply has no output. One role maps to at most one output:
 * the operands' coplanar start discs are one mouth.
 */
function fuseCutter(oc: OccModule, scope: DisposeScope, target: Cutter, tool: Cutter): Cutter {
  const fused = booleanWithDiff(oc, scope, target.shape, tool.shape, 'fuse')
  const roles = new SubShapeMap<HoleFaceRole>()
  const assigned = new Set<HoleFaceRole>()
  for (const origin of fused.faceOrigin) {
    const sourceRoles = origin.fromTool ? tool.roles : target.roles
    const role = sourceRoles.get(origin.source)
    if (role === undefined || assigned.has(role)) continue
    assigned.add(role)
    roles.set(origin.output, role)
  }
  scope.release(target.shape)
  scope.release(tool.shape)
  return { shape: fused.shape, roles }
}

/**
 * One site's whole cut tool. A simple hole is the bore cylinder; a counterbore
 * fuses the bore with a wider, short cylinder at the mouth; a countersink fuses
 * it with a cone whose included angle is `csAngle` (the cone runs from the wide
 * mouth radius down to the bore radius, so no separate floor is introduced).
 *
 * `start` is where the bore begins (backed off outside the body for a through
 * hole); `mouth` is the drill site's plane, where a widened mouth is measured
 * from. A through-all counterbore's step reaches back to `start` so it always
 * covers the entry face, however far the bore is backed off.
 */
function buildCutter(
  oc: OccModule,
  scope: DisposeScope,
  style: string,
  through: boolean,
  start: Vec3,
  mouth: Vec3,
  axis: Vec3,
  radius: number,
  boreLength: number,
  cbRadius: number,
  cbDepth: number,
  coneHeight: number,
  backOffset: number,
): Cutter {
  const bore = makeCylinderWithFaces(oc, scope, start, axis, radius, boreLength)
  let cutter: Cutter = { shape: bore.shape, roles: cylinderRoles(bore.faces, 'bore', 'floor') }
  if (style === 'counterbore') {
    const stepStart = through ? start : mouth
    const stepLength = through ? backOffset + cbDepth : cbDepth
    const step = makeCylinderWithFaces(oc, scope, stepStart, axis, cbRadius, stepLength)
    cutter = fuseCutter(oc, scope, cutter, {
      shape: step.shape,
      roles: cylinderRoles(step.faces, 'step_wall', 'step_floor'),
    })
  } else if (style === 'countersink') {
    const cone = makeCone(oc, scope, mouth, axis, cbRadius, radius, coneHeight)
    const lateral = coneLateral(oc, scope, cone)
    const roles = new SubShapeMap<HoleFaceRole>()
    if (lateral !== null) roles.set(lateral, 'sink')
    cutter = fuseCutter(oc, scope, cutter, { shape: cone, roles })
  }
  return { shape: scope.track(cutter.shape), roles: cutter.roles }
}

/** Extent of the target along the drill axis, from its edge-sampled AABB: the
 *  length a through-all cutter must clear. The AABB is projected onto the axis
 *  (2*sum(|axis_i|*half_i)) instead of taking the max world-axis half-extent: an
 *  oblique axis can cross a cube along its space diagonal, where the max-axis
 *  span underestimates the body by up to sqrt(3), leaving the far corner uncut
 *  while intersects() still reports a hit. Vertices alone understate curved
 *  bodies (a cylinder's only vertices sit on its seam), so the edge samples
 *  carry the silhouette. */
function bodySpanAlong(oc: OccModule, scope: DisposeScope, shape: OccShape, axis: Vec3): number {
  const { half } = bodyFrame(oc, scope, shape)
  return 2.0 * (Math.abs(axis[0]) * half[0] + Math.abs(axis[1]) * half[1] + Math.abs(axis[2]) * half[2])
}

/** True when `tool` shares any volume with `shape`.
 *
 *  The same bare BRepAlgoAPI_Common probe bodyOps and boolean run before a cut
 *  to skip disjoint tools. The cut's BrepDiff cannot decide this: a disjoint
 *  cut still writes a NON-empty diff because OCC's history marks the whole
 *  tool as deleted, which reads as "material removed" even though the body is
 *  untouched. A failed probe is not evidence of disjointness (mirror bodyOps),
 *  so the cut proceeds and surfaces its own failure. */
function intersects(oc: OccModule, shape: OccShape, tool: OccShape): boolean {
  const probe = new DisposeScope()
  try {
    const algo = probe.track(new oc.BRepAlgoAPI_Common_1())
    const args = probe.track(new oc.TopTools_ListOfShape_1())
    args.Append_1(shape)
    const tools = probe.track(new oc.TopTools_ListOfShape_1())
    tools.Append_1(tool)
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetToFillHistory(false)
    algo.Build()
    if (!algo.IsDone()) return true
    const inter = algo.Shape()
    probe.track(inter)
    return volumeOf(oc, probe, inter) >= 1e-10
  } catch {
    return true
  } finally {
    probe.dispose()
  }
}

/**
 * Solve a hole feature into the body store (mirrors `_solve_hole`).
 *
 * The result's accounting split: a site is MISSED when it had geometry but the
 * boolean removed nothing. `hole_count` is sites that removed material (placed
 * minus missed). A hole where SOME sites cut and some missed is `partial` and
 * names the missed sites; a hole where every site missed keeps `status: 'ok'`
 * with a solver warning (the body is unchanged, and a warning beats the old
 * silent ok), matching the bodyOps warning-with-ok convention. `partial` is
 * reserved for the mixed case. A hole that consumes the whole body (a
 * through-hole wider than the body) goes through resplitBody's deletion path:
 * the body leaves the store and the result reports it with `body_ids: []`.
 */
export function solveHole(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict>,
): HoleResult {
  const sub = (feature.hole as Dict) ?? {}
  const sketchRef = typeof sub.sketch === 'string' ? sub.sketch : ''
  // An empty sketch is a half-configured feature, not a bad ref: name the
  // missing piece instead of letting the plane lookup report `_pt_` by itself.
  if (sketchRef.trim() === '') throw new Error('hole: the hole needs a sketch')
  const { sketchId, entityId } = parseHoleSketchRef(sketchRef, globalRepo)
  const diameter = Number(sub.diameter ?? 10.0)
  const depthMode = (sub.depth_mode as string) ?? 'blind'
  const depth = Number(sub.depth ?? 10.0)
  const direction = (sub.direction as string) ?? 'normal'
  const targetRef = (sub.target as string) ?? ''
  const thread = readThreadSpec(sub.thread)
  const style = (sub.style as string) ?? 'simple'
  const cbDiameter = Number(sub.cb_diameter ?? 0)
  const cbDepth = Number(sub.cb_depth ?? 0)
  const csAngle = Number(sub.cs_angle ?? 90)

  if (!Number.isFinite(diameter) || diameter <= 0) throw new Error('hole: diameter must be positive')
  if (depthMode !== 'through_all') {
    if (!Number.isFinite(depth) || depth <= 0) throw new Error('hole: depth must be positive')
  }
  if (style !== 'simple' && style !== 'counterbore' && style !== 'countersink') {
    throw new Error(`hole: style '${style}' is not simple, counterbore or countersink`)
  }
  if (style !== 'simple') {
    if (!Number.isFinite(cbDiameter) || cbDiameter <= 0) {
      throw new Error(`hole: a ${style} needs a positive cb_diameter`)
    }
  }
  if (style === 'counterbore') {
    if (!Number.isFinite(cbDepth) || cbDepth <= 0) throw new Error('hole: a counterbore needs a positive cb_depth')
    if (depthMode !== 'through_all' && cbDepth >= depth) {
      throw new Error(`hole: the counterbore depth ${cbDepth} must be less than the blind hole depth ${depth}`)
    }
  }
  if (style === 'countersink') {
    if (!Number.isFinite(csAngle) || csAngle <= 0 || csAngle >= 180) {
      throw new Error(`hole: the countersink angle ${csAngle} must be between 0 and 180 degrees`)
    }
  }

  const radius = diameter / 2.0
  const cbRadius = cbDiameter / 2.0

  const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (plane === undefined) {
    throw new Error(`hole: sketch '${sketchId}' has no plane transform registered`)
  }
  const origin = plane.origin
  const xAxis = plane.x_axis
  const yAxis = plane.y_axis
  const normal = plane.normal
  const axis: Vec3 = (direction === 'normal' ? normal : normal.map((n) => -n)) as Vec3

  let targetBody: Body
  if (targetRef) {
    targetBody = resolveBody(targetRef, bodyStore)
  } else {
    const ids = Object.keys(bodyStore)
    if (ids.length === 0) throw new Error('hole: no bodies in body_store and no target specified')
    targetBody = bodyStore[ids[0]]
  }
  if (targetBody.shape === null) throw new Error(`hole: target body '${targetBody.id}' has no shape`)

  const sketchFeature = featuresById[sketchId] ?? {}
  const drilled = drilledEntities((sketchFeature.entities as Dict[]) ?? [], sketchId, entityId)

  let currentShape = table.get<OccShape>(targetBody.shape)
  // The body's names, carried through every drill cut by its face history.
  // Read at the first cut: a hole that places nothing never touches the shape.
  let names: ShapeNames | null = null

  let throughDepth = 0.0
  let throughBackOffset = 0.0
  // How far a through-all bore runs inside the body, for the thread display.
  let throughSpan = 0.0
  if (depthMode === 'through_all') {
    const span = bodySpanAlong(oc, scope, currentShape, axis)
    // Back the cutter off by the full projected span plus a hair so a site on
    // the body's near face still clears the far face tangentially; the 3x
    // length leaves ample margin on the forward side.
    const margin = span * 1e-3 + 1e-6
    throughDepth = span * 3.0
    throughBackOffset = span + margin
    throughSpan = span
  }

  let skippedCount = 0
  const skippedEntityIds: string[] = []
  // The bores the thread display rides: one entry per site that actually cut,
  // so a thread never draws where the hole removed nothing.
  const threadSites: ThreadSite[] = []
  // This hole's own cuts only, like boolean and bodyOps. Seeding with the body's
  // previous diff credited the last modifier's surviving elements to the hole in a
  // full build, while a build restored past that modifier has no diff to seed with.
  let accumulatedDiff: BrepDiff | null = null
  const missedSites: string[] = []
  let cutAny = false

  for (let i = 0; i < drilled.length; i++) {
    const entity = drilled[i]
    const eid = entity.id as string
    const site = drillSite(globalRepo, sketchId, entity, radius)
    if (site === null) {
      skippedCount++
      skippedEntityIds.push(eid)
      continue
    }
    const [x2d, y2d] = site.xy
    const center3d: Vec3 = [
      origin[0] + x2d * xAxis[0] + y2d * yAxis[0],
      origin[1] + x2d * xAxis[1] + y2d * yAxis[1],
      origin[2] + x2d * xAxis[2] + y2d * yAxis[2],
    ]

    // A circle site carries its own radius, so the widened-mouth geometry is
    // checked against THAT bore, not the feature `diameter` a point would use.
    if (style !== 'simple' && cbRadius <= site.radius) {
      throw new Error(
        `hole: the ${style} mouth diameter ${cbDiameter} must be larger than the bore diameter ${site.radius * 2}`,
      )
    }
    let countersinkDepth = 0
    if (style === 'countersink') {
      // The cone runs from the wide mouth radius down to the bore radius; the
      // included angle fixes how deep that transition sits.
      countersinkDepth = (cbRadius - site.radius) / Math.tan((csAngle * Math.PI) / 360.0)
      if (!Number.isFinite(countersinkDepth) || countersinkDepth <= 0) {
        throw new Error(`hole: the countersink angle ${csAngle} gives no countersink depth`)
      }
      if (depthMode !== 'through_all' && countersinkDepth >= depth) {
        throw new Error(
          `hole: the countersink depth ${countersinkDepth.toFixed(4)} must be less than the blind hole depth ${depth}`,
        )
      }
    }

    let start3d: Vec3
    let h: number
    if (depthMode === 'through_all') {
      start3d = [
        center3d[0] - axis[0] * throughBackOffset,
        center3d[1] - axis[1] * throughBackOffset,
        center3d[2] - axis[2] * throughBackOffset,
      ]
      h = throughDepth
    } else {
      start3d = center3d
      h = depth
    }

    const cutter = buildCutter(
      oc, scope, style, depthMode === 'through_all', start3d, center3d, axis,
      site.radius, h, cbRadius, cbDepth, countersinkDepth, throughBackOffset,
    )
    const cyl = cutter.shape
    if (!intersects(oc, currentShape, cyl)) {
      // The cutter does not reach the body: a drill site that removes nothing.
      // Skipping the cut keeps it out of accumulatedDiff, so the body's stored
      // diff never gains a "whole tool deleted" entry for a miss.
      scope.release(cyl)
      missedSites.push(eid)
      continue
    }
    names ??= readBodyNames(oc, scope, currentShape, targetBody)
    const res = booleanWithDiff(oc, scope, currentShape, cyl, 'cut', { unifyFaces: !targetBody.imported })
    // A drilled face keeps its own name, and the cutter's faces carry theirs from
    // the drill site onto the bore and floor they leave behind. The cutter is
    // dropped after the cut and reaches this one body, so nothing else holds its
    // uuids and they carry verbatim (no toolUuidScope).
    const tool = cutterNames(feature.id as string, sketchId, eid, cutter.roles)
    names = transferBooleanNames(oc, scope, {
      bodyShape: res.shape,
      faceOrigin: res.faceOrigin,
      targetFaceNames: names.faceNames,
      targetFaceAncestry: names.faceAncestry,
      targetCapAncestry: names.capAncestry,
      toolFaceNames: tool.faceNames,
      toolFaceAncestry: tool.faceAncestry,
      toolCapAncestry: tool.capAncestry,
      toolUuidScope: null,
    })
    scope.release(cyl)
    if (i > 0) scope.release(currentShape)
    currentShape = scope.track(res.shape)
    // Accumulate per-cut diffs so all rims survive, not just the last.
    accumulatedDiff = mergeBrepDiff(accumulatedDiff, res.diff)
    cutAny = true
    // The bore the cosmetic thread (if any) is displayed on: the through
    // portion below the widened mouth, never the counterbore wall or the cone.
    const threadOffset = style === 'counterbore' ? cbDepth : style === 'countersink' ? countersinkDepth : 0
    const threadLength = (depthMode === 'through_all' ? throughSpan : depth) - threadOffset
    if (threadLength > 0) {
      threadSites.push({
        center: [
          center3d[0] + axis[0] * threadOffset,
          center3d[1] + axis[1] * threadOffset,
          center3d[2] + axis[2] * threadOffset,
        ],
        axis: [axis[0], axis[1], axis[2]],
        radius: site.radius,
        length: threadLength,
      })
    }
  }

  const total = drilled.length
  const placed = total - skippedCount
  if (placed === 0) {
    // Fail before any bookkeeping. This branch deliberately skips the brep_diff
    // update, so pushing modified_by first would make ancestry re-read the
    // stale diff and pin the PREVIOUS op's sub-shapes on this failed feature.
    throw new Error(
      `hole: all ${total} drill site(s) in sketch '${sketchId}' have no solved geometry; nothing to place`,
    )
  }

  let bodyIds = [targetBody.id]
  if (cutAny) {
    // A hole is a cut, so it can sever the body: a through-hole wider than the
    // web between two features leaves two disconnected solids.
    bodyIds = resplitBody(oc, scope, table, bodyStore, targetBody, currentShape, feature.id as string, names ?? {})
    if (bodyIds.length === 0) {
      // The cut ate the whole body: resplitBody deleted it from the store.
      // Report the deletion with body_id still naming the consumed body (that
      // is what the feature row points at) and body_ids: [] for "nothing
      // survives".
      return {
        status: 'ok',
        body_id: targetBody.id,
        body_ids: [],
        // "removed material" matches the docstring: sites that cut minus those
        // that missed and therefore removed nothing.
        hole_count: placed - missedSites.length,
        solver_warning: `hole: the cut removed all of body '${targetBody.id}'; the body was deleted`,
      }
    }
    targetBody.brep_diff = accumulatedDiff
    targetBody.modified_by.push(feature.id as string)
  }

  const result: HoleResult = {
    status: skippedCount > 0 || (missedSites.length > 0 && missedSites.length < placed) ? 'partial' : 'ok',
    body_id: bodyIds[0],
    body_ids: bodyIds,
    hole_count: placed - missedSites.length,
  }
  if (thread !== null && threadSites.length > 0) {
    result.thread = {
      designation: thread.designation,
      nominal: thread.nominal,
      pitch: thread.pitch,
      helices: threadHelices(threadSites, thread.pitch),
    }
  }
  if (skippedCount > 0) {
    // Wording pinned by the frozen parity snapshot (occ/__fixtures__/hole.json,
    // case `partial_skip`): reword it and the golden result stops matching.
    result.exception = `hole: ${skippedCount}/${total} point(s) skipped, no XY data for: ${skippedEntityIds.join(', ')}`
  } else if (missedSites.length > 0 && missedSites.length < placed) {
    // Some sites cut, some removed nothing: name the misses so the user knows
    // which picks to move.
    result.exception = `hole: ${missedSites.length}/${placed} drill site(s) did not intersect body '${targetBody.id}': ${missedSites.join(', ')}`
  }
  if (placed > 0 && missedSites.length === placed) {
    // Every site had geometry but none removed material. The body is unchanged;
    // ok with this warning beats the old silent ok with hole_count: N.
    result.solver_warning =
      `hole: none of the ${placed} drill site(s) intersect body '${targetBody.id}'; nothing was removed`
  }
  return result
}
