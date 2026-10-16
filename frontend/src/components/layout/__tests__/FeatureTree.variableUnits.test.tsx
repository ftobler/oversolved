// The parameter table's read-only half in the feature tree: a variable row
// shows its solved value, and its unit hint beside it when it carries one.
import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { makeCallbacks, renderSidebar, resetStores, builtInFeatures } from './sidebarTestHarness'
import type { PartFeature } from '@/types/cad'

const width: PartFeature = { id: 'v1', kind: 'variable', label: 'width', variable: { expression: '20', unit: 'mm' } }
const plain: PartFeature = { id: 'v2', kind: 'variable', label: 'count', variable: { expression: '3' } }

beforeEach(() => {
  resetStores()
})

describe('variable rows in the feature tree', () => {
  it('shows the solved value with its unit hint', () => {
    usePartEditorStore.setState({
      features: [...builtInFeatures, width, plain],
      visibleFeatures: new Set(['v1', 'v2']),
      solveResults: { v1: { value: 20 }, v2: { value: 3 } },
    })
    renderSidebar(makeCallbacks())
    expect(screen.getByText('width = 20 mm')).toBeInTheDocument()
    // No unit hint: the value alone, exactly as before.
    expect(screen.getByText('count = 3')).toBeInTheDocument()
  })

  it('shows no value before the solve lands', () => {
    usePartEditorStore.setState({
      features: [...builtInFeatures, width],
      visibleFeatures: new Set(['v1']),
      solveResults: {},
    })
    renderSidebar(makeCallbacks())
    expect(screen.getByText('width')).toBeInTheDocument()
  })
})
