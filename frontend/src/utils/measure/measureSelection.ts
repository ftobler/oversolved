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
//
// A cell the pair table marks `kernel` leaves here as an ASK: the picks in the
// form the solver Worker resolves them, so the HUD can send one request. The
// ask is only made when every pick is a body element or a whole body; a sketch
// entity or a datum plane against a freeform pick has no OCC shape to measure,
// so it still reads nothing.
import type { PartResult, LengthUnit, Sketch } from '@/types/cad'
import {
  isWholePartSelectionId,
  parseSelectionId,
  parseTopoFallbackQuery,
  stripSelectionWrapper,
} from '@/utils/query/selectionId'
import type { MeasureOp, MeasurePickRef } from '@/kernel/worker/solverProtocol'
import { partPickRef, partPrimitive } from './adapters/part'
import { datumPrimitive } from './adapters/datum'
import { sketchPrimitive } from './adapters/sketch'
import { formatReadouts } from './format'
import { isKernelAsk, measureOne, measurePair, type MeasureResult, type Readout } from './rules'
import type { Primitive } from './primitives'

export interface MeasureContext {
  /** The flat sketch a sketch-edit caller already narrowed to its feature. The
   *  per-feature solve result wins when present. */
  sketch?: Sketch
  /** Solve results keyed by feature id: sketch `solved` + `plane`, and a datum
   *  plane's `plane`. */
  solveResults?: Record<string, unknown>
  parts?: Record<string, PartResult>
  unit?: LengthUnit
}

/** The kernel cell a selection asks for: the op and the picks it names. */
export interface KernelMeasureAsk {
  op: MeasureOp
  picks: MeasurePickRef[]
}

export interface SelectionMeasurement {
  // The lines the sync readout renders: empty for a kernel cell.
  lines: string[]
  // The kernel question, or null when the sync readout answered (or nothing
  // could be asked safely).
  ask: KernelMeasureAsk | null
}

/** The core's answer before formatting: the analytic readout, or the kernel
 *  question, or neither. */
export interface SelectionReadout {
  readout: Readout | null
  ask: KernelMeasureAsk | null
}

interface ResolvedPick {
  primitive: Primitive
  // How the kernel names this pick, when it names a body element at all.
  ref: MeasurePickRef | null
}

function resolvePick(id: string, ctx: MeasureContext): ResolvedPick | null {
  try {
    if (id.startsWith('entity:') || id.startsWith('vertex:')) {
      const parsed = parseSelectionId(id)
      if (parsed.kind === 'entity') {
        const primitive = sketchPrimitive(
          { featureId: parsed.featureId, eid: parsed.eid },
          ctx.sketch,
          ctx.solveResults,
        )
        return primitive ? { primitive, ref: null } : null
      }
      if (parsed.kind === 'vertex') {
        const primitive = sketchPrimitive(
          { featureId: parsed.featureId, eid: parsed.eid, sub: parsed.sub },
          ctx.sketch,
          ctx.solveResults,
        )
        return primitive ? { primitive, ref: null } : null
      }
      return null
    }

    // A parts-list whole-body pick has no analytic rule; it is a kernel cell and
    // still a resolved pick, so it counts toward the selection size.
    if (isWholePartSelectionId(id)) {
      const partId = id.slice(1)
      return { primitive: { type: 'solid', partId }, ref: { bodyId: partId, kind: 'body' } }
    }

    if (id.startsWith('face:') || id.startsWith('edge:')) {
      const query = stripSelectionWrapper(id)
      const primitive = partPrimitive(query, ctx.parts)
      const ref = partPickRef(query, ctx.parts)
      return primitive ? { primitive, ref } : null
    }
    if (id.startsWith('?') || parseTopoFallbackQuery(id) !== null) {
      const primitive = partPrimitive(id, ctx.parts)
      const ref = partPickRef(id, ctx.parts)
      return primitive ? { primitive, ref } : null
    }
    if (id.startsWith('@')) {
      const primitive = datumPrimitive(id.slice(1), ctx.solveResults)
      return primitive ? { primitive, ref: null } : null
    }
    return null
  } catch {
    // A malformed id is an unresolvable pick, not a crash in the viewport HUD.
    return null
  }
}

const NOTHING: SelectionReadout = { readout: null, ask: null }

/**
 * The selection's measurement before formatting: the analytic readout when the
 * pair table answers, or the kernel question it asks instead. The ask names the
 * pick of every side: a kernel cell whose picks are not all body elements (a
 * datum plane or a sketch entity against a freeform face, K3) answers nothing
 * rather than measuring a made-up shape.
 */
export function measureSelectionResolved(
  selection: ReadonlySet<string>,
  ctx: MeasureContext = {},
): SelectionReadout {
  const picks: ResolvedPick[] = []
  for (const id of selection) {
    const pick = resolvePick(id, ctx)
    if (!pick) return NOTHING
    picks.push(pick)
  }
  if (picks.length === 0 || picks.length > 2) return NOTHING

  const result: MeasureResult = picks.length === 1
    ? measureOne(picks[0].primitive)
    : measurePair(picks[0].primitive, picks[1].primitive)
  if (result == null) return NOTHING
  if (!isKernelAsk(result)) return { readout: result, ask: null }

  const refs = picks.map((pick) => pick.ref)
  if (refs.some((ref) => ref === null)) return NOTHING
  // One pick for a length, two for a distance or a clearance: the same count
  // the sync readout counted.
  if (result.kernel === 'length' ? picks.length !== 1 : picks.length !== 2) {
    return { readout: null, ask: null }
  }
  return { readout: null, ask: { op: result.kernel, picks: refs as MeasurePickRef[] } }
}

/** The selection's readout lines, plus the kernel question when the pair table
 *  asks for one. */
export function measureSelectionPicks(
  selection: ReadonlySet<string>,
  ctx: MeasureContext = {},
): SelectionMeasurement {
  const { readout, ask } = measureSelectionResolved(selection, ctx)
  return { lines: readout === null ? [] : formatReadouts(readout, ctx.unit), ask }
}

/** The HUD lines for a selection: zero, one or two readable measurements. */
export function measureSelection(selection: ReadonlySet<string>, ctx: MeasureContext = {}): string[] {
  return measureSelectionPicks(selection, ctx).lines
}
