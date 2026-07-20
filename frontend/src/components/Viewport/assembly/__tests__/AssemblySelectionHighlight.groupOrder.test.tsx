// Regression: the highlight wrapper carried renderOrder={RENDER_ORDER_HIGHLIGHT}
// on the <group> itself. three.js promotes a Group's renderOrder to the
// groupOrder of its whole subtree, and reversePainterSortStable compares
// groupOrder BEFORE renderOrder, so the highlights out-sorted the collision/ID
// debug pass (IdDebugOverlay: renderOrder 9999 but groupOrder 0) and painted
// over it in assembly mode. Part mode was correct only because Body3D's root
// group has no renderOrder.
//
// Two halves, and both matter: the group must stay renderOrder-free, AND every
// child must keep its own RENDER_ORDER_HIGHLIGHT so the fix cannot regress into
// highlights sinking behind the bodies they mark.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AssemblySelectionHighlight from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import { RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

function body(): AssemblyPickBody {
  return {
    bodyKey: 'B',
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['f0'],
    },
    edges: {
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 1]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e0'],
    },
    vertices: { vertices: [[9, 9, 9]], vertexQueries: ['v0'] },
    faceBoundaries: null,
  }
}

// Everything the component can emit: one selected and one hovered of each kind.
function renderAll() {
  return render(
    <AssemblySelectionHighlight
      pickBodies={[body()]}
      selection={new Set(['f0', 'e0', 'v0'])}
      hovered="f0"
    />
  )
}

describe('AssemblySelectionHighlight group render order', () => {
  it('leaves every wrapping group free of renderOrder', () => {
    const { container } = renderAll()
    const groups = container.querySelectorAll('group')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) {
      expect(g.hasAttribute('renderorder')).toBe(false)
    }
  })

  it('keeps RENDER_ORDER_HIGHLIGHT on each drawn highlight child', () => {
    const { container } = renderAll()
    const drawn = container.querySelectorAll('mesh, linesegments, points')
    expect(drawn.length).toBeGreaterThan(0)
    for (const child of drawn) {
      expect(child.getAttribute('renderorder')).toBe(String(RENDER_ORDER_HIGHLIGHT))
    }
  })
})
