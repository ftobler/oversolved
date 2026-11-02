import type { LengthUnit, PartFeature, Mutation } from '@/types/cad'
import { LENGTH_UNIT_LABEL } from '@/utils/lengthUnit'
import type {
  SchemaData,
  EditorFieldDef,
  NumberFieldDef,
  SelectFieldDef,
  CheckboxFieldDef,
  PickFieldDef,
  FeatureSelectFieldDef,
  TextFieldDef,
} from './widgets/fieldTypes'
import { NumberFieldWidget } from './widgets/NumberField'
import { SelectFieldWidget } from './widgets/SelectField'
import { CheckboxFieldWidget } from './widgets/CheckboxField'
import { PickFieldWidget } from './widgets/PickField'
import { TextFieldWidget } from './widgets/TextField'

// ─── types ───

export type { SchemaData } from './widgets/fieldTypes'

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
  // The document's unit. A schema field marked `unit: 'mm'` is a length in that
  // unit, so its label follows the document without touching the authored value.
  lengthUnit?: LengthUnit
}

// ─── main component ───

export function FeatureEditor({
  feature, onMutation, features, partLabels, schema, lengthUnit = 'mm',
}: FeatureEditorProps) {
  const fid = feature.id
  const raw = (feature as unknown as SchemaData)[schema.subKey] ?? schema.defaults
  const data: SchemaData = schema.normalize ? schema.normalize(raw) : raw
  const mutationType = `${schema.mutationPrefix}_field`

  const arrayFieldData: Record<string, (string | number)[]> = {}
  for (const f of schema.fields) {
    if (f.type === 'number' && f.arrayField != null && f.arrayIndex != null) {
      const arr: (string | number)[] = Array.isArray(data[f.arrayField])
        ? [...data[f.arrayField]] as (string | number)[]
        : []
      // Widgets splice their slot and persist the whole array, so a short or
      // missing source array must be padded to dense length first: splicing a
      // hole serializes as null and NaN-poisons downstream transform math.
      while (arr.length <= f.arrayIndex) arr.push(f.default ?? 0)
      arrayFieldData[f.arrayField] = arr
    }
  }

  return (
    <div className="plane-editor">
      {/* Keyed by `key:index`, not `key` alone: a schema may legitimately repeat
          a field key across rows (transform's translation X/Y/Z all write
          `translation`), and React then treated the three inputs as one. The
          field list is a static schema array, so the index is stable. */}
      {schema.fields.map((field, i) => {
        if (field.showWhen && !field.showWhen(data)) return null

        switch (field.type) {
          case 'number': {
            const nf = field as NumberFieldDef
            // `mm` in a schema marks a length; the label is the document's.
            const labeled = nf.unit === 'mm' ? { ...nf, unit: LENGTH_UNIT_LABEL[lengthUnit] } : nf
            const rawVal = nf.arrayField != null && nf.arrayIndex != null
              ? data[nf.arrayField]?.[nf.arrayIndex]
              : data[field.key]
            return <NumberFieldWidget
              key={`${field.key}:${i}`}
              field={labeled}
              value={rawVal as string | number | undefined}
              data={data}
              arrayData={nf.arrayField != null ? arrayFieldData[nf.arrayField] : undefined}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          }
          case 'select':
            return <SelectFieldWidget
              key={`${field.key}:${i}`}
              field={field as SelectFieldDef}
              value={data[field.key] as string | undefined}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          case 'checkbox':
            return <CheckboxFieldWidget
              key={`${field.key}:${i}`}
              field={field as CheckboxFieldDef}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          case 'pick':
            return <PickFieldWidget
              key={`${field.key}:${i}`}
              field={field as PickFieldDef}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationPrefix={schema.mutationPrefix}
              features={features}
              partLabels={partLabels}
            />
          case 'featureSelect': {
            const fs = field as FeatureSelectFieldDef
            const shown = (data[field.key] as string | undefined) ?? fs.default ?? ''
            // A source must come earlier in the log: showing a later row only
            // promises a feature the kernel will refuse by name.
            const currentAt = (features ?? []).findIndex((f) => f.id === feature.id)
            const options = (features ?? []).filter(
              (f, index) => f.id !== feature.id
                && (currentAt < 0 || index < currentAt)
                && (fs.kinds === undefined || fs.kinds.includes(f.kind)),
            )
            return (
              <div className="feature-field-row" key={`${field.key}:${i}`}>
                <span className="feature-field-label">{fs.label}</span>
                <select
                  className="feature-field-select"
                  aria-label={fs.label}
                  value={shown}
                  onChange={(e) => {
                    e.stopPropagation()
                    onMutation({ type: mutationType, featureId: fid, field: field.key, value: e.target.value } as Mutation)
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="">{fs.emptyText ?? '(pick a feature)'}</option>
                  {options.map((f) => (
                    <option key={f.id} value={`@${f.id}`}>{f.label ?? f.id}</option>
                  ))}
                </select>
              </div>
            )
          }
          case 'text':
            return <TextFieldWidget
              key={`${field.key}:${i}`}
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