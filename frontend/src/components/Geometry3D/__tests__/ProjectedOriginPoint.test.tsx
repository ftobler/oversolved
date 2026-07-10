import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { COLOR_PROJECTED, COLOR_INACTIVE, COLOR_HOVER, COLOR_SELECTED } from '@/components/Geometry3D/constants'

const MockLine = vi.fn((_props: Record<string, unknown>) => null)

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { MockLine(props); return null },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

function resetStore(overrides: Record<string, unknown> = {}) {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    hoveredConstraintEntityIds: new Set(),
    hoveredSelectionId: null,
    ...overrides,
  } as never)
}

beforeEach(() => {
  MockLine.mockClear()
  resetStore()
})

/** The mesh material colour, as written to the DOM by the R3F stand-in elements. */
function materialColor(container: HTMLElement): string | null {
  return container.querySelector('meshbasicmaterial')?.getAttribute('color') ?? null
}

describe('ProjectedOriginPoint', () => {
  it('draws a dot, not a cross', async () => {
    // Regression: projected points used to render as a thin '+' of two lines,
    // which read as a different kind of thing than a sketch point.
    const { ProjectedOriginPoint } = await import('@/components/Geometry3D/VertexDots')
    const { container } = render(
      <ProjectedOriginPoint x={1} y={2} featureId="sketch1" entityId="p1" isEditing={true} />
    )

    expect(MockLine).not.toHaveBeenCalled()
    expect(container.querySelector('circlegeometry')).not.toBeNull()
  })

  it('is the projected colour while editing and inactive grey otherwise', async () => {
    const { ProjectedOriginPoint } = await import('@/components/Geometry3D/VertexDots')

    const editing = render(
      <ProjectedOriginPoint x={0} y={0} featureId="sketch1" entityId="p1" isEditing={true} />
    )
    expect(materialColor(editing.container)).toBe(COLOR_PROJECTED)
    editing.unmount()

    const visible = render(
      <ProjectedOriginPoint x={0} y={0} featureId="sketch1" entityId="p1" isEditing={false} />
    )
    expect(materialColor(visible.container)).toBe(COLOR_INACTIVE)
  })

  it('takes the hover and selection colours like any other sketch point', async () => {
    const { ProjectedOriginPoint } = await import('@/components/Geometry3D/VertexDots')
    const entId = 'entity:sketch1:p1'

    resetStore({ hoveredSelectionId: entId })
    const hovered = render(
      <ProjectedOriginPoint x={0} y={0} featureId="sketch1" entityId="p1" isEditing={true} />
    )
    expect(materialColor(hovered.container)).toBe(COLOR_HOVER)
    hovered.unmount()

    resetStore({ normalSelection: new Set([entId]) })
    const selected = render(
      <ProjectedOriginPoint x={0} y={0} featureId="sketch1" entityId="p1" isEditing={true} />
    )
    expect(materialColor(selected.container)).toBe(COLOR_SELECTED)
  })
})
