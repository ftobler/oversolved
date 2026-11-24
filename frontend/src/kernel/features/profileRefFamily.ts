// One family split for profile refs. The pick gate and the build both read it,
// so the chip cannot accept a sketch area the build will throw out as a part
// face (or the other way round). Pure: no OCC and no solve, only the id shape.

import { parseAncestry } from '../query'
import { isEdgeRestriction, isFaceRestriction } from '../faceTypes'
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
// A picked part element carries a body tag or a face/edge token in the ancestry,
// never just a `@body_` substring: queryLabel's legacy forms glue the index to
// the feature id (`@extrude1face0`), and the slash forms name it after a slash
// (`@body_ex1/face0`, `@extrude1/face/3`).
const PART_TAG = /@body_/
const LEGACY_PART_ELEMENT = /@[-\w]+?(?:face|edge)\d+/
const SLASH_PART_ELEMENT = /@[-\w]+\/(?:face|tri|edge|straightedge)\d*(?:\/\d+)?/
// A sketch area is a surface of a drawn region: its ancestry carries the
// `surface:N` marker and `@<sketch>/<entity>` tokens. Builtin planes and datum
// origins are not part faces either. The checks run on the raw wire string so a
// hand-written query whose framing is off still classifies by its token shapes.
const SKETCH_SURFACE = /surface:\d+/
const SKETCH_ENTITY = /@[-\w]+\/[^@:]+/
const BUILTIN_TAG = /@builtin_/
const RAW_RESTRICTION = /:([a-z]+)(?:@[^:]*)?$/

function restrictionOf(refStr: string): string | null {
  try {
    const [, kind] = parseAncestry(refStr)
    if (kind !== null) return kind
  } catch {
    // A malformed framing still has a readable tail restriction.
  }
  return RAW_RESTRICTION.exec(refStr)?.[1] ?? null
}

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
 * query (named, legacy or topo fallback) is `part`. A body tag or a face/edge
 * token names a part element even without a `body_` token; a face or edge
 * restriction with only non-sketch lineage does the same. Sketch areas carry a
 * `surface:N` marker and `@<sketch>/<entity>` tokens, so those stay on the
 * loop path the build takes. No geometry is read at pick time.
 */
export function profileRefFamily(refStr: string): ProfileRefFamily {
  refStr = wireRef(refStr)
  if (isEdgeProfileRef(refStr)) return 'part'
  if (refStr.startsWith('entity:') || refStr.startsWith('vertex:') || refStr.startsWith('$')) return 'sketch'
  if (refStr.startsWith('?')) {
    if (PART_TAG.test(refStr) || LEGACY_PART_ELEMENT.test(refStr) || SLASH_PART_ELEMENT.test(refStr)) return 'part'
    const kind = restrictionOf(refStr)
    if (kind !== null && (isFaceRestriction(kind) || isEdgeRestriction(kind))) {
      if (BUILTIN_TAG.test(refStr) || SKETCH_SURFACE.test(refStr) || SKETCH_ENTITY.test(refStr)) return 'sketch'
      return 'part'
    }
    return 'sketch'
  }
  if (refStr.startsWith('@')) {
    const [owner, member] = refStr.slice(1).split('/')
    if (owner.startsWith('body_')) return 'part'
    if (member !== undefined && /^(?:face|tri|edge|straightedge)(?:\/\d+)?$/.test(member)) return 'part'
    return 'sketch'
  }
  return 'sketch'
}

/** True when a face pick's own query says the surface is not a plane. */
export function isNonPlanarProfileFace(refStr: string): boolean {
  refStr = wireRef(refStr)
  if (!refStr.startsWith('?')) return false
  const kind = restrictionOf(refStr)
  // A plain `:face` carries no surface kind, so its planarity is a solve
  // fact; only an explicit curved kind can be refused from the id alone.
  return kind !== null && CURVED_FACE_KINDS.has(kind)
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
