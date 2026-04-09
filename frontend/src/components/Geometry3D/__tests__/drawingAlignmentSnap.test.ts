import { describe, it, expect, beforeEach } from 'vitest'
import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { suggestConstraint, ALIGNMENT_TOLERANCE_DEG } from '../../../registry'

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

    it('returns null for non-alignment snap kinds', () => {
      expect(suggestConstraint('vertex', 'vertex')).toBe('coincident')
      expect(suggestConstraint('vertex', 'midpoint')).toBe('coincident')
      expect(suggestConstraint('vertex', 'path')).toBe('coincident')
    })
  })

  describe('ALIGNMENT_TOLERANCE_DEG constant', () => {
    it('is defined as 15 degrees', () => {
      expect(ALIGNMENT_TOLERANCE_DEG).toBe(15)
    })
  })

  describe('horizontal alignment detection', () => {
    it('cursor within tolerance of horizontal axis is detected as kinda_horizontal', () => {
      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [5, 0.1]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180

      const isHorizontal = normalizedAngle < ALIGNMENT_TOLERANCE_DEG || 
                           normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isHorizontal).toBe(true)
    })

    it('cursor at exactly horizontal is detected as kinda_horizontal', () => {
      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [5, 0]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180

      const isHorizontal = normalizedAngle < ALIGNMENT_TOLERANCE_DEG || 
                           normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isHorizontal).toBe(true)
    })
  })

  describe('vertical alignment detection', () => {
    it('cursor within tolerance of vertical axis is detected as kinda_vertical', () => {
      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [0.1, 5]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180
      const verticalAngle = Math.abs(normalizedAngle - 90)

      const isVertical = verticalAngle < ALIGNMENT_TOLERANCE_DEG || 
                         verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isVertical).toBe(true)
    })

    it('cursor at exactly vertical is detected as kinda_vertical', () => {
      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [0, 5]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180
      const verticalAngle = Math.abs(normalizedAngle - 90)

      const isVertical = verticalAngle < ALIGNMENT_TOLERANCE_DEG || 
                         verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isVertical).toBe(true)
    })
  })

  describe('no alignment detection', () => {
    it('cursor at 45 degrees is not aligned', () => {
      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [5, 5]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180

      const isHorizontal = normalizedAngle < ALIGNMENT_TOLERANCE_DEG || 
                           normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG
      const verticalAngle = Math.abs(normalizedAngle - 90)
      const isVertical = verticalAngle < ALIGNMENT_TOLERANCE_DEG || 
                         verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isHorizontal).toBe(false)
      expect(isVertical).toBe(false)
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

  describe('constraint insertion pattern', () => {
    it('horizontal alignment snap produces horizontal constraint', () => {
      expect(suggestConstraint('vertex', 'kinda_horizontal')).toBe('horizontal')
    })

    it('vertical alignment snap produces vertical constraint', () => {
      expect(suggestConstraint('vertex', 'kinda_vertical')).toBe('vertical')
    })
  })
})
