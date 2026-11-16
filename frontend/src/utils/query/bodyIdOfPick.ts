import type { BodyResult } from '@/types/cad'
import { parseAncestry } from '@/kernel/queryWire'

// UI-side twin of the kernel's `resolveBodyIds` (kernel/features/shared/
// bodyResolution.ts), operating on the plain `BodyResult` records the store
// publishes (`usePartEditorStore.bodies`) instead of the kernel's `Body`
// objects. The kernel resolver is not imported here: it lives behind the OCC
// kernel, and this module must stay free of it.
//
// Returns every body id a pick resolves to (possibly several, when a bare
// feature ref names a feature that made more than one body). `bodyIdOfPick`
// narrows that to a single id or null, which is what a chip that names one
// part needs; a feature owning several bodies has no single part and the
// chip falls back to the feature label plus its count.

export function bodyIdsOfPick(
  query: string,
  bodies: Record<string, BodyResult> | null | undefined,
): string[] {
  const store = bodies ?? {}
  if (!query) return []

  const key = query.startsWith('@') ? query.slice(1) : query

  // Exact body id: names exactly that one sibling.
  if (key in store) return [key]

  // Topo-fallback element ref (`@body_x/face/N`, edge/vertex too): the body
  // the element sits on.
  const topo = /^@([^/]+)\/(?:face|edge|vertex)\/\d+$/.exec(query)
  if (topo) return bodyIdsOfPick(topo[1], store)

  // `?` ancestry query: body-exact, the first `@body_*` ancestor is the owner.
  if (query.startsWith('?')) {
    try {
      const [ids] = parseAncestry(query)
      for (const aid of ids) {
        if (aid.startsWith('@body_') && aid.slice(1) in store) return [aid.slice(1)]
      }
    } catch {
      // unparseable query names nothing
    }
    return []
  }

  // Otherwise the ref names a FEATURE. The creator scan comes first: a body
  // literally called `body_<feature>` would otherwise hide the siblings.
  const byCreator = Object.keys(store).filter((bid) => store[bid].created_by === key)
  if (byCreator.length > 0) return byCreator
  const prefixed = 'body_' + key
  if (prefixed in store) return [prefixed]
  return []
}

export function bodyIdOfPick(
  query: string,
  bodies: Record<string, BodyResult> | null | undefined,
): string | null {
  const ids = bodyIdsOfPick(query, bodies)
  return ids.length === 1 ? ids[0] : null
}
