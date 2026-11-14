// The hole leaf. For each drill site the `sketch` ref names it drills a cylinder (blind depth
// or through-all) and boolean-cuts it from the target body. Composite of the cut boolean
// + cylinder primitive.
//
// The ref is a pick chip's raw value, so it names either a whole sketch (every
// non-construction POINT in it) or ONE picked entity. A hole drills points only:
// a point names a position and takes the feature's `diameter`. A circle is a
// profile and not a drill site, so a whole-sketch pick ignores it and a pick
// that names one alone is refused with the extrude-cut alternative (the same
// cylinder through `add_extrude` with `operation: cut`). Construction points are
// skipped by a whole-sketch pick and refused when picked alone.
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
import type { OccModule, OccShape, OccSubShape, OccXYZ } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { parseSketchEntityRef, sketchIdFromQuery, soleEntityInQuery } from './shared/bodyRef'
import { circleDrillSiteReason, constructionOnlyPointsReason, noPointDrillSiteReason, type SketchCircleKind } from './shared/drillSite'
import { resolveBody } from './shared/bodyResolution'
import { mergeBrepDiff } from './shared/brepDiff'
import { stripRefSigil } from '@/utils/refSigil'
import {
  makeCylinder, makeCylinderWithFaces, makeCone, faceSurfaceType, type CylinderFaces, type Vec3,
} from '../occ/primitives'
import { SubShapeMap } from '../occ/subshapeIdentity'
import { holeFacePath, mintFaceUuid, splitFacePath, type HoleFaceRole } from '../constructionName'
import { absolute, emitWire, featureRefId } from '../query'
import { bodySpanAlong, projectedRadius } from './shared/bodyExtent'
import { sameEnum } from '../occ/enumValue'
import { booleanWithDiff, volumeOf } from '../occ/booleans'
import { resplitBody } from './bodySplit'
import { transferBooleanNames } from './booleanLineage'
import { readBodyNames, type ShapeNames } from '../occ/bodyNames'
import { DRILL_POINT_ANGLE } from '../threadTable'
import type { ThreadDisplayData, ThreadSiteData } from '@/types/cad'
import type { PlaneLike } from './shared/planes'
import { swallowUnlessTrap } from '../errors'
import { OCC_CONFUSION, TOL_LENGTH_SLACK, TOL_VOLUME_DEGENERATE } from '../solverConstants'

type Dict = Record<string, unknown>

interface HoleResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
  hole_count: number
  // The side the hole drilled, as resolved: a through hole under `normal` may
  // have voted `reverse`, which is otherwise only visible by measuring faces.
  direction: 'normal' | 'reverse'
  // The cosmetic thread the drilled bores are for, if the feature names one: its
  // metadata plus one tapped run per drilled site. A cosmetic thread changes
  // no geometry, so this rides the result rather than the body.
  thread?: ThreadDisplayData
}

/** A length for a warning: enough digits to read, no float noise. */
function roundForMessage(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/**
 * The uuids the bore named `bore` carries on a shape whose face uuids are
 * `present`: itself if it survived whole, else its split children, and theirs
 * if a later site of this hole split a piece again. Pure identity (the split
 * names are derived from the parent uuid and the child index), never a
 * geometry match.
 *
 * A present uuid is a leaf: a split replaces the parent's name with its
 * children's, so the common whole bore costs one lookup. An absent one was
 * split; its children are numbered from 0, and each is present, split again
 * (absent with children of its own), or consumed outright by a later site's
 * cut, which leaves a gap in the numbering. So the scan tolerates a few
 * consecutive misses before it concludes the children ended. Both bounds keep
 * a bore that vanished entirely to a few dozen hashes.
 */
const BORE_SPLIT_DEPTH = 3
const BORE_SPLIT_GAP = 3

export function boreFamily(bore: string, present: ReadonlySet<string>): string[] {
  const out: string[] = []
  const visit = (uuid: string, depth: number): boolean => {
    if (present.has(uuid)) {
      out.push(uuid)
      return true
    }
    if (depth >= BORE_SPLIT_DEPTH) return false
    let found = false
    let misses = 0
    for (let i = 0; i < present.size && misses < BORE_SPLIT_GAP; i++) {
      if (visit(mintFaceUuid(splitFacePath(uuid, i)), depth + 1)) {
        found = true
        misses = 0
      } else {
        misses++
      }
    }
    return found
  }
  visit(bore, 0)
  return out
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
 * Where one point puts a drill, or null when the solver left it without
 * geometry (the caller counts those as skipped).
 *
 * A point entity names a position and nothing else, so the feature's own
 * diameter is the bore. Nothing else reaches here: a circle is a profile (the
 * caller refuses it with the extrude-cut remedy), and a line, an arc or a
 * spline names no point either.
 */
function drillSite(
  globalRepo: Repository,
  sketchId: string,
  entity: Dict,
): { xy: number[] } | null {
  const eid = entity.id as string
  const xyEntry = globalRepo.elements.get(sketchId + '/' + eid + '/xy') as Dict | undefined
  if (xyEntry === undefined) return null
  return { xy: xyEntry.external_xy as number[] }
}

/**
 * The entities this hole drills. A pick that named one entity drills that one
 * and nothing else -- a user who clicked a single point does not expect the
 * other points in the sketch to be drilled too. A pick that named the sketch
 * drills every non-construction point in it, in the sketch's entity order; a
 * circle is a profile and is ignored, because cutting it is an extrude cut.
 *
 * Construction points are reference geometry (a point an author flags
 * construction), never a drill site: a whole-sketch pick skips them, and a pick
 * that names one is refused rather than silently drilling or skipping it. A
 * circle picked alone is refused: a real one with the extrude-cut remedy, a
 * construction one with the instruction to clear its flag first, because
 * profiles exclude construction geometry. Line endpoints are not drill sites
 * either, while add_center_rect's helper centre point is an ordinary point
 * entity and does drill.
 */

/** What the sketch's circles offer when no point can be drilled. */
function circleKindOf(entities: Dict[]): SketchCircleKind {
  if (entities.some((e) => e.kind === 'circle' && e.construction !== true)) return 'real'
  return entities.some((e) => e.kind === 'circle') ? 'construction' : 'none'
}

function drilledEntities(
  entities: Dict[],
  sketchId: string,
  entityId: string | null,
): Dict[] {
  if (entityId === null) {
    const candidates = entities.filter((e) => e.kind === 'point')
    const sites = candidates.filter((e) => e.construction !== true)
    if (sites.length === 0) {
      const circle = circleKindOf(entities)
      if (candidates.length > 0) {
        throw new Error('hole: ' + constructionOnlyPointsReason(sketchId, circle))
      }
      throw new Error('hole: ' + noPointDrillSiteReason(sketchId, circle))
    }
    return sites
  }
  const picked = entities.find((e) => e.id === entityId)
  if (picked === undefined) throw new Error(`hole: sketch '${sketchId}' has no entity '${entityId}'`)
  if (picked.kind === 'circle') {
    throw new Error('hole: ' + circleDrillSiteReason(sketchId, entityId, picked.construction === true))
  }
  if (picked.kind === 'point') {
    if (picked.construction === true) {
      throw new Error(
        `hole: '${entityId}' of sketch ${sketchId} is a construction point, which names no drill site; ` +
        'construction geometry is reference only; toggle its construction off to drill it, or pick the sketch itself',
      )
    }
    return [picked]
  }
  throw new Error(
    `hole: '${entityId}' of sketch ${sketchId} is a ${picked.kind}, which names no drill site; ` +
    'pick a sketch point, or the sketch itself',
  )
}

/**
 * The source a projected sketch entity was projected from, or null when the
 * entity carries no `projection` constraint.
 *
 * Since projection-constraint a projected point is an ordinary point held by
 * that constraint, so the projection itself is a drill site. When a second
 * point sits on it, naming what the kept site is projected from is what tells
 * the author which of the two the recipe wanted.
 */
function projectionSourceOf(sketchFeature: Dict, entityId: string): string | null {
  const constraints = (sketchFeature.constraints as Dict[] | undefined) ?? []
  for (const constraint of constraints) {
    if (constraint.kind !== 'projection' || typeof constraint.target !== 'string') continue
    const source = constraint.source
    // The stored target is the entity's own operand spelling, so strip its
    // sigil rather than minting one: this only reads the constraint.
    if (constraint.target.replace(/^\$/, '') === entityId && typeof source === 'string' && source !== '') {
      return source
    }
  }
  return null
}

/**
 * Construction names for one drill site's cutter, keyed by its faces before the
 * cut: the bore wall, the mouth (the cutter's start disc), the floor (its end
 * disc), and for a widened mouth the counterbore's wall and step floor or the
 * countersink's cone, and for a drill-point blind hole the tip cone in place of
 * the floor. A through_all cutter starts backed off outside the body and ends
 * past it, so only a blind hole's floor or tip, or a mouth at a site inside
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
 *  only the surviving disc. A drill-point tip fused under the bore drops the
 *  end disc, so its `floor` maps to nothing. */
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
 * A drill-point tip is fused first, at the bore's far end.
 *
 * `start` and `boreAxis` place the bore (backed off across any air gap for a
 * through hole); `mouth` and `mouthAxis` place the widened mouth, measured from
 * the drill site's plane INTO the material. The solve passes one axis for both:
 * the hole drills one way. `airGap` is how far the entry face sits below the
 * sketch plane and `overhang` how far past the plane the tool reaches (the gap
 * plus a hair), so the mouth is opened at full width at the FACE, with its
 * depth measured from there. Both are zero for a blind hole, whose mouth is on
 * the face, and for a through hole whose plane already touches the material.
 *
 * `tipHeight` is a blind bore's drill-point cone, fused under the bore's end so
 * the depth stays measured to the shoulder (the full-diameter part) and the
 * point reaches past it; zero keeps the flat floor.
 */
function buildCutter(
  oc: OccModule,
  scope: DisposeScope,
  style: string,
  start: Vec3,
  boreAxis: Vec3,
  mouth: Vec3,
  mouthAxis: Vec3,
  airGap: number,
  overhang: number,
  radius: number,
  boreLength: number,
  cbRadius: number,
  cbDepth: number,
  coneHeight: number,
  tipHeight: number,
): Cutter {
  const bore = makeCylinderWithFaces(oc, scope, start, boreAxis, radius, boreLength)
  let cutter: Cutter = { shape: bore.shape, roles: cylinderRoles(bore.faces, 'bore', 'floor') }
  if (tipHeight > 0) {
    // The cone's base is the bore's end disc, so the fuse drops both and the
    // flat floor gives way to the point.
    const tip = makeCone(oc, scope, backAlong(start, boreAxis, -boreLength), boreAxis, radius, 0, tipHeight)
    const lateral = coneLateral(oc, scope, tip)
    const roles = new SubShapeMap<HoleFaceRole>()
    if (lateral !== null) roles.set(lateral, 'tip')
    cutter = fuseCutter(oc, scope, cutter, { shape: tip, roles })
  }
  // The widened mouth is measured from the entry FACE, which is airGap below
  // the sketch plane; the overhang carries it back past the plane.
  const reach = overhang + airGap
  if (style === 'counterbore') {
    const stepStart = backAlong(mouth, mouthAxis, overhang)
    const step = makeCylinderWithFaces(oc, scope, stepStart, mouthAxis, cbRadius, reach + cbDepth)
    cutter = fuseCutter(oc, scope, cutter, {
      shape: step.shape,
      roles: cylinderRoles(step.faces, 'step_wall', 'step_floor'),
    })
  } else if (style === 'countersink') {
    // The cone widens away from the material, so reaching back to the face
    // means starting further back at a correspondingly wider r1: the slope is
    // fixed by the distance the cone covers between the two radii.
    const slope = (cbRadius - radius) / coneHeight
    const coneStart = backAlong(mouth, mouthAxis, overhang)
    const cone = makeCone(oc, scope, coneStart, mouthAxis, cbRadius + reach * slope, radius, coneHeight + reach)
    const lateral = coneLateral(oc, scope, cone)
    const roles = new SubShapeMap<HoleFaceRole>()
    if (lateral !== null) roles.set(lateral, 'sink')
    cutter = fuseCutter(oc, scope, cutter, { shape: cone, roles })
  }
  return { shape: scope.track(cutter.shape), roles: cutter.roles }
}

/** `point` moved `distance` back along `axis` (toward the air side). */
function backAlong(point: Vec3, axis: Vec3, distance: number): Vec3 {
  return [
    point[0] - axis[0] * distance,
    point[1] - axis[1] * distance,
    point[2] - axis[2] * distance,
  ]
}

/** How far `mouth` sits outside the body's AABB on its AIR side, along `dir`
 *  (which points into the material). The air side is the -dir end, so the mouth
 *  is outside the box when its projection along `dir` falls below the box's
 *  minimum. A mouth on or inside the AABB returns zero. */
function airGapAlong(frame: { center: Vec3; half: Vec3 }, mouth: Vec3, dir: Vec3): number {
  const centre = frame.center[0] * dir[0] + frame.center[1] * dir[1] + frame.center[2] * dir[2]
  const atMouth = mouth[0] * dir[0] + mouth[1] * dir[1] + mouth[2] * dir[2]
  const gap = (centre - projectedRadius(frame, dir)) - atMouth
  return gap > 0 ? gap : 0
}

/** How far the AABB lies ahead of `mouth` along `dir`: the length a probe must
 *  span to reach the body from a mouth outside the box, and no more. */
function reachAlong(frame: { center: Vec3; half: Vec3 }, mouth: Vec3, dir: Vec3): number {
  const centre = frame.center[0] * dir[0] + frame.center[1] * dir[1] + frame.center[2] * dir[2]
  const atMouth = mouth[0] * dir[0] + mouth[1] * dir[1] + mouth[2] * dir[2]
  return Math.max(0, (centre + projectedRadius(frame, dir)) - atMouth)
}

/** Which side of the sketch plane a through hole drills: along the plane
 *  normal, or against it. */
type DrillSide = 'normal' | 'reverse'

/** What one site's side probe saw: material on one side only (that side), on
 *  both (the plane runs through the body there), or on neither (out of reach). */
type SideProbe = DrillSide | 'both' | 'none'

/** Where a site's material lies relative to the sketch plane, read by probing a
 *  bore-radius cylinder either way along the plane `normal`. A face sketch
 *  registers the face's OUTWARD normal, so the authored axis points out of the
 *  body there, and only the probe can tell which side the material is on.
 *
 *  Each probe reaches as far as the body's AABB along its direction, not just
 *  the mouth depth: a sketch plane can sit further above the entry face than
 *  the counterbore is deep, and a short probe would then miss on both sides and
 *  leave the side undecided. */
function probeSide(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  frame: { center: Vec3; half: Vec3 },
  mouth: Vec3,
  normal: Vec3,
  radius: number,
  depth: number,
): SideProbe {
  const away = normal.map((n) => -n) as Vec3
  const forwardHits = probeHits(oc, scope, shape, mouth, normal, radius, reachAlong(frame, mouth, normal) + depth)
  const backwardHits = probeHits(oc, scope, shape, mouth, away, radius, reachAlong(frame, mouth, away) + depth)
  if (forwardHits && backwardHits) return 'both'
  if (forwardHits) return 'normal'
  return backwardHits ? 'reverse' : 'none'
}

/** Whether a bore-radius probe of `length` along `dir` meets the body. A mouth
 *  on the AABB's limit has nothing ahead of it on that side, and a simple hole
 *  adds no mouth depth, so the probe would be a zero-height cylinder: that side
 *  holds no material by construction, and the degenerate solid is never built
 *  (a failed Common reads as a hit in `intersects`). */
function probeHits(
  oc: OccModule, scope: DisposeScope, shape: OccShape, mouth: Vec3, dir: Vec3, radius: number, length: number,
): boolean {
  if (!(length > TOL_LENGTH_SLACK)) return false
  const probe = makeCylinder(oc, scope, mouth, dir, radius, length)
  const hit = intersects(oc, shape, probe)
  scope.release(probe)
  return hit
}

/**
 * The one side a through hole drills at every site, and the sites that leave
 * material on the other side of the plane uncut.
 *
 * The side is the feature's, not each site's, so one hole never opens its
 * counterbores on two sides: a site the probe cannot decide (the plane runs
 * through the body there) follows the sites that can. Those vote and every
 * site drills the winner; a tie, or no deciding site, keeps `normal`, the side
 * the document names.
 */
function resolveDrillSide(probes: Array<{ eid: string; probe: SideProbe }>): {
  side: DrillSide
  otherSide: string[]
} {
  let normalVotes = 0
  let reverseVotes = 0
  for (const { probe } of probes) {
    if (probe === 'normal') normalVotes++
    else if (probe === 'reverse') reverseVotes++
  }
  const side: DrillSide = reverseVotes > normalVotes ? 'reverse' : 'normal'
  const otherSide = probes
    .filter(({ probe }) => probe === 'both' || (probe !== 'none' && probe !== side))
    .map(({ eid }) => eid)
  return { side, otherSide }
}

/**
 * Whether one site's tool built along `axis` would remove material: build it,
 * probe it, drop it. The opposite-direction check a blind miss runs before it
 * warns; the cut itself is never attempted, so only the verdict leaves here.
 */
function cutterReaches(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  style: string,
  mouth: Vec3,
  axis: Vec3,
  radius: number,
  depth: number,
  cbRadius: number,
  cbDepth: number,
  coneHeight: number,
  tipHeight: number,
): boolean {
  const probe = buildCutter(
    oc, scope, style, mouth, axis, mouth, axis, 0, 0, radius, depth, cbRadius, cbDepth, coneHeight, tipHeight,
  )
  const hit = intersects(oc, shape, probe.shape)
  scope.release(probe.shape)
  return hit
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
    // Budget relative to the tool's own volume: a real hit is a piece of the
    // tool, and OCC integrates it with error that scales with the shape, so a
    // 1000x copy of the same probe clears the same fraction of itself. A tool
    // that integrates to zero mass clears only a floored budget: the bare
    // fraction would read 0 >= 0 as a hit for a degenerate probe, and a failed
    // Common already reads as a hit elsewhere.
    const toolVolume = Math.abs(volumeOf(oc, probe, tool))
    const floor = TOL_VOLUME_DEGENERATE * TOL_VOLUME_DEGENERATE  // breaks the 0 >= 0 tie only
    return volumeOf(oc, probe, inter) >= Math.max(TOL_VOLUME_DEGENERATE * toolVolume, floor)
  } catch (e) {
    swallowUnlessTrap(e)
    return true
  } finally {
    probe.dispose()
  }
}

/**
 * The body a hole with no authored target drills into: the one its sites sit on
 * or in. A face sketch's sites lie ON the face they were sketched on, so a
 * boundary hit counts (the enclosure's lid is not the first body); a plane
 * sketch floating above the part classifies OUT everywhere, and the old
 * first-body default still answers, with the existing miss warning if it is
 * the wrong body.
 *
 * The best score wins, first body on a tie, so the choice follows the geometry
 * rather than the store order.
 */
function defaultTargetBody(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  sites: ReadonlyArray<{ center3d: Vec3 }>,
): Body | null {
  if (sites.length === 0) return null
  const shaped = Object.values(bodyStore).filter(body => body.shape !== null)
  // One candidate needs no classification, which is also the common case.
  if (shaped.length === 1) return shaped[0]
  const state = oc.TopAbs_State
  let best: Body | null = null
  let bestScore = 0
  for (const body of shaped) {
    if (body.shape === null) continue
    const shape = table.get<OccShape>(body.shape)
    let score = 0
    for (const site of sites) {
      const [x, y, z] = site.center3d
      try {
        const probe = scope.track(new oc.gp_Pnt_3(x, y, z)) as OccXYZ
        const classifier = scope.track(new oc.BRepClass3d_SolidClassifier_3(shape, probe, OCC_CONFUSION))
        const verdict = classifier.State()
        if (sameEnum(verdict, state.TopAbs_IN)) score += 2
        else if (sameEnum(verdict, state.TopAbs_ON)) score += 1
      } catch (e) {
        swallowUnlessTrap(e)
        // A body whose shape is not a classifiable solid cannot claim a site;
        // the first-body fallback still answers and the cut names its own
        // failure, as it did before the default followed the sites.
      }
    }
    if (score > bestScore) {
      best = body
      bestScore = score
    }
  }
  return best
}

/**
 * Solve a hole feature into the body store (mirrors `_solve_hole`).
 *
 * The result's accounting split: a site is MISSED when it had geometry but the
 * boolean removed nothing. A site whose own cutter lies inside an earlier site's
 * bore is SWALLOWED instead: the earlier cut already removed that material, so
 * the site is a warning with the delete/move remedy, not a miss. `hole_count` is
 * sites that removed material (placed minus missed minus swallowed). A hole
 * where SOME sites cut and some missed is `partial` and names the missed sites;
 * a swallowed site never makes the hole partial. A hole where every site missed
 * keeps `status: 'ok'` with a solver warning (the body is unchanged, and a
 * warning beats the old silent ok), matching the bodyOps warning-with-ok
 * convention. `partial` is reserved for the mixed case. A hole that consumes the
 * whole body (a through-hole wider than the body) goes through resplitBody's
 * deletion path: the body leaves the store and the result reports it with
 * `body_ids: []`.
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
  // Absent means the whole bore. Only a threaded hole reads it, so a stale
  // value left behind by switching the thread off cannot refuse a plain hole.
  const threadDepth = thread !== null && sub.thread_depth !== undefined && sub.thread_depth !== null
    ? Number(sub.thread_depth)
    : null
  const style = (sub.style as string) ?? 'simple'
  const cbDiameter = Number(sub.cb_diameter ?? 0)
  const cbDepth = Number(sub.cb_depth ?? 0)
  const csAngle = Number(sub.cs_angle ?? 90)
  // The blind bore's bottom: flat, or the cone a twist drill leaves. A through
  // hole has no bottom, so it never reads either field.
  const tip = (sub.tip as string) ?? 'flat'
  const tipAngle = Number(sub.tip_angle ?? DRILL_POINT_ANGLE)

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
  if (threadDepth !== null && (!Number.isFinite(threadDepth) || threadDepth <= 0)) {
    throw new Error('hole: thread_depth must be positive')
  }
  if (tip !== 'flat' && tip !== 'drill_point') {
    throw new Error(`hole: tip '${tip}' is not flat or drill_point`)
  }
  const pointed = tip === 'drill_point' && depthMode !== 'through_all'
  if (pointed && (!Number.isFinite(tipAngle) || tipAngle <= 0 || tipAngle >= 180)) {
    throw new Error(`hole: the drill point angle ${tipAngle} must be between 0 and 180 degrees`)
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

  // An authored target is settled before the sketch content, so a bad target
  // is reported as such even when the sketch is also unusable (the guard order
  // the editor and the scripts rely on). A default target needs the sites, so
  // that path waits for them below.
  let targetBody: Body | null = null
  if (targetRef) {
    targetBody = resolveBody(targetRef, bodyStore)
    if (targetBody.shape === null) throw new Error(`hole: target body '${targetBody.id}' has no shape`)
  } else if (Object.keys(bodyStore).length === 0) {
    throw new Error('hole: no bodies in body_store and no target specified')
  }

  const sketchFeature = featuresById[sketchId] ?? {}
  const drilled = drilledEntities((sketchFeature.entities as Dict[]) ?? [], sketchId, entityId)

  // Each site's position and mouth geometry, settled before any cut so the
  // drill side can be resolved across all of them first. Settled before the
  // target too: a hole with no authored target drills into the body its sites
  // sit on, so the sites must exist before that body is chosen.
  const sites: Array<{ eid: string; radius: number; center3d: Vec3; countersinkDepth: number; tipHeight: number }> = []
  let skippedCount = 0
  const skippedEntityIds: string[] = []
  // Bores that overlap in the sketch merge into one cut without a word (kcl
  // bracket F3); the pairs are named in the result's warning instead. A site
  // whose own disc lies inside an earlier site's bore leaves no material to
  // remove, which the per-site cut below turns into a swallowed-site warning
  // rather than a miss; the overlaps are kept per site so it can tell the two
  // apart and name the site that already did the work.
  const siteDiscs: Array<{ id: string; xy: [number, number]; radius: number }> = []
  const siteOverlaps = new Map<string, Array<{ earlier: string; coincident: boolean }>>()
  for (const entity of drilled) {
    const eid = entity.id as string
    const site = drillSite(globalRepo, sketchId, entity)
    if (site === null) {
      skippedCount++
      skippedEntityIds.push(eid)
      continue
    }
    const [x2d, y2d] = site.xy
    const overlaps: Array<{ earlier: string; coincident: boolean }> = []
    for (const earlier of siteDiscs) {
      const distance = Math.hypot(earlier.xy[0] - x2d, earlier.xy[1] - y2d)
      if (distance < earlier.radius + radius - TOL_LENGTH_SLACK) {
        overlaps.push({ earlier: earlier.id, coincident: distance < TOL_LENGTH_SLACK })
      }
    }
    if (overlaps.length > 0) siteOverlaps.set(eid, overlaps)
    siteDiscs.push({ id: eid, xy: [x2d, y2d], radius })
    const center3d: Vec3 = [
      origin[0] + x2d * xAxis[0] + y2d * yAxis[0],
      origin[1] + x2d * xAxis[1] + y2d * yAxis[1],
      origin[2] + x2d * xAxis[2] + y2d * yAxis[2],
    ]

    // Every site drills at the feature `diameter`; a point carries no size of
    // its own.
    if (style !== 'simple' && cbRadius <= radius) {
      throw new Error(
        `hole: the ${style} mouth diameter ${cbDiameter} must be larger than the bore diameter ${radius * 2}`,
      )
    }
    let countersinkDepth = 0
    if (style === 'countersink') {
      // The cone runs from the wide mouth radius down to the bore radius; the
      // included angle fixes how deep that transition sits.
      countersinkDepth = (cbRadius - radius) / Math.tan((csAngle * Math.PI) / 360.0)
      if (!Number.isFinite(countersinkDepth) || countersinkDepth <= 0) {
        throw new Error(`hole: the countersink angle ${csAngle} gives no countersink depth`)
      }
      if (depthMode !== 'through_all' && countersinkDepth >= depth) {
        throw new Error(
          `hole: the countersink depth ${countersinkDepth.toFixed(4)} must be less than the blind hole depth ${depth}`,
        )
      }
    }
    // A drill point's height follows the bore, which is the feature diameter.
    const tipHeight = pointed ? radius / Math.tan((tipAngle * Math.PI) / 360.0) : 0
    sites.push({ eid, radius, center3d, countersinkDepth, tipHeight })
  }

  // The body the sites drill: the authored target settled above, or the body
  // they sit on.
  if (targetBody === null) {
    const ids = Object.keys(bodyStore)
    targetBody = defaultTargetBody(oc, scope, table, bodyStore, sites) ?? bodyStore[ids[0]]
  }
  if (targetBody.shape === null) throw new Error(`hole: target body '${targetBody.id}' has no shape`)

  let currentShape = table.get<OccShape>(targetBody.shape)
  // The body's names, carried through every drill cut by its face history.
  // Read at the first cut: a hole that places nothing never touches the shape.
  let names: ShapeNames | null = null

  let throughMargin = 0.0
  // How far a through-all bore runs inside the body, for the thread display.
  let throughSpan = 0.0
  // The body's edge-sampled AABB, kept for a widened mouth's air-side reach.
  let throughFrame: { center: Vec3; half: Vec3 } | null = null
  if (depthMode === 'through_all') {
    const { span, frame } = bodySpanAlong(oc, scope, currentShape, axis)
    // A hair past the far face so the bore clears it rather than ending on it.
    throughMargin = span * 1e-3 + 1e-6
    throughSpan = span
    throughFrame = frame
  }

  // The one side every site drills. A blind hole and an authored `reverse` keep
  // the authored axis. `normal` is also what every hole stored before this rule
  // says, including the face-sketch through holes that relied on the probe to
  // find the material, so a through hole under `normal` probes and votes.
  // An authored `reverse` still probes, but only to know where the material
  // behind each site's plane is (see materialBehind below), never to vote.
  let side: DrillSide = direction === 'reverse' ? 'reverse' : 'normal'
  let otherSideSites: string[] = []
  let probes: Array<{ eid: string; probe: SideProbe }> = []
  if (depthMode === 'through_all' && throughFrame !== null) {
    const frame = throughFrame
    probes = sites.map((s) => ({
      eid: s.eid,
      probe: probeSide(oc, scope, currentShape, frame, s.center3d, normal as Vec3, s.radius,
        style === 'counterbore' ? cbDepth : s.countersinkDepth),
    }))
    if (direction !== 'reverse') {
      const resolved = resolveDrillSide(probes)
      side = resolved.side
      otherSideSites = resolved.otherSide
    }
  }
  const drillAxis: Vec3 = (side === 'normal' ? normal : normal.map((n) => -n)) as Vec3
  // Whether a site's plane has material on the side the hole does not drill.
  // Such a bore must start exactly on the plane so the material behind stays
  // whole. Every other through bore starts a hair behind its entry: a cutter
  // whose start disc only touches the body (a radial bore on a cylinder's
  // tangent plane) leaves a sliver at the contact uncut.
  const materialBehind = (i: number): boolean => {
    const probe = probes[i]?.probe
    return probe === 'both' || (probe !== undefined && probe !== 'none' && probe !== side)
  }

  // The tapped bores the viewport shades: one entry per site that actually cut,
  // so a thread never shows where the hole removed nothing.
  const threadSites: ThreadSiteData[] = []
  // Sites whose thread_depth overran the bore (clamped) or stopped inside the
  // widened mouth (no tapped run), named in the warning.
  const threadClamped: string[] = []
  const threadUntapped: string[] = []
  // This hole's own cuts only, like boolean and bodyOps. Seeding with the body's
  // previous diff credited the last modifier's surviving elements to the hole in a
  // full build, while a build restored past that modifier has no diff to seed with.
  let accumulatedDiff: BrepDiff | null = null
  const missedSites: string[] = []
  // Sites whose cut removed no material, and the earlier sites of this hole
  // whose bores already cover them. Reported as a warning with a remedy, never
  // as a miss: the hole itself is right.
  const swallowedSites: Array<{ eid: string; coincident: boolean; earlier: string[] }> = []
  // The sites whose cut did remove material, in drill order. A swallowed site
  // needs one of these among the sites it overlaps: nothing else explains the
  // empty probe.
  const cutSites = new Set<string>()
  let cutAny = false
  // Set when a missed blind site would cut with the opposite direction, so the
  // all-missed warning can point at `direction` instead of only reporting.
  let oppositeCuts = false

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    const { eid, center3d, countersinkDepth, tipHeight } = site

    // A through hole drills one way: from the sketch plane (backed off across
    // the air gap, plus a hair, when nothing lies behind it) to past the far
    // face. Material behind the plane is never cut, which is what "through all"
    // reads as, even where something sits on the plane's other side.
    const airGap = depthMode === 'through_all' && throughFrame !== null
      ? airGapAlong(throughFrame, center3d, drillAxis)
      : 0
    const overhang = depthMode === 'through_all' && !materialBehind(i) ? airGap + throughMargin : 0

    let start3d: Vec3
    let h: number
    if (depthMode === 'through_all') {
      // The bore starts at the step rather than protruding above the widened
      // mouth: the fuse would split a protruding wall into the piece above the
      // step and the piece below, and only one can carry the bore role. The
      // overhang counts twice: once to reach back to the mouth and once more
      // because a mouth above the entry face is up to the same distance short
      // of the far face.
      start3d = backAlong(center3d, drillAxis, overhang)
      h = throughSpan + 2.0 * overhang + throughMargin
    } else {
      start3d = center3d
      h = depth
    }

    const cutter = buildCutter(
      oc, scope, style, start3d, drillAxis, center3d, drillAxis, airGap, overhang,
      site.radius, h, cbRadius, cbDepth, countersinkDepth, tipHeight,
    )
    const cyl = cutter.shape
    if (!intersects(oc, currentShape, cyl)) {
      // The cutter does not reach the body: a drill site that removes nothing.
      // Skipping the cut keeps it out of accumulatedDiff, so the body's stored
      // diff never gains a "whole tool deleted" entry for a miss.
      scope.release(cyl)
      const overlaps = siteOverlaps.get(eid) ?? []
      const cutOverlaps = overlaps.filter((o) => cutSites.has(o.earlier))
      if (cutOverlaps.length > 0) {
        // An earlier site of this hole already cut this spot away, so the empty
        // probe is not a placement problem: the cutter lies inside that bore.
        // A coincident twin is the common authoring slip and names the one site
        // to keep; an off-centre site needs several earlier bores to cover it.
        const twins = cutOverlaps.filter((o) => o.coincident)
        swallowedSites.push({
          eid,
          coincident: twins.length > 0,
          earlier: twins.length > 0 ? [twins[0].earlier] : cutOverlaps.map((o) => o.earlier),
        })
        // The direction is not the problem, so the opposite-side probe would
        // only answer a question nobody asked.
        continue
      }
      // A hole on a face sketch commonly points out of the body. When the side
      // is the author's (a blind hole, or a through hole set to reverse), probe
      // the other way so the all-missed warning can name the one-field fix; a
      // site that misses both ways is a placement problem, not a direction one,
      // and keeps the plain miss text. A voted side already looked both ways.
      const authoredSide = depthMode !== 'through_all' || direction === 'reverse'
      if (authoredSide && !oppositeCuts) {
        const away = drillAxis.map((n) => -n) as Vec3
        const reach = depthMode === 'through_all' && throughFrame !== null
          ? reachAlong(throughFrame, center3d, away) + throughMargin
          : depth
        oppositeCuts = cutterReaches(
          oc, scope, currentShape, style, center3d, away, site.radius, reach,
          cbRadius, cbDepth, countersinkDepth, tipHeight,
        )
      }
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
      targetFaceOwner: names.faceOwner,
      targetEdgeOwner: names.edgeOwner,
      toolFaceNames: tool.faceNames,
      toolFaceAncestry: tool.faceAncestry,
      toolCapAncestry: tool.capAncestry,
      // The cutter is this hole's own tool: its wall, floor and mouth belong to
      // the hole. Without it a bore that opens into a face an earlier feature
      // owns takes that face's owner on the breakout edge, because the tool
      // face has no owner to be preferred over it.
      toolCreatedBy: feature.id as string,
      toolUuidScope: null,
    })
    scope.release(cyl)
    // Only a previous cut's own result is this solve's to free; until the first
    // cut, currentShape is the target body's stored shape.
    if (cutAny) scope.release(currentShape)
    currentShape = scope.track(res.shape)
    // Accumulate per-cut diffs so all rims survive, not just the last.
    accumulatedDiff = mergeBrepDiff(accumulatedDiff, res.diff)
    cutAny = true
    cutSites.add(eid)
    // The bore the cosmetic thread (if any) is displayed on: the through
    // portion below the widened mouth, never the counterbore wall or the cone.
    const threadOffset = style === 'counterbore' ? cbDepth : style === 'countersink' ? countersinkDepth : 0
    // A through bore ends at the body's far limit along the drill axis, which a
    // plane inside the body reaches in less than the whole span.
    const boreLength = depthMode === 'through_all' && throughFrame !== null
      ? reachAlong(throughFrame, center3d, drillAxis) - airGap
      : depth
    // Where the tap stops, from the same origin as the bore length (the entry
    // face; the sketch plane for a blind hole): the authored thread_depth, but
    // never past the full-diameter bore, so a drill-point cone stays untapped.
    let tapEnd = boreLength
    if (threadDepth !== null) {
      // A through bore's length is the body's bounding-box reach, so a value
      // that runs past the real exit face but inside the box (an L flange
      // further along the axis) clamps silently; the shading itself still
      // stops at the faces, which are all the bore has.
      if (threadDepth > boreLength + TOL_LENGTH_SLACK) threadClamped.push(`${eid} (${roundForMessage(boreLength)})`)
      tapEnd = Math.min(threadDepth, boreLength)
    }
    const threadLength = tapEnd - threadOffset
    // The thread rides the bore below the widened mouth, measured from the
    // entry face, not the sketch plane that may sit above it.
    const threadStart = airGap + threadOffset
    if (threadLength > TOL_LENGTH_SLACK) {
      threadSites.push({
        center: [
          center3d[0] + drillAxis[0] * threadStart,
          center3d[1] + drillAxis[1] * threadStart,
          center3d[2] + drillAxis[2] * threadStart,
        ],
        axis: [drillAxis[0], drillAxis[1], drillAxis[2]],
        radius: site.radius,
        length: threadLength,
        // The name cutterNames gave this site's bore face; widened to its
        // split pieces once every site has cut (boreFamily below).
        bore_uuids: [mintFaceUuid(holeFacePath(feature.id as string, `${sketchId}/${eid}`, 'bore'))],
      })
    } else if (thread !== null && threadDepth !== null) {
      threadUntapped.push(eid)
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

  // A bore that crosses a gap (a slot, the inside of a U channel) or is cut by
  // a later site of this hole leaves several faces, and the boolean names each
  // piece as a split child of the bore rather than the bore itself. The
  // viewport shades by uuid, so each site reports its whole family as it
  // stands on the final shape.
  if (names !== null) {
    const present = new Set(names.faceNames.values())
    for (const site of threadSites) site.bore_uuids = boreFamily(site.bore_uuids[0], present)
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
        // that missed or were swallowed and therefore removed nothing.
        hole_count: placed - missedSites.length - swallowedSites.length,
        direction: side,
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
    hole_count: placed - missedSites.length - swallowedSites.length,
    direction: side,
  }
  if (thread !== null && threadSites.length > 0) {
    result.thread = {
      designation: thread.designation,
      nominal: thread.nominal,
      pitch: thread.pitch,
      sites: threadSites,
    }
  }
  // Both messages are facts about this solve: the skipped sites were never
  // placed and the missed ones were placed but removed nothing. Reporting one
  // of them must not hide the other. The `partial_skip` prefix stays first
  // because its wording is pinned by the frozen parity snapshot.
  const partialReasons: string[] = []
  if (skippedCount > 0) {
    partialReasons.push(
      `hole: ${skippedCount}/${total} point(s) skipped, no XY data for: ${skippedEntityIds.join(', ')}`,
    )
  }
  if (missedSites.length > 0 && missedSites.length < placed) {
    // Some sites cut, some removed nothing: name the misses so the user knows
    // which picks to move.
    partialReasons.push(
      `hole: ${missedSites.length}/${placed} drill site(s) did not intersect body '${targetBody.id}': ${missedSites.join(', ')}`,
    )
  }
  if (partialReasons.length > 0) result.exception = partialReasons.join('; ')
  if (placed > 0 && missedSites.length === placed) {
    // Every site had geometry but none removed material. The body is unchanged;
    // ok with this warning beats the old silent ok with hole_count: N.
    const authored = direction === 'normal' ? 'normal' : 'reverse'
    const other = authored === 'normal' ? 'reverse' : 'normal'
    result.solver_warning = oppositeCuts
      ? `hole: direction: ${authored} cuts nothing in body '${targetBody.id}' at every drill site; direction: ${other} drills into it`
      : `hole: none of the ${placed} drill site(s) intersect body '${targetBody.id}'; nothing was removed`
  } else if (otherSideSites.length > 0) {
    // The hole removed material, but these sites left material on the other
    // side of the plane. Naming them is the only cue, since the volume looks
    // plausible either way. One through hole drills one side; `reverse` is the
    // authored side that silences this.
    const fix = side === 'normal' ? 'set direction: reverse to drill the other way' : 'set direction: reverse to keep it'
    result.solver_warning =
      `hole: sites ${otherSideSites.join(', ')} have material on the other side; ` +
      `drilled ${side} at all sites (a through hole drills one side), ${fix}`
  }
  // A swallowed site is a warning with a remedy, never a miss: the hole's cut
  // is right, the author only placed one site too many. The note replaces the
  // generic overlap pair for the same sites so the author reads one fact and
  // one fix, not two messages saying different things.
  const swallowedIds = new Set(swallowedSites.map((site) => site.eid))
  for (const site of swallowedSites) {
    const twin = site.earlier[0]
    let note: string
    if (site.coincident) {
      // The parenthesis names the projection a twin duplicates, which is the
      // case the old recipe produced: the projected origin IS the drill site.
      const source = projectionSourceOf(sketchFeature, twin)
      note = `hole: site ${site.eid} sits on site ${twin} and drills nothing; ` +
        `one point per hole is enough, delete ${site.eid}` +
        (source === null ? '' : ` (${twin} is the projection of ${source})`)
    } else {
      note = `hole: site ${site.eid} lies inside the bores of sites ${site.earlier.join(', ')} ` +
        `and drills nothing; move or delete ${site.eid}`
    }
    result.solver_warning = result.solver_warning === undefined ? note : `${result.solver_warning}; ${note}`
  }
  // A pair whose later site was swallowed is already explained above; only the
  // pairs that both cut merge into one bore.
  const mergedPairs: string[] = []
  for (const [later, overlaps] of siteOverlaps) {
    if (swallowedIds.has(later)) continue
    for (const overlap of overlaps) {
      if (swallowedIds.has(overlap.earlier)) continue
      mergedPairs.push(`sites ${overlap.earlier}, ${later}`)
    }
  }
  if (mergedPairs.length > 0) {
    const note = `hole: drill sites overlap and merge into one cut: ${mergedPairs.join('; ')}`
    result.solver_warning = result.solver_warning === undefined ? note : `${result.solver_warning}; ${note}`
  }
  // A cosmetic overrun is a warning, not a failure: the cut itself is right,
  // and a thread note must not red the feature.
  const threadNotes: string[] = []
  if (threadClamped.length > 0) {
    threadNotes.push(
      `hole: thread_depth ${threadDepth} exceeds the bore at sites ${threadClamped.join(', ')} (bore length in parentheses); ` +
      'the thread stops at the bore end',
    )
  }
  if (threadUntapped.length > 0) {
    threadNotes.push(
      `hole: thread_depth ${threadDepth} ends above the bore ${style === 'simple' ? 'start' : `(inside the ${style})`} ` +
      `at sites ${threadUntapped.join(', ')}; no thread is tapped there`,
    )
  }
  for (const note of threadNotes) {
    result.solver_warning = result.solver_warning === undefined ? note : `${result.solver_warning}; ${note}`
  }
  return result
}
