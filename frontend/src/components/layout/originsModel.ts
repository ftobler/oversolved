import type { OriginStatus } from '@/workspace/import'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'

// The pure half of U6, kept when the origins panel became row meta on the
// workspace view (R5). Everything here reads local data only: what a row says
// about its origin before the explicit check is a claim about what was recorded
// at copy time, never a resolver read (I2).

// 'unknown' is the row's state before a check has run. It is not an
// OriginStatus because `originState` can never return it: only the absence of a
// check produces it.
export type RowOriginStatus = OriginStatus | 'unknown'

export const ORIGIN_STATUS_LABEL: Record<RowOriginStatus, string> = {
  unknown: 'Not checked',
  current: 'Up to date',
  changed: 'Origin changed',
  unreachable: 'Origin unavailable',
  'not-updatable': 'Not updatable',
}

// What the row calls its source. The locator is opaque and per-gesture, so it
// is the fallback rather than the label.
export function originLabel(record: ProvenanceRecord): string {
  return record.originName ?? record.origin
}

// The local drift answer: the copy's payload hash no longer matches the hash the
// source had when it was copied. Both halves are local, so a row can say it
// without reaching for the source.
export function editedLocally(record: ProvenanceRecord, entry: EntryMeta | undefined): boolean {
  return record.hash !== undefined && entry?.contentHash !== undefined && entry.contentHash !== record.hash
}

export interface OriginUpdatePolicy {
  canUpdate: boolean
  // Why the control is offered or refused. It is the only place that says so:
  // a disabled button with no explanation reads as a broken one.
  title: string
  // The same drift the title warns about, so the row can label it without
  // computing it a second time.
  edited: boolean
}

// Not updatable and unreachable can never pull. A current origin can still be
// pulled to reset a local edit, which the title warns overwrites. A changed
// origin is always pullable, and an unchecked one is not: offering the pull
// before a check would make the row's first honest resolver read a side effect
// of clicking Update rather than of clicking Check.
export function originUpdatePolicy(
  record: ProvenanceRecord,
  entry: EntryMeta | undefined,
  status: RowOriginStatus,
): OriginUpdatePolicy {
  const edited = editedLocally(record, entry)
  const canUpdate = status !== 'not-updatable' && status !== 'unreachable'
    && (status === 'changed' || edited)
  const title = status === 'not-updatable'
    ? 'No recorded source entry; this copy cannot be updated.'
    : status === 'unreachable'
      ? 'Origin unavailable.'
      : edited
        ? 'Updating overwrites your local edits.'
        : status === 'current'
          ? 'Already up to date.'
          : status === 'unknown'
            ? 'Check for updates first.'
            : 'Pull the source changes.'
  return { canUpdate, title, edited }
}
