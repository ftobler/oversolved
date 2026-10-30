// Expanding `add_part_pattern` into the plain instances and mates it stands for.
//
// A pattern is an authoring macro: nothing about it is stored, so the document
// a client later opens holds only part_instance and mate features (the same
// reason a selector is never stored). This module is the pure half: given the
// part builds' anchor indices it decides every copy's handle, seed pose and
// add_mate step. The drive session runs the result through its normal
// add_part and add_mate paths, so ids, capture and the mate solve behave
// exactly as for hand-written steps.

import type { AssemblyDoc, Transform3D } from '@/types/cad'
import type { Anchor } from '@/kernel/partBundle'
import { findInstance, findMate } from '@/utils/assemblyMutations'
import { orderPatternPoses, seedTransformForPose, type PatternPose } from '@/utils/assemblyPattern'
import { canonicalPerp } from '@/utils/mateOrientation'
import type { AssemblyWireMutation, DrivePatternRefB, PartPatternRequest } from '@/drive/assemblyMutationCatalog'
import { posedAnchor } from '@/drive/assemblyCapture'
import { selectorMatches, type DriveRefFailure, type PartAnchorIndex } from '@/drive/assemblyRefs'

export interface PatternCopy {
  handle: string
  featureId: string
  transform: Transform3D
  // The add_mate step for this copy, refs already in the anchor form.
  mate: Extract<AssemblyWireMutation, { type: 'add_mate' }>
}

export type PatternExpansion =
  | { ok: true; copies: PatternCopy[] }
  | { ok: false; code: DriveRefFailure['code'] | 'invalid-mutation'; message: string }

export interface PatternEnv {
  doc: AssemblyDoc
  // The build index of an existing instance (the pattern side), or why it has none.
  indexFor: (handle: string) => PartAnchorIndex | Error
  // Where an existing instance sits for the purpose of the holes' world poses.
  poseOf: (handle: string) => Transform3D | undefined
  // The build index of the part every copy instantiates.
  partIndex: PartAnchorIndex
}

function refuse(code: DriveRefFailure['code'] | 'invalid-mutation', message: string): PatternExpansion {
  return { ok: false, code, message }
}

type Located = { ok: true; id: string; anchor: Anchor } | DriveRefFailure

function anchorOfQuery(query: string, index: PartAnchorIndex, label: string): Located {
  const ids = index.byQuery.get(query)
  if (ids === undefined) return { ok: false, code: 'unresolved-ref', message: `${label}: query "${query}" is not in the part build` }
  if (ids.length !== 1 || !index.anchors[ids[0]]) {
    return { ok: false, code: 'unresolved-ref', message: `${label}: "${query}" has no matable anchor (freeform faces and ellipse/spline edges have none)` }
  }
  return { ok: true, id: ids[0], anchor: index.anchors[ids[0]] }
}

function locateB(refB: DrivePatternRefB, index: PartAnchorIndex, docId: string): Located {
  if ('anchor' in refB) {
    const anchor = index.anchors[refB.anchor]
    return anchor
      ? { ok: true, id: refB.anchor, anchor }
      : { ok: false, code: 'unresolved-ref', message: `ref_b: part "${docId}" has no anchor "${refB.anchor}"` }
  }
  if ('query' in refB) return anchorOfQuery(refB.query, index, 'ref_b')
  const matched = selectorMatches(refB.selector, index)
  if (!matched.ok) return matched
  if (matched.queries.length !== 1) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `ref_b selector matched ${matched.queries.length} entities on part "${docId}"; make it name exactly one`,
    }
  }
  return anchorOfQuery(matched.queries[0], index, 'ref_b')
}

/**
 * The copies a pattern request stands for, in the pattern's own order. Fails,
 * naming what is wrong, before any copy is built: the selector matching nothing,
 * a match with no anchor, a handle or mate id already taken.
 */
export function expandPartPattern(request: PartPatternRequest, env: PatternEnv): PatternExpansion {
  const refA = request.ref_a as { part: string; selector: unknown }
  const holder = findInstance(env.doc, refA.part)
  if (!holder) return refuse('unknown-target', `ref_a.part "${refA.part}" is not an instance of this assembly`)
  const holderIndex = env.indexFor(refA.part)
  if (holderIndex instanceof Error) {
    return refuse('unresolved-ref', `could not build part "${holder.doc_id}": ${holderIndex.message}`)
  }
  const matched = selectorMatches(refA.selector, holderIndex)
  if (!matched.ok) return refuse(matched.code, `ref_a: ${matched.message}`)
  if (matched.queries.length === 0) {
    return refuse('unresolved-ref', `ref_a selector ${JSON.stringify(refA.selector)} matched no entity on part "${refA.part}"`)
  }

  const holes: Array<PatternPose & { id: string }> = []
  for (const query of matched.queries) {
    const located = anchorOfQuery(query, holderIndex, 'ref_a')
    if (!located.ok) return refuse(located.code, located.message)
    const posed = posedAnchor(located.anchor, env.poseOf(refA.part) ?? holder.transform)
    holes.push({ point: posed.point, axis: posed.axis, x_axis: posed.x_axis ?? canonicalPerp(posed.axis), id: located.id })
  }

  const located = locateB(request.ref_b, env.partIndex, request.part)
  if (!located.ok) return refuse(located.code, located.message)

  const flip = request.flip === true
  const copies: PatternCopy[] = []
  orderPatternPoses(holes).forEach((hole, i) => {
    const handle = `${request.handlePrefix}${i}`
    const featureId = `inst_${handle}`
    const mateId = `${handle}_mate`
    copies.push({
      handle,
      featureId,
      transform: seedTransformForPose(located.anchor, hole, flip),
      mate: {
        type: 'add_mate',
        featureId: mateId,
        kind: request.kind,
        ref_a: { part: refA.part, anchor: hole.id },
        ref_b: { part: handle, anchor: located.id },
        ...(request.flip !== undefined && { flip: request.flip }),
        ...(request.offset !== undefined && { offset: request.offset }),
        ...(request.angle !== undefined && { angle: request.angle }),
        ...(request.radius !== undefined && { radius: request.radius }),
        ...(request.ratio !== undefined && { ratio: request.ratio }),
        ...(request.capture !== undefined && { capture: request.capture }),
      },
    })
  })

  for (const copy of copies) {
    if (findInstance(env.doc, copy.handle)) {
      return refuse('invalid-mutation', `handle "${copy.handle}" already names a part instance; pick another handlePrefix`)
    }
    if (findMate(env.doc, copy.mate.featureId)) {
      return refuse('invalid-mutation', `featureId "${copy.mate.featureId}" already names a mate; pick another handlePrefix`)
    }
  }
  return { ok: true, copies }
}
