/**
 * Grow or shrink a solid by a signed distance with sharp (Intersection) joins,
 * for the boolean subtract's clearance. `d > 0` is clearance (the tool grows,
 * the hole comes out bigger), `d < 0` is interference (the tool shrinks).
 *
 * This is a 3D offset, not a sketch offset: it also moves a blind pocket's
 * floor and grows a through-cut tool axially, and it works on filleted, drafted
 * or imported tools a sketch offset cannot touch (decision 3, isotropic).
 *
 * opencascade.js 1.1.1 / OCCT 7.4.0p1 facts this module is built on (probed
 * against the shipped build, see the plan's table):
 *   - History is `Generated(face)`, NOT `Modified(face)`: every source face
 *     yields exactly one grown face, which `IsSame`s a face of the result. Sharp
 *     joins keep that mapping one to one, which is the naming contract.
 *   - Skin mode returns a SHELL for non-primitive input (a filleted box, a
 *     slotted box). A shell is not a usable boolean tool, so it is wrapped into
 *     a TopoDS_Solid via BRep_Builder; its faces are unchanged (`IsSame`), so
 *     the history images still match.
 *   - A negative clearance can drive the offset to a COMPOUND or a self-
 *     intersecting shape; both are refused here and, if one slips the check,
 *     again by the cut's own BRepCheck (the fillet at -0.6 case).
 *
 * The result shape is NOT tracked (the caller owns it, exactly like the other
 * occ producers); every transient the offset allocates is tracked in `scope`.
 */

import { drainList, type DisposeScope } from './disposeScope'
import { shapeIsValid, volumeOf } from './booleans'
import { SubShapeMap } from './subshapeIdentity'
import { sameEnum } from './enumValue'
import type { OccModule, OccOrientableShape, OccShape, OccShapeEnumValue, OccSubShape } from './occTypes'

/** The 3D offset could not be applied, or produced a shape that cannot be a
 *  boolean tool. The message is the reason; the caller adds the tool context. */
export class OffsetError extends Error {}

const SHAPE_TOL = 1e-6
const VOLUME_EPS = 1e-9

type ShapeKind = 'solid' | 'shell' | 'other'

/** The TopAbs kind of a shape's top level, read via ShapeType(). */
function shapeKind(oc: OccModule, shape: OccShape): ShapeKind {
  const st = (shape as OccShape & { ShapeType?(): unknown }).ShapeType?.()
  if (st === undefined) return 'other'
  if (sameEnum(st, oc.TopAbs_ShapeEnum.TopAbs_SOLID)) return 'solid'
  if (sameEnum(st, oc.TopAbs_ShapeEnum.TopAbs_SHELL)) return 'shell'
  return 'other'
}

/** The sub-shapes of `shape` of `kind`, as handles, in explorer order. */
function explore(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: OccShapeEnumValue,
): OccSubShape[] {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(exp.Current()) as OccSubShape)
  return out
}

/** Promote a lone SHELL into a TopoDS_Solid (BRep_Builder.MakeSolid + Add). The
 *  faces (and therefore the offset history images) are carried over unchanged. */
function wrapShellAsSolid(oc: OccModule, scope: DisposeScope, shell: OccShape): OccShape {
  const solid = scope.track(new oc.TopoDS_Solid())
  const builder = scope.track(new oc.BRep_Builder())
  builder.MakeSolid(solid)
  builder.Add(solid, shell)
  return solid
}

/**
 * Offset `shape` by the signed distance `d` with sharp joins, returning the
 * normalised solid plus the one-to-one image of every source face. `d` must be
 * non-zero (the feature never calls it with zero). Throws [[OffsetError]] when
 * the offset fails, does not obey the sign law, or splits/merges a face.
 */
export function offsetSolid(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  d: number,
): { shape: OccShape; faceImage: (src: OccSubShape) => OccSubShape } {
  if (!Number.isFinite(d) || d === 0) {
    throw new OffsetError(`clearance must be a non-zero finite number, got ${d}`)
  }

  const op = scope.track(new oc.BRepOffsetAPI_MakeOffsetShape_1())
  op.PerformByJoin(
    shape,
    d,
    SHAPE_TOL,
    oc.BRepOffset_Mode.BRepOffset_Skin,
    false,
    false,
    oc.GeomAbs_JoinType.GeomAbs_Intersection,
    false,
  )
  if (!op.IsDone()) throw new OffsetError('the offset operation did not complete')
  const raw = scope.track(op.Shape())

  // Normalise: a SOLID is used as is; a lone SHELL (non-primitive input) is
  // wrapped into a solid; a COMPOUND or anything else is refused (the negative
  // slot case is a compound with invalid topology).
  const kind = shapeKind(oc, raw)
  let result: OccShape
  if (kind === 'solid') {
    result = raw
  } else if (kind === 'shell') {
    result = wrapShellAsSolid(oc, scope, raw)
  } else {
    throw new OffsetError('the offset did not produce a solid or a single shell')
  }

  // A wrapped shell, or an offset that folds, can come back inside out: the
  // signed volume is negative while every face is correct. Reverse the solid so
  // downstream volume reads and the sign law below see a positively oriented
  // tool, exactly as an authored solid is (plan step 3).
  let after = volumeOf(oc, scope, result)
  if (after < 0) {
    result = scope.track((result as OccOrientableShape).Reversed())
    after = volumeOf(oc, scope, result)
  }

  if (!shapeIsValid(oc, scope, result)) {
    throw new OffsetError('the offset result is not a valid solid (BRepCheck_Analyzer)')
  }

  // Sign law: d > 0 must strictly grow the tool, d < 0 must strictly shrink it
  // and leave positive material. This catches a silently degenerate offset that
  // still validated.
  const before = volumeOf(oc, scope, shape)
  if (d > 0 && after <= before + VOLUME_EPS) {
    throw new OffsetError(`the offset did not grow the tool (${before} -> ${after})`)
  }
  if (d < 0 && (after >= before - VOLUME_EPS || after <= 0)) {
    throw new OffsetError(`the offset did not shrink the tool to a positive volume (${before} -> ${after})`)
  }

  // One-to-one naming: each source face's Generated image must be exactly one
  // face that IsSame a face of the normalised result. Sharp joins guarantee it;
  // Arc joins (deferred) would not, so this is the contract that keeps them out.
  const resultFaces = explore(oc, scope, result, oc.TopAbs_ShapeEnum.TopAbs_FACE)
  const images = new SubShapeMap<OccSubShape>()
  for (const src of explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
    const generated = drainList(scope, op.Generated(src)) as OccSubShape[]
    if (generated.length !== 1) {
      throw new OffsetError(
        `the offset split or merged faces (${generated.length} images); sharp-join naming needs one to one`,
      )
    }
    const image = generated[0]
    const match = resultFaces.find((f) => f.IsSame(image))
    if (match === undefined) {
      throw new OffsetError('an offset face does not belong to the result shape')
    }
    images.set(src, match)
  }

  return {
    shape: scope.detach(result),
    faceImage: (src: OccSubShape): OccSubShape => {
      const image = images.get(src)
      if (image === undefined) {
        throw new OffsetError('asked for the image of a face that is not part of the offset source')
      }
      return image
    },
  }
}
