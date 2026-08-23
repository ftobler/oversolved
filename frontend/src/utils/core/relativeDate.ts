// Compact "how long ago" label for document tiles: seconds/minutes/hours for
// the recent past, then a plain calendar date. Shared by the documents grid
// and the insert-part browser.
export function formatRelativeDate(isoString: string): string {
  if (!isoString) return ''
  const date = new Date(isoString)
  const time = date.getTime()
  // A malformed isoString parses to NaN; some Intl/date formatting paths
  // throw a RangeError on that instead of degrading gracefully, so bail
  // before it ever reaches arithmetic or formatting below.
  if (!Number.isFinite(time)) return ''
  // Clamp so a future timestamp (clock skew, optimistic local edit) reads as
  // "just now" instead of a nonsensical negative duration like "-5s ago".
  const diffMs = Math.max(0, Date.now() - time)
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}min ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
