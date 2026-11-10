// The tree row reads the kernel's sketch verdict through featureFailure: an
// underconstrained sketch is yellow (a build warning, never a failure) and an
// overconstrained one is red, the mark the tree used to hide for both.
import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { usePartEditorStore } from '@/stores/partEditorStore'
import {
  builtInFeatures, renderSidebar, resetStores, setupEditingStore, sketchFeature,
} from './sidebarTestHarness'

beforeEach(() => {
  resetStores()
})

function renderWithSketchResult(result: Record<string, unknown>) {
  const features = [...builtInFeatures, sketchFeature]
  setupEditingStore(features)
  usePartEditorStore.setState({ solveResults: { sk1: result } as never })
  renderSidebar()
  return screen.getByText('sk1')
}

describe('FeatureTree sketch constraint mark', () => {
  it('marks an underconstrained sketch as a warning', () => {
    const name = renderWithSketchResult({
      status: 'underconstrained',
      dof: 4,
      solver_warning: 'Underconstrained: 4 degrees of freedom. Free: l1, l2, l3, l4.',
    })
    expect(name.classList.contains('feature-name-warning')).toBe(true)
    expect(name.classList.contains('feature-name-error')).toBe(false)
  })

  it('marks an overconstrained sketch as an error', () => {
    const name = renderWithSketchResult({ status: 'overconstrained' })
    expect(name.classList.contains('feature-name-error')).toBe(true)
    expect(name.classList.contains('feature-name-warning')).toBe(false)
  })

  it('leaves a fully constrained sketch unmarked', () => {
    const name = renderWithSketchResult({ status: 'fully_constrained', dof: 0 })
    expect(name.classList.contains('feature-name-warning')).toBe(false)
    expect(name.classList.contains('feature-name-error')).toBe(false)
  })
})
