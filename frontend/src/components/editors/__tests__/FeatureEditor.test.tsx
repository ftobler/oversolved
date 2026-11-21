import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import type { FeatureEditorSchema } from '@/components/editors/FeatureEditor'
import { EXTRUDE_SCHEMA, FILLET_SCHEMA, VARIABLE_SCHEMA, BOOLEAN_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { ExtrudeFeature, PartFeature, Mutation } from '@/types/cad'
import { useState } from 'react'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'
import { useEditorState } from '@/hooks/useEditorState'

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
    chipOwnedSelection: new Set(),
  })
  usePartEditorStore.setState({ solveResults: {} })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture type; schema values are heterogeneous
type SchemaData = Record<string, any>

function makeFeature(kind: string, subKey: string, data: SchemaData): PartFeature {
  return { id: 'f1', kind, [subKey]: data } as PartFeature
}

// ─── number fields ───

describe('FeatureEditor number field', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { count: 5 },
    fields: [{ type: 'number', key: 'count', label: 'Count', default: 5, quantity: 'count' }],
  }

  it('renders number input with default value', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { count: 10 })} onMutation={vi.fn()} schema={schema} />)
    expect(screen.getByDisplayValue('10')).toBeInTheDocument()
  })

  it('renders default when data is missing', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', {})} onMutation={vi.fn()} schema={schema} />)
    expect(screen.getByDisplayValue('5')).toBeInTheDocument()
  })

  it('dispatches onMutation on blur with valid value', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { count: 10 })} onMutation={onMutation} schema={schema} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'count', value: 25 })
  })

  it('does not dispatch for non-positive value when validate rejects', () => {
    const validatedSchema: FeatureEditorSchema = {
      ...schema,
      fields: [{ type: 'number', key: 'count', label: 'Count', default: 5, quantity: 'count', validate: (v) => (v > 0 ? null : 'must be greater than 0') }],
    }
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { count: 10 })} onMutation={onMutation} schema={validatedSchema} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('renders the document unit on a length field', () => {
    const unitSchema: FeatureEditorSchema = {
      ...schema,
      fields: [{ type: 'number', key: 'diam', label: 'Diameter', default: 10, quantity: 'length' }],
    }
    render(<FeatureEditor feature={makeFeature('test', 'test', { diam: 10 })} onMutation={vi.fn()} schema={unitSchema} />)
    expect(screen.getByText('mm')).toBeInTheDocument()
  })

  it('follows the document unit on a length field without touching the value', () => {
    const unitSchema: FeatureEditorSchema = {
      ...schema,
      fields: [{ type: 'number', key: 'diam', label: 'Diameter', default: 10, quantity: 'length' }],
    }
    render(
      <FeatureEditor
        feature={makeFeature('test', 'test', { diam: 0.5 })}
        onMutation={vi.fn()}
        schema={unitSchema}
        lengthUnit="inch"
      />,
    )
    expect(screen.getByDisplayValue('0.5')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
    expect(screen.queryByText('mm')).not.toBeInTheDocument()
  })

  it('keeps the unit of a read-only row in the text, since no input says it', () => {
    // A number input's accessible name carries the unit, so its adornment is
    // aria-hidden. The solved-value row has no input: hiding its unit would drop
    // "mm" from the only place the reader hears it.
    const readonlySchema: FeatureEditorSchema = {
      mutationPrefix: 'set_test', subKey: 'test', defaults: {},
      fields: [{ type: 'readonly', key: 'resolved', label: 'Spacing', quantity: 'length', value: () => '12.5' }],
    }
    render(<FeatureEditor feature={makeFeature('test', 'test', {})} onMutation={vi.fn()} schema={readonlySchema} />)
    const unit = screen.getByText('mm')
    expect(unit.getAttribute('aria-hidden')).toBeNull()
    const row = unit.closest('.feature-field-row')!
    expect(row.textContent).toContain('Spacing')
    expect(row.textContent).toContain('12.5')
  })

  it('keeps a degree label independent of the document length unit', () => {
    const angleSchema: FeatureEditorSchema = {
      ...schema,
      fields: [{ type: 'number', key: 'angle', label: 'Angle', default: 45, quantity: 'angle' }],
    }
    render(
      <FeatureEditor
        feature={makeFeature('test', 'test', { angle: 45 })}
        onMutation={vi.fn()}
        schema={angleSchema}
        lengthUnit="inch"
      />,
    )
    expect(screen.getByText('deg')).toBeInTheDocument()
  })

  it('dispatches Enter key blur', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { count: 10 })} onMutation={onMutation} schema={schema} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'count', value: 30 })
  })
})

// ─── select fields ───

describe('FeatureEditor select field', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { mode: 'a' },
    fields: [{ type: 'select', key: 'mode', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
  }

  it('renders select with options', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { mode: 'a' })} onMutation={vi.fn()} schema={schema} />)
    expect(screen.getByDisplayValue('A')).toBeInTheDocument()
  })

  it('dispatches onMutation on change', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { mode: 'a' })} onMutation={onMutation} schema={schema} />)
    fireEvent.change(screen.getByDisplayValue('A'), { target: { value: 'b' } })
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'mode', value: 'b' })
  })
})

// ─── checkbox fields ───

describe('FeatureEditor checkbox field', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: {},
    fields: [{ type: 'checkbox', key: 'enabled', label: 'Enabled', default: false }],
  }

  it('renders checkbox unchecked', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { enabled: false })} onMutation={vi.fn()} schema={schema} />)
    const cb = screen.getByRole('checkbox') as HTMLInputElement
    expect(cb.checked).toBe(false)
  })

  it('renders checkbox checked when value is true', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { enabled: true })} onMutation={vi.fn()} schema={schema} />)
    const cb = screen.getByRole('checkbox') as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  it('dispatches onMutation on change', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { enabled: false })} onMutation={onMutation} schema={schema} />)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'enabled', value: true })
  })
})

// ─── pick fields ───

describe('FeatureEditor pick field', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { body: '' },
    fields: [{ type: 'pick', key: 'body', label: 'Body' }],
  }

  it('renders empty PickChip when value is empty', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { body: '' })} onMutation={vi.fn()} schema={schema} />)
    expect(document.querySelector('.feature-pick-chip.empty')).toBeTruthy()
  })

  it('renders value in PickChip when set', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { body: '@body_1' })} onMutation={vi.fn()} schema={schema} />)
    const chip = document.querySelector('.feature-pick-chip-item-text')
    expect(chip?.textContent).toBe('@body_1')
  })

  it('toggles picking state on chip click', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { body: '' })} onMutation={vi.fn()} schema={schema} />)
    const chip = document.querySelector('.feature-pick-chip')!
    expect(chip.classList.contains('picking')).toBe(false)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(true)
    fireEvent.click(chip)
    expect(chip.classList.contains('picking')).toBe(false)
  })

  it('marks chips red whose edge the modifier refused', () => {
    // A pick that resolved but whose fillet/chamfer the kernel refused (kernel
    // `failed_edges`) renders red, distinct from a stale pick.
    usePartEditorStore.setState({
      solveResults: { f1: { status: 'partial', failed_edges: ['@edge_refused'] } },
    })
    render(
      <FeatureEditor
        feature={makeFeature('fillet', 'fillet', { edges: ['@edge_ok', '@edge_refused'], radius: 1 })}
        onMutation={vi.fn()}
        schema={FILLET_SCHEMA}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(2)
    expect(items[0].classList.contains('failed')).toBe(false)
    expect(items[1].classList.contains('failed')).toBe(true)
  })

  it('strikes through chips the last solve could not resolve', () => {
    // A stale pick (kernel `unresolved_edges`) must be struck through, distinct
    // from a resolved-but-refused edge (failed_edges).
    usePartEditorStore.setState({
      solveResults: { f1: { status: 'partial', unresolved_edges: ['@edge_gone'] } },
    })
    render(
      <FeatureEditor
        feature={makeFeature('fillet', 'fillet', { edges: ['@edge_ok', '@edge_gone'], radius: 1 })}
        onMutation={vi.fn()}
        schema={FILLET_SCHEMA}
      />
    )
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(2)
    expect(items[0].classList.contains('unresolved')).toBe(false)
    expect(items[1].classList.contains('unresolved')).toBe(true)
    expect(items[1].classList.contains('failed')).toBe(false)
  })
})

// ─── boolean union join list ───

describe('FeatureEditor boolean union picker', () => {
  const unionFeature = (operation: string) => makeFeature('boolean', 'boolean', {
    operation, target: '@body_a', tools: ['@body_b'],
  })

  it('shows one Parts to join list, base first, instead of target plus tools', () => {
    render(<FeatureEditor feature={unionFeature('union')} onMutation={vi.fn()} schema={BOOLEAN_SCHEMA} />)
    expect(screen.getByText('Parts to join')).toBeInTheDocument()
    expect(screen.queryByText('Target')).toBeNull()
    expect(screen.queryByText('Tools')).toBeNull()
    const items = document.querySelectorAll('.feature-pick-chip-item')
    expect(items.length).toBe(2)
    expect(items[0].querySelector('.feature-pick-chip-item-tag')?.textContent).toBe('base')
    expect(items[1].querySelector('.feature-pick-chip-item-tag')).toBeNull()
    // No drag handles: the join list's order carries no meaning.
    expect(document.querySelector('.feature-pick-chip-item-drag')).toBeNull()
  })

  it('keeps the labelled target and tools fields for subtract', () => {
    render(<FeatureEditor feature={unionFeature('subtract')} onMutation={vi.fn()} schema={BOOLEAN_SCHEMA} />)
    expect(screen.getByText('Target')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.queryByText('Parts to join')).toBeNull()
    expect(document.querySelector('.feature-pick-chip-item-tag')).toBeNull()
  })

  it('sends a viewport pick on the join list to the boolean tool mutation', () => {
    const onMutation = vi.fn()
    // A body pick resolves against the pick layer, which is where the field
    // learns which body the picked ref names.
    usePartEditorStore.setState({
      pickParts: { body_a: { id: 'body_a', created_by: 'ex1', modified_by: [] } },
    })
    render(
      <FeatureEditor
        feature={makeFeature('boolean', 'boolean', { operation: 'union', target: '', tools: [] })}
        onMutation={onMutation}
        schema={BOOLEAN_SCHEMA}
      />,
    )
    const chip = document.querySelector('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'f1', field: 'tools', multi: true, names: 'body' })
    act(() => { useEditorState.setState({ normalSelection: new Set(['@body_a']) }) })
    // One mutation per pick: the applier turns the first one into the base.
    expect(onMutation).toHaveBeenCalledWith({ type: 'add_boolean_tool', featureId: 'f1', tool: '@body_a' })
  })

  it('labels each joined body by its part name and follows a rename', () => {
    // The field is body-typed, so the chip names the resolved body (the Part
    // list's own name), not the face or feature query the click stored.
    const partsBefore = usePartEditorStore.getState().parts
    usePartEditorStore.setState({
      parts: {
        body_a: { id: 'body_a', created_by: 'ex1', modified_by: [] },
        body_b: { id: 'body_b', created_by: 'ex2', modified_by: [] },
      },
    })
    try {
      const { rerender } = render(
        <FeatureEditor
          feature={unionFeature('union')}
          onMutation={vi.fn()}
          schema={BOOLEAN_SCHEMA}
          partLabels={{ body_a: 'Housing', body_b: 'Lid' }}
          features={[]}
        />,
      )
      expect(screen.getByText('Housing')).toBeInTheDocument()
      expect(screen.getByText('Lid')).toBeInTheDocument()

      rerender(
        <FeatureEditor
          feature={unionFeature('union')}
          onMutation={vi.fn()}
          schema={BOOLEAN_SCHEMA}
          partLabels={{ body_a: 'Housing A', body_b: 'Lid' }}
          features={[]}
        />,
      )
      expect(screen.getByText('Housing A')).toBeInTheDocument()
      expect(screen.queryByText('Housing')).toBeNull()
    } finally {
      // The store is shared by the whole file; a later test must not inherit
      // these fixture bodies. Wrapped in act because the rendered chip is still
      // subscribed when the test body restores it.
      act(() => { usePartEditorStore.setState({ parts: partsBefore }) })
    }
  })
})

// ─── showWhen ───

describe('FeatureEditor showWhen', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { kind: 'a' },
    fields: [
      { type: 'select', key: 'kind', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { type: 'number', key: 'extra', label: 'Extra', quantity: 'none', showWhen: (d) => d.kind === 'b' },
    ],
  }

  it('hides field when showWhen returns false', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { kind: 'a' })} onMutation={vi.fn()} schema={schema} />)
    expect(screen.queryByText('Extra')).toBeNull()
  })

  it('shows field when showWhen returns true', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { kind: 'b', extra: 42 })} onMutation={vi.fn()} schema={schema} />)
    expect(screen.getByText('Extra')).toBeInTheDocument()
  })
})

// ─── text fields ───

describe('FeatureEditor text field', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { direction: '1, 0, 0' },
    fields: [{
      type: 'text', key: 'direction', label: 'Direction', default: '1, 0, 0',
      parse: (s: string) => { const p = s.split(',').map(x => parseFloat(x.trim())); return p.length === 3 && p.every(x => !isNaN(x)) ? p : null },
      validate: (v: unknown) => (Array.isArray(v) && v.length === 3 ? null : 'needs three numbers'),
    }],
  }

  it('renders text input with default value', () => {
    render(<FeatureEditor feature={makeFeature('test', 'test', { direction: '1, 0, 0' })} onMutation={vi.fn()} schema={schema} />)
    expect(screen.getByDisplayValue('1, 0, 0')).toBeInTheDocument()
  })

  it('dispatches parsed value on blur', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { direction: '1, 0, 0' })} onMutation={onMutation} schema={schema} />)
    const input = screen.getByDisplayValue('1, 0, 0')
    fireEvent.change(input, { target: { value: '0, 1, 0' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'direction', value: [0, 1, 0] })
  })

  it('does not dispatch for invalid input', () => {
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { direction: '1, 0, 0' })} onMutation={onMutation} schema={schema} />)
    const input = screen.getByDisplayValue('1, 0, 0')
    fireEvent.change(input, { target: { value: 'invalid' } })
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })
})

// ─── pick field survives canvas tool switch ───

describe('FeatureEditor extrude profile pick survives canvas tool switch', () => {
  it('keeps the profile pick field active after the select tool, so a face click still adds a profile', () => {
    const initialFeature: ExtrudeFeature = {
      id: 'ex1', kind: 'extrude',
      extrude: { sketch: [], distance: 10, direction: 'normal' },
    }
    const mutations: Mutation[] = []
    function Harness() {
      const [feature, setFeature] = useState(initialFeature)
      const onMutation = (m: Mutation) => {
        mutations.push(m)
        // Mirror the real reducer for add_extrude_profile so the chip re-renders.
        setFeature(prev => m.type === 'add_extrude_profile'
          ? { ...prev, extrude: { ...prev.extrude!, sketch: [...prev.extrude!.sketch, m.sketchQuery] } }
          : prev)
      }
      return <FeatureEditor feature={feature} onMutation={onMutation} schema={EXTRUDE_SCHEMA} />
    }
    render(<Harness />)

    // Activate the Profile pick field by clicking its chip.
    const chip = document.querySelector('.feature-pick-chip')!
    fireEvent.click(chip)
    expect(useSketchEditorStore.getState().activePickField).toEqual({ featureId: 'ex1', field: 'sketch', multi: true })

    // Clicking empty canvas activates the passive select (drag) tool. With the
    // bug, this wiped activePickField and subsequent face clicks did nothing.
    act(() => { useSketchEditorStore.getState().setActiveTool('drag') })
    expect(useSketchEditorStore.getState().activePickField).not.toBeNull()

    // A face click toggles a selection id into normalSelection.
    act(() => { useEditorState.setState({
    normalSelection: new Set(['@ex1/face/0']),
  }) })

    // The pick field is still active, so onPick fired and the chip grew.
    expect(mutations).toContainEqual({ type: 'add_extrude_profile', featureId: 'ex1', sketchQuery: '@ex1/face/0' })
    expect(document.querySelector('.feature-pick-chip-item-text')?.textContent).toBe('@ex1/face/0')
  })
})

// ─── feature-kind validation ───

describe('FeatureEditor schema lookup', () => {
  it('renders FeatureEditor for extrude kind', () => {
    const feature: PartFeature = { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 10, direction: 'normal' } }
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={EXTRUDE_SCHEMA} />)
    expect(screen.getByText('Profile')).toBeInTheDocument()
    expect(screen.getByText('Distance')).toBeInTheDocument()
  })

  it('renders FeatureEditor for fillet kind', () => {
    const feature: PartFeature = { id: 'f1', kind: 'fillet', fillet: { edges: [], radius: 1 } }
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={FILLET_SCHEMA} />)
    expect(screen.getByText('Edges')).toBeInTheDocument()
    expect(screen.getByText('Radius')).toBeInTheDocument()
  })
})

describe('FeatureEditor expression scope', () => {
  function extrudeFeature(distance: string | number): PartFeature {
    return { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance, direction: 'normal' } } as PartFeature
  }

  it('shows the variable value and commits the name as the expression string', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={extrudeFeature(5)}
        onMutation={onMutation}
        schema={EXTRUDE_SCHEMA}
        variables={{ width: 40 }}
      />,
    )
    const input = screen.getByDisplayValue('5')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'width' } })
    expect(screen.getByText('= 40')).toBeInTheDocument()
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 'width',
    })
  })

  it('refuses a forward reference with the below wording and dispatches nothing', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={extrudeFeature(5)}
        onMutation={onMutation}
        schema={EXTRUDE_SCHEMA}
        variables={{}}
        laterVariables={{ width: 1 }}
      />,
    )
    const input = screen.getByDisplayValue('5')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'width*2' } })
    expect(screen.getByRole('status')).toHaveTextContent('variable "width" is defined below this feature')
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('explains each spelling the report tried, and commits none of them', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={extrudeFeature(5)}
        onMutation={onMutation}
        schema={EXTRUDE_SCHEMA}
        variables={{ width: 40 }}
      />,
    )
    const input = screen.getByDisplayValue('5')
    const cases: [string, string][] = [
      ['#var', 'cannot evaluate "#var": write a variable by its bare name, e.g. width*2'],
      ['{var}', 'cannot evaluate "{var}": write a variable by its bare name, e.g. width*2'],
      ['$var', 'unknown variable "$var"; defined above this feature: width'],
    ]
    for (const [text, reason] of cases) {
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: text } })
      expect(screen.getByRole('status')).toHaveTextContent(reason)
      fireEvent.blur(input)
    }
    expect(onMutation).not.toHaveBeenCalled()
  })
})

describe('VARIABLE_SCHEMA', () => {
  function variableFeature(expression: string | number): PartFeature {
    return { id: 'v1', kind: 'variable', label: 'v', variable: { expression } } as PartFeature
  }

  it('is a standard expression field, not plain text', () => {
    expect(VARIABLE_SCHEMA.mutationPrefix).toBe('set_variable')
    expect(VARIABLE_SCHEMA.subKey).toBe('variable')
    expect(VARIABLE_SCHEMA.defaults).toEqual({ expression: 0 })
    const field = VARIABLE_SCHEMA.fields.find(f => f.key === 'expression')
    // A schema guard: the field gave no wheel step and no value readout while
    // it was text, and it must not drift back.
    expect(field?.type).toBe('number')
    expect(field?.type === 'number' && field.quantity).toBe('none')
  })

  it('is registered under the variable kind', () => {
    expect(EDITOR_SCHEMAS.variable).toBe(VARIABLE_SCHEMA)
  })

  it('dispatches set_variable_field on expression blur', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={variableFeature('0')}
        onMutation={onMutation}
        schema={VARIABLE_SCHEMA}
        variables={{ width: 10 }}
      />,
    )
    const input = screen.getByDisplayValue('0')
    fireEvent.change(input, { target: { value: 'width*2' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 'width*2' })
  })

  it('wheel-steps a plain expression by one, with no lower bound', () => {
    const onMutation = vi.fn()
    const { rerender } = render(
      <FeatureEditor feature={variableFeature('0')} onMutation={onMutation} schema={VARIABLE_SCHEMA} />,
    )
    const input = screen.getByDisplayValue('0')
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 1,
    })

    rerender(<FeatureEditor feature={variableFeature(1)} onMutation={onMutation} schema={VARIABLE_SCHEMA} />)
    fireEvent.wheel(screen.getByDisplayValue('1'), { deltaY: 100 })
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 0,
    })

    // A variable may be negative: the wheel has no positive/non-negative rule.
    rerender(<FeatureEditor feature={variableFeature(0)} onMutation={onMutation} schema={VARIABLE_SCHEMA} />)
    fireEvent.wheel(screen.getByDisplayValue('0'), { deltaY: 100 })
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'set_variable_field', featureId: 'v1', field: 'expression', value: -1,
    })
  })

  it('leaves an expression alone on the wheel, so the panel scrolls', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={variableFeature('w*2')}
        onMutation={onMutation}
        schema={VARIABLE_SCHEMA}
        variables={{ w: 10 }}
      />,
    )
    const input = screen.getByDisplayValue('w*2')
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(onMutation).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('shows the value of an expression over the variables above it', () => {
    render(
      <FeatureEditor
        feature={variableFeature('w*2')}
        onMutation={vi.fn()}
        schema={VARIABLE_SCHEMA}
        variables={{ w: 10 }}
      />,
    )
    expect(screen.getByText('= 20')).toBeInTheDocument()
  })

  it('refuses a forward reference with the below wording', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={variableFeature('depth')}
        onMutation={onMutation}
        schema={VARIABLE_SCHEMA}
        variables={{}}
        laterVariables={{ depth: 3 }}
      />,
    )
    const input = screen.getByDisplayValue('depth')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'depth*2' } })
    expect(screen.getByRole('status')).toHaveTextContent('is defined below this feature')
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('shows the stored unit as a display hint only', () => {
    const feature = variableFeature('5')
    ;(feature as unknown as { variable: Record<string, unknown> }).variable.unit = 'mm'
    render(<FeatureEditor feature={feature} onMutation={vi.fn()} schema={VARIABLE_SCHEMA} />)
    expect(screen.getByText('mm')).toBeInTheDocument()
  })
})
