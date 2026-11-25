// The document boundary accepts a reference dimension and refuses the flag on
// a row that cannot measure. The field is true or absent, never a loose boolean.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(constraint: Record<string, unknown>) {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0] },
      constraints: [constraint],
    }],
  }
}

const flat = (r: ReturnType<typeof loadPartDoc>) => r.ok ? null : `${r.error.field}: ${r.error.message}`

describe('driven dimensions at the document boundary', () => {
  it('loads and round-trips a driven length', () => {
    const c = { id: 'c1', kind: 'length', target: '$l1', value: 10, driven: true }
    expect(loadPartDoc(doc(c)).ok).toBe(true)
    const loaded = loadPartDoc(doc(c))
    const feature = loaded.ok ? loaded.doc.features?.[0] : undefined
    expect(feature?.kind === 'sketch' && feature.constraints?.[0].driven).toBe(true)
  })

  it('refuses driven on a geometric row', () => {
    const error = flat(loadPartDoc(doc({ id: 'c1', kind: 'horizontal', target: '$l1', driven: true })))
    expect(error).toContain('.driven')
    expect(error).toContain('only dimension constraints')
  })

  it('refuses a false or numeric flag', () => {
    const error = flat(loadPartDoc(doc({ id: 'c1', kind: 'length', target: '$l1', driven: false })))
    expect(error).toContain('must be true when present')
  })
})
