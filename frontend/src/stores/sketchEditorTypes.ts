// Types and the state interface for sketchEditorStore. Kept apart so the store
// module reads as behavior, and so the pure helper modules can depend on the
// shape without reaching into the store's runtime.
import type { ActiveTool, SelectionDomain } from '@/types/cad'
import type { SnapKind, DimensionPick } from '@/registry'
import type { SnapTarget } from '@/components/Geometry3D/snapDetection'

export interface DialogState {
  position: [number, number]
  label: string
  defaultValue?: string
  onConfirm: (val: string) => void
  onCancel?: () => void
  // Return an error message to reject the input (dialog stays open and shows
  // it); return null to accept. Omit to accept any input.
  validate?: (val: string) => string | null
  // Optional secondary action rendered as an extra button (e.g. "Flip side" on
  // a directional dimension). Runs its handler and closes the dialog; it does
  // not go through `validate`/`onConfirm`.
  extraAction?: { label: string; onClick: () => void }
}

// Dragging a geometry vertex or whole edge.
export interface VertexOrEdgeDrag {
  type: 'vertex' | 'edge'
  vertexId: string  // full composite ID (entity ID for edge drags)
  featureId: string
  entityId: string
  vertexKey: string  // "start" | "end" | "center" | "xy" | "edge"
  startWorld: [number, number]
  currentWorld: [number, number]
  startClient: [number, number]  // screen coordinates at pointer-down (for click-vs-drag distinction)
}

// Dragging a dimension label to reposition it.
export interface DimLabelDrag {
  type: 'dim_label'
  constraintId: string
  featureId: string
  // World-space anchor for the label (midpoint of measured points, center, or vertex).
  anchorWorld: [number, number]
  startWorld: [number, number]
  currentWorld: [number, number]
}

// Dragging a feature editing handle (extrude/fillet/revolve arrow). Unlike the
// sketch drags this lives in world space: the cursor ray is mapped onto the
// handle's 3D axis and the travel converted to a field value via unitScale.
export interface FeatureHandleDrag {
  type: 'feature_handle'
  featureId: string
  field: string
  startValue: number
  currentValue: number
  axisOrigin: [number, number, number]  // world anchor at startValue
  axisDir: [number, number, number]  // unit world drag direction
  unitScale: number  // world units per field unit
  min: number
  max?: number
}

export type DragState = VertexOrEdgeDrag | DimLabelDrag | FeatureHandleDrag

export interface EdgeVertexDragPending {
  type: 'edge' | 'vertex'
  vertexId: string
  featureId: string
  entityId: string
  vertexKey: string
  startWorld: [number, number]
}

export interface DimLabelDragPending {
  type: 'dim_label'
  constraintId: string
  featureId: string
  anchorWorld: [number, number]
  startWorld: [number, number]
}

export interface FeatureHandleDragPending {
  type: 'feature_handle'
  featureId: string
  field: string
  startValue: number
  axisOrigin: [number, number, number]
  axisDir: [number, number, number]
  unitScale: number
  min: number
  max?: number
}

export type DragPendingState = EdgeVertexDragPending | DimLabelDragPending | FeatureHandleDragPending

// The single, store-owned pick-field coordinator (Layer 2 of the selection
// model). When non-null, exactly one feature field is consuming picks. There
// is no parallel plane-pick path: plane selection is just a field like any
// other.
export interface ActivePickField {
  featureId: string
  field: string
  multi?: boolean
}

export interface SketchEditorState {
   // SELECTION SUBSYSTEM
  // Hovered selection, always reflects what entity/face/plane is directly under cursor.
  hoveredSelectionId: string | null
  // Per-primitive pick key of the hovered b-rep primitive (bodyKey#layer#index).
  // Set alongside hoveredSelectionId for edges so hover highlight can isolate the
  // single primitive under the cursor even when its query string is not unique.
  hoveredPickKey: string | null
  // Normal selection, traditional selection, persists until explicitly changed.
  // Query-keyed: the durable/ancestral identity every consumer reads.
  normalSelection: Set<string>
  // Live per-primitive refinement of the b-rep selection: query -> the SET of
  // pickKeys (bodyKey#layer#index) selected under that query. A click records
  // the exact primitive's pickKey here alongside its query in normalSelection,
  // so the viewport highlight isolates the primitives actually clicked even when
  // several of them share a query.
  //
  // A set, not a single key: a query is a many-to-one durable identity (two
  // primitives that earned no construction UUID legitimately share one), so a
  // single key per query made the query the de-facto selection identity and let
  // a second click on a colliding sibling evict the first. Grouping by query
  // still keeps the claims tied to their durable entry, so toggling a query off
  // drops every claim under it and no stale sibling key survives an off/on cycle.
  // Transient: unlike normalSelection it is not persisted and is empty after a
  // re-solve, where the query-keyed fallback takes over (see computeHighlight).
  // Cleared whenever the normal selection is cleared/reset, and by
  // clearSelectedPicks() at the solve seam, because a re-solve can re-tessellate
  // and shift a pickKey's positional index onto a different primitive.
  selectedPicks: Map<string, Set<string>>
  // Derived domain of the current normal selection.
  selectionDomain: SelectionDomain
  isPointerDown: boolean
  setHoveredSelectionId: (id: string | null) => void
  setHoveredPickKey: (key: string | null) => void
  setIsPointerDown: (down: boolean) => void
  clearNormalSelection: () => void
  // Retires the whole selection subsystem AND every hover field at once, for a
  // context change that invalidates both (leaving a sketch).
  // clearNormalSelection covers selection but not hover; resetTransientState
  // covers both but also tears down tools/modes/dialogs a feature-to-feature
  // switch must keep. setActiveFeatureId delegates here so that transition
  // cannot hand-list a subset the way its drag reset once did.
  clearSelectionAndHover: () => void
  // Empties the per-primitive claims WITHOUT touching normalSelection. This is
  // the solve seam hook: a re-solve can shift primitive indices, so the claim a
  // pickKey encodes becomes stale and must not survive. The durable queries stay
  // and computeHighlight re-highlights by membership until the user picks again.
  clearSelectedPicks: () => void
  // Reset every transient interaction field to its create() default, leaving
  // user preferences (showDebugHit, showConstraintTiles, ngonSides,
  // entityKindMap) intact. Called from Part's unmount cleanup: the store is
  // module-level and survives a remount, so a new document would otherwise
  // inherit the previous one's picks, drags, and modes. Deliberately a plain
  // set, not the validation-running actions: it tears down a half-open state,
  // and validating that state would failLoud on the inconsistency being cleared.
  resetTransientState: () => void
  // `pickKey` refines the b-rep highlight to a single primitive; omit it for
  // selections with no per-primitive identity (sketch entities, planes).
  toggleNormalSelection: (id: string, pickKey?: string) => void
  // Add-only: puts `id` into normalSelection and touches nothing else. Unlike
  // toggleNormalSelection it leaves selectedPicks standing, so a pick persisted
  // earlier survives. Pair it with clearNormalSelection for replace semantics
  // (the callers today, useDimInteraction and Constraints.tsx, always do).
  addToNormalSelection: (id: string) => void
  // Replace the whole normal selection with exactly `ids` (the rubber-band
  // box set). A box resolves entities, never primitives, so selectedPicks
  // claims and chip-owned entries the old selection held must not survive.
  // selectionDomain is re-derived from the new set.
  setNormalSelection: (ids: ReadonlySet<string>) => void

  // HOVER STATE
  // Vertex-specific hover data (for snap / visual highlight).
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  // Constraint tile hover, highlights related entities/vertices.
  hoveredConstraintEntityIds: Set<string>
  // Face geometry for the "Normal to" context menu entry.
  hoveredFaceNormal: [number, number, number] | null
  hoveredFaceCenter: [number, number, number] | null
  setHoveredVertex: (id: string | null, position: [number, number] | null, snapKind?: SnapKind | null) => void
  setHoveredConstraintEntities: (ids: Set<string>) => void
  setHoveredFaceGeometry: (normal: [number, number, number] | null, center: [number, number, number] | null) => void

  // DRAG TOOL STATE
  drag: DragState | null
  dragStartClient: [number, number] | null  // screen coordinates at pointer-down, before drag initiated (for lazy initiation)
  dragPending: DragPendingState | null  // pending drag info from onPointerDown, used for lazy initiation
  dragSnap: SnapTarget | null
  alignmentSnapPoint: [number, number] | null
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  setDrag: (drag: DragState | null) => void
  setDragStartClient: (pos: [number, number] | null) => void
  setDragPending: (pending: DragPendingState | null) => void
  setDragSnap: (snap: SnapTarget | null) => void
  setAlignmentSnap: (point: [number, number] | null, kind: 'kinda_horizontal' | 'kinda_vertical' | null) => void
  // Drops a live drag gesture (sketch vertex/edge, dimension label, or feature
  // handle) and its pointer/alignment residue WITHOUT touching the doc: used
  // where the doc is already being replaced (undo), so a pointer-up that
  // arrives afterward finds no drag to commit onto the new doc. Mirrors
  // clearBrepProjectionState's rationale, and the assembly editor's equivalent
  // guard in resetTransientAssemblyState/applyUndoRedo.
  clearDragState: () => void

  // DRAW TOOL STATE
  drawPoints: [number, number][]
  drawHover: [number, number] | null
  drawSnapRefs: (string | null)[]
  addDrawPoint: (pt: [number, number]) => void
  setDrawPoints: (pts: [number, number][]) => void
  setDrawHover: (pt: [number, number] | null) => void
  setDrawSnap: (refs: (string | null)[]) => void
  clearDraw: () => void

  // NAVIGATION SUBSYSTEM
  isRotating: boolean
  setIsRotating: (rotating: boolean) => void

  // MODE STACK, tracks nested editor modes; must be empty when returning to "main"
  modeStack: string[]
  pushMode: (kind: string) => void
  popMode: (expectedKind?: string) => void

  // TOOL / SESSION STATE
  activeTool: ActiveTool
  activeFeatureId: string | null
  // The document origin (0,0,0) expressed in the ACTIVE sketch's local 2D frame.
  // [0,0] for the builtin planes, nonzero for a sketch on an offset or projected
  // face. Mirrors the kernel's `originLocal` so the origin snap can place a draw
  // click at the document origin instead of the plane-frame origin (a different
  // 3D point on a face-based plane). See wasm-kernel/partDocToSketches.ts.
  activeOriginLocal: [number, number]
  setActiveOriginLocal: (p: [number, number]) => void
  showDebugHit: boolean
  showConstraintTiles: boolean
  ngonSides: number  // side count for the two-click n-gon draw tool
  entityKindMap: Record<string, string>
  // Sticky-placement state: the picks the user has made inside the active
  // dimension-tool gesture. Empty until the first click, cleared on tool exit
  // or after the placement dialog closes.
  dimensionPicks: DimensionPick[]
  // Entity ids of projections this dimension gesture created on the active
  // sketch, so an aborted gesture or a replaced pick can delete them without
  // leaving orphans in the doc or the undo history.
  pendingBrepProjectionIds: string[]
  // Abandons the brep dimension gesture: deletes every projection it created
  // (withheld, so no undo entries) and drops the pick/commit pair. Used when
  // the gesture ends without a commit (dialog cancel, tool switch, sketch exit).
  cancelBrepProjectionGesture: () => void
  // Drops the brep gesture bookkeeping without touching the doc. Used where the
  // doc is already being replaced (undo), so no compensating delete is wanted.
  clearBrepProjectionState: () => void
  // Latest cursor position in sketch-local world coords during dim placement.
  // Written by the R3F-side pointermove projection (see Drawing.tsx); read by
  // finalizeDimensionPlacement to fill `pos` on the new constraint so the
  // dim lands at the click point instead of the renderer's default offset.
  dimensionCursorWorld: [number, number] | null
  pendingDialog: DialogState | null
  contextMenu: [number, number] | null
  activePickField: ActivePickField | null
  chipOwnedSelection: Set<string>
  syncChipSelection: (values: string[]) => void
  clearChipSelection: () => void
  setActiveTool: (tool: ActiveTool) => void
  setNgonSides: (n: number) => void
  setActiveFeatureId: (id: string | null) => void
  setShowDebugHit: (enabled: boolean) => void
  setShowConstraintTiles: (show: boolean) => void
  setEntityKindMap: (map: Record<string, string>) => void
  // Returns a human-readable rejection when the selection cannot carry the
  // constraint (incompatible operand kinds), or null when the constraint was
  // authored or there was simply nothing to act on. The caller surfaces the
  // message; a devOnly console.warn reached nobody in a production build.
  applyConstraint: (kind: string) => string | null
  applyOffset: (distance: number) => void
  toggleConstruction: () => void
  deleteSelected: () => void
  openDialog: (opts: DialogState) => void
  closeDialog: () => void
  openContextMenu: (pos: [number, number]) => void
  closeContextMenu: () => void
  addDimensionPick: (pick: DimensionPick) => void
  addBrepDimensionPick: (query: string, opts: { isVertexPick: boolean; sourceKind?: string | null }) => void
  clearDimensionPicks: () => void
  setDimensionCursorWorld: (p: [number, number] | null) => void
  finalizeDimensionPlacement: (clientPos: [number, number]) => void
  setActivePickField: (field: ActivePickField | null) => void
}
