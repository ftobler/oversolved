import { describe, it, expect } from 'vitest'
import { buildContextMenu } from '@/pages/buildContextMenu'
import type { BuildContextMenuInput, BuildContextMenuCallbacks } from '@/pages/buildContextMenu'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import type { PartFeature } from '@/types/cad'

function makeFeature(overrides: Partial<PartFeature> & { id: string; kind: string }): PartFeature {
  return overrides as PartFeature
}

function defaultInput(overrides?: Partial<BuildContextMenuInput>): BuildContextMenuInput {
  return {
    pos: [0, 0] as [number, number],
    targetId: undefined,
    hoveredSelectionId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
    features: [],
    visibleFeatures: new Set(),
    activeSketchFeatureId: undefined,
    showConstraintTiles: true,
    partLabels: {},
    builtInIds: new Set(),
    ...overrides,
  }
}

function defaultCallbacks(): BuildContextMenuCallbacks {
  return {
    onRebuild: () => {},
    onToggleVisibility: () => {},
    onToggleSuppression: () => {},
    onEnterEditSketch: () => {},
    onExitSketch: () => {},
    onDeleteFeature: () => {},
    onFeatureRename: () => {},
    onBodyRename: () => {},
    onAlignToFace: () => {},
    onAlignCameraToSketchPlane: () => {},
    onSetPartColorPopover: () => {},
    onToggleConstraintTiles: () => {},
    onExportBody: () => {},
    onShowContextMenu: () => {},
  }
}

function findLabel(items: ContextMenuItem[], label: string) {
  return items.find(i => i.label === label)
}

describe('buildContextMenu', () => {
  it('contains Rebuild when no target', () => {
    const result = buildContextMenu(defaultInput(), defaultCallbacks())
    expect(findLabel(result.items, 'Rebuild')).toBeTruthy()
    expect(result.items).toHaveLength(1)
  })

  it('contains Rebuild, Edit, Hide, Rename, Delete for a non-built-in sketch', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features,
        visibleFeatures: new Set(['sketch1']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')).toBeTruthy()
    expect(findLabel(result.items, 'Edit')).toBeTruthy()
    expect(findLabel(result.items, 'Hide')).toBeTruthy()
    expect(findLabel(result.items, 'Rename')).toBeTruthy()
    expect(findLabel(result.items, 'Delete')).toBeTruthy()
  })

  it('excludes Delete for a built-in feature', () => {
    const features = [makeFeature({ id: 'builtin_plane_front', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'builtin_plane_front',
        features,
        builtInIds: new Set(['builtin_plane_front']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')).toBeTruthy()
    expect(findLabel(result.items, 'Delete')).toBeUndefined()
    expect(findLabel(result.items, 'Edit')).toBeUndefined()
  })

  it('contains Rename, Color, Export for a body target', () => {
    const result = buildContextMenu(
      defaultInput({
        targetId: 'body:abc123',
        partLabels: { abc123: 'MyBody' },
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rename')).toBeTruthy()
    expect(findLabel(result.items, 'Color')).toBeTruthy()
    expect(findLabel(result.items, 'Export')).toBeTruthy()
    expect(result.items).toHaveLength(3)
  })

  it('contains Edit, Hide/Show for a non-built-in plane', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'plane1',
        features,
        visibleFeatures: new Set(['plane1']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')).toBeTruthy()
    expect(findLabel(result.items, 'Edit')).toBeTruthy()
    expect(findLabel(result.items, 'Hide')).toBeTruthy()
    expect(findLabel(result.items, 'Rename')).toBeTruthy()
    expect(findLabel(result.items, 'Delete')).toBeTruthy()
  })

  it('shows Show instead of Hide when plane is not visible', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'plane1',
        features,
        visibleFeatures: new Set(),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Show')).toBeTruthy()
    expect(findLabel(result.items, 'Hide')).toBeUndefined()
  })

  it('contains Align to Face when hovered surface is present', () => {
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: 'face:xyz',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Align to Face')).toBeTruthy()
    expect(result.items).toHaveLength(1)
  })

  it('contains Exit Sketch and Align camera when activeSketchFeatureId matches target', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features,
        visibleFeatures: new Set(['sketch1']),
        activeSketchFeatureId: 'sketch1',
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Exit Sketch')).toBeTruthy()
    expect(findLabel(result.items, 'Align camera')).toBeTruthy()
    expect(findLabel(result.items, 'Hide')).toBeTruthy()
    expect(findLabel(result.items, 'Edit')).toBeTruthy()
  })

  it('contains Exit Sketch but not Align camera when activeSketchFeatureId differs from target', () => {
    const features = [
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
      makeFeature({ id: 'sketch2', kind: 'sketch' }),
    ]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch2',
        features,
        visibleFeatures: new Set(['sketch1', 'sketch2']),
        activeSketchFeatureId: 'sketch1',
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Exit Sketch')).toBeTruthy()
    expect(findLabel(result.items, 'Align camera')).toBeUndefined()
    expect(findLabel(result.items, 'Edit')).toBeTruthy()
  })

  it('does not include Hide when visibleFeatures does not contain the sketch', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features,
        visibleFeatures: new Set(),
        activeSketchFeatureId: 'sketch1',
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide')).toBeUndefined()
    expect(findLabel(result.items, 'Exit Sketch')).toBeTruthy()
  })

  it('includes Hide for sketch in active section when visible', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features,
        visibleFeatures: new Set(['sketch1']),
        activeSketchFeatureId: 'sketch1',
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide')).toBeTruthy()
  })

  it('calls onAlignToFace when Align to Face is clicked', () => {
    let called = false
    const callbacks = defaultCallbacks()
    callbacks.onAlignToFace = () => { called = true }
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: 'face:xyz',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
      }),
      callbacks,
    )
    const alignItem = findLabel(result.items, 'Align to Face')
    alignItem!.onClick()
    expect(called).toBe(true)
  })

  it('calls onBodyRename when Rename on body is clicked', () => {
    const callbacks = defaultCallbacks()
    callbacks.onBodyRename = () => {}
    const result = buildContextMenu(
      defaultInput({
        targetId: 'body:b1',
        partLabels: { b1: 'Body1' },
      }),
      callbacks,
    )
    const renameItem = findLabel(result.items, 'Rename')
    expect(renameItem).toBeTruthy()
  })

  it('calls onRebuild when Rebuild is clicked', () => {
    let called = false
    const callbacks = defaultCallbacks()
    callbacks.onRebuild = () => { called = true }
    const result = buildContextMenu(defaultInput(), callbacks)
    findLabel(result.items, 'Rebuild')!.onClick()
    expect(called).toBe(true)
  })

  it('contains Hide Constraints toggle during sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: 'sketch1',
        showConstraintTiles: true,
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide Constraints')).toBeTruthy()
    expect(findLabel(result.items, 'Show Constraints')).toBeUndefined()
  })

  it('shows Show Constraints when showConstraintTiles is false', () => {
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: 'sketch1',
        showConstraintTiles: false,
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Show Constraints')).toBeTruthy()
    expect(findLabel(result.items, 'Hide Constraints')).toBeUndefined()
  })

  it('does not include constraint toggle outside sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: undefined,
        showConstraintTiles: true,
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide Constraints')).toBeUndefined()
    expect(findLabel(result.items, 'Show Constraints')).toBeUndefined()
  })

  it('calls onToggleConstraintTiles when Hide Constraints is clicked', () => {
    let called = false
    const callbacks = defaultCallbacks()
    callbacks.onToggleConstraintTiles = () => { called = true }
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: 'sketch1',
        showConstraintTiles: true,
      }),
      callbacks,
    )
    findLabel(result.items, 'Hide Constraints')!.onClick()
    expect(called).toBe(true)
  })
})
