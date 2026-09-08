import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import type { FeatureEditorSchema } from '@/components/editors/FeatureEditor'
import { EXTRUDE_SCHEMA, FILLET_SCHEMA, VARIABLE_SCHEMA, EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartFeature, Mutation } from '@/types/cad'
import { useState } from 'react'
import { initializeTools } from '@/tools'
import { toolRegistry } from '@/registry/toolRegistry'

beforeEach(() => {
  toolRegistry.reset()
  initializeTools()
  useSketchEditorStore.setState({ normalSelection: new Set(), activePickField: null, modeStack: [], chipOwnedSelection: new Set() })
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
    fields: [{ type: 'number', key: 'count', label: 'Count', default: 5 }],
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
      fields: [{ type: 'number', key: 'count', label: 'Count', default: 5, validate: (v) => v > 0 }],
    }
    const onMutation = vi.fn()
    render(<FeatureEditor feature={makeFeature('test', 'test', { count: 10 })} onMutation={onMutation} schema={validatedSchema} />)
    const input = screen.getByDisplayValue('10')
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('renders unit label when unit is set', () => {
    const unitSchema: FeatureEditorSchema = {
      ...schema,
      fields: [{ type: 'number', key: 'diam', label: 'Diameter', default: 10, unit: 'mm' }],
    }
    render(<FeatureEditor feature={makeFeature('test', 'test', { diam: 10 })} onMutation={vi.fn()} schema={unitSchema} />)
    expect(screen.getByText('mm')).toBeInTheDocument()
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

  it('marks chips named by the last solve failed_edges as faulty', () => {
    // The pick field must surface which picks did not apply in the last solve
    // (kernel partial result `failed_edges`) so the user sees what to re-pick.
    usePartEditorStore.setState({
      solveResults: { f1: { status: 'partial', failed_edges: ['@edge_gone'] } },
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
    expect(items[0].classList.contains('faulty')).toBe(false)
    expect(items[1].classList.contains('faulty')).toBe(true)
  })
})

// ─── showWhen ───

describe('FeatureEditor showWhen', () => {
  const schema: FeatureEditorSchema = {
    mutationPrefix: 'set_test', subKey: 'test', defaults: { kind: 'a' },
    fields: [
      { type: 'select', key: 'kind', label: 'Kind', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { type: 'number', key: 'extra', label: 'Extra', showWhen: (d) => d.kind === 'b' },
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
      validate: (v: unknown) => Array.isArray(v) && v.length === 3,
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
    const initialFeature: PartFeature = {
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
    act(() => { useSketchEditorStore.setState({ normalSelection: new Set(['@ex1/face/0']) }) })

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

describe('VARIABLE_SCHEMA', () => {
  it('has the expected shape', () => {
    expect(VARIABLE_SCHEMA.mutationPrefix).toBe('set_variable')
    expect(VARIABLE_SCHEMA.subKey).toBe('variable')
    expect(VARIABLE_SCHEMA.defaults).toEqual({ expression: '0' })
    const field = VARIABLE_SCHEMA.fields.find(f => f.key === 'expression')
    expect(field?.type).toBe('text')
  })

  it('is registered under the variable kind', () => {
    expect(EDITOR_SCHEMAS.variable).toBe(VARIABLE_SCHEMA)
  })

  it('dispatches set_variable_field on expression blur', () => {
    const onMutation = vi.fn()
    const feature: PartFeature = { id: 'v1', kind: 'variable', variable: { expression: '0' } }
    render(<FeatureEditor feature={feature} onMutation={onMutation} schema={VARIABLE_SCHEMA} />)
    const input = screen.getByDisplayValue('0')
    fireEvent.change(input, { target: { value: 'width*2' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_variable_field', featureId: 'v1', field: 'expression', value: 'width*2' })
  })
})
