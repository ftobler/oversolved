// Registers the triad gizmo's grab regions into the gizmoHandle ID layer.
// Renders nothing: TriadGizmo owns the visuals, this owns what a pointer can
// hit. Splitting them is the point -- the gizmo draws with depthTest off, and
// only the ID buffer's layer priority reproduces that rule for picking.
//
// The gizmo is screen-scaled, so its world size changes with zoom. Registering
// on every zoom tick would rebuild the ID buffer continuously, so the scale is
// quantized: only a step of more than ~10% re-registers, and the resolver's
// snap window absorbs the residual.

import { useMemo, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { useIdPipeline } from '@/picking'
import { useRegisteredBody } from '@/picking/idRegistrationUtils'
import { p2w } from '@/utils/geometry/sketchHelpers'
import { buildGizmoPickGeometry, GIZMO_PIXELS } from '@/utils/gizmoPickGeometry'
import type { Quat, Vec3 } from '@/utils/transform3d'

const BODY_KEY = 'assembly-triad-gizmo'

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
  const [pxToWorld, setPxToWorld] = useState(() => p2w(camera))

  useFrame(() => {
    const f = p2w(camera)
    if (f > pxToWorld * 1.1 || f < pxToWorld * 0.91) setPxToWorld(f)
  })

  const [ox, oy, oz] = origin
  const [qx, qy, qz, qw] = orientation
  const scale = GIZMO_PIXELS * pxToWorld

  const geometry = useMemo(
    () => buildGizmoPickGeometry([ox, oy, oz], [qx, qy, qz, qw], scale),
    [ox, oy, oz, qx, qy, qz, qw, scale],
  )

  useRegisteredBody(
    pipeline,
    enabled,
    BODY_KEY,
    (p) => {
      p.gizmoHandleLayer.registerBody({ bodyKey: BODY_KEY, ...geometry })
      return true
    },
    (p) => p.gizmoHandleLayer.unregisterBody(BODY_KEY),
    [geometry],
  )

  return null
}
