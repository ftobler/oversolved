// The typed refusal a guarded entry delete throws when something still
// references the entry. The store owns the check; the UI catches this to name
// the live referrers rather than surfacing a generic failure.

export interface EntryReferrer {
  id: string
  name: string
}

export class EntryReferencedError extends Error {
  readonly entry: string
  readonly referrers: EntryReferrer[]

  constructor(entry: string, referrers: EntryReferrer[]) {
    super(`Entry is referenced by ${referrers.length} live ${referrers.length === 1 ? 'entry' : 'entries'}: ${referrers.map(r => r.name).join(', ')}`)
    this.name = 'EntryReferencedError'
    this.entry = entry
    this.referrers = referrers
  }
}
