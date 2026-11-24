// One family split for profile refs. The pick gate and the build both read it,
// so the chip cannot accept a sketch area the build will throw out as a part
// face (or the other way round). Pure: no OCC and no solve, only the id shape.

import { parseAncestry } from '../query'
import { stripSelectionWrapper } from '@/utils/query/selectionId'

export type ProfileRefFamily = 'sketch' | 'part'

/** The wire query behind a selection id, so a wrapped face pick classifies the
 *  same as the query the chip will store. */
function wireRef(refStr: string): string {
  try {
    return stripSelectionWrapper(refStr)
  } catch {
    return refStr
  }
}

const EDGE_KINDS = /^(?:straight)?edge$/
const CURVED_FACE_KINDS = new Set(['cylinderface', 'coneface', 'sphereface', 'torusface'])
const PART_TOKEN = /@body_[^@:;,/]+/
const PART_MEMBER = /^(?:face|tri|edge|straightedge)(?:\/\d+)?$/

/**
 * True for a profile ref that addresses a B-rep edge: the ancestry forms carry
 * an `edge`/`straightedge` restriction, and `?body_x:edge:N` is the index alias
 * buildEdgeIndex registers. Moved here from edgeProfile so this predicate and
 * the family classifier cannot drift apart; edgeProfile re-exports it.
 */
export function isEdgeProfileRef(refStr: string): boolean {
  refStr = wireRef(refStr)
  if (!refStr.startsWith('?')) return false
  if (/:(?:straight)?edge:\d+$/.test(refStr)) return true
  try {
    const [, kind] = parseAncestry(refStr)
    return kind !== null && EDGE_KINDS.test(kind)
  } catch {
    return false
  }
}

/**
 * Which side of the profile split a ref lands on. A whole sketch, a `?` sketch
 * area and a viewport entity/vertex pick are `sketch`; a part face or edge
 * query (named or topo fallback) is `part`. A `?` area names its sketch as a
 * bare ancestor token, while a picked face carries a body id, so one token is
 * enough to tell them apart without geometry.
 */
export function profileRefFamily(refStr: string): ProfileRefFamily {
  refStr = wireRef(refStr)
  if (isEdgeProfileRef(refStr)) return 'part'
  if (refStr.startsWith('entity:') || refStr.startsWith('vertex:') || refStr.startsWith('$')) return 'sketch'
  if (refStr.startsWith('?')) return PART_TOKEN.test(refStr) ? 'part' : 'sketch'
  if (refStr.startsWith('@')) {
    const [owner, member] = refStr.slice(1).split('/')
    if (owner.startsWith('body_')) return 'part'
    if (member !== undefined && PART_MEMBER.test(member)) return 'part'
    return 'sketch'
  }
  return 'sketch'
}

/** True when a face pick's own query says the surface is not a plane. */
export function isNonPlanarProfileFace(refStr: string): boolean {
  refStr = wireRef(refStr)
  if (!refStr.startsWith('?')) return false
  try {
    const [, kind] = parseAncestry(refStr)
    // A plain `:face` carries no surface kind, so its planarity is a solve
    // fact; only an explicit curved kind can be refused from the id alone.
    return kind !== null && CURVED_FACE_KINDS.has(kind)
  } catch {
    return false
  }
}

/** True when a document's stored profile list spans both families. */
export function mixedProfileRefs(refs: readonly string[]): boolean {
  let sketch = false
  let part = false
  for (const refStr of refs) {
    if (profileRefFamily(refStr) === 'part') part = true
    else sketch = true
  }
  return sketch && part
}
