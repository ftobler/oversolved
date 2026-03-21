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

  params.set(indices[0], Math.round(to[0] * 1e6) / 1e6)
  params.set(indices[1], Math.round(to[1] * 1e6) / 1e6)
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
    params.set(xi, Math.round((x + dx) * 1e6) / 1e6)
    params.set(yi, Math.round((y + dy) * 1e6) / 1e6)
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

const KIND_PREFIX: Record<string, string> = {
  line_segment: 'line',
  circle:       'circle',
  arc:          'arc',
  point:        'point',
}

/**
 * Add a new entity to a feature's entities list and initial params.
 * Generates a unique entity ID based on kind prefix.
 */
export function applyAddEntity(
  doc: Document,
  featureId: string,
  kind: string,
  params: number[],
): Document {
  const feature = findFeature(doc, featureId)
  if (!feature) return doc

  // Collect existing entity IDs for uniqueness
  const existingIds = new Set<string>()
  const entList = feature.get('entities') as YAMLSeq | undefined
  if (entList) {
    for (const item of entList.items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (item as any).get?.('id')
      if (id) existingIds.add(id)
    }
  }

  const prefix = KIND_PREFIX[kind] ?? kind
  let idx = 1
  let eid = `${prefix}${idx}`
  while (existingIds.has(eid)) { idx++; eid = `${prefix}${idx}` }

  // Add to entities list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryNode = doc.createNode({ id: eid, kind }) as any
  if (!entList) {
    feature.set('entities', doc.createNode([]))
    ;(feature.get('entities') as YAMLSeq).add(entryNode)
  } else {
    entList.add(entryNode)
  }

  // Add to initial params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let initial = feature.get('initial') as any
  if (!initial) {
    feature.set('initial', doc.createNode({}))
    initial = feature.get('initial')
  }
  const roundedParams = params.map(p => Math.round(p * 1e6) / 1e6)
  initial.set(eid, doc.createNode(roundedParams))

  return doc
}

/**
 * Add a rectangle as 4 line segments with 8 automatic constraints:
 *   4× coincident (connecting corners), 2× equal_length (opposite sides),
 *   1× horizontal (bottom side), 1× vertical (right side).
 * Single undo step for the whole operation.
 */
export function applyAddRect(
  doc: Document,
  featureId: string,
  p0: [number, number],
  p1: [number, number],
): Document {
  const [x0, y0] = p0
  const [x1, y1] = p1
  const feature = findFeature(doc, featureId)
  if (!feature) return doc

  // Collect existing entity IDs
  const existingIds = new Set<string>()
  const entList = feature.get('entities') as YAMLSeq | undefined
  if (entList) {
    for (const item of entList.items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (item as any).get?.('id')
      if (id) existingIds.add(id)
    }
  }

  // Generate 4 unique line IDs
  const lineIds: string[] = []
  let idx = 1
  for (let i = 0; i < 4; i++) {
    while (existingIds.has(`line${idx}`)) idx++
    lineIds.push(`line${idx}`)
    existingIds.add(`line${idx}`)
    idx++
  }
  const [lA, lB, lC, lD] = lineIds
  const fid = featureId

  // Add 4 line entities (CCW winding: bottom, right, top, left)
  const lines: [string, number[]][] = [
    [lA, [x0, y0, x1, y0]],  // bottom: p0 → (x1,y0)  [horizontal]
    [lB, [x1, y0, x1, y1]],  // right:  (x1,y0) → p1  [vertical]
    [lC, [x1, y1, x0, y1]],  // top:    p1 → (x0,y1)
    [lD, [x0, y1, x0, y0]],  // left:   (x0,y1) → p0
  ]
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entryList = (entList ?? (() => { feature.set('entities', doc.createNode([])); return feature.get('entities') as YAMLSeq })())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let initial = feature.get('initial') as any
  if (!initial) { feature.set('initial', doc.createNode({})); initial = feature.get('initial') }
  for (const [eid, params] of lines) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    entryList.add(doc.createNode({ id: eid, kind: 'line_segment' }) as any)
    initial.set(eid, doc.createNode(params.map(round)))
  }

  // Collect existing constraint IDs
  const existingCids = new Set<string>()
  const conList = feature.get('constraints') as YAMLSeq | undefined
  if (conList) {
    for (const item of conList.items) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const id = (item as any).get?.('id')
      if (id) existingCids.add(id)
    }
  }
  // Ensure constraints list exists
  if (!conList) feature.set('constraints', doc.createNode([]))
  const cList = feature.get('constraints') as YAMLSeq

  const addConstraint = (kind: string, targets: string[]) => {
    let cidx = existingCids.size + 1
    let cid = `c_${kind}_${cidx}`
    while (existingCids.has(cid)) { cidx++; cid = `c_${kind}_${cidx}` }
    existingCids.add(cid)
    const parseTarget = (t: string) => {
      const parts = t.split(':')
      if (parts[0] === 'entity') return { entity: parts[2] }
      if (parts[0] === 'vertex') return { entity: parts[2], point: parts[3] }
      return { entity: t }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry: Record<string, any> = { id: cid, kind }
    if (targets.length === 1) entry.target = parseTarget(targets[0])
    else if (targets.length >= 2) { entry.a = parseTarget(targets[0]); entry.b = parseTarget(targets[1]) }
    cList.add(doc.createNode(entry))
  }

  // 4× coincident: connect corners
  addConstraint('coincident', [`vertex:${fid}:${lA}:end`,   `vertex:${fid}:${lB}:start`])
  addConstraint('coincident', [`vertex:${fid}:${lB}:end`,   `vertex:${fid}:${lC}:start`])
  addConstraint('coincident', [`vertex:${fid}:${lC}:end`,   `vertex:${fid}:${lD}:start`])
  addConstraint('coincident', [`vertex:${fid}:${lD}:end`,   `vertex:${fid}:${lA}:start`])
  // 2× equal_length: opposite sides
  addConstraint('equal_length', [`entity:${fid}:${lA}`, `entity:${fid}:${lC}`])
  addConstraint('equal_length', [`entity:${fid}:${lB}`, `entity:${fid}:${lD}`])
  // 1× horizontal, 1× vertical
  addConstraint('horizontal', [`entity:${fid}:${lA}`])
  addConstraint('vertical',   [`entity:${fid}:${lB}`])

  return doc
}

/** Parse YAML string to Document, preserving comments/formatting */
export function parseYamlDoc(content: string): Document {
  return parseDocument(content)
}
