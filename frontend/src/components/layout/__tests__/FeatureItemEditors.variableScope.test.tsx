/**
 * The reported flow: an expression field in the feature editor must see the
 * variables defined above its own feature, not just whatever the widget is
 * handed. FeatureItemEditors owns that read: it folds the document log with
 * variableScopeAt and hands the scope down, so the extrude's Distance resolves
 * `width` and a later variable reads as a forward reference.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FeatureItemEditors } from '../FeatureItemEditors'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import type { Mutation, PartFeature } from '@/types/cad'

function variable(label: string, expression: string | number, id = label): PartFeature {
  return { id, kind: 'variable', label, variable: { expression } } as PartFeature
}

function extrude(distance: string | number, id = 'ex1'): PartFeature {
  return { id, kind: 'extrude', extrude: { sketch: [], distance, direction: 'normal' } } as PartFeature
}

function renderFeature(
  feature: PartFeature,
  features: PartFeature[],
  onMutation: (m: Mutation) => void = vi.fn(),
) {
  return render(
    <FeatureItemEditors
      feature={feature}
      editingFeatureId={feature.id}
      doc={{ features }}
      onMutation={onMutation}
      features={features}
      partLabels={{}}
    />,
  )
}

beforeEach(() => {
  useEditorState.setState({ normalSelection: new Set(), activePickField: null, modeStack: [] })
  usePartEditorStore.setState({ solveResults: {} })
  useSketchEditorStore.setState({ activePickField: null })
})

describe('FeatureItemEditors variable scope', () => {
  it('resolves the extrude distance from the variable above it', () => {
    const onMutation = vi.fn()
    const features = [variable('width', 40), extrude(5)]
    renderFeature(features[1], features, onMutation)

    const input = screen.getByDisplayValue('5')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'width' } })
    expect(screen.getByText('= 40')).toBeInTheDocument()
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 'width',
    })
  })

  it('refuses a variable defined after the feature', () => {
    const onMutation = vi.fn()
    const features = [extrude(5), variable('width', 40)]
    renderFeature(features[0], features, onMutation)

    const input = screen.getByDisplayValue('5')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'width' } })
    expect(screen.getByRole('status')).toHaveTextContent('variable "width" is defined below this feature')
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('gives the variable editor the scope of the variables above it', () => {
    const onMutation = vi.fn()
    const features = [variable('w', 10), variable('h', 'w*2', 'vh')]
    renderFeature(features[1], features, onMutation)

    // The variable's own Expression box is a standard expression field: the
    // value readout, the wheel step and the field refusal all come with it.
    expect(screen.getByText('= 20')).toBeInTheDocument()
    fireEvent.wheel(screen.getByDisplayValue('w*2'), { deltaY: -100 })
    expect(onMutation).not.toHaveBeenCalled()

    fireEvent.focus(screen.getByDisplayValue('w*2'))
    fireEvent.change(screen.getByDisplayValue('w*2'), { target: { value: 'w*3' } })
    expect(screen.getByText('= 30')).toBeInTheDocument()
  })

  it('wheel-steps a plain variable expression and commits the number', () => {
    const onMutation = vi.fn()
    const features = [variable('w', '0')]
    renderFeature(features[0], features, onMutation)

    fireEvent.wheel(screen.getByDisplayValue('0'), { deltaY: -100 })
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_variable_field', featureId: 'w', field: 'expression', value: 1,
    })
  })

  it('does not leak a variable into its own scope', () => {
    // A variable cannot reference itself; the fold stops before its index, so
    // the name reads as unknown here, exactly as the solve refuses it.
    const features = [variable('w', 'w+1')]
    renderFeature(features[0], features)
    const input = screen.getByDisplayValue('w+1')
    expect(input.className).toContain('feature-field-input--error')
    expect(input.title).toContain('unknown variable "w"')
  })
})

describe('FeatureItemEditors mutation wiring', () => {
  it('dispatches the variable mutation type for the expression box', () => {
    const mutations: Mutation[] = []
    const features = [variable('w', 10)]
    renderFeature(features[0], features, (m) => mutations.push(m))
    const input = screen.getByDisplayValue('10')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '5+5' } })
    fireEvent.blur(input)
    expect(mutations).toContainEqual({
      type: 'set_variable_field', featureId: 'w', field: 'expression', value: '5+5',
    })
  })
})
