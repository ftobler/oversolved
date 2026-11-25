// The sketch clipboard's format and its two pure operations, build and parse.
// The text is versioned, `kind`-tagged JSON so "other info" (features,
// variables) can join it under a new kind later without changing this reader's
// envelope. A clip is self-contained: the source may be another document, a
// deleted sketch or another browser tab, so nothing in it is resolved against
// the live document on the way in.
//
// Coordinates are sketch-local 2D and lengths are in the document unit named by
// `length_unit`; a paste into another unit converts them. The constraints are
// already filtered by the shared carry rule (yamlMutations/sketchCarry): only
// the ones that live entirely inside the copied set survive, so the copy is a
// free-floating duplicate that keeps its internal shape.

import type {
  Entity, LengthUnit, PartConstraint, PartEntityDef, Sketch, SketchEntitiesClip, SketchFeature,
} from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import {
  ENTITY_BY_KIND, ENTITY_PARAM_LAYOUT, entityCoordPairs,
} from '@/registry/entityRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { MAX_FIT_POINTS } from '@/utils/geometry/fitSpline'
import { CARRY_KINDS } from '@/utils/yamlMutations/sketchMirror'
import { carryConstraints, type CarryReport } from '@/utils/yamlMutations/sketchCarry'
import { CONSTRAINT_REF_FIELDS } from '@/utils/yamlMutations/helpers'
import { isVertexPointKey } from '@/types/vertexKeys'

/** The envelope's magic key. A JSON object without it is not our text. */
export const CLIPBOARD_MAGIC = 'oversolved'

/** The one envelope version this build writes and reads. */
export const CLIPBOARD_VERSION = 1

/** The only kind v1 reads. Phase 2 adds feature and variable clips beside it. */
export type ClipKind = 'sketch-entities'

export type { SketchEntitiesClip }

export interface BuiltSketchClip {
  clip: SketchEntitiesClip
  // What the carry rule could not take: the copy is free-floating.
  broken: CarryReport
}

export type ClipBuild = BuiltSketchClip | { reason: string }

export const NOT_OURS = 'The clipboard does not hold Oversolved sketch geometry.'
export const NO_GEOMETRY = 'The clipboard holds no sketch geometry.'
export const PASTE_NEEDS_SKETCH = 'Open a sketch to paste sketch geometry.'

function newerFormat(version: number): string {
  return `The clipboard holds geometry from a newer Oversolved (format ${version}); this version reads format 1.`
}

function foreignKind(kind: unknown): string {
  const name = typeof kind === 'string' ? kind : JSON.stringify(kind) ?? String(kind)
  return `The clipboard holds ${name}, which cannot be pasted into a sketch.`
}

function entityInvalid(id: string, detail: string): string {
  return `Entity ${id} in the clipboard is not valid: ${detail}.`
}

function constraintNamesMissing(id: string, ref: string): string {
  return `Constraint ${id} in the clipboard names ${ref}, which is not in the copied geometry.`
}

function constraintInvalid(id: string, detail: string): string {
  return `Constraint ${id} in the clipboard is not valid: ${detail}.`
}

/** One untyped clip row, before the field checks narrow it. */
interface RawRow {
  [key: string]: unknown
}

const isRecord = (value: unknown): value is RawRow =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The PartConstraint fields a clip may carry. Anything else in a hand-edited
// row is dropped rather than copied into the document.
const CONSTRAINT_FIELDS = [
  'value', 'target', 'a', 'b', 'refs', 'circle', 'line', 'arc', 'point',
  'point_a', 'point_b', 'host', 'x', 'y', 'axis', 'sign', 'pos', 'source',
  'members', 'excluded', 'driven',
] as const

/** The flat params of one solved entity, in the registry's slot order. The
 *  solved map is where a projected entity's real geometry lives; its stored
 *  `initial` may be stale or absent. */
export function entityToParams(kind: string, entity: Entity): number[] {
  switch (kind) {
    case 'line': {
      const line = entity as { start: [number, number]; end: [number, number] }
      return [line.start[0], line.start[1], line.end[0], line.end[1]]
    }
    case 'circle': {
      const circle = entity as { center: [number, number]; radius: number }
      return [circle.center[0], circle.center[1], circle.radius]
    }
    case 'arc': {
      const arc = entity as {
        center: [number, number]; radius: number; angle_start: number; angle_end: number
      }
      return [arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end]
    }
    case 'ellipse': {
      const ellipse = entity as {
        center: [number, number]; a: number; b: number; theta: number
      }
      return [ellipse.center[0], ellipse.center[1], ellipse.a, ellipse.b, ellipse.theta]
    }
    case 'spline': {
      const spline = entity as {
        p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]
      }
      return [
        spline.p1[0], spline.p1[1], spline.p2[0], spline.p2[1],
        spline.p3[0], spline.p3[1], spline.p4[0], spline.p4[1],
      ]
    }
    case 'fit_spline': {
      const fit = entity as {
        points: [number, number][]; handleStart?: [number, number]; handleEnd?: [number, number]
      }
      const out = fit.points.flatMap(point => [point[0], point[1]])
      if (fit.handleStart) out.push(fit.handleStart[0], fit.handleStart[1])
      if (fit.handleEnd) out.push(fit.handleEnd[0], fit.handleEnd[1])
      return out
    }
    case 'point': {
      const point = entity as { x: number; y: number }
      return [point.x, point.y]
    }
    default:
      return []
  }
}

/** Why one entity's block cannot be a clip row, or null when it can. The count
 *  comes from the entity registry, so a new kind cannot be forgotten here. */
function blockProblem(kind: string, params: unknown, handles?: 'start' | 'end' | 'both'): string | null {
  const layout = (ENTITY_PARAM_LAYOUT as Record<string, readonly string[]>)[kind]
  if (layout === undefined) return `unknown kind ${kind}`
  if (!Array.isArray(params)) return 'its parameters are not a list'
  if (!params.every(value => typeof value === 'number' && Number.isFinite(value))) {
    return 'its parameters must be finite numbers'
  }
  const block = params as number[]
  if (kind !== 'fit_spline') {
    return block.length === layout.length
      ? null
      : `a ${kind} needs ${layout.length} parameters, got ${block.length}`
  }
  const handleCount = handles === 'both' ? 2 : handles === 'start' || handles === 'end' ? 1 : 0
  const points = (block.length - 2 * handleCount) / 2
  if (block.length < 4 + 2 * handleCount || !Number.isInteger(points) || points < 2 || points > MAX_FIT_POINTS) {
    return `a fit_spline needs 2..${MAX_FIT_POINTS} fit points followed by its handles, got ${block.length} parameters`
  }
  return null
}

/** Every entity id a selection id names for a clipboard copy: an entity or a
 *  vertex names its own entity, a constraint names the entities it reaches.
 *  Selection ids outside the open sketch are ignored, so a mixed 2D/3D
 *  selection copies only the sketch half. */
export function clipboardSelectionEntityIds(
  selection: ReadonlySet<string>,
  sketch: SketchFeature,
): string[] {
  const known = new Set((sketch.entities ?? []).map(entity => entity.id))
  const constraints = new Map((sketch.constraints ?? []).map(c => [c.id, c]))
  const out = new Set<string>()
  const addRef = (ref: unknown): void => {
    if (typeof ref !== 'string') return
    const bare = ref.startsWith('$') ? ref.slice(1) : ref
    for (const id of known) {
      if (bare === id || (bare.startsWith(id) && isVertexPointKey(bare.slice(id.length)))) {
        out.add(id)
        return
      }
    }
  }
  for (const selectionId of selection) {
    const parts = selectionId.split(':')
    if (parts[1] !== sketch.id) continue
    if (parts[0] === 'entity' || parts[0] === 'vertex') {
      if (parts[2] !== undefined && known.has(parts[2])) out.add(parts[2])
      continue
    }
    if (parts[0] !== 'constraint' || parts[2] === undefined) continue
    const constraint = constraints.get(parts[2])
    if (constraint === undefined) continue
    for (const field of CONSTRAINT_REF_FIELDS) addRef(constraint[field])
    for (const ref of constraint.refs ?? []) addRef(ref)
    addRef(constraint.circle)
  }
  return [...out]
}

/**
 * Build the clip for the selected entities of `sketch`, or the reason it cannot
 * be copied. `solved` makes every block the geometry the user sees, which is
 * what a projected entity needs; without it the stored `initial` is used.
 */
export function buildSketchClip(
  sketch: SketchFeature,
  selectedIds: readonly string[],
  options: { solved?: Sketch; lengthUnit?: LengthUnit } = {},
): ClipBuild {
  const selected = new Set(selectedIds)
  const chosen = (sketch.entities ?? []).filter(entity => selected.has(entity.id))
  if (chosen.length === 0) return { reason: 'The selection holds no sketch entities to copy.' }

  const defs: PartEntityDef[] = []
  const initial: Record<string, number[]> = {}
  for (const def of chosen) {
    const solvedEntity = options.solved?.[def.id]
    // A projected entity may resolve to another kind than it was picked as (a
    // tilted circle is an ellipse). The copy is that resolved kind, because it
    // is the geometry the user sees.
    const kind = solvedEntity === undefined ? def.kind : getEntityKind(solvedEntity)
    const params = solvedEntity !== undefined
      ? entityToParams(kind, solvedEntity)
      : sketch.initial?.[def.id]
    const problem = blockProblem(kind, params, def.handles)
    if (problem !== null) return { reason: entityInvalid(def.id, problem) }
    initial[def.id] = [...(params as number[])]
    defs.push(kind === def.kind ? { ...def } : { ...def, kind })
  }

  // The carry rule filters the constraints; the operands already name the clip
  // ids, so the clip stores them as they are written.
  const carried = carryConstraints(sketch.constraints ?? [], defs.map(def => def.id), 'copy', null)
  const constraints = carried.templates.map(template => {
    const clone: PartConstraint = { ...template.constraint }
    if (Array.isArray(template.constraint.refs)) clone.refs = [...template.constraint.refs]
    return clone
  })

  return {
    clip: {
      oversolved: 1,
      kind: 'sketch-entities',
      entities: defs.map(def => ({ ...def })),
      initial,
      constraints,
      length_unit: options.lengthUnit ?? 'mm',
    },
    broken: carried.report,
  }
}

/** The readable text the Copy command puts on the clipboard. The two-space
 *  indentation is deliberate: a user or an LLM can read and edit it. */
export function serializeClip(clip: SketchEntitiesClip): string {
  return JSON.stringify(clip, null, 2)
}

/** True when `ref` names one of the copied entities (whole or one vertex). */
function refInClip(ref: string, entityIds: readonly string[]): boolean {
  if (ref.startsWith('@') || ref.startsWith('?')) return false
  const bare = ref.startsWith('$') ? ref.slice(1) : ref
  return entityIds.some(id => bare === id || (bare.startsWith(id) && isVertexPointKey(bare.slice(id.length))))
}

/** The structural gate every clip passes on the way out and on the way in. A
 *  mutation can arrive from MCP or a replay, so the applier calls this too, not
 *  only the editor's own parse. */
export function validateClip(value: unknown): SketchEntitiesClip | { reason: string } {
  if (!isRecord(value)) return { reason: NOT_OURS }
  const version = value[CLIPBOARD_MAGIC]
  if (typeof version !== 'number') return { reason: NOT_OURS }
  if (version !== CLIPBOARD_VERSION) return { reason: newerFormat(version) }
  // A missing kind is not a recognizable envelope; a named other kind is our
  // format but a payload this reader does not take.
  if (typeof value.kind !== 'string') return { reason: NOT_OURS }
  if (value.kind !== 'sketch-entities') return { reason: foreignKind(value.kind) }

  const unit = value.length_unit
  if (unit !== 'mm' && unit !== 'inch') return { reason: NOT_OURS }
  if (!Array.isArray(value.entities)) return { reason: NOT_OURS }
  if (value.entities.length === 0) return { reason: NO_GEOMETRY }
  if (!isRecord(value.initial) || !Array.isArray(value.constraints)) return { reason: NOT_OURS }

  const entities: PartEntityDef[] = []
  const entityIds: string[] = []
  for (const raw of value.entities) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.kind !== 'string') {
      return { reason: entityInvalid(String(isRecord(raw) ? raw.id : raw), 'the entity row is malformed') }
    }
    if (entityIds.includes(raw.id)) return { reason: entityInvalid(raw.id, 'the id appears twice') }
    if (!ENTITY_BY_KIND.has(raw.kind) || !Object.hasOwn(ENTITY_PARAM_LAYOUT, raw.kind)) {
      return { reason: entityInvalid(raw.id, `unknown kind ${raw.kind}`) }
    }
    if (raw.handles !== undefined && raw.handles !== 'start' && raw.handles !== 'end' && raw.handles !== 'both') {
      return { reason: entityInvalid(raw.id, 'handles must be start, end or both') }
    }
    const problem = blockProblem(
      raw.kind,
      value.initial[raw.id],
      raw.handles === 'start' || raw.handles === 'end' || raw.handles === 'both' ? raw.handles : undefined,
    )
    if (problem !== null) return { reason: entityInvalid(raw.id, problem) }
    entityIds.push(raw.id)
    const entity: PartEntityDef = { id: raw.id, kind: raw.kind }
    if (raw.construction === true) entity.construction = true
    if (raw.handles === 'start' || raw.handles === 'end' || raw.handles === 'both') entity.handles = raw.handles
    entities.push(entity)
  }

  const initial: Record<string, number[]> = {}
  for (const id of entityIds) initial[id] = [...(value.initial[id] as number[])]

  const constraints: PartConstraint[] = []
  const constraintIds = new Set<string>()
  for (const raw of value.constraints) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.kind !== 'string') {
      return { reason: constraintInvalid(String(isRecord(raw) ? raw.id : raw), 'the constraint row is malformed') }
    }
    if (constraintIds.has(raw.id)) return { reason: constraintInvalid(raw.id, 'the id appears twice') }
    constraintIds.add(raw.id)
    if (!CONSTRAINT_BY_KIND.has(raw.kind)) {
      return { reason: constraintInvalid(raw.id, `unknown kind ${raw.kind}`) }
    }
    // A clip is a free-floating copy: a fixed row or an outside link never
    // belongs in one, whether the builder or a hand edit put it there.
    if (!CARRY_KINDS.has(raw.kind) || raw.kind === 'fixed' || raw.kind === 'projection') {
      return { reason: constraintInvalid(raw.id, `${raw.kind} cannot be pasted into a free copy`) }
    }
    const clone: PartConstraint = { id: raw.id, kind: raw.kind }
    for (const field of CONSTRAINT_FIELDS) {
      if (raw[field] !== undefined) Object.assign(clone, { [field]: raw[field] })
    }
    if (clone.refs !== undefined && !Array.isArray(clone.refs)) {
      return { reason: constraintInvalid(raw.id, 'refs must be a list') }
    }
    // `host` names another constraint (the dock kind), which is not carried:
    // the copy would name a row that does not exist in the target sketch.
    if (clone.host !== undefined) {
      return { reason: constraintInvalid(raw.id, 'host names a constraint in the source sketch') }
    }
    for (const field of CONSTRAINT_REF_FIELDS) {
      const ref = clone[field]
      if (ref === undefined) continue
      if (typeof ref !== 'string') return { reason: constraintInvalid(raw.id, `${String(field)} is not a ref`) }
      if (!refInClip(ref, entityIds)) return { reason: constraintNamesMissing(raw.id, ref) }
    }
    for (const ref of clone.refs ?? []) {
      if (typeof ref !== 'string' || !refInClip(ref, entityIds)) {
        return { reason: constraintNamesMissing(raw.id, String(ref)) }
      }
    }
    if (clone.circle !== undefined && (typeof clone.circle !== 'string' || !refInClip(clone.circle, entityIds))) {
      return { reason: constraintNamesMissing(raw.id, String(clone.circle)) }
    }
    if (clone.value !== undefined && (typeof clone.value !== 'number' || !Number.isFinite(clone.value))) {
      return { reason: constraintInvalid(raw.id, 'value must be a finite number') }
    }
    if (clone.pos !== undefined && (
      !Array.isArray(clone.pos) || clone.pos.length !== 2
      || clone.pos.some(v => typeof v !== 'number' || !Number.isFinite(v))
    )) {
      return { reason: constraintInvalid(raw.id, 'pos must be a finite [x, y] pair') }
    }
    if (clone.sign !== undefined && (typeof clone.sign !== 'number' || !Number.isFinite(clone.sign))) {
      return { reason: constraintInvalid(raw.id, 'sign must be a finite number') }
    }
    if (clone.axis !== undefined && typeof clone.axis !== 'string') {
      return { reason: constraintInvalid(raw.id, 'axis must be a string') }
    }
    // A reference dimension carries its role through the clipboard: a pasted
    // measurement must not become a driver in the target sketch.
    if (clone.driven !== undefined && clone.driven !== true) {
      return { reason: constraintInvalid(raw.id, 'driven must be true when present') }
    }
    // x/y are a fixed row's pin, which the free-copy rule already refused; a
    // non-finite pair on any other kind would still be junk in the document.
    for (const field of ['x', 'y'] as const) {
      if (clone[field] !== undefined && (typeof clone[field] !== 'number' || !Number.isFinite(clone[field]))) {
        return { reason: constraintInvalid(raw.id, `${field} must be a finite number`) }
      }
    }
    constraints.push(clone)
  }

  return {
    oversolved: 1,
    kind: 'sketch-entities',
    entities,
    initial,
    constraints,
    length_unit: unit,
  }
}

/** Parse clipboard text into a clip, or the sentence the toast shows. */
export function parseClip(text: string): SketchEntitiesClip | { reason: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { reason: NOT_OURS }
  }
  return validateClip(value)
}

export interface ClipBox {
  center: [number, number]
  width: number
  height: number
  diagonal: number
}

/** The clip's 2D bounds in its own unit, for centring it under the cursor. The
 *  extents are conservative for curves (a full radius around the centre), which
 *  is what a paste offset needs; it is not a rendered outline. */
export function clipBoundingBox(clip: SketchEntitiesClip): ClipBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const see = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const def of clip.entities) {
    const params = clip.initial[def.id] ?? []
    if (def.kind === 'circle' || def.kind === 'arc') {
      const [cx, cy, radius] = params
      see(cx - radius, cy - radius)
      see(cx + radius, cy + radius)
      continue
    }
    if (def.kind === 'ellipse') {
      const [cx, cy, a, b] = params
      const extent = Math.max(a, b)
      see(cx - extent, cy - extent)
      see(cx + extent, cy + extent)
      continue
    }
    for (const [ix, iy] of entityCoordPairs(def.kind, params.length, def.handles) ?? []) {
      see(params[ix], params[iy])
    }
  }
  if (!Number.isFinite(minX)) return { center: [0, 0], width: 0, height: 0, diagonal: 0 }
  const width = maxX - minX
  const height = maxY - minY
  return {
    center: [(minX + maxX) / 2, (minY + maxY) / 2],
    width,
    height,
    diagonal: Math.hypot(width, height),
  }
}
