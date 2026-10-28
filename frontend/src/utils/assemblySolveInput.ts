// The one document-to-solve adapter: an AssemblyDoc's instances and mates as
// the solve consumes them. The browser hook and the headless assembly session
// both read this module, so the two drivers cannot disagree about which fields
// travel to the solver (a test pins the hook's re-export to it).

import type { AssemblyDoc, AssemblyFeature } from '@/types/cad'
import type { MateSpec } from '@/kernel/solveAssembly'
import type { PartInputSpec } from '@/kernel/worker/solverProtocol'

export function partSpecs(doc: AssemblyDoc): PartInputSpec[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map(f => ({
      handle: f.instance!.handle,
      doc_id: f.instance!.doc_id,
      transform: f.instance!.transform,
      fixed: f.instance!.fixed,
    }))
}

export function mateSpecs(doc: AssemblyDoc): MateSpec[] {
  return (doc.features ?? [])
    .filter((f): f is AssemblyFeature => f.kind === 'mate' && !!f.mate)
    .map(f => ({
      id: f.id,
      kind: f.mate!.kind,
      // Rebuild each ref from its authored fields only. A hand-edited YAML
      // could carry a stray `inlineAnchor`; dropping it keeps the solve's
      // inline-anchor trust exemption (drag objective only) unreachable from a
      // document. `anchor_descriptor` is the durable identity and must ride
      // along, or a cold-cache resolve loses the only fallback it has.
      ref_a: {
        part: f.mate!.ref_a.part,
        anchor: f.mate!.ref_a.anchor,
        anchor_descriptor: f.mate!.ref_a.anchor_descriptor,
      },
      ref_b: {
        part: f.mate!.ref_b.part,
        anchor: f.mate!.ref_b.anchor,
        anchor_descriptor: f.mate!.ref_b.anchor_descriptor,
      },
      flip: f.mate!.flip,
      // Passed through in its authored form, scalar or vector: normalizing it
      // needs the anchor axis, which only resolves inside the solve (see
      // `mateOffsetVector` at solveAssembly.ts's record build).
      offset: f.mate!.offset,
      // Authored values, including an expression string: the solve boundary
      // refuses an unresolved one rather than reading it as 0.
      angle: f.mate!.angle,
      radius: f.mate!.radius,
      ratio: f.mate!.ratio,
    }))
}
