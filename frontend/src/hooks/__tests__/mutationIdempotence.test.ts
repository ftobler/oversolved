// The total classification in mutationIdempotence: which mutations can write a
// value the doc already holds, so handleMutation pays for the deep compare on
// the true entries only and never swallows a real edit. The
// `satisfies Record<Mutation['type'], boolean>` already fails the build on a
// missing or extra key; these tests pin the same fact at runtime, so a weakened
// type (an index signature, a cast to Partial) cannot slip the hole back in.
//
// The reference for "every Mutation variant" is the dispatch table, whose own
// exhaustive test pins its keys against a hand-written copy of the union. This
// file does not repeat that list, but note the cost: adding a variant to cad.ts
// takes THREE edits, not one. Classify it here, add a handler in
// mutationDispatch.ts, and add the name to the list
// mutationDispatch.exhaustive.test.ts holds. Two of the three are the compiler's
// problem; that list is the one that is not.
//
// The GUARDED array below is the third duplication this file could have avoided,
// kept on purpose. It is the ONLY record of which names the guard covered before
// this table existed, so a diff that flips one to false is visibly a change to
// undo behaviour rather than a reorganisation of the table.
import { describe, it, expect } from 'vitest'
import { IDEMPOTENT_MUTATION } from '@/hooks/mutationIdempotence'
import { mutationHandlers } from '@/hooks/mutationDispatch'

// Every name here has been guarded in every commit since the guard was
// introduced, so flipping one to false changes undo behaviour and has to be
// argued for, not just done.
const GUARDED = [
  'rename_feature',
  'rename_part',
  'reorder_features',
  'reorder_pick_field',
  'set_part_color',
  'set_part_transparency',
  'set_part_metalness',
  'set_part_roughness',
  'set_part_transmission',
  'set_body_visibility',
  'set_feature_visibility',
  'set_feature_suppression',
  'set_feature_plane',
  'set_plane_definition_field',
  'set_extrude_field',
  'set_revolve_field',
  'set_sweep_field',
  'set_fillet_field',
  'set_chamfer_field',
  'set_shell_field',
  'set_move_face_field',
  'set_boolean_field',
  'set_array_field',
  'set_circular_array_field',
  'set_hole_field',
  'set_transform_field',
  'set_mirror_field',
  'set_split_field',
  'set_variable_field',
  'set_helix_field',
  'set_constraint_value',
  'set_constraint_pos',
  'set_constraint_sign',
  'set_rollback',
  'remove_dangling_content',
  'remove_extrude_profile',
  'remove_revolve_profile',
  'remove_sweep_profile',
  'remove_sweep_path',
  'remove_fillet_edge',
  'remove_chamfer_edge',
  'remove_shell_face',
  'remove_move_face_ref',
  'remove_delete_face_ref',
  'remove_boolean_tool',
  'remove_delete_body_ref',
  'remove_transform_body',
  'remove_split_body',
]

describe('mutationIdempotence classification', () => {
  it('classifies exactly the 101 Mutation variants, no more and no fewer', () => {
    expect(Object.keys(IDEMPOTENT_MUTATION)).toHaveLength(101)
    // Sorting ignores key order, so regrouping the table stays free while adding
    // or dropping a name does not.
    expect([...Object.keys(IDEMPOTENT_MUTATION)].sort()).toEqual(Object.keys(mutationHandlers).sort())
  })

  it('gives every variant a real boolean, never a truthy placeholder', () => {
    for (const [type, value] of Object.entries(IDEMPOTENT_MUTATION)) {
      expect(typeof value, `${type} must be an explicit boolean`).toBe('boolean')
    }
  })

  it('reads undefined for a type outside the union, so an index signature cannot hide', () => {
    const loose = IDEMPOTENT_MUTATION as Record<string, boolean | undefined>
    expect(loose['__unknown_type__']).toBeUndefined()
  })

  it('guards exactly the names the hand-maintained Set held', () => {
    const guarded = Object.entries(IDEMPOTENT_MUTATION)
      .filter(([, isIdempotent]) => isIdempotent)
      .map(([type]) => type)
      .sort()
    expect(guarded).toEqual([...GUARDED].sort())
  })

  it('never guards half of a verb family', () => {
    // The verb prefix is the unit that decides: every set_* writes a value into a
    // named place, every add_* appends or toggles, every remove_* removes by
    // index or key. A half-classified family is exactly the mistake a prose-only
    // list invited (a new set_mirror_field added while its siblings were absent)
    // and it fails silently, so it is worth a test of its own.
    const byVerb = new Map<string, Set<boolean>>()
    for (const [type, value] of Object.entries(IDEMPOTENT_MUTATION)) {
      const verb = type.split('_')[0]
      if (!byVerb.has(verb)) byVerb.set(verb, new Set())
      byVerb.get(verb)!.add(value)
    }
    const split = [...byVerb.entries()].filter(([, values]) => values.size > 1).map(([v]) => v)
    expect(split).toEqual([])
  })
})
