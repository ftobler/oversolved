import type { PartDoc } from '@/types/cad'

export function applyGeometryToFeature(
  doc: PartDoc,
  featureId: string,
  geometry: Record<string, number[]>,
  superfluousConstraintIds: Set<string>,
  resolvedKinds?: Record<string, string>,
): void {
  const featureDef = (doc.features ?? []).find(f => f.id === featureId)
  if (!featureDef) return
  // Projection can resolve an entity to a different kind than was declared at
  // pick time (a tilted circle -> ellipse, a partial ellipse -> spline). Adopt
  // the resolved kind so the stored geometry's param count matches the entity
  // and the renderer draws the right primitive. Applied before `initial` so the
  // kind and its params are written consistently.
  if (resolvedKinds && featureDef.entities) {
    for (const ent of featureDef.entities) {
      const rk = resolvedKinds[ent.id]
      if (rk && ent.kind !== rk) ent.kind = rk
    }
  }
  featureDef.initial = geometry
  if (superfluousConstraintIds.size > 0 && featureDef.constraints) {
    featureDef.constraints = featureDef.constraints.filter(c => !superfluousConstraintIds.has(c.id))
  }
}
