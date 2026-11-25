// The assembly origin is a mate target, so picking it must light it up the way
// the part editor's origin marker does. The highlight reads the assembly's own
// hover and entity-selection state, keyed by its built-in entity id.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'

const { MockDot, registerOrigin } = vi.hoisted(() => ({
  MockDot: vi.fn((_props: Record<string, unknown>) => null),
  registerOrigin: vi.fn(),
}))

vi.mock('@/components/Geometry3D/VertexDots', () => ({
  Dot: (props: Record<string, unknown>) => { MockDot(props); return null },
  VertexHighlight: () => null,
}))
vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))
vi.mock('@/components/Viewport/PlaneVisual', () => ({
  PlaneSurface: () => null,
  PlaneLabel: () => null,
}))
vi.mock('@/picking', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/picking')>(),
  useOriginMarkerIdRegistration: registerOrigin,
  usePlaneIdRegistration: vi.fn(),
}))

import AssemblyBuiltin from '@/components/Viewport/assembly/AssemblyBuiltin'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { ASSEMBLY_ORIGIN_ID } from '@/utils/assemblyBuiltins'
import { assemblyBuiltinEntityKey } from '@/utils/anchorCandidates'
import { COLOR_HOVER, COLOR_INACTIVE, COLOR_SELECTED } from '@/components/Geometry3D/constants'

const originItem = {
  id: ASSEMBLY_ORIGIN_ID, kind: 'origin' as const, label: 'Origin', rotation: [0, 0, 0] as [number, number, number],
}
const key = assemblyBuiltinEntityKey(ASSEMBLY_ORIGIN_ID)

function dotProps() {
  expect(MockDot).toHaveBeenCalled()
  return MockDot.mock.calls[0][0] as Record<string, unknown>
}

beforeEach(() => {
  MockDot.mockClear()
  registerOrigin.mockClear()
  useAssemblyStore.setState({ entitySelection: new Set(), hoveredEntity: null })
})

describe('AssemblyBuiltin origin highlight', () => {
  it('registers its pick id under the assembly built-in key', () => {
    render(<AssemblyBuiltin item={originItem} />)
    expect(registerOrigin).toHaveBeenCalledWith({ selectionId: key })
  })

  it('uses the inactive colour at the resting size when neither hovered nor selected', () => {
    render(<AssemblyBuiltin item={originItem} />)
    const props = dotProps()
    expect(props.color).toBe(COLOR_INACTIVE)
    expect(props.px).toBe(4)
  })

  it('uses the hover colour and grows the dot while hovered', () => {
    useAssemblyStore.setState({ hoveredEntity: key })
    render(<AssemblyBuiltin item={originItem} />)
    const props = dotProps()
    expect(props.color).toBe(COLOR_HOVER)
    expect(props.px).toBe(6)
  })

  it('uses the selected colour at the resting size when selected', () => {
    useAssemblyStore.setState({ entitySelection: new Set([key]) })
    render(<AssemblyBuiltin item={originItem} />)
    const props = dotProps()
    expect(props.color).toBe(COLOR_SELECTED)
    expect(props.px).toBe(4)
  })

  it('lets selection win over hover, as the shared highlight state does', () => {
    useAssemblyStore.setState({ entitySelection: new Set([key]), hoveredEntity: key })
    render(<AssemblyBuiltin item={originItem} />)
    expect(dotProps().color).toBe(COLOR_SELECTED)
  })

  it('ignores a highlight aimed at another entity', () => {
    useAssemblyStore.setState({ entitySelection: new Set(['p1|face|0']), hoveredEntity: 'p1|face|0' })
    render(<AssemblyBuiltin item={originItem} />)
    expect(dotProps().color).toBe(COLOR_INACTIVE)
  })
})
