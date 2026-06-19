import type { PartDoc, PartConstraint } from '@/types/cad'

const CONSTRAINT_TARGET_KEYS: (keyof PartConstraint)[] = [
  'target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b',
]

// Check whether a stored wire-format ref (e.g. "$eid", "$eidstart") addresses entityId.
// Local refs are "$eid[sub]" with no separator; a startsWith check is safe because
// entity IDs are random base64url strings and never prefix each other in practice.
function refAddressesEntity(raw: string, entityId: string): boolean {
  return raw.startsWith('$' + entityId)
}

function constraintReferencesAny(c: PartConstraint, removed: Set<string>): boolean {
  for (const key of CONSTRAINT_TARGET_KEYS) {
    const raw = c[key]
    if (typeof raw === 'string') {
      for (const eid of removed) {
        if (refAddressesEntity(raw, eid)) return true
      }
    }
  }
  if (c.refs) {
    for (const raw of c.refs) {
      if (typeof raw === 'string') {
        for (const eid of removed) {
          if (refAddressesEntity(raw, eid)) return true
        }
      }
    }
  }
  return false
}

export function applyGeometryToFeature(
  doc: PartDoc,
  featureId: string,
  geometry: Record<string, number[]>,
  superfluousConstraintIds: Set<string>,
  resolvedKinds?: Record<string, string>,
  projectionErrors?: string[],
): boolean {
  const featureDef = (doc.features ?? []).find(f => f.id === featureId)
  if (!featureDef) return false
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

  if (!projectionErrors || projectionErrors.length === 0) return false

  // Remove projected entities whose source failed to resolve: entities with a
  // `source` field that appear in projectionErrors. Then drop any constraint
  // that references a removed entity so no dangling refs linger in the doc.
  const toRemove = new Set(
    (featureDef.entities ?? [])
      .filter(e => e.source != null && projectionErrors.includes(e.id))
      .map(e => e.id),
  )
  if (toRemove.size === 0) return false

  featureDef.entities = (featureDef.entities ?? []).filter(e => !toRemove.has(e.id))
  if (featureDef.constraints) {
    featureDef.constraints = featureDef.constraints.filter(
      c => !constraintReferencesAny(c, toRemove),
    )
  }
  return true
}
