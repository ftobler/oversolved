import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { suggestConstraint, ALIGNMENT_TOLERANCE_DEG, ALIGNMENT_TOLERANCE_DIST } from '@/registry'
import { detectDrawAlignment, isAlignmentSnap } from '@/components/interaction/useAlignmentSnapEffect'

describe('alignment snap for draw tool', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({
      alignmentSnapPoint: null,
      alignmentSnapKind: null,
      alignmentSnapVertexId: null,
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

    it('ALIGNMENT_TOLERANCE_DIST is 5 screen pixels', () => {
      expect(ALIGNMENT_TOLERANCE_DIST).toBe(5)
    })
  })

  describe('isAlignmentSnap', () => {
    const tol = ALIGNMENT_TOLERANCE_DIST

    describe('horizontal detection', () => {
      it('detects near-horizontal when both angle and normal distance are within tolerance', () => {
        expect(isAlignmentSnap(100, tol - 1, tol)).toBe('kinda_horizontal')
      })

      it('detects exactly horizontal', () => {
        expect(isAlignmentSnap(50, 0, tol)).toBe('kinda_horizontal')
      })

      it('rejects when normal distance exceeds tolerance despite small angle', () => {
        expect(isAlignmentSnap(100, tol + 1, tol)).toBeNull()
      })

      it('rejects when angle exceeds tolerance even if normal distance is small', () => {
        expect(isAlignmentSnap(2, 1, tol)).toBeNull()
      })
    })

    describe('vertical detection', () => {
      it('detects near-vertical when both angle and normal distance are within tolerance', () => {
        expect(isAlignmentSnap(tol - 1, 100, tol)).toBe('kinda_vertical')
      })

      it('detects exactly vertical', () => {
        expect(isAlignmentSnap(0, 50, tol)).toBe('kinda_vertical')
      })

      it('rejects when normal distance exceeds tolerance despite small angle', () => {
        expect(isAlignmentSnap(tol + 1, 100, tol)).toBeNull()
      })

      it('rejects when angle exceeds tolerance even if normal distance is small', () => {
        expect(isAlignmentSnap(1, 2, tol)).toBeNull()
      })
    })

    describe('no detection', () => {
      it('returns null for 45 degree line', () => {
        expect(isAlignmentSnap(10, 10, tol)).toBeNull()
      })

      it('returns null when distance is too small', () => {
        expect(isAlignmentSnap(0, 0.0001, tol)).toBeNull()
      })
    })
  })

  describe('detectDrawAlignment', () => {
    const tol = ALIGNMENT_TOLERANCE_DIST

    it('wraps isAlignmentSnap into a result with point and vertexId', () => {
      const result = detectDrawAlignment([60, 20], [10, 20], tol)
      expect(result).toEqual({
        kind: 'kinda_horizontal',
        point: [10, 20],
        vertexId: 'draw:last',
      })
    })

    it('returns null when isAlignmentSnap returns null', () => {
      const result = detectDrawAlignment([10, 10], [0, 0], tol)
      expect(result).toBeNull()
    })
  })

  describe('store alignment snap state', () => {
    it('setAlignmentSnap updates store state', () => {
      const setAlignmentSnap = useSketchEditorStore.getState().setAlignmentSnap
      setAlignmentSnap([0, 0], 'kinda_horizontal', 'draw:last')

      const state = useSketchEditorStore.getState()
      expect(state.alignmentSnapPoint).toEqual([0, 0])
      expect(state.alignmentSnapKind).toBe('kinda_horizontal')
      expect(state.alignmentSnapVertexId).toBe('draw:last')
    })

    it('clear alignment snap by setting to null', () => {
      const setAlignmentSnap = useSketchEditorStore.getState().setAlignmentSnap
      setAlignmentSnap([0, 0], 'kinda_horizontal', 'draw:last')
      setAlignmentSnap(null, null, null)

      const state = useSketchEditorStore.getState()
      expect(state.alignmentSnapPoint).toBeNull()
      expect(state.alignmentSnapKind).toBeNull()
      expect(state.alignmentSnapVertexId).toBeNull()
    })
  })
})
