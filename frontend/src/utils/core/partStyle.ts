// The solve-time part_style reconcile, pure so the node CLI and the write-back
// test can run it without React. useSolver re-exports both functions; the hook
// itself only calls reconcilePartStyle from its applied-solve path.

import type { PartDoc, PartResult, PartStyleEntry } from '@/types/cad'
import { PART_COLOR_PALETTE } from '@/utils/core/partColors'

export function pickPartColor(partNumber: number): string {
  return PART_COLOR_PALETTE[(partNumber - 1) % PART_COLOR_PALETTE.length]
}

export function reconcilePartStyle(doc: PartDoc, parts: Record<string, PartResult> | undefined): void {
  const partIds = Object.keys(parts ?? {})
  if (partIds.length === 0) return

  const style = doc.part_style ?? {}
  const usedPartNumbers = new Set<number>()
  for (const entry of Object.values(style)) {
    const match = /^part (\d+)$/i.exec(entry?.name ?? '')
    if (match) usedPartNumbers.add(Number(match[1]))
  }

  const nextStyle: Record<string, PartStyleEntry> = { ...style }
  let nextPartNumber = 1
  const nextFreePartNumber = () => {
    while (usedPartNumbers.has(nextPartNumber)) nextPartNumber += 1
    usedPartNumbers.add(nextPartNumber)
    return nextPartNumber++
  }

  for (const partId of partIds) {
    // An existing entry is never touched, so a colour the user picked (or the
    // file colour an earlier solve seeded) survives every re-solve, including
    // one after the import's file bytes were replaced.
    if (nextStyle[partId]) continue
    const partNumber = nextFreePartNumber()
    const part = parts?.[partId]
    nextStyle[partId] = {
      name: `part ${partNumber}`,
      // A STEP import seeds the colour its file gives the part; the palette
      // is the fallback for a modelled part and an uncoloured file.
      color: part?.import_color ?? pickPartColor(partNumber),
      created_by: part?.created_by,
    }
  }

  doc.part_style = nextStyle
}
