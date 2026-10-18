import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MsaaPresenter, attachPresenter, detachPresenter } from '@/components/Viewport/msaaPresenter'

/**
 * Takes over the part viewport's render: a positive useFrame priority tells R3F
 * not to call `gl.render` itself, and this draws the frame through the
 * multisampled presenter instead (see msaaPresenter.ts for why). Every other
 * frame callback runs at the default priority, so the scene is settled when
 * this draws.
 *
 * The presenter lives in an effect, not in render, so StrictMode's
 * mount-unmount-mount disposes one and builds a fresh one rather than reusing a
 * disposed target. A frame that arrives before the effect draws directly, and
 * the effect asks for a fresh one: on demand that aliased frame would otherwise
 * stay up until the next unrelated change.
 */
export function MsaaRender() {
  const gl = useThree(state => state.gl)
  const invalidate = useThree(state => state.invalidate)
  const presenter = useRef<MsaaPresenter | null>(null)

  useEffect(() => {
    const p = new MsaaPresenter()
    presenter.current = p
    attachPresenter(gl, p)
    invalidate()
    return () => {
      detachPresenter(gl, p)
      p.dispose()
      presenter.current = null
    }
  }, [gl, invalidate])

  useFrame(({ gl: renderer, scene, camera }) => {
    if (presenter.current) presenter.current.render(renderer, scene, camera)
    else renderer.render(scene, camera)
  }, 1)

  return null
}
