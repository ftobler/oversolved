/**
 * Unit tests for the rubber-band commit's read planner. The commit must stay
 * exact (every pixel of the band visited exactly once) while bounding its
 * working set: one read under the budget, fixed-height chunks past it.
 */
import { describe, it, expect } from 'vitest'
import { planBandReads, BAND_READ_BUDGET_PIXELS, BAND_CHUNK_ROWS } from '../bandReadPlan'

describe('planBandReads', () => {
  it('plans a single exact read for an empty rect budget fit', () => {
    expect(planBandReads(0, 100)).toEqual([])
    expect(planBandReads(100, 0)).toEqual([])
  })

  it('plans one full-rect read while the rect fits the budget', () => {
    const side = Math.sqrt(BAND_READ_BUDGET_PIXELS)  // 512: fits exactly
    expect(planBandReads(side, side)).toEqual([{ x: 0, y: 0, w: side, h: side }])
    expect(planBandReads(90, 90)).toEqual([{ x: 0, y: 0, w: 90, h: 90 }])
  })

  it('chunks a rect that exceeds the budget into bounded full-width bands', () => {
    // A near-full-pane HiDPI rect: the case that used to be one tens-of-MB read.
    const rects = planBandReads(5120, 2880)
    expect(rects.length).toBe(Math.ceil(2880 / BAND_CHUNK_ROWS))
    for (const r of rects) {
      expect(r.x).toBe(0)
      expect(r.w).toBe(5120)
      expect(r.h).toBeLessThanOrEqual(BAND_CHUNK_ROWS)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.y + r.h).toBeLessThanOrEqual(2880)
    }
    // Chunks tile the rect with no gaps or overlaps.
    const covered = rects.reduce((sum, r) => sum + r.h, 0)
    expect(covered).toBe(2880)
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].y).toBe(rects[i - 1].y + rects[i - 1].h)
    }
  })

  it('keeps the last chunk whole when the height divides evenly', () => {
    const rects = planBandReads(600, BAND_CHUNK_ROWS * 2)
    expect(rects).toEqual([
      { x: 0, y: 0, w: 600, h: BAND_CHUNK_ROWS },
      { x: 0, y: BAND_CHUNK_ROWS, w: 600, h: BAND_CHUNK_ROWS },
    ])
  })
})
