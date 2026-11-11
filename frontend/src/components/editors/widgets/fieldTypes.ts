import type { Mutation, PartFeature } from '@/types/cad'

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
  // The field's own value rule, the same contract as `validatePick`: null
  // accepts, a string is the reason the value is refused and what the user
  // sees. Use the shared rules in numberFieldValidate.ts.
  validate?: (v: number) => string | null
  // The same contract for a rule that reads the sibling fields (an array's
  // cells cap needs the other count); runs after `validate`.
  validateWith?: (v: number, data: SchemaData) => string | null
  // `'mm'` marks a LENGTH field: the editor renders it with the document's
  // length unit (`in` for an inch document), never as a fixed millimetre label.
  unit?: string
  arrayField?: string
  arrayIndex?: number
  min?: number
  max?: number
}

export interface SelectFieldDef extends BaseFieldDef {
  type: 'select'
  default?: string
  options: { value: string; label: string }[]
  // The option the control shows, when it is not the stored value itself (a
  // field holding an object has no string to display). Falls back to the stored
  // value, then the default.
  valueFrom?: (data: SchemaData) => string
  // The mutation a selection writes, when it is not the plain
  // `{ field: key, value: option }` write. A select over a table (the hole's
  // thread designations) writes the looked-up record under its own field.
  getMutation?: (option: string, data: SchemaData) => { field: string; value: unknown }
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
  // The field's own pick rule: null accepts the element; a string is the reason
  // to refuse it, and the text the user sees. The reason travels with the rule,
  // so a refusal cannot misstate what the field accepts. The feature list is
  // the document's own rows, for a rule that must look an entity's kind up (the
  // hole's sketch pick refusing a circle); a caller without it gets a rule that
  // can only judge the id's shape.
  validatePick?: (selectionId: string, features?: readonly PartFeature[]) => string | null
  addMutationType?: string
  addValueKey?: string
  removeMutationType?: string
  removeKey?: string
  removeValueIsIndex?: boolean
  removeValue?: unknown
  emptyText?: string
  normalize?: (value: unknown) => unknown
}

// A feature-to-feature reference chosen from the document's own rows, not from
// a viewport pick. The options are the live features (filtered by `kinds`), so
// a pattern can name the extrude it repeats without a second pick surface.
export interface FeatureSelectFieldDef extends BaseFieldDef {
  type: 'featureSelect'
  kinds?: readonly string[]
  default?: string
  emptyText?: string
}

export interface TextFieldDef extends BaseFieldDef {
  type: 'text'
  default?: string
  parse?: (value: string) => unknown
  // Same contract as the number and pick rules: null accepts, a string is
  // the refusal reason.
  validate?: (parsed: unknown) => string | null
}

export type EditorFieldDef =
  | NumberFieldDef
  | SelectFieldDef
  | CheckboxFieldDef
  | PickFieldDef
  | FeatureSelectFieldDef
  | TextFieldDef

// ─── shared prop fragments ───

export interface WidgetBaseProps {
  fid: string
  onMutation: (m: Mutation) => void
}

export interface NumberFieldWidgetProps extends WidgetBaseProps {
  field: NumberFieldDef
  value: string | number | undefined
  data?: SchemaData
  arrayData?: (string | number)[]
  mutationType: string
}

export interface SelectFieldWidgetProps extends WidgetBaseProps {
  field: SelectFieldDef
  value: string | undefined
  data: SchemaData
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
