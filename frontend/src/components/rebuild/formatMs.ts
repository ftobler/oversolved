// Format a millisecond duration for rebuild timing display: sub-second values
// stay in ms, anything longer is shown as seconds with two decimals.
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
