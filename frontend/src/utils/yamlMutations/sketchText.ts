// The sketch lettering writer: one mutation expands a string into authored
// line and spline entities, so a whole run is one undo entry and every glyph
// edge is editable by the existing tools. No constraint is added; the solver
// leaves the outlines where they were authored, and a later extrude fills the
// glyph loops even-odd, counters included.

import type { PartDoc } from '@/types/cad'
import { expandText, textFieldsProblem } from '@/utils/geometry/textExpand'
import type { TextAlign } from '@/utils/geometry/textExpand'
import { MAX_SKETCH_ENTITIES } from '@/utils/geometry/sketchPattern'
import { findSketchFeature, freshEntityIds, resolveSketch, round, warn } from './helpers'

export interface AddTextFields {
  text: string
  origin?: [number, number]
  size?: number
  angle?: number
  align?: TextAlign
}

type Pair = [number, number]
type TextRow = ['line' | 'spline', number[]]

function roundPair(p: Pair): Pair {
  return [round(p[0]), round(p[1])]
}

function samePair(a: Pair, b: Pair): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

/** The `[kind, params]` rows of the whole run, rounded and chained: each
 *  segment starts at the previous segment's stored end pair, and each
 *  contour's last end is its stored start pair, so every loop closes by
 *  identical coordinates instead of two separately rounded ones. A segment
 *  whose stored end equals its start is dropped rather than stored degenerate,
 *  and so is a contour rounding left as fewer than three lines: two lines
 *  there and back enclose nothing and would hand the profile builder a
 *  zero-area loop. Dropping a segment never opens a loop, since the last one
 *  is pinned to the start. */
export function textEntityRows(fields: AddTextFields): TextRow[] {
  const rows: TextRow[] = []
  for (const contour of expandText(fields.text, fields)) {
    const start = roundPair(contour.start)
    const contourRows: TextRow[] = []
    let prev = start
    contour.segments.forEach((segment, i) => {
      const last = i === contour.segments.length - 1
      const points = segment.points.map(roundPair)
      if (last) points[points.length - 1] = start
      const end = points[points.length - 1]
      if (samePair(prev, end)) return
      contourRows.push([segment.kind, [...prev, ...points.flat()]])
      prev = end
    })
    const collapsed = contourRows.length < 3 && contourRows.every(([kind]) => kind === 'line')
    if (!collapsed) rows.push(...contourRows)
  }
  return rows
}

/** The rows one add_text step writes into a sketch already holding
 *  `holding` entities, or why it writes none. The drive value rule and the
 *  applier both call it, so a direct dispatch refuses exactly what the drive
 *  refuses. A run that draws nothing (only spaces, or a size so small every
 *  segment rounds away) is refused: it would otherwise land as an undo entry
 *  that changes nothing. */
export function planAddText(fields: AddTextFields, holding: number): { rows: TextRow[] } | { reason: string } {
  const problem = textFieldsProblem(fields)
  if (problem !== null) return { reason: problem }
  const rows = textEntityRows(fields)
  if (rows.length === 0) {
    return { reason: `text ${JSON.stringify(fields.text)} draws no outline at size ${fields.size ?? 'default'}; `
      + 'it is only spaces, or every glyph rounds away at the 1e-6 stored precision' }
  }
  if (holding + rows.length > MAX_SKETCH_ENTITIES) {
    return { reason: `would add ${rows.length} entities to the ${holding} already in the sketch; `
      + `the sketch holds at most ${MAX_SKETCH_ENTITIES}` }
  }
  return { rows }
}

/** How many entities the named sketch holds, for the sketch-wide cap; zero
 *  for a sketch that does not exist (the caller refuses that separately). */
export function sketchEntityCount(doc: PartDoc, featureId: string): number {
  return findSketchFeature(doc, featureId)?.entities?.length ?? 0
}

export function applyAddText(doc: PartDoc, featureId: string, fields: AddTextFields): void {
  // Plan before resolving the sketch, so a refused run does not even create
  // the empty entity containers.
  if (!findSketchFeature(doc, featureId)) return
  const plan = planAddText(fields, sketchEntityCount(doc, featureId))
  if ('reason' in plan) {
    // The drive value rule reports the refusal before dispatch; a direct
    // internal caller gets a loud no-op instead of a partial run.
    warn('applyAddText: refusing text', plan.reason)
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return
  // One mint for the whole run: a per-entity mint re-walks the live list and
  // goes quadratic over a name tag's few hundred entities.
  const ids = freshEntityIds(feature.entities, plan.rows.length)
  plan.rows.forEach(([kind, params], i) => {
    feature.entities.push({ id: ids[i], kind })
    feature.initial[ids[i]] = params
  })
}
