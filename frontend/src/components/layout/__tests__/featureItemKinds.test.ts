// The edit gate, the editor bodies and the panel's predicate must agree.
// `EDIT_LABELS` is what lets the tree open an editor; the editor body itself
// comes from `EDITOR_SCHEMAS` or one of the bespoke kinds (plane, sketch, STEP
// import); `featureHasEditor` is what the floating FeatureEditPanel asks before
// it draws a frame. A kind the tree opens but no editor body answers would
// strand an edit session with no fields and no OK/Cancel, and a kind with an
// editor body but no edit label is unreachable from the tree. Both are silent
// in production and fail here; a broken bespoke branch inside `editorFor` is
// caught by FeatureEditPanel.test.tsx, which renders each body.
import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { EDIT_LABELS } from '@/components/layout/featureItemKinds'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { featureHasEditor } from '@/components/layout/FeatureItemEditors'
import { BUILTIN_FEATURE_IDS } from '@/components/layout/builtinFeatureIds'

// Kinds whose editor body is bespoke rather than schema-driven
// (FeatureItemEditors.editorFor). `import_step` has no edit label: nothing in
// the tree opens it, but the panel still answers it if a state ever does.
const BESPOKE_EDITOR_KINDS = new Set(['plane', 'sketch', 'import_step'])

function hasOwnSchema(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(EDITOR_SCHEMAS, kind)
}

// A cast, not a literal: the loop's kind is a plain string and PartFeature is a
// discriminated union. featureHasEditor reads only `kind` and `id`.
function featureOfKind(kind: string, id = 'f1'): PartFeature {
  return { id, kind } as unknown as PartFeature
}

describe('edit gate and editor body coverage', () => {
  it('gives every editable kind an editor body to open', () => {
    const missing = Object.keys(EDIT_LABELS)
      .filter(kind => !BESPOKE_EDITOR_KINDS.has(kind) && !hasOwnSchema(kind))
    expect(missing, `editable kinds with no editor body: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps every editor schema reachable from the tree', () => {
    const unreachable = Object.keys(EDITOR_SCHEMAS)
      .filter(kind => !Object.prototype.hasOwnProperty.call(EDIT_LABELS, kind))
    expect(unreachable, `editor schemas with no edit label: ${unreachable.join(', ')}`).toEqual([])
  })

  it('featureHasEditor agrees with the coverage for every editable kind', () => {
    for (const kind of Object.keys(EDIT_LABELS)) {
      expect(featureHasEditor(featureOfKind(kind)), kind).toBe(true)
    }
  })

  it('featureHasEditor reports the kinds the panel must not frame', () => {
    expect(featureHasEditor(featureOfKind('not-a-kind'))).toBe(false)
    expect(featureHasEditor(featureOfKind('origin'))).toBe(false)
    // A built-in plane is never editable, so it has no editor body either.
    const builtInPlaneId = [...BUILTIN_FEATURE_IDS][0]
    expect(featureHasEditor(featureOfKind('plane', builtInPlaneId))).toBe(false)
  })
})
