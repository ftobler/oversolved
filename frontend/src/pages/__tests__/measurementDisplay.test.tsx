import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const { mockMeasure } = vi.hoisted(() => ({ mockMeasure: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({
  measureViaWorker: mockMeasure,
}))

import MeasurementDisplay from '@/components/layout/MeasurementDisplay'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartResult } from '@/types/cad'

// One jsdom smoke test for the HUD wiring: the component reads the store's
// selection, calls the pure core and renders the lines. Everything below it is
// pure and tested without a DOM.
const part: PartResult = {
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
    mockMeasure.mockReset()
    useSketchEditorStore.setState({ normalSelection: new Set(['?f0:flatface', '?f1:flatface']) })
  })

  afterEach(() => {
    cleanup()
    useSketchEditorStore.setState({ normalSelection: new Set() })
  })

  it('renders the two-pick body readout from the canned BodyResult', () => {
    render(<MeasurementDisplay sketch={{}} parts={{ body_1: part }} />)
    expect(screen.getByText('distance 5.000 mm')).toBeTruthy()
  })

  it('reads nothing for a single face', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['?f0:flatface']) })
    render(<MeasurementDisplay sketch={{}} parts={{ body_1: part }} />)
    expect(screen.queryByText(/distance/)).toBeNull()
  })

  it('shows the primary and two extras inline, the rest behind a disclosure', () => {
    const points: PartResult = {
      ...part,
      vertices: [[0, 0, 0], [3, 4, 0]],
      vertex_queries: ['?v0', '?v1'],
    }
    useSketchEditorStore.setState({ normalSelection: new Set(['?v0', '?v1']) })
    const { container } = render(<MeasurementDisplay sketch={{}} parts={{ body_1: points }} />)
    expect(screen.getByText('distance 5.000 mm')).toBeTruthy()
    expect(screen.getByText('dx 3.000 mm')).toBeTruthy()
    expect(screen.getByText('dy 4.000 mm')).toBeTruthy()
    const more = container.querySelector('.measurement-more')
    expect(more?.querySelector('summary')?.textContent).toBe('more')
    expect(more?.textContent).toContain('dz 0.000 mm')
  })

  it('reserves a HUD row for a kernel cell, then renders the clearance', async () => {
    // Two whole-body picks: a clearance, which only the kernel can answer.
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_1', '@body_2']) })
    mockMeasure.mockResolvedValue({ value: 4 })
    const { container } = render(
      <MeasurementDisplay sketch={{}} parts={{ body_1: part, body_2: part }} generation="boot:1" />,
    )

    // The row is reserved (and empty) while the reply is in flight.
    expect(container.querySelector('.measurement-pending')).toBeTruthy()
    expect(screen.queryByText(/clearance/)).toBeNull()

    await waitFor(() => expect(screen.getByText('clearance 4.000 mm')).toBeTruthy())
    expect(mockMeasure).toHaveBeenCalledWith(expect.objectContaining({
      generation: 'boot:1',
      set: 'final',
      op: 'clearance',
      picks: [{ bodyId: 'body_1', kind: 'body' }, { bodyId: 'body_2', kind: 'body' }],
    }))
  })

  it('asks nothing without a solve generation', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_1', '@body_2']) })
    const { container } = render(<MeasurementDisplay sketch={{}} parts={{ body_1: part, body_2: part }} />)
    // No generation means no question: neither a readout nor a reserved row.
    expect(container.querySelector('.measurement-pending')).toBeNull()
  })
})
