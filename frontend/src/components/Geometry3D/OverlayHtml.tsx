import { useCallback, useState } from 'react'
import type { ComponentProps, CSSProperties } from 'react'
import { Html } from '@react-three/drei'
import { Vector3, type Camera, type Object3D } from 'three'

type OverlayHtmlProps = ComponentProps<typeof Html>

/**
 * Decides whether an anchor may draw its DOM overlay. An orthographic camera
 * draws everything in its clip volume, including anchors behind its own
 * position (near is negative in the viewport), so the volume is the only test
 * that matters. drei's angle-to-view-direction test is a perspective rule and
 * wrongly hides labels off to one side of the model.
 *
 * For a perspective camera the volume still clips, but nothing behind the
 * camera can draw. The dot product with the view direction is drei's own
 * behind-camera test expressed as a sign, so this keeps its result.
 */
// eslint-disable-next-line react-refresh/only-export-components -- test-only pure helper exported alongside the component for direct unit tests
export function overlayAnchorVisible(camera: Camera, worldPos: Vector3): boolean {
  const isPerspective = 'isPerspectiveCamera' in camera && camera.isPerspectiveCamera === true
  if (!isPerspective) {
    const ndcZ = worldPos.clone().project(camera).z
    return ndcZ >= -1 && ndcZ <= 1
  }
  const viewDirection = camera.getWorldDirection(new Vector3())
  const fromCamera = worldPos.clone().sub(camera.getWorldPosition(new Vector3()))
  return fromCamera.dot(viewDirection) >= 0
}

/**
 * The viewport's single drei Html mount. drei calls onOcclude instead of
 * writing `display` when it is given, which hands visibility to this wrapper;
 * calculatePosition is called on the same frame with the live camera, so the
 * visibility check uses the matrices the label is actually placed with.
 */
export function OverlayHtml({ style, ...props }: OverlayHtmlProps) {
  const [hidden, setHidden] = useState(false)

  const calculatePosition = useCallback((el: Object3D, camera: Camera, size: { width: number; height: number }): number[] => {
    const worldPos = new Vector3().setFromMatrixPosition(el.matrixWorld)
    const nextHidden = !overlayAnchorVisible(camera, worldPos)
    setHidden(previous => previous === nextHidden ? previous : nextHidden)
    const ndc = worldPos.project(camera)
    return [ndc.x * size.width / 2 + size.width / 2, -(ndc.y * size.height / 2) + size.height / 2]
  }, [])

  // Only the callback's presence matters: it stops drei applying its
  // perspective-only decision to the outer element over this one's.
  const onOcclude = useCallback(() => {}, [])

  const overlaidStyle: CSSProperties = hidden ? { ...style, display: 'none' } : { ...style }
  return <Html {...props} style={overlaidStyle} calculatePosition={calculatePosition} onOcclude={onOcclude} />
}
