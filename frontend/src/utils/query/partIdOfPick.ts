import type { PartResult } from '@/types/cad'
import { resolvePartIds } from '@/kernel/features/shared/partResolution'

// UI-side twin of the kernel's `resolvePartIds` (kernel/features/shared/
// partResolution.ts), operating on the plain `BodyResult` records the store
// publishes (`usePartEditorStore.bodies`) instead of the kernel's `Body`
// objects. The kernel resolver is not imported here: it lives behind the OCC
// kernel, and this module must stay free of it.
//
// Returns every body id a pick resolves to (possibly several, when a bare
// feature ref names a feature that made more than one body). `bodyIdOfPick`
// narrows that to a single id or null, which is what a chip that names one
// part needs; a feature owning several bodies has no single part and the
// chip falls back to the feature label plus its count.

export function partIdsOfPick(
  query: string,
  parts: Record<string, PartResult> | null | undefined,
): string[] {
  if (!query) return []
  // Shared with the kernel's `resolvePartIds` (kernel/features/shared/
  // partResolution.ts) so the chip's body resolution cannot drift from the
  // solve's. The kernel resolver is pure store lookup with no OCC, so
  // importing it here is safe.
  return resolvePartIds(query, (parts ?? {}) as Record<string, { created_by: string }>)
}

export function partIdOfPick(
  query: string,
  parts: Record<string, PartResult> | null | undefined,
): string | null {
  const ids = partIdsOfPick(query, parts)
  return ids.length === 1 ? ids[0] : null
}
