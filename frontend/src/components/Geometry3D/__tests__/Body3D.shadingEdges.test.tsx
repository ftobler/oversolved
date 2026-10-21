// The viewer's Shading and Edges rows, in the component where they become both
// pixels and pick targets. A hidden layer must leave BOTH: a face that is not
// drawn but still registered would block a click on the edge the user can see,
// which is the "can't click what I see" trap the plan names.
//
// What a DOM render can observe is exactly what reaches the GPU: the three
// elements exist or not, and each ID registration is handed enabled true/false.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { registrations } = vi.hoisted(() => ({
  registrations: [] as { hook: string; enabled: boolean }[],
}))

vi.mock('@/picking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/picking')>()
  const spy = (hook: string, real: (a: never) => unknown) =>
    (args: { enabled?: boolean }) => {
      registrations.push({ hook, enabled: args.enabled !== false })
      return real(args as never)
    }
  return {
    ...actual,
    useFaceIdRegistration: spy('face', actual.useFaceIdRegistration),
    useEdgeIdRegistration: spy('edge', actual.useEdgeIdRegistration),
    useVertexIdRegistration: spy('vertex', actual.useVertexIdRegistration),
  }
})

const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
  face_queries: ['f0'],
  triangle_to_face: [0],
}

const edges = [
  { kind: 'line' as const, start: [0, 0, 0] as [number, number, number], end: [1, 0, 0] as [number, number, number] },
]

const vertices: [number, number, number][] = [[0, 0, 0]]

beforeEach(() => {
  registrations.length = 0
})

async function renderBody(props: Record<string, unknown>) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} edges={edges} vertices={vertices} {...props} />,
  )
}

const enabled = (hook: string) => registrations.filter(r => r.hook === hook).some(r => r.enabled)

describe('Body3D shading and edges', () => {
  it('draws and registers both layers by default', async () => {
    const { container } = await renderBody({})
    expect(container.querySelector('meshphysicalmaterial')).not.toBeNull()
    expect(container.querySelector('linesegments')).not.toBeNull()
    expect(enabled('face')).toBe(true)
    expect(enabled('edge')).toBe(true)
  })

  it('shading off hides the face from the image and from the ID buffer', async () => {
    const { container } = await renderBody({ showFaces: false })
    expect(container.querySelector('meshphysicalmaterial')).toBeNull()
    expect(enabled('face')).toBe(false)
    // The wireframe is what the user sees in a wireframe view, so it stays.
    expect(container.querySelector('linesegments')).not.toBeNull()
    expect(enabled('edge')).toBe(true)
  })

  it('edges off hides the wireframe from the image and from the ID buffer', async () => {
    const { container } = await renderBody({ showEdges: false })
    expect(container.querySelector('linesegments')).toBeNull()
    expect(enabled('edge')).toBe(false)
    expect(container.querySelector('meshphysicalmaterial')).not.toBeNull()
    expect(enabled('face')).toBe(true)
  })

  it('leaves vertex picking alone: it is neither shading nor edges', async () => {
    await renderBody({ showFaces: false })
    expect(enabled('vertex')).toBe(true)
  })

  it('keeps the removal mark visible through the edges row', async () => {
    // The plan exempts the removal mark: a doomed body must stay identifiable
    // while the user chooses what the edit takes. It is drawn, but not made
    // pickable -- registration follows the row alone.
    const { container } = await renderBody({ showEdges: false, doomed: true })
    expect(container.querySelector('linesegments')).not.toBeNull()
    expect(enabled('edge')).toBe(false)
  })

  it('honours an explicit hide as the other axis', async () => {
    await renderBody({ visible: false })
    expect(enabled('face')).toBe(false)
    expect(enabled('edge')).toBe(false)
    expect(enabled('vertex')).toBe(false)
  })
})
