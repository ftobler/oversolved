import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { suggestConstraint, ALIGNMENT_TOLERANCE_DEG, ALIGNMENT_TOLERANCE_DIST } from '@/registry'
import { detectDrawAlignment, isAlignmentSnap, toolTakesAlignmentSnap } from '@/components/interaction/useAlignmentSnapEffect'

describe('alignment snap for draw tool', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({
      alignmentSnapPoint: null,
      alignmentSnapKind: null,
      drawPoints: [],
    })
  })

  describe('suggestConstraint for alignment snap', () => {
    it('returns horizontal for kinda_horizontal snap', () => {
      expect(suggestConstraint('vertex', 'kinda_horizontal')).toBe('horizontal')
      expect(suggestConstraint('entity', 'kinda_horizontal')).toBe('horizontal')
    })

    it('returns vertical for kinda_vertical snap', () => {
      expect(suggestConstraint('vertex', 'kinda_vertical')).toBe('vertical')
      expect(suggestConstraint('entity', 'kinda_vertical')).toBe('vertical')
    })

    it('returns coincident for vertex and path snap kinds', () => {
      expect(suggestConstraint('vertex', 'vertex')).toBe('coincident')
      expect(suggestConstraint('vertex', 'path')).toBe('coincident')
    })
  })

  describe('tolerance constants', () => {
    it('ALIGNMENT_TOLERANCE_DEG is 10 degrees', () => {
      expect(ALIGNMENT_TOLERANCE_DEG).toBe(10)
    })

    it('ALIGNMENT_TOLERANCE_DIST is 20 screen pixels', () => {
      expect(ALIGNMENT_TOLERANCE_DIST).toBe(20)
    })
  })

  describe('isAlignmentSnap', () => {
    const TOL = 20  // world-space tolerance for test

    describe('horizontal detection', () => {
      it('detects near-horizontal when both angle and normal distance are within tolerance', () => {
        expect(isAlignmentSnap(100, 4, TOL)).toBe('kinda_horizontal')
      })

      it('detects exactly horizontal', () => {
        expect(isAlignmentSnap(50, 0, TOL)).toBe('kinda_horizontal')
      })

      it('rejects when normal distance exceeds tolerance despite small angle', () => {
        expect(isAlignmentSnap(100, 21, TOL)).toBeNull()
      })

      it('rejects when angle exceeds tolerance even if normal distance is small', () => {
        expect(isAlignmentSnap(2, 1, TOL)).toBeNull()
      })
    })

    describe('vertical detection', () => {
      it('detects near-vertical when both angle and normal distance are within tolerance', () => {
        expect(isAlignmentSnap(4, 100, TOL)).toBe('kinda_vertical')
      })

      it('detects exactly vertical', () => {
        expect(isAlignmentSnap(0, 50, TOL)).toBe('kinda_vertical')
      })

      it('rejects when normal distance exceeds tolerance despite small angle', () => {
        expect(isAlignmentSnap(21, 100, TOL)).toBeNull()
      })

      it('rejects when angle exceeds tolerance even if normal distance is small', () => {
        expect(isAlignmentSnap(1, 2, TOL)).toBeNull()
      })
    })

    describe('no detection', () => {
      it('returns null for 45 degree line', () => {
        expect(isAlignmentSnap(10, 10, TOL)).toBeNull()
      })

      it('returns null when distance is too small', () => {
        expect(isAlignmentSnap(0, 0.0001, TOL)).toBeNull()
      })
    })
  })

  describe('detectDrawAlignment', () => {
    const TOL = 20

    it('wraps isAlignmentSnap into a result carrying only kind and reference point', () => {
      // No vertex id: the reference is the segment's own start, so this snap
      // names a line to make axis-aligned, never a second point to merge with.
      const result = detectDrawAlignment([60, 20], [10, 20], TOL)
      expect(result).toEqual({
        kind: 'kinda_horizontal',
        point: [10, 20],
      })
    })

    it('returns null when isAlignmentSnap returns null', () => {
      const result = detectDrawAlignment([10, 10], [0, 0], TOL)
      expect(result).toBeNull()
    })
  })

  describe('store alignment snap state', () => {
    it('setAlignmentSnap updates store state', () => {
      const setAlignmentSnap = useSketchEditorStore.getState().setAlignmentSnap
      setAlignmentSnap([0, 0], 'kinda_horizontal')

      const state = useSketchEditorStore.getState()
      expect(state.alignmentSnapPoint).toEqual([0, 0])
      expect(state.alignmentSnapKind).toBe('kinda_horizontal')
    })

    it('clear alignment snap by setting to null', () => {
      const setAlignmentSnap = useSketchEditorStore.getState().setAlignmentSnap
      setAlignmentSnap([0, 0], 'kinda_horizontal')
      setAlignmentSnap(null, null)

      const state = useSketchEditorStore.getState()
      expect(state.alignmentSnapPoint).toBeNull()
      expect(state.alignmentSnapKind).toBeNull()
    })
  })

  // A guide is a promise that the click will honour it. The rect, center rect
  // and n-gon commits drop alignment, so they must not show the guide either.
  describe('toolTakesAlignmentSnap', () => {
    it.each(['rect', 'center_rect', 'ngon'])('%s gets no alignment snap', (tool) => {
      expect(toolTakesAlignmentSnap(tool)).toBe(false)
    })

    it.each(['line', 'circle', 'arc', 'spline'])('%s keeps the alignment snap', (tool) => {
      expect(toolTakesAlignmentSnap(tool)).toBe(true)
    })
  })
})
