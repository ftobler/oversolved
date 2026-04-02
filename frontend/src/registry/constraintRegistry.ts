// ====
// Constraint Registry — single source of truth for all sketch constraints.
//
// Every constraint recognised by the solver is listed here exactly once.
// Toolbar buttons, keyboard shortcuts, icon mapping, dimension-tool detection,
// and documentation pages are all derived from this registry.
//
// To add a new constraint:
//   1. Add an entry to CONSTRAINTS below.
//   2. Add render logic in utils/geometryMapping.ts  (computeConstraintRender).
//   3. Add solver residual in the backend  (solver.py → residuals).
//   4. Optionally add an SVG icon in assets/icons/.
// ====

// -- Constraint definition ----

export interface ConstraintDef {
  // Solver kind string — the canonical name used in the AST and solver.
  kind: string

  // Human-readable label shown in the toolbar tooltip and docs.
  label: string

  // One-line description for auto-generated documentation.
  description: string

  /**
   * Grouping for toolbar layout:
   *   - "geometric"   → symbol constraints (horizontal, coincident, …)
   *   - "dimensional"  → constraints that carry a numeric value (length, radius, …)
   */
  category: 'geometric' | 'dimensional'

  // Whether the constraint stores a numeric `value` (dimensions do).
  hasValue: boolean

  /**
   * How selection targets map to PartConstraint fields:
   *   - "target"   → single entity/vertex → `target`
   *   - "a_b"      → two entities/vertices → `a`, `b`
   *   - "midpoint" → special (line+point or 3 vertices)
   */
  refPattern: 'target' | 'a_b' | 'midpoint'

  /**
   * The render kind returned by computeConstraintRender.
   * Used to look up the correct icon for on-canvas display.
   *   - Symbols: "symbol_h", "symbol_v", "symbol_coincident", …
   *   - Dimensions: "dim_linear", "dim_radius", "dim_diameter", "dim_angle"
   */
  renderKind: string

  /**
   * Icon filename (without path or extension) placed in assets/icons/.
   * Used for the constraint symbol on the canvas.
   * `undefined` means no icon (e.g. angle, which renders as a dimension arc).
   */
  symbolIcon?: string

  /**
   * Icon filename for the toolbar button.
   * `undefined` means the constraint has no dedicated toolbar button
   * (it may still be accessible via the dimension tool or code editor).
   */
  toolbarIcon?: string

  /**
   * Keyboard shortcut (single lowercase key, no modifiers).
   * `undefined` means no shortcut.
   */
  shortcut?: string

  /**
   * If true, this constraint is shown as a direct toolbar button.
   * If false, it may only be reachable via the dimension tool or the code editor.
   */
  showInToolbar: boolean
}

// -- Registry ----

export const CONSTRAINTS: readonly ConstraintDef[] = [
  // ── Geometric constraints ────

  {
    kind: 'horizontal',
    label: 'Horizontal',
    description: 'Constrains a line segment to be horizontal, or two points to share the same Y coordinate.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'target',  // single line, or a/b for two points (overloaded)
    renderKind: 'symbol_h',
    symbolIcon: 'constraint-horizontal',
    toolbarIcon: 'constraint-horizontal',
    shortcut: 'h',
    showInToolbar: true,
  },
  {
    kind: 'vertical',
    label: 'Vertical',
    description: 'Constrains a line segment to be vertical, or two points to share the same X coordinate.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'target',
    renderKind: 'symbol_v',
    symbolIcon: 'constraint-vertical',
    toolbarIcon: 'constraint-vertical',
    shortcut: 'v',
    showInToolbar: true,
  },
  {
    kind: 'coincident',
    label: 'Coincident',
    description: 'Forces two points to occupy the same location.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_coincident',
    symbolIcon: 'constraint-coincident',
    toolbarIcon: 'constraint-coincident',
    shortcut: 'c',
    showInToolbar: true,
  },
  {
    kind: 'concentric',
    label: 'Concentric',
    description: 'Forces two circles or arcs to share the same center point.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_concentric',
    symbolIcon: 'constraint-concentric',
    toolbarIcon: 'constraint-concentric',
    showInToolbar: true,
  },
  {
    kind: 'equal_length',
    label: 'Equal',
    description: 'Forces two line segments to have the same length.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_equal',
    symbolIcon: 'constraint-equal',
    toolbarIcon: 'constraint-equal',
    shortcut: 'e',
    showInToolbar: true,
  },
  {
    kind: 'parallel',
    label: 'Parallel',
    description: 'Forces two line segments to be parallel.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_parallel',
    symbolIcon: 'constraint-parallel',
    toolbarIcon: 'constraint-parallel',
    showInToolbar: true,
  },
  {
    kind: 'normal',
    label: 'Normal',
    description: 'Forces a line to be perpendicular to another line or to the tangent of an arc at its endpoint.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_normal',
    symbolIcon: 'constraint-square',
    toolbarIcon: 'constraint-square',
    shortcut: 'n',
    showInToolbar: true,
  },
  {
    kind: 'tangent',
    label: 'Tangent',
    description: 'Forces a line to be tangent to a circle or arc at the contact point.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_tangent',
    symbolIcon: 'constraint-tangent',
    toolbarIcon: 'constraint-tangent',
    shortcut: 't',
    showInToolbar: true,
  },
  {
    kind: 'midpoint',
    label: 'Midpoint',
    description: 'Forces a point to lie at the midpoint of a line segment. Supports axis restriction (X only, Y only, or both).',
    category: 'geometric',
    hasValue: false,
    refPattern: 'midpoint',
    renderKind: 'symbol_midpoint',
    symbolIcon: 'constraint-midpoint',
    toolbarIcon: 'constraint-midpoint',
    shortcut: 'm',
    showInToolbar: true,
  },
  {
    kind: 'fixed',
    label: 'Fixed',
    description: 'Pins a point to its current (or specified) X/Y coordinates.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'target',
    renderKind: 'symbol_fixed',
    symbolIcon: 'constraint-fixed',
    toolbarIcon: 'constraint-fixed',
    shortcut: 'f',
    showInToolbar: true,
  },
  {
    kind: 'colinear',
    label: 'Colinear',
    description: 'Forces a point to lie on the infinite line defined by a line segment.',
    category: 'geometric',
    hasValue: false,
    refPattern: 'a_b',
    renderKind: 'symbol_colinear',
    symbolIcon: 'constraint-colinear',
    showInToolbar: false,
  },

  // ── Dimensional constraints ────
  // These are normally applied via the "Dimension" tool, which auto-detects
  // the correct kind based on the clicked entity type(s).

  {
    kind: 'length',
    label: 'Length',
    description: 'Sets the length of a line segment to a specific value.',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'target',
    renderKind: 'dim_linear',
    showInToolbar: false,  // accessed via Dimension tool
  },
  {
    kind: 'radius',
    label: 'Radius',
    description: 'Sets the radius of a circle or arc to a specific value.',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'target',
    renderKind: 'dim_radius',
    showInToolbar: false,
  },
  {
    kind: 'diameter',
    label: 'Diameter',
    description: 'Sets the diameter of a circle to a specific value.',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'target',
    renderKind: 'dim_diameter',
    showInToolbar: false,
  },
  {
    kind: 'point_distance',
    label: 'Point Distance',
    description: 'Sets the distance between two points to a specific value.',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'a_b',
    renderKind: 'dim_linear',
    showInToolbar: false,
  },
  {
    kind: 'line_distance',
    label: 'Line Distance',
    description: 'Sets the perpendicular distance from a point to a line to a specific value.',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'a_b',
    renderKind: 'dim_linear',
    showInToolbar: false,
  },
  {
    kind: 'angle',
    label: 'Angle',
    description: 'Sets the angle between two line segments to a specific value (in degrees).',
    category: 'dimensional',
    hasValue: true,
    refPattern: 'a_b',
    renderKind: 'dim_angle',
    symbolIcon: 'constraint-angle',
    showInToolbar: false,
  },
] as const

// -- Dimension tool auto-detection ----
// When the user activates the Dimension tool and clicks entities/vertices,
// these rules determine which constraint kind to create.

export interface DimensionRule {
  // What the user clicks.
  trigger:
    | { type: 'single_entity'; entityKind: string }
    | { type: 'two_vertices' }
    | { type: 'two_lines' }
    | { type: 'two_entities' }
    | { type: 'mixed' }

  // The constraint kind to create.
  constraintKind: string

  // Description for documentation.
  description: string
}

export const DIMENSION_RULES: readonly DimensionRule[] = [
  {
    trigger: { type: 'single_entity', entityKind: 'line' },
    constraintKind: 'length',
    description: 'Click a line segment twice (same line) to set its length.',
  },
  {
    trigger: { type: 'single_entity', entityKind: 'arc' },
    constraintKind: 'radius',
    description: 'Click an arc to set its radius.',
  },
  {
    trigger: { type: 'single_entity', entityKind: 'circle' },
    constraintKind: 'diameter',
    description: 'Click a circle to set its diameter.',
  },
  {
    trigger: { type: 'two_vertices' },
    constraintKind: 'point_distance',
    description: 'Click two points to set the distance between them.',
  },
  {
    trigger: { type: 'two_lines' },
    constraintKind: 'angle',
    description: 'Click two line segments to set the angle between them.',
  },
  {
    trigger: { type: 'two_entities' },
    constraintKind: 'line_distance',
    description: 'Click two entities to set the perpendicular distance between them.',
  },
  {
    trigger: { type: 'mixed' },
    constraintKind: 'line_distance',
    description: 'Click a point and an entity to set the perpendicular distance.',
  },
] as const

// -- Derived lookup tables (computed once at module load) ----

// Map from constraint kind → full definition.
export const CONSTRAINT_BY_KIND: ReadonlyMap<string, ConstraintDef> =
  new Map(CONSTRAINTS.map(c => [c.kind, c]))

// Map from render kind → icon filename (for on-canvas symbols).
export const RENDER_KIND_TO_ICON: Readonly<Record<string, string>> =
  Object.fromEntries(
    CONSTRAINTS
      .filter(c => c.symbolIcon)
      .map(c => [c.renderKind, c.symbolIcon!])
  )

// Constraints that appear as direct toolbar buttons, in display order.
export const TOOLBAR_CONSTRAINTS: readonly ConstraintDef[] =
  CONSTRAINTS.filter(c => c.showInToolbar)

// Map from keyboard shortcut → command name (for commandRegistry integration).
export const CONSTRAINT_SHORTCUTS: ReadonlyMap<string, string> =
  new Map(
    CONSTRAINTS
      .filter(c => c.shortcut)
      .map(c => [c.shortcut!, `apply_${c.kind}`])
  )

/**
 * Resolve the dimension constraint kind for a single-entity click.
 * Returns the constraint kind string, or null if the entity kind
 * is not a valid single-click dimension target (needs two clicks).
 */
export function resolveSingleEntityDimension(entityKind: string): string | null {
  const rule = DIMENSION_RULES.find(
    r => r.trigger.type === 'single_entity' && r.trigger.entityKind === entityKind
  )
  return rule?.constraintKind ?? null
}

/**
 * Resolve the dimension constraint kind for a two-target click.
 * @param firstIsVertex    Whether the first click was on a vertex.
 * @param secondIsVertex   Whether the second click was on a vertex.
 * @param firstEntityKind  Entity kind of the first click (if entity).
 * @param secondEntityKind Entity kind of the second click (if entity).
 */
export function resolveTwoTargetDimension(
  firstIsVertex: boolean,
  secondIsVertex: boolean,
  firstEntityKind?: string,
  secondEntityKind?: string,
): string {
  if (firstIsVertex && secondIsVertex) {
    return DIMENSION_RULES.find(r => r.trigger.type === 'two_vertices')!.constraintKind
  }
  if (!firstIsVertex && !secondIsVertex) {
    if (firstEntityKind === 'line' && secondEntityKind === 'line') {
      return DIMENSION_RULES.find(r => r.trigger.type === 'two_lines')!.constraintKind
    }
    return DIMENSION_RULES.find(r => r.trigger.type === 'two_entities')!.constraintKind
  }
  return DIMENSION_RULES.find(r => r.trigger.type === 'mixed')!.constraintKind
}
