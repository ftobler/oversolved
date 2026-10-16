/**
 * Fold the inside-out solids a boolean hands back into the solid they hollow.
 *
 * A fuse that seals a void (the robustness fuzz seed 134: a mirror merge closes
 * a sphere pocket against its mirror image) comes out of OCCT 7.4.0p1 as the
 * outer solid plus the void's shell as a SEPARATE solid with a negative signed
 * volume, instead of one solid holding an outer and an inner shell. The total
 * volume is right, so the boolean soundness check passes, but the body split
 * then registers the void as a part of its own with negative volume.
 *
 * The fold rebuilds each enclosing solid from its own shells plus the void
 * shells it contains. The shells are reused as they are, so every face and
 * edge stays IsSame and the names and history keyed by them carry over.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { volumeOf } from './volume'
import { sameEnum } from './enumValue'

// A void smaller than this is numerical noise on a positive solid, not a hole.
const CAVITY_VOLUME_EPS = 1e-9
const CLASSIFY_TOL = 1e-7

function explore(oc: OccModule, scope: DisposeScope, shape: OccShape, kind: unknown): OccShape[] {
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(exp.Current()))
  return out
}

/** The solid a void sits inside: the lone positive solid, or the one that
 *  classifies a void vertex as IN when there are several. */
function ownerOf(oc: OccModule, scope: DisposeScope, cavity: OccShape, solids: OccShape[]): number {
  if (solids.length === 1) return 0
  const E = oc.TopAbs_ShapeEnum
  const vertices = explore(oc, scope, cavity, E.TopAbs_VERTEX)
  if (vertices.length === 0) return -1
  const pnt = scope.track(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex_1(vertices[0])))
  return solids.findIndex((solid) => {
    const classifier = scope.track(new oc.BRepClass3d_SolidClassifier_3(solid, pnt, CLASSIFY_TOL))
    return sameEnum(classifier.State(), oc.TopAbs_State.TopAbs_IN)
  })
}

/**
 * `shape` with every negative-volume solid folded into its enclosing solid as an
 * inner shell, or `shape` itself when it has none (or a void has no owner, which
 * is left for the caller's own checks to report rather than guessed at). A
 * folded result is a new, UNTRACKED shape: one solid alone, else a compound.
 */
export function foldCavitySolids(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const solids = explore(oc, scope, shape, E.TopAbs_SOLID)
  if (solids.length < 2) return shape
  const volumes = solids.map((s) => volumeOf(oc, scope, s))
  const positives = solids.filter((_, i) => volumes[i] > CAVITY_VOLUME_EPS)
  const cavities = solids.filter((_, i) => volumes[i] < -CAVITY_VOLUME_EPS)
  if (cavities.length === 0 || positives.length === 0) return shape

  const owned: OccShape[][] = positives.map(() => [])
  for (const cavity of cavities) {
    const owner = ownerOf(oc, scope, cavity, positives)
    if (owner < 0) return shape
    owned[owner].push(cavity)
  }

  const builder = scope.track(new oc.BRep_Builder())
  const rebuilt = positives.map((solid, i) => {
    if (owned[i].length === 0) return solid
    const folded = new oc.TopoDS_Solid()
    builder.MakeSolid(folded)
    for (const shell of explore(oc, scope, solid, E.TopAbs_SHELL)) builder.Add(folded, shell)
    // The void's shell already faces into the void (that is why its own solid
    // reads negative), which is the orientation an inner shell needs.
    for (const cavity of owned[i]) {
      for (const shell of explore(oc, scope, cavity, E.TopAbs_SHELL)) builder.Add(folded, shell)
    }
    return folded
  })
  if (rebuilt.length === 1) return rebuilt[0]
  const compound = new oc.TopoDS_Compound()
  builder.MakeCompound(compound)
  for (const solid of rebuilt) builder.Add(compound, solid)
  // Solids carried over unfolded are explorer views tracked above; the
  // compound holds its own references to them.
  for (const solid of rebuilt) if (!scope.isTracked(solid)) scope.track(solid)
  return compound
}
