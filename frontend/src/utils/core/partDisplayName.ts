// One naming source for the "part N" fallback. `part_style` mints `part N` from
// the first free number, skipping numbers already taken by renamed or surviving
// parts; the Parts list, the chip, the context menu and the export dialog all
// used to recompute that fallback differently (list position, raw id, index+1),
// which disagreed once a body was deleted. This helper mints the same number
// the solve-time reconcile in partStyle.ts would, by walking `orderedBodyIds`
// in store order and skipping numbers already claimed by `partLabels`.

export function partDisplayName(
  partId: string,
  partLabels: Record<string, string> | null | undefined,
  orderedPartIds: readonly string[] = [],
): string {
  const labels = partLabels ?? {}
  const trimmed = labels[partId]?.trim()
  if (trimmed) return trimmed

  const used = new Set<number>()
  for (const label of Object.values(labels)) {
    const m = /^part (\d+)$/i.exec((label ?? '').trim())
    if (m) used.add(Number(m[1]))
  }

  // Walk the ordered body ids so a body with no label is minted the same
  // number partStyle.ts would give it at that position. Bodies not in the list
  // (a stale ref) get the next free number.
  let result: string | null = null
  const seen = new Set(orderedPartIds)
  const order = seen.has(partId) ? [...orderedPartIds] : [...orderedPartIds, partId]
  for (const id of order) {
    const existing = labels[id]?.trim()
    if (existing) {
      const m = /^part (\d+)$/i.exec(existing)
      if (m) used.add(Number(m[1]))
      if (id === partId) { result = existing; break }
      continue
    }
    let n = 1
    while (used.has(n)) n++
    used.add(n)
    const name = `part ${n}`
    if (id === partId) { result = name; break }
  }
  if (result) return result

  // bodyId was not walked (empty order): mint the first free number.
  let n = 1
  while (used.has(n)) n++
  return `part ${n}`
}
