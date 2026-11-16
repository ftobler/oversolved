import type { BodyResult } from '@/types/cad'
import { resolveBodyIds } from '@/kernel/features/shared/bodyResolution'

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
  if (!query) return []
  // Shared with the kernel's `resolveBodyIds` (kernel/features/shared/
  // bodyResolution.ts) so the chip's body resolution cannot drift from the
  // solve's. The kernel resolver is pure store lookup with no OCC, so
  // importing it here is safe.
  return resolveBodyIds(query, (bodies ?? {}) as Record<string, { created_by: string }>)
}

export function bodyIdOfPick(
  query: string,
  bodies: Record<string, BodyResult> | null | undefined,
): string | null {
  const ids = bodyIdsOfPick(query, bodies)
  return ids.length === 1 ? ids[0] : null
}
