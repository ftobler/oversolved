import { useMemo } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { resolveDimension } from '@/registry'
import { parseTarget } from '@/utils/yamlMutations/helpers'
import { computeConstraintRender } from '@/utils/geometryMapping'
import { computeNaturalDimensionValue } from '@/utils/dimensionNaturalValue'
import type {
  PartConstraint, PlaneTransform, Sketch,
  DimLinearRender, DimRadiusRender, DimDiameterRender,
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
    const resolved = resolveDimension(dimensionPicks)
    if (!resolved) return null
    const kind = resolved.constraintKind
    const targets = dimensionPicks.length === 2 && dimensionPicks[0].target === dimensionPicks[1].target
      ? [dimensionPicks[0].target]
      : dimensionPicks.map(p => p.target)
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

    // Anchor-relative pos for label placement at the cursor. For kinds whose
    // anchor we know (linear/radius/diameter) we offset to follow the cursor;
    // for angle we leave pos undefined and the preview lands at the default
    // mid-arc position until the user finalises.
    if (cursorWorld) {
      const render0 = computeConstraintRender(c, sketch)
      if (render0.kind === 'dim_linear' || render0.kind === 'dim_diameter') {
        const r0 = render0 as DimLinearRender | DimDiameterRender
        const ax = (r0.p1[0] + r0.p2[0]) / 2
        const ay = (r0.p1[1] + r0.p2[1]) / 2
        c.pos = [cursorWorld[0] - ax, cursorWorld[1] - ay]
      } else if (render0.kind === 'dim_radius') {
        const r0 = render0 as DimRadiusRender
        c.pos = [cursorWorld[0] - r0.p1[0], cursorWorld[1] - r0.p1[1]]
      }
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
