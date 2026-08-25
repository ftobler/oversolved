// Pure read planning for the rubber-band commit's GPU readback.
//
// Crossing selection is exact only if every pixel of the band rect is seen,
// but a native-resolution read of a near-full-pane HiDPI rect is tens of MB
// allocated, copied and stalled inside one task. The plan keeps the reads
// bounded instead: while the rect fits the budget it is one read; past that
// it becomes fixed-height full-width chunks executed through a reused scratch
// buffer. Every pixel is still visited exactly once, so the collected set is
// identical to what the old single-read-plus-flip produced; only the working
// set shrank.

export interface BandReadRect {
  // Offsets relative to the band rect's top-left corner, in target pixels.
  x: number
  y: number
  w: number
  h: number
}

// 512x512 px = 1 MiB of RGBA: larger than any ordinary selection box, so the
// common case stays a single read.
export const BAND_READ_BUDGET_PIXELS = 262144

// Rows per chunk once the budget is exceeded. Caps the scratch buffer at
// 256 * w * 4 bytes (about 5 MB against a 5120-wide HiDPI target) where the
// old path held the full rect twice over.
export const BAND_CHUNK_ROWS = 256

export function planBandReads(w: number, h: number): BandReadRect[] {
  if (w <= 0 || h <= 0) return []
  if (w * h <= BAND_READ_BUDGET_PIXELS) return [{ x: 0, y: 0, w, h }]
  const rects: BandReadRect[] = []
  for (let y = 0; y < h; y += BAND_CHUNK_ROWS) {
    rects.push({ x: 0, y, w, h: Math.min(BAND_CHUNK_ROWS, h - y) })
  }
  return rects
}
