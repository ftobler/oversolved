// The one canonical document hash the drive layer uses for journal entries,
// repro payloads and replay verification. It reuses the checkpoint
// machinery's serializer (stableJson, key-sorted and Map-normalized) and hash
// (sha256Hex) rather than inventing a second one: the dirty fingerprint
// (session/dirty.ts) stays the save-path hash over the YAML text, and this
// stays the content hash over the document structure.

import type { PartDoc } from '@/types/cad'
import { sha256Hex } from '@/kernel/sha256'
import { stableJson } from '@/kernel/builderHash'

/** The canonical content hash of a document (or any JSON-shaped value). */
export function docHashOf(doc: unknown): string {
  return sha256Hex(stableJson(doc))
}

/**
 * The hash of what the author wrote, invariant under the solver write-back.
 * That write-back bakes solved geometry into each feature's `initial`,
 * reconciles `part_style`, adopts the kind a projected entity resolved to, and
 * reconciles a face projection's member map. None of those is authored, so this
 * projection removes them: `initial` and `part_style` wholesale, `members` from
 * a projection constraint, and the `kind` of any entity a projection holds (the
 * pick-time kind is a hint; the solve owns the resolved one). The projection is
 * shallow on purpose: `stableJson` only reads the features, and a deep clone
 * would cost the whole document on every step.
 */
export function authoredHashOf(doc: PartDoc): string {
  const { part_style: _partStyle, ...authored } = doc
  if (Array.isArray(doc.features)) {
    authored.features = doc.features.map((feature) => {
      const { initial: _initial, ...authoredFeature } = feature as typeof feature & Record<string, unknown>
      const constraints = Array.isArray(authoredFeature.constraints)
        ? authoredFeature.constraints as Array<Record<string, unknown>>
        : undefined
      const held = new Set<string>()
      if (constraints !== undefined) {
        authoredFeature.constraints = constraints.map((constraint) => {
          if (constraint?.kind === 'projection' && typeof constraint.target === 'string') {
            held.add(constraint.target.replace(/^\$/, ''))
          }
          if (constraint?.members === undefined) return constraint
          const { members: _members, ...rest } = constraint
          return rest
        })
      }
      if (held.size > 0 && Array.isArray(authoredFeature.entities)) {
        authoredFeature.entities = (authoredFeature.entities as Array<Record<string, unknown>>).map((entity) => {
          if (!held.has(String(entity.id))) return entity
          const { kind: _kind, ...rest } = entity
          return rest
        })
      }
      return authoredFeature as typeof feature
    })
  }
  return docHashOf(authored)
}
