// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
// ─── Entity Registry — single source of truth for sketch entity types. ───
//
// Every entity kind recognised by the solver is listed here exactly once.
// Toolbar buttons, vertex definitions, parameter layouts, and documentation
// are all derived from this registry.
//
// To add a new entity type:
//   1. Add an entry to ENTITIES below.
//   2. Add unflatten logic in utils/geometryMapping.ts  (unflattenGeometry).
//   3. Add solver handling in the backend  (solver.py).
//   4. Add rendering in Geometry3D.tsx / SketchSvg.tsx.
//   5. Optionally add an SVG icon in assets/icons/.

import type { ActiveTool } from '@/types/cad'

// ─── Entity definition ───

export interface VertexDef {
  // Vertex key (e.g. "start", "end", "center", "xy").
  key: string
  // Indices into the flat parameter array for [x, y].
  indices: [number, number]
}

export interface EntityDef {
  // Solver kind string — the canonical name used in the AST and solver.
  kind: string

  // Human-readable label shown in toolbar and docs.
  label: string

  // One-line description for documentation.
  description: string

  // Number of scalar parameters in the flat array.
  paramCount: number

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
export const ENTITY_SHORTCUTS: ReadonlyMap<string, string> =
  new Map(
    ENTITIES
      .filter(e => e.shortcut && e.activeTool)
      .map(e => [e.shortcut!, 'set_tool_' + e.activeTool])
  )

// Get default parameters for an entity kind.
export function getDefaultParams(kind: string): number[] {
  return ENTITY_BY_KIND.get(kind)?.defaultParams ?? []
}
