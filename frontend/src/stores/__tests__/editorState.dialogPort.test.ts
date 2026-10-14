// The value dialog lives in the UI store, reached through the openDialog port
// that stores/sketchEditorStore.ts registers at module scope. This suite
// deliberately imports ONLY the editor-state store: a headless consumer has no
// port, and the missing-port case must be observable (failLoud throws in test
// mode) instead of a silent no-op.
import { describe, it, expect, afterEach } from 'vitest'
import { editorState } from '@/stores/editorState'
import { sketchCallbacks, setSketchCallback } from '@/stores/sketchEditorCallbacks'

function armSingleLineDimension(): void {
  editorState.setState({
    activeFeatureId: 'S1',
    dimensionPicks: [{ isVertex: false, target: 'entity:S1:L1', entityKind: 'line' }],
  })
}

afterEach(() => {
  setSketchCallback('onMutation', null)
  setSketchCallback('getSketch', null)
  sketchCallbacks.openDialog = null
  editorState.getState().clearDimensionPicks()
})

describe('the editor-state store dialog port', () => {
  it('a consumer without the UI store fails loud when the prompt would open', () => {
    setSketchCallback('onMutation', () => {})
    // No sketchEditorStore import: the port was never registered.
    expect(sketchCallbacks.openDialog).toBeNull()
    armSingleLineDimension()

    expect(() => editorState.getState().finalizeDimensionPlacement([10, 10]))
      .toThrow(/openDialog/)
  })

  it('with the port registered the same call reaches it', () => {
    setSketchCallback('onMutation', () => {})
    const opened: unknown[] = []
    sketchCallbacks.openDialog = dialog => { opened.push(dialog) }
    armSingleLineDimension()

    editorState.getState().finalizeDimensionPlacement([10, 10])

    expect(opened).toHaveLength(1)
  })
})
