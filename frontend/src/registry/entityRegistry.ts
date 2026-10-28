// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
// ─── Entity Registry, single source of truth for sketch entity types ───
//
// Every entity kind recognised by the solver is listed here exactly once.
// Toolbar buttons, vertex definitions, parameter layouts, and documentation
// are all derived from this registry.
//
// To add a new entity type:
//   1. Add an entry to ENTITIES below.
//   2. Add unflatten logic in utils/geometryMapping.ts  (unflattenGeometry).
//   3. Add solver handling in the WASM kernel  (sketch solver).
//   4. Add rendering in Geometry3D/.
//   5. Optionally add an SVG icon in assets/icons/.

import type { ActiveTool, EntityKind } from '@/types/cad'
import { narrowCommandName, type CommandName } from '@/utils/core/commandNames'

// ─── Entity definition ───

export interface VertexDef {
  // Vertex key (e.g. "start", "end", "center", "xy").
  key: string
  // Indices into the flat parameter array for [x, y].
  indices: [number, number]
}

export interface EntityDef {
  // Solver kind string, the canonical name the document and the solver share.
  kind: string

  // Human-readable label shown in toolbar and docs.
  label: string

  // One-line description for documentation.
  description: string

  // Number of scalar parameters in the flat array. For a variable-size kind
  // this is the MINIMUM (`fit_spline`: two points, no handles); the layout
  // helper computes the real count from the authored points and handles.
  paramCount: number

  // True when `paramCount` is only a floor: the entity's real block depends on
  // authored data (`fit_spline`'s fit-point count and handles).
  variableParams?: boolean

  // Default parameter values when no initial data exists.
  defaultParams: number[]

  // Named vertices and their parameter indices.
  vertices: VertexDef[]

  /**
   * Coordinate pairs to translate when moving the whole entity.
   * Each entry is [xIndex, yIndex] into the flat parameter array.
   */
  coordPairs: [number, number][]

  /**
   * The ActiveTool value that triggers drawing this entity.
   * `undefined` for entities that cannot be drawn interactively (e.g. construction-only).
   */
  activeTool?: ActiveTool

  /**
   * Keyboard shortcut key string for activating this tool (e.g. "l" for line).
   * Must not conflict with constraint shortcuts or CORE_KEYMAP entries.
   * Omit for entities that should not have a keyboard shortcut.
   */
  shortcut?: string

  // Icon filename (without path/extension) for the toolbar button.
  toolbarIcon?: string

  // Whether this entity type shows in the drawing toolbar.
  showInToolbar: boolean
}

// ─── Registry ───

export const ENTITIES: readonly EntityDef[] = [
  {
    kind: 'line',
    label: 'Line',
    description: 'A straight line segment defined by two endpoints.',
    paramCount: 4,
    defaultParams: [0, 0, 0, 0],
    vertices: [
      { key: 'start', indices: [0, 1] },
      { key: 'end',   indices: [2, 3] },
    ],
    coordPairs: [[0, 1], [2, 3]],
    activeTool: 'line',
    shortcut: 'l',
    toolbarIcon: 'toolbar-line',
    showInToolbar: true,
  },
  {
    kind: 'circle',
    label: 'Circle',
    description: 'A full circle defined by center and radius.',
    paramCount: 3,
    defaultParams: [0, 0, 0],
    vertices: [
      { key: 'center', indices: [0, 1] },
    ],
    coordPairs: [[0, 1]],
    activeTool: 'circle',
    shortcut: 'o',
    toolbarIcon: 'toolbar-circle',
    showInToolbar: true,
  },
  {
    kind: 'arc',
    label: 'Arc',
    description: 'A circular arc defined by center, radius, start angle, and end angle (in degrees).',
    paramCount: 5,
    defaultParams: [0, 0, 0, 0, 0],
    vertices: [
      { key: 'center', indices: [0, 1] },
    ],
    coordPairs: [[0, 1]],
    activeTool: 'arc',
    shortcut: 'a',
    toolbarIcon: 'toolbar-arc',
    showInToolbar: true,
  },
  {
    kind: 'ellipse',
    label: 'Ellipse',
    description: 'An ellipse defined by center, semi-major and semi-minor radii, and rotation.',
    paramCount: 5,
    defaultParams: [0, 0, 0, 0, 0],
    vertices: [
      { key: 'center', indices: [0, 1] },
    ],
    coordPairs: [[0, 1]],
    activeTool: 'ellipse',
    // No keyboard shortcut: 'e' is taken by the equal_length constraint and the
    // add_extrude command, and there is no free mnemonic key. Toolbar only.
    toolbarIcon: 'toolbar-ellipse',
    showInToolbar: true,
  },
  {
    kind: 'spline',
    label: 'Bezier',
    description: 'A cubic Bezier spline defined by four control points.',
    paramCount: 8,
    defaultParams: [0, 0, 0, 0, 0, 0, 0, 0],
    vertices: [
      { key: 'start', indices: [0, 1] },
      { key: 'c1',    indices: [2, 3] },
      { key: 'c2',    indices: [4, 5] },
      { key: 'end',   indices: [6, 7] },
    ],
    coordPairs: [[0, 1], [2, 3], [4, 5], [6, 7]],
    activeTool: 'spline',
    toolbarIcon: 'toolbar-spline',
    showInToolbar: true,
  },
  {
    kind: 'fit_spline',
    label: 'Spline',
    description: 'An interpolating spline through N fit points, with optional end handles.',
    // Minimum block: two fit points, no handles. The real count is
    // `2 N + 2 h`; see `fitSplineVertices`.
    paramCount: 4,
    variableParams: true,
    defaultParams: [0, 0, 1, 1],
    vertices: [],
    coordPairs: [],
    activeTool: 'fit_spline',
    shortcut: 's',
    toolbarIcon: 'toolbar-fit-spline',
    showInToolbar: true,
  },
  {
    kind: 'point',
    label: 'Point',
    description: 'A free point in the sketch plane.',
    paramCount: 2,
    defaultParams: [0, 0],
    vertices: [
      { key: 'xy', indices: [0, 1] },
    ],
    coordPairs: [[0, 1]],
    activeTool: 'point',
    toolbarIcon: 'toolbar-point',
    showInToolbar: true,
  },
  {
    // The project tool produces a base-kind entity (line/circle/arc/point)
    // carrying a `source` query; projection is not a distinct entity kind. This
    // entry exists only to register the tool's shortcut and toolbar metadata.
    kind: 'project',
    label: 'Project',
    description: 'Project geometry from another sketch onto this sketch plane.',
    paramCount: 4,
    defaultParams: [0, 0, 0, 0],
    vertices: [],
    coordPairs: [[0, 1], [2, 3]],
    activeTool: 'project',
    shortcut: 'j',
    toolbarIcon: 'toolbar-project',
    showInToolbar: false,  // Dedicated ProjectTool component handles toolbar rendering.
  },
] as const

// ─── Derived lookup tables (computed once at module load) ───

// Map from entity kind → full definition.
export const ENTITY_BY_KIND: ReadonlyMap<string, EntityDef> =
  new Map(ENTITIES.map(e => [e.kind, e]))

// Map from activeTool value → entity definition.
export const ENTITY_BY_ACTIVE_TOOL: ReadonlyMap<string, EntityDef> =
  new Map(
    ENTITIES
      .filter(e => e.activeTool)
      .map(e => [e.activeTool!, e])
  )

// Map from entity kind → vertex key → [xIndex, yIndex].
export const VERTEX_INDICES: Readonly<Record<string, Record<string, [number, number]>>> =
  Object.fromEntries(
    ENTITIES.map(e => [
      e.kind,
      Object.fromEntries(e.vertices.map(v => [v.key, v.indices])),
    ])
  )

// Map from entity kind → array of [xIndex, yIndex] coordinate pairs.
export const ALL_COORD_INDICES: Readonly<Record<string, [number, number][]>> =
  Object.fromEntries(
    ENTITIES.map(e => [e.kind, e.coordPairs])
  )

// Entities that appear as toolbar drawing buttons, in display order.
export const TOOLBAR_ENTITIES: readonly EntityDef[] =
  ENTITIES.filter(e => e.showInToolbar)

// Map from keyboard shortcut → command name (for commandRegistry integration).
export const ENTITY_SHORTCUTS: ReadonlyMap<string, CommandName> =
  new Map(
    ENTITIES
      .filter(e => e.shortcut && e.activeTool)
      .map(e => [e.shortcut!, narrowCommandName('set_tool_' + e.activeTool)])
  )

// Get default parameters for an entity kind.
export function getDefaultParams(kind: string): number[] {
  return ENTITY_BY_KIND.get(kind)?.defaultParams ?? []
}

// The flat seed-parameter order `add_entity` writes, in solver order. Named
// per slot so an authoring catalog can say what each number means without
// reading the solver; the names are the solver's own terms. Arc and ellipse
// angles are degrees, and an arc sweeps counter-clockwise from a0_deg to
// a1_deg. `project` is absent because it is a tool registration, not an entity
// kind. Keyed by the EntityKind union so a new kind fails to compile until its
// layout is named here; a test pins each length to the registry's paramCount.
export const ENTITY_PARAM_LAYOUT: Record<EntityKind, readonly string[]> = {
  line: ['x1', 'y1', 'x2', 'y2'],
  circle: ['cx', 'cy', 'r'],
  arc: ['cx', 'cy', 'r', 'a0_deg', 'a1_deg'],
  ellipse: ['cx', 'cy', 'a', 'b', 'theta_deg'],
  spline: ['x1', 'y1', 'c1x', 'c1y', 'c2x', 'c2y', 'x2', 'y2'],
  // Variable: `x0, y0, ..., xN-1, yN-1` then the optional `c1x, c1y` and
  // `c2x, c2y`; the layout's length is the two-point minimum.
  fit_spline: ['x0', 'y0', 'x1', 'y1'],
  point: ['x', 'y'],
}

/** Every entity kind's params slot list on one line, for the mutation catalog
 *  and the docs: `line [x1, y1, x2, y2]; circle [cx, cy, r]; ...`. A variable
 *  kind's list is its minimum block, so `fit_spline` also names the authored
 *  point range and the optional handle slots. */
export function entityParamLayoutsSentence(): string {
  return (Object.keys(ENTITY_PARAM_LAYOUT) as EntityKind[])
    .map(kind => {
      const slots = ENTITY_PARAM_LAYOUT[kind].join(', ')
      if (kind !== 'fit_spline') return `${kind} [${slots}]`
      return `${kind} [${slots}] (2..64 fit points, then the optional c1x, c1y and c2x, c2y handles)`
    })
    .join('; ')
}

/** Which end handles a fit-spline block carries, from its wire flag bits
 *  (`lowerSketch` writes bit0 start, bit1 end; the Rust codec uses the same
 *  encoding). */
export function fitSplineHandlesFromFlags(flags: number): 'start' | 'end' | 'both' | undefined {
  const hasStart = (flags & 1) !== 0
  const hasEnd = (flags & 2) !== 0
  if (hasStart && hasEnd) return 'both'
  return hasStart ? 'start' : hasEnd ? 'end' : undefined
}

/** The named vertices and coordinate pairs of a fit spline with `nPoints` fit
 *  points and the given end handles. The registry's own lists are empty because
 *  the layout depends on the authored point count. */
export function fitSplineVertices(
  nPoints: number,
  handles?: 'start' | 'end' | 'both',
): { vertices: VertexDef[]; coordPairs: [number, number][] } {
  const vertices: VertexDef[] = []
  const coordPairs: [number, number][] = []
  const push = (key: string, index: number): void => {
    vertices.push({ key, indices: [2 * index, 2 * index + 1] })
    coordPairs.push([2 * index, 2 * index + 1])
  }
  push('start', 0)
  for (let k = 1; k < nPoints - 1; k++) push(`fit${k}`, k)
  push('end', nPoints - 1)
  let next = 2 * nPoints
  if (handles === 'start' || handles === 'both') {
    vertices.push({ key: 'c1', indices: [next, next + 1] })
    coordPairs.push([next, next + 1])
    next += 2
  }
  if (handles === 'end' || handles === 'both') {
    vertices.push({ key: 'c2', indices: [next, next + 1] })
    coordPairs.push([next, next + 1])
  }
  return { vertices, coordPairs }
}

/** The fit-point count of a block of `nParams` scalars carrying `handles`, or
 *  null when the block cannot be one (`2 N + 2 h` with `N >= 2`). */
function fitSplinePointCount(
  nParams: number,
  handles?: 'start' | 'end' | 'both',
): number | null {
  const handleCount = handles === 'both' ? 2 : handles === 'start' || handles === 'end' ? 1 : 0
  const remaining = nParams - 2 * handleCount
  if (remaining < 4 || remaining % 2 !== 0) return null
  return remaining / 2
}

/** The vertex-key -> [xIndex, yIndex] map of ONE entity instance. A static kind
 *  reads its registry row; a `fit_spline` derives its positional `start`,
 *  `fit<k>`, `end` and `c1`/`c2` keys from the block length and handles, which
 *  is the only place its point count exists. Undefined for an unknown kind or a
 *  malformed block, so a caller keeps its existing "no such vertex" path. */
export function entityVertexIndices(
  kind: string,
  nParams?: number,
  handles?: 'start' | 'end' | 'both',
): Record<string, [number, number]> | undefined {
  if (kind === 'fit_spline') {
    const n = nParams === undefined ? null : fitSplinePointCount(nParams, handles)
    if (n === null) return undefined
    return Object.fromEntries(fitSplineVertices(n, handles).vertices.map(v => [v.key, v.indices]))
  }
  return VERTEX_INDICES[kind]
}

/** The coordinate pairs to translate for ONE entity instance, the instance-aware
 *  counterpart of `ALL_COORD_INDICES` (`fit_spline` again derives them). */
export function entityCoordPairs(
  kind: string,
  nParams?: number,
  handles?: 'start' | 'end' | 'both',
): [number, number][] | undefined {
  if (kind === 'fit_spline') {
    const n = nParams === undefined ? null : fitSplinePointCount(nParams, handles)
    if (n === null) return undefined
    return fitSplineVertices(n, handles).coordPairs
  }
  return ALL_COORD_INDICES[kind]
}
