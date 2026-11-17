// The assembly's measurement readout, computed off the solved anchor table and
// rendered through the one shared measurement core.
//
// The part editor measures sketch entities and B-rep queries; an assembly does
// not carry `face_data`, only the anchor the solve placed at each pickable
// entity. So each pick resolves through the same lookup the mate pick uses into
// a world primitive (adapters/anchor), then `utils/measure/rules` answers the
// pair exactly as it does for a part. The formatter is the part's too, so the
// assembly no longer reads 2 decimals in a hardcoded mm while the part reads 3
// decimals in the document unit.
//
// Pure: no three.js, no store, no ID buffer.
import { lookupAnchor, type AnchorTable } from '@/utils/anchorGizmos'
import type { EntityMateRefs } from '@/utils/anchorCandidates'
import { anchorPrimitive } from './measure/adapters/anchor'
import { formatReadouts } from './measure/format'
import { isKernelAsk, measurePair } from './measure/rules'
import type { Primitive } from './measure/primitives'

/** Resolve one selected entity key to its primary anchor's primitive. */
function primitiveForEntity(
  entityKey: string,
  entityMateRefs: Readonly<EntityMateRefs>,
  anchors: Readonly<AnchorTable>,
): Primitive | null {
  const ref = entityMateRefs[entityKey]?.[0]
  if (!ref) return null
  const anchor = lookupAnchor(anchors, ref)
  return anchor ? anchorPrimitive(anchor) : null
}

/**
 * The measurement lines for the current assembly selection.
 *
 * Exactly two resolved picks are measured. An assembly anchor carries no radius,
 * length or area, so a single pick has nothing to state (D2), and three or more
 * picks would be a "first two" guess (D3, matching the part editor). A pick that
 * does not resolve makes the selection unmeasurable rather than shrinking it.
 */
export function computeAssemblyMeasurements(
  selection: ReadonlySet<string>,
  entityMateRefs: Readonly<EntityMateRefs>,
  anchors: Readonly<AnchorTable>,
): string[] {
  const primitives: Primitive[] = []
  for (const key of selection) {
    const primitive = primitiveForEntity(key, entityMateRefs, anchors)
    if (!primitive) return []
    primitives.push(primitive)
    if (primitives.length > 2) return []
  }
  if (primitives.length !== 2) return []
  const result = measurePair(primitives[0], primitives[1])
  if (result == null || isKernelAsk(result)) return []
  // An assembly document has no length unit; its frame and every anchor are
  // millimetres.
  return formatReadouts(result, 'mm')
}
