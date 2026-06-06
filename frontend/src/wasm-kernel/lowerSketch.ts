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

const ENTITY_SIZES: Record<string, number> = { line: 4, circle: 3, arc: 5, point: 2 }
const KIND_CODE: Record<string, number> = {
  line: Kind.Line,
  circle: Kind.Circle,
  arc: Kind.Arc,
  point: Kind.Point,
}
const SEL_CODE: Record<string, number> = {
  start: Sel.start,
  end: Sel.end,
  center: Sel.center,
  xy: Sel.xy,
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

/** Matches ORIGIN_ID in `solver_constants.py`. */
export const ORIGIN_ID = '_origin'

export interface SketchEntity {
  id: string
  kind: string
}

export interface SketchInput {
  id: string
  plane?: string | null
  entities: SketchEntity[]
  initial: Record<string, number[]>
  constraints: Array<Record<string, unknown>>
}

export interface EntityLayout {
  id: string
  kind: string
  offset: number
  size: number
}

export interface LowerResult {
  input: FlatInput
  /** Index-aligned entity layout, including the injected origin at the end. */
  layout: EntityLayout[]
}

function isRefDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Lower a sketch. Appends the projected origin point (pinned at the plane
 * origin) exactly as `_solve_sketch` does, so DOF accounting and per-entity
 * status match the Python solver.
 */
export function lowerSketch(sk: SketchInput): LowerResult {
  const entities = [...sk.entities, { id: ORIGIN_ID, kind: 'point' }]

  const idToIndex = new Map<string, number>()
  const layout: EntityLayout[] = []
  const params: number[] = []
  entities.forEach((e, index) => {
    idToIndex.set(e.id, index)
    const size = ENTITY_SIZES[e.kind]
    layout.push({ id: e.id, kind: e.kind, offset: params.length, size })
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
    const point = pointName ? SEL_CODE[pointName] ?? Sel.absent : Sel.absent
    return { kind: 'entity', index, point }
  }

  const lowerConstraint = (c: Record<string, unknown>): FlatConstraint | null => {
    const kindName = c.kind as string
    const kind = ConstraintKindCode[kindName]
    if (kind === undefined) return null
    const refs: FlatConstraint['refs'] = []
    for (const [key, role] of REF_KEYS) {
      const val = c[key]
      if (typeof val === 'string' && val === '@builtin_origin') {
        refs.push({ role, ref: { kind: 'external', x: 0, y: 0 } })
        continue
      }
      if (isRefDict(val)) refs.push({ role, ref: lowerRef(val) })
    }
    const out: FlatConstraint = { kind, refs }
    if (typeof c.value === 'number') out.value = c.value
    if (typeof c.x === 'number' && typeof c.y === 'number') out.xy = [c.x, c.y]
    if (typeof c.axis === 'string') out.axis = AxisCode[c.axis]
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
    pinnedMask: [],
    equalityPins: [],
    constraints,
    options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
  }
  return { input, layout }
}
