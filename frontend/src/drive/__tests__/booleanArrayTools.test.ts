// @vitest-environment node
//
// A boolean `tools` entry that names an array feature expands to the array's
// source body and every instance body at solve time, so a later count change
// is followed (sprocket F3 typed 40 ids by hand; din_rail F1 raised a count
// and left the new slots floating free). A hand list that names only some of
// one array's bodies warns. The add_boolean / add_extrude inline fields carry
// the whole feature in one call. The add-array copies (`split_from`
// provenance) are covered by kernel/features/__tests__/boolean.arrayAddSplit.
// The kernel-backed cases live in booleanArrayToolsReal.test.ts.

import { describe, it, expect } from 'vitest'
import { mutationInfoOf } from '../mutationCatalog'


describe('add_boolean / add_extrude inline catalog rows', () => {
  it('publish the inline fields, the required boolean fields and the array-tool rule', () => {
    const boolean = mutationInfoOf('add_boolean')
    for (const key of ['operation', 'target', 'tools']) expect(boolean.fields[key], key).toBeDefined()
    expect(boolean.note).toContain('needs `target`')
    expect(boolean.note).toContain('@<arrayId>')
    const extrude = mutationInfoOf('add_extrude')
    for (const key of ['direction', 'operation', 'merge_target']) expect(extrude.fields[key], key).toBeDefined()
  })
})
