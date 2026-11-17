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
