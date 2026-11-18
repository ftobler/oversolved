// Main-thread resolution of an assembly's sub-assemblies. The document graph is
// walked depth-first, each distinct child document is solved once (memoised by
// its recursive bundle key), and its solved output is flattened into the rigid
// composite the parent's own solve receives.
//
// Pure orchestration over injected callbacks: the browser hook solves through
// the anchor worker, the headless session solves in the kernel worker, and both
// share this walk and its cycle/depth refusals.

import type { AssemblyDoc, MateAnchorDescriptor, Transform3D } from '@/types/cad'
import type { AnchorPose } from './partBundle'
import type { MeshPayload } from './solveAssembly'
import type { AssemblySolveStatus } from './solveAssembly'
import type { MateSpec } from './solveAssembly'
import type { PartInputSpec } from './worker/solverProtocol'
import { partSpecs, mateSpecs } from '@/utils/assemblySolveInput'
import {
  buildAssemblyBundle,
  MAX_SUBASSEMBLY_DEPTH,
  type AssemblyBundle,
  type AssemblyLeaf,
} from './assemblyBundle'

/** The part of a solve reply the composite flattening reads. */
export interface CompositeSolvePayload {
  transforms: Record<string, Transform3D>
  bodies: Record<string, MeshPayload[]>
  anchors: Record<string, Record<string, AnchorPose>>
  anchorDescriptors?: Record<string, Record<string, MateAnchorDescriptor>>
  leaves?: Record<string, AssemblyLeaf[]>
  status?: AssemblySolveStatus
}

export type CompositeSolveFn = (
  docId: string,
  parts: PartInputSpec[],
  mates: MateSpec[],
) => Promise<CompositeSolvePayload | null>

/** The memo is module-level in the browser (one per tab) and per session
 *  headless; its key is the recursive content key, so an edit to any leaf
 *  misses by construction. */
export interface CompositeMemo {
  get(key: string): AssemblyBundle | undefined
  set(key: string, bundle: AssemblyBundle): void
}

const MEMO_CAPACITY = 32

export function createCompositeMemo(): CompositeMemo {
  const entries = new Map<string, AssemblyBundle>()
  return {
    get(key) {
      const found = entries.get(key)
      if (found === undefined) return undefined
      // Refresh the LRU order on a hit.
      entries.delete(key)
      entries.set(key, found)
      return found
    },
    set(key, bundle) {
      entries.delete(key)
      entries.set(key, bundle)
      while (entries.size > MEMO_CAPACITY) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
    },
  }
}

export interface CompositeContext {
  kindOf(docId: string): 'part' | 'assembly' | undefined
  readAssembly(docId: string): Promise<AssemblyDoc | null>
  contentHashOf(docId: string): string | undefined
  // Every doc's key, from assemblyGraph.assemblyHashes.
  hashes: Record<string, string>
  solve: CompositeSolveFn
  memo: CompositeMemo
  nameOf?(docId: string): string | undefined
}

export interface CompositeResolution {
  // Top-level instance handle -> the rigid bundle to send instead of a doc_id.
  overrides: Record<string, AssemblyBundle>
  // Top-level instance handle -> why its sub-assembly could not be resolved.
  // The instance still goes to the solve, but its row reports this by name.
  failures: Record<string, string>
}

function displayName(ctx: CompositeContext, docId: string): string {
  return ctx.nameOf?.(docId) ?? docId
}

/**
 * Resolve every assembly instance of `doc` into a rigid composite. Parts are
 * left alone; the caller's worker loads them from their doc_id as before.
 *
 * A child that cannot be resolved at all (missing entry, unreadable document,
 * cycle, depth cap) is a failure on its top-level row. A child that solves but
 * reports a bad verdict still enters rigidly at its solved poses, with the
 * verdict carried as a warning on the bundle.
 */
export async function resolveSubassemblyBundles(
  doc: AssemblyDoc,
  ctx: CompositeContext,
  stack: ReadonlySet<string> = new Set(),
  depth = 0,
): Promise<CompositeResolution> {
  const overrides: Record<string, AssemblyBundle> = {}
  const failures: Record<string, string> = {}

  for (const part of partSpecs(doc)) {
    if (ctx.kindOf(part.doc_id) !== 'assembly') continue
    const name = displayName(ctx, part.doc_id)

    if (stack.has(part.doc_id)) {
      failures[part.handle] = `circular assembly reference: ${name} is already being solved`
      continue
    }
    if (depth >= MAX_SUBASSEMBLY_DEPTH) {
      failures[part.handle] = `sub-assembly nesting exceeds ${MAX_SUBASSEMBLY_DEPTH} levels at ${name}`
      continue
    }

    const key = ctx.hashes[part.doc_id]
    const cached = key === undefined ? undefined : ctx.memo.get(key)
    if (cached !== undefined) {
      overrides[part.handle] = cached
      continue
    }

    const childDoc = await ctx.readAssembly(part.doc_id)
    if (!childDoc) {
      failures[part.handle] = `cannot read assembly document ${name}`
      continue
    }

    const childResolution = await resolveSubassemblyBundles(
      childDoc,
      ctx,
      new Set([...stack, part.doc_id]),
      depth + 1,
    )
    const childParts = partSpecs(childDoc).map(spec => (
      childResolution.overrides[spec.handle] === undefined
        ? spec
        : { ...spec, bundle: childResolution.overrides[spec.handle] }
    ))
    const result = await ctx.solve(part.doc_id, childParts, mateSpecs(childDoc))
    if (result === null) {
      failures[part.handle] = `sub-assembly solve is unavailable: ${name}`
      continue
    }

    const bundle = buildAssemblyBundle(
      ctx.contentHashOf(part.doc_id) ?? '',
      partSpecs(childDoc).map(spec => ({
        handle: spec.handle,
        doc_id: spec.doc_id,
        doc_rev: 0,
        transform: spec.transform,
        ...(spec.visible !== undefined && { visible: spec.visible }),
      })),
      result,
    )
    // A nested failure is not this child's verdict; the child's own solve marks
    // its failed instance red. This warning makes sure the parent row still says
    // that something below it did not resolve.
    if (Object.keys(childResolution.failures).length > 0) {
      bundle.warning = bundle.warning === undefined
        ? 'a nested sub-assembly failed to resolve'
        : `${bundle.warning}; a nested sub-assembly failed to resolve`
    }
    if (key !== undefined) ctx.memo.set(key, bundle)
    overrides[part.handle] = bundle
  }

  return { overrides, failures }
}
