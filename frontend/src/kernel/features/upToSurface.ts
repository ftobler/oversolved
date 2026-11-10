// Curved up_to and up_to_next trims (feature: extrude-up-to-surface).
//
// A planar up_to target still trims with a half-space (upTo.ts). A curved target
// has no half-space, so the over-length tool is split by the target face itself
// (BRepAlgoAPI_Splitter) and the solid pieces containing the profile's start cap
// are kept. The same splitter trims `up_to_next` at the offset stop surface.
//
// The offset is a true face offset along the material's outward normal, not a
// translation along the extrude: on a cylinder that is what keeps an emboss a
// uniform height. `BRepOffsetAPI_MakeOffsetShape` offsets along the face's own
// oriented normal in this build (probed on a cylinder and a cavity ceiling), so
// the material sign is passed through unchanged.
//
// A face smaller than the profile does not cut the tool through: the split
// leaves one piece that still reaches the over-length end. That is detected by
// identity with the tool's end cap, not by a volume guess, and retried on the
// face's untrimmed surface extended over the tool (analytic cylinder/cone only,
// which is the case an extruded cylinder face hits). Anything else refuses by
// name; a tool built 10 m long is never returned.

import type { DisposeScope } from '../occ/disposeScope'
import type {
  OccModule,
  OccShape,
  OccShapeEnumValue,
  OccSubShape,
  OccSurfaceAdaptor,
  OccXYZ,
} from '../occ/occTypes'
import type { Vec3 } from '../occ/primitives'
import {
  faceCentroid,
  faceNormal,
  shapeBndBox,
} from '../occ/primitives'
import {
  booleanWithDiffMany,
  booleanWithHistory,
  exploreSolids,
  shapesTouch,
  splitWithHistory,
  type FaceOrigin,
} from '../occ/booleans'
import { volumeOfDefault } from '../occ/volume'
import { sameEnum } from '../occ/enumValue'
import { OCC_CONFUSION, TOL_SURFACE_IDENTITY } from '../solverConstants'
import { UP_TO_REACH } from './upTo'
import { swallowUnlessTrap } from '../errors'

const TWO_PI = 2 * Math.PI

/** The over-length tool's two caps, found by the direction their outward normal
 *  faces: the start cap points back at the profile, the end cap points along
 *  the sweep. A prism's lateral walls are parallel to the sweep (or curved), so
 *  they never match. A multi-region tool has more than one of each. */
export interface ToolCaps {
  start: OccSubShape[]
  end: OccSubShape[]
}

export function toolCaps(oc: OccModule, scope: DisposeScope, tool: OccShape, dir: Vec3): ToolCaps {
  const start: OccSubShape[] = []
  const end: OccSubShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(tool, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current())) as OccSubShape
    let n: Vec3
    try {
      n = faceNormal(oc, scope, face)
    } catch (e) {
      swallowUnlessTrap(e)
      continue
    }
    const along = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2]
    if (along < -0.9) start.push(face)
    else if (along > 0.9) end.push(face)
  }
  if (start.length === 0) {
    throw new Error('extrude up_to: could not find the profile start cap on the tool')
  }
  return { start, end }
}

/** Point the sweep at a curved face. The profile centroid is cast along the
 *  nominal direction: a hit ahead keeps it, a hit only behind flips it, and no
 *  hit at all falls back to the face centroid's side (the rule the plane target
 *  has always used). The first crossing wins, so a tool that enters and leaves
 *  a cylinder stops at the near wall. */
export function orientToFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  profileOrigin: number[],
  directionVec: Vec3,
): Vec3 {
  const length = Math.hypot(directionVec[0], directionVec[1], directionVec[2])
  if (!(length > 1e-12)) throw new Error('extrude up_to: degenerate direction vector')
  const dir: Vec3 = [directionVec[0] / length, directionVec[1] / length, directionVec[2] / length]
  const line = scope.track(
    new oc.gp_Lin_3(
      scope.track(new oc.gp_Pnt_3(profileOrigin[0], profileOrigin[1], profileOrigin[2])),
      scope.track(new oc.gp_Dir_4(dir[0], dir[1], dir[2])),
    ),
  )
  const intersector = scope.track(new oc.IntCurvesFace_ShapeIntersector())
  intersector.Load(face, OCC_CONFUSION)
  intersector.Perform_1(line, -1e9, 1e9)
  let ahead: number | null = null
  let behind: number | null = null
  if (intersector.IsDone()) {
    for (let i = 1; i <= intersector.NbPnt(); i++) {
      const w = intersector.WParameter(i)
      if (w > OCC_CONFUSION && (ahead === null || w < ahead)) ahead = w
      if (w < -OCC_CONFUSION && (behind === null || w > behind)) behind = w
    }
  }
  let signed: number
  let sign: 1 | -1
  if (ahead !== null) {
    signed = ahead
    sign = 1
  } else if (behind !== null) {
    signed = -behind
    sign = -1
  } else {
    // No crossing: the centroid's side is the same fallback orientToTarget
    // makes for a plane, and it keeps a barely-covering face usable.
    const c = faceCentroid(oc, scope, face)
    signed =
      (c[0] - profileOrigin[0]) * dir[0] +
      (c[1] - profileOrigin[1]) * dir[1] +
      (c[2] - profileOrigin[2]) * dir[2]
    sign = signed >= 0 ? 1 : -1
  }
  if (Math.abs(signed) <= 1e-9) {
    throw new Error('extrude up_to: target passes through the profile; no distance to extrude')
  }
  if (Math.abs(signed) > UP_TO_REACH) {
    throw new Error(
      `extrude up_to: target is beyond reach (${Math.abs(signed).toFixed(1)} > ${UP_TO_REACH})`,
    )
  }
  return sign > 0 ? dir : (dir.map((c) => -c) as Vec3)
}

/** The TopAbs kind of a shape's top level, or null when it cannot be read. */
function shapeKindValue(shape: OccShape): OccShapeEnumValue | null {
  const st = (shape as OccShape & { ShapeType?(): OccShapeEnumValue }).ShapeType?.()
  return st ?? null
}

function isKind(shape: OccShape, kind: OccShapeEnumValue): boolean {
  const st = shapeKindValue(shape)
  return st !== null && sameEnum(st, kind)
}

/** Faces of a shape, tracked, in explorer order. */
function facesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Face_1(exp.Current())) as OccSubShape)
  return out
}

/**
 * Offset a face along its own material-outward normal. Returns an UNTRACKED
 * face (a compound when the offset produced several), per the occ producer
 * contract; the caller tracks it. The offset maker returns a shell for a lone
 * face in this build, so the single face is unwrapped and the shell released.
 */
export function offsetFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  delta: number,
): OccShape {
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error('extrude up_to: up_to_offset must be a non-zero finite distance')
  }
  const op = scope.track(new oc.BRepOffsetAPI_MakeOffsetShape_1())
  op.PerformByJoin(
    face,
    delta,
    TOL_SURFACE_IDENTITY,
    oc.BRepOffset_Mode.BRepOffset_Skin,
    false,
    false,
    oc.GeomAbs_JoinType.GeomAbs_Intersection,
    false,
  )
  if (!op.IsDone()) {
    throw new Error('extrude up_to: could not offset the target face by the up_to_offset')
  }
  const raw = scope.track(op.Shape())
  if (isKind(raw, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
    scope.detach(raw)
    return raw
  }
  if (!isKind(raw, oc.TopAbs_ShapeEnum.TopAbs_SHELL)) {
    throw new Error('extrude up_to: the offset target is not a face or a single shell')
  }
  const faces = facesOf(oc, scope, raw)
  if (faces.length === 0) {
    throw new Error('extrude up_to: the offset target has no faces')
  }
  if (faces.length === 1) {
    const only = scope.detach(faces[0])
    scope.release(raw)
    return only
  }
  const compound = compoundOf(oc, scope, faces)
  scope.release(raw)
  return compound
}

/** A compound of the given shapes, tracked then detached for the caller. */
function compoundOf(oc: OccModule, scope: DisposeScope, shapes: readonly OccShape[]): OccShape {
  const compound = scope.track(new oc.TopoDS_Compound())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeCompound(compound as never)
  for (const shape of shapes) builder.Add(compound as never, shape)
  return scope.detach(compound)
}

/** The kept solids as one shape: the solid itself, or a compound of them. */
function keepPieces(oc: OccModule, scope: DisposeScope, result: OccShape, keep: readonly OccShape[]): OccShape {
  if (keep.length === 1) {
    scope.detach(keep[0])
    scope.release(result)
    return keep[0]
  }
  const compound = compoundOf(oc, scope, keep)
  scope.release(result)
  return compound
}

/** Solids of a split/cut result that own at least one of the tool's start caps. */
function startPieces(
  oc: OccModule,
  scope: DisposeScope,
  result: OccShape,
  startCaps: readonly OccShape[],
): OccShape[] {
  return exploreSolids(oc, scope, result).filter((solid) =>
    facesOf(oc, scope, solid).some((f) => startCaps.some((cap) => (cap as OccSubShape).IsSame(f))),
  )
}

/** True when a kept piece still reaches the over-length end: the target face
 *  did not cut it through, i.e. it does not cover the profile. */
function reachesEnd(oc: OccModule, scope: DisposeScope, piece: OccShape, endCaps: readonly OccShape[]): boolean {
  return facesOf(oc, scope, piece).some((f) => endCaps.some((cap) => (cap as OccSubShape).IsSame(f)))
}

/**
 * The face's untrimmed analytic surface, extended over the whole tool. Only a
 * cylinder and a cone are rebuilt (BRepBuilderAPI_MakeFace parameter windows
 * exist for both); a freeform face that does not cover the profile has no
 * honest extension and the caller refuses by name.
 */
export function extendFaceOver(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  tool: OccShape,
): OccShape | null {
  const adaptor: OccSurfaceAdaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const type = adaptor.GetType().value
  const S = oc.GeomAbs_SurfaceType
  const box = shapeBndBox(oc, scope, tool)
  const corners: Vec3[] = [
    [box.min[0], box.min[1], box.min[2]], [box.max[0], box.min[1], box.min[2]],
    [box.min[0], box.max[1], box.min[2]], [box.max[0], box.max[1], box.min[2]],
    [box.min[0], box.min[1], box.max[2]], [box.max[0], box.min[1], box.max[2]],
    [box.min[0], box.max[1], box.max[2]], [box.max[0], box.max[1], box.max[2]],
  ]
  const margin = 1
  if (type === S.GeomAbs_Cylinder.value) {
    const cylinder = scope.track(adaptor.Cylinder())
    const pos = scope.track(cylinder.Position())
    const loc = scope.track(pos.Location())
    const axis = scope.track(pos.Direction())
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
    const dir: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    let vmin = Infinity
    let vmax = -Infinity
    for (const c of corners) {
      const v = (c[0] - origin[0]) * dir[0] + (c[1] - origin[1]) * dir[1] + (c[2] - origin[2]) * dir[2]
      vmin = Math.min(vmin, v)
      vmax = Math.max(vmax, v)
    }
    const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_10(cylinder, 0, TWO_PI, vmin - margin, vmax + margin))
    return builder.IsDone() ? builder.Face() : null
  }
  if (type === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    const pos = scope.track(cone.Position())
    const loc = scope.track(pos.Location())
    const axis = scope.track(pos.Direction())
    const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()]
    const dir: Vec3 = [axis.X(), axis.Y(), axis.Z()]
    const cos = Math.max(0.05, Math.cos(Math.abs(cone.SemiAngle())))
    let vmin = Infinity
    let vmax = -Infinity
    for (const c of corners) {
      const axial = (c[0] - origin[0]) * dir[0] + (c[1] - origin[1]) * dir[1] + (c[2] - origin[2]) * dir[2]
      const v = axial / cos
      vmin = Math.min(vmin, v)
      vmax = Math.max(vmax, v)
    }
    const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_11(cone, 0, TWO_PI, vmin - margin, vmax + margin))
    return builder.IsDone() ? builder.Face() : null
  }
  return null
}

export interface TrimResult {
  shape: OccShape
  faceOrigin: FaceOrigin[]
  // The face did not cover the profile and was replaced by its extended surface.
  extended: boolean
}

/**
 * Split the over-length tool at one or more target faces and keep the pieces
 * that own the profile's start cap. The first crossing wins, so a tool that
 * enters and leaves a body stops at the near wall. When a kept piece still
 * reaches the over-length end, the target did not cut the profile through: the
 * face is extended once and the split retried; if that fails too the caller gets
 * the named coverage refusal.
 */
export function trimAtFace(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  targets: OccShape | readonly OccShape[],
  dir: Vec3,
): TrimResult {
  const tools = Array.isArray(targets) ? [...targets] : [targets as OccShape]
  const caps = toolCaps(oc, scope, tool, dir)
  const attempt = (splitTools: readonly OccShape[]): { shape: OccShape; faceOrigin: FaceOrigin[] } | null => {
    let split: { shape: OccShape; faceOrigin: FaceOrigin[] }
    try {
      split = splitWithHistory(oc, scope, tool, splitTools)
      scope.track(split.shape)
    } catch (e) {
      swallowUnlessTrap(e)
      return null
    }
    const keep = startPieces(oc, scope, split.shape, caps.start)
    if (keep.length === 0 || keep.some((s) => reachesEnd(oc, scope, s, caps.end))) {
      scope.release(split.shape)
      return null
    }
    return { shape: keepPieces(oc, scope, split.shape, keep), faceOrigin: split.faceOrigin }
  }

  let result = attempt(tools)
  let extended = false
  if (result === null) {
    const extendedFaces: OccShape[] = []
    try {
      for (const target of tools) {
        const face = extendFaceOver(oc, scope, target, tool)
        if (face === null) throw new Error('not extendable')
        scope.track(face)
        extendedFaces.push(face)
      }
    } catch (e) {
      swallowUnlessTrap(e)
      for (const face of extendedFaces) scope.release(face)
      throw new Error(
        'extrude up_to: target face does not cover the profile (the extrude passes beside it); ' +
          'pick a larger face or use up_to_next',
      )
    }
    result = attempt(extendedFaces)
    for (const face of extendedFaces) scope.release(face)
    if (result === null) {
      throw new Error(
        'extrude up_to: target face does not cover the profile (the extrude passes beside it); ' +
          'pick a larger face or use up_to_next',
      )
    }
    extended = true
  }
  return { shape: result.shape, faceOrigin: result.faceOrigin, extended }
}

/** A candidate body for up_to_next, with the id the refusal names. */
export interface NextCandidate {
  id: string
  shape: OccShape
  imported: boolean
}

/** Faces of the reached bodies that the tool meets head-on: the stop surface.
 *  A face whose outward normal points back at the sweep is where the tool
 *  exits into material; the start-side floor (normal along the sweep) and the
 *  side walls (normal across it) are not stops. */
function stopFaces(
  oc: OccModule,
  scope: DisposeScope,
  pieces: readonly OccShape[],
  candidates: readonly NextCandidate[],
  dir: Vec3,
): OccShape[] {
  const out: OccShape[] = []
  const seen = new Set<OccShape>()
  for (const candidate of candidates) {
    for (const face of facesOf(oc, scope, candidate.shape)) {
      if (seen.has(face)) continue
      let n: Vec3
      try {
        n = faceNormal(oc, scope, face)
      } catch (e) {
        swallowUnlessTrap(e)
        continue
      }
      if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] >= -1e-3) continue
      if (!pieces.some((piece) => shapesTouch(oc, piece, face))) continue
      seen.add(face)
      out.push(face)
    }
  }
  return out
}

/** The near material boundary a tool's first body raises, before any offset. */
export interface NextStop {
  pieces: OccShape[]
  faceOrigin: FaceOrigin[]
  faces: OccShape[]
}

/**
 * Split the over-length tool at the candidate bodies and keep the pieces that
 * own the profile start cap. `profileOrigin` is only consulted when nothing is
 * kept, to name a start inside material apart from a region that meets nothing.
 */
function nearStop(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  candidates: readonly NextCandidate[],
  caps: ToolCaps,
  profileOrigin: Vec3,
  dir: Vec3,
): NextStop {
  const unifyFaces = !candidates.some((c) => c.imported)
  const cut = booleanWithDiffMany(
    oc,
    scope,
    tool,
    candidates.map((c) => c.shape),
    'cut',
    { unifyFaces },
  )
  const result = scope.track(cut.shape)
  const keep = startPieces(oc, scope, result, caps.start)
  if (keep.length === 0) {
    const inside = candidates.find((c) => {
      try {
        const classifier = scope.track(
          new oc.BRepClass3d_SolidClassifier_3(
            c.shape,
            scope.track(new oc.gp_Pnt_3(...profileOrigin)) as OccXYZ,
            OCC_CONFUSION,
          ),
        )
        return sameEnum(classifier.State(), oc.TopAbs_State.TopAbs_IN)
      } catch (e) {
        swallowUnlessTrap(e)
        return false
      }
    })
    scope.release(result)
    if (inside !== undefined) {
      throw new Error(
        `extrude up_to_next: the profile starts inside ${inside.id}; ` +
          'pick the face with up_to instead',
      )
    }
    throw new Error(
      'extrude up_to_next: the profile meets no body; no region would stop before the reach limit',
    )
  }
  if (keep.some((s) => reachesEnd(oc, scope, s, caps.end))) {
    scope.release(result)
    throw new Error(
      'extrude up_to_next: a profile region meets no body; it would run past the reach limit',
    )
  }
  const pieces = keep.map((s) => scope.detach(s))
  scope.release(result)
  return { pieces, faceOrigin: cut.faceOrigin, faces: stopFaces(oc, scope, pieces, candidates, dir) }
}

/** Compound the pieces into the tool shape the body operation consumes. */
function combinePieces(oc: OccModule, scope: DisposeScope, pieces: readonly OccShape[]): OccShape {
  if (pieces.length === 1) return pieces[0]
  for (const piece of pieces) scope.track(piece)
  const compound = compoundOf(oc, scope, pieces)
  for (const piece of pieces) scope.release(piece)
  return compound
}

export interface NextTrimResult {
  shape: OccShape
  faceOrigin: FaceOrigin[]
}

/**
 * up_to_next with an optional material-signed offset. Zero offset returns the
 * near pieces themselves. A non-zero offset moves the reached stop faces (only
 * the faces the tool meets head-on, so the profile's own start boundary is not
 * moved) and re-splits the over-length tool at them: positive stops short of
 * the material, negative runs into it. The stop faces are offset as faces, not
 * by offsetting the whole body: a body offset would also grow the face the
 * profile starts on and eat the first `offset` of the tool, which is neither
 * the authored stop nor what the documented volumes say.
 */
export function trimAtNext(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  candidates: readonly NextCandidate[],
  dir: Vec3,
  profileOrigin: Vec3,
  offset: number,
): NextTrimResult {
  if (candidates.length === 0) {
    throw new Error('extrude up_to_next: no bodies to stop at; build the target body first')
  }
  const caps = toolCaps(oc, scope, tool, dir)
  const stop = nearStop(oc, scope, tool, candidates, caps, profileOrigin, dir)
  if (offset === 0) {
    const shape = combinePieces(oc, scope, stop.pieces)
    return { shape, faceOrigin: stop.faceOrigin }
  }
  if (stop.faces.length === 0) {
    throw new Error(
      'extrude up_to_next: could not find the reached stop face to offset; ' +
        'remove up_to_offset or use up_to on the face',
    )
  }
  const offsetFaces = stop.faces.map((face) => scope.track(offsetFace(oc, scope, face, offset)))
  try {
    const result = trimAtFace(oc, scope, tool, offsetFaces, dir)
    return { shape: result.shape, faceOrigin: result.faceOrigin }
  } finally {
    for (const face of offsetFaces) scope.release(face)
    for (const piece of stop.pieces) scope.release(piece)
  }
}

/**
 * The emboss/deboss slab at an up_to_next stop: the near band between the
 * reached stop faces and their offset. The body offset is not used for the
 * stop itself (it would move the face the profile starts on too); the reached
 * faces are the stop.
 */
export function embossAtNext(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  candidates: readonly NextCandidate[],
  dir: Vec3,
  profileOrigin: Vec3,
  offset: number,
): { shape: OccShape; faceOrigin: FaceOrigin[]; note?: string } {
  if (candidates.length === 0) {
    throw new Error('extrude up_to_next: no bodies to stop at; build the target body first')
  }
  const caps = toolCaps(oc, scope, tool, dir)
  const stop = nearStop(oc, scope, tool, candidates, caps, profileOrigin, dir)
  try {
    if (stop.faces.length === 0) {
      throw new Error(
        'extrude up_to_next: could not find the reached stop face to offset; ' +
          'remove up_to_offset or use up_to on the face',
      )
    }
    return surfaceSlab(oc, scope, tool, stop.faces, dir, offset)
  } finally {
    for (const piece of stop.pieces) scope.release(piece)
  }
}

/**
 * The emboss/deboss slab: the near band between a stop surface and its offset.
 * Both bounds are trimmed from the same over-length tool, so the band nearest
 * the profile is the difference of the two start-side pieces; the far side of a
 * cylinder is never in it. `targets` is the stop face set (one face for an
 * up_to target, the reached stop faces for up_to_next); the offset faces are
 * built from them here.
 */
export function surfaceSlab(
  oc: OccModule,
  scope: DisposeScope,
  tool: OccShape,
  targets: readonly OccShape[],
  dir: Vec3,
  offset: number,
): { shape: OccShape; faceOrigin: FaceOrigin[]; note?: string } {
  if (!Number.isFinite(offset) || offset === 0) {
    throw new Error('extrude up_to: up_to_start surface needs a non-zero up_to_offset (the slab height)')
  }
  const offsetTargets = targets.map((face) => scope.track(offsetFace(oc, scope, face, offset)))
  let base!: TrimResult
  let shifted!: TrimResult
  try {
    base = trimAtFace(oc, scope, tool, targets, dir)
    shifted = trimAtFace(oc, scope, tool, offsetTargets, dir)
  } finally {
    for (const face of offsetTargets) scope.release(face)
  }
  scope.track(base.shape)
  scope.track(shifted.shape)
  const baseVolume = Math.abs(volumeOfDefault(oc, scope, base.shape))
  const shiftedVolume = Math.abs(volumeOfDefault(oc, scope, shifted.shape))
  const budget = 1e-9 * Math.max(baseVolume, shiftedVolume, 1)
  if (Math.abs(shiftedVolume - baseVolume) <= budget) {
    scope.release(base.shape)
    scope.release(shifted.shape)
    throw new Error('extrude up_to: up_to_offset produced an empty emboss slab')
  }
  // The offset is not a translation along the extrude, so either piece can be
  // the outer one; the slab is the difference, whichever side the material
  // sign put the offset surface on.
  const outer = shiftedVolume > baseVolume ? shifted.shape : base.shape
  const inner = shiftedVolume > baseVolume ? base.shape : shifted.shape
  const slab = booleanWithHistory(oc, scope, outer, inner, 'cut')
  scope.release(base.shape)
  scope.release(shifted.shape)
  const extended = base.extended || shifted.extended
  return {
    shape: slab.shape,
    faceOrigin: slab.faceOrigin,
    ...(extended ? { note: 'up_to: the face did not cover the profile; trimmed at its extended surface' } : {}),
  }
}

// Re-exported so the extrude leaf imports every curved-trim entry point from
// one module.
export { UP_TO_REACH }
