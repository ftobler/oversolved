// The union editor's one list, "Parts to join". A union has no target/tools
// split: the first pick is only the base that keeps the body's id and name, so
// the editor shows the stored target (the base) followed by the tools. The
// document keeps the target + tools shape, unchanged, and no migration runs.

import type { BooleanFeatureDef } from '@/types/cad'

/** The stored keys the list is assembled from; the widget's schema data is an
 *  untyped bag, so the reader accepts the loose shape. */
type JoinFields = Partial<Pick<BooleanFeatureDef, 'target' | 'tools'>>

/** The join list a union picker shows: the base first, then the tool picks. */
export function booleanJoinList(data: JoinFields): string[] {
  const base = typeof data.target === 'string' && data.target !== '' ? [data.target] : []
  const tools = Array.isArray(data.tools)
    ? data.tools.filter((tool): tool is string => typeof tool === 'string' && tool !== '')
    : []
  // A legacy hand-written doc can list the base among the tools; the base is
  // the first entry and the solve refuses a body listed as its own tool, so the
  // duplicate is folded away here.
  return [...new Set([...base, ...tools])]
}

/**
 * What a boolean still needs from the user, in the words its editor uses, or
 * null when the picks are complete. A union's list counts the base and the
 * tools together: the stored target is only the list's first pick, so a
 * lone entry in either key is a list of one. The stored keys never reach the
 * message. An absent operation is the stored default, union; an unknown one
 * still gets its pick check first and then its own refusal from the kernel.
 */
export function booleanPickProblem(
  operation: string | undefined,
  target: string | undefined,
  tools: string[] | undefined,
): string | null {
  if (operation === 'subtract') {
    if (target === undefined || target === '') return 'boolean: pick the target part to subtract from'
    if (tools === undefined || tools.length === 0) return 'boolean: pick at least one tool part to subtract'
    return null
  }
  if (operation === 'intersect') {
    if (target === undefined || target === '') return 'boolean: pick the target part to intersect'
    if (tools === undefined || tools.length === 0) return 'boolean: pick at least one tool part to intersect with'
    return null
  }
  const picks = booleanJoinList({ target: target ?? '', tools })
  if (picks.length === 0) return 'boolean: pick at least two parts to join'
  if (picks.length === 1) return 'boolean: pick at least one more part to join'
  return null
}
