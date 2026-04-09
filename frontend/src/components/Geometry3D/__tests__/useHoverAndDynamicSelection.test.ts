import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSketchEditorStore } from '../../../stores/sketchEditorStore'

describe('useHoverAndDynamicSelection hook behavior', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({
      isPointerDown: false,
      dynamicSelection: new Set(),
      normalSelection: new Set(),
      internalHoverSelection: null,
      isRotating: false,
      activeTool: 'select',
    })
  })

  describe('dynamicSelection accumulation logic', () => {
    it('updateDynamicSelection adds id when id not in normal selection', () => {
      useSketchEditorStore.setState({ isPointerDown: true })

      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(true)
    })

    it('updateDynamicSelection removes from dynamic when id already in normal selection', () => {
      useSketchEditorStore.setState({
        isPointerDown: true,
        normalSelection: new Set(['entity:S1:L1']),
        dynamicSelection: new Set(['entity:S1:L1']),
        internalHoverSelection: null,
      })

      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(false)
    })

    it('updateDynamicSelection ignores when hoverId matches internalHoverSelection', () => {
      useSketchEditorStore.setState({
        isPointerDown: true,
        normalSelection: new Set(),
        dynamicSelection: new Set(),
        internalHoverSelection: 'entity:S1:L1',
      })

      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(false)
    })

    it('updateDynamicSelection(null) clears dynamic selection', () => {
      useSketchEditorStore.setState({
        isPointerDown: true,
        normalSelection: new Set(),
        dynamicSelection: new Set(['entity:S1:L1']),
        internalHoverSelection: null,
      })

      useSketchEditorStore.getState().updateDynamicSelection(null)
      expect(useSketchEditorStore.getState().dynamicSelection.size).toBe(0)
    })

    it('lasso behavior: add on hover, clear on out, add again on re-hover', () => {
      useSketchEditorStore.setState({
        isPointerDown: true,
        normalSelection: new Set(),
        dynamicSelection: new Set(),
        internalHoverSelection: null,
      })

      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(true)

      useSketchEditorStore.getState().updateDynamicSelection(null)
      expect(useSketchEditorStore.getState().dynamicSelection.size).toBe(0)

      useSketchEditorStore.getState().updateDynamicSelection('entity:S1:L1')
      expect(useSketchEditorStore.getState().dynamicSelection.has('entity:S1:L1')).toBe(true)
    })
  })

  describe('internalHoverSelection', () => {
    it('setInternalHoverSelection updates store', () => {
      const setInternalHoverSelection = vi.fn()
      useSketchEditorStore.setState({ setInternalHoverSelection })

      useSketchEditorStore.getState().setInternalHoverSelection('entity:S1:L1')

      expect(setInternalHoverSelection).toHaveBeenCalledWith('entity:S1:L1')
    })

    it('setInternalHoverSelection with null clears hover', () => {
      useSketchEditorStore.setState({ internalHoverSelection: 'entity:S1:L1' })
      const setInternalHoverSelection = vi.fn()
      useSketchEditorStore.setState({ setInternalHoverSelection })

      useSketchEditorStore.getState().setInternalHoverSelection(null)

      expect(setInternalHoverSelection).toHaveBeenCalledWith(null)
    })
  })

  describe('isDrawingTool flag', () => {
    it('select tool is not a drawing tool', () => {
      useSketchEditorStore.setState({ activeTool: 'select' })
      const state = useSketchEditorStore.getState()
      const isDrawingTool = (state.activeTool ?? 'drag') !== 'select' && (state.activeTool ?? 'drag') !== 'dimension'
      expect(isDrawingTool).toBe(false)
    })

    it('dimension tool is not a drawing tool', () => {
      useSketchEditorStore.setState({ activeTool: 'dimension' })
      const state = useSketchEditorStore.getState()
      const isDrawingTool = (state.activeTool ?? 'drag') !== 'select' && (state.activeTool ?? 'drag') !== 'dimension'
      expect(isDrawingTool).toBe(false)
    })

    it('line tool is a drawing tool', () => {
      useSketchEditorStore.setState({ activeTool: 'line' })
      const state = useSketchEditorStore.getState()
      const isDrawingTool = (state.activeTool ?? 'drag') !== 'select' && (state.activeTool ?? 'drag') !== 'dimension'
      expect(isDrawingTool).toBe(true)
    })

    it('circle tool is a drawing tool', () => {
      useSketchEditorStore.setState({ activeTool: 'circle' })
      const state = useSketchEditorStore.getState()
      const isDrawingTool = (state.activeTool ?? 'drag') !== 'select' && (state.activeTool ?? 'drag') !== 'dimension'
      expect(isDrawingTool).toBe(true)
    })
  })

  describe('alignment snap with drawLastPoint', () => {
    it('horizontal alignment detected when cursor is within tolerance of horizontal axis', () => {
      const setAlignmentSnapSpy = vi.fn()
      useSketchEditorStore.setState({ setAlignmentSnap: setAlignmentSnapSpy })

      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [5, 0.1]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180
      const ALIGNMENT_TOLERANCE_DEG = 15

      expect(
        normalizedAngle < ALIGNMENT_TOLERANCE_DEG || normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG
      ).toBe(true)

      setAlignmentSnapSpy(lastPt, 'kinda_horizontal', 'draw:last')
      expect(setAlignmentSnapSpy).toHaveBeenCalledWith(lastPt, 'kinda_horizontal', 'draw:last')
    })

    it('vertical alignment detected when cursor is within tolerance of vertical axis', () => {
      const setAlignmentSnapSpy = vi.fn()
      useSketchEditorStore.setState({ setAlignmentSnap: setAlignmentSnapSpy })

      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [0.1, 5]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180
      const ALIGNMENT_TOLERANCE_DEG = 15
      const verticalAngle = Math.abs(normalizedAngle - 90)

      expect(
        verticalAngle < ALIGNMENT_TOLERANCE_DEG || verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG
      ).toBe(true)

      setAlignmentSnapSpy(lastPt, 'kinda_vertical', 'draw:last')
      expect(setAlignmentSnapSpy).toHaveBeenCalledWith(lastPt, 'kinda_vertical', 'draw:last')
    })

    it('no alignment when cursor is not aligned to either axis', () => {
      const setAlignmentSnapSpy = vi.fn()
      useSketchEditorStore.setState({ setAlignmentSnap: setAlignmentSnapSpy })

      const lastPt: [number, number] = [0, 0]
      const cursorPt: [number, number] = [5, 5]

      const dx = cursorPt[0] - lastPt[0]
      const dy = cursorPt[1] - lastPt[1]
      const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
      const normalizedAngle = ((angleDeg % 180) + 180) % 180
      const ALIGNMENT_TOLERANCE_DEG = 15
      const verticalAngle = Math.abs(normalizedAngle - 90)

      const isHorizontal = normalizedAngle < ALIGNMENT_TOLERANCE_DEG || normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG
      const isVertical = verticalAngle < ALIGNMENT_TOLERANCE_DEG || verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG

      expect(isHorizontal).toBe(false)
      expect(isVertical).toBe(false)

      setAlignmentSnapSpy(null, null, null)
      expect(setAlignmentSnapSpy).toHaveBeenCalledWith(null, null, null)
    })
  })
})
