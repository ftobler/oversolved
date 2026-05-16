import type { PartDoc } from '@/types/cad'

export function applyGeometryToFeature(
  doc: PartDoc,
  featureId: string,
  geometry: Record<string, number[]>,
  superfluousConstraintIds: Set<string>,
): void {
  const featureDef = (doc.features ?? []).find(f => f.id === featureId)
  if (!featureDef) return
  featureDef.initial = geometry
  if (superfluousConstraintIds.size > 0 && featureDef.constraints) {
    featureDef.constraints = featureDef.constraints.filter(c => !superfluousConstraintIds.has(c.id))
  }
}
