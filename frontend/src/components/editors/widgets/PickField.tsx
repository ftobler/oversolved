import { useMemo } from 'react'
import type { Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PickFieldWidgetProps } from './fieldTypes'
import { StatusMessage } from '@/components/shared/StatusMessage'
import { bodyWantKey, identityWantKey, type PickBatch } from '@/utils/query/pickIntake'
import { partPickLabel } from '@/utils/query/partPickLabel'

export function PickFieldWidget({
  field, data, fid, onMutation, onMutationBatch, mutationPrefix, features, partLabels, parts: bodies,
}: PickFieldWidgetProps) {
  const isMulti = field.multi ?? false
  const rawValues: unknown = data[field.key]

  const normalizedValues: string[] = field.normalize
    ? (field.normalize(rawValues, data) as string[])
    : Array.isArray(rawValues) ? rawValues as string[] : (rawValues ? [rawValues as string] : [])

  const addMutationFor = (selectionId: string): Mutation => {
    const transformed = field.transform ? field.transform(selectionId) : selectionId
    if (isMulti) {
      const addType = field.addMutationType ?? `add_${mutationPrefix}_${field.key}`
      const valueKey = field.addValueKey ?? field.key
      return { type: addType, featureId: fid, [valueKey]: transformed } as Mutation
    }
    return {
      type: `${mutationPrefix}_field`, featureId: fid, field: field.key, value: transformed,
    } as Mutation
  }

  const removeMutationAt = (index: number): Mutation => {
    if (isMulti) {
      const type = field.removeMutationType ?? `remove_${mutationPrefix}_${field.key}`
      const key = field.removeKey ?? 'index'
      const value = field.removeValueIsIndex === false ? normalizedValues[index] : index
      return { type, featureId: fid, [key]: value } as Mutation
    }
    return {
      type: `${mutationPrefix}_field`, featureId: fid, field: field.key, value: (field.removeValue ?? ''),
    } as Mutation
  }

  // One arriving batch is one dispatch: the removes and adds of a lasso land as
  // a single mutation group, so the whole box is one undo step. A host without
  // the group seam (a bare editor render) still applies every mutation.
  const dispatch = (mutations: Mutation[]) => {
    if (mutations.length === 0) return
    if (onMutationBatch) {
      onMutationBatch(mutations)
      return
    }
    for (const mutation of mutations) onMutation(mutation)
  }

  // The hook still documents a single-pick shape for consumers with no identity
  // model; the batch callback below is what an editor field actually uses.
  const pickOne = (selectionId: string) => dispatch([addMutationFor(selectionId)])
  const pickBatch = (intake: PickBatch) => dispatch([
    ...intake.remove.map(removeMutationAt),
    ...intake.add.map(addMutationFor),
  ])

  // The feature's last solve splits the picks that did not apply into two kinds
  // (kernel partial result): `unresolved_edges` matched no current edge (stale,
  // shown struck through -- re-picking is the fix) and `failed_edges` resolved
  // but the modifier refused/skipped them (shown red -- the parameter or
  // geometry is the fix). Values added since the solve simply are not in either
  // set and stay neutral.
  const solveResult = usePartEditorStore(s => s.solveResults?.[fid])
  const storeParts = usePartEditorStore(s => s.parts)
  const pickParts = usePartEditorStore(s => s.pickParts)
  // Body resolution reads the PRE-feature pick layer: in a Delete Part edit the
  // preview has already lost the very part being compared, so the preview's
  // bodies would refuse the pick that removes it. An editor opened with no
  // pick-layer solve (or a host that passes its own bodies) falls back.
  const effectiveParts = bodies ?? (Object.keys(pickParts).length > 0 ? pickParts : storeParts)

  // What the field holds for an arriving pick. A part field wants the body the
  // pick lands on; every other field keeps the stored form of the id, so a
  // transformed field's re-click is compared after the same rewrite its stored
  // value went through.
  const wantKeyOf = useMemo(
    () => (field.names === 'body' ? bodyWantKey(effectiveParts) : identityWantKey(field.transform)),
    [field.names, field.transform, effectiveParts],
  )
  const partLabel = (value: string) => partPickLabel(value, effectiveParts, partLabels, features)

  // The field's own pick rule rides into the hook, which owns both refusal
  // guards and the keep-the-field-open policy for them; this widget only
  // dispatches the mutation for the picks that passed. The form's data rides
  // along as the rule's third argument, for a rule that depends on another
  // field.
  const ownRule = field.validatePick
  const pickState = usePickField(fid, field.key, pickOne, {
    multi: isMulti,
    features,
    held: normalizedValues,
    wantKeyOf,
    labelOf: field.names === 'body' ? partLabel : undefined,
    onPickBatch: pickBatch,
    validatePick: ownRule === undefined
      ? undefined
      : (selectionId, featureRows) => ownRule(selectionId, featureRows, data),
  })
  const { toggle, activate } = pickState

  // Removing a chip arms the field so the user can immediately re-pick the
  // value they just took out (a stale chamfer edge, say) instead of having to
  // click the chip again. The unpick (viewport re-click) path keeps plain
  // removeAt: there the user is already in picking mode.
  const removeAt = (index: number) => onMutation(removeMutationAt(index))
  const removeAndActivate = (index: number) => {
    removeAt(index)
    activate()
  }

  const solveSet = (key: string): ReadonlySet<string> | undefined => {
    if (typeof solveResult !== 'object' || solveResult === null) return undefined
    const raw = (solveResult as Record<string, unknown>)[key]
    return Array.isArray(raw) && raw.length > 0 ? new Set(raw as string[]) : undefined
  }
  // Edge-modifier fields report `unresolved_edges`/`failed_edges`; the shell's
  // face field reports the face-named pair. Union both so one widget serves
  // either, and a feature never carries the other kind's key.
  const union = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined => {
    if (!a) return b
    if (!b) return a
    return new Set([...a, ...b])
  }
  const unresolvedValues = union(solveSet('unresolved_edges'), solveSet('unresolved_faces'))
  const failedValues = union(solveSet('failed_edges'), solveSet('failed_faces'))

  return (
    <div className="feature-field-row feature-field-row--stacked">
      <span className="feature-field-label">{field.label}</span>
      <PickChip
        values={normalizedValues}
        isPicking={pickState.isPicking}
        onActivate={toggle}
        onRemove={removeAndActivate}
        onReorder={isMulti && (field.reorder ?? true)
          ? (from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: field.key, fromIndex: from, toIndex: to } as Mutation)
          : undefined
        }
        emptyText={field.emptyText}
        features={features}
        partLabels={partLabels}
        parts={effectiveParts}
        labelKind={field.names === 'body' ? 'body' : undefined}
        baseTag={field.baseTag}
        unresolvedValues={unresolvedValues}
        failedValues={failedValues}
      />
      {field.hint !== undefined && <span className="feature-field-hint">{field.hint}</span>}
      <StatusMessage mark={pickState.refusal} />
    </div>
  )
}
