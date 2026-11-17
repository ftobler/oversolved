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
  // How the control is rendered: a dropdown by default, or a tab strip for a
  // field whose choice decides what the feature does (Mirror/Pattern subject,
  // Boolean operation). Data path is unchanged; only the widget differs.
  presentation?: 'tabs'
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
  // What a chip value names: `'body'` means the field names a whole body (a
  // part), so the chip labels it through `bodyPickLabel` instead of treating
  // the stored query as an element pick.
  names?: 'body'
  // The field's own pick rule: null accepts the element; a string is the reason
  // to refuse it, and the text the user sees. The reason travels with the rule,
  // so a refusal cannot misstate what the field accepts. The feature list is
  // the document's own rows, for a rule that must look an entity's kind up (the
  // hole's sketch pick refusing a circle); a caller without it gets a rule that
  // can only judge the id's shape. The form's data is the third argument, for a
  // rule that depends on another field (the linear pattern's pick accepting a
  // face only where the mode reads a direction, not a length).
  validatePick?: (selectionId: string, features?: readonly PartFeature[], data?: SchemaData) => string | null
  addMutationType?: string
  addValueKey?: string
  removeMutationType?: string
  removeKey?: string
  removeValueIsIndex?: boolean
  removeValue?: unknown
  emptyText?: string
  // A one-line explanation under the chip for a field whose meaning is not
  // obvious from its label (the pattern's multi-source seed rule).
  hint?: string
  // The list a field shows when it is assembled from more than its own key
  // (the union's join list is the target followed by the tools). The form's
  // data comes along, because the parts live in sibling fields.
  normalize?: (value: unknown, data: SchemaData) => unknown
  // A word tagged onto the first chip, for a list whose first entry has a
  // different meaning from the rest (the union's base keeps the body identity).
  baseTag?: string
  // Whether the chips can be dragged into a new order. A list whose order has
  // no meaning (the union's join list) turns this off; absent means sortable.
  reorder?: boolean
}

// A feature-to-feature reference chosen from the document's own rows is a plain
// `pick` field: the feature tree writes `@<id>` into normalSelection, the same
// pick path every other chip consumes.

export interface TextFieldDef extends BaseFieldDef {
  type: 'text'
  default?: string
  // Parses the typed text into the stored value; null means the text cannot be
  // read. `parseReason` names why when the rule has its own sentence (the
  // pattern's skip parser does); without it the widget shows "cannot be read".
  parse?: (value: string) => unknown
  parseReason?: (value: string) => string | null
  // Same contract as the number and pick rules: null accepts, a string is
  // the refusal reason.
  validate?: (parsed: unknown) => string | null
  // How a stored value that is not a string is shown while idle (the pattern's
  // skip list is an array). Absent means the value is shown as text.
  format?: (value: unknown) => string
  // A one-line live explanation under the input, for a field whose meaning is
  // computed from the rest of the form (the pattern's instance total). The
  // document's own feature rows come along for a hint that must name a sketch's
  // points (the instance pattern's numbered target list).
  hint?: (data: SchemaData, context: HintContext) => string | null
  // Greyed-out example shown in the empty box, so a field that parses a small
  // grammar does not read as dead before the user types.
  placeholder?: string
  // One-line grammar/help shown as the input's tooltip, built next to the
  // parser so the wording cannot drift from the refusal messages.
  title?: string
}

/** The document context a field hint may read beside the form's own values. */
export interface HintContext {
  features?: readonly import('@/types/cad').PartFeature[]
}

export type EditorFieldDef =
  | NumberFieldDef
  | SelectFieldDef
  | CheckboxFieldDef
  | PickFieldDef
  | TextFieldDef
  | ReadonlyFieldDef

/** A value the solve computed, shown but not edited (the linear pattern's
 *  resolved spacing). `value` reads the feature's last solve result; null hides
 *  the row, which is the state before the first solve. */
export interface ReadonlyFieldDef extends BaseFieldDef {
  type: 'readonly'
  unit?: string
  value: (solved: unknown) => string | null
}

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
  // The stored value, of whatever type the field parses: an array or a number
  // is shown through `field.format`.
  value: unknown
  data?: SchemaData
  features?: readonly import('@/types/cad').PartFeature[]
  mutationType: string
}

export interface PickFieldWidgetProps extends WidgetBaseProps {
  field: PickFieldDef
  data: SchemaData
  mutationPrefix: string
  features?: import('@/types/cad').PartFeature[]
  partLabels?: Record<string, string>
  bodies?: Record<string, import('@/types/cad').BodyResult>
}
