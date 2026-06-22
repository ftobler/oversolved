import type { ReactNode } from 'react'
import type { PlaneTransform } from '@/types/cad'
import type { DimInteraction } from './useDimInteraction'
import { LinearDimension } from './Linear'
import { RadiusDimension, DiameterDimension } from './Radial'
import { AngleDimension } from './Angle'

/** The owning feature/entity for a dimension's drag interaction. When omitted
 *  the dimension renders read-only (no pointer handlers). */
export type DimInteractionBase = Pick<DimInteraction, 'featureId' | 'entityId'>

function interactionFor(base: DimInteractionBase | undefined, cid: string, promptLabel: string): DimInteraction | undefined {
  return base ? { ...base, constraintId: cid, promptLabel } : undefined
}

/** Render the dimension element for a constraint render block, or null when the
 *  block is not a (renderable) dimension. Shared by the editable and read-only
 *  constraint overlays. */
export function renderDimension(
  cid: string,
  r: { kind: string; [key: string]: unknown },
  dimOffset: number,
  base?: DimInteractionBase,
  planeTransform?: PlaneTransform,
): ReactNode | null {
  switch (r.kind) {
    case 'dim_linear': {
      const dim = r as { kind: string; dimKind?: string; p1: [number, number]; p2: [number, number]; normal: [number, number]; value: number; pos?: [number, number] }
      return <LinearDimension key={cid} cid={cid} dim={dim} dimOffset={dimOffset} interaction={interactionFor(base, cid, 'dimension')} planeTransform={planeTransform} />
    }
    case 'dim_radius': {
      const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
      return <RadiusDimension key={cid} cid={cid} dim={dim} interaction={interactionFor(base, cid, 'radius')} planeTransform={planeTransform} />
    }
    case 'dim_diameter': {
      const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; value: number; pos?: [number, number] }
      return <DiameterDimension key={cid} cid={cid} dim={dim} interaction={interactionFor(base, cid, 'diameter')} planeTransform={planeTransform} />
    }
    case 'dim_angle': {
      const dim = r as { kind: string; p1: [number, number]; p2: [number, number]; p3: [number, number]; p4: [number, number]; value: number; pos?: [number, number] }
      if (!dim.p3 || !dim.p4) return null
      return <AngleDimension key={cid} cid={cid} dim={dim} interaction={interactionFor(base, cid, 'angle in degrees')} planeTransform={planeTransform} />
    }
    default:
      return null
  }
}
