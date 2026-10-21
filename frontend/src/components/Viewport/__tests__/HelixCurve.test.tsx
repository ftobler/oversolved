// The helix is sketch-class reference geometry: it answers hover and selection
// with the same colours and render layer as a sketch entity, and its start
// marker only exists while its own editor is open.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { EdgeDataSpline } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import {
  COLOR_HOVER, COLOR_INACTIVE, COLOR_PROJECTED, COLOR_SELECTED, COLOR_SOLVED,
  RENDER_ORDER_DEFAULT, RENDER_ORDER_EDITING, RENDER_ORDER_HIGHLIGHT,
  entityRenderLayer,
} from '@/components/Geometry3D/constants'

const MockLine = vi.fn((_props: Record<string, unknown>) => null)
const MockRegister = vi.fn((_params: Record<string, unknown>) => {})

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { MockLine(props); return null },
}))

vi.mock('@/picking', () => ({
  useEdgeIdRegistration: (params: Record<string, unknown>) => { MockRegister(params) },
}))

const CURVE: EdgeDataSpline = { kind: 'spline', points: [[0, 0, 0], [1, 0, 1], [2, 0, 2]] }
const HELIX_ID = 'helix1'
const SELECTION_ID = `@${HELIX_ID}`

function resetStore(overrides: Record<string, unknown> = {}) {
  useEditorState.setState({
    normalSelection: new Set<string>(),
    hoveredSelectionId: null,
    ...overrides,
  } as never)
}

beforeEach(() => {
  MockLine.mockClear()
  MockRegister.mockClear()
  resetStore()
})

async function renderHelix(props: { visible?: boolean; isEditing?: boolean } = {}) {
  const { default: HelixCurve } = await import('@/components/Viewport/HelixCurve')
  return render(<HelixCurve featureId={HELIX_ID} curve={CURVE} {...props} />)
}

function lineProps(): Record<string, unknown> {
  return MockLine.mock.calls[0]?.[0] as Record<string, unknown>
}

describe('HelixCurve colour', () => {
  it('is inactive grey when idle, matching a sketch outside its editor', async () => {
    await renderHelix()
    expect(lineProps().color).toBe(COLOR_INACTIVE)
    expect(lineProps().lineWidth).toBe(1)
  })

  it('is hover white while hovered and thicker', async () => {
    resetStore({ hoveredSelectionId: SELECTION_ID })
    await renderHelix()
    expect(lineProps().color).toBe(COLOR_HOVER)
    expect(lineProps().lineWidth).toBe(2)
  })

  it('is selection orange while selected', async () => {
    resetStore({ normalSelection: new Set([SELECTION_ID]) })
    await renderHelix()
    expect(lineProps().color).toBe(COLOR_SELECTED)
  })

  it('lets hover outrank selection, the same precedence as EntityItem', async () => {
    resetStore({ normalSelection: new Set([SELECTION_ID]), hoveredSelectionId: SELECTION_ID })
    await renderHelix()
    expect(lineProps().color).toBe(COLOR_HOVER)
  })

  it('is the editing blue while its own editor is open', async () => {
    await renderHelix({ isEditing: true })
    expect(lineProps().color).toBe(COLOR_SOLVED)
  })
})

describe('HelixCurve render layer', () => {
  const states = [
    { name: 'idle', isEditing: false, selected: false, hovered: false },
    { name: 'hovered', isEditing: false, selected: false, hovered: true },
    { name: 'selected', isEditing: false, selected: true, hovered: false },
    { name: 'editing', isEditing: true, selected: false, hovered: false },
  ] as const

  it('matches entityRenderLayer in every interaction state', async () => {
    for (const state of states) {
      resetStore({
        normalSelection: state.selected ? new Set([SELECTION_ID]) : new Set(),
        hoveredSelectionId: state.hovered ? SELECTION_ID : null,
      })
      const view = await renderHelix({ isEditing: state.isEditing })
      const props = lineProps()
      const layer = entityRenderLayer({ isEditing: state.isEditing, selected: state.selected, hovered: state.hovered })
      expect(props.depthTest, state.name).toBe(layer.depthTest)
      expect(props.renderOrder, state.name).toBe(layer.renderOrder)
      view.unmount()
      MockLine.mockClear()
    }
  })

  it('a hovered helix draws on top of a body instead of being occluded', async () => {
    resetStore({ hoveredSelectionId: SELECTION_ID })
    await renderHelix()
    expect(lineProps().depthTest).toBe(false)
    expect(lineProps().renderOrder).toBe(RENDER_ORDER_HIGHLIGHT)
  })

  it('an idle helix stays depth-tested at its own layer', async () => {
    await renderHelix()
    expect(lineProps().depthTest).toBe(true)
    expect(lineProps().renderOrder).toBe(RENDER_ORDER_DEFAULT)
  })

  it('a selected helix uses the edit layer, not the highlight layer', async () => {
    resetStore({ normalSelection: new Set([SELECTION_ID]) })
    await renderHelix()
    expect(lineProps().renderOrder).toBe(RENDER_ORDER_EDITING)
  })
})

describe('HelixCurve start marker', () => {
  it('is not drawn while the feature is not being edited', async () => {
    const { container } = await renderHelix()
    expect(container.querySelector('mesh')).toBeNull()
  })

  it('is drawn while its own editor is open, in the projected hue', async () => {
    const { container } = await renderHelix({ isEditing: true })
    expect(container.querySelector('mesh')).not.toBeNull()
    expect(container.querySelector('meshstandardmaterial')?.getAttribute('color')).toBe(COLOR_PROJECTED)
  })
})

describe('HelixCurve ID registration', () => {
  it('registers on the edge layer under its own feature id', async () => {
    await renderHelix()
    expect(MockRegister).toHaveBeenCalledWith(expect.objectContaining({
      featureId: HELIX_ID,
      bodyId: HELIX_ID,
      edgeQueries: [`@${HELIX_ID}`],
      enabled: true,
    }))
  })

  it('does not register while hidden, so a hidden helix cannot be picked', async () => {
    await renderHelix({ visible: false })
    expect(MockRegister).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    expect(MockLine).not.toHaveBeenCalled()
  })
})
