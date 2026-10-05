// Reference parsing shared by the leaf feature solvers: surface ancestry ids
// and viewport sketch picks. Pure, no OCC.

import { parseAncestry, type Repository } from '../../query'

type Dict = Record<string, unknown>

/**
 * Sorted, deduped entity ids referenced by a surface's ancestry query, or `[]`
 * if the query is absent/non-ancestry/unparsable. Dedup mirrors Python's
 * frozenset, since parseAncestry can repeat ids.
 */
export function surfaceEntityIds(surface: Dict): string[] {
  const query = (surface.query as string) ?? ''
  if (!query.startsWith('?')) return []
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return []
  }
  return [...new Set(ids.filter((i) => i.startsWith('@') && i.includes('/')))].sort()
}

/**
 * Split a viewport sketch pick (`entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>`) into the sketch and the entity it names.
 * Returns null for every other ref form (`$sketch`, `@feat/...`, `?...`).
 *
 * These are selection ids, not queries: the viewport toggles them into
 * `normalSelection` verbatim and the pick chips persist them unchanged (a
 * rewritten value would no longer match the re-click that unpicks it), so the
 * feature leaves have to understand the raw form. A `vertex:` pick names the
 * entity that owns the vertex, which is what both the sweep path and the
 * profile paths want from it.
 */
export function parseSketchEntityRef(ref: string): { sketchId: string; eid: string } | null {
  if (!ref.startsWith('entity:') && !ref.startsWith('vertex:')) return null
  const parts = ref.split(':')
  const sketchId = parts[1] ?? ''
  const eid = parts[2] ?? ''
  if (!sketchId || !eid) return null
  return { sketchId, eid }
}

/**
 * Sketch a `?...` ancestry query is drawn on: the first ancestor token that
 * names a registered sketch plane (`_pt_<id>`). An area pick carries its sketch
 * as a bare `@<sketchId>` token beside the `@<sketchId>/<eid>` tokens that name
 * the curves bounding it, so the plane registry is what tells the two apart.
 * Returns null when no token names a sketch (a body-face query, say).
 */
export function sketchIdFromQuery(query: string, globalRepo: Repository): string | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  for (const id of ids) {
    if (!id.startsWith('@') || id.includes('/')) continue
    const candidate = id.slice(1)
    if (globalRepo.elements.get('_pt_' + candidate) !== undefined) return candidate
  }
  return null
}

/**
 * The one entity of `sketchId` a sketch-area query is bounded by, or null when
 * it names none or several. A click on the fill inside a lone circle and a click
 * on the circle itself are the same gesture as far as a feature is concerned, so
 * this is what lets the area form answer like the `entity:` form; a region
 * bounded by four lines names four entities and gets no single answer.
 */
export function soleEntityInQuery(query: string, sketchId: string): string | null {
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  const prefix = '@' + sketchId + '/'
  const named = [...new Set(ids.filter((i) => i.startsWith(prefix)))]
  return named.length === 1 ? named[0].slice(prefix.length) : null
}
