import type { PartDoc } from '@/types/cad'

// The transform/delete_body body pick became a LIST in 2026-07 (delete_body in
// fa72b97a on the 27th, transform in 0eab4115 on the 29th). Docs authored
// before that carry the singular `body` key and no `bodies`; the kernel reads
// only `bodies`, so such a doc solves to nothing, and the list mutators crash
// on a missing `bodies`. Every parse seam runs this migration right after
// dropDeadAxisConstraints, so a legacy doc is healed once at load and never
// ships its singular ref to the UI or the solver. Mirrors dropDeadAxisConstraints:
// mutate in place, return the count of features rewritten. Idempotent (a second
// pass rewrites nothing). The mirror feature's own singular `body` is
// intentional and untouched.
export function migrateLegacyBodyPicks(doc: PartDoc): number {
  let rewritten = 0
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'transform' && feature.kind !== 'delete_body') continue
    const sub = (feature.transform ?? feature.delete_body) as unknown as {
      bodies?: unknown
      body?: string
    } | undefined
    if (!sub) continue
    if (!Array.isArray(sub.bodies) && typeof sub.body === 'string') {
      sub.bodies = sub.body ? [sub.body] : []
      rewritten += 1
    }
    delete sub.body
  }
  return rewritten
}
