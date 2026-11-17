// The selection entry point: resolve every pick to a world primitive first,
// then count. The count decides the readout, so a pair never silently drops one
// of its picks the way the old routing did (a body id plus a datum plane used to
// measure the body alone, and mixed sketch/body picks measured only one side).
//
//   0 picks          nothing
//   1 pick           measureOne
//   2 picks          measurePair
//   3 or more picks  nothing (D3: no "first two" guess)
//
// A pick that cannot be resolved makes the whole selection unmeasurable rather
// than shrinking it: a three-pick selection with one stale id must not read like
// a genuine two-pick one.
import type { BodyResult, LengthUnit, Sketch } from '@/types/cad'
import {
  isWholeBodySelectionId,
  parseSelectionId,
  parseTopoFallbackQuery,
  stripSelectionWrapper,
} from '@/utils/query/selectionId'
import { bodyPrimitive } from './adapters/body'
import { datumPrimitive } from './adapters/datum'
import { sketchPrimitive } from './adapters/sketch'
import { formatReadouts } from './format'
import { isKernelAsk, measureOne, measurePair, type MeasureResult } from './rules'
import type { Primitive } from './primitives'

export interface MeasureContext {
  /** The flat sketch a sketch-edit caller already narrowed to its feature. The
   *  per-feature solve result wins when present. */
  sketch?: Sketch
  /** Solve results keyed by feature id: sketch `solved` + `plane`, and a datum
   *  plane's `plane`. */
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
  unit?: LengthUnit
}

function resolvePick(id: string, ctx: MeasureContext): Primitive | null {
  try {
    if (id.startsWith('entity:') || id.startsWith('vertex:')) {
      const parsed = parseSelectionId(id)
      if (parsed.kind === 'entity') {
        return sketchPrimitive(
          { featureId: parsed.featureId, eid: parsed.eid },
          ctx.sketch,
          ctx.solveResults,
        )
      }
      if (parsed.kind === 'vertex') {
        return sketchPrimitive(
          { featureId: parsed.featureId, eid: parsed.eid, sub: parsed.sub },
          ctx.sketch,
          ctx.solveResults,
        )
      }
      return null
    }

    // A parts-list whole-body pick has no analytic rule; it is a kernel cell and
    // still a resolved pick, so it counts toward the selection size.
    if (isWholeBodySelectionId(id)) return { type: 'solid', bodyId: id.slice(1) }

    if (id.startsWith('face:') || id.startsWith('edge:')) {
      return bodyPrimitive(stripSelectionWrapper(id), ctx.bodies)
    }
    if (id.startsWith('?') || parseTopoFallbackQuery(id) !== null) {
      return bodyPrimitive(id, ctx.bodies)
    }
    if (id.startsWith('@')) return datumPrimitive(id.slice(1), ctx.solveResults)
    return null
  } catch {
    // A malformed id is an unresolvable pick, not a crash in the viewport HUD.
    return null
  }
}

/** The HUD lines for a selection: zero, one or two readable measurements. */
export function measureSelection(selection: ReadonlySet<string>, ctx: MeasureContext = {}): string[] {
  const primitives: Primitive[] = []
  for (const id of selection) {
    const primitive = resolvePick(id, ctx)
    if (!primitive) return []
    primitives.push(primitive)
  }
  if (primitives.length === 0 || primitives.length > 2) return []

  const result: MeasureResult = primitives.length === 1
    ? measureOne(primitives[0])
    : measurePair(primitives[0], primitives[1])
  // A kernel cell reads nothing until the measure-kernel-pairs follow-up lands.
  if (result == null || isKernelAsk(result)) return []
  return formatReadouts(result, ctx.unit)
}
