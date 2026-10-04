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
  type FlatConstraint,
  type FlatInput,
  type FlatRef,
  Kind,
  Role,
  Sel,
} from './codec'

const ENTITY_SIZES: Record<string, number> = { line: 4, circle: 3, arc: 5, point: 2, ellipse: 5, spline: 8 }
const KIND_CODE: Record<string, number> = {
  line: Kind.Line,
  circle: Kind.Circle,
  arc: Kind.Arc,
  point: Kind.Point,
  ellipse: Kind.Ellipse,
  spline: Kind.Spline,
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
  construction?: boolean
}

export interface LowerResult {
  input: FlatInput
  // Index-aligned entity layout, including the injected origin at the end.
  layout: EntityLayout[]
}

export interface LowerOptions {
  dragMode?: boolean
  dragAnchorId?: number
  skipStatusPass?: boolean
}

function isRefDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
    if (!Object.hasOwn(ENTITY_SIZES, e.kind)) {
      throw new Error(`lowerSketch: unknown entity kind '${e.kind}'`)
    }
    const size = ENTITY_SIZES[e.kind]
    layout.push({ id: e.id, kind: e.kind, offset: params.length, size, construction: e.construction })
    const init = e.id === ORIGIN_ID ? [0, 0] : sk.initial[e.id] ?? new Array(size).fill(0)
    for (let i = 0; i < size; i++) params.push(init[i] ?? 0)
  })

  const flatEntities = layout.map((l) => ({ kind: KIND_CODE[l.kind], offset: l.offset }))

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
      const code = Object.hasOwn(SEL_CODE, pointName) ? SEL_CODE[pointName] : undefined
      if (code === undefined) throw new Error(`lowerSketch: unknown point selector '${pointName}'`)
      point = code
    }
    return { kind: 'entity', index, point }
  }

  const lowerConstraint = (c: Record<string, unknown>): FlatConstraint | null => {
    const kindName = c.kind as string
    const kind = ConstraintKindCode[kindName]
    if (kind === undefined) return null
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
    return out
  }

  const constraints: FlatConstraint[] = []
  for (const c of sk.constraints) {
    const lowered = lowerConstraint(c)
    if (lowered) constraints.push(lowered)
  }

  // Implicit origin pin, mirroring _solve_sketch's ORIGIN_FIX.
  constraints.push({
    kind: ConstraintKindCode.fixed,
    refs: [{ role: Role.target, ref: { kind: 'entity', index: idToIndex.get(ORIGIN_ID)!, point: Sel.xy } }],
    xy: [0, 0],
  })

  const input: FlatInput = {
    entities: flatEntities,
    params,
    pinnedMask: pinnedMaskFor(layout, sk.pinnedEntityIds ?? [], params.length),
    equalityPins: [],
    constraints,
    options: {
      dragMode: opts?.dragMode ?? false,
      dragAnchorId: opts?.dragAnchorId ?? 0,
      skipStatusPass: opts?.skipStatusPass ?? false,
    },
  }
  return { input, layout }
}
