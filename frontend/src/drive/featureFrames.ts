// The resolved frames a measure reply (or a `frames: "all"` run) reports, one
// per sketch and add_plane feature. A sketch on a face takes its origin at the
// face centroid and its axes from the normal rule, which is not something an
// author can read off the query; reporting the frame answers "where does my
// sketch x go" without a probe hole or a source read.
//
// The frame comes from the kernel's own result: `plane_transform` for a sketch
// (`frameFromPlaneTransform`) and `plane` for a plane feature. A suppressed
// feature, or one whose solve threw, carries no frame-bearing result and stays
// out of the map: inventing one would describe a plane the sketch was never
// built on. An overconstrained sketch did build on a plane and is reported.
//
// A chained call must not repeat the whole history: an untouched sketch whose
// frame did not move did not change because a later call added a fillet. The
// run reply keeps a frame only when the call touched the feature or the frame
// differs from the input document's solve; `mode: 'all'` (the `frames: "all"`
// opt-in) restores every resolved frame, which is also what a measure reply
// reports.

import type { PartDoc } from '@/types/cad'
import type { BuildResponse } from '@/kernel/builderTypes'
import { frameFromPlaneTransform } from '@/kernel/types3d'
import { TOL_SELECT_DIRECTION } from '@/kernel/solverConstants'
import { round } from '@/utils/yamlMutations/helpers'
import { LENGTH_UNIT_LABEL, lengthUnitOf } from '@/utils/lengthUnit'
import type { FeatureNote } from '@/drive/featureOutcome'

export interface FeatureFrame {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Feature id -> the frame that feature was solved in. */
export type FeatureFrameMap = Record<string, FeatureFrame>

export interface FeatureFrameOptions {
  // The input document's solve: a frame that matches it did not change.
  baseline?: FeatureFrameMap | null
  // Feature ids the steps created or named; such a frame is reported even when
  // it did not move, because the call is what authored it.
  touched?: ReadonlySet<string>
  // 'all' lists every resolved frame (the inspection opt-in); 'changed' keeps
  // only what this call touched or moved. Omitting the options keeps the
  // historical all-frames behaviour.
  mode?: 'changed' | 'all'
}

const FRAME_FEATURE_KINDS: ReadonlySet<string> = new Set(['sketch', 'plane'])

// The kernel's per-feature solve result crosses the worker as plain data, so its
// fields are only knowable by shape here (the same untyped boundary
// `BuildResponse.result` names). This alias is that boundary, not a feature
// shape: the doc side still narrows by kind.
type SolvedFeature = { [field: string]: unknown }

function isSolvedFeature(value: unknown): value is SolvedFeature {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

/** The same 6-decimal rounding the sketch mutators persist, so a reported
 *  frame reads like the document rather than like raw solver digits. */
function roundFrame(frame: {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}): FeatureFrame {
  return {
    origin: frame.origin.map(round),
    x_axis: frame.x_axis.map(round),
    y_axis: frame.y_axis.map(round),
    normal: frame.normal.map(round),
  }
}

function frameOfResult(result: unknown): FeatureFrame | null {
  if (!isSolvedFeature(result)) return null
  if (isSolvedFeature(result.plane_transform)) {
    const { rotation, origin } = result.plane_transform
    if (isTuple(rotation, 9) && isTuple(origin, 3)) {
      return roundFrame(frameFromPlaneTransform({ rotation, origin }))
    }
  }
  if (isSolvedFeature(result.plane)) {
    const { origin, x_axis, y_axis, normal } = result.plane
    if (isTuple(origin, 3) && isTuple(x_axis, 3) && isTuple(y_axis, 3) && isTuple(normal, 3)) {
      return roundFrame({ origin, x_axis, y_axis, normal })
    }
  }
  return null
}

const FRAME_VECTORS = ['origin', 'x_axis', 'y_axis', 'normal'] as const

/** Both frames are already rounded to the reply's precision, so equality here
 *  is exactly "the reply would print the same numbers twice". */
function sameFrame(a: FeatureFrame, b: FeatureFrame): boolean {
  return FRAME_VECTORS.every(key => a[key].every((value, index) => value === b[key][index]))
}

/**
 * The frames of every sketch and plane feature the solve resolved, keyed by
 * feature id. A feature missing from `result` (a shorter solve, a suppressed
 * row) or with no frame-bearing result (a thrown solve) is left out.
 *
 * In `changed` mode a baseline frame that matches the final one is left out
 * unless the steps touched the feature, so a chained call reports only what it
 * authored or moved; a frame the baseline lacked is new and is reported. A
 * missing baseline cannot call anything unchanged, so every frame is shown
 * (the same fallback `featureDeltas` uses).
 */
export function featureFrames(
  doc: PartDoc | null | undefined,
  result: BuildResponse['result'] | null | undefined,
  opts: FeatureFrameOptions = {},
): FeatureFrameMap {
  const frames: FeatureFrameMap = {}
  if (!doc || !result) return frames
  const mode = opts.mode ?? 'all'
  const baseline = mode === 'changed' ? opts.baseline ?? null : null
  const touched = opts.touched ?? new Set<string>()
  for (const feature of doc.features ?? []) {
    if (!FRAME_FEATURE_KINDS.has(String(feature.kind))) continue
    const id = String(feature.id ?? '')
    if (id === '') continue
    const frame = frameOfResult(result[id])
    if (frame === null) continue
    if (mode === 'changed' && baseline !== null && !touched.has(id)) {
      const before = baseline[id]
      if (before !== undefined && sameFrame(frame, before)) continue
    }
    frames[id] = frame
  }
  return frames
}

// The spelling a plane query groups by: a ref sigil is not part of the query,
// so `$sk2` and `@sk2` name one plane.
function planeKey(plane: string): string {
  return plane.startsWith('$') || plane.startsWith('@') ? plane.slice(1) : plane
}

function axesMoved(a: readonly number[], b: readonly number[]): boolean {
  return a.some((value, index) => Math.abs(value - (b[index] ?? value)) > TOL_SELECT_DIRECTION)
}

/**
 * Two sketches drawn on one stored face query can resolve to different frames
 * without a word in the document: the plane resolver re-derives a `?` face
 * query's origin from the face centroid on every solve (resolveSketchPlane), so
 * a feature between the two sketches that changed that face (a boss consuming
 * part of it) moves the later sketch's frame. The document is internally
 * consistent and the pair is not: a bore meant to sit inside a boss becomes
 * eccentric.
 *
 * The frames map holds the answer for both sketches; grouping by the stored
 * query is the only step that compares them. Emit one note per later sketch
 * whose frame differs from the first sketch on the same query, naming both.
 * A builtin plane or a plane-feature ref resolves to the same frame every time,
 * so only a face query can produce a note in practice; the grouping does not
 * depend on that, which keeps the check honest if a resolver changes.
 *
 * The distance is compared after the reply's own 6-decimal rounding, so a note
 * never prints "differ by 0.000000"; an axes-only drift gets a wording that
 * does not claim an origin distance.
 */
export function frameConflicts(
  doc: PartDoc | null | undefined,
  frames: FeatureFrameMap,
): FeatureNote[] {
  if (!doc) return []
  const groups = new Map<string, { id: string; plane: string }[]>()
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'sketch') continue
    const id = String(feature.id ?? '')
    const plane = typeof feature.plane === 'string' ? feature.plane : ''
    if (id === '' || plane === '' || frames[id] === undefined) continue
    const key = planeKey(plane)
    groups.set(key, [...(groups.get(key) ?? []), { id, plane }])
  }
  const unit = LENGTH_UNIT_LABEL[lengthUnitOf(doc.length_unit)]
  const notes: FeatureNote[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]
    const firstFrame = frames[first.id]
    for (const sketch of group.slice(1)) {
      const frame = frames[sketch.id]
      const distance = round(Math.hypot(
        frame.origin[0] - firstFrame.origin[0],
        frame.origin[1] - firstFrame.origin[1],
        frame.origin[2] - firstFrame.origin[2],
      ))
      const turned = axesMoved(firstFrame.x_axis, frame.x_axis)
        || axesMoved(firstFrame.y_axis, frame.y_axis)
      if (distance === 0 && !turned) continue
      const what = distance !== 0
        ? `their resolved origins differ by ${distance} ${unit}`
        : 'their resolved in-plane axes differ'
      notes.push({
        ids: [first.id, sketch.id],
        text: `${first.id} and ${sketch.id} share the face query "${first.plane}"; ${what}, `
          + `so a feature between them changed that face and ${sketch.id}'s coordinates sit in a `
          + `different frame. Sketch on a plane offset from the first sketch, or move ${sketch.id} `
          + 'above that feature',
      })
    }
  }
  return notes
}
