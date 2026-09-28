import { describe, it, expect, vi } from 'vitest'
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
    selectedNormalTarget: null,
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

function enabledLabels(items: ContextMenuItem[]) {
  return items.filter(i => !i.disabled).map(i => i.label)
}

const DANGLING = 'Remove dangling projections / superfluous constraints'

describe('buildContextMenu', () => {
  it('keeps the full fixed order for an empty viewport, with only Rebuild live', () => {
    const result = buildContextMenu(defaultInput(), defaultCallbacks())
    expect(result.items.map(i => i.label)).toEqual([
      'New Sketch',
      'Normal to',
      'Rebuild',
      DANGLING,
      'Edit',
      'Exit Sketch',
      'Normal to sketch',
      'Show',
      'Hide Constraints',
      'Suppress',
      'Rename',
      'Delete',
    ])
    expect(enabledLabels(result.items)).toEqual(['Rebuild'])
  })

  it('offers the dangling-content cleanup only when the last solve flagged it', () => {
    const clean = buildContextMenu(defaultInput({ hasDanglingContent: true }), defaultCallbacks())
    expect(findLabel(clean.items, DANGLING)!.disabled).toBeFalsy()
    const dirty = buildContextMenu(defaultInput({ hasDanglingContent: false }), defaultCallbacks())
    expect(findLabel(dirty.items, DANGLING)!.disabled).toBe(true)
  })

  it('greys the cleanup command during an active sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({ hasDanglingContent: true, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, DANGLING)!.disabled).toBe(true)
  })

  it('enables Rebuild, Edit, Hide, Rename, Delete for a non-built-in sketch', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'sketch1',
        features,
        visibleFeatures: new Set(['sketch1']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Edit')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Rename')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Delete')!.disabled).toBeFalsy()
  })

  it('disables Delete and Edit for a built-in feature', () => {
    const features = [makeFeature({ id: 'builtin_plane_front', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'builtin_plane_front',
        features,
        builtInIds: new Set(['builtin_plane_front']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Delete')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Edit')!.disabled).toBe(true)
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

  it('enables Edit and Hide/Show for a non-built-in plane', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'plane1',
        features,
        visibleFeatures: new Set(['plane1']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Edit')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Rename')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Delete')!.disabled).toBeFalsy()
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
    expect(findLabel(result.items, 'Show')!.disabled).toBeFalsy()
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
    expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
    findLabel(result.items, 'New Sketch')!.onClick()
    expect(plane).toBe('@builtin_plane_top')
  })

  it('greys New Sketch for a hovered id that is no plane', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
  })

  it('greys New Sketch while a sketch edit session is open', () => {
    const features = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]
    const treeMenu = buildContextMenu(
      defaultInput({ targetId: 'plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(treeMenu.items, 'New Sketch')!.disabled).toBe(true)

    const viewportMenu = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(viewportMenu.items, 'New Sketch')!.disabled).toBe(true)
  })

  it('greys New Sketch on a sketch target', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
  })

  it('enables New Sketch and Normal to when a hovered surface is present', () => {
    const result = buildContextMenu(
      defaultInput({
        hoveredSelectionId: 'face:xyz',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [1, 2, 3],
      }),
      defaultCallbacks(),
    )
    expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
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

  it('keeps Normal to live on a plane while a sketch edit blocks New Sketch', () => {
    const features = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]
    const result = buildContextMenu(
      defaultInput({ hoveredSelectionId: '@plane1', features, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Normal to')!.disabled).toBeFalsy()
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
    expect(findLabel(result.items, 'Delete')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
  })

  it('greys Normal to on a sketch target', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'sketch1', features }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
  })

  it('contains Exit Sketch and Normal to sketch when activeSketchFeatureId matches target', () => {
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
    expect(findLabel(result.items, 'Exit Sketch')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Normal to sketch')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Align camera')).toBeUndefined()
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Edit')!.disabled).toBeFalsy()
  })

  it('contains Exit Sketch but greys Normal to sketch when activeSketchFeatureId differs from target', () => {
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
    expect(findLabel(result.items, 'Exit Sketch')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Normal to sketch')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Edit')!.disabled).toBeFalsy()
  })

  it('shows Show and keeps it live when the edited sketch is not visible', () => {
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
    expect(findLabel(result.items, 'Show')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Exit Sketch')!.disabled).toBeFalsy()
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
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
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

  it('contains the Hide Constraints toggle during sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: 'sketch1',
        showConstraintTiles: true,
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide Constraints')!.disabled).toBeFalsy()
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
    expect(findLabel(result.items, 'Show Constraints')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide Constraints')).toBeUndefined()
  })

  it('greys the constraint toggle outside sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: undefined,
        showConstraintTiles: true,
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide Constraints')!.disabled).toBe(true)
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

  describe('Normal to sketch and the selection', () => {
    const planeAndSketch = [
      makeFeature({ id: 'plane1', kind: 'plane' }),
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
    ]

    it('offers Normal to sketch on a viewport right-click in sketch edit', () => {
      let called = false
      const callbacks = defaultCallbacks()
      callbacks.onAlignCameraToSketchPlane = () => { called = true }
      const result = buildContextMenu(
        defaultInput({ features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
        callbacks,
      )
      findLabel(result.items, 'Normal to sketch')!.onClick()
      expect(called).toBe(true)
    })

    it('lets the edited sketch win over a selection while editing it', () => {
      const result = buildContextMenu(
        defaultInput({
          features: planeAndSketch,
          activeSketchFeatureId: 'sketch1',
          selectedNormalTarget: { kind: 'plane', featureId: 'plane1' },
        }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Normal to sketch')!.disabled).toBeFalsy()
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
    })

    it('offers New Sketch and Normal to for one selected plane, keyed by its feature id', () => {
      let plane: string | undefined
      const callbacks = defaultCallbacks()
      callbacks.onNormalToPlane = (id) => { plane = id }
      const result = buildContextMenu(
        defaultInput({ features: planeAndSketch, selectedNormalTarget: { kind: 'plane', featureId: 'plane1' } }),
        callbacks,
      )
      expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
      findLabel(result.items, 'Normal to')!.onClick()
      expect(plane).toBe('plane1')
    })

    it('offers Normal to for one selected planar face with its resolved frame', () => {
      let args: [number[], number[]] | undefined
      const callbacks = defaultCallbacks()
      callbacks.onAlignToFace = (normal, center) => { args = [normal, center] }
      const result = buildContextMenu(
        defaultInput({ selectedNormalTarget: { kind: 'face', query: '?faceQ', normal: [1, 0, 0], center: [4, 5, 6] } }),
        callbacks,
      )
      findLabel(result.items, 'Normal to')!.onClick()
      expect(args).toEqual([[1, 0, 0], [4, 5, 6]])
    })

    it('lets a hovered face win over a different selected plane', () => {
      const seen: string[] = []
      const callbacks = defaultCallbacks()
      callbacks.onAlignToFace = () => { seen.push('face') }
      callbacks.onNormalToPlane = () => { seen.push('plane') }
      const result = buildContextMenu(
        defaultInput({
          features: planeAndSketch,
          hoveredSelectionId: '?face',
          hoveredFaceNormal: [0, 0, 1],
          hoveredFaceCenter: [0, 0, 0],
          selectedNormalTarget: { kind: 'plane', featureId: 'plane1' },
        }),
        callbacks,
      )
      expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
      findLabel(result.items, 'Normal to')!.onClick()
      expect(seen).toEqual(['face'])
    })

    // ─── A flat face is a sketch surface, like a plane ───

    it('offers New Sketch then Normal to on a hovered flat face, keyed by its query', () => {
      let plane: string | undefined
      const callbacks = defaultCallbacks()
      callbacks.onNewSketchOnPlane = (p) => { plane = p }
      const result = buildContextMenu(
        defaultInput({ hoveredSelectionId: '?faceQ', hoveredFaceNormal: [0, 0, 1], hoveredFaceCenter: [0, 0, 5] }),
        callbacks,
      )
      expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
      findLabel(result.items, 'New Sketch')!.onClick()
      // The unchanged selection query: what the sketch plane pick field stores.
      expect(plane).toBe('?faceQ')
    })

    it('offers New Sketch then Normal to on a selected flat face, keyed by its query', () => {
      let plane: string | undefined
      const callbacks = defaultCallbacks()
      callbacks.onNewSketchOnPlane = (p) => { plane = p }
      const result = buildContextMenu(
        defaultInput({ selectedNormalTarget: { kind: 'face', query: '?faceQ', normal: [0, 0, 1], center: [0, 0, 5] } }),
        callbacks,
      )
      expect(enabledLabels(result.items)).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
      findLabel(result.items, 'New Sketch')!.onClick()
      expect(plane).toBe('?faceQ')
    })

    it('greys New Sketch on a hovered flat face while a sketch is edited', () => {
      const result = buildContextMenu(
        defaultInput({
          features: planeAndSketch,
          activeSketchFeatureId: 'sketch1',
          hoveredSelectionId: '?faceQ',
          hoveredFaceNormal: [0, 0, 1],
          hoveredFaceCenter: [0, 0, 5],
        }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
      expect(findLabel(result.items, 'Normal to')!.disabled).toBeFalsy()
    })

    it('greys both surface items on a hovered curved face, which carries no face frame', () => {
      // Hover leaves the frame null for a non-flat face (planarFaceFrame).
      const result = buildContextMenu(
        defaultInput({ hoveredSelectionId: '?cylinderQ', hoveredFaceNormal: null, hoveredFaceCenter: null }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
      expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
    })

    it('does not fall back to a selected plane under a hovered curved face', () => {
      // The hover wins even though it offers neither item, so the selection
      // must not leak a Normal to for the plane.
      const result = buildContextMenu(
        defaultInput({
          features: planeAndSketch,
          hoveredSelectionId: '?cylinderQ',
          hoveredFaceNormal: null,
          hoveredFaceCenter: null,
          selectedNormalTarget: { kind: 'plane', featureId: 'plane1' },
        }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
      expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
      expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    })

    it('greys Normal to when the selection resolves to nothing', () => {
      // Two faces, an edge or a curved face all reach here as a null target.
      const result = buildContextMenu(defaultInput({ selectedNormalTarget: null }), defaultCallbacks())
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
    })

    it('ignores the selection on a feature-tree right-click', () => {
      const result = buildContextMenu(
        defaultInput({
          targetId: 'sketch1',
          features: planeAndSketch,
          selectedNormalTarget: { kind: 'plane', featureId: 'plane1' },
        }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
    })
  })

  describe('fixed slots', () => {
    it('keeps the edited sketch commands live and everything else greyed', () => {
      const features = [
        makeFeature({ id: 'sketch1', kind: 'sketch' }),
        makeFeature({ id: 'plane1', kind: 'plane' }),
      ]
      const result = buildContextMenu(
        defaultInput({
          features,
          visibleFeatures: new Set(['sketch1']),
          activeSketchFeatureId: 'sketch1',
        }),
        defaultCallbacks(),
      )
      expect(enabledLabels(result.items)).toEqual([
        'Rebuild',
        'Exit Sketch',
        'Normal to sketch',
        'Hide',
        'Hide Constraints',
      ])
    })

    it('greys Suppress, Rename and Delete for the sketch being edited', () => {
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
      expect(findLabel(result.items, 'Suppress')!.disabled).toBe(true)
      expect(findLabel(result.items, 'Rename')!.disabled).toBe(true)
      expect(findLabel(result.items, 'Delete')!.disabled).toBe(true)
    })

    it('greys Hide/Show for a feature that is neither a plane nor a sketch', () => {
      const features = [makeFeature({ id: 'f1', kind: 'extrude' })]
      const result = buildContextMenu(
        defaultInput({ targetId: 'f1', features, visibleFeatures: new Set(['f1']) }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Show')!.disabled).toBe(true)
    })

    it('still offers the edited sketch Hide when the targeted feature is not hideable', () => {
      const features = [
        makeFeature({ id: 'sketch1', kind: 'sketch' }),
        makeFeature({ id: 'f1', kind: 'extrude' }),
      ]
      const result = buildContextMenu(
        defaultInput({
          targetId: 'f1',
          features,
          visibleFeatures: new Set(['sketch1']),
          activeSketchFeatureId: 'sketch1',
        }),
        defaultCallbacks(),
      )
      expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    })

    it('greys New Sketch and Normal to on a hovered curved face without leaking a stale selection', () => {
      const newSketch = vi.fn()
      const align = vi.fn()
      const callbacks = defaultCallbacks()
      callbacks.onNewSketchOnPlane = newSketch
      callbacks.onAlignToFace = align
      const result = buildContextMenu(
        defaultInput({
          features: [makeFeature({ id: 'plane1', kind: 'plane' })],
          hoveredSelectionId: '?cylinderQ',
          hoveredFaceNormal: null,
          hoveredFaceCenter: null,
          selectedNormalTarget: { kind: 'plane', featureId: 'plane1' },
        }),
        callbacks,
      )
      expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
      expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
      // A disabled slot must not fire through the stale selected plane.
      findLabel(result.items, 'New Sketch')!.onClick()
      findLabel(result.items, 'Normal to')!.onClick()
      expect(newSketch).not.toHaveBeenCalled()
      expect(align).not.toHaveBeenCalled()
    })
  })
})
