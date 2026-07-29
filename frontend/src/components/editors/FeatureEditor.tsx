import type { PartFeature, Mutation } from '@/types/cad'
import type {
  SchemaData,
  EditorFieldDef,
  NumberFieldDef,
  SelectFieldDef,
  CheckboxFieldDef,
  PickFieldDef,
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