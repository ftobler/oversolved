// The resolved placement of each helix a solve built, keyed by feature id. A
// helix is a reference curve with an axis and a start point, not an in-plane
// x/y frame, so it gets its own map beside `frames`: folding it into the frame
// shape would publish two axes that mean nothing on a curve.
//
// The placement comes from the kernel's own result (`placement`, written by
// solveHelix) and the document's `helix` definition. The result supplies the
// points and the climb axis; the definition supplies `hand`, the input the
// solve read, because the result does not repeat it. A suppressed helix or one
// whose solve threw has no placement row and stays out of the map.
//
// The map is reported whole rather than filtered to what a call touched. The
// caller that needs it is a sweep chained after the helix's own call, where the
// helix was built by an earlier call and is not touched now; a touched-only
// default would hide the start exactly when the sweep needs it.

import type { PartDoc } from '@/types/cad'
import type { BuildResponse } from '@/kernel/builderTypes'
import { round } from '@/utils/yamlMutations/helpers'

export interface FeatureCurve {
  origin: number[]
  // The climb direction, not the reference axis: `direction: reverse` negates
  // it, so a caller can place a profile without re-reading the helix definition.
  axis: number[]
  start: number[]
  end: number[]
  radius: number
  pitch: number
  turns: number
  height: number
  hand: 'right' | 'left'
}

/** Helix feature id -> the placement that feature was solved at. */
export type FeatureCurveMap = Record<string, FeatureCurve>

// The kernel's per-feature solve result crosses the worker as plain data, so its
// fields are only knowable by shape here (the same untyped boundary
// `BuildResponse.result` names). The doc side still narrows by kind.
type SolvedFeature = { [field: string]: unknown }

function isSolvedFeature(value: unknown): value is SolvedFeature {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 3
    && value.every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function curveOfResult(result: unknown, definition: unknown): FeatureCurve | null {
  if (!isSolvedFeature(result) || result.status !== 'ok') return null
  if (!isSolvedFeature(result.placement) || !isSolvedFeature(result.helix)) return null
  const { origin, axis, start, end } = result.placement
  const { radius, pitch, turns, height } = result.helix
  if (!isVector(origin) || !isVector(axis) || !isVector(start) || !isVector(end)) return null
  if (!isNumber(radius) || !isNumber(pitch) || !isNumber(turns) || !isNumber(height)) return null
  const hand = isSolvedFeature(definition) && definition.hand === 'left' ? 'left' : 'right'
  return {
    origin: origin.map(round),
    axis: axis.map(round),
    start: start.map(round),
    end: end.map(round),
    radius: round(radius),
    pitch: round(pitch),
    turns: round(turns),
    height: round(height),
    hand,
  }
}

/**
 * The placement of every helix the solve resolved, keyed by feature id. A
 * feature missing from `result` (a shorter solve, a suppressed row) or with no
 * placement (a thrown solve) is left out, the same rule `featureFrames` follows.
 */
export function featureCurves(
  doc: PartDoc | null | undefined,
  result: BuildResponse['result'] | null | undefined,
): FeatureCurveMap {
  const curves: FeatureCurveMap = {}
  if (!doc || !result) return curves
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'helix') continue
    const id = String(feature.id ?? '')
    if (id === '') continue
    const curve = curveOfResult(result[id], feature.helix)
    if (curve !== null) curves[id] = curve
  }
  return curves
}
