// Registers the triad gizmo's grab regions into the gizmoHandle ID layer.
// Renders nothing: TriadGizmo owns the visuals, this owns what a pointer can
// hit. Splitting them is the point -- the gizmo draws with depthTest off, and
// only the ID buffer's layer priority reproduces that rule for picking.
//
// The gizmo is screen-scaled, so its world size changes with zoom. Registering
// on every zoom tick would rebuild the ID buffer continuously, so the scale is
// quantized: only a step of more than ~10% re-registers, and the resolver's
// snap window absorbs the residual.

import { useId, useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useIdPipeline } from '@/picking'
import { useRegisteredBody } from '@/picking/idRegistrationUtils'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { buildGizmoPickGeometry, GIZMO_PIXELS } from '@/utils/gizmoPickGeometry'
import type { Quat, Vec3 } from '@/utils/transform3d'

interface GizmoPickLayerProps {
  origin: Vec3
  orientation: Quat
  /**
   * False while a gesture is running: the gizmo then tracks the pointer every
   * frame, and re-registering that fast would thrash the ID buffer to answer a
   * question nobody is asking mid-drag.
   */
  enabled: boolean
}

export default function GizmoPickLayer({ origin, orientation, enabled }: GizmoPickLayerProps) {
  const pipeline = useIdPipeline()
  const { camera } = useThree()
  // Per-instance, not a module constant: a second mount (a split view, or a
  // StrictMode remount whose cleanup races the new register) must not overwrite
  // the first's registration, and one instance's unregister must not remove the
  // other's. The single-viewport-only invariant is broader than this layer.
  const bodyKey = `assembly-triad-gizmo:${useId()}`
  const [pxToWorld, setPxToWorld] = useState(() => p2w(camera))

  useFrame(() => {
    const f = p2w(camera)
    if (f > pxToWorld * 1.1 || f < pxToWorld * 0.91) setPxToWorld(f)
  })

  const [ox, oy, oz] = origin
  const [qx, qy, qz, qw] = orientation
  const scale = GIZMO_PIXELS * pxToWorld

  // Disabled means the layer answers no picks, and useRegisteredBody returns
  // before registering anyway. Building the 1158-triangle soup here would only
  // throw it away the same frame, so the ternary skips the build entirely; the
  // memo factory still runs per move while disabled, but it is now a null return.
  const geometry = useMemo(
    () => (enabled ? buildGizmoPickGeometry([ox, oy, oz], [qx, qy, qz, qw], scale) : null),
    [enabled, ox, oy, oz, qx, qy, qz, qw, scale],
  )

  useRegisteredBody(
    pipeline,
    enabled,
    bodyKey,
    (p) => {
      if (!geometry) return false
      p.gizmoHandleLayer.registerBody({ bodyKey, ...geometry })
      return true
    },
    (p) => p.gizmoHandleLayer.unregisterBody(bodyKey),
    [geometry],
  )

  return null
}
