import { IdPipeline } from '@/picking'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { act } from '@testing-library/react'
import { resetDimCallbacksForTest } from '../dimensionLabelCallbacks'
import { StubRenderer, makeCanvas } from './pickCanvasFixture'

// Shared per-test scaffolding for the split useIdBufferPointerDispatch suites.
// This is the setup the single pre-split file ran once: a fresh canvas, pipeline
// and renderer ref, with the live pipeline and dimension callbacks reset around
// every test. Suites assign the returned refs to their own let bindings so the
// test bodies stay verbatim.
export interface IdBufferDispatchFixture {
  canvas: HTMLCanvasElement
  pipeline: IdPipeline
  glRef: { current: unknown }
}

export function newIdBufferDispatchFixture(): IdBufferDispatchFixture {
  resetDimCallbacksForTest()
  const canvas = makeCanvas()
  const pipeline = new IdPipeline({ width: 800, height: 600 })
  setLivePipeline(pipeline)
  const glRef = { current: new StubRenderer(canvas) }
  useSketchEditorStore.setState({ activeTool: null })  // idle select is activeTool null
  return { canvas, pipeline, glRef }
}

export function disposeIdBufferDispatchFixture(pipeline: IdPipeline): void {
  setLivePipeline(null)
  pipeline.dispose()
}

/**
 * Let the hover throttle's trailing frame fire. Hover resolves are capped at ~two
 * per animation frame (see onPointerMove): the first move in a frame reads the ID
 * buffer straight away, later ones wait for the frame boundary.
 */
export async function flushHoverFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await Promise.resolve()
  })
}
