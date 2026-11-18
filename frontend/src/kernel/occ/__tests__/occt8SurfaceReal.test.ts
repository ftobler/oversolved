// @vitest-environment node
//
// occTypes.ts is the contract between the kernel and the OCCT build: it
// declares every constructor, static and method the kernel touches, with the
// overload suffix and the exact arity. This probe holds the live module to it,
// so a renumbered overload, a member the build stopped binding or a signature
// that grew a defaulted argument fails here by name instead of deep inside a
// feature test.
//
// The declarations are parsed from occTypes.ts itself (the file is regular
// enough for that), so a new declaration is probed without touching this file.
// Each interface names the OCCT class(es) that implement it in INTERFACE_CLASSES;
// an interface missing from that table fails too, so the table cannot fall
// behind. Embind reports a bound function's arity as its `length`, and a
// constructor's in the error it throws on a wrong argument count.
//
// Skips when OCC is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadOcc } from '../loadOcc'
import { extractOccErrorMessage, isKernelTrap, isWasmException } from '../../errors'

const oc = await loadOcc()
const OCC_TYPES = readFileSync(fileURLToPath(new URL('../occTypes.ts', import.meta.url)), 'utf8')

interface Member {
  name: string
  arity: number
  optional: boolean
}

interface Block {
  name: string
  extends: string[]
  members: Member[]
}

/** Top-level comma count of a parameter list, ignoring nested generics/parens. */
function countParams(params: string): number {
  if (params.trim() === '') return 0
  let depth = 0
  let n = 1
  for (const ch of params) {
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) n++
  }
  // A trailing comma (the multi-line style) adds no parameter.
  return params.trim().endsWith(',') ? n - 1 : n
}

/**
 * The methods of an indented block: `M(a, b): T` on one line, or `M(` with one
 * parameter per line closed by `): T`. Property lines (`X: T`) are returned
 * with arity -1 so the caller can treat them as values.
 */
function parseMembers(lines: string[], indent: string): Member[] {
  const out: Member[] = []
  const single = new RegExp(`^${indent}(\\w+)(\\?)?\\((.*)\\): .+$`)
  const open = new RegExp(`^${indent}(\\w+)(\\?)?\\($`)
  const close = new RegExp(`^${indent}\\): `)
  const prop = new RegExp(`^${indent}(\\w+)(\\?)?: (.+)$`)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m = single.exec(line)
    if (m) {
      out.push({ name: m[1], arity: countParams(m[3]), optional: m[2] === '?' })
      continue
    }
    m = open.exec(line)
    if (m) {
      const params: string[] = []
      for (i++; i < lines.length && !close.test(lines[i]); i++) params.push(lines[i].trim())
      out.push({ name: m[1], arity: countParams(params.join(' ')), optional: m[2] === '?' })
      continue
    }
    m = prop.exec(line)
    if (m) out.push({ name: m[1], arity: -1, optional: m[2] === '?' })
  }
  return out
}

function parseInterfaces(src: string): Map<string, Block> {
  const lines = src.split('\n')
  const out = new Map<string, Block>()
  for (let i = 0; i < lines.length; i++) {
    const head = /^export interface (\w+)(?:<\w+>)?(?: extends ([\w, <>]+))? \{$/.exec(lines[i])
    if (!head) continue
    const part: string[] = []
    for (i++; i < lines.length && lines[i] !== '}'; i++) part.push(lines[i])
    const parents = (head[2] ?? '').split(',').map((s) => s.trim().replace(/<.*>$/, '')).filter(Boolean)
    out.set(head[1], { name: head[1], extends: parents, members: parseMembers(part, '  ') })
  }
  return out
}

/** The module interface's members: constructors, static blocks and enums. */
interface ModuleEntry {
  kind: 'ctor' | 'block'
  name: string
  arity: number
  members: Member[]
}

function parseModule(block: Block | undefined, src: string, name: string): ModuleEntry[] {
  if (!block) return []
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^export interface ${name}\\b`).test(l))
  const out: ModuleEntry[] = []
  for (let i = start + 1; i < lines.length && lines[i] !== '}'; i++) {
    const line = lines[i]
    // Module members sit at a two-space indent.
    let m = /^ {2}(\w+): new \((.*)\) => /.exec(line)
    if (m) {
      out.push({ kind: 'ctor', name: m[1], arity: countParams(m[2]), members: [] })
      continue
    }
    m = /^ {2}(\w+): new \($/.exec(line)
    if (m) {
      const params: string[] = []
      for (i++; i < lines.length && !/^ {2}\) => /.test(lines[i]); i++) params.push(lines[i].trim())
      out.push({ kind: 'ctor', name: m[1], arity: countParams(params.join(' ')), members: [] })
      continue
    }
    m = /^ {2}(\w+): \{$/.exec(line)
    if (m) {
      const part: string[] = []
      for (i++; i < lines.length && lines[i] !== '  }'; i++) part.push(lines[i])
      out.push({ kind: 'block', name: m[1], arity: -1, members: parseMembers(part, '    ') })
    }
  }
  return out
}

/**
 * The OCCT classes that implement each interface. `null` marks an interface
 * with nothing of its own to probe: a structural alias, a union shape the
 * kernel narrows at runtime, or a slice another entry covers.
 */
const INTERFACE_CLASSES: Record<string, string[] | null> = {
  OccDisposable: null,
  OccPntArray: ['TColgp_Array1OfPnt'],
  OccRealArray: ['TColStd_Array1OfReal'],
  OccIntArray: ['TColStd_Array1OfInteger'],
  OccBSplineCurve: ['Geom_BSplineCurve'],
  OccBSplineHandle: ['Handle_Geom_BSplineCurve'],
  OccPolygonBuilder: ['BRepBuilderAPI_MakePolygon'],
  OccFaceBuilder: ['BRepBuilderAPI_MakeFace'],
  OccPrismBuilder: ['BRepPrimAPI_MakePrism', 'BRepPrimAPI_MakeRevol'],
  OccCylinderBuilder: ['BRepPrimAPI_MakeCylinder'],
  OccCylinderPrimitive: ['BRepPrim_Cylinder'],
  OccListOfShape: ['TopTools_ListOfShape'],
  OccThruSectionsBuilder: ['BRepOffsetAPI_ThruSections'],
  OccOffsetMaker: ['BRepOffsetAPI_MakeOffset'],
  OccDPrismBuilder: ['LocOpe_DPrism'],
  OccPipeShellBuilder: ['BRepOffsetAPI_MakePipeShell'],
  OccModifierHistory: null,
  // AddDA is the chamfer's; the fillet shares the rest.
  OccEdgeModifierMaker: ['BRepFilletAPI_MakeChamfer'],
  OccThickSolidMaker: ['BRepOffsetAPI_MakeThickSolid'],
  OccOffsetShapeMaker: ['BRepOffsetAPI_MakeOffsetShape'],
  OccDefeaturingMaker: ['BRepAlgoAPI_Defeaturing'],
  OccHistory: ['BRepTools_History'],
  OccHistoryHandle: ['Handle_BRepTools_History'],
  OccExtrema: ['BRepExtrema_DistShapeShape'],
  OccBooleanOp: ['BRepAlgoAPI_Cut', 'BRepAlgoAPI_Fuse', 'BRepAlgoAPI_Common'],
  OccSplitter: ['BRepAlgoAPI_Splitter'],
  OccShapeIntersector: ['IntCurvesFace_ShapeIntersector'],
  OccOffsetInterval: ['BRepOffset_Interval'],
  OccOffsetIntervalList: ['BRepOffset_ListOfInterval'],
  OccOffsetAnalyse: ['BRepOffset_Analyse'],
  OccFaceClassifier: ['BRepClass_FaceClassifier'],
  OccBRepBuilder: ['BRep_Builder'],
  OccUnify: ['ShapeUpgrade_UnifySameDomain'],
  OccExplorer: ['TopExp_Explorer'],
  OccXYZ: ['gp_Pnt', 'gp_Dir', 'gp_Vec'],
  OccPntValue: ['gp_Pnt'],
  OccEnumValue: null,
  OccTriangle: ['Poly_Triangle'],
  OccTriangulationBasic: null,
  OccTriangulation: ['Poly_Triangulation'],
  OccTriangulationHandleBasic: null,
  OccTriangulationHandle: ['Handle_Poly_Triangulation'],
  OccPolygonOnTriangulation: ['Poly_PolygonOnTriangulation'],
  OccPolygonOnTriangulationHandle: ['Handle_Poly_PolygonOnTriangulation'],
  OccGProps: ['GProp_GProps'],
  OccSurfaceAdaptor: ['BRepAdaptor_Surface'],
  OccAnalyticCylinder: ['gp_Cylinder'],
  OccAnalyticCone: ['gp_Cone'],
  OccAnalyticSphere: ['gp_Sphere'],
  OccAnalyticTorus: ['gp_Torus'],
  OccPnt2d: ['gp_Pnt2d'],
  OccCircle2d: ['gp_Circ2d'],
  OccCurve2dAdaptor: ['BRepAdaptor_Curve2d'],
  OccWireExplorer: ['BRepTools_WireExplorer'],
  OccAx3: ['gp_Ax3'],
  OccPln: ['gp_Pln'],
  OccSLProps: ['BRepLProp_SLProps'],
  OccEdgeBuilder: ['BRepBuilderAPI_MakeEdge'],
  OccGeomHandle: ['Handle_Geom_TrimmedCurve'],
  OccArcMaker: ['GC_MakeArcOfCircle', 'GC_MakeArcOfEllipse'],
  OccWireBuilder: ['BRepBuilderAPI_MakeWire'],
  OccVertexBuilder: ['BRepBuilderAPI_MakeVertex'],
  OccShapeFixFace: ['ShapeFix_Face'],
  OccShapeFixWire: ['ShapeFix_Wire'],
  OccLocation: ['TopLoc_Location'],
  OccSubShape: ['TopoDS_Shape'],
  OccAxisDir: ['gp_Ax1'],
  OccCircle: ['gp_Circ'],
  OccEllipse: ['gp_Elips'],
  OccCurveAdaptor: ['BRepAdaptor_Curve'],
  OccBndBox: ['Bnd_Box'],
  OccBaseModule: null,
  OccModule: null,
  OccOrientedShape: ['TopoDS_Shape'],
  OccOrientableShape: ['TopoDS_Shape'],
  OccReShape: ['BRepTools_ReShape', 'ShapeBuild_ReShape'],
  OccReShapeHandle: ['Handle_ShapeBuild_ReShape'],
  OccShapeFixShape: ['ShapeFix_Shape'],
  OccShapeAnalyzer: ['BRepCheck_Analyzer'],
  OccTrsf: ['gp_Trsf'],
  OccTransformBuilder: ['BRepBuilderAPI_Transform'],
  OccCopyBuilder: ['BRepBuilderAPI_Copy'],
  OccTransientHandle: null,
  OccStepReader: ['STEPControl_Reader'],
  OccWorkSession: ['XSControl_WorkSession'],
  OccTransferReader: ['XSControl_TransferReader'],
  OccTransientProcess: ['Transfer_TransientProcess'],
  // Narrowed at runtime: only a shape binder has Result().
  OccTransferBinder: null,
  OccMaybeShape: null,
  OccInterfaceModel: ['Interface_InterfaceModel'],
  OccStepWriter: ['STEPControl_Writer'],
  OccStlWriter: ['StlAPI_Writer'],
  // Nothing of its own to probe in this release: GeomLib (a namespace, so not
  // a constructor) and BRepOffset_MakeOffset are NOT bound in the pinned OCCT
  // build. moveFaceRungs.ts probes both with `typeof`, and the rung 3/4 tests
  // are it.skipIf(!bound); a release bump that binds them flips those tests on.
  OccOptionalNamespace: null,
  OccFaceOffsetMaker: null,
}

/**
 * Optional members the kernel still needs when the build can provide them.
 * `HashCode` is optional in occTypes because subshapeIdentity.ts degrades to a
 * flat scan without it, but without it every identity index is quadratic.
 */
const REQUIRED_OPTIONAL: Record<string, string[]> = {
  TopoDS_Shape: ['HashCode'],
}

/** Module members that are emscripten runtime, not bindings. */
const RUNTIME_BLOCKS = new Set(['FS'])

type Ctor = (new (...args: unknown[]) => { delete?: () => void }) & { prototype: Record<string, unknown> }

/** A constructor's arity from embind's wrong-count error, or 0 when the
 *  zero-argument call constructs. */
function ctorArity(ctor: Ctor): number | string {
  try {
    const made = new ctor()
    made.delete?.()
    return 0
  } catch (e) {
    const m = /expected \((\d+)\) parameters/.exec(String((e as Error).message ?? e))
    return m ? Number(m[1]) : `unreadable (${String((e as Error).message ?? e).slice(0, 80)})`
  }
}

function allMembers(blocks: Map<string, Block>, name: string, seen = new Set<string>()): Member[] {
  const block = blocks.get(name)
  if (!block || seen.has(name)) return []
  seen.add(name)
  const own = new Map(block.members.map((m) => [m.name, m]))
  for (const parent of block.extends) {
    for (const m of allMembers(blocks, parent, seen)) if (!own.has(m.name)) own.set(m.name, m)
  }
  // delete/isDeleted are embind's own, on every class.
  own.delete('delete')
  own.delete('isDeleted')
  return [...own.values()]
}

describe.skipIf(!oc)('occTypes.ts against the live OCCT build', () => {
  const blocks = parseInterfaces(OCC_TYPES)
  const mod = oc as unknown as Record<string, unknown>

  it('names a C++ throw from the module and leaves the module usable', () => {
    // An empty wire builder has no wire: Wire() raises StdFail_NotDone. The
    // 7.4 build compiled such checks out; this one keeps them.
    const builder = new oc!.BRepBuilderAPI_MakeWire_1()
    let thrown: unknown = null
    try {
      builder.Wire()
    } catch (e) {
      thrown = e
    } finally {
      builder.delete()
    }
    expect(isWasmException(thrown)).toBe(true)
    expect(isKernelTrap(thrown)).toBe(false)
    expect(extractOccErrorMessage(oc, thrown)).toMatch(/^OCC threw StdFail_NotDone/)
    // Unwinding ran, so the next call works.
    const vec = new oc!.gp_Vec_1()
    expect(vec.Y()).toBe(0)
    vec.delete()
  })

  it('maps every occTypes interface to its OCCT class', () => {
    const unmapped = [...blocks.keys()].filter((name) => !(name in INTERFACE_CLASSES))
    expect(unmapped, 'add these to INTERFACE_CLASSES').toEqual([])
  })

  it('binds every declared method with the declared arity', () => {
    const problems: string[] = []
    for (const [iface, classes] of Object.entries(INTERFACE_CLASSES)) {
      if (classes === null) continue
      const members = allMembers(blocks, iface).filter((m) => m.arity >= 0)
      for (const cls of classes) {
        const ctor = mod[cls] as Ctor | undefined
        if (typeof ctor !== 'function') {
          problems.push(`${iface}: class ${cls} is not bound`)
          continue
        }
        const required = new Set(REQUIRED_OPTIONAL[cls] ?? [])
        for (const m of members) {
          const fn = ctor.prototype[m.name] as ((...a: unknown[]) => unknown) | undefined
          if (typeof fn !== 'function') {
            if (!m.optional || required.has(m.name)) problems.push(`${iface}: ${cls}.${m.name} is not bound`)
            continue
          }
          if (fn.length !== m.arity) {
            problems.push(`${iface}: ${cls}.${m.name} takes ${fn.length} arguments, occTypes declares ${m.arity}`)
          }
        }
        for (const name of required) {
          if (!members.some((m) => m.name === name) && typeof ctor.prototype[name] !== 'function') {
            problems.push(`${iface}: ${cls}.${name} is not bound`)
          }
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('binds every declared constructor, static and enum value', () => {
    const entries = new Map<string, ModuleEntry>()
    // OccModule redeclares a few OccBaseModule members with richer types; the
    // later declaration is the one the kernel reads.
    for (const name of ['OccBaseModule', 'OccModule']) {
      for (const entry of parseModule(blocks.get(name), OCC_TYPES, name)) entries.set(entry.name, entry)
    }
    expect(entries.size).toBeGreaterThan(50)
    const problems: string[] = []
    for (const entry of entries.values()) {
      if (RUNTIME_BLOCKS.has(entry.name)) continue
      const value = mod[entry.name]
      if (entry.kind === 'ctor') {
        if (typeof value !== 'function') {
          problems.push(`constructor ${entry.name} is not bound`)
          continue
        }
        const arity = ctorArity(value as Ctor)
        if (arity !== entry.arity) problems.push(`constructor ${entry.name} takes ${arity}, occTypes declares ${entry.arity}`)
        continue
      }
      if (value === undefined || value === null) {
        problems.push(`${entry.name} is not bound`)
        continue
      }
      const owner = value as Record<string, unknown>
      for (const m of entry.members) {
        const member = owner[m.name]
        if (member === undefined) {
          if (!m.optional) problems.push(`${entry.name}.${m.name} is not bound`)
          continue
        }
        if (m.arity >= 0 && (member as (...a: unknown[]) => unknown).length !== m.arity) {
          problems.push(
            `${entry.name}.${m.name} takes ${(member as (...a: unknown[]) => unknown).length} arguments, ` +
            `occTypes declares ${m.arity}`,
          )
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })
})
