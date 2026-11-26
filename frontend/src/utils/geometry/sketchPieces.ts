// PURE -- no doc mutation, no WASM, no Three.js. The piece-rewrite engine shared
// by the sketch split and trim: find where a point lies on a curve, cut the curve
// into ordered pieces at native parameters, and plan the document rewrite that
// replaces the entity by the pieces it keeps.
//
// The plan is shape preserving by construction. The first kept piece keeps the
// entity id, so every ref to the original start vertex and every carrier-level
// relation (horizontal, parallel, radius, tangent to a circle) stays valid with
// no rewrite. Refs to a vertex that now belongs to another piece move to it, and
// adjacent kept pieces are tied (coincident joint plus the kind's carrier tie)
// with one pin per line or arc joint so the split point does not slide: a fully
// constrained line, arc or circle stays fully constrained. A spline joint has no
// such pin (the pieces' inner handles are new freedom), and kept pieces that are
// not neighbours get no tie at all: trim, which drops the piece between them,
// states what still relates them itself.
//
// Supported kinds: line, arc, circle (two or more cuts) and the cubic Bezier
// spline. An ellipse has no elliptical-arc entity kind to cut into, and a piece
// of a fit spline is not the interpolant of its own fit points, so both are the
// caller's refusal, as is a point.

import type { PartConstraint, SketchFeature } from '@/types/cad'
import { entityPointXY } from '@/registry/entityRegistry'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'
import { CONSTRAINT_REF_FIELDS, refMatchesEntity, round } from '@/utils/yamlMutations/helpers'
import { bezierClosestT, bezierEval, type Pt } from './fitSpline'

/** How far a picked point may lie from the curve and still name a point on it.
 *  The same reach the topology's intersection attribution uses for "this point
 *  lies on that curve" (snapDetection's INFERRED_TOL). */
export const PIECE_PICK_TOL = 1e-3

export type PieceEntityKind = 'line' | 'arc' | 'circle' | 'spline'
export type PieceKind = 'line' | 'arc' | 'spline'

const PIECE_ENTITY_KINDS: ReadonlySet<string> = new Set(['line', 'arc', 'circle', 'spline'])

const PARAM_COUNT: Record<PieceEntityKind, number> = { line: 4, arc: 5, circle: 3, spline: 8 }

export function isPieceEntityKind(kind: string): kind is PieceEntityKind {
  return PIECE_ENTITY_KINDS.has(kind)
}

/** Where a point's closest foot lies on a curve, in the curve's native
 *  parameter: line t (0 at start, 1 at end), arc and circle angle in degrees,
 *  Bezier t. For an arc the parameter is measured CCW from the start angle, as
 *  `a0 + rel` with rel in [0, 360), so it orders along the sweep. `inSpan` says
 *  whether the foot lies on the finite curve (a line foot past an end, an arc
 *  angle outside the sweep); `distance` is to the carrier foot. */
export interface EntityFoot {
  param: number
  foot: Pt
  distance: number
  inSpan: boolean
}

const DEG = Math.PI / 180

function mod360(deg: number): number {
  const m = deg % 360
  return m < 0 ? m + 360 : m
}

/** The arc's CCW sweep in degrees, with a nonzero full turn kept as 360. */
export function arcSweep(a0: number, a1: number): number {
  const delta = a1 - a0
  if (delta !== 0 && delta % 360 === 0) return 360
  return mod360(delta)
}

function bezierCtrl(params: readonly number[]): Pt[] {
  return [
    [params[0], params[1]], [params[2], params[3]],
    [params[4], params[5]], [params[6], params[7]],
  ]
}

export function pointOnEntity(kind: string, params: readonly number[], p: readonly [number, number]): EntityFoot | null {
  if (!params.every(Number.isFinite)) return null
  if (kind === 'line' && params.length >= 4) {
    const [x0, y0, x1, y1] = params
    const dx = x1 - x0
    const dy = y1 - y0
    const len2 = dx * dx + dy * dy
    if (!(len2 > 0)) return null
    const t = ((p[0] - x0) * dx + (p[1] - y0) * dy) / len2
    const foot: Pt = [x0 + t * dx, y0 + t * dy]
    return { param: t, foot, distance: Math.hypot(p[0] - foot[0], p[1] - foot[1]), inSpan: t >= 0 && t <= 1 }
  }
  if ((kind === 'arc' && params.length >= 5) || (kind === 'circle' && params.length >= 3)) {
    const [cx, cy, r] = params
    if (!(r > 0)) return null
    const angle = Math.atan2(p[1] - cy, p[0] - cx) / DEG
    const foot: Pt = [cx + r * Math.cos(angle * DEG), cy + r * Math.sin(angle * DEG)]
    const distance = Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r)
    if (kind === 'circle') return { param: mod360(angle), foot, distance, inSpan: true }
    const a0 = params[3]
    const rel = mod360(angle - a0)
    return { param: a0 + rel, foot, distance, inSpan: rel <= arcSweep(a0, params[4]) }
  }
  if (kind === 'spline' && params.length >= 8) {
    const ctrl = bezierCtrl(params)
    const t = bezierClosestT(ctrl, [p[0], p[1]])
    const foot = bezierEval(ctrl, t)
    return { param: t, foot, distance: Math.hypot(p[0] - foot[0], p[1] - foot[1]), inSpan: true }
  }
  return null
}

/** The point at a native parameter, the inverse of `pointOnEntity`'s param. */
export function entityPointAt(kind: string, params: readonly number[], param: number): Pt | null {
  if (kind === 'line') {
    const [x0, y0, x1, y1] = params
    return [x0 + param * (x1 - x0), y0 + param * (y1 - y0)]
  }
  if (kind === 'arc' || kind === 'circle') {
    const [cx, cy, r] = params
    return [cx + r * Math.cos(param * DEG), cy + r * Math.sin(param * DEG)]
  }
  if (kind === 'spline') return bezierEval(bezierCtrl(params), param)
  return null
}

/** One cubic split at t by de Casteljau: two exact cubics meeting at B(t). */
export function splitBezier(ctrl: readonly Pt[], t: number): [Pt[], Pt[]] {
  const lerp = (a: Pt, b: Pt): Pt => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
  const [p0, p1, p2, p3] = ctrl
  const q0 = lerp(p0, p1)
  const q1 = lerp(p1, p2)
  const q2 = lerp(p2, p3)
  const r0 = lerp(q0, q1)
  const r1 = lerp(q1, q2)
  const s = lerp(r0, r1)
  return [[p0, q0, r0, s], [s, r1, q2, p3]]
}

export interface EntityPiece {
  kind: PieceKind
  params: number[]
}

/**
 * Cut an entity at the given native parameters into ordered piece param
 * blocks. The parameters must lie strictly inside the span and be distinct;
 * they are sorted here. A circle needs at least two cuts and its pieces start
 * at the smallest cut angle, wrapping through the seam. The original endpoints
 * are copied, never recomputed, so the first piece starts and the last ends
 * byte-identical to the entity. Returns null for an unsupported kind or cut.
 */
export function cutEntity(kind: string, params: readonly number[], cutParams: readonly number[]): EntityPiece[] | null {
  if (cutParams.length === 0 || !cutParams.every(Number.isFinite)) return null
  if (!isPieceEntityKind(kind)) return null
  const needed = PARAM_COUNT[kind]
  if (params.length < needed || !params.slice(0, needed).every(Number.isFinite)) return null
  const cuts = [...cutParams].sort((a, b) => a - b)
  // Two equal cuts would make an empty piece.
  const distinct = kind === 'circle' ? cuts.map(mod360).sort((a, b) => a - b) : cuts
  for (let i = 1; i < distinct.length; i++) if (distinct[i] === distinct[i - 1]) return null
  if (kind === 'line') {
    if (cuts[0] <= 0 || cuts[cuts.length - 1] >= 1) return null
    const points: Pt[] = [[params[0], params[1]]]
    for (const t of cuts) points.push(entityPointAt('line', params, t)!)
    points.push([params[2], params[3]])
    const pieces: EntityPiece[] = []
    for (let i = 0; i + 1 < points.length; i++) {
      pieces.push({ kind: 'line', params: [points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]] })
    }
    return pieces
  }
  if (kind === 'arc') {
    const [cx, cy, r, a0, a1] = params
    const sweep = arcSweep(a0, a1)
    const rel = cuts.map(c => c - a0)
    if (rel[0] <= 0 || rel[rel.length - 1] >= sweep) return null
    const angles = [a0, ...rel.map(s => mod360(a0 + s)), a1]
    const pieces: EntityPiece[] = []
    for (let i = 0; i + 1 < angles.length; i++) {
      pieces.push({ kind: 'arc', params: [cx, cy, r, angles[i], angles[i + 1]] })
    }
    return pieces
  }
  if (kind === 'circle') {
    if (cuts.length < 2) return null
    const [cx, cy, r] = params
    const angles = cuts.map(mod360).sort((a, b) => a - b)
    const pieces: EntityPiece[] = []
    for (let i = 0; i < angles.length; i++) {
      pieces.push({ kind: 'arc', params: [cx, cy, r, angles[i], angles[(i + 1) % angles.length]] })
    }
    return pieces
  }
  if (kind === 'spline') {
    if (cuts[0] <= 0 || cuts[cuts.length - 1] >= 1) return null
    const pieces: EntityPiece[] = []
    let rest = bezierCtrl(params)
    let consumed = 0
    for (const t of cuts) {
      // Each cut is re-expressed on the remaining tail, which spans [consumed, 1].
      const [head, tail] = splitBezier(rest, (t - consumed) / (1 - consumed))
      pieces.push({ kind: 'spline', params: head.flat() })
      rest = tail
      consumed = t
    }
    pieces.push({ kind: 'spline', params: rest.flat() })
    // The endpoints are the entity's own numbers, not de Casteljau's re-evaluation.
    pieces[0].params[0] = params[0]
    pieces[0].params[1] = params[1]
    pieces[pieces.length - 1].params[6] = params[6]
    pieces[pieces.length - 1].params[7] = params[7]
    return pieces
  }
  return null
}

// ─── Document plan ───

/** The slots of a piece that `cutEntity` copied from the entity: the outer
 *  ends, and an arc's centre and radius. */
function copiedSlots(kind: PieceEntityKind, index: number, last: number): number[] {
  const slots: number[] = []
  if (kind === 'arc' || kind === 'circle') slots.push(0, 1, 2)
  if (index === 0) {
    if (kind === 'line' || kind === 'spline') slots.push(0, 1)
    if (kind === 'arc') slots.push(3)
  }
  if (index === last) {
    if (kind === 'line') slots.push(2, 3)
    if (kind === 'spline') slots.push(6, 7)
    if (kind === 'arc') slots.push(4)
  }
  return slots
}

/** Interior numbers land on the document grid; the copied ones stay the
 *  entity's own bytes, so an untouched end never moves by a rounding. */
function onGrid(kind: PieceEntityKind, params: readonly number[], index: number, last: number): number[] {
  const copied = new Set(copiedSlots(kind, index, last))
  return params.map((value, slot) => copied.has(slot) ? value : round(value))
}

/** A ref to one piece of the plan: the whole piece, or one of its vertices.
 *  `piece` indexes `PieceRewritePlan.pieces`. */
export interface PieceRef {
  piece: number
  vertex?: 'start' | 'end' | 'center'
}

export interface PlannedPiece extends EntityPiece {
  kept: boolean
  // The first kept piece takes over the entity id; every other kept piece is
  // minted by the applier.
  keepsId: boolean
}

/** The single-operand ref fields a rewrite may retarget (CONSTRAINT_REF_FIELDS,
 *  spelled as literals so a write stays typed as a ref). */
export type RefField = 'target' | 'a' | 'b' | 'line' | 'arc' | 'point' | 'point_a' | 'point_b'

/** An in-place rewrite of an existing constraint: its id, value and label stay,
 *  only the named ref fields (and optionally the kind) change. */
export interface PlannedConstraintRewrite {
  constraintId: string
  set: Partial<Record<RefField, PieceRef>>
  kind?: string
  clear?: RefField[]
}

/** A constraint the plan authors between pieces. A string target is passed to
 *  the applier verbatim (`vertex:<sketch>:<id>:<key>`), for a caller that ties
 *  a piece to other geometry, as trim ties a new end to its cutter. */
export interface PlannedPieceConstraint {
  kind: string
  targets: Array<PieceRef | string>
  value?: number
  sign?: number
}

export type PieceRewritePlan =
  | {
      entityId: string
      pieces: PlannedPiece[]
      // Constraints that named only dropped geometry, removed with it.
      removeConstraintIds: string[]
      rewrites: PlannedConstraintRewrite[]
      addConstraints: PlannedPieceConstraint[]
    }
  | { code: 'invalid' | 'unknown-target'; reason: string }

type PieceFeatureInput = Pick<SketchFeature, 'id' | 'entities' | 'initial' | 'constraints'>

function stringRefs(c: PartConstraint): Array<{ field: RefField; ref: string }> {
  const out: Array<{ field: RefField; ref: string }> = []
  for (const field of CONSTRAINT_REF_FIELDS) {
    const value = c[field]
    if (typeof value === 'string') out.push({ field: field as RefField, ref: value })
  }
  return out
}

/** The vertex key a `$<eid><key>` ref names on this entity, '' for the bare
 *  entity, null when the ref names something else. */
function refKey(ref: string, entityId: string): string | null {
  if (!refMatchesEntity(ref, entityId)) return null
  return ref.slice(1 + entityId.length)
}

/** The entity id and key a local ref names, resolved against the sketch's own
 *  entity ids (longest match, since a bare id can prefix another). */
function parseLocalRef(ref: string, entityIds: readonly string[]): { id: string; key: string } | null {
  let best: { id: string; key: string } | null = null
  for (const id of entityIds) {
    const key = refKey(ref, id)
    if (key === null) continue
    if (best === null || id.length > best.id.length) best = { id, key }
  }
  return best
}

const OWN_KEYS: Record<PieceEntityKind, ReadonlySet<string>> = {
  line: new Set(['start', 'end']),
  arc: new Set(['start', 'end', 'center']),
  circle: new Set(['center']),
  spline: new Set(['start', 'end', 'c1', 'c2']),
}

/** Why a constraint on the entity forbids the rewrite, or null. These have no
 *  form that survives a cut: the user must remove or re-anchor them first. */
function blockingReason(c: PartConstraint, entityId: string, kind: PieceEntityKind): string | null {
  const refs = stringRefs(c)
  const bare = refs.some(({ ref }) => refKey(ref, entityId) === '')
  if (c.kind === 'group') return `the entity is held by group constraint "${c.id}"; ungroup first`
  if (c.kind === 'projection') {
    return `the entity is projected geometry held by constraint "${c.id}"; projected geometry is derived, edit its source instead`
  }
  if (c.kind === 'fixed' && bare) return `constraint "${c.id}" fixes the whole entity; remove it first`
  // On an arc or circle `equal_length` means equal radius, a carrier relation
  // the first piece keeps; only a line's length has no form across pieces.
  if (c.kind === 'equal_length' && bare && kind === 'line') {
    return `constraint "${c.id}" is an equal_length on the entity, which has no form across its pieces; remove it first`
  }
  if (c.kind === 'midpoint' && typeof c.line === 'string' && refKey(c.line, entityId) === '') {
    return `constraint "${c.id}" is a midpoint on the entity, whose midpoint is no piece's midpoint; remove it first`
  }
  if (c.kind === 'ngon') return `the entity belongs to n-gon constraint "${c.id}"; remove it first`
  for (const { ref } of refs) {
    const key = refKey(ref, entityId)
    if (key === null || key === '') continue
    if (key === 'c1' || key === 'c2') {
      return `constraint "${c.id}" names the spline handle "${key}", which the cut moves; remove it first`
    }
    if (!OWN_KEYS[kind].has(key)) return `constraint "${c.id}" names the point "${key}", which the cut cannot carry`
  }
  return null
}

function memberHeldIds(constraints: readonly PartConstraint[]): Map<string, string> {
  const held = new Map<string, string>()
  for (const c of constraints) {
    if (c.kind !== 'projection') continue
    if (typeof c.target === 'string') held.set(c.target.replace(/^\$/, ''), c.id)
    for (const member of Object.values(c.members ?? {})) held.set(member, c.id)
  }
  return held
}

/** The piece a native parameter falls in, by the sorted cut list. */
export function pieceOfParam(kind: PieceEntityKind, params: readonly number[], cuts: readonly number[], param: number): number {
  if (kind === 'circle') {
    // Circle pieces start at the smallest cut and wrap through the seam.
    const angles = cuts.map(mod360).sort((a, b) => a - b)
    const a = mod360(param)
    for (let i = 0; i < angles.length; i++) {
      const lo = angles[i]
      const hi = i + 1 < angles.length ? angles[i + 1] : angles[0] + 360
      const rel = a >= lo ? a : a + 360
      if (rel >= lo && rel < hi) return i
    }
    return 0
  }
  // An arc parameter outside the sweep, a line foot past an end: the nearer end
  // piece holds it, which is the carrier either way.
  let value = param
  if (kind === 'arc') {
    const sweep = arcSweep(params[3], params[4])
    const rel = param - params[3]
    if (rel > sweep) value = rel - sweep < 360 - rel ? params[3] + sweep : params[3]
  }
  let index = 0
  for (const cut of cuts) if (value > cut) index++
  return index
}

/** Chord quality for pinning a point on a circle by its distance to another:
 *  the row's sensitivity to the angle goes as |cos(delta / 2)|, so a chord near
 *  a diameter cannot hold the point. */
function chordQuality(fromDeg: number, toDeg: number): number {
  return Math.abs(Math.cos((mod360(toDeg - fromDeg) * DEG) / 2))
}

/**
 * Plan the rewrite of `entityId` cut at `cutParams` (native parameters strictly
 * inside the span, as `pointOnEntity` reports them), keeping the pieces whose
 * `keep` flag is set. Split keeps every piece; trim drops one. `keep` is in
 * `cutEntity`'s piece order: along the curve from its start, and for a circle
 * from the smallest cut angle (mod 360) through the seam; `pieceOfParam` maps a
 * parameter to that index.
 *
 * Constraint carry, in the order it is decided:
 * - refused by constraint id: a group, a projection, a fixed on the whole
 *   entity, an equal_length or midpoint on the entity, an n-gon side, a ref to a
 *   spline handle;
 * - a ref to a vertex moves to the piece that now owns it (start to the first
 *   piece, end to the last); when that piece is dropped the constraint goes;
 * - a `length` becomes a `point_distance` from the first piece's start to the
 *   last piece's end, the same value and label: the end-to-end distance the
 *   user typed. Without both end pieces it goes;
 * - a point-on-curve coincident moves to the piece under the point (only a
 *   spline needs it, a line or arc carrier holds it anyway);
 * - a tangent whose other curve meets the entity at one of its ends is that
 *   end's joint and moves with the end;
 * - every other relation stays on the id-keeping piece: the carrier ties make
 *   it true for the rest.
 */
export function planPieceRewrite(
  feature: PieceFeatureInput,
  entityId: string,
  cutParams: readonly number[],
  keep: readonly boolean[],
): PieceRewritePlan {
  const entities = feature.entities ?? []
  const initial = feature.initial ?? {}
  const constraints = feature.constraints ?? []
  const entity = entities.find(e => e.id === entityId)
  if (entity === undefined) {
    return { code: 'unknown-target', reason: `entity "${entityId}" names no entity in the sketch` }
  }
  const kind = entity.kind
  if (!isPieceEntityKind(kind)) {
    return { code: 'invalid', reason: `a ${kind} cannot be cut into pieces` }
  }
  const params = initial[entityId] ?? []
  const cuts = [...cutParams].sort((a, b) => a - b)
  const raw = cutEntity(kind, params, cuts)
  if (raw === null) {
    return { code: 'invalid', reason: `the cut parameters do not lie strictly inside "${entityId}"` }
  }
  if (keep.length !== raw.length) {
    return { code: 'invalid', reason: `keep names ${keep.length} piece(s), the cut makes ${raw.length}` }
  }
  const first = keep.indexOf(true)
  if (first < 0) return { code: 'invalid', reason: 'the rewrite keeps no piece; delete the entity instead' }

  const held = memberHeldIds(constraints).get(entityId)
  if (held !== undefined) {
    return {
      code: 'invalid',
      reason: `the entity is projected geometry held by constraint "${held}"; projected geometry is derived, edit its source instead`,
    }
  }
  for (const c of constraints) {
    if (!stringRefs(c).some(({ ref }) => refMatchesEntity(ref, entityId))
      && !(c.refs ?? []).some(ref => refMatchesEntity(ref, entityId))
      && !refMatchesEntity(c.circle, entityId)) continue
    const reason = blockingReason(c, entityId, kind)
    if (reason !== null) return { code: 'invalid', reason }
  }

  const last = raw.length - 1
  const pieces: PlannedPiece[] = raw.map((piece, index) => ({
    kind: piece.kind,
    params: onGrid(kind, piece.params, index, raw.length - 1),
    kept: keep[index],
    keepsId: index === first,
  }))

  const entityIds = entities.map(e => e.id)
  const kindOf = new Map(entities.map(e => [e.id, e.kind]))
  const pointOf = (ref: string): Pt | null => {
    const parsed = parseLocalRef(ref, entityIds)
    if (parsed === null) return null
    const otherKind = kindOf.get(parsed.id) ?? ''
    // A bare point entity names its only vertex; any other bare entity is a
    // curve, not a point.
    const key = parsed.key === '' ? (otherKind === 'point' ? 'xy' : '') : parsed.key
    if (key === '') return null
    return entityPointXY(otherKind, initial[parsed.id] ?? [], key) ?? null
  }
  const ends: Array<{ key: 'start' | 'end'; at: Pt; piece: number }> = []
  if (kind !== 'circle') {
    for (const key of ['start', 'end'] as const) {
      const at = entityPointXY(kind, params, key)
      if (at !== undefined) ends.push({ key, at, piece: key === 'start' ? 0 : last })
    }
  }
  // Whether another curve has an end on this point: the shape of an end-to-end
  // tangent joint.
  const meetsAt = (otherId: string, at: Pt): boolean => {
    const otherKind = kindOf.get(otherId) ?? ''
    const otherParams = initial[otherId] ?? []
    return (['start', 'end'] as const).some(key => {
      const p = entityPointXY(otherKind, otherParams, key)
      return p !== undefined && Math.hypot(p[0] - at[0], p[1] - at[1]) <= TOL_TOPOLOGY_MERGE
    })
  }

  // The piece that holds a coincident between this entity and `otherId`: this
  // entity's start or end vertex, or the piece under the partner's point when
  // the point lies on this curve. Null when no such coincident exists.
  const contactPiece = (otherId: string): number | null => {
    for (const c of constraints) {
      if (c.kind !== 'coincident' || typeof c.a !== 'string' || typeof c.b !== 'string') continue
      for (const [mine, theirs] of [[c.a, c.b], [c.b, c.a]]) {
        const key = refKey(mine, entityId)
        if (key === null || parseLocalRef(theirs, entityIds)?.id !== otherId) continue
        if (key === 'start') return 0
        if (key === 'end') return last
        if (key !== '') continue
        const at = pointOf(theirs)
        const foot = at === null ? null : pointOnEntity(kind, params, at)
        if (foot !== null) return pieceOfParam(kind, params, cuts, foot.param)
      }
    }
    return null
  }

  const removeConstraintIds: string[] = []
  const rewrites: PlannedConstraintRewrite[] = []
  for (const c of constraints) {
    const refs = stringRefs(c)
    if (!refs.some(({ ref }) => refMatchesEntity(ref, entityId))) continue

    if (c.kind === 'length') {
      if (keep[0] && keep[last]) {
        rewrites.push({
          constraintId: c.id,
          kind: 'point_distance',
          clear: ['target'],
          set: { a: { piece: 0, vertex: 'start' }, b: { piece: last, vertex: 'end' } },
        })
      } else {
        removeConstraintIds.push(c.id)
      }
      continue
    }

    const set: Partial<Record<RefField, PieceRef>> = {}
    let drop = false
    for (const { field, ref } of refs) {
      const key = refKey(ref, entityId)
      if (key === null) continue
      let target: PieceRef
      if (key === 'start' || key === 'end') {
        target = { piece: key === 'start' ? 0 : last, vertex: key }
      } else if (key === 'center') {
        target = { piece: first, vertex: 'center' }
      } else {
        // The bare entity: a carrier relation unless it is a joint or a locus.
        const others = refs.filter(other => other.field !== field)
        let piece = first
        if (c.kind === 'tangent') {
          const otherIds = others
            .map(other => parseLocalRef(other.ref, entityIds))
            .filter((p): p is { id: string; key: string } => p !== null && p.id !== entityId)
            .map(p => p.id)
          // The solver reads a tangent's contact from the coincident between the
          // same two curves, so the tangent follows that coincident to its piece;
          // only without one does an end the partner touches decide.
          const contact = otherIds.length === 1 ? contactPiece(otherIds[0]) : null
          if (contact !== null) piece = contact
          else {
            const joint = ends.filter(end => otherIds.some(id => meetsAt(id, end.at)))
            if (joint.length === 1) piece = joint[0].piece
          }
        } else if (c.kind === 'coincident' && others.length === 1) {
          const at = pointOf(others[0].ref)
          const foot = at === null ? null : pointOnEntity(kind, params, at)
          if (foot !== null) piece = pieceOfParam(kind, params, cuts, foot.param)
          // A line or arc carrier still holds the point when its piece is gone.
          if (!keep[piece] && kind !== 'spline') piece = first
        }
        target = { piece }
      }
      if (!keep[target.piece]) {
        drop = true
        break
      }
      const unchanged = target.piece === first && (target.vertex === undefined ? key === '' : target.vertex === key)
      if (!unchanged) set[field] = target
    }
    if (drop) removeConstraintIds.push(c.id)
    else if (Object.keys(set).length > 0) rewrites.push({ constraintId: c.id, set })
  }

  const addConstraints: PlannedPieceConstraint[] = []
  const joints: Array<[number, number]> = []
  for (let i = 0; i < last; i++) if (keep[i] && keep[i + 1]) joints.push([i, i + 1])
  if (kind === 'circle' && keep[last] && keep[0]) joints.push([last, 0])
  for (const [a, b] of joints) {
    addConstraints.push({ kind: 'coincident', targets: [{ piece: a, vertex: 'end' }, { piece: b, vertex: 'start' }] })
    if (kind === 'line') addConstraints.push({ kind: 'colinear', targets: [{ piece: a }, { piece: b }] })
    else if (kind === 'spline') addConstraints.push({ kind: 'tangent', targets: [{ piece: a }, { piece: b }] })
    else if (b !== 0) addConstraints.push({ kind: 'concentric', targets: [{ piece: first }, { piece: b }] })
  }
  addConstraints.push(...jointPins(kind, params, pieces, joints))

  return { entityId, pieces, removeConstraintIds, rewrites, addConstraints }
}

/**
 * One dimension per joint, so the split point does not slide along the carrier
 * (the coincident and the carrier tie leave it one free parameter). Each joint
 * is pinned against a point already held: a line joint by the length of the
 * piece before it, an arc joint by its chord to the arc's start, end or the
 * previous joint (whichever chord is farthest from a diameter, where a distance
 * cannot hold an angle), a circle's first cut by its axis offset from the
 * centre. A spline joint has no such row: its pieces keep the shape only
 * through their own handles.
 */
function jointPins(
  kind: PieceEntityKind,
  params: readonly number[],
  pieces: readonly PlannedPiece[],
  joints: ReadonlyArray<[number, number]>,
): PlannedPieceConstraint[] {
  const out: PlannedPieceConstraint[] = []
  if (kind === 'line') {
    for (const [a] of joints) {
      const [x0, y0, x1, y1] = pieces[a].params
      out.push({ kind: 'length', targets: [{ piece: a }], value: round(Math.hypot(x1 - x0, y1 - y0)) })
    }
    return out
  }
  const last = pieces.length - 1
  if (kind === 'arc') {
    for (const [a, b] of joints) {
      // Pin against points that are held already: the arc's own ends and the
      // previous joint, which this loop pinned one step earlier.
      const candidates: Array<{ ref: PieceRef; deg: number }> = []
      if (pieces[0].kept) candidates.push({ ref: { piece: 0, vertex: 'start' }, deg: params[3] })
      if (pieces[last].kept) candidates.push({ ref: { piece: last, vertex: 'end' }, deg: params[4] })
      if (a > 0) candidates.push({ ref: { piece: a, vertex: 'start' }, deg: pieces[a].params[3] })
      if (candidates.length > 0) {
        out.push(chordPin(params[2], { piece: b, vertex: 'start' }, pieces[b].params[3], candidates))
      }
    }
    return out
  }
  if (kind === 'circle' && joints.length > 0 && pieces[0].kept) {
    const r = params[2]
    const seam = pieces[0].params[3]
    // A closed curve has no end to measure from, so the first cut is held by
    // its offset from the centre along the axis that moves fastest with the
    // angle there.
    const useX = Math.abs(Math.sin(seam * DEG)) >= Math.abs(Math.cos(seam * DEG))
    const offset = round(r * (useX ? Math.cos(seam * DEG) : Math.sin(seam * DEG)))
    out.push({
      kind: useX ? 'point_distance_x' : 'point_distance_y',
      targets: [{ piece: 0, vertex: 'center' }, { piece: 0, vertex: 'start' }],
      value: Math.abs(offset),
      sign: offset >= 0 ? 1 : -1,
    })
    for (const [, b] of joints) {
      if (b === 0) continue
      const candidates: Array<{ ref: PieceRef; deg: number }> = [
        { ref: { piece: 0, vertex: 'start' }, deg: seam },
        { ref: { piece: b - 1, vertex: 'start' }, deg: pieces[b - 1].params[3] },
      ]
      out.push(chordPin(r, { piece: b, vertex: 'start' }, pieces[b].params[3], candidates))
    }
  }
  return out
}

function chordPin(
  r: number,
  point: PieceRef,
  atDeg: number,
  candidates: ReadonlyArray<{ ref: PieceRef; deg: number }>,
): PlannedPieceConstraint {
  let best = candidates[0]
  for (const candidate of candidates) {
    if (chordQuality(atDeg, candidate.deg) > chordQuality(atDeg, best.deg)) best = candidate
  }
  const chord = 2 * r * Math.abs(Math.sin((mod360(atDeg - best.deg) * DEG) / 2))
  return { kind: 'point_distance', targets: [best.ref, point], value: round(chord) }
}
