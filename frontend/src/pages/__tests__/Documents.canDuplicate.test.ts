import { describe, it, expect } from 'vitest'
import { canDuplicateDocument } from '@/pages/Documents'
import type { DocSummary } from '@/stores/documentStore'

// PS-L3: the duplicate action is server-gated on document ownership, so the
// button must not be offered on a cloud tile the server will reject.
function doc(isOwner: boolean): DocSummary {
  return {
    uuid: 'u1',
    name: 'doc',
    owner_username: 'owner',
    is_owner: isOwner,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    is_public: false,
  }
}

describe('canDuplicateDocument', () => {
  it('hides duplicate on a non-owned cloud tile', () => {
    expect(canDuplicateDocument(doc(false), true)).toBe(false)
  })

  it('shows duplicate on an owned cloud tile', () => {
    expect(canDuplicateDocument(doc(true), true)).toBe(true)
  })

  it('always shows duplicate for a local document', () => {
    // Local documents are device-owned, so ownership is irrelevant there.
    expect(canDuplicateDocument(doc(false), false)).toBe(true)
    expect(canDuplicateDocument(doc(true), false)).toBe(true)
  })
})
