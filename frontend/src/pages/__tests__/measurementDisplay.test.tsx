import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import MeasurementDisplay from '@/components/layout/MeasurementDisplay'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { BodyResult } from '@/types/cad'

// One jsdom smoke test for the HUD wiring: the component reads the store's
// selection, calls the pure core and renders the lines. Everything below it is
// pure and tested without a DOM.
const body: BodyResult = {
  id: 'body_1',
  created_by: 'ex',
  modified_by: [],
  mesh: {
    vertices: [], faces: [],
    face_data: [
      { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' },
      { centroid: [0, 0, 5], normal: [0, 0, 1], surface_type: 'flatface' },
    ],
    face_queries: ['?f0:flatface', '?f1:flatface'],
  },
}

describe('MeasurementDisplay', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({ normalSelection: new Set(['?f0:flatface', '?f1:flatface']) })
  })

  afterEach(() => {
    cleanup()
    useSketchEditorStore.setState({ normalSelection: new Set() })
  })

  it('renders the two-pick body readout from the canned BodyResult', () => {
    render(<MeasurementDisplay sketch={{}} bodies={{ body_1: body }} />)
    expect(screen.getByText('distance 5.000 mm')).toBeTruthy()
  })

  it('renders nothing for a single face', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['?f0:flatface']) })
    render(<MeasurementDisplay sketch={{}} bodies={{ body_1: body }} />)
    expect(screen.queryByText(/distance/)).toBeNull()
  })
})
