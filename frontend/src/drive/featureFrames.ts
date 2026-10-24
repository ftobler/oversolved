// The resolved frames a run or measure reply reports, one per sketch and
// add_plane feature. A sketch on a face takes its origin at the face centroid
// and its axes from the normal rule, which is not something an author can read
// off the query; reporting the frame answers "where does my sketch x go"
// without a probe hole or a source read.
//
// The frame comes from the kernel's own result: `plane_transform` for a sketch
// (`frameFromPlaneTransform`) and `plane` for a plane feature. A feature the
// solve refused carries no frame, so it stays out of the map: inventing one
// would describe a plane the sketch was never built on.

import type { PartDoc } from '@/types/cad'
import type { BuildResponse } from '@/kernel/builderTypes'
import { frameFromPlaneTransform } from '@/kernel/types3d'
import { round } from '@/utils/yamlMutations/helpers'

export interface FeatureFrame {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Feature id -> the frame that feature was solved in. */
export type FeatureFrameMap = Record<string, FeatureFrame>

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

/**
 * The frames of every sketch and plane feature the solve resolved, keyed by
 * feature id. A feature missing from `result` (a shorter solve, a suppressed
 * row) or carrying no frame (an exception) is left out.
 */
export function featureFrames(
  doc: PartDoc | null | undefined,
  result: BuildResponse['result'] | null | undefined,
): FeatureFrameMap {
  const frames: FeatureFrameMap = {}
  if (!doc || !result) return frames
  for (const feature of doc.features ?? []) {
    if (!FRAME_FEATURE_KINDS.has(String(feature.kind))) continue
    const id = String(feature.id ?? '')
    if (id === '') continue
    const frame = frameOfResult(result[id])
    if (frame !== null) frames[id] = frame
  }
  return frames
}
