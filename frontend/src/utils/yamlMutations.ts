import { Document, parseDocument, YAMLSeq } from 'yaml'

// Param layout per entity kind: maps vertexKey to indices in the initial array
const VERTEX_INDICES: Record<string, Record<string, [number, number]>> = {
  line_segment: { start: [0, 1], end: [2, 3] },
  circle:       { center: [0, 1] },
  arc:          { center: [0, 1] },
  point:        { xy: [0, 1] },
}

/** Find entity kind by looking up entities list in the feature */
function findEntityKind(doc: Document, featureId: string, entityId: string): string | undefined {
  const features = doc.get('features') as YAMLSeq | undefined
  if (!features) return undefined
  for (const item of features.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = item as any
    if (node.get?.('id') === featureId) {
      const entities = node.get('entities') as YAMLSeq | undefined
      if (!entities) return undefined
      for (const ent of entities.items) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ent as any
        if (e.get?.('id') === entityId) return e.get('kind') as string
      }
    }
  }
  return undefined
}

/** Find the feature node by id */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findFeature(doc: Document, featureId: string): any | undefined {
  const features = doc.get('features') as YAMLSeq | undefined
  if (!features) return undefined
  for (const item of features.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = item as any
    if (node.get?.('id') === featureId) return node
  }
  return undefined
}

/**
 * Move a vertex in the initial param array.
 * Modifies doc in place and returns it.
 */
export function applyMoveVertex(
  doc: Document,
  featureId: string,
  entityId: string,
  vertexKey: string,
  to: [number, number],
): Document {
  const kind = findEntityKind(doc, featureId, entityId)
  if (!kind) return doc
  const indices = VERTEX_INDICES[kind]?.[vertexKey]
  if (!indices) return doc

  const feature = findFeature(doc, featureId)
  if (!feature) return doc
  const initial = feature.get('initial')
  if (!initial) return doc
  const params = initial.get(entityId) as YAMLSeq | undefined
  if (!params) return doc

  params.set(indices[0], Math.round(to[0] * 1000) / 1000)
  params.set(indices[1], Math.round(to[1] * 1000) / 1000)
  return doc
}

/**
 * Add a constraint to a feature's constraints list.
 * Builds a minimal constraint node from kind + targets.
 */
export function applyAddConstraint(
  doc: Document,
  featureId: string,
  constraintKind: string,
  targets: string[],
): Document {
  const feature = findFeature(doc, featureId)
  if (!feature) return doc

  let constraints = feature.get('constraints') as YAMLSeq | undefined
  if (!constraints) {
    feature.set('constraints', doc.createNode([]))
    constraints = feature.get('constraints') as YAMLSeq
  }

  // Generate unique constraint id
  const existingIds = new Set<string>()
  for (const c of constraints.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (c as any).get?.('id')
    if (id) existingIds.add(id)
  }
  let idx = existingIds.size + 1
  let cid = `c_${constraintKind}_${idx}`
  while (existingIds.has(cid)) { idx++; cid = `c_${constraintKind}_${idx}` }

  // Parse targets: "entity:featureId:entityId" or "vertex:featureId:entityId:vertexKey"
  const parseTarget = (t: string) => {
    const parts = t.split(':')
    if (parts[0] === 'entity') return { entity: parts[2] }
    if (parts[0] === 'vertex') return { entity: parts[2], point: parts[3] }
    return { entity: t }
  }

  // Build constraint based on kind
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry: Record<string, any> = { id: cid, kind: constraintKind }

  if (targets.length === 1) {
    entry.target = parseTarget(targets[0])
  } else if (targets.length >= 2) {
    entry.a = parseTarget(targets[0])
    entry.b = parseTarget(targets[1])
  }

  constraints.add(doc.createNode(entry))
  return doc
}

/**
 * Delete entities and/or constraints by their composite IDs.
 * IDs: "entity:featureId:entityId", "vertex:featureId:entityId:key", "constraint:featureId:cid"
 */
export function applyDeleteElements(doc: Document, targets: string[]): Document {
  // Group by feature
  const byFeature: Record<string, { entities: Set<string>; constraints: Set<string> }> = {}
  for (const t of targets) {
    const parts = t.split(':')
    const fid = parts[1]
    if (!byFeature[fid]) byFeature[fid] = { entities: new Set(), constraints: new Set() }
    if (parts[0] === 'entity') byFeature[fid].entities.add(parts[2])
    if (parts[0] === 'constraint') byFeature[fid].constraints.add(parts[2])
    // vertex deletion maps to entity deletion
    if (parts[0] === 'vertex') byFeature[fid].entities.add(parts[2])
  }

  for (const [fid, { entities: entsToDelete, constraints: consToDelete }] of Object.entries(byFeature)) {
    const feature = findFeature(doc, fid)
    if (!feature) continue

    // Remove from entities list
    if (entsToDelete.size > 0) {
      const entList = feature.get('entities') as YAMLSeq | undefined
      if (entList) {
        const toRemove: number[] = []
        entList.items.forEach((item, i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const id = (item as any).get?.('id')
          if (id && entsToDelete.has(id)) toRemove.push(i)
        })
        for (const i of toRemove.reverse()) entList.delete(i)
      }

      // Remove from initial
      const initial = feature.get('initial')
      if (initial) {
        for (const eid of entsToDelete) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(initial as any).delete?.(eid)
        }
      }
    }

    // Remove from constraints list
    if (consToDelete.size > 0) {
      const conList = feature.get('constraints') as YAMLSeq | undefined
      if (conList) {
        const toRemove: number[] = []
        conList.items.forEach((item, i) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const id = (item as any).get?.('id')
          if (id && consToDelete.has(id)) toRemove.push(i)
        })
        for (const i of toRemove.reverse()) conList.delete(i)
      }
    }
  }

  return doc
}

// All coordinate index pairs per entity kind, in order (used by applyMoveEntity)
const ALL_COORD_INDICES: Record<string, [number, number][]> = {
  line_segment: [[0, 1], [2, 3]],
  circle:       [[0, 1]],
  arc:          [[0, 1]],
  point:        [[0, 1]],
}

/**
 * Translate an entire entity by a delta (dx, dy).
 * Offsets all coordinate pairs in the initial param array.
 */
export function applyMoveEntity(
  doc: Document,
  featureId: string,
  entityId: string,
  delta: [number, number],
): Document {
  const [dx, dy] = delta
  if (dx === 0 && dy === 0) return doc
  const kind = findEntityKind(doc, featureId, entityId)
  if (!kind) return doc
  const coordPairs = ALL_COORD_INDICES[kind]
  if (!coordPairs) return doc

  const feature = findFeature(doc, featureId)
  if (!feature) return doc
  const initial = feature.get('initial')
  if (!initial) return doc
  const params = initial.get(entityId) as YAMLSeq | undefined
  if (!params) return doc

  for (const [xi, yi] of coordPairs) {
    const x = params.get(xi) as number
    const y = params.get(yi) as number
    params.set(xi, Math.round((x + dx) * 1000) / 1000)
    params.set(yi, Math.round((y + dy) * 1000) / 1000)
  }
  return doc
}

/**
 * Update the `value` field of an existing constraint.
 * Used for editing dimension values via dialog.
 */
export function applySetConstraintValue(
  doc: Document,
  featureId: string,
  constraintId: string,
  value: number,
): Document {
  const feature = findFeature(doc, featureId)
  if (!feature) return doc
  const constraints = feature.get('constraints') as YAMLSeq | undefined
  if (!constraints) return doc
  for (const item of constraints.items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = item as any
    if (c.get?.('id') === constraintId) {
      c.set('value', Math.round(value * 1000) / 1000)
      return doc
    }
  }
  return doc
}

/** Parse YAML string to Document, preserving comments/formatting */
export function parseYamlDoc(content: string): Document {
  return parseDocument(content)
}
