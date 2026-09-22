import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import PlaneBody from '../PlaneBody'

/**
 * PlaneBody is the shared visual/behaviour body for reference and user-defined
 * planes. Its decisions are the hover/selected precedence, the mid-drag mesh
 * hide, and the exact pick registration it hands to the ID buffer.
 */

const seams = vi.hoisted(() => ({
  regPlane: vi.fn(),
  surfaceProps: vi.fn(),
  labelProps: vi.fn(),
}))

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  usePlaneIdRegistration: (args: unknown) => seams.regPlane(args),
}))

vi.mock('@/components/Viewport/PlaneVisual', () => ({
  PlaneSurface: (props: Record<string, unknown>) => { seams.surfaceProps(props); return null },
  PlaneLabel: (props: Record<string, unknown>) => { seams.labelProps(props); return null },
}))

const ROT: [number, number, number] = [0, 0, 0]

beforeEach(() => {
  seams.regPlane.mockClear()
  seams.surfaceProps.mockClear()
  seams.labelProps.mockClear()
  useSketchEditorStore.setState({ normalSelection: new Set(), hoveredSelectionId: null, drag: null })
})

describe('PlaneBody', () => {
  it('registers its pick quad with the selection id and placement', () => {
    render(<PlaneBody selId="plane:ref:xy" size={20} rotation={ROT} label="XY" />)
    expect(seams.regPlane).toHaveBeenCalledWith({
      selectionId: 'plane:ref:xy', size: 20, rotation: ROT, origin: undefined,
    })
  })

  it('paints the label at the top-left corner for the given size', () => {
    render(<PlaneBody selId="p" size={20} rotation={ROT} label="Front" />)
    expect(seams.labelProps).toHaveBeenCalledWith({ x: -10, y: 10, children: 'Front' })
  })

  it('is default when neither hovered nor selected', () => {
    render(<PlaneBody selId="p" size={10} rotation={ROT} label="L" />)
    expect(seams.surfaceProps.mock.calls.at(-1)![0]).toMatchObject({ state: 'default', hideMesh: false })
  })

  it('is selected when the selection set holds this id', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['p']) })
    render(<PlaneBody selId="p" size={10} rotation={ROT} label="L" />)
    expect(seams.surfaceProps.mock.calls.at(-1)![0]).toMatchObject({ state: 'selected' })
  })

  it('hover wins over selection', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['p']), hoveredSelectionId: 'p' })
    render(<PlaneBody selId="p" size={10} rotation={ROT} label="L" />)
    expect(seams.surfaceProps.mock.calls.at(-1)![0]).toMatchObject({ state: 'hovered' })
  })

  it('hides the fill mesh while any drag is live, so the plane cannot occlude the grab', () => {
    useSketchEditorStore.setState({
      drag: {
        type: 'vertex', vertexId: 'entity:S1:L1', featureId: 'S1', entityId: 'L1',
        vertexKey: 'start', startWorld: [0, 0], currentWorld: [1, 1], startClient: [0, 0],
      },
    })
    render(<PlaneBody selId="p" size={10} rotation={ROT} label="L" />)
    expect(seams.surfaceProps.mock.calls.at(-1)![0]).toMatchObject({ hideMesh: true })
  })
})
