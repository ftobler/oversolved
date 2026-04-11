import type { Feature, BodyResult } from '../../types/cad'

export interface BodyRenderItem {
  key: string
  featureId: string
  mesh: NonNullable<BodyResult['mesh']>
  visible: boolean
}

function isInActiveRange(id: string, features: Feature[] | undefined, rollbackPos: number | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return rollbackPos === undefined || idx < rollbackPos
}

export function getBodiesToRender(
  bodies: Record<string, BodyResult> | undefined,
  features: Feature[] | undefined,
  rollbackPosition: number | undefined,
  visibleFeatures: Set<string> | undefined,
): BodyRenderItem[] {
  const items: BodyRenderItem[] = []
  if (!bodies) return items
  for (const [bodyId, body] of Object.entries(bodies)) {
    const createdBy = body.created_by
    if (!isInActiveRange(createdBy, features, rollbackPosition)) continue
    if (!body.mesh) continue
    items.push({
      key: bodyId,
      featureId: bodyId,
      mesh: body.mesh,
      visible: visibleFeatures ? visibleFeatures.has(createdBy) : true,
    })
  }
  return items
}