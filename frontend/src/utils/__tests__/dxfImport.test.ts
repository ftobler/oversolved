// The DXF profile parser contract: each entity kind, the unit rule, the layer
// and annotation report, and the named refusals. Every fixture is an inline
// ASCII DXF string, so a new case costs no file. The writer and the drive
// boundary are covered in dxfImportMutation.test.ts.

import { describe, it, expect } from 'vitest'
import {
  DxfImportError,
  MAX_DXF_IMPORT_BYTES,
  dxfImportLimitError,
  parseDxfProfile,
} from '@/utils/dxfImport'

type Group = [number, string | number]

function entity(type: string, ...groups: Group[]): string[] {
  return ['0', type, ...groups.flatMap(([code, value]) => [String(code), String(value)])]
}

function dxf(entities: string[][], options: { insunits?: number } = {}): string {
  const groups: string[] = ['0', 'SECTION', '2', 'HEADER']
  if (options.insunits !== undefined) groups.push('9', '$INSUNITS', '70', String(options.insunits))
  groups.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES')
  for (const rows of entities) groups.push(...rows)
  groups.push('0', 'ENDSEC', '0', 'EOF')
  return groups.join('\n') + '\n'
}

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0') =>
  entity('LINE', [8, layer], [10, x1], [20, y1], [11, x2], [21, y2])

describe('parseDxfProfile entities', () => {
  it('reads a LINE as its two endpoints', () => {
    const profile = parseDxfProfile(dxf([line(0, 0, 10, 5)]), 'mm')
    expect(profile.entities).toEqual([{ kind: 'line', params: [0, 0, 10, 5] }])
  })

  it('reads a CIRCLE as center and radius', () => {
    const profile = parseDxfProfile(
      dxf([entity('CIRCLE', [10, 3], [20, 4], [40, 2.5])]),
      'mm',
    )
    expect(profile.entities).toEqual([{ kind: 'circle', params: [3, 4, 2.5] }])
  })

  it('reads an ARC as center, radius and a counter-clockwise angle pair', () => {
    const profile = parseDxfProfile(
      dxf([entity('ARC', [10, 1], [20, 2], [40, 3], [50, 0], [51, 90])]),
      'mm',
    )
    expect(profile.entities).toEqual([{ kind: 'arc', params: [1, 2, 3, 0, 90] }])
  })

  it('wraps an ARC that crosses zero degrees through a full turn', () => {
    const profile = parseDxfProfile(
      dxf([entity('ARC', [10, 0], [20, 0], [40, 1], [50, 350], [51, 10])]),
      'mm',
    )
    expect(profile.entities[0].params).toEqual([0, 0, 1, 350, 370])
  })

  it('reads a full-turn ARC as a circle and skips a zero-extent one', () => {
    const full = parseDxfProfile(
      dxf([entity('ARC', [10, 0], [20, 0], [40, 2], [50, 0], [51, 360])]),
      'mm',
    )
    expect(full.entities).toEqual([{ kind: 'circle', params: [0, 0, 2] }])
    expect(() => parseDxfProfile(
      dxf([entity('ARC', [10, 0], [20, 0], [40, 2], [50, 30], [51, 30])]),
      'mm',
    )).toThrow(/no importable geometry \(skipped 1 degenerate curve\)/)
  })

  it('reads a full ELLIPSE with a normalized major axis', () => {
    const profile = parseDxfProfile(
      dxf([entity('ELLIPSE', [10, 1], [20, 2], [11, 10], [21, 0], [40, 0.5])]),
      'mm',
    )
    expect(profile.entities).toEqual([{ kind: 'ellipse', params: [1, 2, 10, 5, 0] }])
  })

  it('refuses a partial ellipse by name', () => {
    const text = dxf([entity('ELLIPSE', [10, 0], [20, 0], [11, 10], [21, 0], [40, 0.5], [41, 0], [42, 3.14])])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(DxfImportError)
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/partial ellipse/)
  })

  it('reads a POINT', () => {
    const profile = parseDxfProfile(dxf([entity('POINT', [10, 7], [20, -2])]), 'mm')
    expect(profile.entities).toEqual([{ kind: 'point', params: [7, -2] }])
  })

  it('turns an LWPOLYLINE bulge into an arc and the next segment into a line', () => {
    const text = dxf([
      entity('LWPOLYLINE', [90, 3], [70, 0], [10, 0], [20, 0], [42, 1], [10, 2], [20, 0], [10, 2], [20, 2]),
    ])
    const { entities } = parseDxfProfile(text, 'mm')
    expect(entities).toHaveLength(2)
    expect(entities[0].kind).toBe('arc')
    expect(entities[0].params[0]).toBeCloseTo(1)
    expect(entities[0].params[1]).toBeCloseTo(0)
    expect(entities[0].params[2]).toBeCloseTo(1)
    expect(entities[0].params[3]).toBeCloseTo(180)
    expect(entities[0].params[4]).toBeCloseTo(360)
    expect(entities[1]).toEqual({ kind: 'line', params: [2, 0, 2, 2] })
  })

  it('closes an LWPOLYLINE and emits the four rectangle sides', () => {
    const text = dxf([
      entity(
        'LWPOLYLINE', [90, 4], [70, 1],
        [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 5], [10, 0], [20, 5],
      ),
    ])
    const { entities } = parseDxfProfile(text, 'mm')
    expect(entities.map(e => e.params)).toEqual([
      [0, 0, 10, 0],
      [10, 0, 10, 5],
      [10, 5, 0, 5],
      [0, 5, 0, 0],
    ])
  })

  it('reads an old-style POLYLINE with VERTEX rows and SEQEND', () => {
    const text = dxf([
      entity('POLYLINE', [70, 0]),
      entity('VERTEX', [10, 0], [20, 0], [42, -1]),
      entity('VERTEX', [10, 2], [20, 0]),
      entity('SEQEND'),
    ])
    const { entities } = parseDxfProfile(text, 'mm')
    expect(entities).toHaveLength(1)
    expect(entities[0].kind).toBe('arc')
    // A clockwise bulge is stored as the same counter-clockwise arc, so its
    // endpoints swap and the pair still spans 180 degrees.
    expect(entities[0].params[0]).toBeCloseTo(1)
    expect(entities[0].params[3]).toBeCloseTo(0)
    expect(entities[0].params[4]).toBeCloseTo(180)
  })

  it('reads a single-span cubic Bezier SPLINE as its four control points', () => {
    const text = dxf([
      entity(
        'SPLINE', [70, 0], [71, 3], [72, 4], [73, 4],
        [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1],
        [10, 0], [20, 0], [10, 1], [20, 2], [10, 3], [20, 2], [10, 4], [20, 0],
      ),
    ])
    expect(parseDxfProfile(text, 'mm').entities).toEqual([
      { kind: 'spline', params: [0, 0, 1, 2, 3, 2, 4, 0] },
    ])
  })

  it('refuses a multi-control SPLINE by name rather than dropping it', () => {
    const text = dxf([
      entity(
        'SPLINE', [70, 0], [71, 3], [72, 5], [73, 5],
        [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1], [40, 2],
        [10, 0], [20, 0], [10, 1], [20, 2], [10, 2], [20, 2], [10, 3], [20, 2], [10, 4], [20, 0],
      ),
    ])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/SPLINE: 5 control points/)
  })

  it('refuses a rational SPLINE by name', () => {
    const text = dxf([
      entity(
        'SPLINE', [70, 4], [71, 3], [72, 4], [73, 4],
        [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1],
        [10, 0], [20, 0], [41, 1], [10, 1], [20, 2], [41, 0.5], [10, 3], [20, 2], [41, 1], [10, 4], [20, 0], [41, 1],
      ),
    ])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/rational spline/)
  })

  it('imports repeated entities instead of deduplicating them', () => {
    const text = dxf([line(0, 0, 10, 0), line(0, 0, 10, 0)])
    expect(parseDxfProfile(text, 'mm').entities).toHaveLength(2)
  })

  it('reports the layer counts and imports every layer', () => {
    const text = dxf([line(0, 0, 10, 0, 'profile'), line(0, 5, 10, 5, 'hidden')])
    const profile = parseDxfProfile(text, 'mm')
    expect(profile.entities).toHaveLength(2)
    expect(profile.layers).toEqual({ profile: 1, hidden: 1 })
  })
})

describe('parseDxfProfile units', () => {
  const inchLine = () => dxf([line(0, 0, 1, 0)], { insunits: 1 })
  const mmLine = () => dxf([line(0, 0, 25.4, 0)], { insunits: 4 })

  it('converts an inch file into a millimetre document', () => {
    const profile = parseDxfProfile(inchLine(), 'mm')
    expect(profile.unit).toEqual({ code: 1, name: 'inch' })
    expect(profile.scale).toBe(25.4)
    expect(profile.entities[0].params[2]).toBeCloseTo(25.4)
  })

  it('converts a millimetre file into an inch document', () => {
    const profile = parseDxfProfile(mmLine(), 'inch')
    expect(profile.scale).toBeCloseTo(1 / 25.4)
    expect(profile.entities[0].params[2]).toBeCloseTo(1)
  })

  it('reads an absent $INSUNITS as the document unit', () => {
    const profile = parseDxfProfile(dxf([line(0, 0, 7, 0)]), 'inch')
    expect(profile.unit).toEqual({ code: 0, name: 'unitless' })
    expect(profile.scale).toBe(1)
    expect(profile.entities[0].params[2]).toBe(7)
  })

  it('refuses an unsupported $INSUNITS by code', () => {
    const text = dxf([line(0, 0, 1, 0)], { insunits: 3 })
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/\$INSUNITS 3/)
  })

  it('refuses a non-integer $INSUNITS', () => {
    const text = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\noops\n0\nENDSEC\n'
      + '0\nSECTION\n2\nENTITIES\n' + line(0, 0, 1, 0).join('\n') + '\n0\nENDSEC\n0\nEOF\n'
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/\$INSUNITS is not an integer/)
  })
})

describe('parseDxfProfile refusals', () => {
  it('skips and counts annotation entities', () => {
    const text = dxf([
      entity('TEXT', [10, 0], [20, 0], [1, 'hello']),
      entity('DIMENSION', [10, 0], [20, 0]),
      line(0, 0, 5, 0),
    ])
    const profile = parseDxfProfile(text, 'mm')
    expect(profile.entities).toHaveLength(1)
    expect(profile.skipped).toEqual({ TEXT: 1, DIMENSION: 1 })
  })

  it('skips paper-space entities and keeps the model-space geometry', () => {
    const text = dxf([
      entity('LINE', [67, 1], [10, 0], [20, 0], [11, 5], [21, 0]),
      line(0, 0, 10, 0),
    ])
    const profile = parseDxfProfile(text, 'mm')
    expect(profile.entities).toEqual([{ kind: 'line', params: [0, 0, 10, 0] }])
    expect(profile.skipped).toEqual({ 'paper-space entity': 1 })
  })

  it('refuses an INSERT by name', () => {
    const text = dxf([entity('INSERT', [2, 'BLOCK']), line(0, 0, 5, 0)])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/INSERT/)
  })

  it('refuses an unknown curve entity by name', () => {
    const text = dxf([entity('HATCH', [2, 'SOLID']), line(0, 0, 5, 0)])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/unsupported DXF entity HATCH/)
  })

  it('refuses a 3D POLYLINE by name', () => {
    const text = dxf([
      entity('POLYLINE', [70, 8]),
      entity('VERTEX', [10, 0], [20, 0], [30, 1]),
      entity('VERTEX', [10, 2], [20, 0], [30, 1]),
      entity('SEQEND'),
    ])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/3D polylines/)
  })

  it('refuses a file with no importable geometry', () => {
    const text = dxf([entity('TEXT', [10, 0], [20, 0], [1, 'only text'])])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/no importable geometry \(skipped 1 TEXT\)/)
  })

  it('refuses a file with no ENTITIES section', () => {
    const text = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n'
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/no ENTITIES section/)
  })

  it('refuses a binary DXF before reading it as text groups', () => {
    expect(() => parseDxfProfile('AutoCAD Binary DXF\r\n\u001a', 'mm')).toThrow(/binary DXF/)
  })

  it('refuses a truncated group pair', () => {
    expect(() => parseDxfProfile('0\nSECTION\n2', 'mm')).toThrow(/truncated DXF/)
  })

  it('refuses a malformed LINE that is missing its end y', () => {
    const text = dxf([entity('LINE', [10, 0], [20, 0], [11, 5])])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/malformed LINE: missing end y/)
  })

  it('refuses an LWPOLYLINE whose declared count disagrees with its rows', () => {
    const text = dxf([entity('LWPOLYLINE', [90, 3], [10, 0], [20, 0], [10, 5], [20, 0])])
    expect(() => parseDxfProfile(text, 'mm')).toThrow(/declares 3 vertices but carries 2/)
  })
})

describe('dxfImportLimitError', () => {
  it('admits a file at the limit and refuses one byte over', () => {
    expect(dxfImportLimitError(MAX_DXF_IMPORT_BYTES)).toBeNull()
    expect(dxfImportLimitError(MAX_DXF_IMPORT_BYTES + 1)).toMatch(/too large/)
  })
})
