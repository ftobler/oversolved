import { describe, it, expect } from 'vitest'
import { buildContextMenu } from '@/pages/buildContextMenu'
import type { BuildContextMenuInput, BuildContextMenuCallbacks, RenameTarget } from '@/pages/buildContextMenu'
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
    hasDanglingContent: false,
    ...overrides,
  }
}

function defaultCallbacks(): BuildContextMenuCallbacks {
  return {
    onRebuild: () => {},
    onRemoveDanglingContent: () => {},
    onToggleVisibility: () => {},
    onToggleSuppression: () => {},
    onEnterEditSketch: () => {},
    onExitSketch: () => {},
    onDeleteFeature: () => {},
    onRequestRename: () => {},
    onAlignToFace: () => {},
    onNormalToPlane: () => {},
    onAlignCameraToSketchPlane: () => {},
    onSetPartColorPopover: () => {},
    onToggleConstraintTiles: () => {},
    onExportBody: () => {},
    onNewSketchOnPlane: () => {},
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

  it('offers the dangling-content cleanup only when the last solve flagged it', () => {
    const label = 'Remove dangling projections / superfluous constraints'
    const clean = buildContextMenu(defaultInput({ hasDanglingContent: true }), defaultCallbacks())
    expect(findLabel(clean.items, label)).toBeTruthy()
    const dirty = buildContextMenu(defaultInput({ hasDanglingContent: false }), defaultCallbacks())
    expect(findLabel(dirty.items, label)).toBeFalsy()
  })

  it('withholds the cleanup command during an active sketch edit', () => {
    const label = 'Remove dangling projections / superfluous constraints'
    const result = buildContextMenu(
      defaultInput({ hasDanglingContent: true, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, label)).toBeFalsy()
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

  it('exports a body, falling back to the body id when it has no label', () => {
    const seen: [string, string][] = []
    const callbacks = defaultCallbacks()
    callbacks.onExportBody = (bodyId, name) => { seen.push([bodyId, name]) }
    const result = buildContextMenu(defaultInput({ targetId: 'body:b1' }), callbacks)
    findLabel(result.items, 'Export')!.onClick()
    expect(seen).toEqual([['b1', 'b1']])
  })

  it('offers Unsuppress for a suppressed feature and toggles it off', () => {
    const seen: [string, boolean][] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleSuppression = (id, suppressed) => { seen.push([id, suppressed]) }
    const features = [makeFeature({ id: 'f1', kind: 'extrude', suppressed: true })]
    const result = buildContextMenu(defaultInput({ targetId: 'f1', features }), callbacks)
    const item = findLabel(result.items, 'Unsuppress')
    expect(item).toBeTruthy()
    item!.onClick()
    expect(seen).toEqual([['f1', false]])
  })

  it('offers Suppress for an active feature and toggles it on', () => {
    const seen: [string, boolean][] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleSuppression = (id, suppressed) => { seen.push([id, suppressed]) }
    const features = [makeFeature({ id: 'f1', kind: 'extrude' })]
    const result = buildContextMenu(defaultInput({ targetId: 'f1', features }), callbacks)
    const item = findLabel(result.items, 'Suppress')
    expect(item).toBeTruthy()
    item!.onClick()
    expect(seen).toEqual([['f1', true]])
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

  it('offers New Sketch on a user-defined plane, keyed by its feature query', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    let plane: string | undefined
    const callbacks = defaultCallbacks()
    callbacks.onNewSketchOnPlane = (p) => { plane = p }
    const result = buildContextMenu(defaultInput({ targetId: 'plane1', features }), callbacks)
    findLabel(result.items, 'New Sketch')!.onClick()
    expect(plane).toBe('@plane1')
  })

  it('offers New Sketch on a built-in plane, keyed by its builtin query', () => {
    const features = [makeFeature({ id: 'Front', kind: 'plane' })]
    let plane: string | undefined
    const callbacks = defaultCallbacks()
    callbacks.onNewSketchOnPlane = (p) => { plane = p }
    const result = buildContextMenu(
      defaultInput({ targetId: 'Front', features, builtInIds: new Set(['Front']) }),
      callbacks,
    )
    findLabel(result.items, 'New Sketch')!.onClick()
    expect(plane).toBe('@builtin_plane_front')
  })

  it('offers New Sketch when a plane is hovered in the viewport', () => {
    const features = [makeFeature({ id: 'Top', kind: 'plane' })]
    let plane: string | undefined
    const callbacks = defaultCallbacks()
    callbacks.onNewSketchOnPlane = (p) => { plane = p }
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: '@builtin_plane_top',
        features,
        builtInIds: new Set(['Top']),
      }),
      callbacks,
    )
    expect(result.items.map(i => i.label)).toEqual(['New Sketch', 'Normal to'])
    findLabel(result.items, 'New Sketch')!.onClick()
    expect(plane).toBe('@builtin_plane_top')
  })

  it('does not offer New Sketch for a hovered id that is no plane', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')).toBeUndefined()
  })

  it('does not offer New Sketch while a sketch edit session is open', () => {
    const features = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]
    const treeMenu = buildContextMenu(
      defaultInput({ targetId: 'plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(treeMenu.items, 'New Sketch')).toBeUndefined()

    const viewportMenu = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(viewportMenu.items, 'New Sketch')).toBeUndefined()
  })

  it('does not offer New Sketch on a sketch target', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')).toBeUndefined()
  })

  it('contains Normal to when hovered surface is present', () => {
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: 'face:xyz',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Normal to')).toBeTruthy()
    expect(result.items).toHaveLength(1)
  })

  it('passes the hovered face normal and center to onAlignToFace', () => {
    let args: [number[], number[]] | undefined
    const callbacks = defaultCallbacks()
    callbacks.onAlignToFace = (normal, center) => { args = [normal, center] }
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: 'face:xyz',
        hoveredFaceNormal: [0, 1, 0],
        hoveredFaceCenter: [1, 2, 3],
      }),
      callbacks,
    )
    findLabel(result.items, 'Normal to')!.onClick()
    expect(args).toEqual([[0, 1, 0], [1, 2, 3]])
  })

  it('offers Normal to on a plane hovered in the viewport, keyed by feature id', () => {
    const features = [makeFeature({ id: 'Top', kind: 'plane' })]
    let plane: string | undefined
    const callbacks = defaultCallbacks()
    callbacks.onNormalToPlane = (id) => { plane = id }
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: '@builtin_plane_top',
        features,
        builtInIds: new Set(['Top']),
      }),
      callbacks,
    )
    findLabel(result.items, 'Normal to')!.onClick()
    expect(plane).toBe('Top')
  })

  it('offers Normal to on a plane targeted in the feature tree', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    let plane: string | undefined
    const callbacks = defaultCallbacks()
    callbacks.onNormalToPlane = (id) => { plane = id }
    const result = buildContextMenu(defaultInput({ targetId: 'plane1', features }), callbacks)
    findLabel(result.items, 'Normal to')!.onClick()
    expect(plane).toBe('plane1')
  })

  it('offers Normal to on a plane even while a sketch edit session blocks New Sketch', () => {
    const features = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]
    const result = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')).toBeUndefined()
    expect(findLabel(result.items, 'Normal to')).toBeTruthy()
  })

  it('lets a feature-tree target win over a stale viewport hover', () => {
    const features = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        hoveredSelectionId: '@plane1',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
        features,
        visibleFeatures: new Set(['sketch1']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Delete')).toBeTruthy()
    expect(findLabel(result.items, 'Normal to')).toBeUndefined()
    expect(findLabel(result.items, 'New Sketch')).toBeUndefined()
  })

  it('does not offer Normal to on a sketch target', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Normal to')).toBeUndefined()
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

  it('requests a body rename carrying the current label', () => {
    const seen: RenameTarget[] = []
    const callbacks = defaultCallbacks()
    callbacks.onRequestRename = t => { seen.push(t) }
    const result = buildContextMenu(
      defaultInput({
        targetId: 'body:b1',
        partLabels: { b1: 'Body1' },
      }),
      callbacks,
    )
    findLabel(result.items, 'Rename')!.onClick()
    expect(seen).toEqual([{ kind: 'body', id: 'b1', currentName: 'Body1' }])
  })

  // An unlabelled body is named by its id, which is what the user sees in the tree.
  it('falls back to the body id when it carries no label', () => {
    const seen: RenameTarget[] = []
    const callbacks = defaultCallbacks()
    callbacks.onRequestRename = t => { seen.push(t) }
    const result = buildContextMenu(defaultInput({ targetId: 'body:b1' }), callbacks)
    findLabel(result.items, 'Rename')!.onClick()
    expect(seen[0].currentName).toBe('b1')
  })

  it('requests a feature rename carrying the current label', () => {
    const seen: RenameTarget[] = []
    const callbacks = defaultCallbacks()
    callbacks.onRequestRename = t => { seen.push(t) }
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features: [makeFeature({ id: 'sketch1', kind: 'sketch', label: 'Sketch A' })],
      }),
      callbacks,
    )
    findLabel(result.items, 'Rename')!.onClick()
    expect(seen).toEqual([{ kind: 'feature', id: 'sketch1', currentName: 'Sketch A' }])
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
