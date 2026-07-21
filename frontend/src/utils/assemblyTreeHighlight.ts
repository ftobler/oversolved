// Cross-highlight between the assembly tree's two panes: selecting a part row
// marks the mate rows that reference it, and selecting a mate row marks the two
// part rows it mates. Kept as pure set-computation, no store or React in sight,
// so the relation is unit-testable without a rendered tree.

import type { MateFeature } from '@/types/cad'

/** Every mate id whose ref_a.part or ref_b.part equals the given part handle. */
export function relatedMateIds(mates: MateFeature[], partHandle: string | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (!partHandle) return ids
  for (const { id, mate } of mates) {
    if (mate.ref_a.part === partHandle || mate.ref_b.part === partHandle) ids.add(id)
  }
  return ids
}

/**
 * The part handles a mate references. A self-mate (both refs on the same part)
 * still yields a single-entry set, since the Set dedupes it.
 */
export function relatedPartHandles(mates: MateFeature[], mateId: string | null | undefined): Set<string> {
  const handles = new Set<string>()
  if (!mateId) return handles
  const found = mates.find(m => m.id === mateId)
  if (!found) return handles
  handles.add(found.mate.ref_a.part)
  handles.add(found.mate.ref_b.part)
  return handles
}
