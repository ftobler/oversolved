import type { Mutation } from '@/types/cad'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- editor schema values are a heterogeneous bag and are intentionally untyped
export type SchemaData = Record<string, any>

// ─── field-definition types (shared between FeatureEditor and widgets) ───

export interface BaseFieldDef {
  key: string
  label: string
  showWhen?: (data: SchemaData) => boolean
}

export interface NumberFieldDef extends BaseFieldDef {
  type: 'number'
  default?: number
  parse?: 'float' | 'int'
  validate?: (v: number) => boolean
  unit?: string
  arrayField?: string
  arrayIndex?: number
  min?: number
}

export interface SelectFieldDef extends BaseFieldDef {
  type: 'select'
  default?: string
  options: { value: string; label: string }[]
}

export interface CheckboxFieldDef extends BaseFieldDef {
  type: 'checkbox'
  default?: boolean
  isChecked?: (data: SchemaData) => boolean
  getMutation?: (checked: boolean, data: SchemaData) => { field: string; value: unknown }
}

export interface PickFieldDef extends BaseFieldDef {
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

export interface TextFieldDef extends BaseFieldDef {
  type: 'text'
  default?: string
  parse?: (value: string) => unknown
  validate?: (parsed: unknown) => boolean
}

export type EditorFieldDef =
  | NumberFieldDef
  | SelectFieldDef
  | CheckboxFieldDef
  | PickFieldDef
  | TextFieldDef

// ─── shared prop fragments ───

export interface WidgetBaseProps {
  fid: string
  onMutation: (m: Mutation) => void
}

export interface NumberFieldWidgetProps extends WidgetBaseProps {
  field: NumberFieldDef
  value: string | number | undefined
  arrayData?: (string | number)[]
  mutationType: string
}

export interface SelectFieldWidgetProps extends WidgetBaseProps {
  field: SelectFieldDef
  value: string | undefined
  mutationType: string
}

export interface CheckboxFieldWidgetProps extends WidgetBaseProps {
  field: CheckboxFieldDef
  data: SchemaData
  mutationType: string
}

export interface TextFieldWidgetProps extends WidgetBaseProps {
  field: TextFieldDef
  value: string | undefined
  mutationType: string
}

export interface PickFieldWidgetProps extends WidgetBaseProps {
  field: PickFieldDef
  data: SchemaData
  mutationPrefix: string
  features?: import('@/types/cad').PartFeature[]
  partLabels?: Record<string, string>
}