// Selecting a mate in the feature tree must highlight the geometry it
// references, exactly as hovering that geometry would. `EntityMateRefs` maps
// entity key -> the mate refs it offers (Stage 7's pick lookup); this is the
// reverse of that lookup, going from a mate's two refs back to whichever
// entity keys resolve to them.
//
// Pure and viewport-free: a mate can name an anchor no longer offered by the
// current bundle (a rebuild dropped it, or the ref was never completed), and
// that ref simply contributes no entity key rather than throwing.

import type { MateFeatureDef, MateRef } from '@/types/cad'
import type { EntityMateRefs } from '@/utils/anchorCandidates'

function sameRef(a: MateRef, b: MateRef): boolean {
  return a.part === b.part && a.anchor === b.anchor
}

// Shared instance for the no-highlight case (no mate selected, or a selected
// mate whose refs are stale/unresolved). Handing back the same reference lets
// a caller's own memoization (AssemblyViewport keys a useMemo on this return
// value) recognize "still nothing to highlight" across a re-solve that
// otherwise hands back a fresh `entityMateRefs` object every time, instead of
// rebuilding the highlight's geometry buffers for no visible change.
const EMPTY_KEYS: ReadonlySet<string> = new Set()

/**
 * The entity keys that draw a mate's highlight: every key in `entityMateRefs`
 * whose ref list contains `ref_a` or `ref_b`. One ref can match several keys
 * (a shared anchor point offered by more than one entity), and a stale or
 * unresolved ref matches none -- both are expected, not errors.
 */
export function entityKeysForMate(
  mate: MateFeatureDef | undefined,
  entityMateRefs: Readonly<EntityMateRefs>,
): ReadonlySet<string> {
  if (!mate) return EMPTY_KEYS
  const out = new Set<string>()
  const refs = [mate.ref_a, mate.ref_b]
  for (const [entityKey, offered] of Object.entries(entityMateRefs)) {
    if (offered.some(o => refs.some(r => sameRef(r, o)))) out.add(entityKey)
  }
  return out.size > 0 ? out : EMPTY_KEYS
}
