import { describe, it, expect, vi } from 'vitest'
import { buildContextMenu, canManageFeature } from '@/pages/buildContextMenu'
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
    targetPartId: null,
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
    projectedTargetIds: [],
    visibleParts: undefined,
    ...overrides,
  }
}

function defaultCallbacks(): BuildContextMenuCallbacks {
  return {
    onRebuild: () => {},
    onRemoveDanglingContent: () => {},
    onToggleVisibility: () => {},
    onToggleSuppression: () => {},
    onExitSketch: () => {},
    onDeleteFeature: () => {},
    onRequestRename: () => {},
    onAlignToFace: () => {},
    onNormalToPlane: () => {},
    onAlignCameraToSketchPlane: () => {},
    onSetPartColorPopover: () => {},
    onToggleConstraintTiles: () => {},
    onExportPart: () => {},
    onTogglePartVisibility: () => {},
    onNewSketchOnPlane: () => {},
    onFreezeProjection: () => {},
  }
}

function findLabel(items: ContextMenuItem[], label: string) {
  return items.find(i => i.label === label)
}

function enabledLabels(items: ContextMenuItem[]) {
  return items.filter(i => !i.disabled).map(i => i.label)
}

const DANGLING = 'Remove dangling projections / superfluous constraints'

const PART_BOARD = [
  'New Sketch',
  'Normal to',
  'Rebuild',
  DANGLING,
  'Show',
  'Color',
  'Export',
  'Suppress',
  'Rename',
  'Delete',
]

const SKETCH_BOARD = [
  'Exit Sketch',
  'Normal to sketch',
  'Normal to',
  'Show',
  'Hide Constraints',
  'Convert to fixed',
  'Break link (keep free)',
  'Rebuild',
]

const planeAndSketch = [
  makeFeature({ id: 'plane1', kind: 'plane' }),
  makeFeature({ id: 'sketch1', kind: 'sketch' }),
]

describe('buildContextMenu board selection', () => {
  it('keeps the full part-board order for an empty viewport, with only Rebuild live', () => {
    const result = buildContextMenu(defaultInput(), defaultCallbacks())
    expect(result.items.map(i => i.label)).toEqual(PART_BOARD)
    expect(enabledLabels(result.items)).toEqual(['Rebuild'])
  })

  it('keeps the full sketch-board order for a viewport right-click during sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({ features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(result.items.map(i => i.label)).toEqual(SKETCH_BOARD)
  })

  it('shows the sketch board for a tree row of another feature during sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({ targetId: 'plane1', features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(result.items.map(i => i.label)).toEqual(SKETCH_BOARD)
  })

  it('contains Edit in neither board', () => {
    const part = buildContextMenu(defaultInput(), defaultCallbacks())
    const sketch = buildContextMenu(
      defaultInput({ features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect([...part.items, ...sketch.items].map(i => i.label)).not.toContain('Edit')
  })

  // A fixed board is the whole point: a disable must never change the menu's
  // height or slot order, across every input shape the page can build.
  it('keeps a constant length for every board input', () => {
    const fixtures: BuildContextMenuInput[] = [
      defaultInput(),
      defaultInput({ targetId: 'extrude1', features: [makeFeature({ id: 'extrude1', kind: 'extrude' })] }),
      defaultInput({ targetId: 'body:b1', partLabels: { b1: 'Body 1' } }),
      defaultInput({ targetPartId: 'b1', partLabels: { b1: 'Body 1' } }),
      defaultInput({
        targetPartId: 'b1',
        partLabels: { b1: 'Body 1' },
        hoveredSelectionId: '?faceQ',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [0, 0, 5],
      }),
      defaultInput({ hoveredSelectionId: '@builtin_plane_top', features: planeAndSketch }),
      defaultInput({ selectedNormalTarget: { kind: 'plane', featureId: 'plane1' }, features: planeAndSketch }),
      defaultInput({ hasDanglingContent: true }),
      defaultInput({ activeSketchFeatureId: 'sketch1' }),
      defaultInput({ activeSketchFeatureId: 'sketch1', features: planeAndSketch, showConstraintTiles: false }),
      defaultInput({ activeSketchFeatureId: 'sketch1', features: planeAndSketch, projectedTargetIds: ['entity:sketch1:e1'] }),
      defaultInput({ targetId: 'plane1', features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
    ]
    for (const fixture of fixtures) {
      const { items } = buildContextMenu(fixture, defaultCallbacks())
      expect(items).toHaveLength(fixture.activeSketchFeatureId ? SKETCH_BOARD.length : PART_BOARD.length)
    }
  })
})

describe('part board commands', () => {
  it('offers the dangling-content cleanup only when the last solve flagged it', () => {
    const dirty = buildContextMenu(defaultInput({ hasDanglingContent: true }), defaultCallbacks())
    expect(findLabel(dirty.items, DANGLING)!.disabled).toBeFalsy()
    const clean = buildContextMenu(defaultInput({ hasDanglingContent: false }), defaultCallbacks())
    expect(findLabel(clean.items, DANGLING)!.disabled).toBe(true)
  })

  it('enables Rebuild, Hide, Suppress, Rename and Delete for a non-built-in sketch', () => {
    const features = [makeFeature({ id: 'sketch1', kind: 'sketch' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'sketch1', features, visibleFeatures: new Set(['sketch1']) }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Suppress')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Rename')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Delete')!.disabled).toBeFalsy()
  })

  it('greys Delete, Suppress and Rename for a built-in feature but keeps its eye', () => {
    const features = [makeFeature({ id: 'builtin_plane_front', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'builtin_plane_front',
        features,
        builtInIds: new Set(['builtin_plane_front']),
        visibleFeatures: new Set(['builtin_plane_front']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Rebuild')!.disabled).toBeFalsy()
    // A built-in plane has an eye in the tree, so the menu keeps the same slot.
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Suppress')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Rename')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Delete')!.disabled).toBe(true)
  })

  it('contains Hide, Color, Export and Rename for a body target, and greys the feature verbs', () => {
    const result = buildContextMenu(
      defaultInput({ targetId: 'body:abc123', partLabels: { abc123: 'MyPart' } }),
      defaultCallbacks(),
    )
    expect(result.items.map(i => i.label)).toEqual([
      'New Sketch', 'Normal to', 'Rebuild', DANGLING, 'Hide', 'Color', 'Export', 'Suppress', 'Rename', 'Delete',
    ])
    expect(enabledLabels(result.items)).toEqual(['Rebuild', 'Hide', 'Color', 'Export', 'Rename'])
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Normal to')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Suppress')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Delete')!.disabled).toBe(true)
  })

  it('names no body in any menu label', () => {
    const part = buildContextMenu(
      defaultInput({ targetId: 'body:abc123', partLabels: { abc123: 'MyPart' } }),
      defaultCallbacks(),
    )
    const feature = buildContextMenu(defaultInput(), defaultCallbacks())
    const labels = [...part.items, ...feature.items].map(i => i.label)
    expect(labels.filter(label => /\bbod(?:y|ies)\b/i.test(label))).toEqual([])
  })

  it('shows Hide for a visible body and calls onTogglePartVisibility(id, false)', () => {
    const seen: [string, boolean][] = []
    const callbacks = defaultCallbacks()
    callbacks.onTogglePartVisibility = (partId, visible) => { seen.push([partId, visible]) }
    for (const visibleParts of [undefined, new Set(['abc123'])]) {
      const result = buildContextMenu(
        defaultInput({ targetId: 'body:abc123', partLabels: { abc123: 'MyPart' }, visibleParts }),
        callbacks,
      )
      expect(findLabel(result.items, 'Hide')).toBeTruthy()
      findLabel(result.items, 'Hide')!.onClick()
      expect(seen).toEqual([['abc123', false]])
      seen.length = 0
    }
  })

  it('shows Show for a hidden body and calls onTogglePartVisibility(id, true)', () => {
    const seen: [string, boolean][] = []
    const callbacks = defaultCallbacks()
    callbacks.onTogglePartVisibility = (partId, visible) => { seen.push([partId, visible]) }
    const result = buildContextMenu(
      defaultInput({
        targetId: 'body:abc123',
        partLabels: { abc123: 'MyPart' },
        visibleParts: new Set(),
      }),
      callbacks,
    )
    expect(findLabel(result.items, 'Show')).toBeTruthy()
    findLabel(result.items, 'Show')!.onClick()
    expect(seen).toEqual([['abc123', true]])
  })

  it('exports a body, falling back to the part number when it has no label', () => {
    const seen: [string, string][] = []
    const callbacks = defaultCallbacks()
    callbacks.onExportPart = (partId, name) => { seen.push([partId, name]) }
    const result = buildContextMenu(defaultInput({ targetId: 'body:b1' }), callbacks)
    findLabel(result.items, 'Export')!.onClick()
    expect(seen).toEqual([['b1', 'part 1']])
  })

  it('opens the color popover on the body at the click point', () => {
    const seen: { partId: string; position: [number, number] }[] = []
    const callbacks = defaultCallbacks()
    callbacks.onSetPartColorPopover = opts => {
      if (opts) seen.push(opts)
    }
    const result = buildContextMenu(
      defaultInput({ targetId: 'body:b1', pos: [12, 34] }),
      callbacks,
    )
    findLabel(result.items, 'Color')!.onClick()
    expect(seen).toEqual([{ partId: 'b1', position: [12, 34] }])
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

  it('enables New Sketch, Normal to, Hide, Suppress, Rename and Delete for a user plane', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'plane1', features, visibleFeatures: new Set(['plane1']) }),
      defaultCallbacks(),
    )
    expect(enabledLabels(result.items)).toEqual([
      'New Sketch', 'Normal to', 'Rebuild', 'Hide', 'Suppress', 'Rename', 'Delete',
    ])
  })

  it('shows Show instead of Hide when a plane is not visible', () => {
    const features = [makeFeature({ id: 'plane1', kind: 'plane' })]
    const result = buildContextMenu(
      defaultInput({ targetId: 'plane1', features, visibleFeatures: new Set() }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Show')).toBeTruthy()
    expect(findLabel(result.items, 'Show')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide')).toBeUndefined()
  })

  it('offers Hide for a helix, which is reference geometry like a sketch', () => {
    const features = [makeFeature({ id: 'hx1', kind: 'helix', helix: {} })]
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleVisibility = (id) => { seen.push(id) }
    const result = buildContextMenu(
      defaultInput({ targetId: 'hx1', features, visibleFeatures: new Set(['hx1']) }),
      callbacks,
    )
    const hide = findLabel(result.items, 'Hide')!
    expect(hide.disabled).toBeFalsy()
    hide.onClick()
    expect(seen).toEqual(['hx1'])
  })

  it('offers Hide for a sweep, whose eye hides the parts it made', () => {
    // The tree and the context menu read one per-kind table, so a body-producing
    // feature must not have the eye in one place and a grey slot in the other.
    const features = [makeFeature({ id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$hx1' } })]
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleVisibility = (id) => { seen.push(id) }
    const result = buildContextMenu(
      defaultInput({ targetId: 'sw1', features, visibleFeatures: new Set(['sw1']) }),
      callbacks,
    )
    const hide = findLabel(result.items, 'Hide')!
    expect(hide.disabled).toBeFalsy()
    hide.onClick()
    expect(seen).toEqual(['sw1'])
  })

  it('requests a body rename carrying the current label', () => {
    const seen: RenameTarget[] = []
    const callbacks = defaultCallbacks()
    callbacks.onRequestRename = t => { seen.push(t) }
    const result = buildContextMenu(
      defaultInput({ targetId: 'body:b1', partLabels: { b1: 'Part1' } }),
      callbacks,
    )
    findLabel(result.items, 'Rename')!.onClick()
    expect(seen).toEqual([{ kind: 'body', id: 'b1', currentName: 'Part1' }])
  })

  // An unlabelled part is named by its number, which is what the user sees in
  // the tree.
  it('falls back to the part number when the body carries no label', () => {
    const seen: RenameTarget[] = []
    const callbacks = defaultCallbacks()
    callbacks.onRequestRename = t => { seen.push(t) }
    const result = buildContextMenu(defaultInput({ targetId: 'body:b1' }), callbacks)
    findLabel(result.items, 'Rename')!.onClick()
    expect(seen[0].currentName).toBe('part 1')
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

  it('calls onDeleteFeature when Delete is clicked', () => {
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onDeleteFeature = id => { seen.push(id) }
    const features = [makeFeature({ id: 'f1', kind: 'extrude' })]
    const result = buildContextMenu(defaultInput({ targetId: 'f1', features }), callbacks)
    findLabel(result.items, 'Delete')!.onClick()
    expect(seen).toEqual(['f1'])
  })

  it('calls onRebuild when Rebuild is clicked', () => {
    let called = false
    const callbacks = defaultCallbacks()
    callbacks.onRebuild = () => { called = true }
    const result = buildContextMenu(defaultInput(), callbacks)
    findLabel(result.items, 'Rebuild')!.onClick()
    expect(called).toBe(true)
  })
})

// A viewport body is resolved from the hover and then the selection, and it
// never outranks the face the same pointer sits on for New Sketch / Normal to:
// a face hover gives both a surface target and a body target.
describe('part board viewport body target', () => {
  it('aims the surface items at the hovered face and the body items at its body', () => {
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onNewSketchOnPlane = query => { seen.push(`sketch:${query}`) }
    callbacks.onAlignToFace = (normal, center) => { seen.push(`face:${normal.join(',')}:${center.join(',')}`) }
    callbacks.onTogglePartVisibility = (partId, visible) => { seen.push(`visibility:${partId}:${visible}`) }
    callbacks.onSetPartColorPopover = opts => { seen.push(`color:${opts?.partId}`) }
    callbacks.onExportPart = (partId, name) => { seen.push(`export:${partId}:${name}`) }
    const result = buildContextMenu(
      defaultInput({
        targetPartId: 'body-1',
        partLabels: { 'body-1': 'Body One' },
        orderedPartIds: ['body-1'],
        hoveredSelectionId: '?faceQ',
        hoveredFaceNormal: [0, 0, 1],
        hoveredFaceCenter: [0, 0, 5],
      }),
      callbacks,
    )
    expect(findLabel(result.items, 'New Sketch')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Normal to')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Color')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Export')!.disabled).toBeFalsy()

    findLabel(result.items, 'New Sketch')!.onClick()
    findLabel(result.items, 'Normal to')!.onClick()
    findLabel(result.items, 'Hide')!.onClick()
    findLabel(result.items, 'Color')!.onClick()
    findLabel(result.items, 'Export')!.onClick()
    expect(seen).toEqual([
      'sketch:?faceQ',
      'face:0,0,1:0,0,5',
      'visibility:body-1:false',
      'color:body-1',
      'export:body-1:Body One',
    ])
  })

  it('greys the body commands when no single body is resolved', () => {
    const result = buildContextMenu(defaultInput({ targetPartId: null }), defaultCallbacks())
    expect(findLabel(result.items, 'Show')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Color')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Export')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Rename')!.disabled).toBe(true)
  })

  it('ignores the viewport body on a tree row, whose own Hide covers it', () => {
    const features = [makeFeature({ id: 'extrude1', kind: 'extrude' })]
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleVisibility = id => { seen.push(`feature:${id}`) }
    callbacks.onTogglePartVisibility = (id, visible) => { seen.push(`part:${id}:${visible}`) }
    const result = buildContextMenu(
      defaultInput({
        targetId: 'extrude1',
        targetPartId: 'body-1',
        features,
        visibleFeatures: new Set(['extrude1']),
      }),
      callbacks,
    )
    expect(findLabel(result.items, 'Color')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Export')!.disabled).toBe(true)
    findLabel(result.items, 'Hide')!.onClick()
    expect(seen).toEqual(['feature:extrude1'])
  })
})

// A flat face is a sketch surface, like a plane.
describe('part board surface target', () => {
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

describe('sketch board commands', () => {
  it('keeps Exit Sketch, Normal to sketch, the sketch Hide and the constraint toggle live', () => {
    const result = buildContextMenu(
      defaultInput({ features: planeAndSketch, visibleFeatures: new Set(['sketch1']), activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(enabledLabels(result.items)).toEqual([
      'Exit Sketch',
      'Normal to sketch',
      'Hide',
      'Hide Constraints',
      'Rebuild',
    ])
  })

  it('shows Show and keeps it live when the edited sketch is not visible', () => {
    const result = buildContextMenu(
      defaultInput({ features: planeAndSketch, visibleFeatures: new Set(), activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide')).toBeUndefined()
    expect(findLabel(result.items, 'Show')!.disabled).toBeFalsy()
  })

  it('still offers the edited sketch Hide when the targeted feature has no eye', () => {
    const features = [
      makeFeature({ id: 'sketch1', kind: 'sketch' }),
      makeFeature({ id: 'Origin', kind: 'origin' }),
    ]
    const result = buildContextMenu(
      defaultInput({
        targetId: 'Origin',
        features,
        visibleFeatures: new Set(['sketch1']),
        activeSketchFeatureId: 'sketch1',
        builtInIds: new Set(['Origin']),
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide')!.disabled).toBeFalsy()
  })

  it('toggles the edited sketch through the feature visibility mutation', () => {
    const seen: string[] = []
    const callbacks = defaultCallbacks()
    callbacks.onToggleVisibility = id => { seen.push(id) }
    const result = buildContextMenu(
      defaultInput({ targetId: 'plane1', features: planeAndSketch, visibleFeatures: new Set(['sketch1']), activeSketchFeatureId: 'sketch1' }),
      callbacks,
    )
    findLabel(result.items, 'Hide')!.onClick()
    expect(seen).toEqual(['sketch1'])
  })

  it('offers Normal to on a plane hovered during sketch edit, without New Sketch', () => {
    const result = buildContextMenu(
      defaultInput({
        features: planeAndSketch,
        activeSketchFeatureId: 'sketch1',
        hoveredSelectionId: '@plane1',
      }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Normal to')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'New Sketch')).toBeUndefined()
  })

  it('greys Normal to on a plane hovered while the selection names another plane', () => {
    // No selection fallback inside a sketch edit: the edited sketch's own plane
    // is the view already offered by Normal to sketch.
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

  it('contains the Hide Constraints toggle during sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({ activeSketchFeatureId: 'sketch1', showConstraintTiles: true }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Hide Constraints')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Show Constraints')).toBeUndefined()
  })

  it('shows Show Constraints when showConstraintTiles is false', () => {
    const result = buildContextMenu(
      defaultInput({ activeSketchFeatureId: 'sketch1', showConstraintTiles: false }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Show Constraints')!.disabled).toBeFalsy()
    expect(findLabel(result.items, 'Hide Constraints')).toBeUndefined()
  })

  it('calls onToggleConstraintTiles when Hide Constraints is clicked', () => {
    let called = false
    const callbacks = defaultCallbacks()
    callbacks.onToggleConstraintTiles = () => { called = true }
    const result = buildContextMenu(
      defaultInput({ activeSketchFeatureId: 'sketch1', showConstraintTiles: true }),
      callbacks,
    )
    findLabel(result.items, 'Hide Constraints')!.onClick()
    expect(called).toBe(true)
  })

  it('greys both freeze slots with no projected target and keeps them in place', () => {
    const result = buildContextMenu(
      defaultInput({ activeSketchFeatureId: 'sketch1', projectedTargetIds: [] }),
      defaultCallbacks(),
    )
    expect(findLabel(result.items, 'Convert to fixed')!.disabled).toBe(true)
    expect(findLabel(result.items, 'Break link (keep free)')!.disabled).toBe(true)
  })

  it('offers Convert to fixed and Break link only for a projected target', () => {
    const callbacks = defaultCallbacks()
    const seen: Array<['fixed' | 'free', readonly string[]]> = []
    callbacks.onFreezeProjection = (mode, targets) => { seen.push([mode, targets]) }
    const result = buildContextMenu(
      defaultInput({
        activeSketchFeatureId: 'sketch1',
        projectedTargetIds: ['entity:sketch1:pe1'],
      }),
      callbacks,
    )
    const fixed = findLabel(result.items, 'Convert to fixed')!
    const free = findLabel(result.items, 'Break link (keep free)')!
    expect(fixed.disabled).toBeFalsy()
    expect(free.disabled).toBeFalsy()
    fixed.onClick()
    free.onClick()
    expect(seen).toEqual([
      ['fixed', ['entity:sketch1:pe1']],
      ['free', ['entity:sketch1:pe1']],
    ])
  })

  it('drops the part-board slots inside sketch edit', () => {
    const result = buildContextMenu(
      defaultInput({ features: planeAndSketch, activeSketchFeatureId: 'sketch1' }),
      defaultCallbacks(),
    )
    for (const label of ['New Sketch', DANGLING, 'Suppress', 'Rename', 'Delete']) {
      expect(findLabel(result.items, label)).toBeUndefined()
    }
  })
})

// The open editor card asks this same predicate before it draws its Rename
// button, so a built-in and the sketch under edit stay off limits at both ends.
describe('canManageFeature', () => {
  const builtIns = new Set(['Top'])

  it('refuses a built-in id', () => {
    expect(canManageFeature('Top', builtIns, undefined)).toBe(false)
  })

  it('refuses the sketch under edit', () => {
    expect(canManageFeature('sketch1', builtIns, 'sketch1')).toBe(false)
  })

  it('allows any other authored feature, including while a sketch is open', () => {
    expect(canManageFeature('ex1', builtIns, 'sketch1')).toBe(true)
    expect(canManageFeature('ex1', builtIns, undefined)).toBe(true)
  })

  it('refuses a menu with no feature target', () => {
    expect(canManageFeature(undefined, builtIns, undefined)).toBe(false)
  })
})
