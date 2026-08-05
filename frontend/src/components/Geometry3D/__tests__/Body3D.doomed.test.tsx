// The Body3D half of delete-preview-marking. `bodySurfaceLook` is unit-tested
// on its own, but Body3D is the ONLY place the decision becomes pixels, and a
// mutation that passed `doomed: false` into it -- deleting the whole
// visual half of the feature -- left the rest of the suite green. This renders
// the real component and observes the two things that actually reach the GPU:
// the material props, and the palettes handed to useHighlightColors (the body
// colour travels as a vertex-colour attribute, not as a material prop). The
// doomed body is marked on the WIREFRAME now -- the face is fully transparent,
// so the edge palette is the observable mark, not the face palette.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { paletteRGB } from '@/components/Geometry3D/useHighlightColors'
import type { HighlightPalette } from '@/components/Geometry3D/highlightColorPainter'
import {
  COLOR_BODY_REMOVED,
  COLOR_BODY_DEFAULT,
  COLOR_BODY_EDGE,
  COLOR_BODY_EDGE_SEL,
  DEFAULT_PART_ROUGHNESS,
} from '@/components/Geometry3D/constants'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { palettes, registrations } = vi.hoisted(() => ({
  palettes: [] as unknown[],
  registrations: [] as { hook: string; enabled: boolean }[],
}))

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: { palette: unknown }) => {
      palettes.push(params.palette)
      return actual.useHighlightColors(params as never)
    },
  }
})

// The id registrations are what make a doomed body pickable at all, so capture
// the `enabled` each one is handed rather than a rendered attribute.
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

beforeEach(() => {
  palettes.length = 0
  registrations.length = 0
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

async function renderBody(props: Record<string, unknown>) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} {...props} />)
}

const material = (container: HTMLElement) => container.querySelector('meshphysicalmaterial')

/** The face palette is the first useHighlightColors call of a render. */
const faceBase = () => (palettes[0] as HighlightPalette).base

/** The edge palette is the second useHighlightColors call of a render. */
const edgeBase = () => (palettes[1] as HighlightPalette).base

describe('Body3D draws a doomed body marked', () => {
  it('marks it with a pink wireframe, overriding the grey edge', async () => {
    await renderBody({ doomed: true })
    expect(edgeBase()).toEqual(paletteRGB(COLOR_BODY_REMOVED))
  })

  it('keeps an ordinary body its grey wireframe', async () => {
    await renderBody({ color: '#123456' })
    expect(edgeBase()).toEqual(paletteRGB(COLOR_BODY_EDGE))
  })

  it('keeps the part colour on an ordinary body', async () => {
    await renderBody({ color: '#123456' })
    expect(faceBase()).toEqual(paletteRGB('#123456'))
  })

  it('leaves an unstyled body the default colour', async () => {
    await renderBody({})
    expect(faceBase()).toEqual(paletteRGB(COLOR_BODY_DEFAULT))
  })

  it('brightens the doomed wireframe when selected, keeping the face transparent', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@body_ex1']) } as never)
    const { container } = await renderBody({ doomed: true })
    expect(edgeBase()).toEqual(paletteRGB(COLOR_BODY_EDGE_SEL))
    expect(Number(material(container)?.getAttribute('opacity'))).toBe(0)
  })

  it('draws the doomed face fully transparent, not pink-tinted', async () => {
    const { container } = await renderBody({ doomed: true })
    expect(Number(material(container)?.getAttribute('opacity'))).toBe(0)
  })

  it('keeps the doomed face transparent whatever the user styled', async () => {
    // The old ceiling kept the pink FACE mark visible; the mark now lives on
    // the wireframe, so the face stays fully see-through even at an opaque
    // part style and at transparency 1.
    for (const transparency of [0, 1]) {
      const { container } = await renderBody({ doomed: true, transparency })
      expect(Number(material(container)?.getAttribute('opacity'))).toBe(0)
    }
  })

  it('leaves an ordinary body opaque', async () => {
    const { container } = await renderBody({})
    expect(Number(material(container)?.getAttribute('opacity'))).toBe(1)
  })

  it('drops the part material so every removal looks the same', async () => {
    // A doomed body still wearing transmission=1 (glass) or metalness=1 reads
    // as a different material and washes the mark out.
    const { container } = await renderBody({
      doomed: true, transmission: 1, metalness: 1, roughness: 0.05,
    })
    const m = material(container)
    expect(Number(m?.getAttribute('transmission'))).toBe(0)
    expect(Number(m?.getAttribute('metalness'))).toBe(0)
    expect(Number(m?.getAttribute('roughness'))).toBe(DEFAULT_PART_ROUGHNESS)
  })

  it('keeps the part material on a body the edit is not removing', async () => {
    const { container } = await renderBody({ transmission: 1, metalness: 1, roughness: 0.05 })
    const m = material(container)
    expect(Number(m?.getAttribute('transmission'))).toBe(1)
    expect(Number(m?.getAttribute('metalness'))).toBe(1)
    expect(Number(m?.getAttribute('roughness'))).toBe(0.05)
  })
})

describe('Body3D keeps a doomed body in the id buffer', () => {
  // This is the half that makes the feature more than cosmetic: hiding the
  // ghost took it out of the id buffer, so add_delete_body_ref -- a toggle --
  // could never receive the second click that un-picks it.
  it('enables all three id registrations while marked', async () => {
    await renderBody({ doomed: true })
    expect(registrations.filter(r => r.enabled).map(r => r.hook).sort())
      .toEqual(['edge', 'face', 'vertex'])
  })

  it('still honours an explicit hide, which is the other axis', async () => {
    await renderBody({ doomed: true, visible: false })
    expect(registrations.every(r => !r.enabled)).toBe(true)
  })
})
