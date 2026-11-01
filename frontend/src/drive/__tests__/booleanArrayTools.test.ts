// @vitest-environment node
//
// The pure half of the boolean `tools` array expansion: the add_boolean /
// add_extrude catalog rows publish the inline fields, the required boolean
// fields and the array-tool rule. The kernel-backed expansion cases are
// booleanArrayToolsReal.test.ts; the add-array copies (`split_from` provenance)
// are covered by kernel/features/__tests__/boolean.arrayAddSplit.

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
