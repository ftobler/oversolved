import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import { ExpressionInput } from './widgets/ExpressionInput'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaData = Record<string, any>

// ─── types ───

interface BaseFieldDef {
  key: string
  label: string
  showWhen?: (data: SchemaData) => boolean
}

interface NumberFieldDef extends BaseFieldDef {
  type: 'number'
  default?: number
  parse?: 'float' | 'int'
  validate?: (v: number) => boolean
  unit?: string
  arrayField?: string
  arrayIndex?: number
  min?: number
}

interface SelectFieldDef extends BaseFieldDef {
  type: 'select'
  default?: string
  options: { value: string; label: string }[]
}

interface CheckboxFieldDef extends BaseFieldDef {
  type: 'checkbox'
  default?: boolean
  isChecked?: (data: SchemaData) => boolean
  getMutation?: (checked: boolean, data: SchemaData) => { field: string; value: unknown }
}

interface PickFieldDef extends BaseFieldDef {
  type: 'pick'
  multi?: boolean
  transform?: (selectionId: string) => string
  validatePick?: (selectionId: string) => boolean
  addMutationType?: string
  addValueKey?: string
  removeMutationType?: string
  removeKey?: string
  removeValueIsIndex?: boolean
  removeValue?: unknown
  emptyText?: string
  normalize?: (value: unknown) => unknown
}

interface TextFieldDef extends BaseFieldDef {
  type: 'text'
  default?: string
  parse?: (value: string) => unknown
  validate?: (parsed: unknown) => boolean
}

type EditorFieldDef = NumberFieldDef | SelectFieldDef | CheckboxFieldDef | PickFieldDef | TextFieldDef

export interface FeatureEditorSchema {
  mutationPrefix: string
  subKey: string
  defaults: SchemaData
  normalize?: (raw: SchemaData) => SchemaData
  fields: EditorFieldDef[]
}

interface FeatureEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
  schema: FeatureEditorSchema
}

// ─── widgets ───

function NumberFieldWidget({
  field, value, arrayData, fid, onMutation, mutationType,
}: {
  field: NumberFieldDef
  value: string | number | undefined
  arrayData?: (string | number)[]
  fid: string
  onMutation: (m: Mutation) => void
  mutationType: string
}) {
  const dv = field.default ?? 0
  const isArraySplice = field.arrayField != null && field.arrayIndex != null
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <ExpressionInput
        value={value ?? dv}
        ariaLabel={field.label}
        unit={field.unit}
        validate={field.validate}
        onChange={(v) => {
          if (isArraySplice && arrayData) {
            const arr = [...arrayData]
            arr[field.arrayIndex!] = v
            onMutation({ type: mutationType, featureId: fid, field: field.arrayField!, value: arr } as Mutation)
          } else {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: v } as Mutation)
          }
        }}
      />
    </div>
  )
}

function SelectFieldWidget({
  field, value, fid, onMutation, mutationType,
}: {
  field: SelectFieldDef
  value: string | undefined
  fid: string
  onMutation: (m: Mutation) => void
  mutationType: string
}) {
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <select
        className="feature-field-select"
        aria-label={field.label}
        value={value ?? field.default ?? field.options[0].value}
        onChange={(e) => {
          e.stopPropagation()
          onMutation({ type: mutationType, featureId: fid, field: field.key, value: e.target.value } as Mutation)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {field.options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}

function CheckboxFieldWidget({
  field, data, fid, onMutation, mutationType,
}: {
  field: CheckboxFieldDef
  data: SchemaData
  fid: string
  onMutation: (m: Mutation) => void
  mutationType: string
}) {
  const checked = field.isChecked ? field.isChecked(data) : (data[field.key] ?? field.default ?? false)

  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="checkbox"
        checked={checked as boolean}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (field.getMutation) {
            const m = field.getMutation(e.target.checked, data)
            onMutation({ type: mutationType, featureId: fid, ...m } as Mutation)
          } else {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: e.target.checked } as Mutation)
          }
        }}
      />
    </div>
  )
}

function PickFieldWidget({
  field, data, fid, onMutation, mutationPrefix, features, partLabels,
}: {
  field: PickFieldDef
  data: SchemaData
  fid: string
  onMutation: (m: Mutation) => void
  mutationPrefix: string
  features?: PartFeature[]
  partLabels?: Record<string, string>
}) {
  const isMulti = field.multi ?? false
  const rawValues: unknown = data[field.key]

  const pickCallback = (selectionId: string) => {
    if (field.validatePick && !field.validatePick(selectionId)) return
    const transformed = field.transform ? field.transform(selectionId) : selectionId

    if (isMulti) {
      const addType = field.addMutationType ?? `add_${mutationPrefix}_${field.key}`
      const valueKey = field.addValueKey ?? field.key
      onMutation({ type: addType, featureId: fid, [valueKey]: transformed } as Mutation)
    } else {
      onMutation({ type: `${mutationPrefix}_field`, featureId: fid, field: field.key, value: transformed } as Mutation)
    }
  }

  const removeMutationType = isMulti
    ? (field.removeMutationType ?? `remove_${mutationPrefix}_${field.key}`)
    : `${mutationPrefix}_field`

  const normalizedValues: string[] = field.normalize
    ? (field.normalize(rawValues) as string[])
    : Array.isArray(rawValues) ? rawValues as string[] : (rawValues ? [rawValues as string] : [])

  const removeAt = (index: number) => {
    if (isMulti) {
      const key = field.removeKey ?? 'index'
      const val = field.removeValueIsIndex === false ? normalizedValues[index] : index
      onMutation({ type: removeMutationType, featureId: fid, [key]: val } as Mutation)
    } else {
      onMutation({ type: removeMutationType, featureId: fid, field: field.key, value: (field.removeValue ?? '') } as Mutation)
    }
  }

  // Re-clicking an already-picked element should remove it. The chip stores the
  // transformed value, so map the toggled-off selectionId back to its index.
  const unpickCallback = (selectionId: string) => {
    const index = normalizedValues.indexOf(selectionId)
    if (index >= 0) removeAt(index)
  }

  const pickState = usePickField(fid, field.key, pickCallback, { multi: isMulti, onUnpick: unpickCallback })

  return (
    <div className="feature-field-row feature-field-row--stacked">
      <span className="feature-field-label">{field.label}</span>
      <PickChip
        values={normalizedValues}
        isPicking={pickState.isPicking}
        onActivate={pickState.toggle}
        onRemove={removeAt}
        onReorder={isMulti
          ? (from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: field.key, fromIndex: from, toIndex: to } as Mutation)
          : undefined
        }
        emptyText={field.emptyText}
        features={features}
        partLabels={partLabels}
      />
    </div>
  )
}

function TextFieldWidget({
  field, value, fid, onMutation, mutationType,
}: {
  field: TextFieldDef
  value: string | undefined
  fid: string
  onMutation: (m: Mutation) => void
  mutationType: string
}) {
  const dv = field.default ?? ''
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="text"
        className="feature-field-input"
        defaultValue={value ?? dv}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const parsed = field.parse ? field.parse(e.target.value) : e.target.value
          if (parsed == null) return
          if (field.validate && !field.validate(parsed)) return
          onMutation({ type: mutationType, featureId: fid, field: field.key, value: parsed } as Mutation)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
    </div>
  )
}

// ─── main component ───

export function FeatureEditor({
  feature, onMutation, features, partLabels, schema,
}: FeatureEditorProps) {
  const fid = feature.id
  const raw = (feature as unknown as SchemaData)[schema.subKey] ?? schema.defaults
  const data: SchemaData = schema.normalize ? schema.normalize(raw) : raw
  const mutationType = `${schema.mutationPrefix}_field`

  const arrayFieldData: Record<string, (string | number)[]> = {}
  for (const f of schema.fields) {
    if (f.type === 'number' && f.arrayField != null) {
      const arr = data[f.arrayField]
      arrayFieldData[f.arrayField] = Array.isArray(arr) ? arr as (string | number)[] : []
    }
  }

  return (
    <div className="plane-editor">
      {schema.fields.map(field => {
        if (field.showWhen && !field.showWhen(data)) return null

        switch (field.type) {
          case 'number': {
            const nf = field as NumberFieldDef
            const rawVal = nf.arrayField != null && nf.arrayIndex != null
              ? data[nf.arrayField]?.[nf.arrayIndex]
              : data[field.key]
            return <NumberFieldWidget
              key={field.key}
              field={nf}
              value={rawVal as string | number | undefined}
              arrayData={nf.arrayField != null ? arrayFieldData[nf.arrayField] : undefined}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          }
          case 'select':
            return <SelectFieldWidget
              key={field.key}
              field={field as SelectFieldDef}
              value={data[field.key] as string | undefined}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          case 'checkbox':
            return <CheckboxFieldWidget
              key={field.key}
              field={field as CheckboxFieldDef}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          case 'pick':
            return <PickFieldWidget
              key={field.key}
              field={field as PickFieldDef}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationPrefix={schema.mutationPrefix}
              features={features}
              partLabels={partLabels}
            />
          case 'text':
            return <TextFieldWidget
              key={field.key}
              field={field as TextFieldDef}
              value={data[field.key] as string | undefined}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          default:
            return null
        }
      })}
    </div>
  )
}
