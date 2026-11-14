/**
 * Lower a sketch (entities + initial params + resolved constraints) into the
 * flat `Input` the Rust solver consumes. This is the "what stays scalar TS"
 * boundary from the migration plan: id->index mapping, the injected projected
 * origin, and constraint-dict -> role/ref encoding all live here, never in the
 * crate.
 *
 * Scope (phase 1 shadow mode): the corpus sketches use plain entity-dict refs
 * and no projections / center_rect sugar. Query-string resolution, projection
 * source resolution, and center_rect expansion are the builder port's job
 * (later phases); this lowering mirrors `_solve_sketch`'s solver-facing
 * pre-processing for the already-resolved case only.
 */

import {
  AxisCode,
  ConstraintKindCode,
  isConstraintKindName,
  type FlatConstraint,
  type FlatInput,
  type FlatRef,
  fitSelectorCode,
  Kind,
  Role,
  Sel,
} from './codec'
import { fitPointIndex } from '@/types/vertexKeys'
import { unflattenGeometry, geomPoint } from '@/utils/geometry/geometryMapping'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { DOC_GRID } from '@/utils/yamlMutations/helpers'

const ENTITY_SIZES: Record<string, number> = { line: 4, circle: 3, arc: 5, point: 2, ellipse: 5, spline: 8 }
const KIND_CODE: Record<string, number> = {
  line: Kind.Line,
  circle: Kind.Circle,
  arc: Kind.Arc,
  point: Kind.Point,
  ellipse: Kind.Ellipse,
  spline: Kind.Spline,
  fit_spline: Kind.FitSpline,
}
// Keys must cover VERTEX_POINT_KEYS (types/vertexKeys.ts), which validates
// dict-ref points upstream; anything it admits has to resolve here.
const SEL_CODE: Record<string, number> = {
  start: Sel.start,
  end: Sel.end,
  center: Sel.center,
  xy: Sel.xy,
  // Ellipse axis-endpoint control points.
  major1: Sel.major,
  major2: Sel.majorNeg,
  minor1: Sel.minor,
  minor2: Sel.minorNeg,
  // Spline off-curve control points.
  c1: Sel.c1,
  c2: Sel.c2,
}

/** The keys a constraint dict may carry a reference under, with their role. */
const REF_KEYS: Array<[string, number]> = [
  ['target', Role.target],
  ['a', Role.a],
  ['b', Role.b],
  ['line', Role.line],
  ['arc', Role.arc],
  ['point', Role.point],
  ['point_a', Role.point_a],
  ['point_b', Role.point_b],
]

/** The injected projected-origin point id. */
export const ORIGIN_ID = '_origin'

export interface SketchEntity {
  id: string
  kind: string
  /** Reference geometry: it constrains the solve like any other entity but
   *  bounds no area, so the area builder skips it (`classify` in dcel.rs). */
  construction?: boolean
  // `fit_spline` only: which end handles the params carry.
  handles?: 'start' | 'end' | 'both'
}

export interface SketchInput {
  id: string
  plane?: string | null
  entities: SketchEntity[]
  initial: Record<string, number[]>
  constraints: Array<Record<string, unknown>>
  /** Entity ids whose every param must be pinned to its initial value (the
   *  solver adds an `x[i] - x0[i]` residual per bit). Projected entities live
   *  here so the LM exploration never nudges them off their projected location.
   *  See `pinnedMaskFor`. */
  pinnedEntityIds?: string[]
}

export interface EntityLayout {
  id: string
  kind: string
  offset: number
  size: number
  // Wire flag bits (`fit_spline` handles); 0 for every other kind.
  flags: number
  construction?: boolean
}

export interface LowerResult {
  input: FlatInput
  // Index-aligned entity layout, including the injected origin at the end.
  layout: EntityLayout[]
  /** Doc constraint id per wire constraint, in the same order; null for the
   *  implicit origin pin (no authored constraint owns it) and for a constraint
   *  dict that carried no string id. The solver's per-constraint verdicts are
   *  index-aligned with the wire, so this maps one back to its doc id. */
  constraintIds: Array<string | null>
}

export interface LowerOptions {
  dragMode?: boolean
  dragAnchorId?: number
  skipStatusPass?: boolean
}

/** One resolved constraint dict, as partDocToSketches hands it to this
 *  lowering: refs are already entity dicts, never query strings. */
type RawConstraint = Record<string, unknown>

function isRefDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * The selector that names an entity kind's first point: the point params 0,1
 * hold, and the anchor a group's translation is measured from.
 */
function firstPointSelector(kind: string): number {
  switch (kind) {
    case 'line':
    case 'spline':
    case 'fit_spline':
      return Sel.start
    case 'circle':
    case 'arc':
    case 'ellipse':
      return Sel.center
    case 'point':
      return Sel.xy
    default:
      // A kind added without deciding its anchor point would lower a group
      // whose translation is measured at the wrong place; fail loud instead.
      throw new Error(`lowerSketch: no group anchor point for entity kind '${kind}'`)
  }
}

/** The vertex key of the same first point, for the reference-point reader. */
function firstPointName(kind: string): string {
  switch (kind) {
    case 'line':
    case 'spline':
    case 'fit_spline':
      return 'start'
    case 'circle':
    case 'arc':
    case 'ellipse':
      return 'center'
    case 'point':
      return 'xy'
    default:
      throw new Error(`lowerSketch: no group anchor point for entity kind '${kind}'`)
  }
}

/** One carrier candidate: a vertex key on a member and its reference position. */
interface CarrierCandidate {
  entity: string
  point: string
  xy: [number, number]
}

/**
 * The coordinate pairs a whole member offers as a group carrier, in selector
 * order. Derived points (an arc's ends, an ellipse's axis ends) are left out: a
 * whole-entity row replacement has to map onto a param pair, and a derived point
 * owns none. A point member naming a derived point is still a candidate; its
 * rows are already point rows.
 */
function wholeMemberPairs(
  layout: EntityLayout,
  params: number[],
): Array<{ point: string; xy: [number, number] }> {
  const pairAt = (pair: number): [number, number] => [
    params[layout.offset + 2 * pair] ?? 0,
    params[layout.offset + 2 * pair + 1] ?? 0,
  ]
  switch (layout.kind) {
    case 'line':
      return [{ point: 'start', xy: pairAt(0) }, { point: 'end', xy: pairAt(1) }]
    case 'circle':
    case 'arc':
    case 'ellipse':
      return [{ point: 'center', xy: pairAt(0) }]
    case 'point':
      return [{ point: 'xy', xy: pairAt(0) }]
    case 'spline':
      return [
        { point: 'start', xy: pairAt(0) },
        { point: 'c1', xy: pairAt(1) },
        { point: 'c2', xy: pairAt(2) },
        { point: 'end', xy: pairAt(3) },
      ]
    case 'fit_spline': {
      const hasStart = (layout.flags & 1) !== 0
      const hasEnd = (layout.flags & 2) !== 0
      const handles = (hasStart ? 1 : 0) + (hasEnd ? 1 : 0)
      const points = (layout.size - 2 * handles) / 2
      const out: Array<{ point: string; xy: [number, number] }> = []
      for (let k = 0; k < points; k++) {
        // The wire names the ends Start/End and only the interior points Fit(k),
        // exactly what the solver's point() reads back.
        const point = k === 0 ? 'start' : k === points - 1 ? 'end' : `fit${k}`
        out.push({ point, xy: pairAt(k) })
      }
      if (hasStart) out.push({ point: 'c1', xy: pairAt(points) })
      if (hasEnd) out.push({ point: 'c2', xy: pairAt(points + handles - 1) })
      return out
    }
    default:
      throw new Error(`lowerSketch: no group carrier point for entity kind '${layout.kind}'`)
  }
}

/**
 * Build the solver's `pinned_mask`: `ceil(nParams / 8)` bytes, LSB-first within
 * each byte (matching `codec.rs`), with a set bit for every param of every
 * entity in `pinnedIds`. Returns `[]` (= nothing pinned) when no id matches, so
 * the non-projection path stays byte-identical to before.
 */
export function pinnedMaskFor(layout: EntityLayout[], pinnedIds: Iterable<string>, nParams: number): number[] {
  const pinned = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds)
  if (pinned.size === 0) return []
  const mask = new Array(Math.ceil(nParams / 8)).fill(0)
  let any = false
  for (const l of layout) {
    if (!pinned.has(l.id)) continue
    for (let i = 0; i < l.size; i++) {
      const bit = l.offset + i
      mask[bit >> 3] |= 1 << (bit & 7)
      any = true
    }
  }
  return any ? mask : []
}

/**
 * Lower a sketch. Appends the projected origin point (pinned at the plane
 * origin), so DOF accounting and per-entity status come out right.
 *
 * Pass `opts.dragMode = true` and `opts.dragAnchorId` for a drag-frame solve;
 * the default cold-solve options are `{ dragMode: false, dragAnchorId: 0,
 * skipStatusPass: false }`.
 */
export function lowerSketch(sk: SketchInput, opts?: LowerOptions): LowerResult {
  const entities = [...sk.entities, { id: ORIGIN_ID, kind: 'point' }]

  const idToIndex = new Map<string, number>()
  const layout: EntityLayout[] = []
  const params: number[] = []
  entities.forEach((e, index) => {
    idToIndex.set(e.id, index)
    // Fail loud: an unknown kind leaves the param count undefined, so the
    // layout arithmetic goes NaN and the kind byte encodes as 0, which the Rust
    // decoder reads back as a Line. A persisted or hand-edited document must
    // not silently solve with that entity's geometry missing.
    let size: number
    let flags = 0
    if (e.kind === 'fit_spline') {
      // Variable size: the initial block IS the layout. Its length must be
      // `2 N + 2 h` with `2 <= N <= 64`, exactly what the Rust `ParamLayout`
      // will demand; a mismatch would shift every following entity's offset.
      const init = e.id === ORIGIN_ID ? [] : sk.initial[e.id]
      if (!Array.isArray(init)) throw new Error(`lowerSketch: fit_spline '${e.id}' has no initial params`)
      const hasStart = e.handles === 'start' || e.handles === 'both'
      const hasEnd = e.handles === 'end' || e.handles === 'both'
      const handleCount = (hasStart ? 1 : 0) + (hasEnd ? 1 : 0)
      flags = (hasStart ? 1 : 0) | (hasEnd ? 2 : 0)
      const remaining = init.length - 2 * handleCount
      if (remaining < 4 || remaining % 2 !== 0) {
        throw new Error(`lowerSketch: fit_spline '${e.id}' has ${init.length} params, expected 2N + ${2 * handleCount} with N >= 2`)
      }
      const points = remaining / 2
      if (points > 64) throw new Error(`lowerSketch: fit_spline '${e.id}' has ${points} fit points, the limit is 64`)
      size = init.length
    } else {
      if (!Object.hasOwn(ENTITY_SIZES, e.kind)) {
        throw new Error(`lowerSketch: unknown entity kind '${e.kind}'`)
      }
      size = ENTITY_SIZES[e.kind]
    }
    layout.push({ id: e.id, kind: e.kind, offset: params.length, size, flags, construction: e.construction })
    const init = e.id === ORIGIN_ID ? [0, 0] : sk.initial[e.id] ?? new Array(size).fill(0)
    for (let i = 0; i < size; i++) params.push(init[i] ?? 0)
  })

  const flatEntities = layout.map((l) => ({
    kind: KIND_CODE[l.kind],
    flags: l.flags,
    offset: l.offset,
    count: l.size,
  }))

  // The reference geometry the group carrier is measured in. Built once from
  // the same `initial` block the solver reads as its reference, so a carrier
  // choice and the angle the solver derives describe the same shape.
  const referenceSketch = unflattenGeometry(sk.initial, sk.entities)

  const lowerRef = (refDict: Record<string, unknown>): FlatRef => {
    if (Array.isArray(refDict.external_xy)) {
      const xy = refDict.external_xy as number[]
      return { kind: 'external', x: xy[0], y: xy[1] }
    }
    const entityId = refDict.entity as string
    const index = idToIndex.get(entityId)
    if (index === undefined) throw new Error(`lowerSketch: unknown entity '${entityId}'`)
    const pointName = refDict.point as string | undefined
    let point: number = Sel.absent
    if (pointName) {
      // Fail loud: Sel.absent is meaningful locus semantics in the solver, so a
      // typo'd selector must never fall back into it.
      // Own-property guard: a plain table inherits Object.prototype members,
      // and an inherited function would encode as 0 (= absent) instead of failing.
      const fitIndex = fitPointIndex(pointName)
      const code = fitIndex !== null
        ? fitSelectorCode(fitIndex)
        : Object.hasOwn(SEL_CODE, pointName)
          ? SEL_CODE[pointName]
          : undefined
      if (code === undefined) throw new Error(`lowerSketch: unknown point selector '${pointName}'`)
      point = code
    }
    return { kind: 'entity', index, point }
  }

  /**
   * Lower one rigid group into its per-member wire constraints.
   *
   * The document carries the member refs only; the shape to hold is the
   * sketch's `initial` block, which the solver reads as its reference (the hard
   * solve's `params`; a drag sends it explicitly). So each member becomes one
   * `Group` row set: its own entity and point selector as the target and the
   * group's anchor point as the `a` ref. The anchor's own pair is that shared
   * translation and contributes no row; the residual builder knows that from
   * the selector.
   *
   * Every group also turns, so one carrier names where the angle is measured:
   * a member point farthest from the anchor, or (when every point sits on the
   * anchor) an arc's or ellipse's own angle. Every row of the one document
   * group carries the same third ref, and the row whose target holds the
   * carrier pair swaps its two coordinate rows for the one distance row that
   * leaves the turn free. With neither, rotation is not observable (a lone
   * circle) and the rows stay what they were.
   *
   * The first target is the anchor. A whole-entity anchor takes the entity
   * kind's first point (line/spline start, the centre of a circle/arc/ellipse,
   * a point's xy, a fit spline's first fit point); a point member anchor takes
   * that point's own selector.
   */
  const lowerGroupConstraint = (c: RawConstraint): FlatConstraint[] => {
    const id = typeof c.id === 'string' ? c.id : '?'
    if (!Array.isArray(c.refs)) {
      throw new Error(`lowerSketch: group '${id}' has no member refs`)
    }
    const members: Array<{ index: number; point: number; name?: string }> = []
    const seen = new Set<string>()
    for (const raw of c.refs) {
      if (!isRefDict(raw) || typeof raw.entity !== 'string' || raw.external_xy !== undefined) {
        throw new Error(`lowerSketch: group '${id}' has a member that is not a local entity ref`)
      }
      if (!idToIndex.has(raw.entity)) {
        throw new Error(`lowerSketch: group '${id}' names unknown entity '${raw.entity}'`)
      }
      const lowered = lowerRef(raw)
      if (lowered.kind !== 'entity') {
        throw new Error(`lowerSketch: group '${id}' has a member that is not a local entity ref`)
      }
      const key = `${lowered.index}:${lowered.point}`
      if (seen.has(key)) continue
      seen.add(key)
      members.push({
        index: lowered.index,
        point: lowered.point,
        name: typeof raw.point === 'string' ? raw.point : undefined,
      })
    }
    if (members.length === 0) throw new Error(`lowerSketch: group '${id}' has no members`)
    const anchor = members[0]
    const anchorName = anchor.name ?? firstPointName(layout[anchor.index].kind)
    const anchorPoint = anchor.point !== Sel.absent
      ? anchor.point
      : firstPointSelector(layout[anchor.index].kind)
    const anchorXY = geomPoint(referenceSketch, { entity: layout[anchor.index].id, point: anchorName })
    if (anchorXY === null) {
      throw new Error(`lowerSketch: group '${id}' has no reference point for its anchor`)
    }

    // The carrier is the farthest own point of any member, in member then
    // selector order so ties and cell-sized sketches stay deterministic.
    let carrier: { role: number; ref: FlatRef } | null = null
    let farthest = -1
    let best: CarrierCandidate | null = null
    for (const member of members) {
      const entity = layout[member.index]
      let candidates: CarrierCandidate[]
      if (member.name !== undefined) {
        const xy = geomPoint(referenceSketch, { entity: entity.id, point: member.name })
        candidates = xy === null ? [] : [{ entity: entity.id, point: member.name, xy }]
      } else {
        candidates = wholeMemberPairs(entity, params).map(p => ({ entity: entity.id, ...p }))
      }
      for (const candidate of candidates) {
        // Strictly greater, so the first candidate wins a tie.
        const distance = Math.hypot(candidate.xy[0] - anchorXY[0], candidate.xy[1] - anchorXY[1])
        if (distance > farthest) {
          farthest = distance
          best = candidate
        }
      }
    }
    if (best !== null && farthest > TOL_TOPOLOGY_MERGE) {
      carrier = { role: Role.b, ref: lowerRef({ entity: best.entity, point: best.point }) }
    } else {
      // Every candidate sits on the anchor (concentric arcs): only a whole
      // member's own orientation can tell that the set turned. A circular
      // ellipse has no observable orientation, so it is not a carrier.
      for (const member of members) {
        const entity = layout[member.index]
        if (member.name !== undefined) continue
        if (entity.kind === 'arc') {
          carrier = { role: Role.arc, ref: { kind: 'entity', index: member.index, point: Sel.absent } }
          break
        }
        if (entity.kind === 'ellipse') {
          const a = params[entity.offset + 2] ?? 0
          const b = params[entity.offset + 3] ?? 0
          if (Math.abs(a - b) > TOL_TOPOLOGY_MERGE) {
            carrier = { role: Role.arc, ref: { kind: 'entity', index: member.index, point: Sel.absent } }
            break
          }
        }
      }
    }

    return members.map((member) => {
      const refs: FlatConstraint['refs'] = [
        { role: Role.target, ref: { kind: 'entity', index: member.index, point: member.point } },
        { role: Role.a, ref: { kind: 'entity', index: anchor.index, point: anchorPoint } },
      ]
      // Every row of one document group reads the same carrier, so they all
      // derive one phi.
      if (carrier !== null) refs.push({ role: carrier.role, ref: carrier.ref })
      return { kind: ConstraintKindCode.group, refs }
    })
  }

  const lowerConstraint = (c: RawConstraint): FlatConstraint[] => {
    const kindName = c.kind as string
    // Every document kind is turned into a wire kind by partDocToSketches before
    // this runs, and the document boundary refuses an unknown kind by field, so
    // a kind the wire table does not name here is a programming error. The old
    // `return null` was a silent drop: `colinear` vanished this way with no
    // dropped verdict, no warning and no residual.
    // Own-property guard: a plain table inherits Object.prototype members, and
    // an inherited function would pass a bare undefined check.
    if (!isConstraintKindName(kindName)) {
      throw new Error(`lowerSketch: unknown constraint kind '${kindName}'`)
    }
    if (kindName === 'group') return lowerGroupConstraint(c)
    const kind = ConstraintKindCode[kindName]
    const refs: FlatConstraint['refs'] = []
    for (const [key, role] of REF_KEYS) {
      const val = c[key]
      // Only resolved dict refs are accepted: partDocToSketches pre-transforms
      // the live query strings ($line1, @builtin_origin) and owns originLocal.
      // The former bare-'@builtin_origin' shortcut hardcoded external [0,0],
      // silently wrong for an offset plane whose document origin is elsewhere.
      if (isRefDict(val)) {
        refs.push({ role, ref: lowerRef(val) })
        continue
      }
      // Fail loud like the selector/axis guards: a string here means a caller
      // bypassed the resolver, and silently dropping it would author a
      // constraint with missing operands.
      if (val !== undefined && val !== null) {
        throw new Error(`lowerSketch: unresolved query-string ref '${String(val)}' in '${key}'; resolve refs via partDocToSketches before lowering`)
      }
    }
    const out: FlatConstraint = { kind, refs }
    if (typeof c.value === 'number') out.value = c.value
    if (typeof c.x === 'number' && typeof c.y === 'number') out.xy = [c.x, c.y]
    // Fail loud: an unencoded axis would leave the flag unset so the Rust
    // decoder sees axis=None, bypassing its own BadAxis rejection.
    if (typeof c.axis === 'string') {
      const axis = Object.hasOwn(AxisCode, c.axis) ? AxisCode[c.axis] : undefined
      if (axis === undefined) throw new Error(`lowerSketch: unknown axis '${c.axis}'`)
      out.axis = axis
    }
    if (typeof c.sign === 'number') out.sign = c.sign
    return [out]
  }

  const constraints: FlatConstraint[] = []
  const constraintIds: Array<string | null> = []
  for (const c of sk.constraints) {
    const lowered = lowerConstraint(c)
    // A sugar constraint (a group) lowers to several rows; every piece maps
    // back to the one authored id so its verdict can name the user's row.
    for (const flat of lowered) {
      constraints.push(flat)
      constraintIds.push(typeof c.id === 'string' ? c.id : null)
    }
  }

  // Implicit origin pin, mirroring _solve_sketch's ORIGIN_FIX.
  constraints.push({
    kind: ConstraintKindCode.fixed,
    refs: [{ role: Role.target, ref: { kind: 'entity', index: idToIndex.get(ORIGIN_ID)!, point: Sel.xy } }],
    xy: [0, 0],
  })
  constraintIds.push(null)

  const input: FlatInput = {
    entities: flatEntities,
    params,
    pinnedMask: pinnedMaskFor(layout, sk.pinnedEntityIds ?? [], params.length),
    equalityPins: [],
    // The document's storage grid, so the solver's moved report matches what
    // the write-back can actually represent. Blind-side constant: the crate
    // never hard-codes it.
    seedQuantum: DOC_GRID,
    constraints,
    options: {
      dragMode: opts?.dragMode ?? false,
      dragAnchorId: opts?.dragAnchorId ?? 0,
      skipStatusPass: opts?.skipStatusPass ?? false,
    },
  }
  return { input, layout, constraintIds }
}
