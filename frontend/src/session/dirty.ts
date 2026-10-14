// The dirty policy the session owns: the pin taken when open work starts, the
// restore after a rewind, and the fingerprint check that reconciles the flag
// against the bytes a mid-session save really stored. The UI-facing
// unsavedChangesStore mirrors this state through the adapter; the hash and the
// reconcile decision live here so the store and the session share one
// algorithm (editor-state-one-owner folds the store in fully).

export interface DirtyPin {
  dirty: boolean
  saves: number
}

export interface DirtyFacts extends DirtyPin {
  savedHash: number | null
}

// A content fingerprint of the serialized bytes a save wrote. FNV-1a over the
// text: the save path already serializes the document for the store, so this
// only re-reads that string, needs no dependency and no WebCrypto. It exists
// because a cancel has to know WHICH content a mid-session save stored, and the
// save count alone can only say that one landed.
export function hashSavedText(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// The fallback for a caller that published no fingerprint: without knowing what
// bytes a mid-session save stored, a moved save count is read as "the stored
// doc is not the one being restored", even when a later edit already set the
// flag again.
export function restoreDirtyFlag(facts: DirtyFacts, pinned: DirtyPin): boolean {
  return facts.saves !== pinned.saves ? true : pinned.dirty
}

// The flag after a session cancel or commit rewound the doc to the state its
// session pinned. The flag has to mean one thing: the stored bytes no longer
// match the doc that just became live. So the decision is made against what a
// save REALLY stored -- the fingerprint it published of the exact text it
// wrote -- rather than against the save count, which only proves that one
// landed. A session whose edits netted to zero, or that changed nothing at
// all, stored the very text the rewind restores: nothing is unsaved, and
// reading the moved save count as "an edit was stored" would flag the document
// dirty forever. `serializeRestored` is a thunk because only a session a save
// landed in has anything to compare, so the serialization is paid on that path
// alone. A caller that rewound nothing (a net-zero commit) passes `rewound`
// false; a caller that did passes whether the content actually changed.
//
// Returns the new flag, or null when the decision is "leave the flag where it
// is": a save landed without a fingerprint and the rewind threw nothing away.
export function reconcileDirty(
  facts: DirtyFacts,
  pinned: DirtyPin,
  rewound: boolean,
  serializeRestored: () => string,
): boolean | null {
  const savesMoved = facts.saves !== pinned.saves
  if (savesMoved && facts.savedHash !== null) {
    return facts.savedHash !== hashSavedText(serializeRestored())
  }
  if (!savesMoved || rewound) {
    return restoreDirtyFlag(facts, pinned)
  }
  return null
}
