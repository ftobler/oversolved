// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// Invariant validation for sketch editor store state.
// Uses the 3-tier guard pattern: throw in test, warn in dev, silent in prod.
//
// HARNESS TIER (user decision 2026-08-05, Option B): this layer is a dev/test
// harness by design, NOT a production guard. The only entry points are the four
// validateWithRepair gates in sketchEditorStore.ts (popMode, setActiveTool,
// setActivePickField, clearDraw), all gated `devOnly || testMode`. There is
// deliberately no production store subscription: a per-mutation validate at the
// write was considered and rejected, because the store is a single-source
// document store and prod carries corruption silently by design. A violation
// that slips past a gate is expected to be caught by the next gate or by a test.

import type { SelectionDomain } from '@/types/cad'
import { drawingToolIds, isDrawingTool } from '@/registry/toolRegistry'

export const devOnly = import.meta.env?.DEV ?? false
export const testMode = import.meta.env?.MODE === 'test'

/**
 * Emit a fail-loud signal when an invariant is violated.
 * Throws in test mode, warns in dev, silent in production.
 */
export function failLoud(message: string): void {
  if (testMode) {
    throw new Error(message)
  }
  if (devOnly) {
    console.warn(message)
  }
}

// Drawing-tool id set, derived from the registry so the draw-state invariants
// can never drift from what initializeTools registered (single source of
// truth). A function because the registry populates after module evaluation.
export const DRAWING_TOOLS = drawingToolIds

// ─── Selection State Invariants ───

export interface SelectionInvariantState {
  normalSelection: Set<string>
  // Live pick refinement: query -> the pickKeys of the primitives selected under
  // it. Every claimed query must still be in normalSelection; an orphan claim
  // would resurrect as a ghost highlight when its query is re-selected.
  selectedPicks: Map<string, Set<string>>
  chipOwnedSelection: Set<string>
  selectionDomain: SelectionDomain
}

// Prefixes that mark an id family as first-class selection input. An id that
// matches none of these (and is not a `?` ancestry query) is rejected by
// isValidSelectionId and dropped by repairSelectionState.
export const KNOWN_SELECTION_PREFIXES = [
  'entity:', 'vertex:', 'face:', 'edge:', 'constraint:', 'dock:', 'isect:',
  'dim:', 'fhandle:',
  '@builtin_', '@body_', '@',
]

function isValidSelectionId(id: string): boolean {
  if (id === '') return false
  for (const p of KNOWN_SELECTION_PREFIXES) {
    if (id.startsWith(p)) return true
  }
  if (id.startsWith('?')) return true
  return false
}

// Sketch-space id families. face:/edge: wrap an inner query when one is
// present (bucketOfId decides those), but live here so a wrapper with no query
// still has a home instead of falling through to mixed. dim:/fhandle: are the
// dimension-label and feature-handle overlay families; they are not real
// selection input (the rubber band filters them), but recognizing them keeps a
// stray overlay key from flipping the domain to mixed or being dropped as
// unrecognized while production still carries it.
const SKETCH_PREFIXES = ['entity:', 'vertex:', 'face:', 'edge:', 'constraint:', 'dock:', 'isect:', 'dim:', 'fhandle:']

// The families deriveSelectionDomain can bucket. Set-equality with
// KNOWN_SELECTION_PREFIXES is enforced by a guard test: an id family accepted
// as valid but missing here falls through to mixed.
export const DERIVE_SELECTION_DOMAIN_PREFIXES = [...SKETCH_PREFIXES, '@builtin_', '@body_', '@']

type DomainBucket = 'sketch' | '3d' | 'plane'

// Bucket one selection id onto the domain axis it lives on. face:/edge: wrap
// an inner query and the prefix is owner attribution only (pickOrder.ts), so
// the wrapped query decides: a wrapped and bare form of one face must never
// read as different domains.
function bucketOfId(id: string): DomainBucket | null {
  if (id.startsWith('face:') || id.startsWith('edge:')) {
    const rest = id.slice(id.indexOf(':') + 1)
    const colon = rest.indexOf(':')
    if (colon >= 0) {
      const inner = bucketOfId(rest.slice(colon + 1))
      if (inner !== null) return inner
    }
  }
  if (id.startsWith('@body_')) return '3d'
  if (id.startsWith('@builtin_origin')) return 'sketch'
  if (id.startsWith('?') || (id.startsWith('@') && id.includes('/'))) return '3d'
  for (const p of SKETCH_PREFIXES) {
    if (id.startsWith(p)) return 'sketch'
  }
  if (id.startsWith('@')) return 'plane'
  return null
}

// Sketch-domain queries never mint per-primitive claims: only b-rep primitives
// carry a pickKey, so a claim under a sketch query is cross-domain garbage.
// bucketOfId is private to the classifier, so reuse it here rather than
// re-deriving the bucket by hand.
function isSketchQuery(query: string): boolean {
  return bucketOfId(query) === 'sketch'
}

// A per-primitive pickKey is `bodyKey#layer#index` (pickKey.ts). The index tail
// is a bare integer; anything else (a query, an overlay key) is not a claim.
function isPickKeyClaim(claim: string): boolean {
  const parts = claim.split('#')
  return parts.length === 3
    && parts[0].length > 0
    && parts[1].length > 0
    && /^\d+$/.test(parts[2])
}

export function deriveSelectionDomain(ids: ReadonlySet<string>): SelectionDomain {
  if (ids.size === 0) return 'sketch_2d'
  let hasSketch = false
  let has3d = false
  let hasPlane = false
  for (const id of ids) {
    const bucket = bucketOfId(id)
    if (bucket === 'sketch') hasSketch = true
    else if (bucket === '3d') has3d = true
    else if (bucket === 'plane') hasPlane = true
  }
  if (hasSketch && !has3d && !hasPlane) return 'sketch_2d'
  if (has3d && !hasSketch && !hasPlane) return 'body_3d'
  if (hasPlane && !hasSketch && !has3d) return 'plane_3d'
  return 'mixed'
}

export function validateSelectionState(state: SelectionInvariantState): void {
  const { normalSelection, selectedPicks, chipOwnedSelection, selectionDomain } = state

  // A chip-owned id outside normalSelection is how a re-click toggle-off is
  // signalled, but it is only ever legal in the gap before usePickField's effect
  // consumes it (that hook fails loud if no consumer can). Anything that reaches
  // a validation gate in this state has stranded the signal.
  for (const v of chipOwnedSelection) {
    if (!normalSelection.has(v)) {
      failLoud(
        `[invariant] chipOwnedSelection has orphan '${v}' not in normalSelection`,
      )
    }
  }

  for (const [q, claims] of selectedPicks.entries()) {
    if (!normalSelection.has(q)) {
      failLoud(
        `[invariant] selectedPicks has orphan claim for query '${q}' not in normalSelection`,
      )
    }
    if (claims.size === 0) {
      failLoud(
        `[invariant] selectedPicks has empty claim set for query '${q}'`,
      )
    }
    // A sketch query has no per-primitive identity, so no claim shape is
    // legitimate under one: a bodyKey#layer#index claim records a b-rep
    // primitive against a 2D selection, and the store mints nothing else for a
    // sketch query (toggleNormalSelection writes claims only when a pickKey is
    // in hand). Any claim here is cross-domain garbage.
    if (isSketchQuery(q)) {
      for (const c of claims) {
        failLoud(
          `[invariant] sketch-domain query '${q}' carries claim '${c}'`,
        )
      }
    }
  }

  // One pickKey identifies exactly one primitive, so two queries claiming it
  // means one of them recorded a foreign claim (a ghost highlight would follow
  // whenever either query is selected).
  {
    const claimedBy = new Map<string, string>()
    for (const [q, claims] of selectedPicks.entries()) {
      for (const c of claims) {
        if (!isPickKeyClaim(c)) continue
        const first = claimedBy.get(c)
        if (first !== undefined && first !== q) {
          failLoud(
            `[invariant] pickKey '${c}' claimed by both '${first}' and '${q}'`,
          )
        } else {
          claimedBy.set(c, q)
        }
      }
    }
  }

  const expected = deriveSelectionDomain(normalSelection)
  if (selectionDomain !== expected) {
    failLoud(
      `[invariant] selectionDomain is '${selectionDomain}' but normalSelection yields '${expected}'`,
    )
  }

  for (const id of normalSelection) {
    if (!isValidSelectionId(id)) {
      failLoud(
        `[invariant] normalSelection contains unrecognized entry '${id}'`,
      )
    }
  }
}

export function repairSelectionState(state: SelectionInvariantState): Partial<SelectionInvariantState> | null {
  const { normalSelection, selectedPicks, chipOwnedSelection, selectionDomain } = state
  const patches: Partial<SelectionInvariantState> = {}

  // Drop unrecognized ids first. Every repair below keys off the surviving
  // selection, and deriving them from the pre-filter set would emit a patch that
  // still fails validation -- the repair must be a fixpoint.
  let live: ReadonlySet<string> = normalSelection
  if (devOnly || testMode) {
    const filtered = new Set<string>()
    for (const id of normalSelection) {
      if (isValidSelectionId(id)) {
        filtered.add(id)
      }
    }
    if (filtered.size !== normalSelection.size) {
      patches.normalSelection = filtered
      live = filtered
    }
  }

  const repairedChip = new Set(chipOwnedSelection)
  for (const v of chipOwnedSelection) {
    if (!live.has(v)) {
      repairedChip.delete(v)
    }
  }
  if (repairedChip.size !== chipOwnedSelection.size) {
    patches.chipOwnedSelection = repairedChip
  }

  let picksChanged = false
  const repairedPicks = new Map(selectedPicks)
  for (const [q, claims] of selectedPicks.entries()) {
    if (!live.has(q) || claims.size === 0) {
      repairedPicks.delete(q)
      picksChanged = true
      continue
    }
    // Same rule as validateSelectionState: a sketch query legitimately carries
    // no claim at all, so strip every claim under it. Stripping all of them
    // always empties the set, so the whole entry is dropped.
    if (isSketchQuery(q)) {
      picksChanged = true
      repairedPicks.delete(q)
    }
  }

  // A pickKey can only be claimed by one query. The first claimant (map order)
  // keeps the key; a later query that re-claims it loses that claim, keeping the
  // repaired state under the duplicate rule. If the stripped set empties, drop
  // the whole entry: a query left in normalSelection with no claim entry is
  // valid, an entry with an empty claim set is not.
  {
    const claimedBy = new Map<string, string>()
    for (const [q, claims] of [...repairedPicks.entries()]) {
      const kept = new Set<string>()
      let stripped = false
      for (const c of claims) {
        if (!isPickKeyClaim(c)) {
          kept.add(c)
          continue
        }
        const first = claimedBy.get(c)
        if (first === undefined || first === q) {
          claimedBy.set(c, q)
          kept.add(c)
        } else {
          stripped = true
        }
      }
      if (stripped) {
        picksChanged = true
        if (kept.size === 0) {
          repairedPicks.delete(q)
        } else {
          repairedPicks.set(q, kept)
        }
      }
    }
  }
  // Size is not a faithful change signal: stripping one claim out of a set
  // keeps the map size while changing its content.
  if (picksChanged) {
    patches.selectedPicks = repairedPicks
  }

  const expectedDomain = deriveSelectionDomain(live)
  if (selectionDomain !== expectedDomain) {
    patches.selectionDomain = expectedDomain
  }

  return Object.keys(patches).length > 0 ? patches : null
}

export interface SketchEditorInvariantState extends SelectionInvariantState {
  activeTool: string | null
  dimensionPicks: unknown[]
  activePickField: { featureId: string; field: string } | null
  drawPoints: unknown[]
  drawHover: unknown
  pendingDialog: unknown
  modeStack: readonly string[]
  // Drag-tool transient state. Only the (effective) drag tool may carry a live
  // or pending drag; a drawing tool arms its own transient state and must never
  // inherit drag residue from the previous tool. Typed loosely on purpose: this
  // module stays free of the store's DragState/SnapTarget imports.
  drag: unknown
  dragPending: unknown
  dragSnap: unknown
  // Brep-projection bookkeeping: ids of projected entities a dimension gesture
  // created on the active sketch. They live only while that gesture is open, so
  // outside the dimension tool the list must be empty or the orphaned ids would
  // outlive the gesture that made them.
  pendingBrepProjectionIds: unknown
}

export function validateSketchEditorState(state: SketchEditorInvariantState): void {
  // Selection invariants
  validateSelectionState(state)

  // Tool invariants
  if (state.dimensionPicks.length > 0 && state.activeTool !== 'dimension') {
    failLoud(
      `[invariant] dimensionPicks has ${state.dimensionPicks.length} entries `
      + `but activeTool is '${state.activeTool}', expected 'dimension'`,
    )
  }

  if (state.activePickField !== null && state.activeTool !== null) {
    failLoud(
      `[invariant] activePickField set ('${state.activePickField.featureId}:${state.activePickField.field}') `
      + `but activeTool is '${state.activeTool}', expected null`,
    )
  }

  const drawingActive = state.activeTool !== null && isDrawingTool(state.activeTool)

  if (state.drawPoints.length > 0 && !drawingActive) {
    failLoud(
      `[invariant] drawPoints has ${state.drawPoints.length} entries `
      + `but activeTool is '${state.activeTool}', not a drawing tool`,
    )
  }

  if (state.drawHover !== null && !drawingActive) {
    failLoud(
      `[invariant] drawHover is set but activeTool is '${state.activeTool}', not a drawing tool`,
    )
  }

  // Mode stack coupling. The top entry names the mode the tool/pick fields
  // describe, so whoever is armed owns the top and a disarmed editor owns
  // nothing. Without this an unpaired activation leaks its entry, which
  // permanently disables popMode's stack-empty validation hook.
  const top = state.modeStack.length > 0 ? state.modeStack[state.modeStack.length - 1] : null

  if (state.activeTool !== null && top !== `tool:${state.activeTool}`) {
    failLoud(
      `[invariant] activeTool is '${state.activeTool}' but modeStack top is '${top}', `
      + `expected 'tool:${state.activeTool}'`,
    )
  }

  if (state.activePickField !== null && top !== 'pick') {
    failLoud(
      `[invariant] activePickField set ('${state.activePickField.featureId}:${state.activePickField.field}') `
      + `but modeStack top is '${top}', expected 'pick'`,
    )
  }

  if (state.activeTool === null && state.activePickField === null && state.modeStack.length > 0) {
    failLoud(
      `[invariant] modeStack is [${state.modeStack.join(', ')}] but no tool or pick field is active`,
    )
  }

  // Drag/snap coupling. Drawing tools place points by click, so a live or
  // pending drag left in their state is stuck residue from a lost gesture (a
  // tool switch does not clear drag state). The dimension and drag tools may
  // legitimately carry a drag (a dimension label or vertex is draggable), so
  // only drawing tools are forbidden from holding one.
  if (state.activeTool !== null && isDrawingTool(state.activeTool)
      && (state.drag !== null || state.dragPending !== null || state.dragSnap !== null)) {
    failLoud(
      `[invariant] drag state (drag/dragPending/dragSnap) is set but activeTool is drawing tool '${state.activeTool}'`,
    )
  }

  // Brep-projection bookkeeping is owned by the dimension gesture. Elsewhere an
  // entry means a projection was materialised but never committed or cancelled.
  const pending = state.pendingBrepProjectionIds as unknown as unknown[]
  if (state.activeTool !== 'dimension' && pending.length > 0) {
    failLoud(
      `[invariant] pendingBrepProjectionIds has ${pending.length} entries but activeTool is '${state.activeTool}', expected 'dimension'`,
    )
  }
}
