// The assembly's measurement readout, computed off the bundle's own analytic
// facts and rendered through the one shared measurement core.
//
// The part editor measures sketch entities and B-rep queries; an assembly does
// not carry `face_data`, but it does carry each body's bundle: analytic edge
// curves and (since BUNDLE_SCHEMA 6) face facts, both already in the solved
// pose. So an entity pick resolves to the same primitive classes the part
// editor produces, through the shared `adapters/analytic` classification, and
// `utils/measure/rules` answers it exactly as it answers a part pick. A vertex
// and an assembly built-in still have no geometry beyond their anchor, so those
// two keep `adapters/anchor`.
//
// Pure: no three.js, no store, no ID buffer.
import { lookupAnchor, type AnchorTable } from '@/utils/anchorGizmos'
import type { EntityMateRefs } from '@/utils/anchorCandidates'
import type { AssemblyEntityFacts } from '@/utils/assemblyBodies'
import type { MeasureAssemblyPick, MeasureOp } from '@/kernel/worker/solverProtocol'
import type { Transform3D } from '@/types/cad'
import { anchorPrimitive } from './measure/adapters/anchor'
import { bundleEntityPrimitive } from './measure/adapters/bundle'
import { formatReadoutHud, formatReadouts } from './measure/format'
import { isKernelAsk, measureOne, measurePair, type MeasureResult, type Readout } from './measure/rules'
import type { Primitive } from './measure/primitives'
import { transformPrimitive } from './measure/transform'

/** The assembly built-in key prefix (`assemblyBuiltinEntityKey`). */
const BUILTIN_PREFIX = '__builtin|'
/** The solved-shape id the solve mints for `(handle, partIndex)` (`assemblyPartId`). */
function shapeIdOf(handle: string, partIndex: number): string {
  return `${handle}:body_${partIndex}`
}

interface ParsedEntityKey {
  handle: string
  partIndex: number
  kind: 'face' | 'edge' | 'vertex' | 'body'
  index: number
}

/**
 * `<handle>|<partIndex>|<kind>|<index>` back to its parts. A handle may hold a
 * pipe itself, so only the last three fields are positional. `kind: 'body'`
 * names the whole instance, the drive's way of asking for a clearance or a
 * volume with the same key grammar the viewport uses for an element.
 */
export function parseAssemblyEntityKey(key: string): ParsedEntityKey | null {
  const fields = key.split('|')
  if (fields.length < 4) return null
  const index = Number(fields[fields.length - 1])
  const kind = fields[fields.length - 2]
  const partIndex = Number(fields[fields.length - 2 - 1])
  const handle = fields.slice(0, -3).join('|')
  if (!handle || (kind !== 'face' && kind !== 'edge' && kind !== 'vertex' && kind !== 'body')) return null
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(partIndex) || partIndex < 0) return null
  return { handle, partIndex, kind, index }
}

/** The kernel question a selection asks: the op and the instance entities it names. */
export interface AssemblyMeasureAsk {
  op: MeasureOp
  picks: MeasureAssemblyPick[]
}

export interface AssemblyMeasureContext {
  entityMateRefs: Readonly<EntityMateRefs>
  anchors: Readonly<AnchorTable>
  // Solved body facts, keyed by `handle:body_i`.
  shapeFacts?: Readonly<Record<string, AssemblyEntityFacts>> | null
  // The pose each instance is DRAWN at relative to the pose its bundle was
  // baked at (a committed drag the re-solve has not re-meshed yet). Applying it
  // keeps the readout on the geometry the viewport highlights.
  poseOffsets?: Readonly<Record<string, Transform3D>> | null
  // The tree's part selection. A whole instance is a kernel pick like a part
  // editor's whole-body pick, but only when no B-rep entity is selected: the
  // entity set is the measurement selection once it has anything in it.
  subjectHandle?: string | null
}

interface ResolvedPick {
  primitive: Primitive
  // How the kernel names this pick, when it names body geometry at all. An
  // assembly built-in has no shape, so it asks nothing rather than measuring a
  // made-up one.
  ref: MeasureAssemblyPick | null
}

function offsetPrimitive(
  primitive: Primitive,
  handle: string,
  offsets: AssemblyMeasureContext['poseOffsets'],
): Primitive {
  const offset = offsets?.[handle]
  return offset === undefined ? primitive : transformPrimitive(primitive, offset)
}

/** The anchor-backed primitive a vertex or a built-in key resolves to. */
function anchorPick(
  key: string,
  ctx: AssemblyMeasureContext,
): Primitive | null {
  const ref = ctx.entityMateRefs[key]?.[0]
  if (!ref) return null
  const anchor = lookupAnchor(ctx.anchors, ref)
  return anchor ? anchorPrimitive(anchor) : null
}

function resolveEntityKey(key: string, ctx: AssemblyMeasureContext): ResolvedPick | null {
  const parsed = parseAssemblyEntityKey(key)
  if (!parsed) return null
  if (parsed.kind === 'body') {
    return {
      primitive: { type: 'solid', partId: parsed.handle },
      ref: { handle: parsed.handle, kind: 'body' },
    }
  }
  if (parsed.kind === 'vertex') {
    // A vertex anchor's point IS the vertex, so it keeps the anchor path; the
    // entity key is what scopes it to the right instance's offset.
    const primitive = anchorPick(key, ctx)
    if (!primitive) return null
    return {
      primitive: offsetPrimitive(primitive, parsed.handle, ctx.poseOffsets),
      ref: { handle: parsed.handle, partIndex: parsed.partIndex, kind: 'vertex', index: parsed.index },
    }
  }
  const facts = ctx.shapeFacts?.[shapeIdOf(parsed.handle, parsed.partIndex)]
  const primitive = bundleEntityPrimitive(facts, parsed.kind, parsed.index, key)
  if (!primitive) return null
  return {
    primitive: offsetPrimitive(primitive, parsed.handle, ctx.poseOffsets),
    ref: {
      handle: parsed.handle,
      partIndex: parsed.partIndex,
      kind: parsed.kind,
      index: parsed.index,
    },
  }
}

function resolvePick(key: string, ctx: AssemblyMeasureContext): ResolvedPick | null {
  // A built-in (origin, the three planes) is static assembly frame, never a
  // kernel pick: it has an anchor and no B-rep shape.
  if (key.startsWith(BUILTIN_PREFIX)) {
    const primitive = anchorPick(key, ctx)
    return primitive ? { primitive, ref: null } : null
  }
  return resolveEntityKey(key, ctx)
}

const NOTHING = { readout: null, ask: null } as const

/**
 * The selection's measurement before formatting: the analytic readout when the
 * pair table answers, or the kernel question it asks instead (a spline length,
 * a freeform face, an instance clearance). A pick that cannot resolve makes the
 * whole selection unreadable, as in the part editor; the selection is never
 * shrunk to the picks that happened to resolve.
 */
export function assemblySelectionResolved(
  selection: ReadonlySet<string>,
  ctx: AssemblyMeasureContext,
): { readout: Readout | null; ask: AssemblyMeasureAsk | null } {
  const picks: ResolvedPick[] = []
  if (selection.size === 0) {
    // A whole-instance pick has no B-rep entity key: the tree's part subject is
    // the whole-body analogue of the part editor's `@body` pick.
    if (!ctx.subjectHandle) return NOTHING
    picks.push({ primitive: { type: 'solid', partId: ctx.subjectHandle }, ref: { handle: ctx.subjectHandle, kind: 'body' } })
  } else {
    for (const key of selection) {
      const pick = resolvePick(key, ctx)
      if (!pick) return NOTHING
      picks.push(pick)
    }
  }
  if (picks.length > 2) return NOTHING

  const result: MeasureResult = picks.length === 1
    ? measureOne(picks[0].primitive)
    : measurePair(picks[0].primitive, picks[1].primitive)
  if (result == null) return NOTHING
  if (!isKernelAsk(result)) return { readout: result, ask: null }

  const refs = picks.map((pick) => pick.ref)
  if (refs.some((ref) => ref === null)) return NOTHING
  const oneSided = result.kernel === 'length' || result.kernel === 'area' || result.kernel === 'volume'
  if (oneSided ? picks.length !== 1 : picks.length !== 2) return NOTHING
  return { readout: null, ask: { op: result.kernel, picks: refs as MeasureAssemblyPick[] } }
}

/** The measurement lines for the current assembly selection. */
export function computeAssemblyMeasurements(
  selection: ReadonlySet<string>,
  ctx: AssemblyMeasureContext,
): string[] {
  const { readout } = assemblySelectionResolved(selection, ctx)
  // An assembly document has no length unit; its frame and every anchor are
  // millimetres.
  return readout === null ? [] : formatReadouts(readout, 'mm')
}

/** The HUD's split of the same readout: the primary plus a short inline tail,
 *  the rest behind the disclosure, plus the kernel question to ask. */
export function computeAssemblyHud(
  selection: ReadonlySet<string>,
  ctx: AssemblyMeasureContext,
): { lines: string[]; more: string[]; ask: AssemblyMeasureAsk | null } {
  const { readout, ask } = assemblySelectionResolved(selection, ctx)
  if (readout === null) return { lines: [], more: [], ask }
  return { ...formatReadoutHud(readout, 'mm'), ask }
}
