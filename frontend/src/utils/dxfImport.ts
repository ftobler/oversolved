// ASCII DXF profile import: turn the 2D entities of a DXF file into the flat
// parameter blocks the sketch document stores. Pure (no DOM, no store, no
// kernel) so the parser, the mutation boundary and the file picker all judge a
// file the same way.
//
// The contract is deliberately narrow: a curve the sketch cannot represent
// faithfully refuses the whole file by name, so a profile is never half
// imported. Text and dimension annotations are skipped and counted, because
// they are not profile geometry and refusing a drawing over its title block
// would make the import useless.

import type { EntityKind, LengthUnit } from '@/types/cad'
import { MM_PER_LENGTH_UNIT } from '@/utils/lengthUnit'
import { formatBytes } from '@/utils/formatBytes'

export type DxfEntityKind = Extract<EntityKind, 'line' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'point'>

export interface DxfEntity {
  kind: DxfEntityKind
  // The flat params the document stores, already in the document's unit. The
  // writer still rounds them at the stored precision.
  params: number[]
}

export interface DxfUnit {
  // The raw $INSUNITS code; 0 (or absent) is the unitless spelling.
  code: number
  // The name the import report shows, e.g. 'millimeter' or 'unitless'.
  name: string
}

export interface DxfProfile {
  entities: DxfEntity[]
  unit: DxfUnit
  // Coordinates were multiplied by this to land in the document's unit.
  scale: number
  // Annotation entity types that were not imported, with their counts.
  skipped: Record<string, number>
  // Imported entity rows per authored DXF layer.
  layers: Record<string, number>
}

export class DxfImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DxfImportError'
  }
}

// The text is read into one string before parsing, so this bounds the largest
// transient allocation the picker creates. A profile DXF is normally well under
// a megabyte.
export const MAX_DXF_IMPORT_BYTES = 20 * 1024 * 1024

export function dxfImportLimitError(sizeBytes: number): string | null {
  if (sizeBytes <= MAX_DXF_IMPORT_BYTES) return null
  return `DXF file is too large (${formatBytes(sizeBytes)}); the limit is ${formatBytes(MAX_DXF_IMPORT_BYTES)}`
}

interface Pair {
  code: number
  value: string
}

interface RawEntity {
  type: string
  layer: string
  groups: Pair[]
}

// The DXF units the import converts. Mechanical drawings overwhelmingly use one
// of these; an exotic unit refuses by name rather than guessing a factor.
const DXF_UNITS: Record<number, { name: string; mm: number }> = {
  0: { name: 'unitless', mm: 1 },
  1: { name: 'inch', mm: 25.4 },
  2: { name: 'foot', mm: 304.8 },
  4: { name: 'millimeter', mm: 1 },
  5: { name: 'centimeter', mm: 10 },
  6: { name: 'meter', mm: 1000 },
}

// Text and drafting annotation. None of it is profile geometry, so it is
// skipped and reported instead of refusing the file.
const ANNOTATION_TYPES = new Set([
  'TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'DIMENSION', 'LEADER', 'MLEADER', 'MULTILEADER',
  'TOLERANCE', 'ACAD_TABLE', 'VIEWPORT', 'IMAGE', 'WIPEOUT',
])

// A gap smaller than this is the same point: a zero-length segment carries no
// geometry and would leave a degenerate entity the solver cannot use.
const EPSILON = 1e-9

function fail(message: string): never {
  throw new DxfImportError(message)
}

function pairsOf(text: string): Pair[] {
  if (text.startsWith('AutoCAD Binary DXF')) {
    fail('binary DXF is not supported; save the file as an ASCII DXF')
  }
  const lines = text.split(/\r\n|\n|\r/)
  const pairs: Pair[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      // A blank value line is legal (an empty string group). A blank code line
      // shifts every following pair, so only trailing blanks are tolerated.
      if (lines.slice(i).every(line => line.trim() === '')) break
      fail(`malformed DXF: blank line where group code ${i + 1} was expected`)
    }
    const codeText = lines[i].trim()
    if (!/^\d+$/.test(codeText)) {
      fail(`malformed DXF: line ${i + 1} is not a group code (${JSON.stringify(lines[i].slice(0, 40))})`)
    }
    const code = Number(codeText)
    if (i + 1 >= lines.length) {
      fail(`truncated DXF: group code ${code} at line ${i + 1} has no value`)
    }
    pairs.push({ code, value: lines[i + 1] })
    i += 2
  }
  return pairs
}

/** The pairs of one named section, without its SECTION and ENDSEC markers. */
function sectionPairs(pairs: Pair[], name: string): Pair[] | null {
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].code !== 0 || pairs[i].value.trim().toUpperCase() !== 'SECTION') continue
    const title = pairs[i + 1]
    if (title?.code !== 2 || title.value.trim().toUpperCase() !== name) continue
    const body: Pair[] = []
    for (let j = i + 2; j < pairs.length; j++) {
      if (pairs[j].code === 0 && pairs[j].value.trim().toUpperCase() === 'ENDSEC') return body
      body.push(pairs[j])
    }
    fail(`malformed DXF: ${name} section has no ENDSEC`)
  }
  return null
}

function insUnits(header: Pair[] | null): number {
  if (!header) return 0
  for (let i = 0; i < header.length; i++) {
    if (header[i].code !== 9 || header[i].value.trim() !== '$INSUNITS') continue
    const value = header[i + 1]
    if (value?.code !== 70) return 0
    const code = Number(value.value.trim())
    if (!Number.isInteger(code)) {
      fail(`malformed DXF: $INSUNITS is not an integer (${JSON.stringify(value.value)})`)
    }
    return code
  }
  return 0
}

function unitToDocument(code: number, documentUnit: LengthUnit): { unit: DxfUnit; scale: number } {
  const entry = DXF_UNITS[code]
  if (!entry) {
    fail(
      `unsupported DXF $INSUNITS ${code}; supported units are 0 (unitless), 1 (inch), ` +
      '2 (foot), 4 (mm), 5 (cm) and 6 (m)',
    )
  }
  // A unitless file carries no scale, so its numbers are read as document units.
  const scale = code === 0 ? 1 : entry.mm / MM_PER_LENGTH_UNIT[documentUnit]
  return { unit: { code, name: entry.name }, scale }
}

function rawEntities(section: Pair[]): RawEntity[] {
  const entities: RawEntity[] = []
  let current: RawEntity | null = null
  for (const pair of section) {
    if (pair.code === 0) {
      if (current) entities.push(current)
      current = { type: pair.value.trim().toUpperCase(), layer: '0', groups: [] }
    } else if (current) {
      current.groups.push(pair)
      if (pair.code === 8) current.layer = pair.value.trim()
    }
  }
  if (current) entities.push(current)
  return entities
}

function firstPair(entity: RawEntity, code: number): Pair | undefined {
  return entity.groups.find(pair => pair.code === code)
}

function numOf(entity: RawEntity, code: number, what: string): number {
  const pair = firstPair(entity, code)
  if (!pair) fail(`malformed ${entity.type}: missing ${what} (group ${code})`)
  const value = Number(pair.value.trim())
  if (!Number.isFinite(value)) {
    fail(`malformed ${entity.type}: ${what} is not a number (${JSON.stringify(pair.value)})`)
  }
  return value
}

function optionalNum(entity: RawEntity, code: number): number | undefined {
  const pair = firstPair(entity, code)
  if (!pair) return undefined
  const value = Number(pair.value.trim())
  return Number.isFinite(value) ? value : undefined
}

function intOf(entity: RawEntity, code: number, fallback: number): number {
  const value = optionalNum(entity, code)
  return value === undefined ? fallback : Math.trunc(value)
}

function normalizeDegrees(angle: number): number {
  const wrapped = angle % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/** A DXF/LW polyline vertex: the bulge belongs to the segment that starts here. */
interface PolyVertex {
  x: number
  y: number
  bulge: number
}

function vertexParams(entity: RawEntity, what: string): PolyVertex {
  return {
    x: numOf(entity, 10, `${what} x`),
    y: numOf(entity, 20, `${what} y`),
    bulge: optionalNum(entity, 42) ?? 0,
  }
}

/** The arc a bulge sweeps from `a` to `b` (bulge = tan(sweep / 4), positive is
 *  counter-clockwise). The sketch arc is always counter-clockwise, so a
 *  clockwise bulge emits the same curve with its endpoints swapped. */
function bulgeArc(a: PolyVertex, b: PolyVertex, distance: number): DxfEntity {
  const sweep = 4 * Math.atan(a.bulge)
  const half = sweep / 2
  const radius = Math.abs((distance / 2) / Math.sin(half))
  const centreOffset = (distance / 2) / Math.tan(half)
  const nx = -(b.y - a.y) / distance
  const ny = (b.x - a.x) / distance
  const cx = (a.x + b.x) / 2 + nx * centreOffset
  const cy = (a.y + b.y) / 2 + ny * centreOffset
  const startAngle = (Math.atan2(a.y - cy, a.x - cx) * 180) / Math.PI
  const endAngle = (Math.atan2(b.y - cy, b.x - cx) * 180) / Math.PI
  const sweepDegrees = (sweep * 180) / Math.PI
  if (sweepDegrees > 0) {
    const a0 = normalizeDegrees(startAngle)
    return { kind: 'arc', params: [cx, cy, radius, a0, a0 + sweepDegrees] }
  }
  const a0 = normalizeDegrees(endAngle)
  return { kind: 'arc', params: [cx, cy, radius, a0, a0 - sweepDegrees] }
}

function polySegments(
  vertices: PolyVertex[],
  closed: boolean,
  what: string,
  skipped: Record<string, number>,
): DxfEntity[] {
  if (vertices.length < 2) {
    skipped[`${what} with fewer than two vertices`] = (skipped[`${what} with fewer than two vertices`] ?? 0) + 1
    return []
  }
  const segments: DxfEntity[] = []
  // A closed two-vertex polyline already has its one segment; closing it again
  // would stack the same line on itself.
  const count = closed && vertices.length > 2 ? vertices.length : vertices.length - 1
  for (let i = 0; i < count; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % vertices.length]
    const distance = Math.hypot(b.x - a.x, b.y - a.y)
    if (distance < EPSILON) {
      skipped['zero-length segment'] = (skipped['zero-length segment'] ?? 0) + 1
      continue
    }
    if (Math.abs(a.bulge) < EPSILON) {
      segments.push({ kind: 'line', params: [a.x, a.y, b.x, b.y] })
    } else {
      segments.push(bulgeArc(a, b, distance))
    }
  }
  return segments
}

function lwPolylineVertices(entity: RawEntity): PolyVertex[] {
  const vertices: PolyVertex[] = []
  let current: PolyVertex | null = null
  for (const pair of entity.groups) {
    if (pair.code === 10) {
      const x = Number(pair.value.trim())
      if (!Number.isFinite(x)) fail(`malformed LWPOLYLINE: vertex x is not a number (${JSON.stringify(pair.value)})`)
      current = { x, y: NaN, bulge: 0 }
      vertices.push(current)
    } else if (pair.code === 20) {
      if (!current) fail('malformed LWPOLYLINE: vertex y without a preceding x')
      const y = Number(pair.value.trim())
      if (!Number.isFinite(y)) fail(`malformed LWPOLYLINE: vertex y is not a number (${JSON.stringify(pair.value)})`)
      current.y = y
    } else if (pair.code === 42) {
      if (!current) fail('malformed LWPOLYLINE: bulge without a vertex')
      const bulge = Number(pair.value.trim())
      if (!Number.isFinite(bulge)) fail(`malformed LWPOLYLINE: bulge is not a number (${JSON.stringify(pair.value)})`)
      current.bulge = bulge
    }
  }
  for (const vertex of vertices) {
    if (!Number.isFinite(vertex.y)) fail('malformed LWPOLYLINE: a vertex has x but no y')
  }
  const declared = optionalNum(entity, 90)
  if (declared !== undefined && Math.trunc(declared) !== vertices.length) {
    fail(`malformed LWPOLYLINE: declares ${Math.trunc(declared)} vertices but carries ${vertices.length}`)
  }
  return vertices
}

function polylineVertices(entity: RawEntity, follow: RawEntity[]): PolyVertex[] {
  const flags = intOf(entity, 70, 0)
  if ((flags & (8 | 16 | 64)) !== 0) {
    fail('unsupported DXF POLYLINE: 3D polylines and polygon meshes do not fit a sketch plane')
  }
  return follow.map(vertex => {
    const vertexFlags = intOf(vertex, 70, 0)
    if ((vertexFlags & (16 | 32 | 64 | 128)) !== 0) {
      fail('unsupported DXF POLYLINE: a 3D or mesh vertex does not fit a sketch plane')
    }
    return vertexParams(vertex, 'POLYLINE vertex')
  })
}

function parseEllipse(entity: RawEntity): DxfEntity | null {
  const cx = numOf(entity, 10, 'center x')
  const cy = numOf(entity, 20, 'center y')
  const mx = numOf(entity, 11, 'major axis x')
  const my = numOf(entity, 21, 'major axis y')
  const ratio = numOf(entity, 40, 'axis ratio')
  const major = Math.hypot(mx, my)
  if (major < EPSILON || ratio <= 0) return null
  const start = optionalNum(entity, 41) ?? 0
  const end = optionalNum(entity, 42) ?? 2 * Math.PI
  const sweep = end - start
  // The document's ellipse is a full conic; a partial ellipse would have to
  // become an ellipse_arc edge the sketch does not author.
  if (Math.abs(sweep) < 2 * Math.PI - 1e-9) {
    fail(
      `unsupported ELLIPSE: a partial ellipse (parameter ${start} to ${end}) cannot be a sketch entity; ` +
      'only a full ellipse imports',
    )
  }
  let a = major
  let b = major * ratio
  let theta = (Math.atan2(my, mx) * 180) / Math.PI
  if (b > a) {
    // The document requires a >= b; swapping keeps the same ellipse and moves
    // the major axis a quarter turn.
    const majorRadius = a
    a = b
    b = majorRadius
    theta += 90
  }
  return { kind: 'ellipse', params: [cx, cy, a, b, theta] }
}

function parseSpline(entity: RawEntity): DxfEntity {
  const flags = intOf(entity, 70, 0)
  if ((flags & 1) !== 0 || (flags & 2) !== 0) {
    fail('unsupported SPLINE: a closed or periodic spline cannot be one sketch spline')
  }
  const degree = intOf(entity, 71, 0)
  if (degree !== 3) {
    fail(`unsupported SPLINE: degree ${degree}; the sketch supports one cubic Bezier span (degree 3)`)
  }
  const controls: Array<{ x: number; y: number }> = []
  let current: { x: number; y: number } | null = null
  const weights: number[] = []
  const knots: number[] = []
  for (const pair of entity.groups) {
    if (pair.code === 10) {
      const x = Number(pair.value.trim())
      if (!Number.isFinite(x)) fail(`malformed SPLINE: control point x is not a number (${JSON.stringify(pair.value)})`)
      current = { x, y: NaN }
      controls.push(current)
    } else if (pair.code === 20) {
      if (!current) fail('malformed SPLINE: control point y without a preceding x')
      const y = Number(pair.value.trim())
      if (!Number.isFinite(y)) fail(`malformed SPLINE: control point y is not a number (${JSON.stringify(pair.value)})`)
      current.y = y
    } else if (pair.code === 40) {
      const knot = Number(pair.value.trim())
      if (!Number.isFinite(knot)) fail(`malformed SPLINE: knot is not a number (${JSON.stringify(pair.value)})`)
      knots.push(knot)
    } else if (pair.code === 41) {
      const weight = Number(pair.value.trim())
      if (!Number.isFinite(weight)) fail(`malformed SPLINE: weight is not a number (${JSON.stringify(pair.value)})`)
      weights.push(weight)
    }
  }
  for (const control of controls) {
    if (!Number.isFinite(control.y)) fail('malformed SPLINE: a control point has x but no y')
  }
  if (controls.length !== 4) {
    fail(
      `unsupported SPLINE: ${controls.length} control points; the sketch supports one cubic Bezier span ` +
      '(4 control points)',
    )
  }
  if (weights.length > 0 && weights.some(weight => Math.abs(weight - 1) > 1e-9)) {
    fail('unsupported SPLINE: a rational spline (weights other than 1) cannot be a sketch spline')
  }
  if (knots.length !== 8) {
    fail(`unsupported SPLINE: ${knots.length} knots; a single clamped cubic span needs 8`)
  }
  const sameKnot = (a: number, b: number) => Math.abs(a - b) < 1e-9
  const clamped = sameKnot(knots[0], knots[1]) && sameKnot(knots[1], knots[2]) && sameKnot(knots[2], knots[3])
    && sameKnot(knots[4], knots[5]) && sameKnot(knots[5], knots[6]) && sameKnot(knots[6], knots[7])
    && knots[0] < knots[7]
  if (!clamped) {
    fail('unsupported SPLINE: the knot vector is not one clamped cubic span')
  }
  return {
    kind: 'spline',
    params: [
      controls[0].x, controls[0].y,
      controls[1].x, controls[1].y,
      controls[2].x, controls[2].y,
      controls[3].x, controls[3].y,
    ],
  }
}

function parseArc(entity: RawEntity): DxfEntity | null {
  const cx = numOf(entity, 10, 'center x')
  const cy = numOf(entity, 20, 'center y')
  const radius = numOf(entity, 40, 'radius')
  if (radius <= EPSILON) return null
  const rawStart = numOf(entity, 50, 'start angle')
  const rawEnd = numOf(entity, 51, 'end angle')
  const raw = rawEnd - rawStart
  const start = normalizeDegrees(rawStart)
  const sweep = ((raw % 360) + 360) % 360
  if (sweep < EPSILON) {
    // A full turn can be spelled as equal endpoints a whole number of turns
    // apart; a genuinely zero-extent arc is degenerate and imports nothing.
    if (Math.abs(raw) < 360 - EPSILON) return null
    // A full turn is a circle, the entity the sketch already has for it.
    return { kind: 'circle', params: [cx, cy, radius] }
  }
  return { kind: 'arc', params: [cx, cy, radius, start, start + sweep] }
}

// How many leading params of each kind are lengths. The rest (an arc or
// ellipse angle, an ellipse rotation) are unchanged by a unit conversion.
const LENGTH_SLOTS: Record<DxfEntityKind, number> = {
  line: 4,
  circle: 3,
  arc: 3,
  ellipse: 4,
  spline: 8,
  point: 2,
}

function scaleEntity(entity: DxfEntity, scale: number): DxfEntity {
  if (scale === 1) return entity
  const lengths = LENGTH_SLOTS[entity.kind]
  const params = entity.params.map((value, index) => (index < lengths ? value * scale : value))
  return { kind: entity.kind, params }
}

function describeSkipped(skipped: Record<string, number>): string {
  return Object.entries(skipped).map(([type, count]) => `${count} ${type}`).join(', ')
}

/**
 * Parse an ASCII DXF profile into sketch entity blocks. Throws DxfImportError
 * for a malformed file, an unsupported curve entity, an unsupported unit or a
 * file with no importable geometry; a thrown error means nothing may land.
 */
export function parseDxfProfile(text: string, documentUnit: LengthUnit): DxfProfile {
  const pairs = pairsOf(text)
  const { unit, scale } = unitToDocument(insUnits(sectionPairs(pairs, 'HEADER')), documentUnit)
  const section = sectionPairs(pairs, 'ENTITIES')
  if (!section) {
    fail('not a DXF file: no ENTITIES section')
  }
  const raw = rawEntities(section)
  const entities: DxfEntity[] = []
  const skipped: Record<string, number> = {}
  const layers: Record<string, number> = {}

  const emit = (entity: DxfEntity | null, layer: string) => {
    if (!entity) {
      skipped['degenerate curve'] = (skipped['degenerate curve'] ?? 0) + 1
      return
    }
    const scaled = scaleEntity(entity, scale)
    for (const value of scaled.params) {
      if (!Number.isFinite(value)) fail(`malformed DXF: ${entity.kind} carries a non-finite coordinate`)
    }
    entities.push(scaled)
    layers[layer] = (layers[layer] ?? 0) + 1
  }

  for (let i = 0; i < raw.length; i++) {
    const entity = raw[i]
    // Paper space is a layout view, not model geometry; CadQuery reads the
    // model space too. A POLYLINE still consumes its VERTEX rows below.
    if (entity.type !== 'POLYLINE' && intOf(entity, 67, 0) === 1) {
      skipped['paper-space entity'] = (skipped['paper-space entity'] ?? 0) + 1
      continue
    }
    switch (entity.type) {
      case 'LINE': {
        const x1 = numOf(entity, 10, 'start x')
        const y1 = numOf(entity, 20, 'start y')
        const x2 = numOf(entity, 11, 'end x')
        const y2 = numOf(entity, 21, 'end y')
        if (Math.hypot(x2 - x1, y2 - y1) < EPSILON) {
          skipped['zero-length LINE'] = (skipped['zero-length LINE'] ?? 0) + 1
        } else {
          emit({ kind: 'line', params: [x1, y1, x2, y2] }, entity.layer)
        }
        break
      }
      case 'CIRCLE': {
        const cx = numOf(entity, 10, 'center x')
        const cy = numOf(entity, 20, 'center y')
        const radius = numOf(entity, 40, 'radius')
        emit(radius <= EPSILON ? null : { kind: 'circle', params: [cx, cy, radius] }, entity.layer)
        break
      }
      case 'ARC':
        emit(parseArc(entity), entity.layer)
        break
      case 'ELLIPSE':
        emit(parseEllipse(entity), entity.layer)
        break
      case 'POINT':
        emit({ kind: 'point', params: [numOf(entity, 10, 'x'), numOf(entity, 20, 'y')] }, entity.layer)
        break
      case 'LWPOLYLINE': {
        const closed = (intOf(entity, 70, 0) & 1) !== 0
        for (const segment of polySegments(lwPolylineVertices(entity), closed, 'LWPOLYLINE', skipped)) {
          emit(segment, entity.layer)
        }
        break
      }
      case 'POLYLINE': {
        const follow: RawEntity[] = []
        let j = i + 1
        while (j < raw.length && raw[j].type === 'VERTEX') {
          follow.push(raw[j])
          j++
        }
        if (j < raw.length && raw[j].type === 'SEQEND') j++
        i = j - 1
        if (intOf(entity, 67, 0) === 1) {
          skipped['paper-space entity'] = (skipped['paper-space entity'] ?? 0) + 1
          break
        }
        const closed = (intOf(entity, 70, 0) & 1) !== 0
        for (const segment of polySegments(polylineVertices(entity, follow), closed, 'POLYLINE', skipped)) {
          emit(segment, entity.layer)
        }
        break
      }
      case 'SPLINE':
        emit(parseSpline(entity), entity.layer)
        break
      case 'VERTEX':
        fail('malformed DXF: a VERTEX entity appears outside a POLYLINE')
        break
      case 'SEQEND':
        break
      default:
        if (ANNOTATION_TYPES.has(entity.type)) {
          skipped[entity.type] = (skipped[entity.type] ?? 0) + 1
        } else if (entity.type === 'INSERT') {
          fail(
            'unsupported DXF INSERT: a block reference needs flattening, which this import does not do; ' +
            'explode the block before exporting, or export the profile as lines and arcs',
          )
        } else {
          fail(
            `unsupported DXF entity ${entity.type}; this import takes LINE, ARC, CIRCLE, LWPOLYLINE, ` +
            'POLYLINE (2D), SPLINE (one cubic Bezier span), full ELLIPSE and POINT. ' +
            'TEXT, MTEXT, DIMENSION and the other annotation entities are skipped and reported.',
          )
        }
    }
  }

  if (entities.length === 0) {
    const skippedText = Object.keys(skipped).length > 0 ? ` (skipped ${describeSkipped(skipped)})` : ''
    fail(`DXF contains no importable geometry${skippedText}`)
  }
  return { entities, unit, scale, skipped, layers }
}
