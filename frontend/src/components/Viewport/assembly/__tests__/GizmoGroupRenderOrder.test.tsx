// Same defect class as AssemblySelectionHighlight.groupOrder.test.tsx, on the
// other two assembly overlays that carried a group-level renderOrder.
//
// three.js copies a Group's renderOrder into the groupOrder of everything below
// it, and reversePainterSortStable compares groupOrder BEFORE renderOrder. A
// renderOrder on a wrapper therefore beats the collision/ID debug pass
// (IdDebugOverlay: renderOrder 9999, but groupOrder 0) outright, and the gizmo
// paints over a pass that is supposed to sit on top of everything.
//
// The layering that IS wanted has to be stated on the drawn objects themselves,
// so each test checks both halves: no renderOrder on any group, and the drawn
// children still carrying theirs.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

// drei's <Line> is a Line2 primitive and <Text> pulls in troika; neither
// survives jsdom, and neither is what is under test. Recording the props they
// were called with is enough to assert the render orders moved onto them.
const lineProps: Record<string, unknown>[] = []
const textProps: Record<string, unknown>[] = []

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { lineProps.push(props); return null },
  // Billboard is a plain group that only aims itself at the camera; passing
  // children straight through keeps the readout observable without an R3F store.
  Billboard: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Text: (props: Record<string, unknown>) => { textProps.push(props); return null },
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Imported at module scope by AngleDial and reaches for troika there.
vi.mock('@/components/Viewport/labelFont', () => ({
  LABEL_FONT: '/fonts/stub.woff',
  LABEL_CHARACTERS: undefined,
}))

function expectNoGroupRenderOrder(container: HTMLElement) {
  const groups = container.querySelectorAll('group')
  expect(groups.length).toBeGreaterThan(0)
  for (const g of groups) {
    expect(g.hasAttribute('renderorder')).toBe(false)
  }
}

describe('TriadGizmo group render order', () => {
  it('wraps the triad in groups that carry no renderOrder', async () => {
    const { default: TriadGizmo } = await import('@/components/Viewport/assembly/TriadGizmo')
    const { container } = render(
      <TriadGizmo origin={[0, 0, 0]} orientation={[0, 0, 0, 1]} hovered={null} drag={null} />
    )
    expectNoGroupRenderOrder(container)
  })
})

describe('AngleDial group render order', () => {
  async function renderDial() {
    lineProps.length = 0
    textProps.length = 0
    const { default: AngleDial } = await import('@/components/Viewport/assembly/AngleDial')
    const { GIZMO_AXES } = await import('@/utils/gizmoPickGeometry')
    return render(
      <AngleDial def={GIZMO_AXES[0]} datum={0} swing={Math.PI / 4} snapped={false} snapArmed={true} />
    )
  }

  it('wraps the dial in a group that carries no renderOrder', async () => {
    const { container } = await renderDial()
    expectNoGroupRenderOrder(container)
  })

  it('keeps the dial render order on the drawn children instead', async () => {
    const { container } = await renderDial()

    // The sweep wedge.
    const mesh = container.querySelector('mesh')
    expect(mesh?.getAttribute('renderorder')).toBe('1001')

    // Ticks and both spokes.
    expect(lineProps.length).toBeGreaterThan(0)
    for (const props of lineProps) {
      expect(props.renderOrder).toBe(1001)
    }

    // The readout draws just under the line art, which is exactly where the
    // Billboard's groupOrder reset used to put it.
    expect(textProps.length).toBe(1)
    expect(textProps[0].renderOrder).toBe(1000)
  })
})
