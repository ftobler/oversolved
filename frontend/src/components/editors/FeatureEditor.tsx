import type { LengthUnit, PartFeature, Mutation } from '@/types/cad'
import type {
  SchemaData,
  EditorFieldDef,
  NumberFieldDef,
  SelectFieldDef,
  CheckboxFieldDef,
  PickFieldDef,
  TextFieldDef,
  ReadonlyFieldDef,
} from './widgets/fieldTypes'
import { NumberFieldWidget } from './widgets/NumberField'
import { SelectFieldWidget } from './widgets/SelectField'
import { TabsField } from './widgets/TabsField'
import { CheckboxFieldWidget } from './widgets/CheckboxField'
import { PickFieldWidget } from './widgets/PickField'
import { TextFieldWidget } from './widgets/TextField'
import { UnitLabel } from './widgets/UnitLabel'

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
  // The document's unit, for a field whose quantity is `length`.
  lengthUnit?: LengthUnit
  // The feature's last solve result, for a schema row that shows a solved value
  // (the linear pattern's directive-length spacing) instead of an authored one.
  solved?: unknown
}

// ─── main component ───

export function FeatureEditor({
  feature, onMutation, features, partLabels, schema, lengthUnit = 'mm', solved,
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
            const rawVal = nf.arrayField != null && nf.arrayIndex != null
              ? data[nf.arrayField]?.[nf.arrayIndex]
              : data[field.key]
            return <NumberFieldWidget
              key={`${field.key}:${i}`}
              field={nf}
              value={rawVal as string | number | undefined}
              data={data}
              arrayData={nf.arrayField != null ? arrayFieldData[nf.arrayField] : undefined}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
              lengthUnit={lengthUnit}
            />
          }
          case 'select': {
            const sf = field as SelectFieldDef
            if (sf.presentation === 'tabs') {
              return <TabsField
                key={`${field.key}:${i}`}
                field={sf}
                value={data[field.key] as string | undefined}
                data={data}
                fid={fid}
                onMutation={onMutation}
                mutationType={mutationType}
              />
            }
            return <SelectFieldWidget
              key={`${field.key}:${i}`}
              field={sf}
              value={data[field.key] as string | undefined}
              data={data}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          }
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
          case 'text':
            return <TextFieldWidget
              key={`${field.key}:${i}`}
              field={field as TextFieldDef}
              value={data[field.key]}
              data={data}
              features={features}
              fid={fid}
              onMutation={onMutation}
              mutationType={mutationType}
            />
          case 'readonly': {
            const rf = field as ReadonlyFieldDef
            const shown = rf.value(solved)
            if (shown === null) return null
            return (
              <div className="feature-field-row" key={`${field.key}:${i}`}>
                <span className="feature-field-label">{rf.label}</span>
                <span className="feature-field-value">{shown}</span>
                <UnitLabel quantity={rf.quantity} lengthUnit={lengthUnit} />
              </div>
            )
          }
          default:
            return null
        }
      })}
    </div>
  )
}
