// The solve-time part_style reconcile, pure so the node CLI and the write-back
// test can run it without React. useSolver re-exports both functions; the hook
// itself only calls reconcilePartStyle from its applied-solve path.

import type { PartDoc, BodyResult, PartStyleEntry } from '@/types/cad'
import { PART_COLOR_PALETTE } from '@/utils/core/partColors'

export function pickPartColor(partNumber: number): string {
  return PART_COLOR_PALETTE[(partNumber - 1) % PART_COLOR_PALETTE.length]
}

export function reconcilePartStyle(doc: PartDoc, parts: Record<string, BodyResult> | undefined): void {
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
    if (nextStyle[partId]) continue
    const partNumber = nextFreePartNumber()
    const createdBy = parts?.[partId]?.created_by
    nextStyle[partId] = {
      name: `part ${partNumber}`,
      color: pickPartColor(partNumber),
      created_by: createdBy,
    }
  }

  doc.part_style = nextStyle
}
