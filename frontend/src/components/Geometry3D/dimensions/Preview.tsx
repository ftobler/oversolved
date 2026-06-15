import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { resolveDimension, dimensionTargets } from '@/registry'
import { parseTarget } from '@/utils/yamlMutations/helpers'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import { computeNaturalDimensionValue, computeAnchorRelativePos, resolveDimPoints } from '@/utils/geometry/dimensionNaturalValue'
import type {
  PartConstraint, PlaneTransform, Sketch,
} from '@/types/cad'
import { LinearDimension } from './Linear'
import { RadiusDimension, DiameterDimension } from './Radial'
import { AngleDimension } from './Angle'

const DEFAULT_DIM_OFFSET = 10

/**
 * Sticky-placement preview. While the dimension tool has at least one pick and
 * a cursor world position is available, render a ghost dim using the same
 * renderer the eventual constraint will use. Reuses computeConstraintRender to
 * synthesise the dim's render shape; passes `interaction=undefined` so the
 * label hit area is not registered into the ID layer (non-pickable preview).
 */
export function DimensionPreview({
  featureId, activeFeatureId, sketch, planeTransform,
}: {
  featureId: string
  activeFeatureId?: string
  sketch: Sketch
  planeTransform?: PlaneTransform
}) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const dimensionPicks = useSketchEditorStore(s => s.dimensionPicks)
  const cursorWorld = useSketchEditorStore(s => s.dimensionCursorWorld)

  // Resolve memo. Recomputes whenever picks / cursor / sketch change.
  const synth = useMemo(() => {
    if (activeTool !== 'dimension') return null
    if (dimensionPicks.length === 0) return null
    const resolved = resolveDimension(dimensionPicks, sketch, featureId)
    if (!resolved) return null
    let kind = resolved.constraintKind
    const targets = dimensionTargets(dimensionPicks)

    // Mirror the mode-switching logic from finalizeDimensionPlacement so the
    // preview shows the correct dimension type as the user positions the cursor.
    if (kind === 'point_distance' && cursorWorld && targets.length >= 2) {
      const pts = resolveDimPoints(kind, targets, sketch, featureId)
      if (pts) {
        const [pa, pb] = pts
        const anchorX = (pa[0] + pb[0]) / 2
        const anchorY = (pa[1] + pb[1]) / 2
        const ox = cursorWorld[0] - anchorX
        const oy = cursorWorld[1] - anchorY
        if (Math.abs(oy) > Math.abs(ox) && Math.abs(oy) > 0.001) {
          kind = 'point_distance_x'
        } else if (Math.abs(ox) > Math.abs(oy) && Math.abs(ox) > 0.001) {
          kind = 'point_distance_y'
        }
      }
    }

    const value = computeNaturalDimensionValue(kind, targets, sketch, featureId) ?? 0

    // Build a fake PartConstraint to feed through computeConstraintRender.
    const refs = targets.map(t => parseTarget(t, featureId))
    const c: PartConstraint = { id: '__dim-preview__', kind, value }
    if (kind === 'length' || kind === 'radius' || kind === 'diameter') {
      c.target = refs[0]
    } else {
      c.a = refs[0]
      c.b = refs[1]
    }

    // Anchor-relative pos so the ghost label tracks the cursor. Shares the
    // commit-time math so preview and committed dim place the label identically.
    if (cursorWorld) {
      const pos = computeAnchorRelativePos(kind, targets, sketch, featureId, cursorWorld)
      if (pos) c.pos = pos
    }

    const render = computeConstraintRender(c, sketch)
    return { kind, render }
  }, [activeTool, dimensionPicks, cursorWorld, sketch, featureId])

  if (featureId !== activeFeatureId) return null
  if (!synth) return null

  const { render } = synth
  if (render.kind === 'dim_linear') {
    return (
      <LinearDimension
        cid='__dim-preview__'
        dim={render as { kind: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }}
        dimOffset={DEFAULT_DIM_OFFSET}
        planeTransform={planeTransform}
      />
    )
  }
  if (render.kind === 'dim_radius') {
    return <RadiusDimension cid='__dim-preview__' dim={render as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }} planeTransform={planeTransform} />
  }
  if (render.kind === 'dim_diameter') {
    return <DiameterDimension cid='__dim-preview__' dim={render as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }} planeTransform={planeTransform} />
  }
  if (render.kind === 'dim_angle') {
    return <AngleDimension cid='__dim-preview__' dim={render as { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }} planeTransform={planeTransform} />
  }
  return null
}
