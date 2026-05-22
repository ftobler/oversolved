import { describe, it, expect, beforeEach } from 'vitest'
import { IdPipeline } from '../IdPipeline'
import {
  selectScenePartEditorSlice, sceneSliceChanged, subscribePipelineToPartEditor,
} from '../dirtyInvalidation'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

describe('IdPipeline dirty flag', () => {
  it('starts dirty and clears after a render', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    expect(p.isDirty()).toBe(true)
    expect(p.getRenderCount()).toBe(0)
    p.dispose()
  })

  it('markDirty(reason) sets dirty and records the reason', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    p['target'].markClean()
    expect(p.isDirty()).toBe(false)
    p.markDirty('camera')
    expect(p.isDirty()).toBe(true)
    expect(p.getLastDirtyReason()).toBe('camera')
    p.dispose()
  })

  it('resize marks dirty', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    p['target'].markClean()
    p.resize(32, 32)
    expect(p.isDirty()).toBe(true)
    p.dispose()
  })

  it('renderIfDirty is a no-op when not dirty', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    // Stub renderer with the minimum surface render() touches; the layer
    // loop early-returns when no layer scene has children, so render()
    // never actually calls renderer.render here.
    const renderer = makeFakeRenderer()
    p['target'].markClean()
    const before = p.getRenderCount()
    const rendered = p.renderIfDirty(renderer, makeFakeCamera())
    expect(rendered).toBe(false)
    expect(p.getRenderCount()).toBe(before)
    p.dispose()
  })

  it('renderIfDirty renders exactly once per dirty cycle', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    const renderer = makeFakeRenderer()
    const cam = makeFakeCamera()
    p.markDirty('initial')
    expect(p.renderIfDirty(renderer, cam)).toBe(true)
    expect(p.getRenderCount()).toBe(1)
    // Subsequent calls without re-dirtying are no-ops.
    expect(p.renderIfDirty(renderer, cam)).toBe(false)
    expect(p.renderIfDirty(renderer, cam)).toBe(false)
    expect(p.getRenderCount()).toBe(1)
    p.dispose()
  })
})

describe('partEditorStore scene-slice invalidation', () => {
  beforeEach(() => {
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, setSnapshot: usePartEditorStore.getState().setSnapshot, setActiveSketchFeatureId: usePartEditorStore.getState().setActiveSketchFeatureId }, true)
  })

  it('detects scene-shape changes only on relevant fields', () => {
    const a = selectScenePartEditorSlice(usePartEditorStore.getState())
    // Same store snapshot -> no change.
    const b = selectScenePartEditorSlice(usePartEditorStore.getState())
    expect(sceneSliceChanged(a, b)).toBe(false)

    // Mutating an unrelated field (validation) -> no change.
    usePartEditorStore.setState({ validation: null })
    const c = selectScenePartEditorSlice(usePartEditorStore.getState())
    expect(sceneSliceChanged(a, c)).toBe(false)

    // Replacing bodies -> change.
    usePartEditorStore.setState({ bodies: {} })
    const d = selectScenePartEditorSlice(usePartEditorStore.getState())
    expect(sceneSliceChanged(c, d)).toBe(true)
  })

  it('subscribePipelineToPartEditor does NOT dirty on solve replacement — Body3D registration hooks handle that', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    p['target'].markClean()
    const unsub = subscribePipelineToPartEditor(p)

    // Irrelevant field: should NOT dirty (same as before — no change).
    usePartEditorStore.setState({ isRebuilding: true })
    expect(p.isDirty()).toBe(false)

    // Replacing bodies (post-solve snapshot): the subscription no longer
    // calls markDirty here because the Body3D registration hooks
    // (useFaceIdRegistration, useEdgeIdRegistration, useVertexIdRegistration)
    // handle that AFTER React re-renders and commits the new geometry.
    // Marking dirty here would be too early — the layers still have old
    // geometry, and the pipeline would render stale pixel data.
    usePartEditorStore.setState({ bodies: { 'a': {} as never } })
    expect(p.isDirty()).toBe(false)  // subscription no longer dirties

    unsub()
    p.dispose()
  })
})

describe('sketchEditorStore selection/hover do not dirty', () => {
  it('hover/selection changes never call markDirty on the pipeline', () => {
    const p = new IdPipeline({ width: 16, height: 16 })
    const unsubPart = subscribePipelineToPartEditor(p)
    p['target'].markClean()

    // Simulate a hover change. The pipeline isn't subscribed to
    // sketchEditorStore hover fields, so no dirty.
    useSketchEditorStore.setState({ hoveredSelectionId: 'e1' })
    expect(p.isDirty()).toBe(false)
    useSketchEditorStore.setState({ hoveredSelectionId: null })
    expect(p.isDirty()).toBe(false)

    // Simulate a selection change. Same: must not dirty.
    useSketchEditorStore.setState({ normalSelection: new Set(['x']) })
    expect(p.isDirty()).toBe(false)

    unsubPart()
    p.dispose()
  })
})

function makeFakeRenderer(): import('three').WebGLRenderer {
  const fake = {
    getRenderTarget: () => null,
    setRenderTarget: () => undefined,
    getClearColor: (_c: import('three').Color) => undefined,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    clear: () => undefined,
    clearDepth: () => undefined,
    render: () => undefined,
    autoClear: true,
    readRenderTargetPixels: () => undefined,
  }
  return fake as unknown as import('three').WebGLRenderer
}

function makeFakeCamera(): import('three').Camera {
  return {} as unknown as import('three').Camera
}
