import { describe, it, expect, vi } from 'vitest'
import { useEffect } from 'react'
import { render } from '@testing-library/react'
import * as THREE from 'three'

/**
 * useDimLabelScale is the single place that fixes the dimension label hit
 * circle at 30 screen pixels. The frame callback is captured here so the test
 * can drive it against a real Mesh and assert the resulting world scale for a
 * known camera zoom (p2w = 1/zoom).
 */

const frame = vi.hoisted(() => ({ callbacks: [] as Array<() => void> }))

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 2 } }),
  useFrame: (cb: () => void) => { frame.callbacks.push(cb) },
}))

import { useDimLabelScale } from '../useDimLabelScale'

describe('useDimLabelScale', () => {
  it('keeps the attached object at 30 screen pixels across the frame', () => {
    const onRef = vi.fn()
    function Probe({ onRef }: { onRef: (ref: unknown) => void }) {
      const ref = useDimLabelScale()
      useEffect(() => { onRef(ref) }, [ref, onRef])
      return null
    }
    render(<Probe onRef={onRef} />)

    const ref = onRef.mock.calls[0][0] as { current: THREE.Mesh | null }
    const mesh = new THREE.Mesh()
    ref.current = mesh
    for (const cb of frame.callbacks) cb()

    // 30 px * (1 / zoom 2) = 15 world units.
    expect(mesh.scale.x).toBe(15)
    expect(mesh.scale.y).toBe(15)
    expect(mesh.scale.z).toBe(15)
  })
})
