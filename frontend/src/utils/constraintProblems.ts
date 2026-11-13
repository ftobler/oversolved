// The constraint shapes a sketch cannot author, in one place so the applier and
// the drive value rule refuse the same pick with the same sentence. `warn` is a
// console warning in DEV and silent otherwise, so a refusal only exists to a
// headless caller if the rule that refuses can also name it. The applier calls
// this before it writes anything; the drive rule calls it with or without the
// live document, judging the shapes only when it can read the entity kinds.
import type { SketchFeature } from '@/types/cad'
import { isConstraintKindName } from '@/wasm-kernel/codec'
import { resolveVertexRef } from '@/types/vertexRef'
import { pointDistanceZeroProblem } from './yamlMutations/helpers'
import {
  COLINEAR_SHAPE_REASON,
  colinearShapeProblem,
  constraintOperandSide,
  type ConstraintOperandSide,
} from './constraintOperands'

/** What one target spelling names, for the kinds whose accepted shape depends on
 *  its operands. A whole circle, arc, ellipse or spline is `curve`: the solver
 *  would read its centre in a point slot, which is not a point the author picked
 *  (a colinear of a curve and a line has no row, and the midpoint of a curve is
 *  not an expressible pick). `unresolved` is a ref this sketch does not hold, or
 *  an inferred (`dock:`/`isect:`) handle that only materializes in the applier;
 *  the shape rules pass it so the applier, which can materialize, decides. */
export type ConstraintTargetSide = ConstraintOperandSide  // 'line' | 'point' | 'curve' | 'unresolved'

/**
 * Classify one constraint target by what it names rather than by its prefix.
 * `$<entityId>` is the document's stored form, the explicit `entity:`/
 * `vertex:` forms name the sketch too, and `@builtin_origin` is the builtin
 * point the catalog promises. A vertex key is always a point; a whole entity is
 * classified by its kind. This is the resolver `canonicalLineDistanceTargets`
 * already uses in the applier.
 */
export function constraintTargetSide(
  target: string,
  featureId: string,
  entityIds: ReadonlySet<string>,
  kindById: ReadonlyMap<string, string>,
): ConstraintTargetSide {
  if (target === '@builtin_origin') return 'point'
  if (target.startsWith('$')) return constraintOperandSide(target, entityIds, kindById)
  const parts = target.split(':')
  if (parts[0] === 'entity' && parts[1] === featureId) {
    return constraintOperandSide({ entity: parts[2] }, entityIds, kindById)
  }
  if (parts[0] === 'vertex' && parts[1] === featureId) return 'point'
  return 'unresolved'
}

/**
 * True when `target` names another sketch's geometry by its feature-qualified
 * spelling (`entity:<otherSketch>:<eid>` / `vertex:<otherSketch>:<eid>:<key>`).
 * A stored `$eid` is local by definition, and the builtin origin is not a
 * sketch. A caller with no known sketch id (a shape-only value check) gets
 * false: without the active id nothing can be foreign.
 *
 * The solver reads only sketch-local refs, so a foreign operand is dead from
 * the moment it is authored; the projection gesture is the supported shape.
 */
export function foreignConstraintTarget(target: string, featureId: string): boolean {
  if (featureId === '' || target === '@builtin_origin') return false
  const parts = target.split(':')
  if (parts[0] !== 'entity' && parts[0] !== 'vertex') return false
  return parts[1] !== undefined && parts[1] !== '' && parts[1] !== featureId
}

/** The one warning sentence for a constraint ignored by either the live-doc
 *  lowering or the solver's survivors filter. Shared with the editor tile, which
 *  shows the same sentence for a dropped constraint, so the tooltip and the tree
 *  can never disagree about what was ignored. */
export function ignoredConstraintWarning(id: string, kind: string, reason: string): string {
  return `constraint ${id} (${kind}) names operands it cannot use (${reason}) and was ignored.`
}

/** The keys a midpoint stores, in the document's usual `$`/`@` wire form. The
 *  two forms are distinct: one line with its midpoint, or the point midway
 *  between two points. */
export type MidpointOperands =
  | { line: string; point: string }
  | { point_a: string; point_b: string; point: string }

/** The operands a midpoint target list names: one line and one point in either
 *  order, or three points. Null for any other list, including one carrying an
 *  unresolved operand the applier has not materialized yet. */
export function midpointOperands(
  targets: readonly string[],
  sideOf: (target: string) => ConstraintTargetSide,
): MidpointOperands | null {
  if (targets.length === 2) {
    const a = sideOf(targets[0])
    const b = sideOf(targets[1])
    if (a === 'line' && b === 'point') return { line: targets[0], point: targets[1] }
    if (a === 'point' && b === 'line') return { line: targets[1], point: targets[0] }
    return null
  }
  if (targets.length === 3 && targets.every(target => sideOf(target) === 'point')) {
    return { point_a: targets[0], point_b: targets[1], point: targets[2] }
  }
  return null
}

/** The sketch fields a shape rule reads. `constraints` is optional so a
 *  shape-only caller (the drive rule without a live document) can omit it. */
type SketchShape = Pick<SketchFeature, 'id' | 'entities'> & Pick<Partial<SketchFeature>, 'constraints'>

/**
 * Why a `group` pick has no solver rows, or null. A group holds whole authored
 * entities of one sketch: a vertex, the projected origin, or an entity already
 * held by a `projection` has no rigid-group reading (its params are pinned
 * elsewhere or the pick is not an entity). The count rule and the value refusal
 * apply without a document; the per-entity checks need one.
 */
function groupProblem(
  feature: SketchShape | undefined,
  featureId: string,
  targets: readonly string[],
  value: number | undefined,
): string | null {
  if (targets.length < 1) return 'group needs at least one target'
  if (value !== undefined) {
    return 'group takes no value; delete the Group constraint to edit the entities freely'
  }
  if (!feature) return null
  const entityIds = new Set((feature.entities ?? []).map(e => e.id))
  const projected = new Set(
    (feature.constraints ?? [])
      .filter(c => c.kind === 'projection' && typeof c.target === 'string')
      .map(c => String(c.target).replace(/^\$/, '')),
  )
  for (const target of targets) {
    if (target === '@builtin_origin') {
      return 'group holds whole sketch entities; the origin is not one'
    }
    if (target.startsWith('vertex:')) {
      return 'group holds whole sketch entities, not a vertex'
    }
    // A dock/isect handle materializes into a point before the applier judges
    // it; the applier re-runs this rule on the resolved targets.
    if (target.startsWith('dock:') || target.startsWith('isect:')) continue
    let id: string | null = null
    if (target.startsWith('entity:')) {
      const parts = target.split(':')
      if (parts[0] === 'entity' && parts[1] === featureId && parts[2]) id = parts[2]
    } else {
      const resolved = resolveVertexRef(entityIds, target)
      if (resolved?.point !== undefined) {
        return 'group holds whole sketch entities, not a vertex'
      }
      id = resolved?.entity ?? null
    }
    if (id !== null && projected.has(id)) {
      return `group cannot include the projected entity "${id}"; delete its projection first`
    }
  }
  return null
}

/** The sentence a refused midpoint carries. The accepted shapes come from the
 *  catalog note, so a caller learns what to write instead of only what failed. */
export function midpointShapeReason(targets: readonly string[]): string {
  return `midpoint needs a line and a point, or three points; got ${JSON.stringify(targets)}`
}

/**
 * Why one `add_constraint` pick cannot be authored, or null when it can. `value`
 * is the step's dimension value when it carries one (the zero point_distance
 * rule lives here too, so a refusal has one source).
 *
 * The caller without a materialized target list may get a null for a list that
 * still holds a `dock:`/`isect:` handle: a handle names a point only after
 * materialization, so refusing on it before then would reject a pick the
 * applier can author. The applier calls this again with the resolved targets.
 */
export function addConstraintProblem(
  feature: SketchShape | undefined,
  kind: string,
  targets: readonly string[],
  value: number | undefined,
): string | null {
  if (isConstraintKindName(kind)) {
    const zero = pointDistanceZeroProblem(kind, value)
    if (zero !== null) return zero
  }
  const featureId = feature?.id ?? ''
  const entityIds = new Set((feature?.entities ?? []).map(e => e.id))
  const kindById = new Map((feature?.entities ?? []).map(e => [e.id, e.kind]))
  const sideOf = (target: string) => constraintTargetSide(target, featureId, entityIds, kindById)

  // A target naming another sketch is dead on the wire: the solver resolves
  // sketch-local refs only. The UI snap and constraint paths project the picked
  // element first (applyAddConstraint does it in the applier); a drive or MCP
  // author gets told what to do instead of an ok that changed nothing. Only
  // judged when the active sketch is known: a shape-only caller cannot classify
  // a feature-qualified ref.
  if (feature !== undefined) {
    const foreign = targets.find(target => foreignConstraintTarget(String(target), featureId))
    if (foreign !== undefined) {
      return `constraint targets must be in sketch ${featureId}; project ${foreign} first (add_projected_entity)`
    }
  }

  if (kind === 'midpoint') {
    if (midpointOperands(targets, sideOf) !== null) return null
    // A handle that will materialize into a point keeps the list judgeable
    // after the applier runs; only a shape this sketch can already see is a
    // refusal here.
    const unmaterialized = targets.some(target => sideOf(target) === 'unresolved')
    return unmaterialized && targets.length <= 3 ? null : midpointShapeReason(targets)
  }

  if (kind === 'horizontal' || kind === 'vertical') {
    // Overloaded: one line -> `target`, two points -> `a`/`b`. A whole entity in
    // the a/b slot resolves to one sub-point and yields a degenerate residual
    // that is often already satisfied, so the line never turns. Empty falls
    // through both forms, so it is refused too.
    // See bugreports/vertical_constraint_20260621_102915.md.
    if (targets.length < 1) return `${kind} needs a target`
    if (targets.length >= 2 && (targets[0].startsWith('entity:') || targets[1].startsWith('entity:'))) {
      return `${kind} needs one line or two points, got ${JSON.stringify(targets)}`
    }
    return null
  }

  if (kind === 'colinear') {
    // The solver has a row for two lines or a point and a line. A lone operand
    // or any other pair used to be stored and dropped with no residual, so both
    // the count and the shape are refused with the same sentence the lowering
    // uses.
    if (targets.length !== 2) return COLINEAR_SHAPE_REASON
    return colinearShapeProblem(targets[0], targets[1], target => sideOf(String(target)))
  }

  if (kind === 'group') {
    return groupProblem(feature, featureId, targets, value)
  }

  // Generic kinds need operands: coincident pairs two refs, everything else at
  // least one. An empty (or single-target coincident) pick would otherwise
  // author an operand-less, or half-authored, constraint the solver can only
  // read as garbage.
  const min = kind === 'coincident' ? 2 : 1
  if (targets.length < min) {
    return `${kind} needs ${min === 1 ? 'a target' : 'two targets'}, got ${JSON.stringify(targets)}`
  }
  return null
}
