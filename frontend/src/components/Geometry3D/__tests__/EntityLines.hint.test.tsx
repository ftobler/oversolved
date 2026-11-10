// A consumed sketch is drawn while its consumer's row is selected: the lines
// switch to the hint colour and lift to the edit layer so they can be seen
// inside the body they built. Deselecting restores the ordinary look.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { LineSegment, PartFeature, Sketch } from '@/types/cad'
import {
  COLOR_CONSTRAINT_HOVER,
  COLOR_HINT,
  COLOR_SELECTED,
  RENDER_ORDER_EDITING,
} from '@/components/Geometry3D/constants'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'

const MockLine = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { MockLine(props); return null },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

vi.mock('@/components/Geometry3D/VertexDots', () => ({
  VertexDot: () => null,
  ProjectedOriginPoint: () => null,
}))

const line: LineSegment = { start: [0, 0], end: [1, 0] }
const sketch: Sketch = { l1: line }

const sk1: PartFeature = { id: 'sk1', kind: 'sketch' }
const ex1: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '@sk1', distance: 10, direction: 'normal' },
}

beforeEach(() => {
  MockLine.mockClear()
  usePartEditorStore.setState({ features: [sk1, ex1], bodies: {} })
  useEditorState.setState({
    normalSelection: new Set(),
    rollbackPosition: null,
    hoveredSelectionId: null,
    hoveredPickKey: null,
  })
})

async function renderLines() {
  const { EntityLines } = await import('@/components/Geometry3D/EntityLines')
  return render(
    <EntityLines sketch={sketch} featureId="sk1" color="#aaaaaa" isEditing={false} />,
  )
}

function lastLineProps(): Record<string, unknown> {
  return MockLine.mock.calls[MockLine.mock.calls.length - 1]?.[0] as Record<string, unknown>
}

describe('EntityLines relation hint', () => {
  it('draws a consumed sketch in the hint colour while its consumer is selected', async () => {
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    await renderLines()

    expect(lastLineProps().color).toBe(COLOR_HINT)
    expect(lastLineProps().renderOrder).toBe(RENDER_ORDER_EDITING)
  })

  it('restores the ordinary look when the selection clears', async () => {
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    const { rerender } = await renderLines()
    expect(lastLineProps().color).toBe(COLOR_HINT)

    useEditorState.setState({ normalSelection: new Set() })
    const { EntityLines } = await import('@/components/Geometry3D/EntityLines')
    rerender(<EntityLines sketch={sketch} featureId="sk1" color="#aaaaaa" isEditing={false} />)

    expect(lastLineProps().color).toBe('#aaaaaa')
  })

  it('a selected entity outranks the hint colour', async () => {
    useEditorState.setState({
      normalSelection: new Set(['@ex1', 'entity:sk1:l1']),
    })
    await renderLines()
    expect(lastLineProps().color).toBe(COLOR_SELECTED)
  })

  it('a constraint hover outranks the hint colour', async () => {
    useEditorState.setState({
      normalSelection: new Set(['@ex1']),
      hoveredConstraintEntityIds: new Set(['l1']),
    })
    await renderLines()
    expect(lastLineProps().color).toBe(COLOR_CONSTRAINT_HOVER)
  })
})
